import path from 'node:path';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { Config, PresetStrategy } from '../types/index.js';
import { safeConsole } from './utils.js';
import { TUNING_KEYS, STRATEGY_ML_KEYS } from './tuning-keys.js';

const ALLOWED_KEYS = new Set<string>(['name', 'description', ...TUNING_KEYS, ...STRATEGY_ML_KEYS]);

/**
 * Validates preset trading strategy properties for numeric constraints and sanity ranges.
 * @param strategy - Parsed strategy configuration.
 * @throws Error if strategy contains invalid or out-of-range field values.
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

  // Every numeric tuning knob is a count, threshold, delay or ratio: none may be negative.
  // (earlyPerformanceDropPct-style "drop" values are expressed as positive magnitudes.)
  for (const [field, value] of Object.entries(strategy)) {
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) {
      errors.push(`${field} must be a non-negative number.`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Strategy validation failed:\n- ${errors.join('\n- ')}`);
  }
}

const STRATEGY_DIR = path.resolve(process.cwd(), 'strategies');

function readStrategyFile(name: string): Record<string, unknown> {
  const strategyPath = path.join(STRATEGY_DIR, `${name}.yaml`);
  if (!fs.existsSync(strategyPath)) {
    throw new Error(`Strategy file not found: ${strategyPath}`);
  }
  const parsed = yaml.load(fs.readFileSync(strategyPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Strategy file ${strategyPath} must be a YAML mapping.`);
  }
  return parsed as Record<string, unknown>;
}

/** Rejects unknown keys (typos, removed knobs) and values whose type differs from the base. */
function checkShape(
  name: string,
  overrides: Record<string, unknown>,
  base: Record<string, unknown>
): void {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(overrides)) {
    if (!ALLOWED_KEYS.has(key)) {
      errors.push(`unknown key "${key}"`);
      continue;
    }
    const expected = base[key];
    if (expected === undefined || value === null) continue;
    const kind = (v: unknown): string => (Array.isArray(v) ? 'array' : typeof v);
    if (kind(value) !== kind(expected)) {
      errors.push(`"${key}" must be ${kind(expected)}, got ${kind(value)}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Strategy "${name}" is invalid:\n- ${errors.join('\n- ')}`);
  }
}

function loadBaseStrategy(): PresetStrategy {
  const base = readStrategyFile('standard');
  checkShape('standard', base, base);
  const missing = TUNING_KEYS.filter((key) => base[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`strategies/standard.yaml is missing required keys: ${missing.join(', ')}`);
  }
  const strategy = base as unknown as PresetStrategy;
  validateStrategy(strategy);
  return strategy;
}

/** standard.yaml: the complete set of tuning defaults every other strategy is merged over. */
export const DEFAULT_STRATEGY: PresetStrategy = loadBaseStrategy();

/**
 * Loads a strategy by name: strategies/<name>.yaml merged over standard.yaml, then validated.
 * Falls back to standard if the requested strategy is missing or invalid.
 * @param name - Strategy name (e.g. 'standard', 'custom-alpha').
 */
export function loadStrategy(name: string): PresetStrategy {
  if (name === 'standard') return { ...DEFAULT_STRATEGY };
  try {
    const overrides = readStrategyFile(name);
    checkShape(name, overrides, DEFAULT_STRATEGY as unknown as Record<string, unknown>);
    const strategy = { ...DEFAULT_STRATEGY, ...overrides } as PresetStrategy;
    validateStrategy(strategy);
    return strategy;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    safeConsole('error', `[CONFIG] Failed to load strategy "${name}": ${message}`);
    safeConsole('error', `[CONFIG] Falling back to standard strategy.`);
    return { ...DEFAULT_STRATEGY };
  }
}

/** Copies the tuning (and, by default, optional ML) fields of a resolved strategy. */
export function pickStrategyFields(
  strategy: PresetStrategy,
  keys: readonly string[] = [...TUNING_KEYS, ...STRATEGY_ML_KEYS]
): Partial<Config> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = (strategy as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = Array.isArray(value) ? (value as unknown[]).slice() : value;
  }
  return out as Partial<Config>;
}

/**
 * Applies a strategy preset directly onto an active Config instance in-memory.
 * @param config - The application configuration object to mutate.
 * @param strategyName - The name of the preset strategy to load and apply.
 * @returns The loaded PresetStrategy.
 */
export function applyStrategyToConfig(config: Config, strategyName: string): PresetStrategy {
  const strategy = loadStrategy(strategyName);
  config.strategyName = strategyName;
  Object.assign(config, pickStrategyFields(strategy));
  return strategy;
}
