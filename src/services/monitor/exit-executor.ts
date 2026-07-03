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
import { Context, Position, TipContext, WalletBalance } from '#types/index.js';
import {
  recordClosedTrade,
  recordTradeResult,
  incrementExitReasonMetric,
  buildExitAccounting,
} from './trade-logger.js';
import { getTakeProfitFraction, computeTakeProfitSellAmount } from './exit-calculator.js';

export const processingMints = new Set<string>();

// Maps exit reason → urgency tier for Jito tip scaling.
// 0 = routine, 1 = soft stop, 2 = hard stop, 3 = security/liquidity collapse.
const URGENCY_MAP: Record<string, 0 | 1 | 2 | 3> = {
  'time-exit': 0,
  'tp-partial': 0,
  'tp-trailing-max-exit': 1,
  'moon-bag-trailing-exit': 1,
  'early-performance-guard': 1,
  'burst-early-failure': 1,
  'burst-trailing-exit': 1,
  'burst-distribution-exit': 1,
  'burst-time-exit': 1,
  'stop-loss': 2,
  'rug-exit': 2,
  'burst-take-profit': 2,
  'security-rug-exit': 3,
  'insider-rug-exit': 3,
  'liquidity-exit': 3,
} as const;

/**
 * Exit reasons that must NOT sell into the reserved moon-bag runner. These are routine de-risk /
 * take-profit paths. Hard exits (stop-loss, liquidity-exit, security-rug-exit, insider-rug-exit,
 * shutdown-exit, moon-bag-trailing-exit) are intentionally absent so they can liquidate the runner.
 *
 * The runner is only "activated" once the token has actually banked a take-profit target. A
 * `take-profit*` sale is that banking event (and sells a controlled fraction that can't reach the
 * runner), so it is always protected. Every other de-risk path — the midpoint guard
 * (`adaptive-tp-exit`), the core trailing stop (`tp-trailing-max-exit`), etc. — only protects the
 * runner once `targetsHit >= 1`. If the token reached a midpoint/peak but fell back before hitting
 * any real target, there is no moonshot to keep: the exit liquidates fully instead of stranding a
 * runner on a token that never ran.
 */
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

export async function executePositionExit(
  ctx: Context,
  pos: Position,
  balance: WalletBalance,
  pUsd: number,
  sellRaw: bigint,
  reason: string,
  targetM: number | null = null
): Promise<boolean> {
  // Moon-bag protection: routine de-risk/TP exits cannot sell below the reserved runner. This
  // centralizes the guard across every call site so a winner always keeps a free option on a
  // moonshot, while hard rug/stop exits (not in isMoonBagProtected) can still liquidate fully.
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
      return false;
    }
  }

  if (sellRaw <= 0n) {
    ctx.logger(`Skipping ${reason} for ${pos.symbol}; zero amount.`, 'warn');
    return false;
  }

  if (processingMints.has(pos.mint)) {
    ctx.logger(
      `Already processing exit for ${pos.symbol}; skipping concurrent ${reason}.`,
      'debug'
    );
    return false;
  }
  processingMints.add(pos.mint);

  try {
    if (pos.targetsHit === undefined) pos.targetsHit = 0;

    if (ctx.config.paperTrading) {
      // lastKnownBalanceRaw is the authoritative running balance updated after each
      // partial sell. Use it directly (rather than the passed-in balance) to cap the
      // sell amount and prevent phantom sells where the computed amount exceeds what
      // actually remains.
      const actualBalance = BigInt(
        pos.lastKnownBalanceRaw ?? pos.initialTokenAmountRaw ?? balance.rawAmount.toString()
      );
      if (actualBalance <= 0n) {
        ctx.logger(`Paper position ${pos.symbol} has zero remaining balance; closing.`, 'warn');
        ctx.store.removePosition(pos.mint);
        recordClosedTrade(ctx, pos, reason);
        return false;
      }
      const effectiveSellRaw = sellRaw > actualBalance ? actualBalance : sellRaw;

      let quote: { outAmount: bigint; grossUsdValue: number; solPrice: number };
      try {
        quote = await tradingService.buildPaperSellQuote(
          ctx,
          effectiveSellRaw,
          pUsd,
          pos.decimals,
          ctx.config.jupiterPositionApiKey
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('rounded to zero')) {
          // Remaining balance is dust — close the position with zero proceeds.
          ctx.logger(`Paper position ${pos.symbol} is dust; force-closing (${reason}).`, 'warn');
          pos.lastKnownBalanceRaw = '0';
          pos.lastExitReason = reason;
          ctx.store.removePosition(pos.mint);
          recordTradeResult(ctx, (pos.realizedPnlUsd || 0) > 0, pos.realizedPnlUsd || 0);
          recordClosedTrade(ctx, pos, reason);
          incrementExitReasonMetric(ctx, reason);
          return true;
        }
        throw err;
      }
      const remain = actualBalance - effectiveSellRaw;
      const proceedsSol = Number(atomicToDecimalString(quote.outAmount, 9, 9));
      const proceedsUsd = proceedsSol * quote.solPrice;
      const accounting = buildExitAccounting(
        pos,
        effectiveSellRaw,
        actualBalance,
        proceedsUsd,
        proceedsSol
      );

      ctx.store.updatePaperSolBalance(BigInt(ctx.state.paperSolBalanceLamports) + quote.outAmount);

      if (reason.startsWith('take-profit') || reason.startsWith('swing-take-profit'))
        pos.targetsHit++;
      pos.lastTakeProfitAt = new Date().toISOString();
      pos.lastTakeProfitMultiple = targetM;
      pos.lastKnownBalanceRaw = remain.toString();
      pos.lastKnownPriceUsd = pUsd;
      pos.remainingCostUsd = accounting.remainingCostUsd;
      pos.remainingCostSol = accounting.remainingCostSol;
      pos.realizedPnlUsd = (pos.realizedPnlUsd || 0) + accounting.realizedPnlUsd;
      pos.realizedPnlSol = (pos.realizedPnlSol || 0) + accounting.realizedPnlSol;
      pos.realizedProceedsUsd = (pos.realizedProceedsUsd || 0) + proceedsUsd;
      pos.realizedProceedsSol = (pos.realizedProceedsSol || 0) + proceedsSol;
      pos.lastExitReason = reason;
      pos.exitPriceUsd = pUsd;

      if (remain > 0n) {
        ctx.store.upsertPosition(pos);
      } else {
        ctx.store.removePosition(pos.mint);
        const win = (pos.realizedPnlUsd || 0) > 0;
        recordTradeResult(ctx, win, pos.realizedPnlUsd || 0);
        recordClosedTrade(ctx, pos, reason);
        if (win) ctx.store.incrementMetric('profitableTrades');
        if (reason === 'stop-loss') ctx.store.incrementMetric('stopLosses');
        if (reason === 'tp-trailing-max-exit') ctx.store.incrementMetric('trailingExits');
      }

      incrementExitReasonMetric(ctx, reason);
      journalPaperTrade(ctx, {
        event: remain > 0n ? 'sell' : 'close',
        mint: pos.mint,
        symbol: pos.symbol,
        priceUsd: pUsd,
        tokenAmount: effectiveSellRaw.toString(),
        proceedsUsd: proceedsUsd,
        proceedsSol: proceedsSol,
        realizedPnlUsd: accounting.realizedPnlUsd,
        realizedPnlSol: accounting.realizedPnlSol,
        reason,
        mode: 'paper',
      });
      ctx.logger(
        `PAPER ${reason} on ${pos.symbol}. SOL out ${atomicToDecimalString(quote.outAmount, 9, 6)}. PnL: ${formatUsd(accounting.realizedPnlUsd)}`,
        'trade'
      );
      return true;
    }

    const isPanic = [
      'liquidity-exit',
      'stop-loss',
      'rug-exit',
      'tp-trailing-max-exit',
      'moon-bag-trailing-exit',
      'early-performance-guard',
      'burst-early-failure',
      'burst-trailing-exit',
      'burst-distribution-exit',
      'burst-time-exit',
      'security-rug-exit',
      'insider-rug-exit',
    ].includes(reason);
    if (ctx.config.dryRun) {
      ctx.logger(`DRY_RUN would sell ${pos.symbol} for ${reason}.`, 'trade');
      return false;
    }

    const upBalBefore = await tradingService.getWalletTokenBalance(ctx, pos.mint, PRIORITY.HIGH);
    const actualSellRaw = sellRaw > upBalBefore.rawAmount ? upBalBefore.rawAmount : sellRaw;

    if (actualSellRaw <= 0n) {
      if (!pos.balanceZeroSince) {
        pos.balanceZeroSince = Date.now();
        ctx.logger(
          `Live exit skipped for ${pos.symbol}: no tokens found. Tolerating RPC index lag.`,
          'debug'
        );
        return false;
      }

      const elapsed = Date.now() - pos.balanceZeroSince;
      if (elapsed < 15000) {
        return false;
      }

      ctx.logger(
        `Live exit skipped for ${pos.symbol}: zero tokens sustained. Removing position.`,
        'warn'
      );
      ctx.store.removePosition(pos.mint);
      return false;
    } else {
      if (pos.balanceZeroSince) {
        pos.balanceZeroSince = undefined;
      }
    }

    const solBalanceBefore = await tradingService.getSolBalance(ctx).catch(() => 0n);

    // Build graduated tip context for Jito: urgency tier + unrealized P&L as EV cap.
    const urgency = URGENCY_MAP[reason] ?? 0;
    const preSolPrice = await tradingService.estimateSolUsdPrice(ctx).catch(() => 0);
    let sellTipContext: TipContext | undefined;
    if (preSolPrice > 0) {
      const entryPriceInSol = pos.entryPriceUsd / preSolPrice;
      const currentPriceInSol = pUsd / preSolPrice;
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
      proceedsSol
    );

    if (reason.startsWith('take-profit') || reason.startsWith('swing-take-profit'))
      pos.targetsHit++;
    pos.lastTakeProfitAt = new Date().toISOString();
    pos.lastTakeProfitMultiple = targetM;
    const localFallback =
      upBalBefore.rawAmount > actualSellRaw ? upBalBefore.rawAmount - actualSellRaw : 0n;
    pos.lastKnownBalanceRaw = (
      upBalAfter.rawAmount < upBalBefore.rawAmount ? upBalAfter.rawAmount : localFallback
    ).toString();
    pos.lastKnownPriceUsd = pUsd;
    pos.remainingCostUsd = acc.remainingCostUsd;
    pos.remainingCostSol = acc.remainingCostSol;
    pos.realizedPnlUsd = (pos.realizedPnlUsd || 0) + acc.realizedPnlUsd;
    pos.realizedPnlSol = (pos.realizedPnlSol || 0) + acc.realizedPnlSol;
    pos.realizedProceedsUsd = (pos.realizedProceedsUsd || 0) + proceedsUsd;
    pos.realizedProceedsSol = (pos.realizedProceedsSol || 0) + proceedsSol;
    pos.lastExitReason = reason;
    pos.lastSellSignature = sig;
    pos.exitPriceUsd = pUsd;

    const totalT = Array.isArray(pos.takeProfitMultiples)
      ? pos.takeProfitMultiples.length
      : TAKE_PROFIT_MULTIPLES.length;

    const remainingBal = upBalAfter.rawAmount;
    const hasMoonBag = pos.moonBagRaw && BigInt(pos.moonBagRaw) > 0n;

    if (remainingBal <= 0n || (!hasMoonBag && pos.targetsHit >= totalT)) {
      ctx.store.removePosition(pos.mint);
      const win = (pos.realizedPnlUsd || 0) > 0;
      recordTradeResult(ctx, win, pos.realizedPnlUsd || 0);
      recordClosedTrade(ctx, pos, reason);
      if (win) ctx.store.incrementMetric('profitableTrades');
      if (reason === 'stop-loss') ctx.store.incrementMetric('stopLosses');
      if (reason === 'tp-trailing-max-exit') ctx.store.incrementMetric('trailingExits');
      startCoolDown(ctx, pos.mint, pUsd);

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
      ctx.store.upsertPosition(pos);
    }

    incrementExitReasonMetric(ctx, reason);
    const pnlUsd = acc.realizedPnlUsd;
    const roi = (pnlUsd / Number(pos.entryUsdValue)) * 100;
    const msg = `EXIT: ${pos.symbol}\nReason: ${reason}\nPrice: ${formatUsd(pUsd)}\nPnL: ${formatUsd(pnlUsd)} (${roi.toFixed(2)}%)`;
    void sendNotification(ctx, msg).catch((err: unknown) => {
      ctx.logger(
        `Exit notification failed for ${pos.symbol}: ${err instanceof Error ? err.message : String(err)}`,
        'debug'
      );
    });
    ctx.logger(
      `Sold ${pos.symbol} for ${reason} at ${formatUsd(pUsd)}. PnL: ${formatUsd(pnlUsd)} (${roi.toFixed(2)}%). sig: ${sig}`,
      'trade'
    );

    return true;
  } catch (err: unknown) {
    ctx.logger(
      `Failed to exit ${pos.symbol} for ${reason}: ${err instanceof Error ? err.message : String(err)}`,
      'error'
    );
    return false;
  } finally {
    processingMints.delete(pos.mint);
  }
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
  return executePositionExit(ctx, pos, balance, pUsd, amt, `take-profit-${targetM}x`, targetM);
}

export function startCoolDown(ctx: Context, mint: string, pUsd: number): void {
  const expires = Date.now() + ctx.config.coolDownMinutes * 60000;
  ctx.store.startCoolDown(mint, pUsd, expires);
}
