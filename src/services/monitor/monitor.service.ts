import { evaluateExitChain } from './exits/exit-chain.js';
import { ExitContext } from './exits/types.js';
import { runBoundedPool, PRIORITY, computeSpread, atomicToDecimalString } from '#core/utils.js';
import { TAKE_PROFIT_MULTIPLES } from '#core/config.js';
import { tradingService } from '../trading/trading.service.js';
import { Context, MintSignals, Position } from '#types/index.js';
import { marketDataProvider } from '../market-state/index.js';
import { securityAuditWorker } from './security-audit-worker.js';

export * from './exit-calculator.js';
export * from './exit-executor.js';
export * from './trade-logger.js';
export * from './position-sync.js';

import {
  getTakeProfitPlan,
  getTakeProfitFraction,
  computeTakeProfitSellAmount,
  getMoodAdjustments,
} from './exit-calculator.js';
import { executePositionExit, sellTakeProfit, startCoolDown } from './exit-executor.js';
import {
  incrementExitReasonMetric,
  buildExitAccounting,
  recordTradeResult,
  recordClosedTrade,
} from './trade-logger.js';
import { positionLockManager, markOrphanIfNeeded, ensureFlushed } from './position-sync.js';

export interface PriceRecord {
  usdPrice?: number;
  liquidity?: number;
  bidPrice?: number;
  askPrice?: number;
}

const BALANCE_POLL_INTERVAL_MS = 30_000;
let lastWalletPollAt = 0;
export function __resetMonitorPollForTests(): void {
  lastWalletPollAt = 0;
}

export async function monitorPositions(
  ctx: Context,
  fetchPricesBestEffort: (
    ctx: Context,
    mints: string[],
    label: string,
    apiKey?: string
  ) => Promise<Record<string, PriceRecord>>
): Promise<void> {
  if (ctx.state.positions.size === 0) return;

  ctx.store.incrementMetric('monitorTicks', 1);

  const mints = Array.from(ctx.state.positions.keys());
  const prices: Record<string, PriceRecord> = {};
  const missingMints: string[] = [];

  // Local-First: read prices directly from in-memory marketDataProvider
  for (const mint of mints) {
    const details = marketDataProvider.getMarketPriceDetails(mint);
    const snap = marketDataProvider.getSnapshot(mint);
    if (
      details.status === 'AUTHORITATIVE' &&
      details.isFresh &&
      details.priceUsd != null &&
      details.priceUsd > 0
    ) {
      prices[mint] = {
        usdPrice: details.priceUsd,
        liquidity: snap?.liquidityUsd ?? 0,
      };
      ctx.store.incrementMetric('localMarketReads', 1);
    } else {
      missingMints.push(mint);
      ctx.store.incrementMetric('localMarketMisses', 1);
    }
  }

  // Best-effort external fallback ONLY for mints missing from local state (non-blocking if it fails)
  if (missingMints.length > 0) {
    ctx.store.incrementMetric('externalPriceFallbacks', missingMints.length);
    try {
      const fallbackPrices = await fetchPricesBestEffort(
        ctx,
        missingMints,
        'position refresh fallback',
        ctx.config.jupiterPositionApiKey
      );
      Object.assign(prices, fallbackPrices);
    } catch {
      ctx.store.incrementMetric('monitorRpcFailures', 1);
    }
  }

  // Wallet balance: prefer ATA push-cache, fallback to throttled RPC poll (every 30s)
  const shouldPoll = Date.now() - lastWalletPollAt >= BALANCE_POLL_INTERVAL_MS;

  let liveOrPaperMap:
    | Map<string, { mint: string; rawAmount: bigint; decimals: number; uiAmount: number }>
    | undefined;

  // Seed from ATA push cache first
  const ataCache = ctx.state.ataBalanceCache;
  if (ataCache && ataCache.size > 0) {
    liveOrPaperMap = new Map(
      ataCache as Map<
        string,
        { mint: string; rawAmount: bigint; decimals: number; uiAmount: number }
      >
    );
    ctx.store.incrementMetric('monitorTicksUsingCachedBalance', ataCache.size);
  }

  if (ctx.config.paperTrading) {
    // Paper path: no RPC needed, already seeded from positions inside getAllWalletTokenBalances
  } else if (shouldPoll) {
    try {
      const polled = await Promise.race([
        tradingService.getAllWalletTokenBalances(ctx, PRIORITY.MEDIUM),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('getAllWalletTokenBalances timed out after 1500ms')),
            1500
          )
        ),
      ]);
      liveOrPaperMap = polled;
      lastWalletPollAt = Date.now();
    } catch (err) {
      ctx.store.incrementMetric('monitorRpcFailures', 1);
      ctx.logger(
        `Wallet balance poll failed (throttled ${BALANCE_POLL_INTERVAL_MS}ms): ${err instanceof Error ? err.message : String(err)}; using ATA push cache.`,
        'warn'
      );
    }
  } else if (!liveOrPaperMap) {
    // Between polls: try a non-blocking opportunistic fetch only if no ATA cache
    try {
      const polled = await Promise.race([
        tradingService.getAllWalletTokenBalances(ctx, PRIORITY.LOW),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('skip')), 800)),
      ]);
      // Do not update lastPollAt; this is opportunistic
      liveOrPaperMap = polled;
    } catch {
      ctx.store.incrementMetric('monitorTicksUsingCachedBalance', 1);
    }
  }

  const balanceMap = new Map<
    string,
    { mint: string; rawAmount: bigint; decimals: number; uiAmount: number }
  >();

  if (liveOrPaperMap) {
    for (const [m, b] of liveOrPaperMap.entries()) {
      balanceMap.set(m, b);
    }
  }

  for (const mint of mints) {
    if (!balanceMap.has(mint)) {
      const pos = ctx.state.positions.get(mint);
      if (pos) {
        const rawStr = pos.lastKnownBalanceRaw ?? pos.initialTokenAmountRaw ?? '0';
        const raw = BigInt(rawStr);
        const dec = Number(pos.decimals || 0);
        balanceMap.set(mint, {
          mint,
          rawAmount: raw,
          decimals: dec,
          uiAmount: Number(atomicToDecimalString(raw, dec, 9)),
        });
        ctx.store.incrementMetric('monitorTicksUsingCachedBalance', 1);
      }
    }
  }

  // Non-blocking background security audit trigger
  const now = Date.now();
  const securityAuditDueMints = mints.filter((m) => {
    const pos = ctx.state.positions.get(m);
    return pos && securityAuditWorker.isAuditDue(pos, now, 30_000);
  });

  if (securityAuditDueMints.length > 0) {
    securityAuditWorker.triggerSecurityReaudit(ctx, securityAuditDueMints);
  }

  // Evaluate single positions immediately using local price, cached balance, and cached security signals
  await runBoundedPool(
    mints,
    async (mint) => {
      const pos = ctx.state.positions.get(mint);
      if (!pos) return;
      const balance = balanceMap.get(mint) ?? {
        mint,
        rawAmount: BigInt(pos.lastKnownBalanceRaw ?? pos.initialTokenAmountRaw ?? '0'),
        decimals: Number(pos.decimals || 0),
        uiAmount: 0,
      };
      const pRecord = prices[mint];
      const preSignals = securityAuditWorker.getCachedSecuritySignal(mint, pos);
      await evaluateSinglePosition(ctx, mint, pos, balance, pRecord, preSignals);
    },
    { concurrency: ctx.config.scanParallelismLight || 5 }
  );
}

export async function closeAllOpenPositions(
  ctx: Context,
  fetchPricesBestEffort: (
    ctx: Context,
    mints: string[],
    label: string,
    apiKey?: string
  ) => Promise<Record<string, PriceRecord>>,
  reason = 'shutdown-exit'
): Promise<void> {
  const mints = Array.from(ctx.state.positions.keys());
  if (mints.length === 0) {
    ctx.logger('No positions to close.');
    return;
  }

  ctx.logger(`Closing ${mints.length} positions for shutdown...`, 'warn', { console: true });

  const POSITION_PRICE_MAX_AGE_MS = 10_000;
  const now = Date.now();
  const missingOrStaleMints: string[] = [];
  const prices: Record<string, PriceRecord> = {};

  for (const mint of mints) {
    const pos = ctx.state.positions.get(mint);
    if (!pos) continue;
    const isFresh =
      pos.lastKnownPriceUsd != null &&
      pos.lastKnownPriceUsd > 0 &&
      pos.lastKnownPriceTimestamp != null &&
      now - pos.lastKnownPriceTimestamp <= POSITION_PRICE_MAX_AGE_MS;

    if (isFresh) {
      prices[mint] = { usdPrice: pos.lastKnownPriceUsd };
    } else {
      const localPrice = marketDataProvider.getPrice(mint);
      if (localPrice != null && localPrice > 0) {
        prices[mint] = { usdPrice: localPrice };
      } else {
        missingOrStaleMints.push(mint);
      }
    }
  }

  if (missingOrStaleMints.length > 0) {
    try {
      const fetched = await fetchPricesBestEffort(
        ctx,
        missingOrStaleMints,
        'shutdown exit refresh',
        ctx.config.jupiterPositionApiKey
      );
      Object.assign(prices, fetched);
    } catch (e: unknown) {
      ctx.logger(
        `Shutdown price refresh failed: ${e instanceof Error ? e.message : String(e)}`,
        'warn'
      );
    }
  }

  let balanceMap: Awaited<ReturnType<typeof tradingService.getAllWalletTokenBalances>> = new Map();
  try {
    balanceMap = await Promise.race([
      tradingService.getAllWalletTokenBalances(ctx, PRIORITY.HIGH),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Shutdown balance fetch timed out after 2000ms')), 2000)
      ),
    ]);
  } catch (err) {
    ctx.logger(
      `Balance batch failed during shutdown close: ${err instanceof Error ? err.message : String(err)}`,
      'warn'
    );
  }

  await runBoundedPool(
    mints,
    async (mint) => {
      const pos = ctx.state.positions.get(mint);
      if (!pos) return;
      try {
        const cachedRawStr = pos.lastKnownBalanceRaw ?? pos.initialTokenAmountRaw ?? '0';
        const bal = balanceMap.get(mint) ?? {
          mint,
          rawAmount: BigInt(cachedRawStr),
          decimals: Number(pos.decimals || 0),
          uiAmount: Number(
            atomicToDecimalString(BigInt(cachedRawStr), Number(pos.decimals || 0), 9)
          ),
        };

        if (bal.rawAmount <= 0n) {
          const isShutdownOrphan = markOrphanIfNeeded(pos);
          ctx.store.removePosition(mint);
          recordClosedTrade(ctx, pos, reason);
          await ensureFlushed(ctx);
          if (isShutdownOrphan) {
            ctx.logger(
              `[SHUTDOWN_ORPHAN] Closed orphan ${pos.symbol} (${mint.slice(0, 6)}..) via ${reason}`,
              'warn',
              { console: true }
            );
          }
          return;
        }

        const p = Number(prices[mint]?.usdPrice || pos.lastKnownPriceUsd || pos.entryPriceUsd || 0);
        // Wrap exit with 3s fencing — ensure per-mint close is fully persisted or timed out
        let exitRes: Awaited<ReturnType<typeof executePositionExit>> | null = null;
        try {
          exitRes = await Promise.race([
            executePositionExit(ctx, pos, bal, p, bal.rawAmount, reason),
            new Promise<Awaited<ReturnType<typeof executePositionExit>>>((resolve) =>
              setTimeout(
                () =>
                  resolve({
                    success: false,
                    mint,
                    reason,
                    stage: 'shutdown-timeout',
                    error: 'Shutdown close timed out after 3s',
                  }),
                3000
              )
            ),
          ]);
        } catch (e: unknown) {
          exitRes = {
            success: false,
            mint,
            reason,
            stage: 'shutdown-error',
            error: e instanceof Error ? e.message : String(e),
          };
        }
        if (exitRes && !exitRes.success && ctx.state.positions.has(mint)) {
          if (exitRes.stage === 'shutdown-timeout') {
            ctx.logger(
              `Shutdown close timed out for ${pos.symbol || mint} — position still open, will retry on next shutdown flush`,
              'warn',
              { console: true }
            );
          } else {
            ctx.logger(
              `Shutdown exit failed for ${pos.symbol || mint}: ${exitRes.error}`,
              'error',
              {
                console: true,
              }
            );
          }
        }
      } catch (e: unknown) {
        ctx.logger(
          `Failed to close ${pos.symbol || mint}: ${e instanceof Error ? e.message : String(e)}`,
          'error',
          { console: true }
        );
      }
    },
    { concurrency: 4 }
  );
}

export const evaluatingMints = new Set<string>();

export async function evaluateSinglePosition(
  ctx: Context,
  mint: string,
  pos: Position,
  balance: { mint: string; rawAmount: bigint; decimals: number; uiAmount: number },
  pRecord: PriceRecord | undefined,
  preSignals: MintSignals | undefined
): Promise<void> {
  const { processingMints } = await import('./exit-executor.js');
  if (processingMints.has(mint) || positionLockManager.isExitInFlight(mint)) return;

  if (evaluatingMints.has(mint)) return;
  evaluatingMints.add(mint);

  try {
    if (balance.rawAmount <= 0n) {
      if (!pos.balanceZeroSince) {
        pos.balanceZeroSince = Date.now();
        ctx.logger(
          `Position ${pos.symbol} zero balance detected; tolerating RPC index lag.`,
          'debug'
        );
        return;
      }

      const elapsed = Date.now() - pos.balanceZeroSince;
      if (elapsed < 15000) {
        return;
      }

      // Derive SOL loss for legacy positions missing cost basis (prevents 0 SOL PnL on failed confirmation)
      const costUsd = Number(pos.remainingCostUsd ?? pos.entryUsdValue ?? 0);
      let costSol = Number(pos.remainingCostSol ?? 0);
      if (!(costSol > 0) && pos.initialBuyAmountLamports) {
        try {
          costSol = Number(BigInt(pos.initialBuyAmountLamports)) / 1e9;
        } catch {}
      }
      if (!(costSol > 0) && pos.initialBuyAmountSol != null) {
        const s = Number(pos.initialBuyAmountSol);
        if (s > 0) costSol = s;
      }
      if (
        !(costSol > 0) &&
        costUsd > 0 &&
        pos.entryPriceUsd > 0 &&
        pos.entryPriceSol != null &&
        pos.entryPriceSol > 0
      ) {
        const entrySolPrice = pos.entryPriceUsd / pos.entryPriceSol;
        if (entrySolPrice > 0) costSol = costUsd / entrySolPrice;
      }
      pos.realizedPnlUsd = -Math.max(0, costUsd);
      pos.realizedPnlSol = -Math.max(0, costSol);
      pos.remainingCostUsd = 0;
      pos.remainingCostSol = 0;
      const isZeroOrphan = markOrphanIfNeeded(pos);
      ctx.logger(
        `Position ${pos.symbol} (${mint.slice(0, 6)}..) zero balance sustained; removing and marking as failed-confirmation loss of ${pos.realizedPnlUsd.toFixed(2)} USD / ${pos.realizedPnlSol.toFixed(6)} SOL.${isZeroOrphan ? ' (ORPHAN — no cost basis)' : ''}`,
        'warn'
      );
      recordClosedTrade(ctx, pos, 'failed-confirmation');
      recordTradeResult(ctx, false, pos.realizedPnlUsd);
      ctx.store.removePosition(mint);
      await ensureFlushed(ctx);
      return;
    } else {
      if (pos.balanceZeroSince) {
        pos.balanceZeroSince = undefined;
      }
    }

    const snap = ctx.state.marketSnapshots.get(mint);
    const localDetails = marketDataProvider.getMarketPriceDetails(mint);
    const localSnap = marketDataProvider.getSnapshot(mint);
    const marketStatus = localDetails.status;
    const isProv = marketStatus === 'PROVISIONAL' || localSnap?.source === 'initial-discovery-seed';

    if (isProv) {
      ctx.logger(
        `[POSITION_DATA_INTEGRITY] Open position ${pos.symbol} (${pos.mint}) has PROVISIONAL market state. Blocking synthetic performance exits.`,
        'warn',
        { console: true }
      );
      return;
    }

    const pUsd =
      marketStatus === 'AUTHORITATIVE' && localDetails.priceUsd != null
        ? localDetails.priceUsd
        : Number(pRecord?.usdPrice || snap?.usdPrice || 0);

    if (pRecord?.liquidity != null) {
      pos.lastKnownLiquidityUsd = pRecord.liquidity;
      if (snap) {
        snap.liquidity = pRecord.liquidity;
        snap.usdPrice = pUsd;
        snap.observedAt = new Date().toISOString();
        ctx.store.updateMarketSnapshot(mint, snap);
      }
    } else if (snap?.liquidity != null || snap?.liquidityUsd != null) {
      pos.lastKnownLiquidityUsd = snap.liquidity || snap.liquidityUsd;
    }

    const liquidityExitFloor =
      pos.lastKnownLiquidityUsd != null
        ? Math.max(
            ctx.config.liquidityCollapseThresholdUsd,
            Number(pos.entryLiquidityUsd || 0) * ctx.config.liquidityCollapseThresholdRatio
          )
        : null;

    if (
      liquidityExitFloor != null &&
      pos.lastKnownLiquidityUsd != null &&
      pos.lastKnownLiquidityUsd <= liquidityExitFloor
    ) {
      ctx.logger(
        `Liquidity collapse detected for ${pos.symbol} ($${pos.lastKnownLiquidityUsd.toFixed(0)} <= $${liquidityExitFloor.toFixed(0)}).`,
        'warn',
        { console: true }
      );
      await monitorService.executePositionExit(
        ctx,
        pos,
        balance,
        pUsd || pos.lastKnownPriceUsd || pos.entryPriceUsd,
        balance.rawAmount,
        'liquidity-exit'
      );
      return;
    }

    if (!(pUsd > 0)) {
      ctx.logger(`Price unavailable for ${pos.symbol}; skipping price checks.`, 'debug');
      return;
    }

    pos.highestPriceUsd = Math.max(Number(pos.highestPriceUsd || pos.entryPriceUsd || 0), pUsd);
    pos.lastKnownBalanceRaw = balance.rawAmount.toString();
    pos.lastKnownPriceUsd = pUsd;
    pos.lastKnownPriceTimestamp =
      localDetails.observedAt > 0 ? localDetails.observedAt : Date.now();
    pos.lastKnownPriceSource = localSnap?.source || localDetails.source || 'local-authoritative';

    pos.timeSeries = pos.timeSeries || [];
    pos.timeSeries.push([Date.now(), pUsd, pos.lastKnownLiquidityUsd ?? 0]);
    if (pos.timeSeries.length > 2500) {
      pos.timeSeries.shift();
    }

    pos.priceHistory = pos.priceHistory || [];
    pos.priceHistory.push({ price: pUsd, timestamp: Date.now() });
    if (
      pRecord &&
      pRecord.bidPrice !== undefined &&
      pRecord.askPrice !== undefined &&
      pRecord.bidPrice > 0 &&
      pRecord.askPrice > 0
    ) {
      pos.spreadHistory = pos.spreadHistory || [];
      pos.spreadHistory.push({
        spread: computeSpread(pRecord.bidPrice, pRecord.askPrice),
        timestamp: Date.now(),
      });
    }

    const cutoff = Date.now() - 60000;
    pos.priceHistory = pos.priceHistory.filter((h) => h.timestamp > cutoff);
    if (pos.spreadHistory) {
      pos.spreadHistory = pos.spreadHistory.filter((h) => h.timestamp > cutoff);
    }

    ctx.store.upsertPosition(pos);

    const ageSec = (Date.now() - new Date(pos.openedAt).getTime()) / 1000;
    const multiples =
      Array.isArray(pos.takeProfitMultiples) && pos.takeProfitMultiples.length > 0
        ? pos.takeProfitMultiples
        : TAKE_PROFIT_MULTIPLES;
    const moonBag = pos.moonBagRaw ? BigInt(pos.moonBagRaw) : 0n;
    const remainingRaw = BigInt(
      pos.lastKnownBalanceRaw ?? pos.initialTokenAmountRaw ?? balance.rawAmount.toString()
    );
    const isRunnerOnly =
      moonBag > 0n && remainingRaw > 0n && remainingRaw <= moonBag + moonBag / 100n;

    const exitCtx: ExitContext = {
      ctx,
      mint,
      pos,
      balance,
      pRecord,
      preSignals,
      pUsd,
      ageSec,
      multiples,
      moonBag,
      remainingRaw,
      isRunnerOnly,
    };

    const decision = await evaluateExitChain(exitCtx);
    if (decision && decision.reason) {
      if (decision.message) {
        ctx.logger(decision.message, decision.level || 'trade', {
          console: decision.level === 'warn',
        });
      }
      // adaptiveTpMidpointGuard execution price correction
      const execPrice =
        decision.reason === 'adaptive-tp-exit'
          ? pos.entryPriceUsd * (1 + 0.5 * (multiples[pos.targetsHit!]! - 1))
          : pUsd;

      const exitResult = await monitorService.executePositionExit(
        ctx,
        pos,
        balance,
        execPrice,
        decision.sellRaw ?? balance.rawAmount,
        decision.reason
      );
      if (!exitResult.success && decision.reason === 'adaptive-tp-exit') {
        pos.minTpArmed = false;
        ctx.store.upsertPosition(pos);
      }
    }
  } finally {
    evaluatingMints.delete(mint);
  }
}

export const monitorService = {
  evaluateSinglePosition,
  evaluatingMints,
  incrementExitReasonMetric,
  executePositionExit,
  sellTakeProfit,
  buildExitAccounting,
  getTakeProfitPlan,
  getTakeProfitFraction,
  computeTakeProfitSellAmount,
  getMoodAdjustments,
  recordTradeResult,
  recordClosedTrade,
  startCoolDown,
  monitorPositions,
  closeAllOpenPositions,
};
