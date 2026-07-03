/**
 * Loader for the native `rust-ml-core` addon, shared by the LSTM scorer and the
 * PPO exit-parameter optimizer.
 *
 * The native `.node` binary is built out-of-band (`npm run build:rust`). If it
 * is missing or fails to load (e.g. a machine without the build), this module
 * degrades gracefully: {@link isNativeAvailable} returns false and callers fall
 * back to their non-native paths rather than crashing the bot.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

/** Metrics returned by an LSTM training run. */
export interface NativeTrainResult {
  weights: number[];
  epochsRan: number;
  finalLoss: number;
  samples: number;
}

/** Shape of the napi-generated `LstmNetwork` class. */
export interface NativeLstm {
  readonly inputSize: number;
  readonly hiddenSize: number;
  readonly staticSize: number;
  predict(sequence: number[][], staticFeatures: number[]): number;
  train(
    sequences: number[][][],
    statics: number[][],
    labels: number[],
    epochs: number,
    lr: number,
    batchSize: number,
    posWeight: number,
    seed: number
  ): Promise<NativeTrainResult>;
  serialize(): number[];
  deserialize(flat: number[]): boolean;
}

/** Metrics returned by a PPO training run. */
export interface NativePpoTrainResult {
  itersRan: number;
  finalAvgReward: number;
  samples: number;
}

/** Shape of the napi-generated `RlExitPolicy` class. */
export interface NativeRlPolicy {
  readonly actionDim: number;
  predict(state: number[]): number[];
  train(
    states: number[][],
    peakMults: number[],
    stakes: number[],
    iters: number,
    epochs: number,
    lr: number,
    clip: number,
    entropyCoef: number,
    seed: number
  ): NativePpoTrainResult;
  serialize(): number[];
  deserialize(flat: number[]): boolean;
}

interface NativeModule {
  ping(): string;
  LstmNetwork: new (
    inputSize: number,
    hiddenSize: number,
    staticSize: number,
    seed: number
  ) => NativeLstm;
  RlExitPolicy: new (
    stateDim: number,
    actionMin: number[],
    actionMax: number[],
    seed: number
  ) => NativeRlPolicy;
}

let native: NativeModule | null = null;
let loadError: string | null = null;

try {
  const require = createRequire(import.meta.url);
  const here = path.dirname(fileURLToPath(import.meta.url));
  // rust-ml-core/ lives at the repo root. Resolve it robustly across dev (tsx
  // from src/ml/), prod (compiled under dist/...), and the cwd the bot launches
  // from. The first existing candidate wins.
  const candidates = [
    path.resolve(process.cwd(), 'rust-ml-core/index.js'),
    path.resolve(here, '../../rust-ml-core/index.js'),
    path.resolve(here, '../../../rust-ml-core/index.js'),
  ];
  const addonPath = candidates.find((p) => fs.existsSync(p));
  if (!addonPath) {
    throw new Error(`rust-ml-core addon not found (looked in: ${candidates.join(', ')})`);
  }
  const mod = require(addonPath) as NativeModule;
  if (mod.ping() !== 'pong') throw new Error('unexpected ping response');
  native = mod;
} catch (err) {
  loadError = err instanceof Error ? err.message : String(err);
  native = null;
}

/** True when the native addon loaded and responded to a liveness check. */
export function isNativeAvailable(): boolean {
  return native !== null;
}

/** Human-readable reason the addon failed to load, if any. */
export function nativeLoadError(): string | null {
  return loadError;
}

/** Constructs a native LSTM, or returns null if the addon is unavailable. */
export function createLstm(
  inputSize: number,
  hiddenSize: number,
  staticSize: number,
  seed: number
): NativeLstm | null {
  if (!native) return null;
  return new native.LstmNetwork(inputSize, hiddenSize, staticSize, seed);
}

/** Constructs a native PPO exit policy, or returns null if the addon is unavailable. */
export function createRlPolicy(
  stateDim: number,
  actionMin: number[],
  actionMax: number[],
  seed: number
): NativeRlPolicy | null {
  if (!native) return null;
  return new native.RlExitPolicy(stateDim, actionMin, actionMax, seed);
}
