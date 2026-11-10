import path from 'node:path';
import fs from 'node:fs';
import yaml from 'js-yaml';
import {
  ScoringConfig,
  ScoringWeights,
  MoodThresholds,
  MomentumFilters,
  MomentumScoring,
  TapeSignalWeights,
} from '#types/scoring.js';
import { safeConsole } from './utils.js';

const SCORING_DIR = path.resolve(process.cwd(), 'strategies');

const DEFAULT_SCORING: ScoringConfig = {
  scoringWeights: {
    socialLinkHigh: 15,
    socialLinkLow: 5,
    isVerified: 5,
    organicScoreClamp: 20,
    liquidityRatioHigh: 10,
    liquidityRatioLow: 5,
    holderCountHigh: 5,
    buyPressureBonus: 5,
    suspiciousAuditPenalty: 5,
    volFdvHigh: 5,
    volFdvMid: 3,
    volFdvLow: -3,
  },
  tapeSignals: {
    windowSeconds: 60,
    minTrades: 3,
    liquidityVelocityMax: 6,
    liquidityVelocityFullSolPerSec: 0.1,
    uniqueBuyersMax: 4,
    uniqueBuyersFull: 8,
    washPenalty: 0,
    washWindowSeconds: 10,
    copycatPenalty: 8,
  },
  moodThresholds: {
    winRateCritical: 0.2,
    winRateCautious: 0.4,
    sizeMultiplierCautious: 0.5,
    windowLarge: 10,
    windowSmall: 5,
  },
  momentumFilters: {
    minAccelerationFactor: 0.3,
    minBuysFirstHalf: 5,
    buyVelocityDecayFactor: 0.4,
    maxExhaustionRangePct: 1.6,
    minMomentumConsistency: 0.6,
  },
  momentumScoring: {
    imbalanceMax: 5,
    accelMax: 4,
    trajectoryMax: 5,
    min: -10,
    max: 12,
    growthBandPct: 0.3,
  },
};

function validateScoringConfig(config: ScoringConfig): void {
  const errors: string[] = [];

  const numericFields: Array<{ obj: Record<string, unknown>; name: string }> = [
    { obj: config.scoringWeights as unknown as Record<string, unknown>, name: 'scoringWeights' },
    { obj: config.tapeSignals as unknown as Record<string, unknown>, name: 'tapeSignals' },
    { obj: config.moodThresholds as unknown as Record<string, unknown>, name: 'moodThresholds' },
    { obj: config.momentumFilters as unknown as Record<string, unknown>, name: 'momentumFilters' },
    { obj: config.momentumScoring as unknown as Record<string, unknown>, name: 'momentumScoring' },
  ];

  for (const { obj, name } of numericFields) {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${name}.${key} must be a finite number.`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Scoring config validation failed:\n- ${errors.join('\n- ')}`);
  }
}

export function loadScoringConfig(): ScoringConfig {
  const scoringPath = path.join(SCORING_DIR, 'scoring.yaml');
  try {
    if (!fs.existsSync(scoringPath)) return DEFAULT_SCORING;

    const content = fs.readFileSync(scoringPath, 'utf8');
    const parsed = yaml.load(content) as Partial<ScoringConfig>;

    const config: ScoringConfig = {
      scoringWeights: { ...DEFAULT_SCORING.scoringWeights, ...parsed.scoringWeights },
      tapeSignals: { ...DEFAULT_SCORING.tapeSignals, ...parsed.tapeSignals },
      moodThresholds: { ...DEFAULT_SCORING.moodThresholds, ...parsed.moodThresholds },
      momentumFilters: { ...DEFAULT_SCORING.momentumFilters, ...parsed.momentumFilters },
      momentumScoring: { ...DEFAULT_SCORING.momentumScoring, ...parsed.momentumScoring },
    };

    validateScoringConfig(config);
    return config;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    safeConsole('error', `[CONFIG] Failed to load scoring config: ${message}`);
    return DEFAULT_SCORING;
  }
}

const scoringConfig = loadScoringConfig();

export const SCORING_WEIGHTS: ScoringWeights = scoringConfig.scoringWeights;
export const TAPE_SIGNALS: TapeSignalWeights = scoringConfig.tapeSignals;
export const MOOD_THRESHOLDS: MoodThresholds = scoringConfig.moodThresholds;
export const MOMENTUM_FILTERS: MomentumFilters = scoringConfig.momentumFilters;
export const MOMENTUM_SCORING: MomentumScoring = scoringConfig.momentumScoring;
