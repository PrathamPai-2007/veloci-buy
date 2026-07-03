import { ClosedTrade, Config, TrainingSample } from '#types/index.js';

export interface ParamSpec {
  key: string;
  min: number;
  max: number;
  delta: number;
  learningRate: number;
  // Hard cap on the absolute step size per cycle. Prevents large gradient magnitudes
  // (from many trades or high PnL variance) from jumping a parameter to its bound in
  // a single retrain. Defaults to delta when omitted (move at most one probe unit/cycle).
  maxStep?: number;
  // When true, the value is rounded to a whole number after each gradient step
  // (e.g. minHolderCount must stay an integer).
  integer?: boolean;
}

// Only EXIT-shape parameters are optimized. Entry filters (minCandidateScore,
// minLiquidityUsd, …) are deliberately excluded: replayNetPnl can only score
// trades that were actually taken, so raising an entry filter only ever drops
// (mostly losing) marginal trades — a one-directional bias that monotonically
// ratchets filters up and starves the bot of trades. Entry quality is governed
// by the ML scoring model and the static strategy YAML instead. Exit params are
// simulated from each trade's recorded peak price and have no such bias.
export const PARAM_SPECS: ParamSpec[] = [
  { key: 'stopLossPct', min: 0.05, max: 0.35, delta: 0.01, learningRate: 0.003, maxStep: 0.01 },
  {
    key: 'trailingStopDrawdownPct',
    min: 0.05,
    max: 0.4,
    delta: 0.01,
    learningRate: 0.003,
    maxStep: 0.01,
  },
  {
    key: 'takeProfitMultiples_0',
    min: 1.1,
    max: 2.5,
    delta: 0.05,
    learningRate: 0.01,
    maxStep: 0.05,
  },
  {
    key: 'takeProfitMultiples_1',
    min: 1.5,
    max: 4.0,
    delta: 0.05,
    learningRate: 0.01,
    maxStep: 0.05,
  },
  // Note: Exit parameters below cannot be perfectly simulated from peak price alone,
  // but are added to the spec so the optimizer can track them.
  {
    key: 'earlyPerformanceGuardSeconds',
    min: 5,
    max: 60,
    delta: 5,
    learningRate: 1,
    maxStep: 5,
    integer: true,
  },
  {
    key: 'earlyPerformanceDropPct',
    min: 0.05,
    max: 0.5,
    delta: 0.05,
    learningRate: 0.01,
    maxStep: 0.05,
  },
  {
    key: 'liquidityCollapseThresholdUsd',
    min: 50,
    max: 500,
    delta: 50,
    learningRate: 10,
    maxStep: 50,
  },
  {
    key: 'liquidityCollapseThresholdRatio',
    min: 0.1,
    max: 0.8,
    delta: 0.1,
    learningRate: 0.05,
    maxStep: 0.1,
  },
];

// Entry-gate parameters tuned from GHOST + real trade outcomes. Unlike the exit
// params above (which replay only trades that were taken), ghost trades are opened
// regardless of the live entry gate, so the ghost dataset contains outcomes for
// trades BELOW the current thresholds. That makes replayEntryNetPnl two-directional:
// lowering a gate adds both winning and losing trades, so the gradient can push a
// threshold down (admit more) or up (filter more) — no one-directional starvation.
export const ENTRY_PARAM_SPECS: ParamSpec[] = [
  {
    key: 'minHolderCount',
    min: 3,
    max: 25,
    delta: 1,
    learningRate: 0.02,
    maxStep: 1,
    integer: true,
  },
  { key: 'minCandidateScore', min: 55, max: 85, delta: 1, learningRate: 0.02, maxStep: 1 },
  { key: 'minLiquidityUsd', min: 100, max: 2000, delta: 25, learningRate: 0.5, maxStep: 25 },
  { key: 'minOrganicScore', min: -10, max: 20, delta: 1, learningRate: 0.1, maxStep: 1 },
  { key: 'maxFdvToLiquidity', min: 0.5, max: 3.0, delta: 0.1, learningRate: 0.05, maxStep: 0.1 },
  {
    key: 'minSurvivalMomentum',
    min: 1.0,
    max: 1.5,
    delta: 0.05,
    learningRate: 0.02,
    maxStep: 0.05,
  },
  {
    key: 'minBreakoutMultiplier',
    min: 1.0,
    max: 1.5,
    delta: 0.05,
    learningRate: 0.02,
    maxStep: 0.05,
  },
];

/**
 * Extracts current entry-gate parameter values from the live Config.
 */
export function extractCurrentEntryParams(config: Config): Record<string, number> {
  return {
    minHolderCount: config.minHolderCount,
    minCandidateScore: config.minCandidateScore,
    minLiquidityUsd: config.minLiquidityUsd,
    minOrganicScore: config.minOrganicScore,
    maxFdvToLiquidity: config.maxFdvToLiquidity,
    minSurvivalMomentum: config.minSurvivalMomentum,
    minBreakoutMultiplier: config.minBreakoutMultiplier,
  };
}

/**
 * Recovers the raw entry-gate values from a sample's encoded feature vector.
 * Inverts the encoding in features.ts: raw[0] = log1p(liquidity), raw[2] = log1p(holderCount).
 * Returns null when the featuresJson cannot be parsed.
 */
export function decodeEntryFeatures(featuresJson: string): {
  holderCount: number;
  liquidityUsd: number;
  organicScore: number;
  fdvToLiquidity: number;
  momentum: number;
} | null {
  try {
    const raw = JSON.parse(featuresJson) as number[];
    const liquidityUsd = Math.max(0, Math.expm1(raw[0] ?? 0));
    const holderCount = Math.max(0, Math.round(Math.expm1(raw[2] ?? 0)));
    const organicScore = raw[3] ?? 0;
    const momentum = raw[11] ?? 1.0;
    const fdvToLiquidity = raw[14] ?? 1.0;
    return { holderCount, liquidityUsd, organicScore, fdvToLiquidity, momentum };
  } catch {
    return null;
  }
}

/**
 * Net PnL we would have realized under hypothetical entry gates, replayed over ghost/real
 * samples. A sample contributes its realized PnL only if it clears all three thresholds.
 * The entry score comes directly from the sample's recorded entryScore; holder count and
 * liquidity are decoded from the stored feature vector.
 */
export function replayEntryNetPnl(
  samples: TrainingSample[],
  params: Record<string, number>
): number {
  const minHolders = params['minHolderCount'] ?? 0;
  const minScore = params['minCandidateScore'] ?? 0;
  const minLiq = params['minLiquidityUsd'] ?? 0;
  const minOrganic = params['minOrganicScore'] ?? -100;
  const maxFdvToLiq = params['maxFdvToLiquidity'] ?? 100;
  const minSurvivalMom = params['minSurvivalMomentum'] ?? 0;
  const minBreakoutMom = params['minBreakoutMultiplier'] ?? 0;

  let total = 0;
  for (const s of samples) {
    if (s.entryScore < minScore) continue;
    const decoded = decodeEntryFeatures(s.featuresJson);
    if (!decoded) continue;
    if (decoded.holderCount < minHolders) continue;
    if (decoded.liquidityUsd < minLiq) continue;
    if (decoded.organicScore < minOrganic) continue;
    if (decoded.fdvToLiquidity > maxFdvToLiq) continue;
    if (decoded.momentum < minSurvivalMom) continue;
    if (decoded.momentum < minBreakoutMom) continue;
    total += s.realizedPnlUsd;
  }
  return total;
}

/**
 * Estimates the gradient of entry-gate net PnL w.r.t. each entry param using central
 * finite differences over replayEntryNetPnl. Mirror of estimateGradients for ghost samples.
 */
export function estimateEntryGradients(
  samples: TrainingSample[],
  current: Record<string, number>,
  specs: ParamSpec[]
): Record<string, number> {
  const gradients: Record<string, number> = {};
  for (const spec of specs) {
    const lo = { ...current, [spec.key]: (current[spec.key] ?? 0) - spec.delta };
    const hi = { ...current, [spec.key]: (current[spec.key] ?? 0) + spec.delta };
    gradients[spec.key] =
      (replayEntryNetPnl(samples, hi) - replayEntryNetPnl(samples, lo)) / (2 * spec.delta);
  }
  return gradients;
}

/**
 * Extracts current parameter values from the live Config.
 */
export function extractCurrentParams(config: Config): Record<string, number> {
  const tp = config.takeProfitMultiples;
  return {
    stopLossPct: config.stopLossPct,
    trailingStopDrawdownPct: config.trailingStopDrawdownPct,
    takeProfitMultiples_0: tp[0] ?? 1.3,
    takeProfitMultiples_1: tp[1] ?? 2.1,
    earlyPerformanceGuardSeconds: config.earlyPerformanceGuardSeconds,
    earlyPerformanceDropPct: config.earlyPerformanceDropPct,
    liquidityCollapseThresholdUsd: config.liquidityCollapseThresholdUsd,
    liquidityCollapseThresholdRatio: config.liquidityCollapseThresholdRatio,
  };
}

/**
 * Simulates a single trade's PnL under hypothetical SL/TP parameters.
 * Uses the recorded peak price to approximate how many TP targets would have been hit
 * and what the trailing-stop exit would have been.
 * Assumes a 50/50 split between the two TP targets for simplicity.
 */
function simulateTradePnl(
  trade: ClosedTrade,
  stopLossPct: number,
  trailingStop: number,
  tp0: number,
  tp1: number
): number {
  const peakMult = trade.entryPriceUsd > 0 ? trade.highestPriceUsd / trade.entryPriceUsd : 1;
  const stake = trade.entryUsdValue;

  // Price never recovered — simulate as a stop-loss exit
  if (peakMult <= 1) {
    return -stopLossPct * stake;
  }

  let pnl = 0;
  let remaining = 1.0;
  const splitFraction = 0.5;

  if (peakMult >= tp0) {
    pnl += stake * remaining * splitFraction * (tp0 - 1);
    remaining -= splitFraction;
  }
  if (peakMult >= tp1) {
    pnl += stake * remaining * (tp1 - 1);
    remaining = 0;
  }

  if (remaining > 0) {
    // Remainder closed by trailing stop from peak (or initial SL if peak was minimal)
    const trailingExitMult = peakMult * (1 - trailingStop);
    const exitMult = Math.max(1 - stopLossPct, trailingExitMult);
    pnl += stake * remaining * (exitMult - 1);
  }

  return pnl;
}

/**
 * Approximates net PnL by applying hypothetical parameter filters and exit simulation.
 * Entry-quality params (minCandidateScore, minLiquidityUsd) filter out trades.
 * Exit params (stopLossPct, trailingStop, TP multiples) are simulated from the recorded peak price.
 */
export function replayNetPnl(trades: ClosedTrade[], params: Record<string, number>): number {
  const minScore = params['minCandidateScore'] ?? 0;
  const minLiq = params['minLiquidityUsd'] ?? 0;
  const stopLossPct = params['stopLossPct'] ?? 0.15;
  const trailingStop = params['trailingStopDrawdownPct'] ?? 0.12;
  const tp0 = params['takeProfitMultiples_0'] ?? 1.3;
  const tp1 = params['takeProfitMultiples_1'] ?? 2.1;

  let total = 0;
  for (const trade of trades) {
    if (trade.entryScore < minScore) continue;
    if (trade.entryLiquidityUsd < minLiq) continue;
    total += simulateTradePnl(trade, stopLossPct, trailingStop, tp0, tp1);
  }
  return total;
}

/**
 * Estimates the gradient of net PnL w.r.t. each parameter using central finite differences.
 * More accurate than forward differences (O(delta²) vs O(delta) error).
 */
export function estimateGradients(
  trades: ClosedTrade[],
  current: Record<string, number>,
  specs: ParamSpec[]
): Record<string, number> {
  const gradients: Record<string, number> = {};

  for (const spec of specs) {
    const lo = { ...current, [spec.key]: (current[spec.key] ?? 0) - spec.delta };
    const hi = { ...current, [spec.key]: (current[spec.key] ?? 0) + spec.delta };
    gradients[spec.key] = (replayNetPnl(trades, hi) - replayNetPnl(trades, lo)) / (2 * spec.delta);
  }

  return gradients;
}

/**
 * Simulates a single ghost/training-sample's PnL under hypothetical exit parameters.
 * Requires entryPriceUsd and highestPriceUsd on the sample; returns 0 if either is missing.
 * Uses a notional $100 stake to match the ghost trader's realizedPnlUsd scaling.
 */
function simulateSamplePnl(sample: TrainingSample, params: Record<string, number>): number {
  const { entryPriceUsd, highestPriceUsd } = sample;
  if (!entryPriceUsd || !highestPriceUsd || entryPriceUsd <= 0) return 0;

  const stopLossPct = params['stopLossPct'] ?? 0.15;
  const trailingStop = params['trailingStopDrawdownPct'] ?? 0.12;
  const tp0 = params['takeProfitMultiples_0'] ?? 1.3;
  const tp1 = params['takeProfitMultiples_1'] ?? 2.1;
  const maxHoldMinutes = params['maxHoldMinutes'] ?? 15;

  const earlyGuardSec = params['earlyPerformanceGuardSeconds'] ?? 30;
  const earlyDropPct = params['earlyPerformanceDropPct'] ?? 0.1;
  const liqCollapseUsd = params['liquidityCollapseThresholdUsd'] ?? 5000;
  const liqCollapseRatio = params['liquidityCollapseThresholdRatio'] ?? 0.5;

  const stake = 100;

  if (sample.holdTimeSeriesJson) {
    try {
      const ts = JSON.parse(sample.holdTimeSeriesJson) as [number, number, number][];
      const first = ts[0];
      if (ts.length > 0 && first) {
        const openedAt = first[0];
        const initialLiq = first[2];
        let highestSeen = entryPriceUsd;
        let remaining = 1.0;
        let pnl = 0;
        const splitFraction = 0.5;
        let tp0Hit = false;
        let tp1Hit = false;

        for (let i = 0; i < ts.length; i++) {
          const tick = ts[i];
          if (!tick) continue;
          const [now, pUsd, liqUsd] = tick;
          const holdSec = (now - openedAt) / 1000;
          if (pUsd > highestSeen) highestSeen = pUsd;

          const currentMult = pUsd / entryPriceUsd;
          const peakMult = highestSeen / entryPriceUsd;

          if (!tp0Hit && currentMult >= tp0) {
            tp0Hit = true;
            pnl += stake * remaining * splitFraction * (tp0 - 1);
            remaining -= splitFraction;
          }
          if (!tp1Hit && currentMult >= tp1) {
            tp1Hit = true;
            pnl += stake * remaining * (tp1 - 1);
            remaining = 0;
            break;
          }

          if (currentMult <= 1 - stopLossPct) {
            pnl += stake * remaining * (currentMult - 1);
            remaining = 0;
            break;
          }

          if (peakMult > 1 && currentMult <= peakMult * (1 - trailingStop)) {
            pnl += stake * remaining * (currentMult - 1);
            remaining = 0;
            break;
          }

          if (holdSec >= earlyGuardSec && currentMult <= 1 - earlyDropPct) {
            pnl += stake * remaining * (currentMult - 1);
            remaining = 0;
            break;
          }

          if (liqUsd < liqCollapseUsd || liqUsd < initialLiq * liqCollapseRatio) {
            pnl += stake * remaining * (currentMult - 1);
            remaining = 0;
            break;
          }

          if (holdSec > maxHoldMinutes * 60) {
            pnl += stake * remaining * (currentMult - 1);
            remaining = 0;
            break;
          }
        }

        if (remaining > 0) {
          const lastTick = ts[ts.length - 1];
          if (lastTick) {
            const finalMult = lastTick[1] / entryPriceUsd;
            pnl += stake * remaining * (finalMult - 1);
          }
        }
        return pnl;
      }
    } catch {
      // fallback
    }
  }

  // Fallback if no time series
  const peakMult = highestPriceUsd / entryPriceUsd;
  if (peakMult <= 1) return -stopLossPct * stake;

  let pnl = 0;
  let remaining = 1.0;
  const splitFraction = 0.5;

  if (peakMult >= tp0) {
    pnl += stake * remaining * splitFraction * (tp0 - 1);
    remaining -= splitFraction;
  }
  if (peakMult >= tp1) {
    pnl += stake * remaining * (tp1 - 1);
    remaining = 0;
  }

  if (remaining > 0) {
    const trailingExitMult = peakMult * (1 - trailingStop);
    const exitMult = Math.max(1 - stopLossPct, trailingExitMult);
    pnl += stake * remaining * (exitMult - 1);
  }

  return pnl;
}

/**
 * Approximates net PnL from ghost/training samples under hypothetical exit parameters.
 * Filters by entryScore and liquidity the same way replayNetPnl does for ClosedTrade.
 * Only samples with entryPriceUsd and highestPriceUsd can contribute to the simulation.
 */
export function replayNetPnlFromSamples(
  samples: TrainingSample[],
  params: Record<string, number>
): number {
  const minScore = params['minCandidateScore'] ?? 0;
  const minLiq = params['minLiquidityUsd'] ?? 0;

  let total = 0;
  for (const s of samples) {
    if (s.entryScore < minScore) continue;
    const decoded = decodeEntryFeatures(s.featuresJson);
    if (!decoded || decoded.liquidityUsd < minLiq) continue;
    total += simulateSamplePnl(s, params);
  }
  return total;
}

/**
 * Estimates exit-param gradients from ghost/training samples via central finite differences.
 * Mirror of estimateGradients for the ghost dataset.
 */
export function estimateGradientsFromSamples(
  samples: TrainingSample[],
  current: Record<string, number>,
  specs: ParamSpec[]
): Record<string, number> {
  const gradients: Record<string, number> = {};
  for (const spec of specs) {
    const lo = { ...current, [spec.key]: (current[spec.key] ?? 0) - spec.delta };
    const hi = { ...current, [spec.key]: (current[spec.key] ?? 0) + spec.delta };
    gradients[spec.key] =
      (replayNetPnlFromSamples(samples, hi) - replayNetPnlFromSamples(samples, lo)) /
      (2 * spec.delta);
  }
  return gradients;
}

/**
 * Combined replayed net PnL over real closed trades + ghost samples under a
 * hypothetical exit-parameter set. This is the offline objective the drift guard
 * uses to decide whether a gradient step actually helps before committing it.
 */
export function scoreExitParams(
  trades: ClosedTrade[],
  samples: TrainingSample[],
  params: Record<string, number>
): number {
  return replayNetPnl(trades, params) + replayNetPnlFromSamples(samples, params);
}

/**
 * Inverse of {@link extractCurrentParams}: writes an exit-parameter snapshot back
 * onto the live Config. Used to revert a gradient step the drift guard rejects.
 * Missing keys leave the corresponding Config field untouched.
 */
export function restoreParams(config: Config, snapshot: Record<string, number>): void {
  if (snapshot['stopLossPct'] !== undefined) config.stopLossPct = snapshot['stopLossPct'];
  if (snapshot['trailingStopDrawdownPct'] !== undefined)
    config.trailingStopDrawdownPct = snapshot['trailingStopDrawdownPct'];

  const tp = [...config.takeProfitMultiples];
  if (snapshot['takeProfitMultiples_0'] !== undefined) tp[0] = snapshot['takeProfitMultiples_0'];
  if (snapshot['takeProfitMultiples_1'] !== undefined) tp[1] = snapshot['takeProfitMultiples_1'];
  config.takeProfitMultiples = tp;

  if (snapshot['earlyPerformanceGuardSeconds'] !== undefined)
    config.earlyPerformanceGuardSeconds = snapshot['earlyPerformanceGuardSeconds'];
  if (snapshot['earlyPerformanceDropPct'] !== undefined)
    config.earlyPerformanceDropPct = snapshot['earlyPerformanceDropPct'];
  if (snapshot['liquidityCollapseThresholdUsd'] !== undefined)
    config.liquidityCollapseThresholdUsd = snapshot['liquidityCollapseThresholdUsd'];
  if (snapshot['liquidityCollapseThresholdRatio'] !== undefined)
    config.liquidityCollapseThresholdRatio = snapshot['liquidityCollapseThresholdRatio'];
}

/**
 * Pool-size-weighted average of two gradient maps.
 * Prevents the larger pool from completely drowning the signal from the smaller one
 * while still weighting proportionally.
 */
export function weightedAverageGradients(
  gradA: Record<string, number>,
  weightA: number,
  gradB: Record<string, number>,
  weightB: number
): Record<string, number> {
  const total = weightA + weightB;
  if (total === 0) return gradA;
  const result: Record<string, number> = {};
  const keys = new Set([...Object.keys(gradA), ...Object.keys(gradB)]);
  for (const k of keys) {
    const a = (gradA[k] ?? 0) * weightA;
    const b = (gradB[k] ?? 0) * weightB;
    result[k] = (a + b) / total;
  }
  return result;
}

/**
 * Applies one gradient ascent step to the live Config object (mutated in-place).
 * All values are clamped to spec bounds to ensure safety.
 */
export function applyGradientStep(
  config: Config,
  gradients: Record<string, number>,
  specs: ParamSpec[]
): Record<string, { before: number; after: number }> {
  const changes: Record<string, { before: number; after: number }> = {};

  for (const spec of specs) {
    const grad = gradients[spec.key];
    if (grad === undefined || !Number.isFinite(grad)) continue;

    const isTpKey = spec.key === 'takeProfitMultiples_0' || spec.key === 'takeProfitMultiples_1';
    const tpIdx = spec.key === 'takeProfitMultiples_0' ? 0 : 1;

    let before: number;
    let updated: number;

    // Cap the raw gradient step to maxStep (defaults to delta) so large gradient
    // magnitudes from many trades or high PnL variance can't jump a param to its
    // boundary in a single cycle.
    const cap = spec.maxStep ?? spec.delta;
    const rawStep = spec.learningRate * grad;
    const clampedStep = Math.sign(rawStep) * Math.min(Math.abs(rawStep), cap);

    if (isTpKey) {
      before = config.takeProfitMultiples[tpIdx] ?? spec.min;
      updated = before + clampedStep;
    } else {
      before = (config as unknown as Record<string, number>)[spec.key] ?? spec.min;
      updated = before + clampedStep;
    }

    let after = Math.max(spec.min, Math.min(spec.max, updated));
    if (spec.integer) after = Math.round(after);

    if (Math.abs(after - before) > 1e-9) {
      if (isTpKey) {
        const tp = [...config.takeProfitMultiples];
        tp[tpIdx] = after;
        // Ensure tp[0] < tp[1] to keep profiles sane
        if (tpIdx === 0 && tp[0] !== undefined && tp[1] !== undefined && tp[0] >= tp[1]) {
          tp[0] = tp[1] - 0.1;
        }
        if (tpIdx === 1 && tp[0] !== undefined && tp[1] !== undefined && tp[1] <= tp[0]) {
          tp[1] = tp[0] + 0.1;
        }
        config.takeProfitMultiples = tp;
      } else {
        (config as unknown as Record<string, number>)[spec.key] = after;
      }
      changes[spec.key] = { before, after };
    }
  }

  return changes;
}
