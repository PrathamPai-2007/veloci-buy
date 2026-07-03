import { MlScoreResult, TrainingSample } from '#types/index.js';
import { ScoringModel, TrainMetrics } from './scoring-model.js';
import { CircuitBreaker, confidenceToTpProfile } from './gating.js';

/**
 * DEX buckets the ensemble keeps a dedicated model for. `default` is the general
 * model trained on every sample and used as a fallback / blending partner.
 */
export type EnsembleBucket = 'pumpfun' | 'raydium' | 'default';
const DEX_BUCKETS: EnsembleBucket[] = ['pumpfun', 'raydium'];

/** Maps a launchpad string to its ensemble bucket. */
export function bucketFor(launchpad: string | null | undefined): EnsembleBucket {
  const s = (launchpad ?? '').toLowerCase();
  if (s.includes('pump')) return 'pumpfun';
  if (s.includes('ray')) return 'raydium';
  return 'default';
}

/**
 * Ensemble of per-DEX LSTM scorers plus a general model.
 *
 * Pump.fun and Raydium tokens behave differently (bonding-curve vs. AMM
 * liquidity, holder dynamics, momentum shape), so a model specialized to each
 * DEX can outscore one global model — *once it has enough data*. Until a DEX
 * bucket trains, scoring falls back to the general model, and when both are
 * trained their confidences are averaged. Gating (threshold → blocked,
 * circuit breaker, TP profile) is applied once, on the blended confidence.
 *
 * Exposes the same surface MlService used on a single ScoringModel, plus a
 * `launchpad` argument on {@link predict}.
 */
export class EnsembleModel {
  private readonly models: Record<EnsembleBucket, ScoringModel>;
  private circuitBreaker = new CircuitBreaker();

  constructor(minSamples: number) {
    this.models = {
      default: new ScoringModel(minSamples),
      pumpfun: new ScoringModel(minSamples),
      raydium: new ScoringModel(minSamples),
    };
  }

  nativeAvailable(): boolean {
    return this.models.default.nativeAvailable();
  }

  tsFallbackActive(): boolean {
    return (
      this.models.default.tsFallbackActive() ||
      this.models.pumpfun.tsFallbackActive() ||
      this.models.raydium.tsFallbackActive()
    );
  }

  /** True once any constituent model has trained. */
  getIsTrained(): boolean {
    return (
      this.models.default.getIsTrained() ||
      this.models.pumpfun.getIsTrained() ||
      this.models.raydium.getIsTrained()
    );
  }

  getCircuitBreakerActive(): boolean {
    return this.circuitBreaker.isActive();
  }

  /**
   * Scores a candidate, routing to the DEX-specific model and the general model
   * and averaging whichever are trained.
   */
  predict(
    features: Float32Array,
    sequence: number[][],
    threshold: number,
    launchpad?: string | null
  ): MlScoreResult {
    const bucket = bucketFor(launchpad);

    const confidences: number[] = [];
    if (bucket !== 'default') {
      const dex = this.models[bucket].predictConfidence(features, sequence);
      if (dex !== null) confidences.push(dex);
    }
    const general = this.models.default.predictConfidence(features, sequence);
    if (general !== null) confidences.push(general);

    if (confidences.length === 0) {
      return { confidence: 0.5, tpProfile: 'standard', shadowMode: true, blocked: false };
    }

    const confidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;
    const blocked = confidence < threshold && !this.circuitBreaker.isActive();
    this.circuitBreaker.record(blocked);

    return {
      confidence,
      tpProfile: confidenceToTpProfile(confidence, threshold),
      shadowMode: false,
      blocked,
    };
  }

  /**
   * Trains the general model on all samples and each DEX model on its subset.
   * Returns the general model's metrics (trained on the full set) as the headline
   * result, or null when there were too few samples to train anything.
   */
  async train(
    samples: TrainingSample[],
    options?: { compulsory?: boolean }
  ): Promise<TrainMetrics | null> {
    const generalMetrics = await this.models.default.train(samples, options);

    for (const bucket of DEX_BUCKETS) {
      const subset = samples.filter((s) => bucketFor(s.launchpad) === bucket);
      if (subset.length > 0) await this.models[bucket].train(subset, options);
    }

    // Retraining invalidates the blended block-rate history.
    this.circuitBreaker.reset();
    return generalMetrics;
  }

  saveWeights(upsertKV: (key: string, val: string) => void): void {
    for (const bucket of Object.keys(this.models) as EnsembleBucket[]) {
      this.models[bucket].saveWeights((k, v) => upsertKV(`ens:${bucket}:${k}`, v));
    }
  }

  /** Returns true if at least one bucket's weights loaded. */
  loadWeights(getKV: (key: string) => string | null): boolean {
    let any = false;
    for (const bucket of Object.keys(this.models) as EnsembleBucket[]) {
      if (this.models[bucket].loadWeights((k) => getKV(`ens:${bucket}:${k}`))) any = true;
    }
    return any;
  }
}
