import { Config, TrainingSample } from '#types/index.js';
import { NativeRlPolicy, createRlPolicy } from './native.js';

/**
 * Regime-conditioned RL optimizer for exit parameters, backed by the native PPO
 * policy. An opt-in alternative to the central-difference param optimizer: it
 * outputs continuous (stopLoss, trailingStop, tp0, tp1) values *as a function of
 * the market regime*, so volatile and calm conditions get different exit shapes.
 *
 * Enabled by default (`ML_RL_OPTIMIZER=true`). When the native addon is missing or there
 * is too little data, {@link optimize} is a no-op and the proven optimizer path
 * continues to govern exit params.
 */

// Action vector order and bounds — must match the reward sim in ppo.rs.
const ACTION_MIN = [0.05, 0.05, 1.1, 1.5]; // stopLoss, trailing, tp0, tp1
const ACTION_MAX = [0.35, 0.4, 2.5, 4.0];
const STATE_DIM = 1; // [volatility regime in 0..1]
const INIT_SEED = 7919;
const MIN_SAMPLES = 20;

// PPO hyperparameters.
const ITERS = 60;
const EPOCHS = 4;
const LR = 0.02;
const CLIP = 0.2;
const ENTROPY_COEF = 0.005;

const KV_WEIGHTS = 'rl:exit_policy';

export interface RlOptimizeResult {
  samples: number;
  finalAvgReward: number;
  regime: number;
  changes: Record<string, { before: number; after: number }>;
}

/** Decodes the volatility regime (0..1) from a sample's feature vector (raw[10]). */
function regimeOf(sample: TrainingSample): number | null {
  try {
    const arr = JSON.parse(sample.featuresJson) as number[];
    const volScaler = arr[10]; // features.ts: clamp(volatilityScaler, 0, 2)
    if (volScaler === undefined || !Number.isFinite(volScaler)) return null;
    return Math.max(0, Math.min(1, volScaler / 2));
  } catch {
    return null;
  }
}

export class RlExitOptimizer {
  private policy: NativeRlPolicy | null;
  private trained = false;

  constructor() {
    this.policy = createRlPolicy(STATE_DIM, ACTION_MIN, ACTION_MAX, INIT_SEED);
  }

  available(): boolean {
    return this.policy !== null;
  }

  getIsTrained(): boolean {
    return this.trained;
  }

  /**
   * Trains the policy on ghost/real samples (those with a usable peak price) and
   * applies the regime-appropriate exit params to `config` in place. Returns a
   * summary, or null when unavailable / insufficient data.
   */
  optimize(config: Config, samples: TrainingSample[]): RlOptimizeResult | null {
    if (!this.policy) return null;

    const states: number[][] = [];
    const peakMults: number[] = [];
    const stakes: number[] = [];
    let regimeSum = 0;
    for (const s of samples) {
      const { entryPriceUsd, highestPriceUsd } = s;
      if (!entryPriceUsd || !highestPriceUsd || entryPriceUsd <= 0) continue;
      const regime = regimeOf(s);
      if (regime === null) continue;
      states.push([regime]);
      peakMults.push(highestPriceUsd / entryPriceUsd);
      stakes.push(100); // notional, matching ghost realizedPnl scaling
      regimeSum += regime;
    }

    if (states.length < MIN_SAMPLES) return null;

    const result = this.policy.train(
      states,
      peakMults,
      stakes,
      ITERS,
      EPOCHS,
      LR,
      CLIP,
      ENTROPY_COEF,
      INIT_SEED
    );
    this.trained = true;

    // Apply params for the current (mean) regime of the dataset.
    const regime = regimeSum / states.length;
    const changes = this.apply(config, regime);

    return { samples: states.length, finalAvgReward: result.finalAvgReward, regime, changes };
  }

  /** Sets exit params on `config` from the policy's output for `regime` (0..1). */
  apply(config: Config, regime: number): Record<string, { before: number; after: number }> {
    const changes: Record<string, { before: number; after: number }> = {};
    if (!this.policy) return changes;

    const [sl, trailing, tp0Raw, tp1Raw] = this.policy.predict([clamp01(regime)]);
    if (
      sl === undefined ||
      trailing === undefined ||
      tp0Raw === undefined ||
      tp1Raw === undefined
    ) {
      return changes;
    }
    const tp0 = tp0Raw;
    const tp1 = tp1Raw > tp0 ? tp1Raw : tp0 + 0.1; // keep rungs ordered

    record(changes, 'stopLossPct', config.stopLossPct, sl);
    config.stopLossPct = sl;

    record(changes, 'trailingStopDrawdownPct', config.trailingStopDrawdownPct, trailing);
    config.trailingStopDrawdownPct = trailing;

    const before0 = config.takeProfitMultiples[0] ?? tp0;
    const before1 = config.takeProfitMultiples[1] ?? tp1;
    config.takeProfitMultiples = [tp0, tp1, ...config.takeProfitMultiples.slice(2)];
    record(changes, 'takeProfitMultiples_0', before0, tp0);
    record(changes, 'takeProfitMultiples_1', before1, tp1);

    return changes;
  }

  saveWeights(upsertKV: (key: string, val: string) => void): void {
    if (!this.policy || !this.trained) return;
    upsertKV(KV_WEIGHTS, JSON.stringify(this.policy.serialize()));
  }

  loadWeights(getKV: (key: string) => string | null): boolean {
    if (!this.policy) return false;
    const json = getKV(KV_WEIGHTS);
    if (!json) return false;
    try {
      const flat = JSON.parse(json) as number[];
      if (!this.policy.deserialize(flat)) return false;
      this.trained = true;
      return true;
    } catch {
      return false;
    }
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function record(
  changes: Record<string, { before: number; after: number }>,
  key: string,
  before: number,
  after: number
): void {
  if (Math.abs(after - before) > 1e-9) changes[key] = { before, after };
}
