import { ClosedTrade, Config, TrainingSample } from '#types/index.js';
import { decodeEntryFeatures } from './entry-param-tuner.js';

export interface ParamSpec {
  key: string;
  min: number;
  max: number;
  delta: number;
  learningRate: number;
  maxStep?: number;
  integer?: boolean;
}

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

function simulateTradePnl(
  trade: ClosedTrade,
  stopLossPct: number,
  trailingStop: number,
  tp0: number,
  tp1: number
): number {
  const peakMult = trade.entryPriceUsd > 0 ? trade.highestPriceUsd / trade.entryPriceUsd : 1;
  const stake = trade.entryUsdValue;

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
    const trailingExitMult = peakMult * (1 - trailingStop);
    const exitMult = Math.max(1 - stopLossPct, trailingExitMult);
    pnl += stake * remaining * (exitMult - 1);
  }

  return pnl;
}

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

export function scoreExitParams(
  trades: ClosedTrade[],
  samples: TrainingSample[],
  params: Record<string, number>
): number {
  return replayNetPnl(trades, params) + replayNetPnlFromSamples(samples, params);
}

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
