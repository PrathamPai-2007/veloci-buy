import {
  sleep,
  atomicToDecimalString,
  formatUsd,
  sendNotification,
  journalPaperTrade,
  PRIORITY,
} from '#core/utils.js';
import { SOL_MINT, TAKE_PROFIT_MULTIPLES } from '#core/config.js';
import { tradingService } from '../trading/trading.service.js';
import { Context, Position, TipContext, WalletBalance, ExitResult } from '#types/index.js';
import {
  recordClosedTrade,
  recordTradeResult,
  incrementExitReasonMetric,
  buildExitAccounting,
} from './trade-logger.js';
import { getTakeProfitFraction, computeTakeProfitSellAmount } from './exit-calculator.js';
import {
  positionLockManager,
  logPositionEvent,
  transitionPositionLifecycle,
  markOrphanIfNeeded,
  ensureFlushed,
} from './position-sync.js';
import { marketDataProvider } from '../market-state/index.js';

export const processingMints = new Set<string>();

// Idempotency guard: remembers recently closed (mint|outAmount) to prevent duplicate credit/journal on re-trigger.
const recentCloseDedup = new Map<string, number>();
const DEDUP_WINDOW_MS = 60_000;
function isDuplicateClose(mint: string, outAmount: string): boolean {
  const key = `${mint}:${outAmount}`;
  const last = recentCloseDedup.get(key);
  const now = Date.now();
  if (last != null && now - last < DEDUP_WINDOW_MS) return true;
  recentCloseDedup.set(key, now);
  // prune old
  for (const [k, ts] of [...recentCloseDedup.entries()]) {
    if (now - ts > DEDUP_WINDOW_MS) recentCloseDedup.delete(k);
  }
  return false;
}

// Maps exit reason → urgency tier for Jito tip scaling.
// 0 = routine, 1 = soft stop, 2 = hard stop, 3 = security/liquidity collapse.
const URGENCY_MAP: Record<string, 0 | 1 | 2 | 3> = {
  'time-exit': 0,
  'tp-partial': 0,
  'tp-trailing-max-exit': 1,
  'moon-bag-trailing-exit': 1,
  'early-performance-guard': 1,
  'stop-loss': 2,
  'rug-exit': 2,
  'security-rug-exit': 3,
  'insider-rug-exit': 3,
  'liquidity-exit': 3,
} as const;

function isMoonBagProtected(reason: string, targetsHit: number): boolean {
  if (reason.startsWith('take-profit')) return true;
  if (targetsHit < 1) return false;
  return (
    reason === 'adaptive-tp-exit' ||
    reason === 'early-performance-guard' ||
    reason === 'insider-drift-exit' ||
    reason === 'tp-trailing-max-exit'
  );
}

const POSITION_PRICE_MAX_AGE_MS = 10_000;

export async function executePositionExit(
  ctx: Context,
  pos: Position,
  balance: WalletBalance,
  pUsd: number,
  sellRaw: bigint,
  reason: string,
  targetM: number | null = null
): Promise<ExitResult> {
  const existingInFlight = positionLockManager.getExitPromise(pos.mint);
  if (existingInFlight) {
    logPositionEvent(ctx, 'POSITION_SHUTDOWN_WAIT', pos, {
      reason,
      message: `Awaiting existing in-flight exit for ${pos.symbol}`,
    });
    const prevResult = await existingInFlight;
    if (!ctx.state.positions.has(pos.mint)) {
      return {
        ...prevResult,
        reason,
        stage: 'joined-inflight-completed',
      };
    }
  }

  return positionLockManager.runExitExclusive(pos.mint, async (): Promise<ExitResult> => {
    if (!ctx.state.positions.has(pos.mint)) {
      return {
        success: false,
        mint: pos.mint,
        reason,
        stage: 'position-already-closed',
        error: 'Position is no longer open in store',
      };
    }

    processingMints.add(pos.mint);
    transitionPositionLifecycle(pos, 'EXITING');

    try {
      if (pos.targetsHit === undefined) pos.targetsHit = 0;

      const now = Date.now();
      const priceDetails = marketDataProvider.getMarketPriceDetails(pos.mint);

      if (
        priceDetails.status === 'PROVISIONAL' ||
        priceDetails.source === 'initial-discovery-seed'
      ) {
        transitionPositionLifecycle(pos, 'OPEN');
        ctx.logger(
          `[POSITION_DATA_INTEGRITY] Blocking ${reason} exit for ${pos.symbol}: authoritative market state unavailable.`,
          'warn',
          { console: true }
        );
        return {
          success: false,
          mint: pos.mint,
          reason,
          stage: 'provisional-market-state',
          error: 'Authoritative market state unavailable',
          priceSource: priceDetails.source,
          priceTimestamp: priceDetails.observedAt,
          priceAgeMs: priceDetails.ageMs,
        };
      }

      let priceUsd =
        pUsd > 0
          ? pUsd
          : Number(priceDetails.priceUsd || pos.lastKnownPriceUsd || pos.entryPriceUsd || 0);
      let priceSource = priceDetails.source || pos.lastKnownPriceSource || 'local-authoritative';
      let priceTimestamp =
        priceDetails.observedAt > 0 ? priceDetails.observedAt : pos.lastKnownPriceTimestamp || now;
      let priceAgeMs = now - priceTimestamp;

      if (
        priceAgeMs > POSITION_PRICE_MAX_AGE_MS ||
        !(priceUsd > 0) ||
        priceDetails.status !== 'AUTHORITATIVE'
      ) {
        if (
          priceDetails.status === 'AUTHORITATIVE' &&
          priceDetails.isFresh &&
          priceDetails.priceUsd
        ) {
          priceUsd = priceDetails.priceUsd;
          priceSource = priceDetails.source || 'refresh-authoritative';
          priceTimestamp = priceDetails.observedAt;
          priceAgeMs = priceDetails.ageMs;
        } else if (
          pos.lastKnownPriceUsd != null &&
          pos.lastKnownPriceUsd > 0 &&
          pos.lastKnownPriceSource !== 'initial-discovery-seed'
        ) {
          priceUsd = pos.lastKnownPriceUsd;
          priceSource = pos.lastKnownPriceSource || 'stale-fallback';
          ctx.logger(
            `Using stale cached price $${priceUsd} for ${pos.symbol} exit (${reason}); age ${priceAgeMs}ms`,
            'warn'
          );
        } else {
          priceUsd = pos.entryPriceUsd;
          priceSource = pos.lastKnownPriceSource || 'entry-fallback';
          ctx.logger(
            `Using entry price $${priceUsd} for ${pos.symbol} exit (${reason}); no fresh price available`,
            'warn'
          );
        }
      }

      if (pos.moonBagRaw && isMoonBagProtected(reason, pos.targetsHit ?? 0)) {
        const moonBag = BigInt(pos.moonBagRaw);
        const currentBal = BigInt(
          pos.lastKnownBalanceRaw ?? pos.initialTokenAmountRaw ?? balance.rawAmount.toString()
        );
        const sellable = currentBal > moonBag ? currentBal - moonBag : 0n;
        if (sellRaw > sellable) sellRaw = sellable;
        if (sellRaw <= 0n) {
          ctx.logger(
            `Holding moon bag for ${pos.symbol}: ${reason} would dip into reserved runner.`,
            'debug'
          );
          logPositionEvent(ctx, 'POSITION_EXIT_FAILED', pos, {
            reason,
            stage: 'moonbag-protected',
            error: 'Selling would dip into reserved moon bag runner',
          });
          transitionPositionLifecycle(pos, 'OPEN');
          return {
            success: false,
            mint: pos.mint,
            reason,
            stage: 'moonbag-protected',
            error: 'Selling would dip into reserved moon bag runner',
            priceUsd,
            priceSource,
            priceTimestamp,
            priceAgeMs,
          };
        }
      }

      if (sellRaw <= 0n) {
        ctx.logger(`Skipping ${reason} for ${pos.symbol}; zero amount.`, 'warn');
        logPositionEvent(ctx, 'POSITION_EXIT_FAILED', pos, {
          reason,
          stage: 'zero-sell-amount',
          error: 'Zero sell amount requested',
        });
        transitionPositionLifecycle(pos, 'OPEN');
        return {
          success: false,
          mint: pos.mint,
          reason,
          stage: 'zero-sell-amount',
          error: 'Zero sell amount requested',
          priceUsd,
          priceSource,
          priceTimestamp,
          priceAgeMs,
        };
      }

      const actualBalance = BigInt(
        pos.lastKnownBalanceRaw ?? pos.initialTokenAmountRaw ?? balance.rawAmount.toString()
      );
      if (actualBalance <= 0n) {
        ctx.logger(`Paper position ${pos.symbol} has zero remaining balance; closing.`, 'warn');
        transitionPositionLifecycle(pos, 'CLOSED');
        ctx.store.removePosition(pos.mint);
        recordClosedTrade(ctx, pos, reason);
        logPositionEvent(ctx, 'POSITION_CLOSED', pos, {
          reason,
          stage: 'zero-balance',
        });
        return {
          success: false,
          mint: pos.mint,
          reason,
          stage: 'zero-balance',
          error: 'Position has zero remaining balance',
          priceUsd,
          priceSource,
          priceTimestamp,
          priceAgeMs,
        };
      }

      const effectiveSellRaw = sellRaw > actualBalance ? actualBalance : sellRaw;

      logPositionEvent(ctx, 'POSITION_EXIT_START', pos, {
        reason,
        effectiveSellRaw: effectiveSellRaw.toString(),
        actualBalance: actualBalance.toString(),
        priceUsd,
        priceSource,
        priceAgeMs,
      });

      if (ctx.config.paperTrading) {
        let quote: Awaited<ReturnType<typeof tradingService.buildPaperSellQuote>>;
        try {
          quote = await tradingService.buildPaperSellQuote(
            ctx,
            effectiveSellRaw,
            priceUsd,
            pos.decimals,
            ctx.config.jupiterPositionApiKey
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('rounded to zero')) {
            ctx.logger(`Paper position ${pos.symbol} is dust; force-closing (${reason}).`, 'warn');
            pos.lastKnownBalanceRaw = '0';
            pos.lastExitReason = reason;
            transitionPositionLifecycle(pos, 'CLOSED');
            ctx.store.removePosition(pos.mint);
            recordTradeResult(ctx, (pos.realizedPnlUsd || 0) > 0, pos.realizedPnlUsd || 0);
            recordClosedTrade(ctx, pos, reason);
            incrementExitReasonMetric(ctx, reason);
            logPositionEvent(ctx, 'POSITION_CLOSED', pos, { reason, stage: 'dust-force-close' });
            return {
              success: true,
              mint: pos.mint,
              reason,
              stage: 'dust-force-close',
              priceUsd,
              priceSource,
              soldRaw: effectiveSellRaw.toString(),
              proceedsLamports: '0',
              proceedsUsd: 0,
              proceedsSol: 0,
            };
          }
          logPositionEvent(ctx, 'POSITION_EXIT_FAILED', pos, {
            reason,
            stage: 'quote-error',
            error: msg,
          });
          transitionPositionLifecycle(pos, 'EXIT_FAILED');
          return {
            success: false,
            mint: pos.mint,
            reason,
            stage: 'quote-error',
            error: msg,
            priceUsd,
            priceSource,
          };
        }

        const remain = actualBalance - effectiveSellRaw;
        // Dedup guard: only for full closes (remain==0) with same mint+outAmount within window — prevents rug→SL double-count.
        if (remain === 0n && isDuplicateClose(pos.mint, quote.outAmount.toString())) {
          ctx.logger(
            `Duplicate close suppressed for ${pos.symbol} (${pos.mint.slice(0, 6)}..): ${reason} same outAmount ${quote.outAmount.toString()} — already closed.`,
            'warn'
          );
          logPositionEvent(ctx, 'POSITION_DUPLICATE_CLOSE_SUPPRESSED', pos, {
            reason,
            outAmountLamports: quote.outAmount.toString(),
          });
          if (!ctx.state.positions.has(pos.mint)) {
            return {
              success: false,
              mint: pos.mint,
              reason,
              stage: 'duplicate-suppressed-already-closed',
              error: 'Duplicate close already processed',
            };
          }
          transitionPositionLifecycle(pos, 'CLOSED');
          ctx.store.removePosition(pos.mint);
          return {
            success: true,
            mint: pos.mint,
            reason,
            stage: 'duplicate-suppressed',
            priceUsd,
            priceSource,
            priceTimestamp,
            priceAgeMs,
            solPriceUsd: quote.solPrice,
            solPriceSource: quote.solPriceSource,
            solPriceTimestamp: quote.solPriceTimestamp,
            solPriceAgeMs: quote.solPriceAgeMs,
            soldRaw: effectiveSellRaw.toString(),
            proceedsLamports: quote.outAmount.toString(),
            proceedsUsd: Number(atomicToDecimalString(quote.outAmount, 9, 9)) * quote.solPrice,
            proceedsSol: Number(atomicToDecimalString(quote.outAmount, 9, 9)),
          };
        }
        const proceedsSol = Number(atomicToDecimalString(quote.outAmount, 9, 9));
        const proceedsUsd = proceedsSol * quote.solPrice;
        const accounting = buildExitAccounting(
          pos,
          effectiveSellRaw,
          actualBalance,
          proceedsUsd,
          proceedsSol,
          quote.solPrice
        );

        logPositionEvent(ctx, 'POSITION_SELL_QUOTE', pos, {
          reason,
          effectiveSellRaw: effectiveSellRaw.toString(),
          outAmountLamports: quote.outAmount.toString(),
          proceedsUsd,
          proceedsSol,
          solPriceUsd: quote.solPrice,
          solPriceSource: quote.solPriceSource,
          solPriceTimestamp: quote.solPriceTimestamp,
          solPriceAgeMs: quote.solPriceAgeMs,
        });

        const isOrphan = markOrphanIfNeeded(pos);
        // Credit SOL but flag orphan — no cost basis to offset, still update balance for reconciliation
        ctx.store.updatePaperSolBalance(
          BigInt(ctx.state.paperSolBalanceLamports) + quote.outAmount
        );
        if (isOrphan) {
          logPositionEvent(ctx, 'POSITION_ORPHAN_EXIT', pos, {
            reason,
            proceedsSol,
            proceedsUsd,
            outAmountLamports: quote.outAmount.toString(),
          });
          ctx.logger(
            `[POSITION_ORPHAN_EXIT] Orphan close for ${pos.symbol} (${pos.mint.slice(0, 6)}..${pos.mint.slice(-4)}) via ${reason} — no cost basis (remainingCostSol=0, entryPriceSol=0, initialBuyAmountLamports=null). SOL credited but flagged.`,
            'warn',
            { console: true }
          );
        }

        if (reason.startsWith('take-profit')) {
          pos.targetsHit++;
        }
        pos.lastTakeProfitAt = new Date().toISOString();
        pos.lastTakeProfitMultiple = targetM;
        pos.lastKnownBalanceRaw = remain.toString();
        pos.lastKnownPriceUsd = priceUsd;
        pos.lastKnownPriceTimestamp = priceTimestamp;
        pos.lastKnownPriceSource = priceSource;
        pos.exitPriceUsd = priceUsd;
        pos.exitPriceSource = priceSource;
        pos.exitPriceTimestamp = priceTimestamp;
        pos.exitPriceAgeMs = priceAgeMs;
        pos.remainingCostUsd = accounting.remainingCostUsd;
        pos.remainingCostSol = accounting.remainingCostSol;
        pos.realizedPnlUsd = (pos.realizedPnlUsd || 0) + accounting.realizedPnlUsd;
        pos.realizedPnlSol = (pos.realizedPnlSol || 0) + accounting.realizedPnlSol;
        pos.realizedProceedsUsd = (pos.realizedProceedsUsd || 0) + proceedsUsd;
        pos.realizedProceedsSol = (pos.realizedProceedsSol || 0) + proceedsSol;
        pos.lastExitReason = reason;

        if (remain > 0n) {
          transitionPositionLifecycle(pos, 'PARTIALLY_EXITED');
          pos.partiallyClosed = true;
          ctx.store.upsertPosition(pos);
          logPositionEvent(ctx, 'POSITION_PARTIAL_EXIT', pos, {
            reason,
            soldRaw: effectiveSellRaw.toString(),
            remainRaw: remain.toString(),
            realizedPnlUsd: accounting.realizedPnlUsd,
            orphan: pos.orphan ?? isOrphan,
          });
        } else {
          transitionPositionLifecycle(pos, 'CLOSED');
          ctx.store.removePosition(pos.mint);
          const win = (pos.realizedPnlUsd || 0) > 0;
          recordTradeResult(ctx, win, pos.realizedPnlUsd || 0);
          recordClosedTrade(ctx, pos, reason);
          if (win) ctx.store.incrementMetric('profitableTrades');
          if (reason === 'stop-loss') ctx.store.incrementMetric('stopLosses');
          if (reason === 'tp-trailing-max-exit') ctx.store.incrementMetric('trailingExits');
          logPositionEvent(ctx, 'POSITION_CLOSED', pos, {
            reason,
            totalRealizedPnlUsd: pos.realizedPnlUsd,
            orphan: isOrphan || undefined,
          });
        }

        incrementExitReasonMetric(ctx, reason);
        journalPaperTrade(ctx, {
          event: remain > 0n ? 'sell' : 'close',
          mint: pos.mint,
          symbol: pos.symbol,
          priceUsd,
          tokenAmount: effectiveSellRaw.toString(),
          proceedsUsd,
          proceedsSol,
          realizedPnlUsd: accounting.realizedPnlUsd,
          realizedPnlSol: accounting.realizedPnlSol,
          reason,
          mode: 'paper',
          orphan: isOrphan || undefined,
        });
        const orphanTag = isOrphan && remain === 0n ? ' (ORPHAN — no cost basis)' : '';
        ctx.logger(
          `PAPER ${reason} on ${pos.symbol} (${pos.mint.slice(0, 6)}..${pos.mint.slice(-4)})${orphanTag}. SOL out ${atomicToDecimalString(quote.outAmount, 9, 6)}. PnL: ${formatUsd(accounting.realizedPnlUsd)} (SOL PnL: ${accounting.realizedPnlSol.toFixed(6)})`,
          'trade'
        );

        // Ensure fully closed before returning — wait up to 3s for WAL flush
        if (remain === 0n) await ensureFlushed(ctx);

        return {
          success: true,
          mint: pos.mint,
          reason,
          stage: remain > 0n ? 'partially-exited' : 'closed',
          priceUsd,
          priceSource,
          priceTimestamp,
          priceAgeMs,
          solPriceUsd: quote.solPrice,
          solPriceSource: quote.solPriceSource,
          solPriceTimestamp: quote.solPriceTimestamp,
          solPriceAgeMs: quote.solPriceAgeMs,
          soldRaw: effectiveSellRaw.toString(),
          proceedsLamports: quote.outAmount.toString(),
          proceedsUsd,
          proceedsSol,
        };
      }

      // Live mode execution path
      const isPanic = [
        'liquidity-exit',
        'stop-loss',
        'rug-exit',
        'tp-trailing-max-exit',
        'moon-bag-trailing-exit',
        'early-performance-guard',
        'security-rug-exit',
        'insider-rug-exit',
      ].includes(reason);

      if (ctx.config.dryRun) {
        ctx.logger(`DRY_RUN would sell ${pos.symbol} for ${reason}.`, 'trade');
        transitionPositionLifecycle(pos, 'OPEN');
        return {
          success: false,
          mint: pos.mint,
          reason,
          stage: 'dry-run',
          error: 'Dry run enabled; no live trade executed',
        };
      }

      const upBalBefore = await tradingService.getWalletTokenBalance(ctx, pos.mint, PRIORITY.HIGH);
      const actualSellRaw =
        effectiveSellRaw > upBalBefore.rawAmount ? upBalBefore.rawAmount : effectiveSellRaw;

      if (actualSellRaw <= 0n) {
        if (!pos.balanceZeroSince) {
          pos.balanceZeroSince = Date.now();
          ctx.logger(
            `Live exit skipped for ${pos.symbol}: no tokens found. Tolerating RPC index lag.`,
            'debug'
          );
          transitionPositionLifecycle(pos, 'OPEN');
          return {
            success: false,
            mint: pos.mint,
            reason,
            stage: 'rpc-lag-waiting',
            error: 'No tokens found in live wallet balance',
          };
        }

        const elapsed = Date.now() - pos.balanceZeroSince;
        if (elapsed < 15000) {
          transitionPositionLifecycle(pos, 'OPEN');
          return {
            success: false,
            mint: pos.mint,
            reason,
            stage: 'rpc-lag-waiting',
            error: 'No tokens found in live wallet balance',
          };
        }

        ctx.logger(
          `Live exit skipped for ${pos.symbol}: zero tokens sustained. Removing position.`,
          'warn'
        );
        transitionPositionLifecycle(pos, 'CLOSED');
        ctx.store.removePosition(pos.mint);
        logPositionEvent(ctx, 'POSITION_CLOSED', pos, { reason, stage: 'sustained-zero-balance' });
        return {
          success: false,
          mint: pos.mint,
          reason,
          stage: 'sustained-zero-balance',
          error: 'Sustained zero balance in live wallet',
        };
      } else {
        if (pos.balanceZeroSince) {
          pos.balanceZeroSince = undefined;
        }
      }

      const solBalanceBefore = await tradingService.getSolBalance(ctx).catch(() => 0n);
      const preSolDetails = await tradingService.estimateSolUsdPriceDetails(ctx).catch(() => null);
      const preSolPrice = preSolDetails?.price ?? 0;

      let sellTipContext: TipContext | undefined;
      const urgency = URGENCY_MAP[reason] ?? 0;
      if (preSolPrice > 0) {
        const entryPriceInSol = pos.entryPriceUsd / preSolPrice;
        const currentPriceInSol = priceUsd / preSolPrice;
        const priceChangeSol = currentPriceInSol - entryPriceInSol;
        const unrealizedLamports = BigInt(
          Math.max(0, Math.round(priceChangeSol * Number(actualSellRaw)))
        );
        sellTipContext = {
          confidence: pos.entryConfidence ?? 0.5,
          expectedValueLamports: unrealizedLamports,
          urgencyMultiplier: ([1.0, 1.5, 2.0, 3.0] as const)[urgency],
        };
      }

      const { signature: sig, order } = await tradingService.executeSwapOrderWithSmartRetry(
        ctx,
        pos.mint,
        SOL_MINT,
        actualSellRaw.toString(),
        isPanic,
        null,
        sellTipContext
      );

      await sleep(2000);
      const upBalAfter = await tradingService.getWalletTokenBalance(ctx, pos.mint, PRIORITY.HIGH);
      const solBalanceAfter = await tradingService.getSolBalance(ctx).catch(() => 0n);

      let proceedsSol = Number(atomicToDecimalString(order.outAmount || '0', 9, 9));
      if (solBalanceBefore > 0n && solBalanceAfter > 0n && solBalanceAfter > solBalanceBefore) {
        proceedsSol = Number(atomicToDecimalString(solBalanceAfter - solBalanceBefore, 9, 9));
      }
      const proceedsUsd = preSolPrice > 0 ? proceedsSol * preSolPrice : 0;
      const acc = buildExitAccounting(
        pos,
        actualSellRaw,
        upBalBefore.rawAmount,
        proceedsUsd,
        proceedsSol,
        preSolPrice > 0 ? preSolPrice : undefined
      );

      if (reason.startsWith('take-profit')) {
        pos.targetsHit++;
      }
      pos.lastTakeProfitAt = new Date().toISOString();
      pos.lastTakeProfitMultiple = targetM;
      const localFallback =
        upBalBefore.rawAmount > actualSellRaw ? upBalBefore.rawAmount - actualSellRaw : 0n;
      pos.lastKnownBalanceRaw = (
        upBalAfter.rawAmount < upBalBefore.rawAmount ? upBalAfter.rawAmount : localFallback
      ).toString();
      pos.lastKnownPriceUsd = priceUsd;
      pos.lastKnownPriceTimestamp = priceTimestamp;
      pos.lastKnownPriceSource = priceSource;
      pos.remainingCostUsd = acc.remainingCostUsd;
      pos.remainingCostSol = acc.remainingCostSol;
      pos.realizedPnlUsd = (pos.realizedPnlUsd || 0) + acc.realizedPnlUsd;
      pos.realizedPnlSol = (pos.realizedPnlSol || 0) + acc.realizedPnlSol;
      pos.realizedProceedsUsd = (pos.realizedProceedsUsd || 0) + proceedsUsd;
      pos.realizedProceedsSol = (pos.realizedProceedsSol || 0) + proceedsSol;
      pos.lastExitReason = reason;
      pos.lastSellSignature = sig;
      pos.exitPriceUsd = priceUsd;
      pos.exitPriceSource = priceSource;
      pos.exitPriceTimestamp = priceTimestamp;
      pos.exitPriceAgeMs = priceAgeMs;

      const totalT = Array.isArray(pos.takeProfitMultiples)
        ? pos.takeProfitMultiples.length
        : TAKE_PROFIT_MULTIPLES.length;

      const remainingBal = upBalAfter.rawAmount;
      const hasMoonBag = pos.moonBagRaw && BigInt(pos.moonBagRaw) > 0n;

      if (remainingBal <= 0n || (!hasMoonBag && pos.targetsHit >= totalT)) {
        transitionPositionLifecycle(pos, 'CLOSED');
        ctx.store.removePosition(pos.mint);
        const win = (pos.realizedPnlUsd || 0) > 0;
        recordTradeResult(ctx, win, pos.realizedPnlUsd || 0);
        recordClosedTrade(ctx, pos, reason);
        if (win) ctx.store.incrementMetric('profitableTrades');
        if (reason === 'stop-loss') ctx.store.incrementMetric('stopLosses');
        if (reason === 'tp-trailing-max-exit') ctx.store.incrementMetric('trailingExits');
        startCoolDown(ctx, pos.mint, priceUsd);
        logPositionEvent(ctx, 'POSITION_CLOSED', pos, { reason, sig });

        const closeAta = () =>
          tradingService.closeAssociatedTokenAccount(ctx, pos.mint).catch((err: unknown) => {
            ctx.logger(
              `ATA close failure for ${pos.symbol}: ${err instanceof Error ? err.message : String(err)}`,
              'debug'
            );
          });
        if (ctx.config.backgroundAtaClose) void closeAta();
        else await closeAta();
      } else {
        transitionPositionLifecycle(pos, 'PARTIALLY_EXITED');
        pos.partiallyClosed = true;
        ctx.store.upsertPosition(pos);
        logPositionEvent(ctx, 'POSITION_PARTIAL_EXIT', pos, { reason, sig });
      }

      incrementExitReasonMetric(ctx, reason);
      const pnlUsd = acc.realizedPnlUsd;
      const roi = (pnlUsd / Number(pos.entryUsdValue)) * 100;
      const msg = `EXIT: ${pos.symbol}\nReason: ${reason}\nPrice: ${formatUsd(priceUsd)}\nPnL: ${formatUsd(pnlUsd)} (${roi.toFixed(2)}%)`;
      void sendNotification(ctx, msg).catch((err: unknown) => {
        ctx.logger(
          `Exit notification failed for ${pos.symbol}: ${err instanceof Error ? err.message : String(err)}`,
          'debug'
        );
      });
      ctx.logger(
        `Sold ${pos.symbol} for ${reason} at ${formatUsd(priceUsd)}. PnL: ${formatUsd(pnlUsd)} (${roi.toFixed(2)}%). sig: ${sig}`,
        'trade'
      );

      return {
        success: true,
        mint: pos.mint,
        reason,
        stage: remainingBal <= 0n ? 'closed' : 'partially-exited',
        priceUsd,
        priceSource,
        priceTimestamp,
        priceAgeMs,
        solPriceUsd: preSolPrice,
        solPriceSource: preSolDetails?.source ?? 'unknown',
        solPriceTimestamp: preSolDetails?.timestamp,
        solPriceAgeMs: preSolDetails?.ageMs,
        soldRaw: actualSellRaw.toString(),
        proceedsUsd,
        proceedsSol,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      ctx.logger(`Failed to exit ${pos.symbol} for ${reason}: ${errorMsg}`, 'error');
      transitionPositionLifecycle(pos, 'EXIT_FAILED');
      logPositionEvent(ctx, 'POSITION_EXIT_FAILED', pos, { reason, error: errorMsg });
      return {
        success: false,
        mint: pos.mint,
        reason,
        stage: 'execution-error',
        error: errorMsg,
      };
    } finally {
      processingMints.delete(pos.mint);
    }
  });
}

export async function sellTakeProfit(
  ctx: Context,
  pos: Position,
  balance: WalletBalance,
  pUsd: number,
  targetM: number
): Promise<boolean> {
  const frac = getTakeProfitFraction(pos, pos.targetsHit || 0);
  const amt = computeTakeProfitSellAmount(balance.rawAmount, frac);
  const res = await executePositionExit(
    ctx,
    pos,
    balance,
    pUsd,
    amt,
    `take-profit-${targetM}x`,
    targetM
  );
  return res.success;
}

export function startCoolDown(ctx: Context, mint: string, pUsd: number): void {
  const expires = Date.now() + ctx.config.coolDownMinutes * 60000;
  ctx.store.startCoolDown(mint, pUsd, expires);
}
