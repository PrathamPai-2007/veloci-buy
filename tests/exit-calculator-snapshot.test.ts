'use strict';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCtx, serializeForSnapshot } from './_test_helpers.js';
import {
  getTakeProfitPlan,
  getTakeProfitPlanByProfile,
  getTakeProfitFraction,
  computeTakeProfitSellAmount,
} from '../src/services/monitor/exit-calculator.js';
import { Position } from '../src/types/index.js';

function makePos(overrides: Partial<Position> = {}): Position {
  return {
    mint: 'mint1',
    symbol: 'T',
    name: 'Test',
    decimals: 9,
    openedAt: new Date().toISOString(),
    mode: 'paper',
    entryPriceUsd: 0.001,
    entryUsdValue: 100,
    entryScore: 80,
    initialTokenAmountRaw: '1000',
    highestPriceUsd: 0.002,
    partiallyClosed: false,
    takeProfitMultiples: [1.15, 1.75],
    takeProfitFractions: [0.75, 0.6],
    trailingStopDrawdownPctResolved: 0.16,
    maxHoldMinutesResolved: 20,
    volatilityScaler: 1,
    entryLiquidityUsd: 5000,
    ...overrides,
  } as Position;
}

test('snapshot TP plan: high-confidence profile', (t) => {
  const ctx = createCtx({ highGrowthConfidenceScore: 70 });
  const plan = getTakeProfitPlan(ctx, 85);
  t.assert.snapshot(serializeForSnapshot(plan));
});

test('snapshot TP plan: standard profile', (t) => {
  const ctx = createCtx({ highGrowthConfidenceScore: 80 });
  const plan = getTakeProfitPlan(ctx, 50);
  t.assert.snapshot(serializeForSnapshot(plan));
});

test('snapshot TP plan: high profile with custom multiples and fractions', (t) => {
  const ctx = createCtx({
    highGrowthConfidenceScore: 70,
    takeProfitMultiples: [1.2, 1.8, 2.5],
    takeProfitMultiplesHigh: [1.3, 2.0],
    takeProfitFractions: [0.8, 0.5],
    trailingStopDrawdownPct: 0.18,
    holdDurationHighConfidenceMinutes: 15,
  });
  const highPlan = getTakeProfitPlanByProfile(ctx, 'high');
  const standardPlan = getTakeProfitPlanByProfile(ctx, 'standard');
  t.assert.snapshot(serializeForSnapshot({ high: highPlan, standard: standardPlan }));
});

test('snapshot TP plan: borderline score equals threshold routes to high', (t) => {
  const ctx = createCtx({ highGrowthConfidenceScore: 70 });
  const plan = getTakeProfitPlan(ctx, 70);
  assert.equal(plan.isHighGrowthConfidence, true);
  t.assert.snapshot(serializeForSnapshot(plan));
});

test('snapshot TP plan: clamping trailing drawdown', (t) => {
  const ctx = createCtx({ trailingStopDrawdownPct: 0.93 });
  const plan = getTakeProfitPlanByProfile(ctx, 'high');
  t.assert.snapshot(serializeForSnapshot(plan));
});

test('snapshot TP fraction selection across indices and defaults', (t) => {
  const pos = makePos({ takeProfitFractions: [0.75, 0.5] });
  const result = {
    index0: getTakeProfitFraction(pos, 0),
    index1: getTakeProfitFraction(pos, 1),
    index2Fallback: getTakeProfitFraction(pos, 2),
    emptyArrayFallback: getTakeProfitFraction({ ...pos, takeProfitFractions: [] }, 0),
    clampHigh: getTakeProfitFraction({ ...pos, takeProfitFractions: [1.5] }, 0),
    clampLow: getTakeProfitFraction({ ...pos, takeProfitFractions: [-0.1] }, 0),
  };
  t.assert.snapshot(serializeForSnapshot(result));
});

test('snapshot computeTakeProfitSellAmount across fractions', (t) => {
  const result = {
    zero: computeTakeProfitSellAmount(10_000n, 0),
    quarter: computeTakeProfitSellAmount(10_000n, 0.25),
    half: computeTakeProfitSellAmount(10_000n, 0.5),
    full: computeTakeProfitSellAmount(10_000n, 1.0),
    largeBalance: computeTakeProfitSellAmount(1_000_000_000_000n, 0.75),
  };
  t.assert.snapshot(serializeForSnapshot(result));
});
