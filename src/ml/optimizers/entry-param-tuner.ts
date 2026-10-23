import { Config, TrainingSample } from '#types/index.js';
import { ParamSpec } from './exit-param-tuner.js';

export const ENTRY_PARAM_SPECS: ParamSpec[] = [
  {
    key: 'minHolderCount',
    min: 3,
    max: 25,
    delta: 1,
    learningRate: 0.02,
    maxStep: 1,
    integer: true,
  },
  { key: 'minCandidateScore', min: 55, max: 85, delta: 1, learningRate: 0.02, maxStep: 1 },
  { key: 'minLiquidityUsd', min: 100, max: 2000, delta: 25, learningRate: 0.5, maxStep: 25 },
  { key: 'minOrganicScore', min: -10, max: 20, delta: 1, learningRate: 0.1, maxStep: 1 },
  { key: 'maxFdvToLiquidity', min: 0.5, max: 3.0, delta: 0.1, learningRate: 0.05, maxStep: 0.1 },
  {
    key: 'minSurvivalMomentum',
    min: 1.0,
    max: 1.5,
    delta: 0.05,
    learningRate: 0.02,
    maxStep: 0.05,
  },
  {
    key: 'minBreakoutMultiplier',
    min: 1.0,
    max: 1.5,
    delta: 0.05,
    learningRate: 0.02,
    maxStep: 0.05,
  },
];

export function extractCurrentEntryParams(config: Config): Record<string, number> {
  return {
    minHolderCount: config.minHolderCount,
    minCandidateScore: config.minCandidateScore,
    minLiquidityUsd: config.minLiquidityUsd,
    minOrganicScore: config.minOrganicScore,
    maxFdvToLiquidity: config.maxFdvToLiquidity,
    minSurvivalMomentum: config.minSurvivalMomentum,
    minBreakoutMultiplier: config.minBreakoutMultiplier,
  };
}

export function decodeEntryFeatures(featuresJson: string): {
  holderCount: number;
  liquidityUsd: number;
  organicScore: number;
  fdvToLiquidity: number;
  momentum: number;
} | null {
  try {
    const raw = JSON.parse(featuresJson) as number[];
    const liquidityUsd = Math.max(0, Math.expm1(raw[0] ?? 0));
    const holderCount = Math.max(0, Math.round(Math.expm1(raw[2] ?? 0)));
    const organicScore = raw[3] ?? 0;
    const momentum = raw[11] ?? 1.0;
    const fdvToLiquidity = raw[14] ?? 1.0;
    return { holderCount, liquidityUsd, organicScore, fdvToLiquidity, momentum };
  } catch {
    return null;
  }
}

export function replayEntryNetPnl(
  samples: TrainingSample[],
  params: Record<string, number>
): number {
  const minHolders = params['minHolderCount'] ?? 0;
  const minScore = params['minCandidateScore'] ?? 0;
  const minLiq = params['minLiquidityUsd'] ?? 0;
  const minOrganic = params['minOrganicScore'] ?? -100;
  const maxFdvToLiq = params['maxFdvToLiquidity'] ?? 100;
  const minSurvivalMom = params['minSurvivalMomentum'] ?? 0;
  const minBreakoutMom = params['minBreakoutMultiplier'] ?? 0;

  let total = 0;
  for (const s of samples) {
    if (s.entryScore < minScore) continue;
    const decoded = decodeEntryFeatures(s.featuresJson);
    if (!decoded) continue;
    if (decoded.holderCount < minHolders) continue;
    if (decoded.liquidityUsd < minLiq) continue;
    if (decoded.organicScore < minOrganic) continue;
    // maxFdvToLiquidity is fdv/liquidity/100 clamped 0..1 (features.ts:61). Guard scale.
    if (decoded.fdvToLiquidity > maxFdvToLiq) continue;
    if (decoded.momentum < minSurvivalMom) continue;
    if (decoded.momentum < minBreakoutMom) continue;
    total += s.realizedPnlUsd;
  }
  return total;
}

export function isTighteningMove(key: string, before: number, after: number): boolean {
  // tightening = fewer trades pass. For maxFdvToLiquidity lower is tighter.
  if (key === 'maxFdvToLiquidity') return after < before;
  return after > before;
}

export function estimateEntryGradients(
  samples: TrainingSample[],
  current: Record<string, number>,
  specs: ParamSpec[]
): Record<string, number> {
  const gradients: Record<string, number> = {};
  for (const spec of specs) {
    const lo = { ...current, [spec.key]: (current[spec.key] ?? 0) - spec.delta };
    const hi = { ...current, [spec.key]: (current[spec.key] ?? 0) + spec.delta };
    gradients[spec.key] =
      (replayEntryNetPnl(samples, hi) - replayEntryNetPnl(samples, lo)) / (2 * spec.delta);
  }
  return gradients;
}
