/**
 * Pure-TypeScript LSTM forward pass — inference only, no training.
 *
 * Implements the same architecture as rust-ml-core/src/lstm.rs and produces
 * identical output for the same weights. Used as a fallback when the Rust
 * N-API addon is unavailable so ML gating remains active from pre-trained
 * weights even if the addon was never compiled.
 *
 * Weight serialization layout (matches Rust serialize() / deserialize()):
 *   wf (H*G) | wi (H*G) | wg (H*G) | wo (H*G)
 *   bf (H)   | bi (H)   | bg (H)   | bo (H)
 *   wd (H+S) | bd (1 scalar)
 * where G = inputSize + hiddenSize, H = hiddenSize, S = staticSize.
 */

export interface InferenceLstm {
  readonly inputSize: number;
  readonly hiddenSize: number;
  readonly staticSize: number;
  predict(sequence: number[][], staticFeatures: number[]): number;
  serialize(): number[];
  deserialize(flat: number[]): boolean;
}

function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

export class TsLstm implements InferenceLstm {
  readonly inputSize: number;
  readonly hiddenSize: number;
  readonly staticSize: number;

  private readonly gateIn: number;
  private wf: Float64Array;
  private wi: Float64Array;
  private wg: Float64Array;
  private wo: Float64Array;
  private bf: Float64Array;
  private bi: Float64Array;
  private bg: Float64Array;
  private bo: Float64Array;
  private wd: Float64Array;
  private bd = 0;

  constructor(inputSize: number, hiddenSize: number, staticSize: number) {
    this.inputSize = inputSize;
    this.hiddenSize = hiddenSize;
    this.staticSize = staticSize;
    this.gateIn = inputSize + hiddenSize;

    const gLen = hiddenSize * this.gateIn;
    this.wf = new Float64Array(gLen);
    this.wi = new Float64Array(gLen);
    this.wg = new Float64Array(gLen);
    this.wo = new Float64Array(gLen);
    this.bf = new Float64Array(hiddenSize);
    this.bi = new Float64Array(hiddenSize);
    this.bg = new Float64Array(hiddenSize);
    this.bo = new Float64Array(hiddenSize);
    this.wd = new Float64Array(hiddenSize + staticSize);
  }

  predict(sequence: number[][], staticFeatures: number[]): number {
    const H = this.hiddenSize;
    const G = this.gateIn;
    const h = new Float64Array(H);
    const c = new Float64Array(H);
    const z = new Float64Array(G);

    for (const x of sequence) {
      for (let k = 0; k < this.inputSize; k++) z[k] = x[k] ?? 0;
      for (let k = 0; k < H; k++) z[this.inputSize + k] = h[k]!;

      for (let n = 0; n < H; n++) {
        const base = n * G;
        let pf = this.bf[n]!;
        let pi = this.bi[n]!;
        let pg = this.bg[n]!;
        let po = this.bo[n]!;
        for (let k = 0; k < G; k++) {
          const zk = z[k]!;
          pf += this.wf[base + k]! * zk;
          pi += this.wi[base + k]! * zk;
          pg += this.wg[base + k]! * zk;
          po += this.wo[base + k]! * zk;
        }
        const f = sigmoid(pf);
        const i = sigmoid(pi);
        const g = Math.tanh(pg);
        const o = sigmoid(po);
        c[n] = f * c[n]! + i * g;
        h[n] = o * Math.tanh(c[n]!);
      }
    }

    // Dense head: [h_T ; static] → logit → sigmoid
    let logit = this.bd;
    for (let k = 0; k < H; k++) logit += this.wd[k]! * h[k]!;
    for (let k = 0; k < this.staticSize; k++) {
      logit += this.wd[H + k]! * (staticFeatures[k] ?? 0);
    }
    return sigmoid(logit);
  }

  serialize(): number[] {
    const out: number[] = [];
    for (const v of [
      this.wf,
      this.wi,
      this.wg,
      this.wo,
      this.bf,
      this.bi,
      this.bg,
      this.bo,
      this.wd,
    ]) {
      for (let i = 0; i < v.length; i++) out.push(v[i]!);
    }
    out.push(this.bd);
    return out;
  }

  deserialize(flat: number[]): boolean {
    if (flat.length !== this.serializedLen()) return false;
    let idx = 0;
    const take = (dst: Float64Array) => {
      for (let i = 0; i < dst.length; i++) dst[i] = flat[idx++]!;
    };
    take(this.wf);
    take(this.wi);
    take(this.wg);
    take(this.wo);
    take(this.bf);
    take(this.bi);
    take(this.bg);
    take(this.bo);
    take(this.wd);
    this.bd = flat[idx]!;
    return true;
  }

  private serializedLen(): number {
    return 4 * this.wf.length + 4 * this.hiddenSize + this.wd.length + 1;
  }
}
