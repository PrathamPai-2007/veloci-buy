import { MlScoreResult, TrainingSample } from '#types/index.js';
import { FEATURE_DIM, NormStats, computeNormStats, normalizeFeatures } from './features.js';
import { SEQ_FEATURE_DIM, buildSequenceFromJson } from './sequence-features.js';
import { NativeLstm, createLstm, isNativeAvailable } from './native.js';
import { TsLstm, InferenceLstm } from './ts-lstm.js';
import { CircuitBreaker, confidenceToTpProfile } from './gating.js';

// LSTM architecture / training hyperparameters.
const HIDDEN_SIZE = 16;
const INIT_SEED = 1337; // deterministic weight init + shuffle seed
const MAX_EPOCHS = 40;
const BATCH_SIZE = 16;
const LEARNING_RATE = 0.03;
const TEST_FRACTION = 0.2;
const MAX_CLASS_WEIGHT = 5;

// KV keys for weight/stat persistence.
const KV_WEIGHTS = 'ml:lstm_weights';
const KV_NORMSTATS = 'ml:normstats';
const KV_ARCH = 'ml:lstm_arch';
const KV_TRAINED = 'ml:trained';

export interface TrainMetrics {
  samples: number;
  trainSamples: number;
  testSamples: number;
  epochsRan: number;
  labelBalance: number; // fraction of label=1 in train set
  accuracy: number; // train accuracy
  loss: number; // train loss
  testAccuracy: number;
  testPrecision: number;
  testRecall: number;
  testLoss: number;
}

/**
 * Wraps the native LSTM scorer. The model consumes a pre-entry price sequence
 * plus the static 18-dim feature snapshot and emits a confidence in [0, 1].
 *
 * When the native addon is unavailable the model stays permanently in shadow
 * mode (confidence 0.5, never blocks), so the bot keeps running on rule-based
 * scores alone.
 */
export class ScoringModel {
  private nativeLstm: NativeLstm | null;
  private tsLstm: TsLstm | null;
  private normStats: NormStats;
  private isTrained = false;
  private circuitBreaker = new CircuitBreaker();

  constructor(private readonly minSamples: number) {
    this.nativeLstm = createLstm(SEQ_FEATURE_DIM, HIDDEN_SIZE, FEATURE_DIM, INIT_SEED);
    this.tsLstm = this.nativeLstm ? null : new TsLstm(SEQ_FEATURE_DIM, HIDDEN_SIZE, FEATURE_DIM);
    this.normStats = {
      mean: new Float32Array(FEATURE_DIM).fill(0),
      std: new Float32Array(FEATURE_DIM).fill(1),
    };
  }

  private get lstm(): InferenceLstm | null {
    return this.nativeLstm ?? this.tsLstm;
  }

  /** True when the native Rust addon loaded. */
  nativeAvailable(): boolean {
    return isNativeAvailable() && this.nativeLstm !== null;
  }

  /** True when TS fallback is active and weights are loaded. */
  tsFallbackActive(): boolean {
    return this.tsLstm !== null && this.isTrained;
  }

  /**
   * Raw inference: returns the confidence in [0,1], or null when the model is in
   * shadow mode (untrained or no native addon). No gating side effects — used by
   * the ensemble to average across models before gating.
   */
  predictConfidence(features: Float32Array, sequence: number[][]): number | null {
    if (!this.isTrained || !this.lstm) return null;
    const normalized = normalizeFeatures(features, this.normStats);
    return this.lstm.predict(sequence, Array.from(normalized));
  }

  /**
   * Scores a candidate. `sequence` is the pre-entry price-history matrix from
   * {@link buildSequence}; an empty sequence is allowed (dense-head fallback).
   */
  predict(features: Float32Array, sequence: number[][], threshold: number): MlScoreResult {
    const confidence = this.predictConfidence(features, sequence);
    if (confidence === null) {
      return { confidence: 0.5, tpProfile: 'standard', shadowMode: true, blocked: false };
    }

    const blocked = confidence < threshold && !this.circuitBreaker.isActive();
    this.circuitBreaker.record(blocked);

    const tpProfile = confidenceToTpProfile(confidence, threshold);
    return { confidence, tpProfile, shadowMode: false, blocked };
  }

  getCircuitBreakerActive(): boolean {
    return this.circuitBreaker.isActive();
  }

  async train(
    samples: TrainingSample[],
    options?: { compulsory?: boolean }
  ): Promise<TrainMetrics | null> {
    if (!this.nativeLstm) return null;
    if (samples.length < (options?.compulsory ? 1 : this.minSamples)) return null;

    // Chronological train/test split — last TEST_FRACTION samples are held out.
    // Sorting by closedAt avoids leaking future outcomes into normalization.
    const sorted = [...samples].sort((a, b) => a.closedAt.localeCompare(b.closedAt));
    const testCount =
      options?.compulsory && sorted.length <= 2
        ? 0
        : Math.max(1, Math.floor(sorted.length * TEST_FRACTION));
    const trainSamples = sorted.slice(0, sorted.length - testCount);
    const testSamples = sorted.slice(sorted.length - testCount);
    if (trainSamples.length < (options?.compulsory ? 1 : this.minSamples)) return null;

    // Normalization stats computed on the train set only (no leakage).
    const trainRaw = trainSamples.map(
      (s) => new Float32Array(JSON.parse(s.featuresJson) as number[])
    );
    this.normStats = computeNormStats(trainRaw);

    const buildStatic = (s: TrainingSample): number[] =>
      Array.from(
        normalizeFeatures(new Float32Array(JSON.parse(s.featuresJson) as number[]), this.normStats)
      );

    const trainSeqs = trainSamples.map((s) => buildSequenceFromJson(s.sequenceJson));
    const trainStatics = trainSamples.map(buildStatic);
    const trainLabels = trainSamples.map((s) => s.label as number);

    // Class-balanced weighting: up-weight the minority (positive) class.
    const posCount = trainLabels.filter((l) => l === 1).length;
    const negCount = trainLabels.length - posCount;
    const posWeight = posCount > 0 ? Math.min(negCount / posCount, MAX_CLASS_WEIGHT) : 1;

    const totalEpochs = options?.compulsory ? 20 : MAX_EPOCHS;
    const learningRate = options?.compulsory ? 0.01 : LEARNING_RATE;
    const r = await this.nativeLstm.train(
      trainSeqs,
      trainStatics,
      trainLabels,
      totalEpochs,
      learningRate,
      BATCH_SIZE,
      posWeight,
      INIT_SEED
    );
    this.nativeLstm.deserialize(r.weights);
    const result = { epochsRan: r.epochsRan, finalLoss: r.finalLoss, samples: r.samples };

    // Train-set metrics.
    let trainCorrect = 0;
    let trainLoss = 0;
    for (let i = 0; i < trainSeqs.length; i++) {
      const p = clampProb(this.nativeLstm.predict(trainSeqs[i]!, trainStatics[i]!));
      const label = trainLabels[i]!;
      trainLoss += -(label * Math.log(p) + (1 - label) * Math.log(1 - p));
      if (p >= 0.5 === label >= 0.5) trainCorrect++;
    }

    // Test-set metrics: accuracy, precision, recall, loss.
    const testSeqs = testSamples.map((s) => buildSequenceFromJson(s.sequenceJson));
    const testStatics = testSamples.map(buildStatic);
    const testLabels = testSamples.map((s) => s.label as number);
    let testCorrect = 0;
    let testLoss = 0;
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (let i = 0; i < testSeqs.length; i++) {
      const p = clampProb(this.nativeLstm.predict(testSeqs[i]!, testStatics[i]!));
      const label = testLabels[i]!;
      testLoss += -(label * Math.log(p) + (1 - label) * Math.log(1 - p));
      const pred = p >= 0.5 ? 1 : 0;
      if (pred === label) testCorrect++;
      if (pred === 1 && label === 1) tp++;
      if (pred === 1 && label === 0) fp++;
      if (pred === 0 && label === 1) fn++;
    }

    this.isTrained = true;
    // Fresh model → fresh circuit-breaker window.
    this.circuitBreaker.reset();

    const n = trainSeqs.length || 1;
    const nt = testSeqs.length || 1;
    return {
      samples: samples.length,
      trainSamples: trainSamples.length,
      testSamples: testSamples.length,
      epochsRan: result.epochsRan,
      labelBalance: posCount / (trainLabels.length || 1),
      accuracy: trainCorrect / n,
      loss: trainLoss / n,
      testAccuracy: testCorrect / nt,
      testPrecision: tp + fp > 0 ? tp / (tp + fp) : 0,
      testRecall: tp + fn > 0 ? tp / (tp + fn) : 0,
      testLoss: testLoss / nt,
    };
  }

  saveWeights(upsertKV: (key: string, val: string) => void): void {
    if (!this.lstm) return;
    upsertKV(KV_WEIGHTS, JSON.stringify(this.lstm.serialize()));
    upsertKV(
      KV_NORMSTATS,
      JSON.stringify({
        mean: Array.from(this.normStats.mean),
        std: Array.from(this.normStats.std),
      })
    );
    upsertKV(
      KV_ARCH,
      JSON.stringify({ seq: SEQ_FEATURE_DIM, hidden: HIDDEN_SIZE, static: FEATURE_DIM })
    );
    upsertKV(KV_TRAINED, this.isTrained ? '1' : '0');
  }

  loadWeights(getKV: (key: string) => string | null): boolean {
    if (!this.lstm) return false;

    const weightsJson = getKV(KV_WEIGHTS);
    const statsJson = getKV(KV_NORMSTATS);
    const archJson = getKV(KV_ARCH);
    if (!weightsJson || !statsJson) return false;

    try {
      // Reject weights trained under a different architecture.
      if (archJson) {
        const arch = JSON.parse(archJson) as { seq: number; hidden: number; static: number };
        if (
          arch.seq !== SEQ_FEATURE_DIM ||
          arch.hidden !== HIDDEN_SIZE ||
          arch.static !== FEATURE_DIM
        ) {
          return false;
        }
      }

      const flat = JSON.parse(weightsJson) as number[];
      if (!this.lstm.deserialize(flat)) return false;

      const stats = JSON.parse(statsJson) as { mean: number[]; std: number[] };
      this.normStats = {
        mean: new Float32Array(stats.mean),
        std: new Float32Array(stats.std),
      };

      this.isTrained = getKV(KV_TRAINED) === '1';
      return true;
    } catch {
      return false;
    }
  }

  getIsTrained(): boolean {
    return this.isTrained;
  }
}

function clampProb(p: number): number {
  return Math.max(1e-7, Math.min(1 - 1e-7, p));
}
