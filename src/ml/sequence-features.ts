/**
 * Sequence feature extraction for the LSTM entry scorer.
 *
 * The LSTM consumes the *pre-entry* price history of a token — the price curve
 * we can observe at the moment we decide whether to enter. The same history is
 * available both at inference (the live evaluation result) and at training time
 * (persisted on each training sample), so there is no train/serve skew.
 *
 * Each timestep is reduced to a small, already-bounded feature vector so the
 * network sees momentum/shape rather than absolute price magnitudes.
 */

/** Per-timestep feature dimension produced by {@link buildSequence}. */
export const SEQ_FEATURE_DIM = 4;

/** Cap on sequence length fed to the LSTM (bounds BPTT cost). Keeps the most recent steps. */
export const MAX_SEQ_STEPS = 32;

export interface PricePoint {
  price: number;
  timestamp: number;
}

/**
 * Builds a `[steps, SEQ_FEATURE_DIM]` matrix from a raw price history.
 *
 * Features per step:
 *   0. step log-return       ln(p_t / p_{t-1})           (0 at first step)
 *   1. cumulative log-return ln(p_t / p_0)               (0 at first step)
 *   2. drawdown from peak    (peak_t - p_t) / peak_t     in [0, 1]
 *   3. normalized elapsed t  (ts_t - ts_0)/(ts_N - ts_0) in [0, 1]
 *
 * Invalid/non-positive prices are dropped. Returns `[]` for empty/degenerate
 * input — the network treats an empty sequence as "no temporal context".
 */
export function buildSequence(history: PricePoint[] | undefined | null): number[][] {
  if (!Array.isArray(history) || history.length === 0) return [];

  // Keep only valid points, then the most recent MAX_SEQ_STEPS.
  const points = history.filter(
    (p) => p && Number.isFinite(p.price) && p.price > 0 && Number.isFinite(p.timestamp)
  );
  if (points.length === 0) return [];
  const trimmed =
    points.length > MAX_SEQ_STEPS ? points.slice(points.length - MAX_SEQ_STEPS) : points;

  const p0 = trimmed[0]!.price;
  const t0 = trimmed[0]!.timestamp;
  const tSpan = trimmed[trimmed.length - 1]!.timestamp - t0;

  const out: number[][] = [];
  let peak = p0;
  let prev = p0;
  for (let i = 0; i < trimmed.length; i++) {
    const p = trimmed[i]!.price;
    if (p > peak) peak = p;
    const stepReturn = i === 0 ? 0 : Math.log(p / prev);
    const cumReturn = Math.log(p / p0);
    const drawdown = peak > 0 ? (peak - p) / peak : 0;
    const normTime =
      tSpan > 0 ? (trimmed[i]!.timestamp - t0) / tSpan : i / Math.max(1, trimmed.length - 1);
    out.push([stepReturn, cumReturn, drawdown, normTime]);
    prev = p;
  }
  return out;
}

/** Parses a persisted `sequenceJson` (raw price history) into an LSTM input matrix. */
export function buildSequenceFromJson(sequenceJson: string | undefined | null): number[][] {
  if (!sequenceJson) return [];
  try {
    const parsed = JSON.parse(sequenceJson) as PricePoint[];
    return buildSequence(parsed);
  } catch {
    return [];
  }
}
