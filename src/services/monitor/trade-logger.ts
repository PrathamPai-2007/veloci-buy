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
  proceedsSol: number
): {
  realizedPnlUsd: number;
  realizedPnlSol: number;
  remainingCostUsd: number;
  remainingCostSol: number;
} {
  const ratio = bigintRatioToNumber(sellRaw, balRaw);
  const costSoldUsd = Number(pos.remainingCostUsd || 0) * ratio;
  const costSoldSol = Number(pos.remainingCostSol || 0) * ratio;
  return {
    realizedPnlUsd: proceedsUsd - costSoldUsd,
    realizedPnlSol: proceedsSol - costSoldSol,
    remainingCostUsd: Math.max(0, Number(pos.remainingCostUsd || 0) - costSoldUsd),
    remainingCostSol: Math.max(0, Number(pos.remainingCostSol || 0) - costSoldSol),
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
  const trade: ClosedTrade = {
    mint: pos.mint,
    symbol: pos.symbol,
    exitReason: reason,
    realizedPnlUsd: Number(pos.realizedPnlUsd || 0),
    realizedPnlSol: Number(pos.realizedPnlSol || 0),
    realizedProceedsUsd: Number(pos.realizedProceedsUsd || 0),
    realizedProceedsSol: Number(pos.realizedProceedsSol || 0),
    entryUsdValue: Number(pos.entryUsdValue || 0),
    entryPriceUsd: Number(pos.entryPriceUsd || 0),
    entryPriceSol: Number(pos.entryPriceSol || 0),
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
    initialBuyAmountSol: pos.initialBuyAmountSol || null,
    holdTimeSeriesJson: pos.timeSeries ? JSON.stringify(pos.timeSeries) : undefined,
    entryMarketCapUsd: pos.entryMarketCapUsd,
    exitPriceUsd: pos.exitPriceUsd,
  };
  ctx.store.addClosedTrade(trade);
  journalClosedTrade(ctx, trade as unknown as Record<string, unknown>);

  // Symbol-level cooldown: block re-entry into the same name (across copycat mints) for the
  // standard cooldown window. Stops the JAMES-style triple re-entry into instant reversals.
  ctx.store.noteSymbolExit(
    pos.symbol,
    Date.now() + Math.max(0, ctx.config.coolDownMinutes) * 60_000
  );

  if (process.env.ML_ENABLED === 'true' && pos.mlFeaturesJson) {
    // Mirror ghost-trade label calibration: a win requires a TP-style exit with positive PnL,
    // not just any profitable close (e.g. a max-hold exit is not a signal worth rewarding).
    const exitedViaPositiveClose =
      trade.exitReason.startsWith('take-profit') || trade.exitReason.startsWith('trailing');
    ctx.store.addTrainingSample({
      mint: pos.mint,
      symbol: pos.symbol,
      label: exitedViaPositiveClose && trade.realizedPnlUsd > 0 ? 1 : 0,
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
