'use strict';
import { createCtx } from './_test_helpers.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeEffectiveMinScore } from '../src/services/engine/engine.service.js';

const BASE = 65;

test('adaptive floor: dead market loosens toward the floor instead of tightening (paper)', () => {
  const ctx = createCtx({
    paperTrading: true,
    minCandidateScore: BASE,
    minCandidateScoreFloor: 50,
    tradeStarvationMinutes: 10,
    starvationRelaxStep: 3,
  });
  ctx.calculateGMI = () => 0.0; // fully dead market

  // No starvation yet: a fresh session reference (now ≈ SESSION_START).
  const { effective } = computeEffectiveMinScore(ctx, BASE, Date.now());

  // Must NOT exceed base (never tighten) and must be below base (loosened toward floor).
  assert.ok(effective <= BASE, `expected <= ${BASE}, got ${effective}`);
  assert.ok(effective < BASE, `expected loosening below ${BASE}, got ${effective}`);
  assert.ok(effective >= 50, `must respect floor, got ${effective}`);
});

test('adaptive floor: starvation relaxes the gate further over time, clamped to the floor', () => {
  const ctx = createCtx(
    {
      paperTrading: true,
      minCandidateScore: BASE,
      minCandidateScoreFloor: 50,
      tradeStarvationMinutes: 10,
      starvationRelaxStep: 3,
    },
    { lastBuyAt: 0 } // last buy at epoch 0 → heavily starved relative to `now`
  );
  ctx.calculateGMI = () => 0.5; // neutral regime so we isolate the starvation effect

  const now = 60 * 60 * 1000; // 1h since last buy → many starvation intervals
  const { effective } = computeEffectiveMinScore(ctx, BASE, now);

  assert.equal(effective, 50, `deep starvation should clamp to the floor, got ${effective}`);
});

test('adaptive floor: a recent buy keeps the gate at base in a neutral regime', () => {
  const now = 5_000_000;
  const ctx = createCtx(
    {
      paperTrading: true,
      minCandidateScore: BASE,
      minCandidateScoreFloor: 50,
      tradeStarvationMinutes: 10,
      starvationRelaxStep: 3,
    },
    { lastBuyAt: now - 60_000 } // bought 1 min ago, under the 10-min starvation window
  );
  ctx.calculateGMI = () => 0.5;

  const { effective } = computeEffectiveMinScore(ctx, BASE, now);
  assert.equal(effective, BASE);
});

test('live mode keeps legacy GMI behaviour: dead market tightens by +5', () => {
  const ctx = createCtx({
    paperTrading: false,
    adaptiveFloorEnabled: true,
    adaptiveFloorLiveEnabled: false, // adaptive floor must NOT apply in live
    minCandidateScore: BASE,
  });
  ctx.calculateGMI = () => 0.1; // < 0.3 → legacy tightens

  const { effective } = computeEffectiveMinScore(ctx, BASE, Date.now());
  assert.equal(effective, BASE + 5);
});

test('live mode keeps legacy GMI behaviour: hot market loosens by -5', () => {
  const ctx = createCtx({
    paperTrading: false,
    adaptiveFloorEnabled: true,
    adaptiveFloorLiveEnabled: false,
    minCandidateScore: BASE,
  });
  ctx.calculateGMI = () => 0.9; // > 0.7 → legacy loosens

  const { effective } = computeEffectiveMinScore(ctx, BASE, Date.now());
  assert.equal(effective, BASE - 5);
});

test('adaptiveFloorLiveEnabled lets the adaptive floor apply in live mode too', () => {
  const ctx = createCtx({
    paperTrading: false,
    adaptiveFloorEnabled: true,
    adaptiveFloorLiveEnabled: true,
    minCandidateScore: BASE,
    minCandidateScoreFloor: 50,
  });
  ctx.calculateGMI = () => 0.0;

  const { effective } = computeEffectiveMinScore(ctx, BASE, Date.now());
  assert.ok(effective < BASE, `expected loosening below ${BASE}, got ${effective}`);
});
