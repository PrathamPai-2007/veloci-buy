import { MlScoreResult, TrainingSample } from '#types/index.js';
import { FEATURE_DIM, NormStats, computeNormStats, normalizeFeatures } from './features.js';
import { SEQ_FEATURE_DIM, buildSequenceFromJson } from './sequence-features.js';
import { CircuitBreaker, confidenceToTpProfile } from './gating.js';
import { loadModel, InferenceLstm } from './models/factory.js';

const HIDDEN_SIZE = 16;
const INIT_SEED = 1337;
const MAX_EPOCHS = 20;
const BATCH_SIZE = 16;
const LEARNING_RATE = 0.01;
const TEST_FRACTION = 0.2;
const MAX_CLASS_WEIGHT = 10;

const KV_WEIGHTS = 'ml:lstm_weights';
const KV_NORMSTATS = 'ml:normstats';
const KV_ARCH = 'ml:lstm_arch';
const KV_TRAINED = 'ml:trained';

export interface TrainMetrics {
  samples: number;
  trainSamples: number;
  testSamples: number;
  epochsRan: number;
  labelBalance: number;
  accuracy: number;
  loss: number;
  testAccuracy: number;
  testPrecision: number;
  testRecall: number;
  testLoss: number;
}

function clampProb(p: number): number {
  return Math.max(1e-7, Math.min(1 - 1e-7, p));
}

export type EnsembleBucket = 'pumpfun' | 'raydium' | 'default';
const DEX_BUCKETS: EnsembleBucket[] = ['pumpfun', 'raydium'];

export function bucketFor(launchpad: string | null | undefined): EnsembleBucket {
  const s = (launchpad ?? '').toLowerCase();
  if (s.includes('pump')) return 'pumpfun';
  if (s.includes('ray')) return 'raydium';
  return 'default';
}

class InternalScoringModel {
  private lstm: InferenceLstm;
  private normStats: NormStats;
  private isTrained = false;
  private _lastBestThresh = 0.5;
  get bestThreshold(): number {
    return this._lastBestThresh;
  }

  constructor(private readonly minSamples: number) {
    this.lstm = loadModel(SEQ_FEATURE_DIM, HIDDEN_SIZE, FEATURE_DIM, INIT_SEED);
    this.normStats = {
      mean: new Float32Array(FEATURE_DIM).fill(0),
      std: new Float32Array(FEATURE_DIM).fill(1),
    };
  }

  nativeAvailable(): boolean {
    return this.lstm.type === 'native';
  }

  tsFallbackActive(): boolean {
    return this.lstm.type === 'ts' && this.isTrained;
  }

  getIsTrained(): boolean {
    return this.isTrained;
  }

  predictConfidence(features: Float32Array, sequence: number[][]): number | null {
    if (!this.isTrained || this.lstm.type !== 'native') return null;
    const normalized = normalizeFeatures(features, this.normStats);

    // Flatten sequence into zero-copy Float64Array for Rust predictTyped FFI
    const inputSize = sequence[0]?.length ?? 0;
    const seqLen = sequence.length;
    const seqFlat = new Float64Array(seqLen * inputSize);
    for (let i = 0; i < seqLen; i++) {
      seqFlat.set(sequence[i]!, i * inputSize);
    }
    const staticFlat = new Float64Array(normalized);

    if (typeof this.lstm.predictTyped === 'function') {
      return this.lstm.predictTyped(seqFlat, seqLen, staticFlat);
    }
    return this.lstm.predict(sequence, Array.from(normalized));
  }

  async train(
    samples: TrainingSample[],
    options?: { compulsory?: boolean }
  ): Promise<TrainMetrics | null> {
    if (this.lstm.type !== 'native') return null;
    if (samples.length < (options?.compulsory ? 1 : this.minSamples)) return null;

    const sorted = [...samples].sort((a, b) => a.closedAt.localeCompare(b.closedAt));
    const testCount =
      options?.compulsory && sorted.length <= 2
        ? 0
        : Math.max(1, Math.floor(sorted.length * TEST_FRACTION));
    const trainSamples = sorted.slice(0, sorted.length - testCount);
    const testSamples = sorted.slice(sorted.length - testCount);
    if (trainSamples.length < (options?.compulsory ? 1 : this.minSamples)) return null;

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

    const posCount = trainLabels.filter((l) => l === 1).length;
    const negCount = trainLabels.length - posCount;
    const posWeight = posCount > 0 ? Math.min(negCount / posCount, MAX_CLASS_WEIGHT) : 1;

    const totalEpochs = options?.compulsory ? 20 : MAX_EPOCHS;
    const learningRate = options?.compulsory ? 0.01 : LEARNING_RATE;
    const r = await this.lstm.train!(
      trainSeqs,
      trainStatics,
      trainLabels,
      totalEpochs,
      learningRate,
      BATCH_SIZE,
      posWeight,
      INIT_SEED
    );
    this.lstm.deserialize(r.weights);

    let trainCorrect = 0,
      trainLoss = 0;
    for (let i = 0; i < trainSeqs.length; i++) {
      const p = clampProb(this.lstm.predict(trainSeqs[i]!, trainStatics[i]!));
      const label = trainLabels[i]!;
      trainLoss += -(label * Math.log(p) + (1 - label) * Math.log(1 - p));
      if (p >= 0.5 === label >= 0.5) trainCorrect++;
    }

    const testSeqs = testSamples.map((s) => buildSequenceFromJson(s.sequenceJson));
    const testStatics = testSamples.map(buildStatic);
    const testLabels = testSamples.map((s) => s.label as number);
    let testCorrect = 0,
      testLoss = 0,
      tp = 0,
      fp = 0,
      fn = 0;
    for (let i = 0; i < testSeqs.length; i++) {
      const p = clampProb(this.lstm.predict(testSeqs[i]!, testStatics[i]!));
      const label = testLabels[i]!;
      testLoss += -(label * Math.log(p) + (1 - label) * Math.log(1 - p));
      const pred = p >= 0.5 ? 1 : 0;
      if (pred === label) testCorrect++;
      if (pred === 1 && label === 1) tp++;
      if (pred === 1 && label === 0) fp++;
      if (pred === 0 && label === 1) fn++;
    }
    // Best-threshold sweep for diagnostics (F1-max on holdout) — logged but not yet gating
    let bestF1 = -1;
    let bestThresh = 0.5;
    for (let thr = 0.15; thr <= 0.85; thr += 0.05) {
      let tpT = 0,
        fpT = 0,
        fnT = 0;
      for (let i = 0; i < testSeqs.length; i++) {
        const p = clampProb(this.lstm.predict(testSeqs[i]!, testStatics[i]!));
        const pred = p >= thr ? 1 : 0;
        const label = testLabels[i]!;
        if (pred === 1 && label === 1) tpT++;
        if (pred === 1 && label === 0) fpT++;
        if (pred === 0 && label === 1) fnT++;
      }
      const precT = tpT + fpT > 0 ? tpT / (tpT + fpT) : 0;
      const recT = tpT + fnT > 0 ? tpT / (tpT + fnT) : 0;
      const f1T = precT + recT > 0 ? (2 * precT * recT) / (precT + recT) : 0;
      if (f1T > bestF1) {
        bestF1 = f1T;
        bestThresh = thr;
      }
    }
    this._lastBestThresh = Math.round(bestThresh * 100) / 100;

    this.isTrained = true;
    const n = trainSeqs.length || 1;
    const nt = testSeqs.length || 1;
    return {
      samples: samples.length,
      trainSamples: trainSamples.length,
      testSamples: testSamples.length,
      epochsRan: r.epochsRan,
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
    upsertKV(KV_WEIGHTS, JSON.stringify(this.lstm.serialize()));
    upsertKV(
      KV_NORMSTATS,
      JSON.stringify({ mean: Array.from(this.normStats.mean), std: Array.from(this.normStats.std) })
    );
    upsertKV(
      KV_ARCH,
      JSON.stringify({ seq: SEQ_FEATURE_DIM, hidden: HIDDEN_SIZE, static: FEATURE_DIM })
    );
    upsertKV(KV_TRAINED, this.isTrained ? '1' : '0');
  }

  loadWeights(getKV: (key: string) => string | null): boolean {
    const weightsJson = getKV(KV_WEIGHTS),
      statsJson = getKV(KV_NORMSTATS),
      archJson = getKV(KV_ARCH);
    if (!weightsJson || !statsJson) return false;
    try {
      if (archJson) {
        const arch = JSON.parse(archJson) as { seq: number; hidden: number; static: number };
        if (
          arch.seq !== SEQ_FEATURE_DIM ||
          arch.hidden !== HIDDEN_SIZE ||
          arch.static !== FEATURE_DIM
        )
          return false;
      }
      const flat = JSON.parse(weightsJson) as number[];
      if (!this.lstm.deserialize(flat)) return false;
      const stats = JSON.parse(statsJson) as { mean: number[]; std: number[] };
      this.normStats = { mean: new Float32Array(stats.mean), std: new Float32Array(stats.std) };
      this.isTrained = getKV(KV_TRAINED) === '1';
      return true;
    } catch {
      return false;
    }
  }
}

export class ModelBucket {
  private readonly models: Record<EnsembleBucket, InternalScoringModel>;
  private circuitBreaker = new CircuitBreaker();

  constructor(minSamples: number) {
    this.models = {
      default: new InternalScoringModel(minSamples),
      pumpfun: new InternalScoringModel(minSamples),
      raydium: new InternalScoringModel(minSamples),
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

    if (confidences.length === 0)
      return { confidence: 0.5, tpProfile: 'standard', shadowMode: true, blocked: false };

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

  async train(
    samples: TrainingSample[],
    options?: { compulsory?: boolean }
  ): Promise<TrainMetrics | null> {
    const generalMetrics = await this.models.default.train(samples, options);
    for (const bucket of DEX_BUCKETS) {
      const subset = samples.filter((s) => bucketFor(s.launchpad) === bucket);
      if (subset.length > 0) await this.models[bucket].train(subset, options);
    }
    this.circuitBreaker.reset();
    return generalMetrics;
  }

  saveWeights(upsertKV: (key: string, val: string) => void): void {
    for (const bucket of Object.keys(this.models) as EnsembleBucket[]) {
      this.models[bucket].saveWeights((k, v) => upsertKV(`ens:${bucket}:${k}`, v));
    }
  }

  loadWeights(getKV: (key: string) => string | null): boolean {
    let any = false;
    for (const bucket of Object.keys(this.models) as EnsembleBucket[]) {
      if (this.models[bucket].loadWeights((k) => getKV(`ens:${bucket}:${k}`))) any = true;
    }
    return any;
  }
}
