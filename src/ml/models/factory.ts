import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

export interface NativeTrainResult {
  weights: number[];
  epochsRan: number;
  finalLoss: number;
  samples: number;
}

export interface NativeLstm {
  readonly inputSize: number;
  readonly hiddenSize: number;
  readonly staticSize: number;
  predict(sequence: number[][], staticFeatures: number[]): number;
  predictTyped(seqFlat: Float64Array, seqLen: number, staticFeatures: Float64Array): number;
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

export interface NativePpoTrainResult {
  itersRan: number;
  finalAvgReward: number;
  samples: number;
}

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

export function isNativeAvailable(): boolean {
  return native !== null;
}

export function nativeLoadError(): string | null {
  return loadError;
}

export function createLstm(
  inputSize: number,
  hiddenSize: number,
  staticSize: number,
  seed: number
): NativeLstm | null {
  if (!native) return null;
  return new native.LstmNetwork(inputSize, hiddenSize, staticSize, seed);
}

export function createRlPolicy(
  stateDim: number,
  actionMin: number[],
  actionMax: number[],
  seed: number
): NativeRlPolicy | null {
  if (!native) return null;
  return new native.RlExitPolicy(stateDim, actionMin, actionMax, seed);
}

export interface InferenceLstm {
  type?: 'native' | 'ts';
  predict(sequence: number[][], staticFeatures: number[]): number;
  predictTyped?(seqFlat: Float64Array, seqLen: number, staticFeatures: Float64Array): number;
  serialize(): number[];
  deserialize(flat: number[]): boolean;
  train?(
    sequences: number[][][],
    staticFeatures: number[][],
    labels: number[],
    epochs: number,
    learningRate: number,
    batchSize: number,
    posWeight: number,
    seed: number
  ): Promise<{ weights: number[]; epochsRan: number; finalLoss: number; samples: number }>;
}

class TsLstm implements InferenceLstm {
  type?: 'ts';
  constructor(_seqDim: number, _hiddenSize: number, _staticDim: number) {}
  predict() {
    return 0.5;
  }
  serialize() {
    return [];
  }
  deserialize() {
    return true;
  }
}

export function loadModel(
  seqDim: number,
  hiddenSize: number,
  staticDim: number,
  seed: number
): InferenceLstm {
  const nativeLstm = createLstm(seqDim, hiddenSize, staticDim, seed);
  if (nativeLstm) {
    (nativeLstm as InferenceLstm).type = 'native';
    return nativeLstm as InferenceLstm;
  }
  const tsLstm = new TsLstm(seqDim, hiddenSize, staticDim);
  tsLstm.type = 'ts';
  return tsLstm;
}
