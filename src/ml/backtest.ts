/**
 * @module Backtest
 * Offline entry-decision evaluation harness.
 *
 * Trains an {@link EnsembleModel} on the older portion of recorded
 * {@link TrainingSample}s and evaluates it on the newer (held-out) portion —
 * a walk-forward split that avoids lookahead. It then reports how well the
 * model's confidence separates winners from losers (AUC, precision/recall) and
 * what gating on each candidate `mlScoreGateThreshold` would have done to
 * realized PnL versus the rule-only baseline (admit everything).
 *
 * The scoring path reuses {@link EnsembleModel.predict} with a zero threshold,
 * so confidences come from exactly the code the live bot runs.
 */

import { TrainingSample } from '#types/index.js';
import { EnsembleModel } from './ensemble-model.js';
import { buildSequenceFromJson } from './sequence-features.js';
import {
  BacktestOptions,
  BacktestReport,
  BaselineMetrics,
  ScoredSample,
  ThresholdMetrics,
} from './backtest.types.js';

const DEFAULT_TRAIN_FRACTION = 0.7;
const DEFAULT_MIN_SAMPLES = 25;
const DEFAULT_THRESHOLDS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

/**
 * Chronological walk-forward split. Sorts by `closedAt` ascending so the model
 * only ever trains on samples that closed *before* the ones it is judged on.
 */
export function splitWalkForward(
  samples: TrainingSample[],
  trainFraction: number
): { train: TrainingSample[]; evaluation: TrainingSample[] } {
  const sorted = [...samples].sort((a, b) => a.closedAt.localeCompare(b.closedAt));
  const cut = Math.floor(sorted.length * trainFraction);
  return { train: sorted.slice(0, cut), evaluation: sorted.slice(cut) };
}

/**
 * Scores each sample with the (already-trained) model. Uses a zero gate
 * threshold so `predict` never blocks and never trips the circuit breaker —
 * we only want the raw blended confidence.
 */
export function scoreSamples(model: EnsembleModel, samples: TrainingSample[]): ScoredSample[] {
  return samples.map((s) => {
    const features = new Float32Array(JSON.parse(s.featuresJson) as number[]);
    const sequence = buildSequenceFromJson(s.sequenceJson);
    const { confidence } = model.predict(features, sequence, 0, s.launchpad);
    return {
      confidence,
      label: s.label,
      pnlUsd: Number(s.realizedPnlUsd ?? 0),
      launchpad: s.launchpad,
    };
  });
}

/**
 * Rank-based ROC AUC (equivalent to the Mann–Whitney U statistic), tie-aware.
 * Returns 0.5 when either class is empty (no signal can be measured).
 */
export function computeAuc(scored: ScoredSample[]): number {
  const positives = scored.filter((s) => s.label === 1).length;
  const negatives = scored.length - positives;
  if (positives === 0 || negatives === 0) return 0.5;

  // Assign average ranks to handle ties in confidence fairly.
  const sorted = [...scored].sort((a, b) => a.confidence - b.confidence);
  const ranks = new Array<number>(sorted.length);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j < sorted.length - 1 && sorted[j + 1]!.confidence === sorted[i]!.confidence) j++;
    const avgRank = (i + j) / 2 + 1; // ranks are 1-based
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    i = j + 1;
  }

  let rankSumPos = 0;
  for (let k = 0; k < sorted.length; k++) {
    if (sorted[k]!.label === 1) rankSumPos += ranks[k]!;
  }

  // AUC = (sum of positive ranks − minimal positive rank sum) / (P·N)
  return (rankSumPos - (positives * (positives + 1)) / 2) / (positives * negatives);
}

/** Rule-only control: every scored sample is treated as admitted. */
export function computeBaseline(scored: ScoredSample[]): BaselineMetrics {
  const n = scored.length;
  const wins = scored.filter((s) => s.label === 1).length;
  const totalPnlUsd = scored.reduce((acc, s) => acc + s.pnlUsd, 0);
  return {
    samples: n,
    winRate: n > 0 ? wins / n : 0,
    totalPnlUsd,
    avgPnlUsd: n > 0 ? totalPnlUsd / n : 0,
  };
}

/** Metrics for admitting every sample with confidence ≥ `threshold`. */
export function metricsAtThreshold(
  scored: ScoredSample[],
  threshold: number,
  baselineAvgPnl: number
): ThresholdMetrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let takenPnlUsd = 0;
  let takenWins = 0;
  let taken = 0;

  for (const s of scored) {
    const admit = s.confidence >= threshold;
    if (admit) {
      taken++;
      takenPnlUsd += s.pnlUsd;
      if (s.label === 1) {
        tp++;
        takenWins++;
      } else {
        fp++;
      }
    } else if (s.label === 1) {
      fn++;
    }
  }

  const blocked = scored.length - taken;
  const takenAvgPnlUsd = taken > 0 ? takenPnlUsd / taken : 0;
  return {
    threshold,
    taken,
    blocked,
    precision: tp + fp > 0 ? tp / (tp + fp) : 0,
    recall: tp + fn > 0 ? tp / (tp + fn) : 0,
    takenWinRate: taken > 0 ? takenWins / taken : 0,
    takenPnlUsd,
    takenAvgPnlUsd,
    avgPnlUpliftUsd: takenAvgPnlUsd - baselineAvgPnl,
  };
}

/** Deterministic (seeded) Fisher–Yates shuffle — used to scramble labels for the noise sanity check. */
function seededShuffle<T>(arr: T[], seed: number): T[] {
  const out = [...arr];
  let state = seed >>> 0;
  const next = (): number => {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Runs the full entry-decision backtest: walk-forward split, train, score the
 * held-out set, and compute AUC + baseline + threshold sweep.
 *
 * Returns `null` when there are too few samples to form a usable split.
 */
export async function runEntryBacktest(
  samples: TrainingSample[],
  options: BacktestOptions = {}
): Promise<BacktestReport | null> {
  const trainFraction = options.trainFraction ?? DEFAULT_TRAIN_FRACTION;
  const minSamples = options.minSamples ?? DEFAULT_MIN_SAMPLES;
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;

  let working = samples;
  if (options.shuffleLabels) {
    // Detach labels from features to destroy any real signal — the model should
    // then score at AUC ≈ 0.5. Shuffle labels across the (chronological) set.
    const sorted = [...samples].sort((a, b) => a.closedAt.localeCompare(b.closedAt));
    const shuffledLabels = seededShuffle(
      sorted.map((s) => s.label),
      1337
    );
    working = sorted.map((s, idx) => ({ ...s, label: shuffledLabels[idx]! }));
  }

  const { train, evaluation } = splitWalkForward(working, trainFraction);
  if (train.length < minSamples || evaluation.length === 0) return null;

  const model = new EnsembleModel(minSamples);
  await model.train(train);

  const scored = scoreSamples(model, evaluation);
  const baseline = computeBaseline(scored);
  const sweep = thresholds.map((t) => metricsAtThreshold(scored, t, baseline.avgPnlUsd));

  return {
    trainSamples: train.length,
    evalSamples: evaluation.length,
    nativeAvailable: model.nativeAvailable(),
    auc: computeAuc(scored),
    baseline,
    sweep,
  };
}
