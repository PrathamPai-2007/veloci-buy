/**
 * @module Backtest
 * Types for the offline entry-decision evaluation harness.
 *
 * Where {@link module:Analyze} replays *exit* parameters over completed trades,
 * this harness answers a different question: does the ML *entry* score actually
 * separate winners from losers, and what does gating on it do to realized PnL?
 *
 * It consumes the same ground-truth the live bot records ({@link TrainingSample}
 * rows: features + sequence + realized outcome), so the offline scoring path is
 * identical to the live one — no train/serve skew.
 */

/**
 * A single scored evaluation sample: the model's confidence next to the realized
 * ground-truth outcome. `pnlUsd` lets the sweep weigh decisions by money, not
 * just by count.
 */
export interface ScoredSample {
  /** Model confidence in [0,1] from the held-out (walk-forward) evaluation. */
  confidence: number;
  /** Ground-truth label: 1 = the trade was profitable, 0 = loss. */
  label: 0 | 1;
  /** Realized USD PnL of the trade — used for the PnL-uplift table. */
  pnlUsd: number;
  /** DEX bucket the sample belonged to (for per-launchpad breakdowns). */
  launchpad: string | null;
}

/** Confusion-matrix-derived metrics for one decision threshold. */
export interface ThresholdMetrics {
  /** The `mlScoreGateThreshold` value being evaluated. */
  threshold: number;
  /** Count of samples the model would ADMIT (confidence ≥ threshold). */
  taken: number;
  /** Count of samples the model would BLOCK (confidence < threshold). */
  blocked: number;
  precision: number;
  recall: number;
  /** Profitable-trade rate among ADMITTED samples (the gate's realized win rate). */
  takenWinRate: number;
  /** Total realized USD PnL across ADMITTED samples. */
  takenPnlUsd: number;
  /** Mean realized USD PnL per ADMITTED sample. */
  takenAvgPnlUsd: number;
  /**
   * Uplift vs the rule-only baseline (admit everything): mean PnL of admitted
   * samples minus mean PnL across all samples. Positive ⇒ the gate adds value.
   */
  avgPnlUpliftUsd: number;
}

/** The rule-only control: every candidate that reached scoring is "admitted". */
export interface BaselineMetrics {
  samples: number;
  winRate: number;
  totalPnlUsd: number;
  avgPnlUsd: number;
}

/** Full report produced by {@link runEntryBacktest}. */
export interface BacktestReport {
  /** Samples used to train the evaluation model (older half). */
  trainSamples: number;
  /** Held-out samples the metrics below are computed on (newer half). */
  evalSamples: number;
  /** Whether a native LSTM was available; in shadow mode AUC is undefined-ish (~0.5). */
  nativeAvailable: boolean;
  /** Rank-based area under the ROC curve over the eval set. 0.5 = no signal. */
  auc: number;
  /** Rule-only control metrics over the eval set. */
  baseline: BaselineMetrics;
  /** Per-threshold sweep over the eval set. */
  sweep: ThresholdMetrics[];
}

/** Options for {@link runEntryBacktest}. */
export interface BacktestOptions {
  /** Fraction of (chronologically sorted) samples used for training. Default 0.7. */
  trainFraction?: number;
  /** Min samples required to attempt training. Passed to the EnsembleModel. Default 10. */
  minSamples?: number;
  /** Thresholds to sweep. Default 0.1 … 0.9 in 0.1 steps. */
  thresholds?: number[];
  /** Deterministically shuffle labels before splitting — used to prove AUC≈0.5 on noise. */
  shuffleLabels?: boolean;
}
