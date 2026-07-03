/**
 * Pure scoring helpers for token candidate evaluation.
 * No ML, no burst overlay, no side-effects — safe to import anywhere.
 */
import { clamp } from '#core/utils.js';
import {
  DEFAULT_LAUNCHPAD_PROFILES,
  SCORING_WEIGHTS,
  MOMENTUM_FILTERS,
  MOMENTUM_SCORING,
} from '#core/config.js';
import { Context, TokenMetadata, LaunchpadProfile, AdjustedThresholds } from '#types/index.js';

export interface PricePoint {
  price: number;
  timestamp: number;
}

/** Negative ages within this band are treated as benign clock jitter and clamped silently. */
export const CLOCK_SKEW_TOLERANCE_SECONDS = 30;
const CLOCK_SKEW_WARN_INTERVAL_MS = 60_000;
let lastClockSkewWarnAt = 0;

/** Logs a throttled warning when candidate ages are implausibly negative (system clock skew). */
export function maybeWarnClockSkew(ctx: Context, ageSeconds: number): void {
  const now = Date.now();
  if (now - lastClockSkewWarnAt < CLOCK_SKEW_WARN_INTERVAL_MS) return;
  lastClockSkewWarnAt = now;
  ctx.logger(
    `Clock skew suspected: candidate age ${ageSeconds}s is implausibly negative. ` +
      `Your system clock is likely behind real time — resync NTP (w32tm /resync). ` +
      `Ages are being clamped to 0 so trading is not silently blocked.`,
    'warn'
  );
}

/** Epoch ms when this process started; the starvation clock's baseline before any buy. */
export const SESSION_START = Date.now();

/**
 * Normalizes a potential numeric value, falling back to a default if invalid.
 */
export function finiteNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

/**
 * Normalizes a raw price point object into a validated PricePoint.
 */
export function normalizePricePoint(point: Record<string, unknown>): PricePoint | null {
  const price = finiteNumber(point?.price, NaN);
  const timestamp = finiteNumber(point?.timestamp, NaN);
  if (!(price > 0) || !Number.isFinite(timestamp)) return null;
  return { price, timestamp };
}

/**
 * Filters and normalizes a price history array.
 */
export function getValidPriceHistory(priceHistory: unknown[]): PricePoint[] {
  if (!Array.isArray(priceHistory)) return [];
  return priceHistory
    .map((p) => normalizePricePoint(p as Record<string, unknown>))
    .filter((p): p is PricePoint => p !== null);
}

/**
 * Retrieves the profile for a given launchpad.
 */
export function getLaunchpadProfile(launchpad: unknown): LaunchpadProfile & { name: string } {
  const normalized =
    typeof launchpad === 'string' && launchpad.trim() ? launchpad.trim().toLowerCase() : 'unknown';
  const defaultProfiles: Record<string, LaunchpadProfile> = DEFAULT_LAUNCHPAD_PROFILES;
  const profile = defaultProfiles[normalized];
  if (!profile) {
    return {
      name: 'unknown',
      scoreBonus: 0,
      liquidityMultiplier: 1,
      holderMultiplier: 1,
      buysMultiplier: 1,
      minPoolAgeSeconds: 0,
    };
  }
  return { name: normalized, ...profile };
}

/**
 * Calculates adjusted audit thresholds based on the launchpad profile.
 */
export function getLaunchpadAdjustedThresholds(
  ctx: Context,
  profile: LaunchpadProfile & { name: string }
): AdjustedThresholds {
  const defaults = {
    minLiquidityUsd: ctx.config.minLiquidityUsd,
    minHolderCount: ctx.config.minHolderCount,
    minBuys5m: ctx.config.minBuys5m,
    minPoolAgeSeconds: ctx.config.minPoolAgeSeconds,
  };
  if (!profile || profile.name === 'unknown') return defaults;
  return {
    minLiquidityUsd: defaults.minLiquidityUsd * (profile.liquidityMultiplier || 1),
    minHolderCount: defaults.minHolderCount * (profile.holderMultiplier || 1),
    minBuys5m: defaults.minBuys5m * (profile.buysMultiplier || 1),
    minPoolAgeSeconds:
      profile.minPoolAgeSeconds !== undefined
        ? profile.minPoolAgeSeconds
        : defaults.minPoolAgeSeconds,
  };
}

/**
 * Computes a heuristic score for a token candidate (0–100).
 */
export function computeCandidateScore(
  token: TokenMetadata,
  profile: LaunchpadProfile,
  thresholds: AdjustedThresholds,
  socialLinks: number
): number {
  let score = 50;

  // Launchpad trust bonus — pump.fun/moonshot/raydium tokens get a flat bonus for being on
  // a known launchpad with verified launch mechanics (previously defined but never applied).
  score += profile?.scoreBonus ?? 0;

  if (socialLinks >= 3) score += SCORING_WEIGHTS.socialLinkHigh;
  else if (socialLinks >= 1) score += SCORING_WEIGHTS.socialLinkLow;
  if (token.isVerified) score += SCORING_WEIGHTS.isVerified;
  const organicScore = Number(token.organicScore);
  if (Number.isFinite(organicScore)) {
    score += clamp(
      organicScore,
      -SCORING_WEIGHTS.organicScoreClamp,
      SCORING_WEIGHTS.organicScoreClamp
    );
  }
  const liquidityRatio = finiteNumber(token.liquidity) / thresholds.minLiquidityUsd;
  if (liquidityRatio > 5) score += SCORING_WEIGHTS.liquidityRatioHigh;
  else if (liquidityRatio > 2) score += SCORING_WEIGHTS.liquidityRatioLow;

  if (Number(token.holderCount) >= 10) score += SCORING_WEIGHTS.holderCountHigh;

  // Graded buy pressure: linear scale from 1x (0 pts) to 2x+ (full bonus).
  // Replaces the binary cliff (0 or +5 at exactly 2x) so 1.5x buyPressure earns half the bonus.
  const sellPressure = finiteNumber(token.sellPressure, 1);
  const buyPressure = finiteNumber(token.buyPressure);
  if (buyPressure > 0 && sellPressure > 0) {
    const bpRatio = buyPressure / sellPressure;
    score += Math.min(1, Math.max(0, bpRatio - 1)) * SCORING_WEIGHTS.buyPressureBonus;
  }

  // Volume/FDV ratio: measures organic trading activity relative to market cap.
  // High turnover (volume > 10% of FDV in 24h) signals genuine interest, not wash trading.
  const fdv = finiteNumber(token.fdv);
  const volume24h = finiteNumber(token.volume24h);
  if (fdv > 0 && volume24h > 0) {
    const volFdvRatio = volume24h / fdv;
    if (volFdvRatio > 0.1) score += SCORING_WEIGHTS.volFdvHigh;
    else if (volFdvRatio > 0.05) score += SCORING_WEIGHTS.volFdvMid;
    else if (volFdvRatio < 0.005) score += SCORING_WEIGHTS.volFdvLow;
  }

  if (token.audit?.isSus) score -= SCORING_WEIGHTS.suspiciousAuditPenalty;

  return clamp(score, 0, 100);
}

/**
 * Computes a signed momentum/flow delta (≈ −10..+12) to add to a candidate's structural score.
 *
 * Rationale: `computeCandidateScore` ranks tokens by cleanliness, not by whether they're being
 * bought. In paper sessions the highest-scoring token (95) went flat and the only mover scored
 * lowest — score was inversely related to outcome. This delta injects order-flow/price thrust.
 * It is validated mainly as a downside filter: a token visibly dumping in the survival window is
 * demoted; a flat-but-not-falling token stays roughly neutral (we can't predict a slow-build
 * winner that looks dead at entry, so we don't over-reward).
 *
 * Pure — reads only fields already on `token` (`stats5m`, `tapeHistory`, `tapeAtStart`) plus the
 * survival-window price history. No network round-trips, safe in the latency-critical snipe path.
 */
export function computeMomentumScore(
  token: TokenMetadata,
  priceHistory: PricePoint[],
  startDelayPrice: number,
  currentPrice: number
): number {
  // Cold start: too little trajectory to judge. Stay neutral rather than penalize new mints —
  // the entry-score gate (softened by starvation-relax) is what filters thin candidates.
  if (priceHistory.length < 6) return 0;

  let delta = 0;

  // 1) Graded 5m buy/sell imbalance, centered at 50/50. Sell-dominated tape goes negative.
  //    Uses stats5m counts (distinct from the binary buyPressure/sellPressure bonus — no overlap).
  const buys = finiteNumber(token.stats5m?.numBuys);
  const sells = finiteNumber(token.stats5m?.numSells);
  if (buys + sells > 0) {
    const buyRatio = buys / (buys + sells);
    delta += clamp((buyRatio - 0.5) / 0.5, -1, 1) * MOMENTUM_SCORING.imbalanceMax;
  }

  // 2) Buy-flow acceleration: are buys arriving faster in the second half of the window?
  //    Mirrors the tape-decay math in applyMomentumFilters (cumulative buy counts).
  const tape = token.tapeHistory;
  if (Array.isArray(tape) && tape.length >= 2) {
    const start = token.tapeAtStart ?? tape[0]!;
    const mid = tape[Math.floor(tape.length / 2)]!;
    const firstHalf = finiteNumber(mid.buys) - finiteNumber(start.buys);
    const secondHalf = finiteNumber(token.stats5m?.numBuys) - finiteNumber(mid.buys);
    if (firstHalf > 0) {
      delta += clamp((secondHalf - firstHalf) / firstHalf, -1, 1) * MOMENTUM_SCORING.accelMax;
    }
  }

  // 3) Trajectory: sustained climb off the survival baseline, weighted by how consistently green
  //    the path was so a single vertical spike doesn't score like a steady climb. A falling price
  //    takes the full negative regardless of consistency (a downtrend is a downtrend).
  if (startDelayPrice > 0 && currentPrice > 0) {
    const growth = currentPrice / startDelayPrice - 1;
    const growthScore = clamp(growth / MOMENTUM_SCORING.growthBandPct, -1, 1);
    const snaps = priceHistory.concat({ price: currentPrice, timestamp: Date.now() });
    let green = 0;
    for (let i = 1; i < snaps.length; i++) {
      if (snaps[i]!.price > snaps[i - 1]!.price) green++;
    }
    const consistency = green / (snaps.length - 1);
    const traj = growthScore >= 0 ? growthScore * consistency : growthScore;
    delta += traj * MOMENTUM_SCORING.trajectoryMax;
  }

  return clamp(delta, MOMENTUM_SCORING.min, MOMENTUM_SCORING.max);
}

/**
 * Determines if a token matches the memecoin heuristic.
 */
export function looksLikeMemecoin(ctx: Context, token: TokenMetadata): boolean {
  if (token.launchpad) return true;

  const text = `${token.name || ''} ${token.symbol || ''}`.toLowerCase();
  const hasKeyword = ctx.config.memeKeywords.some((keyword) => text.includes(keyword));
  const isWithinFdv = Number(token.fdv || 0) <= ctx.config.maxMemeFdvUsd;

  if (hasKeyword && isWithinFdv) return true;
  if (token.isVerified && isWithinFdv) return true;
  if (Number(token.organicScore || 0) > 0 && isWithinFdv) return true;

  return false;
}

/**
 * Counts the number of social links (website, twitter, telegram) present for a token.
 */
export function countSocialLinks(token: TokenMetadata): number {
  const fields: (keyof TokenMetadata)[] = ['website', 'twitter', 'telegram'];
  return fields.reduce((count, key) => count + (token[key] ? 1 : 0), 0);
}

/**
 * Determines whether a token snapshot comes from a reduced-fidelity historical backfill.
 */
export function isReducedHistoricalSnapshot(token: TokenMetadata): boolean {
  return (
    token?.snapshotQuality === 'reduced-historical' ||
    token?.historicalSource === 'geckoterminal' ||
    token?.historicalSource === 'dexscreener'
  );
}

/**
 * Checks if a value is borderline below a required threshold (within the buffer ratio).
 */
export function isSlightlyBelowThreshold(
  ctx: Context,
  actual: number | string,
  required: number
): boolean {
  const numericActual = Number(actual);
  if (!(required > 0) || !Number.isFinite(numericActual)) return false;
  return numericActual >= required * (1 - ctx.config.borderlineThresholdBufferRatio);
}

/**
 * Computes the effective minimum entry score, applying GMI regime and trade-starvation adaptation.
 *
 * Legacy (live mode / adaptive disabled): quiet market (GMI < 0.3) tightens gate by +5,
 * hot market (GMI > 0.7) loosens by -5.
 *
 * Adaptive (paper mode, or live with opt-in): gate is NEVER tightened. Dead market relaxes
 * toward `minCandidateScoreFloor`; prolonged starvation relaxes further so the bot keeps
 * sampling instead of freezing at zero trades.
 */
export function computeEffectiveMinScore(
  ctx: Context,
  baseMinScore: number,
  now: number = Date.now()
): { effective: number; note: string | null } {
  const gmi = typeof ctx.calculateGMI === 'function' ? ctx.calculateGMI() : 0.5;
  const adaptiveActive =
    ctx.config.adaptiveFloorEnabled &&
    (ctx.config.paperTrading || ctx.config.adaptiveFloorLiveEnabled);

  if (!adaptiveActive) {
    if (gmi < 0.3) {
      const effective = baseMinScore + 5;
      return {
        effective,
        note: `GMI low (${(gmi * 100).toFixed(1)}%): MinScore +5 (${effective})`,
      };
    }
    if (gmi > 0.7) {
      const effective = baseMinScore - 5;
      return {
        effective,
        note: `GMI high (${(gmi * 100).toFixed(1)}%): MinScore -5 (${effective})`,
      };
    }
    return { effective: baseMinScore, note: null };
  }

  const floor = Math.min(baseMinScore, ctx.config.minCandidateScoreFloor);
  let adjusted = baseMinScore;
  const reasons: string[] = [];

  // Regime loosening: a dead market relaxes the gate up to halfway toward the floor.
  if (gmi < 0.3) {
    const deadness = (0.3 - gmi) / 0.3; // 0 at GMI 0.3 → 1 at GMI 0
    adjusted -= (baseMinScore - floor) * 0.5 * deadness;
    reasons.push(`GMI low (${(gmi * 100).toFixed(1)}%): loosen`);
  }

  // Starvation relaxation: relax further the longer it's been since the last buy.
  const ref = ctx.state.lastBuyAt ?? SESSION_START;
  const starvationMs = Math.max(1, ctx.config.tradeStarvationMinutes) * 60_000;
  const elapsed = now - ref;
  if (elapsed > starvationMs) {
    const intervals = Math.floor((elapsed - starvationMs) / starvationMs) + 1;
    adjusted -= intervals * ctx.config.starvationRelaxStep;
    reasons.push(
      `starved ${Math.floor(elapsed / 60_000)}m: -${intervals * ctx.config.starvationRelaxStep}`
    );
  }

  const effective = clamp(adjusted, floor, baseMinScore);
  const note =
    reasons.length > 0
      ? `Adaptive MinScore ${effective.toFixed(1)} (base ${baseMinScore}, floor ${floor}; ${reasons.join(', ')})`
      : null;
  return { effective, note };
}

/**
 * Applies advanced momentum filters to a token candidate.
 * Mutates the `addBlocker` accumulator — internal to the evaluation pipeline.
 */
export function applyMomentumFilters(
  ctx: Context,
  priceHistory: PricePoint[],
  currentPrice: number,
  now: number,
  startDelayPrice: number,
  token: TokenMetadata,
  tapeHistory: unknown[],
  addBlocker: (message: string, code: string, recheckEligible?: boolean) => void
): void {
  if (priceHistory.length < 6) return;

  const startTime = priceHistory[0]!.timestamp;
  const totalDuration = now - startTime;

  if (totalDuration < ctx.config.survivalDelaySeconds * 0.4 * 1000) return;

  const segDuration = totalDuration / 3;
  const s1Time = startTime + segDuration;
  const s2Time = startTime + 2 * segDuration;
  const pStart = startDelayPrice;

  const pS1 = priceHistory.find((h) => h.timestamp >= s1Time)?.price || pStart;
  const pS2 = priceHistory.find((h) => h.timestamp >= s2Time)?.price || pS1;

  const growthS1 = (pS1 - pStart) / pStart;
  const growthS3 = (currentPrice - pS2) / pS2;

  // Stall Filter
  if (growthS1 > 0.05) {
    const stabilityFactor = growthS3 / growthS1;
    const minAccel = ctx.config.minAccelerationFactor ?? MOMENTUM_FILTERS.minAccelerationFactor;
    if (stabilityFactor < minAccel) {
      addBlocker(
        `Momentum stalling (Stall Filter): segment 3 growth (${(growthS3 * 100).toFixed(1)}%) is too low vs segment 1 (${(growthS1 * 100).toFixed(1)}%). factor=${stabilityFactor.toFixed(2)}`,
        'momentum-stalling'
      );
    }
  }

  // Tape Filter (Buy velocity decay)
  if (Array.isArray(tapeHistory) && tapeHistory.length >= 2) {
    const midPointTime = startTime + totalDuration / 2;
    const tapeAtStartSnapshot = tapeHistory[0] as { buys: number; timestamp: number };
    const tapeAtMidSnapshot =
      (tapeHistory as { buys: number; timestamp: number }[]).find(
        (t) => t.timestamp >= midPointTime
      ) ||
      (tapeHistory[Math.floor(tapeHistory.length / 2)] as {
        buys: number;
        timestamp: number;
      });

    const buysFirstHalf = tapeAtMidSnapshot.buys - tapeAtStartSnapshot.buys;
    const buysSecondHalf = Number(token.stats5m?.numBuys || 0) - tapeAtMidSnapshot.buys;

    if (
      buysFirstHalf > MOMENTUM_FILTERS.minBuysFirstHalf &&
      buysSecondHalf < buysFirstHalf * MOMENTUM_FILTERS.buyVelocityDecayFactor
    ) {
      addBlocker(
        `Buy velocity decay (Tape Filter): second-half buys (${buysSecondHalf}) dropped significantly vs first-half (${buysFirstHalf}).`,
        'buy-velocity-decay'
      );
    }
  }

  // Flatline Filter (Price exhaustion)
  const midPointTime = startTime + totalDuration / 2;
  const pMid = priceHistory.find((h) => h.timestamp >= midPointTime)?.price || currentPrice;
  const growthFirstHalf = (pMid - pStart) / pStart;

  if (growthFirstHalf > 0.2) {
    const recentSnapshots = priceHistory.slice(-8);
    if (recentSnapshots.length >= 5) {
      const prices = recentSnapshots.map((s) => s.price).concat(currentPrice);
      const minP = Math.min(...prices);
      const maxP = Math.max(...prices);
      const rangePct = minP > 0 ? ((maxP - minP) / minP) * 100 : Infinity;
      const maxExhaustion =
        ctx.config.maxExhaustionRangePct ?? MOMENTUM_FILTERS.maxExhaustionRangePct;
      if (Number.isFinite(rangePct) && rangePct < maxExhaustion) {
        addBlocker(
          `Price exhaustion (Flatline Filter): vertical spike followed by stagnant range (${rangePct.toFixed(2)}%) at the peak.`,
          'price-exhaustion'
        );
      }
    }
  }

  // Consistency Filter
  const snapshots = priceHistory.concat({ price: currentPrice, timestamp: now });
  let greenSnapshots = 0;
  for (let i = 1; i < snapshots.length; i++) {
    if (snapshots[i]!.price > snapshots[i - 1]!.price) greenSnapshots++;
  }
  const consistencyRatio = greenSnapshots / (snapshots.length - 1);
  const minConsistency =
    ctx.config.minMomentumConsistency ?? MOMENTUM_FILTERS.minMomentumConsistency;
  if (consistencyRatio < minConsistency) {
    addBlocker(
      `Choppy momentum: ${(consistencyRatio * 100).toFixed(1)}% green (min ${(minConsistency * 100).toFixed(0)}% required).`,
      'choppy-momentum'
    );
  }
}
