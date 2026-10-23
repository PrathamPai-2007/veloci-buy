import { address, getProgramDerivedAddress, getAddressEncoder } from '@solana/addresses';
import { sleep } from '../utils.js';
import { SOL_MINT } from '../constants.js';
import { tradingService } from '#services/trading/trading.service.js';
import {
  poolConfigsCache,
  CachedPoolConfig,
  RaydiumPool,
  MeteoraPool,
} from '#services/trading/local-router.js';
import { Context } from '#types/index.js';

export class VaultSubscriptionManager {
  constructor(
    private readonly getCtx: () => Context,
    private readonly walletAddress: string
  ) {}

  public async subscribeToAtaBalance(mint: string): Promise<void> {
    const ctx = this.getCtx();
    // standalone ATA subscription for all launchpads (pump.fun has no vaults)
    const existing = ctx.state.ataSubscriptions?.get(mint);
    if (existing && !existing.signal.aborted) return;
    try {
      const tokenProgramId = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
      const ataProgramId = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
      const [ataAddress] = await getProgramDerivedAddress({
        programAddress: ataProgramId,
        seeds: [
          getAddressEncoder().encode(address(this.walletAddress)),
          getAddressEncoder().encode(tokenProgramId),
          getAddressEncoder().encode(address(mint)),
        ],
      });
      const ataAbort = new AbortController();
      if (!ctx.state.ataSubscriptions) ctx.state.ataSubscriptions = new Map();
      ctx.state.ataSubscriptions.set(mint, ataAbort);
      this.startAtaSubscription(mint, ataAddress, ataAbort.signal).catch((err) => {
        if (!ataAbort.signal.aborted)
          ctx.logger(`Failed ATA subscription for ${mint}: ${err}`, 'warn');
      });
      ctx.logger(`Subscribed to ATA push-stream for ${mint}`, 'debug');
    } catch (e: unknown) {
      ctx.logger(`Failed to derive ATA for ${mint}: ${e}`, 'warn');
    }
  }

  public unsubscribeFromAtaBalance(mint: string): void {
    const ctx = this.getCtx();
    const ctrl = ctx.state.ataSubscriptions?.get(mint);
    if (ctrl) {
      ctrl.abort();
      ctx.state.ataSubscriptions!.delete(mint);
      ctx.state.ataBalanceCache?.delete(mint);
    }
  }

  /**
   * Subscribes to the token vault accounts for a given active position.
   * On update, decodes the balance and updates the market snapshot instantly.
   */
  public async subscribeToVaultBalances(
    mint: string,
    poolAddress: string,
    type: 'raydium' | 'meteora'
  ): Promise<void> {
    const ctx = this.getCtx();
    this.unsubscribeFromVaultBalances(mint);

    // Always subscribe to ATA balance for wallet
    await this.subscribeToAtaBalance(mint);

    const poolData = poolConfigsCache.get(poolAddress);
    if (!poolData) {
      ctx.logger(`Cannot subscribe to vaults for ${mint}: pool data not in cache.`, 'debug');
      return;
    }

    const vaults: string[] = [];
    if (type === 'raydium') {
      const r = poolData as RaydiumPool;
      vaults.push(r.baseVault, r.quoteVault);
    } else if (type === 'meteora') {
      const m = poolData as MeteoraPool;
      vaults.push(m.reserveX, m.reserveY);
    }

    const abortController = new AbortController();
    if (!ctx.state.vaultSubscriptions) {
      ctx.state.vaultSubscriptions = new Map();
    }
    ctx.state.vaultSubscriptions.set(mint, abortController);

    for (const addr of vaults) {
      if (!addr) continue;
      this.startAccountSubscription(mint, addr, type, poolData, abortController.signal).catch(
        (err) => {
          if (!abortController.signal.aborted) {
            ctx.logger(`Failed vault subscription for ${mint} (${addr}): ${err}`, 'warn');
          }
        }
      );
    }
    ctx.logger(`Subscribed to vault push-stream for ${mint}`, 'debug');
  }

  public unsubscribeFromVaultBalances(mint: string): void {
    const ctx = this.getCtx();
    if (ctx.state.vaultSubscriptions) {
      const controller = ctx.state.vaultSubscriptions.get(mint);
      if (controller) {
        controller.abort();
        ctx.state.vaultSubscriptions.delete(mint);
        ctx.logger(`Unsubscribed from vault push-stream for ${mint}`, 'debug');
      }
    }
  }

  private async startAccountSubscription(
    mint: string,
    addr: string,
    type: 'raydium' | 'meteora',
    poolData: CachedPoolConfig,
    signal: AbortSignal
  ) {
    const ctx = this.getCtx();
    const handshakeMs = ctx.config.websocketHandshakeTimeoutMs || 15_000;
    while (!signal.aborted) {
      let timeoutId: NodeJS.Timeout | undefined;
      try {
        const subscribeTask = ctx.rpcSubscriptions
          .accountNotifications(address(addr), { encoding: 'base64', commitment: 'confirmed' })
          .subscribe({ abortSignal: signal });
        subscribeTask.catch(() => {});
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error('Account subscription handshake timeout')),
            handshakeMs
          );
        });
        timeoutPromise.catch(() => {});
        const subscription = await Promise.race([subscribeTask, timeoutPromise]);
        clearTimeout(timeoutId);

        for await (const notification of subscription) {
          if (signal.aborted) break;
          const dataStr = notification.value.data[0];
          if (!dataStr) continue;
          const buf = Buffer.from(dataStr, 'base64');

          // Offset 64 in SPL Token accounts stores the 64-bit unsigned amount.
          if (buf.length >= 72) {
            const balanceBigInt = buf.readBigUInt64LE(64);
            ctx.state.vaultBalanceCache!.set(addr, balanceBigInt);

            if (type === 'raydium') {
              this.recalculateRaydiumPrice(mint, poolData as RaydiumPool);
            } else {
              this.recalculateMeteoraPrice(mint, poolData as MeteoraPool);
            }
          }
        }
        if (!signal.aborted) {
          throw new Error('Vault subscription ended unexpectedly');
        }
      } catch (err) {
        clearTimeout(timeoutId);
        if (signal.aborted) return;
        ctx.logger(
          `Vault subscription failed/ended for ${mint} (${addr}): ${err instanceof Error ? err.message : String(err)}. Retrying in ~5s...`,
          'warn'
        );
        // Jitter so all vault subs don't retry in lockstep and stampede the RPC WS on a drop.
        await sleep(5000 + Math.floor(Math.random() * 2000));
      }
    }
  }

  private async startAtaSubscription(mint: string, ataAddress: string, signal: AbortSignal) {
    const ctx = this.getCtx();
    const handshakeMs = ctx.config.websocketHandshakeTimeoutMs || 15_000;
    while (!signal.aborted) {
      let timeoutId: NodeJS.Timeout | undefined;
      try {
        const subscribeTask = ctx.rpcSubscriptions
          .accountNotifications(address(ataAddress), {
            encoding: 'base64',
            commitment: 'confirmed',
          })
          .subscribe({ abortSignal: signal });
        subscribeTask.catch(() => {});
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error('ATA subscription handshake timeout')),
            handshakeMs
          );
        });
        timeoutPromise.catch(() => {});
        const subscription = await Promise.race([subscribeTask, timeoutPromise]);
        clearTimeout(timeoutId);

        for await (const notification of subscription) {
          if (signal.aborted) break;
          const dataStr = notification.value?.data?.[0];
          if (!dataStr) continue;
          const buf = Buffer.from(dataStr, 'base64');

          // SPL Token account balance is a u64 at offset 64
          if (buf.length < 72) continue;
          const balanceBigInt = buf.readBigUInt64LE(64);
          const pos = ctx.state.positions.get(mint);
          const decimals = Number(pos?.decimals ?? pos?.mintSignals?.decimals ?? 6);
          const uiAmount = Number(balanceBigInt) / 10 ** decimals;

          ctx.state.ataBalanceCache?.set(mint, {
            mint,
            rawAmount: balanceBigInt,
            decimals,
            uiAmount,
          });
          ctx.logger(`[ATA Push] Balance updated for ${mint}: ${uiAmount} tokens`, 'debug');
        }
        if (!signal.aborted) {
          throw new Error('ATA subscription ended unexpectedly');
        }
      } catch (err) {
        clearTimeout(timeoutId);
        if (signal.aborted) return;
        ctx.logger(
          `ATA subscription failed/ended for ${mint}: ${err instanceof Error ? err.message : String(err)}. Retrying in ~5s...`,
          'warn'
        );
        // Jitter so all ATA subs don't retry in lockstep and stampede the RPC WS on a drop.
        await sleep(5000 + Math.floor(Math.random() * 2000));
      }
    }
  }

  private async recalculateRaydiumPrice(mint: string, poolData: RaydiumPool) {
    const ctx = this.getCtx();
    const baseBalance = ctx.state.vaultBalanceCache!.get(poolData.baseVault);
    const quoteBalance = ctx.state.vaultBalanceCache!.get(poolData.quoteVault);
    if (baseBalance === undefined || quoteBalance === undefined) return;

    const baseBalanceDecimal = Number(baseBalance) / Math.pow(10, poolData.baseDecimals);
    const quoteBalanceDecimal = Number(quoteBalance) / Math.pow(10, poolData.quoteDecimals);
    if (baseBalanceDecimal === 0 || quoteBalanceDecimal === 0) return;

    let priceInSol: number;
    let solReserves: number;
    if (poolData.quoteMint === SOL_MINT) {
      priceInSol = quoteBalanceDecimal / baseBalanceDecimal;
      solReserves = quoteBalanceDecimal;
    } else if (poolData.baseMint === SOL_MINT) {
      priceInSol = baseBalanceDecimal / quoteBalanceDecimal;
      solReserves = baseBalanceDecimal;
    } else {
      return;
    }

    const solUsdPrice = await tradingService.estimateSolUsdPrice(ctx);
    const usdPrice = priceInSol * solUsdPrice;
    const liquidity = solReserves * 2 * solUsdPrice;

    ctx.store.updateMarketSnapshot(mint, {
      launchpad: 'raydium',
      liquidity: liquidity,
      usdPrice: usdPrice,
      observedAt: new Date().toISOString(),
    });

    // Trigger instant monitor check using the Event-Driven Engine
    const pos = ctx.state.positions.get(mint);
    if (pos) {
      const cached = ctx.state.ataBalanceCache?.get(mint);
      if (!cached) return; // avoid spurious zero-balance synthetic triggering 15s timer
      const balance = cached;
      const { evaluateSinglePosition } = await import('#services/monitor/monitor.service.js');
      await evaluateSinglePosition(ctx, mint, pos, balance, { usdPrice, liquidity }, undefined);
    }
  }

  private async recalculateMeteoraPrice(mint: string, poolData: MeteoraPool) {
    const ctx = this.getCtx();
    const xBalance = ctx.state.vaultBalanceCache!.get(poolData.reserveX);
    const yBalance = ctx.state.vaultBalanceCache!.get(poolData.reserveY);
    if (xBalance === undefined || yBalance === undefined) return;

    const solIsX = poolData.tokenXMint === SOL_MINT;
    const solBalance = Number(solIsX ? xBalance : yBalance);
    if (solBalance <= 0) return;

    const solReserves = solBalance / 1e9;

    const snap = ctx.state.marketSnapshots.get(mint);
    if (!snap?.usdPrice) return;

    const usdPrice = snap.usdPrice;
    const liquidity = solReserves * 2 * (await tradingService.estimateSolUsdPrice(ctx));

    ctx.store.updateMarketSnapshot(mint, {
      ...snap,
      liquidity: liquidity,
      observedAt: new Date().toISOString(),
    });

    // Trigger instant monitor check using the Event-Driven Engine
    const pos = ctx.state.positions.get(mint);
    if (pos) {
      const cached = ctx.state.ataBalanceCache?.get(mint);
      if (!cached) return;
      const balance = cached;
      const { evaluateSinglePosition } = await import('#services/monitor/monitor.service.js');
      await evaluateSinglePosition(ctx, mint, pos, balance, { usdPrice, liquidity }, undefined);
    }
  }
}
