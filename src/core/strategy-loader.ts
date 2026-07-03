import path from 'node:path';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { PresetStrategy } from '../types/index.js';
import { safeConsole } from './utils.js';

/**
 * The default trading strategy configuration used if no custom strategy is specified.
 */
export const DEFAULT_STRATEGY: PresetStrategy = {
  name: 'Standard Aggressive',
  description: 'Standard balanced strategy for mid-cap Solana memecoins',
  minLiquidityUsd: 300,
  minHolderCount: 5,
  maxRecheckAttempts: 2,
  minCandidateScore: 75,
  minMarketCapUsd: 1000,
  stopLossPct: 0.15,
  takeProfitMultiples: [1.3, 2.1],
  takeProfitMultiplesHigh: [1.24, 2.0],
  takeProfitFractions: [0.75, 0.6],
  trailingStopDrawdownPct: 0.15,
  maxHoldMinutes: 20,
  holdDurationHighConfidenceMinutes: 30,
  survivalDelaySeconds: 20,
  maxOpenPositions: 5,
  minSurvivalMomentum: 1.05,
  minBreakoutMultiplier: 1.05,
  maxPriceDumpPct: 18,
  maxSurvivalGrowthPct: 450,
  maxSellPressureIncreasePct: 110,
  maxAuditTopHoldersPct: 66,
  minMomentumConsistency: 0.65,
  minAccelerationFactor: 0.3,
  maxConcurrentAudits: 20,
  scanParallelismLight: 8,
  scanParallelismHeavy: 3,
  ownerAuditParallelism: 2,
  priceFallbackParallelism: 6,
  parallelismMinFactor: 0.55,
  errorRateWindow: 30,
  backpressureErrorRateThreshold: 0.22,
  mintSignalMaxAttempts: 2,
  mintSignalRetryDelayMs: 500,
  rpcIndexingRetryDelayMs: 5_000,
  mlScoreGateThreshold: 0.35,
  mlScoreWeight: 0.3,
  breakEvenStopTriggerMultiple: 1.06,
  breakEvenStopFloorPct: 0.04,
};

/**
 * Validates a strategy object for correctness and safety.
 * @param strategy - The strategy object to validate.
 */
export function validateStrategy(strategy: PresetStrategy): void {
  const errors: string[] = [];

  if (
    !Number.isFinite(strategy.stopLossPct) ||
    strategy.stopLossPct <= 0 ||
    strategy.stopLossPct >= 1
  ) {
    errors.push('stopLossPct must be between 0 and 1 (exclusive).');
  }

  if (
    !Array.isArray(strategy.takeProfitMultiples) ||
    strategy.takeProfitMultiples.length === 0 ||
    strategy.takeProfitMultiples.some((v) => !Number.isFinite(v) || v <= 1)
  ) {
    errors.push('takeProfitMultiples must contain one or more values greater than 1.');
  }

  const positiveFields: Array<keyof PresetStrategy> = [
    'minLiquidityUsd',
    'minHolderCount',
    'maxRecheckAttempts',
    'minCandidateScore',
    'minMarketCapUsd',
    'survivalDelaySeconds',
    'maxOpenPositions',
    'minSurvivalMomentum',
    'minBreakoutMultiplier',
    'maxPriceDumpPct',
    'maxSurvivalGrowthPct',
    'maxSellPressureIncreasePct',
    'maxAuditTopHoldersPct',
    'minMomentumConsistency',
    'minAccelerationFactor',
    'maxConcurrentAudits',
    'scanParallelismLight',
    'scanParallelismHeavy',
    'ownerAuditParallelism',
    'priceFallbackParallelism',
    'mintSignalMaxAttempts',
    'mintSignalRetryDelayMs',
    'rpcIndexingRetryDelayMs',
    'mlScoreGateThreshold',
    'mlScoreWeight',
    'burstSurvivalSeconds',
    'burstMinMomentum',
    'burstMaxEntryDrawdownPct',
    'burstMinBuySellRatio',
    'burstTrailingDrawdownPct',
    'burstMaxHoldMinutes',
    'breakEvenStopTriggerMultiple',
    'breakEvenStopFloorPct',
  ];

  for (const field of positiveFields) {
    const value = strategy[field];
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) {
      errors.push(`${String(field)} must be a non-negative number.`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Strategy validation failed:\n- ${errors.join('\n- ')}`);
  }
}

/**
 * Loads a strategy from the strategies/ directory.
 * @param name - The name of the strategy (filename without .yaml).
 */
export function loadStrategy(name: string): PresetStrategy {
  const strategyPath = path.resolve(process.cwd(), 'strategies', `${name}.yaml`);
  let strategy: PresetStrategy;

  if (!fs.existsSync(strategyPath)) {
    if (name === 'standard') {
      strategy = DEFAULT_STRATEGY;
    } else {
      safeConsole(
        'error',
        `[CONFIG] Strategy file not found: ${strategyPath}. Falling back to standard.`
      );
      strategy = loadStrategy('standard');
    }
  } else {
    try {
      const content = fs.readFileSync(strategyPath, 'utf8');
      const parsed = yaml.load(content) as Partial<PresetStrategy>;
      strategy = { ...DEFAULT_STRATEGY, ...parsed };
    } catch (err: unknown) {
      safeConsole(
        'error',
        `[CONFIG] Failed to parse strategy file ${strategyPath}: ${err instanceof Error ? err.message : String(err)}`
      );
      strategy = DEFAULT_STRATEGY;
    }
  }

  try {
    validateStrategy(strategy);
  } catch (err: unknown) {
    safeConsole(
      'error',
      `[CONFIG] Strategy validation failed for "${name}": ${err instanceof Error ? err.message : String(err)}`
    );
    if (name !== 'standard') {
      return loadStrategy('standard');
    }
    throw err; // If standard fails validation, we have a critical error.
  }

  return strategy;
}
