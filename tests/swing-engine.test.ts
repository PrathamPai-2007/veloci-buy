'use strict';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCtx } from './_test_helpers.js';
import { evaluateSwingCandidate } from '../src/services/swing/swing-engine.js';
import { SwingWatchlistItem } from '../src/types/index.js';

function createDoubleDipPriceHistory(
  higherLow: boolean = true
): { price: number; timestamp: number }[] {
  const prices = new Array(100);

  // 0 to 4: decreasing
  for (let i = 0; i <= 4; i++) {
    prices[i] = 20 - i;
  }
  // 5: local min 1
  prices[5] = 10;
  // 6 to 14: increasing
  for (let i = 6; i <= 14; i++) {
    prices[i] = 10 + (i - 5);
  }
  // 15: local max 1
  prices[15] = 20;
  // 16 to 24: decreasing
  for (let i = 16; i <= 24; i++) {
    prices[i] = 20 - (i - 15);
  }
  // 25: local min 2
  prices[25] = 10;
  // 26 to 54: increasing
  for (let i = 26; i <= 54; i++) {
    prices[i] = 10 + (i - 25) * 5;
  }
  // 55: local min 3
  prices[55] = 100;
  // 56 to 64: increasing
  for (let i = 56; i <= 64; i++) {
    prices[i] = 100 + (i - 55) * 10;
  }
  // 65: local max 2
  prices[65] = 200;
  // 66 to 74: decreasing
  for (let i = 66; i <= 74; i++) {
    prices[i] = 200 - (i - 65) * 10;
  }
  // 75: local min 4
  prices[75] = higherLow ? 110 : 100;
  // 76 to 99: increasing
  const baseAt75 = higherLow ? 110 : 100;
  for (let i = 76; i <= 99; i++) {
    prices[i] = baseAt75 + (i - 75) * 4;
  }

  return prices.map((price, idx) => ({
    price,
    timestamp: 1000 + idx * 30_000, // 30s interval
  }));
}

test('evaluateSwingCandidate reject reasons: insufficient-observation-time', async () => {
  const ctx = createCtx({ swingMinObservationMinutes: 30 });
  const item: SwingWatchlistItem = {
    mint: 'TestMint1',
    symbol: 'TEST1',
    name: 'Test Token 1',
    decimals: 9,
    fdvUsd: 100_000,
    addedAt: Date.now() - 10 * 60_000, // only 10 mins
    lastPolledAt: Date.now(),
    priceHistory: createDoubleDipPriceHistory(),
    tapeHistory: [],
    lastKnownPrice: 100,
    lastKnownLiquidity: 50_000,
    pool: 'raydium',
  };

  const res = await evaluateSwingCandidate(ctx, item);
  assert.equal(res.approved, false);
  assert.deepEqual(res.blockers, ['insufficient-observation-time']);
});

test('evaluateSwingCandidate reject reasons: insufficient-price-history', async () => {
  const ctx = createCtx({ swingMinObservationMinutes: 30 });
  const item: SwingWatchlistItem = {
    mint: 'TestMint2',
    symbol: 'TEST2',
    name: 'Test Token 2',
    decimals: 9,
    fdvUsd: 100_000,
    addedAt: Date.now() - 40 * 60_000,
    lastPolledAt: Date.now(),
    priceHistory: [{ price: 100, timestamp: Date.now() }], // too short
    tapeHistory: [],
    lastKnownPrice: 100,
    lastKnownLiquidity: 50_000,
    pool: 'raydium',
  };

  const res = await evaluateSwingCandidate(ctx, item);
  assert.equal(res.approved, false);
  assert.deepEqual(res.blockers, ['insufficient-price-history']);
});

test('evaluateSwingCandidate with full requirements (score >= swingMinScore)', async () => {
  // swingMinScore = 60
  // Double-dip score with higherLow=true and recoveryPct=196 is 40 + 15 + 10 = 65
  // volumeAccumEnabled = false, so no-volume blocker is bypassed
  const ctx = createCtx({
    swingMinObservationMinutes: 30,
    swingMinScore: 60,
    swingDoubleDipEnabled: true,
    swingVolumeAccumEnabled: false,
  });

  const item: SwingWatchlistItem = {
    mint: 'TestMint3',
    symbol: 'TEST3',
    name: 'Test Token 3',
    decimals: 9,
    fdvUsd: 100_000,
    addedAt: Date.now() - 40 * 60_000,
    lastPolledAt: Date.now(),
    priceHistory: createDoubleDipPriceHistory(),
    tapeHistory: [],
    lastKnownPrice: 100,
    lastKnownLiquidity: 50_000,
    pool: 'raydium',
  };

  const res = await evaluateSwingCandidate(ctx, item);
  assert.equal(res.approved, true);
  assert.equal(res.score, 65);
  assert.deepEqual(res.blockers, []);
});

test('evaluateSwingCandidate double-dip-only fallback when no volume data available at all', async () => {
  // If swingVolumeAccumEnabled is true, we expect 'no-volume-accumulation' blocker.
  // With swingAllowDoubleDipOnly = false, it should reject because of the blocker.
  const ctx = createCtx({
    swingMinObservationMinutes: 30,
    swingMinScore: 60,
    swingDoubleDipEnabled: true,
    swingVolumeAccumEnabled: true,
    swingAllowDoubleDipOnly: false,
  });

  const item: SwingWatchlistItem = {
    mint: 'TestMint4',
    symbol: 'TEST4',
    name: 'Test Token 4',
    decimals: 9,
    fdvUsd: 100_000,
    addedAt: Date.now() - 40 * 60_000,
    lastPolledAt: Date.now(),
    priceHistory: createDoubleDipPriceHistory(),
    tapeHistory: [], // empty -> length < 4
    lastKnownPrice: 100,
    lastKnownLiquidity: 50_000,
    pool: 'raydium',
  };

  const res1 = await evaluateSwingCandidate(ctx, item);
  assert.equal(res1.approved, false);
  assert.deepEqual(res1.blockers, ['no-volume-accumulation']);

  // Now with swingAllowDoubleDipOnly = true, and swingMinScoreNoVolume = 55, it should approve because score = 65 >= 55.
  const ctxWithFallback = createCtx({
    swingMinObservationMinutes: 30,
    swingMinScore: 60,
    swingDoubleDipEnabled: true,
    swingVolumeAccumEnabled: true,
    swingAllowDoubleDipOnly: true,
    swingMinScoreNoVolume: 55,
  });

  const res2 = await evaluateSwingCandidate(ctxWithFallback, item);
  assert.equal(res2.approved, true);
  assert.deepEqual(res2.blockers, []);
  assert.equal(res2.signals.approved, true);
  assert.deepEqual(res2.signals.blockers, []);

  // If score is below swingMinScoreNoVolume (e.g. 60, but floor is 70), it should still reject
  const ctxWithHighFloor = createCtx({
    swingMinObservationMinutes: 30,
    swingMinScore: 60,
    swingDoubleDipEnabled: true,
    swingVolumeAccumEnabled: true,
    swingAllowDoubleDipOnly: true,
    swingMinScoreNoVolume: 70,
  });

  const res3 = await evaluateSwingCandidate(ctxWithHighFloor, item);
  assert.equal(res3.approved, false);
  // Note: we override blockers to [] only if approved, otherwise they remain the same
  assert.deepEqual(res3.blockers, ['no-volume-accumulation']);
});
