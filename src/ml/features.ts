import { EvaluationResult } from '#types/index.js';

export const FEATURE_DIM = 18;

export interface NormStats {
  mean: Float32Array;
  std: Float32Array;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function safeLog1p(v: number): number {
  return Math.log1p(Math.max(0, v));
}

/**
 * Extracts a fixed 18-element feature vector from a completed evaluation result.
 * Must be synchronous and zero-I/O.
 */
export function extractFeatures(evalResult: EvaluationResult): Float32Array {
  const { token, candidateScore, volatilityScaler, mintSignals, adjustedThresholds } = evalResult;

  const liquidity = Math.max(0, Number(token.liquidity ?? 0));
  const fdv = Math.max(0, Number(token.fdv ?? 0));
  const holderCount = Math.max(0, Number(token.holderCount ?? 0));
  const organicScore = clamp(Number(token.organicScore ?? 0), -30, 30);
  const buys5m = Math.max(0, Number(token.stats5m?.numBuys ?? 0));
  const sells5m = Math.max(0, Number(token.stats5m?.numSells ?? 0));
  const usdPrice = Math.max(0, Number(token.usdPrice ?? 0));

  const firstPoolCreatedAt = token.firstPool?.createdAt
    ? new Date(token.firstPool.createdAt).getTime()
    : null;
  const ageSeconds =
    firstPoolCreatedAt != null && Number.isFinite(firstPoolCreatedAt)
      ? Math.max(0, (Date.now() - firstPoolCreatedAt) / 1000)
      : 0;

  const socialLinks = (token.website ? 1 : 0) + (token.twitter ? 1 : 0) + (token.telegram ? 1 : 0);

  // Derive momentum from priceHistory if available (currentPrice / firstPrice)
  let momentum = 1.0;
  const ph = token.priceHistory;
  if (Array.isArray(ph) && ph.length >= 2) {
    const startP = ph[0]?.price ?? 0;
    const endP = ph[ph.length - 1]?.price ?? 0;
    if (startP > 0 && endP > 0) {
      momentum = clamp(endP / startP, 0, 10);
    }
  }

  // Consistency ratio: fraction of price steps that were positive
  let consistencyRatio = 0.5;
  if (Array.isArray(ph) && ph.length >= 3) {
    let green = 0;
    for (let i = 1; i < ph.length; i++) {
      if ((ph[i]?.price ?? 0) > (ph[i - 1]?.price ?? 0)) green++;
    }
    consistencyRatio = green / (ph.length - 1);
  }

  // FDV per holder — a concentration signal: high value means few holders relative to market cap
  const fdvPerHolder = safeLog1p(holderCount > 0 ? fdv / holderCount : fdv);

  const fdvToLiquidity = liquidity > 0 ? clamp(fdv / liquidity / 100, 0, 1) : 1;

  const sellRatio = clamp(sells5m / Math.max(1, buys5m), 0, 5);

  // Stability factor: last-segment growth / first-segment growth from price history
  let stabilityFactor = 1.0;
  if (Array.isArray(ph) && ph.length >= 6) {
    const mid = Math.floor(ph.length / 2);
    const p0 = ph[0]?.price ?? 0;
    const pMid = ph[mid]?.price ?? 0;
    const pEnd = ph[ph.length - 1]?.price ?? 0;
    const growthFirst = p0 > 0 ? (pMid - p0) / p0 : 0;
    const growthLast = pMid > 0 ? (pEnd - pMid) / pMid : 0;
    if (growthFirst > 0.01) {
      stabilityFactor = clamp(growthLast / growthFirst, 0, 3);
    }
  }

  const top5Share = mintSignals ? clamp(mintSignals.top5Share, 0, 1) : 0;
  const isVerified = token.isVerified ? 1.0 : 0.0;

  // Suppress unused variable warning — adjustedThresholds is intentionally available
  void adjustedThresholds;

  const raw = new Float32Array(FEATURE_DIM);
  raw[0] = safeLog1p(liquidity);
  raw[1] = safeLog1p(fdv);
  raw[2] = safeLog1p(holderCount);
  raw[3] = organicScore;
  raw[4] = safeLog1p(buys5m);
  raw[5] = sellRatio;
  raw[6] = safeLog1p(usdPrice * 1e9);
  raw[7] = ageSeconds / 3600;
  raw[8] = socialLinks / 3;
  raw[9] = candidateScore / 100;
  raw[10] = clamp(volatilityScaler, 0, 2);
  raw[11] = momentum;
  raw[12] = consistencyRatio;
  raw[13] = fdvPerHolder;
  raw[14] = fdvToLiquidity;
  raw[15] = clamp(stabilityFactor, 0, 3);
  raw[16] = top5Share;
  raw[17] = isVerified;

  return raw;
}

/**
 * Z-score normalization using precomputed mean/std per feature.
 * Features with std ≈ 0 are left unchanged to avoid division by zero.
 */
export function normalizeFeatures(raw: Float32Array, stats: NormStats): Float32Array {
  const out = new Float32Array(FEATURE_DIM);
  for (let i = 0; i < FEATURE_DIM; i++) {
    const s = f32Get(stats.std, i);
    const m = f32Get(stats.mean, i);
    const r = f32Get(raw, i);
    f32Set(out, i, s > 1e-8 ? (r - m) / s : r);
  }
  return out;
}

/**
 * Computes mean and std across a collection of raw feature vectors.
 * Requires at least 2 samples; returns zero-mean unit-std stats if fewer.
 */
function f32Get(arr: Float32Array, i: number): number {
  return (arr as unknown as number[])[i] ?? 0;
}

function f32Set(arr: Float32Array, i: number, v: number): void {
  (arr as unknown as number[])[i] = v;
}

export function computeNormStats(samples: Float32Array[]): NormStats {
  const mean = new Float32Array(FEATURE_DIM);
  // Variance accumulator must start at 0; fill(1) would add a +1 bias to every
  // variance term, inflating std and corrupting all z-scores.
  const std = new Float32Array(FEATURE_DIM);

  if (samples.length < 2) {
    std.fill(1); // unit std when we have no variance estimate
    return { mean, std };
  }

  for (const s of samples) {
    for (let i = 0; i < FEATURE_DIM; i++) {
      f32Set(mean, i, f32Get(mean, i) + f32Get(s, i) / samples.length);
    }
  }

  for (const s of samples) {
    for (let i = 0; i < FEATURE_DIM; i++) {
      const diff = f32Get(s, i) - f32Get(mean, i);
      f32Set(std, i, f32Get(std, i) + (diff * diff) / (samples.length - 1));
    }
  }

  for (let i = 0; i < FEATURE_DIM; i++) {
    const v = Math.sqrt(f32Get(std, i));
    f32Set(std, i, v < 1e-8 ? 1 : v);
  }

  return { mean, std };
}
