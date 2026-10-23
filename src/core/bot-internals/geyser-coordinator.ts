import { address } from '@solana/addresses';
import {
  decodePumpCurve,
  decodeRaydiumPool,
  decodeMeteoraPool,
  rpcCall,
  PRIORITY,
  derivePumpCurvePda,
} from '../utils.js';
import {
  PUMP_FUN_PROGRAM_ID,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  METEORA_DLMM_PROGRAM_ID,
  SOL_MINT,
} from '../constants.js';
import { poolConfigsCache } from '#services/trading/local-router.js';
import { tradingService } from '#services/trading/trading.service.js';
import { GeyserClient, geyserOptionsFromConfig } from '#services/ingestion/geyser-client.js';
import { Context } from '#types/index.js';
import {
  localMarketState,
  priceHistoryEngine,
  decodePumpCurveState,
} from '#services/market-state/index.js';

export class GeyserStreamCoordinator {
  public static activeInstance: GeyserStreamCoordinator | null = null;

  private _geyserClient: GeyserClient | null = null;
  public get geyserClient(): GeyserClient | null {
    return this._geyserClient;
  }
  private readonly raydiumVaultFetchTs = new Map<string, number>();
  private static readonly RAYDIUM_FETCH_DEBOUNCE_MS = 250;
  private readonly raydiumVaultFetchInFlight = new Map<string, Promise<void>>();
  private readonly meteoraVaultFetchTs = new Map<string, number>();
  private static readonly METEORA_FETCH_DEBOUNCE_MS = 250;
  private readonly meteoraVaultFetchInFlight = new Map<string, Promise<void>>();
  private readonly pendingCurvePdas = new Map<
    string,
    { data: Buffer; slot: number; at: number }[]
  >();
  private readonly geyserSeenPools = new Set<string>();
  private readonly geyserRecentMints = new Map<string, number>();

  constructor(
    private readonly getCtx: () => Context,
    private readonly runDiscoveryLoop: (
      trigger:
        | boolean
        | {
            forceDiscovery?: boolean;
            reason?: string;
            mints?: string[];
            mintLaunchpads?: Record<string, string>;
          }
    ) => Promise<void>
  ) {
    GeyserStreamCoordinator.activeInstance = this;
  }

  public onCurvePdaRegistered(pda: string, mint: string): void {
    const pending = this.pendingCurvePdas.get(pda);
    if (pending) {
      this.pendingCurvePdas.delete(pda);
      for (const update of pending) {
        this.processPumpCurveGeyserUpdate(mint, update.data, update.slot);
      }
    }
  }

  public processPumpCurveGeyserUpdate(
    mint: string,
    data: Buffer,
    slot = this.getCtx().state.latestGeyserSlot || 0
  ): void {
    const curveData = decodePumpCurve(data);
    if (!curveData) return;
    const vSol = Number(curveData.virtualSolReserves);
    const vToken = Number(curveData.virtualTokenReserves);
    if (vToken === 0) return;
    const priceInSol = vSol / vToken;
    tradingService
      .estimateSolUsdPrice(this.getCtx())
      .then((solUsdPrice: number) => {
        const usdPrice = priceInSol * solUsdPrice;
        this.getCtx().store.updateMarketSnapshot(mint, {
          launchpad: 'pump.fun',
          liquidity: Number(curveData.realSolReserves),
          usdPrice,
          observedAt: new Date().toISOString(),
        });

        // Push directly into Local Market State Store & Price History Engine
        const existing = localMarketState.getSnapshot(mint);
        const snap = decodePumpCurveState(mint, data, solUsdPrice, slot, {
          ...existing,
          source: 'geyser-pump-curve',
          status: 'authoritative',
        });
        if (snap) {
          localMarketState.updateSnapshot(snap);
          priceHistoryEngine.pushPrice(mint, slot, snap.priceUsd);
        }
      })
      .catch(() => {});
  }

  public triggerGeyserDiscovery(mint: string, launchpad: string): void {
    if (this.getCtx().state.processedMints.has(mint)) return;
    const now = Date.now();
    const last = this.geyserRecentMints.get(mint) ?? 0;
    if (now - last < 60_000) return;
    this.geyserRecentMints.set(mint, now);
    void this.runDiscoveryLoop({
      reason: 'geyser-mint-init',
      forceDiscovery: true,
      mints: [mint],
      mintLaunchpads: { [mint]: launchpad },
    });
  }

  public startGeyserIfEnabled(): void {
    GeyserStreamCoordinator.activeInstance = this;
    const opts = geyserOptionsFromConfig(this.getCtx().config);
    if (!opts) return;

    const logger = this.getCtx().logger;
    this._geyserClient = new GeyserClient({
      ...opts,
      onUpdate: (update) => {
        const state = this.getCtx().state;
        state.latestGeyserSlot = Math.max(state.latestGeyserSlot || 0, update.slot);

        if (this.pendingCurvePdas.size > 0) {
          const staleAt = Date.now() - 30_000;
          for (const [pda, entries] of this.pendingCurvePdas) {
            const fresh = entries.filter((entry) => entry.at >= staleAt);
            if (fresh.length > 0) this.pendingCurvePdas.set(pda, fresh);
            else this.pendingCurvePdas.delete(pda);
          }
        }
        if (this.geyserRecentMints.size > 0) {
          const cutoff = Date.now() - 60_000;
          for (const [mint, ts] of this.geyserRecentMints) {
            if (ts < cutoff) this.geyserRecentMints.delete(mint);
          }
        }
        if (this.geyserSeenPools.size > 10_000) {
          this.geyserSeenPools.clear();
        }

        if (update.owner === PUMP_FUN_PROGRAM_ID) {
          const curveData = decodePumpCurve(update.data);
          if (!curveData) return;

          const mint = this.getCtx().state.curveToMint.get(update.pubkey);
          if (!mint) {
            const pending = this.pendingCurvePdas.get(update.pubkey) ?? [];
            pending.push({ data: update.data, slot: update.slot, at: Date.now() });
            this.pendingCurvePdas.set(update.pubkey, pending);
            return;
          }

          this.processPumpCurveGeyserUpdate(mint, update.data, update.slot);
        } else if (update.owner === RAYDIUM_AMM_V4_PROGRAM_ID) {
          if (!this.geyserSeenPools.has(update.pubkey)) {
            this.geyserSeenPools.add(update.pubkey);
            const newPool = decodeRaydiumPool(update.data);
            if (newPool) {
              const { baseMint, quoteMint } = newPool;
              const tokenMint = baseMint === SOL_MINT ? quoteMint : baseMint;
              if (tokenMint !== SOL_MINT) this.triggerGeyserDiscovery(tokenMint, 'raydium');
            }
          }
          const now = Date.now();
          const lastFetch = this.raydiumVaultFetchTs.get(update.pubkey) ?? 0;
          if (now - lastFetch < GeyserStreamCoordinator.RAYDIUM_FETCH_DEBOUNCE_MS) return;
          this.raydiumVaultFetchTs.set(update.pubkey, now);
          if (this.raydiumVaultFetchInFlight.has(update.pubkey)) return;

          const poolData = decodeRaydiumPool(update.data);
          if (!poolData) return;
          poolConfigsCache.set(update.pubkey, poolData);

          const baseMint = poolData.baseMint;
          const quoteMint = poolData.quoteMint;
          const tokenMint = baseMint === SOL_MINT ? quoteMint : baseMint;

          this.getCtx().state.mintToPool.set(tokenMint, update.pubkey);

          const raydiumFetchPromise: Promise<void> = rpcCall(
            this.getCtx(),
            'getMultipleAccounts',
            [
              [address(poolData.baseVault), address(poolData.quoteVault)],
              { encoding: 'base64', commitment: 'confirmed' },
            ],
            { priority: PRIORITY.HIGH }
          )
            .then(async (vaultInfo) => {
              const value = vaultInfo?.value;
              if (value && value.length === 2) {
                const baseAccount = value[0];
                const quoteAccount = value[1];
                if (baseAccount && quoteAccount) {
                  const baseData = baseAccount.data;
                  const quoteData = quoteAccount.data;
                  if (Array.isArray(baseData) && Array.isArray(quoteData)) {
                    const baseBuffer = Buffer.from(baseData[0], 'base64');
                    const quoteBuffer = Buffer.from(quoteData[0], 'base64');
                    if (baseBuffer.length >= 72 && quoteBuffer.length >= 72) {
                      const baseBalance = baseBuffer.readBigUInt64LE(64);
                      const quoteBalance = quoteBuffer.readBigUInt64LE(64);

                      const baseBalanceDecimal =
                        Number(baseBalance) / Math.pow(10, poolData.baseDecimals);
                      const quoteBalanceDecimal =
                        Number(quoteBalance) / Math.pow(10, poolData.quoteDecimals);

                      if (baseBalanceDecimal === 0 || quoteBalanceDecimal === 0) return;

                      let priceInSol: number;
                      let solReserves: number;
                      if (quoteMint === SOL_MINT) {
                        priceInSol = quoteBalanceDecimal / baseBalanceDecimal;
                        solReserves = quoteBalanceDecimal;
                      } else if (baseMint === SOL_MINT) {
                        priceInSol = baseBalanceDecimal / quoteBalanceDecimal;
                        solReserves = baseBalanceDecimal;
                      } else {
                        return;
                      }

                      const solUsdPrice = await tradingService.estimateSolUsdPrice(this.getCtx());
                      const usdPrice = priceInSol * solUsdPrice;
                      const liquidity = solReserves * 2 * solUsdPrice;

                      this.getCtx().store.updateMarketSnapshot(tokenMint, {
                        launchpad: 'raydium',
                        liquidity: liquidity,
                        usdPrice: usdPrice,
                        observedAt: new Date().toISOString(),
                      });
                    }
                  }
                }
              }
            })
            .catch((err: unknown) => {
              logger(`Failed to get Raydium vault balances for Geyser update: ${err}`, 'debug');
            })
            .finally(() => {
              this.raydiumVaultFetchInFlight.delete(update.pubkey);
            });
          this.raydiumVaultFetchInFlight.set(update.pubkey, raydiumFetchPromise);
        } else if (update.owner === METEORA_DLMM_PROGRAM_ID) {
          if (!this.geyserSeenPools.has(update.pubkey)) {
            this.geyserSeenPools.add(update.pubkey);
            const newPool = decodeMeteoraPool(update.data);
            if (newPool) {
              const solIsXNew = newPool.tokenXMint === SOL_MINT;
              const newMint = solIsXNew ? newPool.tokenYMint : newPool.tokenXMint;
              if (newMint !== SOL_MINT) this.triggerGeyserDiscovery(newMint, 'meteora');
            }
          }
          const now = Date.now();
          const lastFetch = this.meteoraVaultFetchTs.get(update.pubkey) ?? 0;
          if (now - lastFetch < GeyserStreamCoordinator.METEORA_FETCH_DEBOUNCE_MS) return;
          this.meteoraVaultFetchTs.set(update.pubkey, now);
          if (this.meteoraVaultFetchInFlight.has(update.pubkey)) return;

          const poolData = decodeMeteoraPool(update.data);
          if (!poolData) return;
          poolConfigsCache.set(update.pubkey, poolData);

          const { tokenXMint, tokenYMint, reserveX, reserveY, activeId, binStep } = poolData;
          const solIsX = tokenXMint === SOL_MINT;
          const tokenMint = solIsX ? tokenYMint : tokenXMint;

          this.getCtx().state.mintToPool.set(tokenMint, update.pubkey);

          const priceRaw = Math.pow(1 + binStep / 10_000, activeId);
          const priceInSol = solIsX ? 1 / priceRaw : priceRaw;

          const meteoraFetchPromise: Promise<void> = rpcCall(
            this.getCtx(),
            'getMultipleAccounts',
            [
              [address(reserveX), address(reserveY)],
              { encoding: 'base64', commitment: 'confirmed' },
            ],
            { priority: PRIORITY.HIGH }
          )
            .then(async (vaultInfo) => {
              const value = vaultInfo?.value;
              if (!value || value.length < 2) return;
              const xAccount = value[0];
              const yAccount = value[1];
              if (!xAccount || !yAccount) return;
              const xData = xAccount.data;
              const yData = yAccount.data;
              if (!Array.isArray(xData) || !Array.isArray(yData)) return;
              const xBuf = Buffer.from(xData[0], 'base64');
              const yBuf = Buffer.from(yData[0], 'base64');
              if (xBuf.length < 72 || yBuf.length < 72) return;
              const xBalance = Number(xBuf.readBigUInt64LE(64));
              const yBalance = Number(yBuf.readBigUInt64LE(64));
              const solBalance = solIsX ? xBalance : yBalance;
              if (solBalance <= 0) return;
              const solReserves = solBalance / 1e9;
              const solUsdPrice = await tradingService.estimateSolUsdPrice(this.getCtx());
              const usdPrice = priceInSol * solUsdPrice;
              const liquidity = solReserves * 2 * solUsdPrice;
              this.getCtx().store.updateMarketSnapshot(tokenMint, {
                launchpad: 'meteora',
                liquidity,
                usdPrice,
                observedAt: new Date().toISOString(),
              });
            })
            .catch((err: unknown) => {
              logger(`Failed to get Meteora vault balances for Geyser update: ${err}`, 'debug');
            })
            .finally(() => {
              this.meteoraVaultFetchInFlight.delete(update.pubkey);
            });
          this.meteoraVaultFetchInFlight.set(update.pubkey, meteoraFetchPromise);
        }
      },
      log: (msg, level) => logger(msg, level, { console: true }),
    });
    this._geyserClient.start();
    logger(
      `Geyser stream client started (${opts.tcpAddr ?? opts.socketPath}). RPC polling remains the fallback.`,
      'info',
      { console: true }
    );
  }

  public stop(): void {
    if (this._geyserClient) {
      this._geyserClient.stop();
      this._geyserClient = null;
    }
  }
}

export async function registerPumpMintPda(
  ctx: Context,
  mint: string,
  solUsdPrice = 200
): Promise<string> {
  localMarketState.seedInitialPumpFunSnapshot(mint, solUsdPrice);
  try {
    const pda = await derivePumpCurvePda(mint);
    if (pda) {
      ctx.state.curveToMint.set(pda, mint);
      GeyserStreamCoordinator.activeInstance?.onCurvePdaRegistered(pda, mint);
      return pda;
    }
  } catch {}
  return '';
}
