'use strict';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { loadStrategy, validateStrategy } from '../src/core/config.js';

const standardYamlPath = path.resolve(process.cwd(), 'strategies', 'standard.yaml');
const standardConfig = yaml.load(fs.readFileSync(standardYamlPath, 'utf8')) as any;

test('strategy loader loads valid standard strategy', () => {
  const strategy = loadStrategy('standard');
  assert.equal(typeof strategy, 'object');
  assert.equal(strategy.minLiquidityUsd, standardConfig.minLiquidityUsd);
  // The loader parsed the take-profit ladder into a non-empty numeric array. (Don't pin exact
  // multiples here — they're tuned in standard.yaml and shouldn't break this parse smoke test.)
  assert.ok(Array.isArray(strategy.takeProfitMultiples));
  assert.ok(strategy.takeProfitMultiples.length > 0);
  assert.ok(strategy.takeProfitMultiples.every((m: number) => typeof m === 'number' && m > 1));
});

test('strategy loader falls back to standard for deleted conservative strategy', () => {
  const orig = console.error;
  console.error = () => {};
  try {
    const strategy = loadStrategy('conservative');
    assert.equal(typeof strategy, 'object');
    // Should fall back to standard values
    assert.equal(strategy.stopLossPct, standardConfig.stopLossPct);
  } finally {
    console.error = orig;
  }
});

test('strategy loader loads custom strategy by arbitrary filename', () => {
  const strategy = loadStrategy('custom-alpha');
  assert.equal(typeof strategy, 'object');
  assert.equal(strategy.name, 'My Custom Strategy');
  assert.equal(strategy.minLiquidityUsd, 777);
  assert.equal(strategy.stopLossPct, 0.07);
});

test('strategy loader falls back to standard for missing strategy', () => {
  const orig = console.error;
  console.error = () => {};
  try {
    const strategy = loadStrategy('non-existent');
    assert.equal(typeof strategy, 'object');
    // Should have standard values
    assert.equal(strategy.stopLossPct, standardConfig.stopLossPct);
  } finally {
    console.error = orig;
  }
});

test('validateStrategy rejects invalid stopLossPct', () => {
  const invalidStrategy = {
    stopLossPct: 1.5,
    takeProfitMultiples: [1.3],
  } as any;
  assert.throws(() => validateStrategy(invalidStrategy), /stopLossPct/);
});

test('validateStrategy rejects empty takeProfitMultiples', () => {
  const invalidStrategy = {
    stopLossPct: 0.1,
    takeProfitMultiples: [],
  } as any;
  assert.throws(() => validateStrategy(invalidStrategy), /takeProfitMultiples/);
});

test('strategy loader handles malformed yaml by falling back', () => {
  const malformedPath = path.resolve(process.cwd(), 'strategies', 'malformed.yaml');
  fs.writeFileSync(malformedPath, 'name: [unclosed bracket');

  const orig = console.error;
  console.error = () => {};
  try {
    const strategy = loadStrategy('malformed');
    assert.equal(strategy.stopLossPct, 0.15); // malformed parse falls back to DEFAULT_STRATEGY constant
  } finally {
    console.error = orig;
    if (fs.existsSync(malformedPath)) fs.unlinkSync(malformedPath);
  }
});
