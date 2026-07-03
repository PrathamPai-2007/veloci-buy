import { Context, SwingEvaluationResult, SwingWatchlistItem } from '#types/index.js';
import { computeSwingSignals } from './swing-signals.js';

/**
 * Evaluates a watchlist item against all configured swing signals and returns
 * a SwingEvaluationResult. Returns approved=false if the observation window
 * has not been reached or if required signals are not present.
 */
export async function evaluateSwingCandidate(
  ctx: Context,
  item: SwingWatchlistItem
): Promise<SwingEvaluationResult> {
  const reject = (blockers: string[]): SwingEvaluationResult => ({
    approved: false,
    score: 0,
    blockers,
    signals: {
      doubleDipDetected: false,
      dip1LowPrice: 0,
      dip1LowIdx: 0,
      bounceHighPrice: 0,
      bounceHighIdx: 0,
      dip2LowPrice: 0,
      dip2LowIdx: 0,
      recoveryPct: 0,
      higherLow: false,
      volumeAccumDetected: false,
      buySellRatioTrend: 0,
      buyCountDip1: 0,
      buyCountDip2: 0,
      sellCountDip1: 0,
      sellCountDip2: 0,
      totalScore: 0,
      approved: false,
      blockers,
    },
    item,
  });

  const ageMinutes = (Date.now() - item.addedAt) / 60_000;

  if (ageMinutes < ctx.config.swingMinObservationMinutes) {
    return reject(['insufficient-observation-time']);
  }
  if (ageMinutes > 120) {
    return reject(['watchlist-expired']);
  }
  if (item.priceHistory.length < 30) {
    return reject(['insufficient-price-history']);
  }

  const signals = computeSwingSignals(
    item,
    ctx.config.swingDoubleDipEnabled,
    ctx.config.swingVolumeAccumEnabled
  );

  let approved = signals.blockers.length === 0 && signals.totalScore >= ctx.config.swingMinScore;
  let blockers = [...signals.blockers];

  if (!approved && ctx.config.swingAllowDoubleDipOnly) {
    const isOnlyNoVolume =
      signals.blockers.length === 1 && signals.blockers[0] === 'no-volume-accumulation';
    const isSwapTapeEmpty = !item.swapTape || item.swapTape.length === 0;
    const isTapeHistoryEmpty = !item.tapeHistory || item.tapeHistory.length < 4;

    if (isOnlyNoVolume && isSwapTapeEmpty && isTapeHistoryEmpty) {
      if (signals.totalScore >= ctx.config.swingMinScoreNoVolume) {
        approved = true;
        blockers = [];
        signals.approved = true;
        signals.blockers = [];
      }
    }
  }

  return {
    approved,
    score: signals.totalScore,
    blockers,
    signals,
    item,
  };
}
