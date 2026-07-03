'use strict';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCtx } from './_test_helpers.js';
import {
  getTakeProfitPlan,
  getTakeProfitPlanByProfile,
  getTakeProfitFraction,
  computeTakeProfitSellAmount,
  getMoodAdjustments,
  getTrailingActivationMultiple,
} from '../src/services/monitor/exit-calculator.js';
import type { Position } from '../src/types/index.js';

function makePos(overrides: Partial<Position> = {}): Position {
  return {
    mint: 'mint1',
    symbol: 'TEST',
    name: 'Test Token',
    entryPriceUsd: 0.001,
    currentPriceUsd: 0.001,
    highestPriceUsd: 0.001,
    tokensHeld: 1_000_000n,
    entryLamports: 50_000_000n,
    openedAt: new Date().toISOString(),
    launchpad: 'pump.fun',
    takeProfitMultiples: [],
    takeProfitFractions: [],
    targetsHit: 0,
    moonBagTokens: 0n,
    isOpen: true,
    ...overrides,
  } as unknown as Position;
}

// ── getTakeProfitPlan ──────────────────────────────────────────────────────────

test('getTakeProfitPlan routes to high profile when score meets threshold', () => {
  const ctx = createCtx({ highGrowthConfidenceScore: 70 });
  const plan = getTakeProfitPlan(ctx, 70);
  assert.equal(plan.profileId, 'high-confidence');
  assert.equal(plan.isHighGrowthConfidence, true);
  assert.deepEqual(plan.takeProfitMultiples, [1.24, 2.0]);
});

test('getTakeProfitPlan routes to standard profile when score is below threshold', () => {
  const ctx = createCtx({ highGrowthConfidenceScore: 70 });
  const plan = getTakeProfitPlan(ctx, 69);
  assert.equal(plan.profileId, 'low-confidence');
  assert.equal(plan.isHighGrowthConfidence, false);
  assert.deepEqual(plan.takeProfitMultiples, [1.15, 1.75]);
});

test('getTakeProfitPlan handles non-finite score as 0 (routes to standard)', () => {
  const ctx = createCtx({ highGrowthConfidenceScore: 70 });
  const plan = getTakeProfitPlan(ctx, NaN);
  assert.equal(plan.isHighGrowthConfidence, false);
});

// ── getTakeProfitPlanByProfile ─────────────────────────────────────────────────

test('getTakeProfitPlanByProfile high: correct IDs, multiples, trailing offset', () => {
  const ctx = createCtx({ trailingStopDrawdownPct: 0.2, holdDurationHighConfidenceMinutes: 10 });
  const plan = getTakeProfitPlanByProfile(ctx, 'high');
  assert.equal(plan.profileId, 'high-confidence');
  assert.equal(plan.isHighGrowthConfidence, true);
  assert.deepEqual(plan.takeProfitMultiples, [1.24, 2.0]);
  assert.deepEqual(plan.takeProfitFractions, [0.75, 0.6]);
  // trailing = config (0.2) + 0.04 offset for high profile (floating-point tolerance)
  assert.ok(
    Math.abs(plan.trailingStopDrawdownPct - 0.24) < 1e-9,
    `trailing ${plan.trailingStopDrawdownPct}`
  );
  assert.equal(plan.maxHoldMinutesResolved, 10);
});

test('getTakeProfitPlanByProfile standard: no trailing offset, uses maxHoldMinutes', () => {
  const ctx = createCtx({ trailingStopDrawdownPct: 0.16, maxHoldMinutes: 30 });
  const plan = getTakeProfitPlanByProfile(ctx, 'standard');
  assert.equal(plan.profileId, 'low-confidence');
  assert.equal(plan.isHighGrowthConfidence, false);
  assert.deepEqual(plan.takeProfitMultiples, [1.15, 1.75]);
  // standard trailing = config exactly (no +0.04)
  assert.equal(plan.trailingStopDrawdownPct, 0.16);
  assert.equal(plan.maxHoldMinutesResolved, 30);
});

test('getTakeProfitPlanByProfile clamps trailing to [0.01, 0.95]', () => {
  // Edge: config trailing at 0.93 → high = 0.97 → clamped to 0.95
  const ctx = createCtx({ trailingStopDrawdownPct: 0.93 });
  const plan = getTakeProfitPlanByProfile(ctx, 'high');
  assert.equal(plan.trailingStopDrawdownPct, 0.95);
});

// ── getTrailingActivationMultiple ──────────────────────────────────────────────

test('getTrailingActivationMultiple: TP [1.15, 1.75] → midpoint 1.075 (no cap)', () => {
  const pos = makePos({ takeProfitMultiples: [1.15, 1.75] });
  assert.equal(getTrailingActivationMultiple(pos), 1.075);
});

test('getTrailingActivationMultiple: TP [1.24, 2.0] → midpoint exactly at cap 1.12', () => {
  // midpoint = 1 + 0.5 * (1.24 - 1) = 1.12 — exactly the cap
  const pos = makePos({ takeProfitMultiples: [1.24, 2.0] });
  assert.equal(getTrailingActivationMultiple(pos), 1.12);
});

test('getTrailingActivationMultiple: TP [1.5] → midpoint 1.25 → capped at 1.12', () => {
  const pos = makePos({ takeProfitMultiples: [1.5] });
  assert.equal(getTrailingActivationMultiple(pos), 1.12);
});

test('getTrailingActivationMultiple: empty TP falls back to TAKE_PROFIT_MULTIPLES default [1.5] → capped 1.12', () => {
  const pos = makePos({ takeProfitMultiples: [] });
  // default TAKE_PROFIT_MULTIPLES = [1.5] → midpoint 1.25 → capped 1.12
  assert.equal(getTrailingActivationMultiple(pos), 1.12);
});

test('getTrailingActivationMultiple: no takeProfitMultiples field falls back to default', () => {
  const pos = makePos({ takeProfitMultiples: undefined as any });
  assert.equal(getTrailingActivationMultiple(pos), 1.12);
});

// ── computeTakeProfitSellAmount ────────────────────────────────────────────────

test('computeTakeProfitSellAmount: 100% fraction returns full balance', () => {
  assert.equal(computeTakeProfitSellAmount(10_000n, 1.0), 10_000n);
});

test('computeTakeProfitSellAmount: 75% fraction', () => {
  assert.equal(computeTakeProfitSellAmount(10_000n, 0.75), 7_500n);
});

test('computeTakeProfitSellAmount: 60% fraction (default TAKE_PROFIT_FRACTION)', () => {
  assert.equal(computeTakeProfitSellAmount(10_000n, 0.6), 6_000n);
});

test('computeTakeProfitSellAmount: frac=0 clamps to minimum 1/10000 of balance', () => {
  // Math.max(1, Math.round(0 * 10000)) = 1 → 10000n * 1n / 10000n = 1n
  assert.equal(computeTakeProfitSellAmount(10_000n, 0), 1n);
});

test('computeTakeProfitSellAmount: large balance precision', () => {
  // 1 billion tokens, 75% sell
  assert.equal(computeTakeProfitSellAmount(1_000_000_000n, 0.75), 750_000_000n);
});

// ── getTakeProfitFraction ──────────────────────────────────────────────────────

test('getTakeProfitFraction: reads per-position fractions by index', () => {
  const pos = makePos({ takeProfitFractions: [0.8, 0.5] });
  assert.equal(getTakeProfitFraction(pos, 0), 0.8);
  assert.equal(getTakeProfitFraction(pos, 1), 0.5);
});

test('getTakeProfitFraction: falls back to TAKE_PROFIT_FRACTION when index out of range', () => {
  const pos = makePos({ takeProfitFractions: [0.8] });
  // Index 2 missing → fallback to constant 0.6
  assert.equal(getTakeProfitFraction(pos, 2), 0.6);
});

test('getTakeProfitFraction: falls back when fractions array is empty', () => {
  const pos = makePos({ takeProfitFractions: [] });
  assert.equal(getTakeProfitFraction(pos, 0), 0.6);
});

test('getTakeProfitFraction: clamps values above 1.0', () => {
  const pos = makePos({ takeProfitFractions: [1.5] });
  assert.equal(getTakeProfitFraction(pos, 0), 1.0);
});

test('getTakeProfitFraction: clamps negative values to 0', () => {
  const pos = makePos({ takeProfitFractions: [-0.1] });
  assert.equal(getTakeProfitFraction(pos, 0), 0.0);
});

// ── getMoodAdjustments ────────────────────────────────────────────────────────

test('getMoodAdjustments: empty history returns neutral (no pause, full size)', () => {
  const ctx = createCtx({}, { tradeHistory: [], moodPauseUntil: null });
  const result = getMoodAdjustments(ctx);
  assert.equal(result.isPaused, false);
  assert.equal(result.sizeMultiplier, 1);
});

test('getMoodAdjustments: active future pause → isPaused=true regardless of trade history', () => {
  const ctx = createCtx({}, { moodPauseUntil: Date.now() + 3_600_000, tradeHistory: [] });
  assert.equal(getMoodAdjustments(ctx).isPaused, true);
});

test('getMoodAdjustments: 10 trades at 10% win rate (< 20% critical) → pauses', () => {
  // 1 win, 9 losses = 10% WR < winRateCritical (20%)
  const history = [true, false, false, false, false, false, false, false, false, false];
  const ctx = createCtx(
    {},
    { tradeHistory: history, moodPauseUntil: null, moodPauseTradeCount: null }
  );
  const result = getMoodAdjustments(ctx);
  assert.equal(result.isPaused, true);
  assert.ok(ctx.state.moodPauseUntil! > Date.now(), 'pause timestamp should be in the future');
});

test('getMoodAdjustments: 5 trades at 20% win rate (< 40% cautious) → sizeMultiplier 0.5', () => {
  // 1 win, 4 losses = 20% WR < winRateCautious (40%), >= winRateCritical (20%)
  const history = [true, false, false, false, false];
  const ctx = createCtx(
    {},
    { tradeHistory: history, moodPauseUntil: null, moodPauseTradeCount: null }
  );
  const result = getMoodAdjustments(ctx);
  assert.equal(result.isPaused, false);
  assert.equal(result.sizeMultiplier, 0.5);
});

test('getMoodAdjustments: 10 trades at 50% win rate → neutral (full size, no pause)', () => {
  const history = [true, false, true, false, true, false, true, false, true, false];
  const ctx = createCtx(
    {},
    { tradeHistory: history, moodPauseUntil: null, moodPauseTradeCount: null }
  );
  const result = getMoodAdjustments(ctx);
  assert.equal(result.isPaused, false);
  assert.equal(result.sizeMultiplier, 1);
});

test('getMoodAdjustments: anti-lockup path resumes at 0.5× after pause expires with no new trades', () => {
  // Pause expired, but no new trades recorded since pause started (moodPauseTradeCount == history.length)
  // → should NOT re-pause (anti-lockup guard), instead resume at cautious size
  const history = [false, false, false, false, false, false, false, false, false, false]; // 10 losses
  const ctx = createCtx(
    {},
    {
      tradeHistory: history,
      moodPauseUntil: Date.now() - 1, // pause just expired
      moodPauseTradeCount: history.length, // no new trades since pause started
    }
  );
  const result = getMoodAdjustments(ctx);
  assert.equal(result.isPaused, false, 'should not re-pause when no new trades since last pause');
  assert.equal(result.sizeMultiplier, 0.5, 'should resume at cautious size to avoid lockup');
});
