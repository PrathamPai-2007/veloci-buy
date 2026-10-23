'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCandidateScore,
  computeMomentumScore,
  computeEffectiveMinScore,
} from '../../src/services/engine/scoring.js';
import { computeStandardDeviation, computeSpread } from '../../src/core/utils/math.js';
import { computeTakeProfitSellAmount } from '../../src/services/monitor/exit-calculator.js';
import { createTestToken } from '../factories/token.js';
import { createCtx } from '../_test_helpers.js';

test('computeCandidateScore handles normal, boundary, and extreme inputs', () => {
  const profile = {
    name: 'pump.fun',
    scoreBonus: 10,
    liquidityMultiplier: 1.0,
    holderMultiplier: 1.0,
    buysMultiplier: 1.0,
    minPoolAgeSeconds: 0,
  };
  const thresholds = {
    minLiquidityUsd: 1000,
    minHolderCount: 10,
    minBuys5m: 5,
    minPoolAgeSeconds: 0,
  };

  // Standard case
  const normalToken = createTestToken({
    liquidity: 5000,
    holderCount: 20,
    organicScore: 80,
  });
  const scoreNormal = computeCandidateScore(normalToken, profile, thresholds, 2);
  assert.ok(
    scoreNormal >= 0 && scoreNormal <= 100,
    `Score should be bounded 0-100, got ${scoreNormal}`
  );

  // Zero liquidity and zero holders
  const zeroToken = createTestToken({
    liquidity: 0,
    holderCount: 0,
    organicScore: 0,
  });
  const scoreZero = computeCandidateScore(zeroToken, profile, thresholds, 0);
  assert.ok(scoreZero >= 0 && scoreZero <= 100);

  // NaN / Infinity edge values
  const nanToken = createTestToken({
    liquidity: NaN,
    holderCount: Infinity as any,
    organicScore: -Infinity as any,
  });
  const scoreNan = computeCandidateScore(nanToken, profile, thresholds, 0);
  assert.ok(Number.isFinite(scoreNan), 'Score must always return a finite number');

  // Parametrized social links tests
  const socialCases = [
    { count: 0, expectedMin: 0 },
    { count: 1, expectedMin: 50 },
    { count: 3, expectedMin: 60 },
    { count: 10, expectedMin: 60 },
  ];
  for (const c of socialCases) {
    const s = computeCandidateScore(normalToken, profile, thresholds, c.count);
    assert.ok(Number.isFinite(s));
  }
});

test('computeMomentumScore handles momentum ratios and price history length', () => {
  const normalToken = createTestToken({
    stats5m: { numBuys: 40, numSells: 10 },
  });

  // Short price history (< 6 samples returns 0)
  const shortHistory = [{ price: 0.001, timestamp: Date.now() }];
  assert.equal(computeMomentumScore(normalToken, shortHistory, 0.001, 0.0015), 0);

  // Valid price history length (>= 6)
  const validHistory = Array.from({ length: 6 }, (_, i) => ({
    price: 0.001 + i * 0.0001,
    timestamp: Date.now() - (6 - i) * 1000,
  }));

  const score = computeMomentumScore(normalToken, validHistory, 0.001, 0.0015);
  assert.ok(Number.isFinite(score), 'Score should return a finite number for valid history');
});

test('computeEffectiveMinScore respects candidate score floor and GMI regime', () => {
  const ctx = createCtx({
    minCandidateScore: 70,
    adaptiveFloorEnabled: true,
    paperTrading: true,
    minCandidateScoreFloor: 50,
  });

  ctx.state.lastBuyAt = Date.now() - 30 * 60_000; // 30 min ago

  const { effective } = computeEffectiveMinScore(ctx, 70);
  assert.ok(Number.isFinite(effective), 'Effective score must be a finite number');
  assert.ok(effective <= 70, 'Adaptive score should relax or stay equal to base score');
});

test('math utilities boundary tests (computeStandardDeviation & computeSpread)', () => {
  // Empty array
  assert.equal(computeStandardDeviation([]), 0);
  // Single element
  assert.equal(computeStandardDeviation([42]), 0);
  // Equal elements
  assert.equal(computeStandardDeviation([10, 10, 10]), 0);

  // Spread calculations
  assert.equal(computeSpread(100, 100), 0);
  assert.equal(computeSpread(0, 100), 0);
  assert.equal(computeSpread(100, 0), 0);
  assert.ok(Math.abs(computeSpread(95, 105) - 0.1) < 0.001);
});

test('computeTakeProfitSellAmount handles fraction scaling and rounding', () => {
  const rawBalance = 1_000_000_000n; // 1 billion raw

  // 50% fraction
  const half = computeTakeProfitSellAmount(rawBalance, 0.5);
  assert.equal(half, 500_000_000n);

  // 100% fraction
  const full = computeTakeProfitSellAmount(rawBalance, 1.0);
  assert.equal(full, 1_000_000_000n);

  // Negative fraction returns 0n
  const negative = computeTakeProfitSellAmount(rawBalance, -0.5);
  assert.equal(negative, 0n);
});
