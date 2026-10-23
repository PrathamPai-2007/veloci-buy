import { journalClosedTrade, bigintRatioToNumber } from '#core/utils.js';
import { Context, Position, ClosedTrade } from '#types/index.js';
import { mlService } from '#ml/ml-service.js';

export function incrementExitReasonMetric(ctx: Context, reason: string): void {
  ctx.store.incrementExitReason(reason);
}

export function buildExitAccounting(
  pos: Position,
  sellRaw: bigint,
  balRaw: bigint,
  proceedsUsd: number,
  proceedsSol: number,
  solPriceHint?: number
): {
  realizedPnlUsd: number;
  realizedPnlSol: number;
  remainingCostUsd: number;
  remainingCostSol: number;
} {
  const isFullExit = balRaw <= 0n || sellRaw >= balRaw;
  const ratio = isFullExit ? 1.0 : bigintRatioToNumber(sellRaw, balRaw);

  const initialRemainingCostUsd = Math.max(
    0,
    Number(pos.remainingCostUsd ?? pos.entryUsdValue ?? 0)
  );
  // SOL leg fallback: if remainingCostSol was never set (0) but we have entryPriceSol, derive from USD cost via entry SOL price.
  let initialRemainingCostSol = Number(pos.remainingCostSol ?? 0);
  if (
    !(initialRemainingCostSol > 0) &&
    pos.entryPriceSol != null &&
    pos.entryPriceSol > 0 &&
    pos.entryPriceUsd > 0
  ) {
    const solPriceAtEntry = pos.entryPriceUsd / pos.entryPriceSol;
    if (solPriceAtEntry > 0) initialRemainingCostSol = initialRemainingCostUsd / solPriceAtEntry;
  }
  if (!(initialRemainingCostSol > 0) && pos.initialBuyAmountLamports != null) {
    try {
      const lamports = BigInt(pos.initialBuyAmountLamports);
      // atomicToDecimalString equivalent inline to avoid import cycle
      initialRemainingCostSol = Number(lamports) / 1e9;
    } catch {}
  }
  if (!(initialRemainingCostSol > 0) && pos.initialBuyAmountSol != null) {
    const solAmt = Number(pos.initialBuyAmountSol);
    if (solAmt > 0 && Number.isFinite(solAmt)) initialRemainingCostSol = solAmt;
  }
  // Last-resort: derive SOL cost from USD cost via live SOL price hint (prevents proceeds-as-PnL absurd).
  if (
    !(initialRemainingCostSol > 0) &&
    initialRemainingCostUsd > 0 &&
    solPriceHint != null &&
    solPriceHint > 0
  ) {
    initialRemainingCostSol = initialRemainingCostUsd / solPriceHint;
  }
  initialRemainingCostSol = Math.max(0, initialRemainingCostSol);

  const costSoldUsd = isFullExit ? initialRemainingCostUsd : initialRemainingCostUsd * ratio;
  let costSoldSol = isFullExit ? initialRemainingCostSol : initialRemainingCostSol * ratio;

  // Guard: if SOL cost is still zero but we have proceeds, this is a legacy missing-cost position.
  // Fall back to USD-derived cost so realizedPnlSol is not absurdly equal to proceeds.
  if (!(costSoldSol > 0) && proceedsSol > 0 && costSoldUsd > 0) {
    const impliedSolPrice =
      proceedsUsd > 0 && proceedsSol > 0 ? proceedsUsd / proceedsSol : solPriceHint;
    if (impliedSolPrice != null && impliedSolPrice > 0) {
      costSoldSol = costSoldUsd / impliedSolPrice;
    } else if (solPriceHint != null && solPriceHint > 0) {
      costSoldSol = costSoldUsd / solPriceHint;
    }
  }

  const remainingCostUsd = isFullExit ? 0 : Math.max(0, initialRemainingCostUsd - costSoldUsd);
  const remainingCostSol = isFullExit ? 0 : Math.max(0, initialRemainingCostSol - costSoldSol);

  return {
    realizedPnlUsd: proceedsUsd - costSoldUsd,
    realizedPnlSol: proceedsSol - costSoldSol,
    remainingCostUsd,
    remainingCostSol,
  };
}

export function recordTradeResult(ctx: Context, isWin: boolean, realizedPnlUsd?: number): void {
  ctx.store.addTradeResult(isWin);

  // Arm the pause via either breaker. Both reuse drawdownPauseUntil (which the scanner honors) and
  // mark lossStreakPauseActive so resuming does NOT re-baseline the drawdown high-water mark (that
  // reset is only correct after a real drawdown trip).
  const armPause = (logLine: string): void => {
    ctx.state.drawdownPauseUntil =
      Date.now() + Math.max(0, ctx.config.lossStreakCooldownMinutes) * 60_000;
    ctx.state.lossStreakPauseActive = true;
    ctx.logger(logLine, 'warn', { console: true });
  };

  // Loss-streak breaker: pause after N consecutive losing positions. Resets on any win, so it only
  // catches uninterrupted streaks.
  if (isWin) {
    ctx.state.consecutiveLosses = 0;
  } else {
    ctx.state.consecutiveLosses += 1;
    if (
      ctx.config.lossStreakBreakerEnabled &&
      ctx.state.consecutiveLosses >= ctx.config.lossStreakThreshold
    ) {
      ctx.state.consecutiveLosses = 0; // reset so it re-arms after the pause
      armPause(
        `Loss-streak breaker: ${ctx.config.lossStreakThreshold} consecutive losses — pausing new buys for ${ctx.config.lossStreakCooldownMinutes}m.`
      );
    }
  }

  // Expectancy breaker: pause when the trailing window of realized PnL sums net-negative — catches
  // the interleaved bleed (L,L,W,L…) that the consecutive counter resets through. Only callers that
  // pass a realized PnL feed the window; legacy/no-PnL callers leave it untouched.
  if (ctx.config.expectancyBreakerEnabled && realizedPnlUsd !== undefined) {
    ctx.store.addRealizedPnl(realizedPnlUsd, ctx.config.lossStreakWindowSize);
    const window = ctx.state.recentPnlWindow;
    const windowFull = window.length >= Math.max(1, ctx.config.lossStreakWindowSize);
    const net = window.reduce((sum, p) => sum + p, 0);
    if (windowFull && net < 0) {
      ctx.state.recentPnlWindow = []; // clear so it re-arms after the pause
      armPause(
        `Expectancy breaker: trailing-${ctx.config.lossStreakWindowSize} net $${net.toFixed(2)} < 0 — pausing new buys for ${ctx.config.lossStreakCooldownMinutes}m.`
      );
    }
  }
}

export function recordClosedTrade(ctx: Context, pos: Position, reason: string): void {
  const openedAtMs = new Date(pos.openedAt || Date.now()).getTime();
  // Normalize SOL accounting fallback for legacy positions missing entryPriceSol/initialBuyAmountSol
  let entryPriceSolNorm = Number(pos.entryPriceSol || 0);
  if (!(entryPriceSolNorm > 0) && pos.entryPriceUsd > 0 && pos.initialBuyAmountLamports) {
    try {
      const solAmt = Number(BigInt(pos.initialBuyAmountLamports)) / 1e9;
      const usdVal = Number(pos.entryUsdValue || 0);
      if (solAmt > 0 && usdVal > 0) {
        const impliedSolPrice = usdVal / solAmt;
        if (impliedSolPrice > 0) entryPriceSolNorm = pos.entryPriceUsd / impliedSolPrice;
      }
    } catch {}
  }
  // Fix absurd SOL PnL for legacy positions missing cost basis: derive Sol PnL from USD when needed
  let realizedPnlSolNorm = Number(pos.realizedPnlSol || 0);
  const realizedPnlUsdNorm = Number(pos.realizedPnlUsd || 0);
  if (
    realizedPnlSolNorm === 0 &&
    realizedPnlUsdNorm !== 0 &&
    Number(pos.realizedProceedsSol || 0) > 0
  ) {
    // If buildExitAccounting had zero cost, realizedPnlSol would have been == proceedsSol.
    // Detect that absurd case (proceeds == pnl) even after guard, and correct via USD/solPrice
    const proceedsSol = Number(pos.realizedProceedsSol || 0);
    if (
      Math.abs(realizedPnlSolNorm - proceedsSol) < 1e-9 &&
      proceedsSol > 0 &&
      realizedPnlUsdNorm < 0
    ) {
      // No valid SOL cost — leave as 0? caller will recompute via USD; prevent proceeds-as-PnL
      realizedPnlSolNorm = 0;
    }
  }
  // If still zero-cost legacy: try to backfill entryPriceSol from initialBuyAmountLamports / Sol
  if (!(entryPriceSolNorm > 0) && pos.entryPriceUsd > 0 && pos.initialBuyAmountSol != null) {
    const solAmt = Number(pos.initialBuyAmountSol);
    const usdVal = Number(pos.entryUsdValue || 0);
    if (solAmt > 0 && usdVal > 0) {
      const impliedSolPrice = usdVal / solAmt;
      if (impliedSolPrice > 0) entryPriceSolNorm = pos.entryPriceUsd / impliedSolPrice;
    }
  }

  const trade: ClosedTrade = {
    mint: pos.mint,
    symbol: pos.symbol,
    exitReason: reason,
    realizedPnlUsd: realizedPnlUsdNorm,
    realizedPnlSol: realizedPnlSolNorm,
    realizedProceedsUsd: Number(pos.realizedProceedsUsd || 0),
    realizedProceedsSol: Number(pos.realizedProceedsSol || 0),
    entryUsdValue: Number(pos.entryUsdValue || 0),
    entryPriceUsd: Number(pos.entryPriceUsd || 0),
    entryPriceSol: entryPriceSolNorm,
    highestPriceUsd: Number(pos.highestPriceUsd || pos.entryPriceUsd || 0),
    holdSeconds: Math.max(0, (Date.now() - openedAtMs) / 1000),
    closedAt: new Date().toISOString(),
    entryScore: Number(pos.entryScore || 0),
    tpProfile: pos.tpProfile || null,
    takeProfitMultiples: pos.takeProfitMultiples || null,
    takeProfitFractions: pos.takeProfitFractions || null,
    trailingStopDrawdownPctResolved: Number(pos.trailingStopDrawdownPctResolved || 0),
    maxHoldMinutesResolved: Number(pos.maxHoldMinutesResolved || 0),
    volatilityScaler: Number(pos.volatilityScaler || 0),
    entryLiquidityUsd: Number(pos.entryLiquidityUsd || 0),
    launchpad: pos.launchpad || null,
    targetsHit: Number(pos.targetsHit || 0),
    orphan: pos.orphan ? true : undefined,
    initialBuyAmountSol: pos.initialBuyAmountSol != null ? String(pos.initialBuyAmountSol) : null,
    holdTimeSeriesJson: pos.timeSeries ? JSON.stringify(pos.timeSeries) : undefined,
    entryMarketCapUsd: pos.entryMarketCapUsd,
    exitPriceUsd: pos.exitPriceUsd,
    isGhost: false,
    mode: pos.mode || (ctx.config.paperTrading ? 'paper' : 'live'),
  } as ClosedTrade & { mode?: string };
  ctx.store.addClosedTrade(trade);
  journalClosedTrade(ctx, trade as unknown as Record<string, unknown>);

  // ponytail: single finalize — add typed orphan metric here, callers no longer suffix reason
  if ((pos as { orphan?: boolean }).orphan) ctx.store.incrementMetric('orphanExits');

  // Symbol-level cooldown: block re-entry into the same name (across copycat mints) for the
  // standard cooldown window. Stops the JAMES-style triple re-entry into instant reversals.
  ctx.store.noteSymbolExit(
    pos.symbol,
    Date.now() + Math.max(0, ctx.config.coolDownMinutes) * 60_000
  );

  if (process.env.ML_ENABLED === 'true' && pos.mlFeaturesJson) {
    // Realistic label: any close that is net profitable and either is a TP/trailing win,
    // or had locked profit (targetsHit>0) — e.g. breakeven-stop or liquidity-exit on runner.
    // Hard fails (rug/stale/max-hold without profit lock) stay 0.
    const hardFail =
      trade.exitReason === 'rug-exit' ||
      trade.exitReason === 'stale' ||
      (trade.exitReason === 'max-hold' && (trade.targetsHit ?? 0) === 0);
    const isProfitableExit =
      trade.realizedPnlUsd > 0 &&
      (trade.exitReason.startsWith('take-profit') ||
        trade.exitReason.startsWith('trailing') ||
        trade.exitReason === 'breakeven-stop' ||
        trade.exitReason === 'tp-trailing-max-exit' ||
        trade.exitReason === 'adaptive-tp-exit' ||
        trade.exitReason === 'time-exit' ||
        ((trade.targetsHit ?? 0) > 0 && !hardFail));
    ctx.store.addTrainingSample({
      mint: pos.mint,
      symbol: pos.symbol,
      label: isProfitableExit && !hardFail ? 1 : 0,
      featuresJson: pos.mlFeaturesJson,
      realizedPnlUsd: trade.realizedPnlUsd,
      entryScore: pos.entryScore,
      tpProfile: pos.tpProfile ?? null,
      launchpad: pos.launchpad ?? null,
      closedAt: trade.closedAt,
      exitReason: trade.exitReason,
      holdSeconds: trade.holdSeconds,
      highestPriceUsd: trade.highestPriceUsd,
      targetsHit: trade.targetsHit,
      entryPriceUsd: trade.entryPriceUsd,
      holdTimeSeriesJson: trade.holdTimeSeriesJson,
    });

    if (trade.targetsHit > 0) {
      mlService.runParamOptimizerNow().catch((err: unknown) => {
        ctx.logger(
          `[ML] TP param optimizer error: ${err instanceof Error ? err.message : String(err)}`,
          'debug'
        );
      });
    }

    mlService.runEntryTunerNow().catch((err: unknown) => {
      ctx.logger(
        `[ML] Entry tuner error: ${err instanceof Error ? err.message : String(err)}`,
        'debug'
      );
    });
  }
}
