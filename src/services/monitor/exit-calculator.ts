import { clamp } from '#core/utils.js';
import { TAKE_PROFIT_FRACTION, TAKE_PROFIT_MULTIPLES, MOOD_THRESHOLDS } from '#core/config.js';
import { Context, Position } from '#types/index.js';

export interface TakeProfitPlan {
  profileId: string;
  isHighGrowthConfidence: boolean;
  takeProfitMultiples: number[];
  takeProfitFractions: number[];
  trailingStopDrawdownPct: number;
  maxHoldMinutesResolved: number;
}

export function getTakeProfitPlanByProfile(
  ctx: Context,
  profile: 'high' | 'standard'
): TakeProfitPlan {
  const isHigh = profile === 'high';
  const multiples = isHigh
    ? ctx.config.takeProfitMultiplesHigh?.length
      ? ctx.config.takeProfitMultiplesHigh
      : ctx.config.takeProfitMultiples
    : ctx.config.takeProfitMultiples;
  const fractions = ctx.config.takeProfitFractions?.length
    ? ctx.config.takeProfitFractions
    : [ctx.config.takeProfitFraction, ctx.config.takeProfitFraction];
  const maxHoldMinutes = isHigh
    ? Number(ctx.config.holdDurationHighConfidenceMinutes || 30)
    : Number(ctx.config.maxHoldMinutes || 20);
  const baseTrailing =
    typeof ctx.config.trailingStopDrawdownPct === 'number'
      ? ctx.config.trailingStopDrawdownPct
      : 0.16;
  const trailing = isHigh ? baseTrailing + 0.04 : baseTrailing;

  return {
    profileId: isHigh ? 'high-confidence' : 'low-confidence',
    isHighGrowthConfidence: isHigh,
    takeProfitMultiples: [...multiples],
    takeProfitFractions: fractions.map((v) => clamp(v, 0, 1)),
    trailingStopDrawdownPct: clamp(trailing, 0.01, 0.95),
    maxHoldMinutesResolved: Math.max(1, Math.floor(maxHoldMinutes)),
  };
}

export function getTakeProfitPlan(ctx: Context, score: number): TakeProfitPlan {
  const numericScore = Number(score || 0);
  const highThreshold = Number(ctx.config.highGrowthConfidenceScore || 80);
  const profile: 'high' | 'standard' = numericScore >= highThreshold ? 'high' : 'standard';

  return getTakeProfitPlanByProfile(ctx, profile);
}

export function getTakeProfitFraction(pos: Position, targetIndex: number): number {
  return Array.isArray(pos.takeProfitFractions) &&
    Number.isFinite(pos.takeProfitFractions[targetIndex])
    ? clamp(pos.takeProfitFractions[targetIndex]!, 0, 1)
    : TAKE_PROFIT_FRACTION;
}

export function computeTakeProfitSellAmount(balRaw: bigint, frac: number): bigint {
  if (frac < 0) return 0n;
  return (balRaw * BigInt(Math.max(1, Math.round(frac * 10000)))) / 10000n;
}

export interface MoodAdjustments {
  sizeMultiplier: number;
  isPaused: boolean;
}

export function getMoodAdjustments(ctx: Context): MoodAdjustments {
  let sizeMultiplier = 1.0;
  let isPaused = false;

  if (ctx.state.moodPauseUntil && Date.now() < ctx.state.moodPauseUntil) {
    isPaused = true;
  } else {
    const history = ctx.state.tradeHistory || [];
    const last10 = history.slice(-MOOD_THRESHOLDS.windowLarge);
    const last5 = history.slice(-MOOD_THRESHOLDS.windowSmall);

    const winRate10 =
      last10.length >= MOOD_THRESHOLDS.windowLarge
        ? last10.filter((w) => w).length / MOOD_THRESHOLDS.windowLarge
        : 1;

    const winRate5 =
      last5.length >= MOOD_THRESHOLDS.windowSmall
        ? last5.filter((w) => w).length / MOOD_THRESHOLDS.windowSmall
        : 1;

    if (winRate10 < MOOD_THRESHOLDS.winRateCritical) {
      // Guard against a permanent-pause lockup: if a pause just expired and no new trade
      // outcomes have been recorded since it started, the win rate is unchanged and re-pausing
      // would lock the bot out forever. Resume with reduced size instead until a new trade lands.
      const noNewTradesSincePause =
        ctx.state.moodPauseTradeCount != null && history.length <= ctx.state.moodPauseTradeCount;

      if (noNewTradesSincePause) {
        sizeMultiplier = MOOD_THRESHOLDS.sizeMultiplierCautious;
        ctx.logger(
          `Daily Mood: CRITICAL (${(winRate10 * 100).toFixed(0)}% WR) but pause just expired with no new trades. Resuming at reduced size to avoid lockup.`,
          'warn',
          { console: true }
        );
      } else {
        isPaused = true;
        ctx.store.pauseMood(ctx.config.moodPauseDurationMinutes * 60000, history.length);
        ctx.logger(
          `Daily Mood: CRITICAL (${(winRate10 * 100).toFixed(0)}% WR). Pausing for ${ctx.config.moodPauseDurationMinutes}m.`,
          'warn',
          { console: true }
        );
      }
    } else if (winRate5 < MOOD_THRESHOLDS.winRateCautious) {
      sizeMultiplier = MOOD_THRESHOLDS.sizeMultiplierCautious;
      ctx.logger(
        `Daily Mood: CAUTIOUS (${(winRate5 * 100).toFixed(0)}% WR). Reducing size 50%.`,
        'warn',
        { console: true }
      );
    }

    // Win rate is no longer critical — release the anti-lockup latch so a future genuine
    // downturn can pause again from a clean slate.
    if (winRate10 >= MOOD_THRESHOLDS.winRateCritical && ctx.state.moodPauseTradeCount != null) {
      ctx.state.moodPauseTradeCount = null;
    }
  }

  return { sizeMultiplier, isPaused };
}

export function getTrailingActivationMultiple(pos: Position): number {
  const multiples =
    Array.isArray(pos.takeProfitMultiples) && pos.takeProfitMultiples.length > 0
      ? pos.takeProfitMultiples
      : TAKE_PROFIT_MULTIPLES;
  const firstTarget = Number(multiples[0] || 1.5);
  const midpoint = 1 + 0.5 * (firstTarget - 1);
  return Math.min(midpoint, 1.12);
}
