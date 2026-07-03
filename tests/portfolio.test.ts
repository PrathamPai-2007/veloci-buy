'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateDrawdown,
  canBuy,
  getAdjustedBuySize,
  evaluateDrawdownBreaker,
  portfolioService,
} from '../src/services/trading/portfolio.service.js';
import { createCtx, withPatchedMembers } from './_test_helpers.js';

test('portfolio calculateDrawdown computes session drawdown', () => {
  // Scenario 1: No drawdown
  const ctx1 = createCtx({ paperTrading: true, maxDailyDrawdownPct: 0.15 });
  ctx1.state.paperSolBalanceLamports = '100000000'; // 0.1 SOL
  ctx1.state.peakSessionSolBalanceLamports = '100000000'; // 0.1 SOL
  const res1 = calculateDrawdown(ctx1);
  assert.equal(res1.drawdownPct, 0);
  assert.equal(res1.isCritical, false);

  // Scenario 2: Drawdown exceeds threshold (e.g. drop from 1 SOL to 0.8 SOL is 20% drawdown)
  const ctx2 = createCtx({ paperTrading: true, maxDailyDrawdownPct: 0.15 });
  ctx2.state.paperSolBalanceLamports = '800000000'; // 0.8 SOL
  ctx2.state.peakSessionSolBalanceLamports = '1000000000'; // 1.0 SOL
  const res2 = calculateDrawdown(ctx2);
  assert.ok(Math.abs(res2.drawdownPct - 0.2) < 0.001);
  assert.equal(res2.isCritical, true);

  // Scenario 3: peakSol <= 0
  const ctx3 = createCtx({ paperTrading: true });
  ctx3.state.peakSessionSolBalanceLamports = '0';
  const res3 = calculateDrawdown(ctx3);
  assert.equal(res3.drawdownPct, 0);
});

test('portfolio canBuy validates per-token sector concentration (drawdown handled by breaker)', () => {
  const ctx = createCtx({
    paperTrading: true,
    maxPositionsPerLaunchpad: 2,
  });

  // Approved
  const approvedRes = canBuy(ctx, { id: 'MintA', launchpad: 'pump.fun' } as any);
  assert.equal(approvedRes.approved, true);

  // canBuy no longer rejects on drawdown — even a deep drawdown leaves the per-token gate open.
  ctx.state.paperSolBalanceLamports = '1';
  ctx.state.peakSessionSolBalanceLamports = '1000000000';
  assert.equal(canBuy(ctx, { id: 'MintA', launchpad: 'pump.fun' } as any).approved, true);

  // Rejected by sector concentration
  ctx.state.positions.set('MintB', { mint: 'MintB', launchpad: 'pump.fun' } as any);
  ctx.state.positions.set('MintC', { mint: 'MintC', launchpad: 'pump.fun' } as any);

  const concRes = canBuy(ctx, { id: 'MintA', launchpad: 'pump.fun' } as any);
  assert.equal(concRes.approved, false);
  assert.match(concRes.reason!, /Max concurrent positions for pump.fun reached/);
});

test('portfolio evaluateDrawdownBreaker trips, pauses, and auto-resumes', async () => {
  const mkCtx = () =>
    createCtx({ paperTrading: true, maxDailyDrawdownPct: 0.3, drawdownCooldownMinutes: 30 });

  // (a) below threshold → not blocked
  const a = mkCtx();
  a.state.peakSessionSolBalanceLamports = '1000000000';
  a.state.paperSolBalanceLamports = '800000000'; // 20% < 30%
  assert.deepEqual(await evaluateDrawdownBreaker(a), { blocked: false });

  // (b) at/above 30% → blocked + tripped + pause armed
  const b = mkCtx();
  b.state.peakSessionSolBalanceLamports = '1000000000';
  b.state.paperSolBalanceLamports = '600000000'; // 40% >= 30%
  const bRes = await evaluateDrawdownBreaker(b);
  assert.equal(bRes.blocked, true);
  assert.equal(bRes.event, 'tripped');
  assert.match(bRes.reason!, /Critical drawdown/);
  assert.ok(b.state.drawdownPauseUntil && b.state.drawdownPauseUntil > Date.now());

  // (c) within the pause window → blocked, no event (stays quiet)
  b.state.drawdownPauseUntil = Date.now() + 5 * 60_000;
  assert.deepEqual(await evaluateDrawdownBreaker(b), { blocked: true });

  // (d) cooldown elapsed → not blocked, resumed, peak re-baselined to current
  b.state.drawdownPauseUntil = Date.now() - 1;
  const dRes = await evaluateDrawdownBreaker(b);
  assert.equal(dRes.blocked, false);
  assert.equal(dRes.event, 'resumed');
  assert.equal(b.state.drawdownPauseUntil, null);
  assert.equal(b.state.peakSessionSolBalanceLamports, '600000000'); // reset to current balance
});

test('portfolio evaluateDrawdownBreaker does NOT re-baseline the peak when resuming a loss-streak pause', async () => {
  // A loss-streak pause is only a few percent down; resuming it must preserve the high-water mark
  // so the catastrophic-drawdown breaker still measures against the true peak afterward.
  const ctx = createCtx({ paperTrading: true, maxDailyDrawdownPct: 0.3 });
  ctx.state.peakSessionSolBalanceLamports = '1000000000';
  ctx.state.paperSolBalanceLamports = '950000000'; // only 5% down — nowhere near the 30% breaker

  // Simulate the loss-streak breaker having armed the pause (tagged as loss-streak origin).
  ctx.state.drawdownPauseUntil = Date.now() - 1; // already elapsed
  ctx.state.lossStreakPauseActive = true;

  const res = await evaluateDrawdownBreaker(ctx);
  assert.equal(res.blocked, false);
  assert.equal(res.event, 'resumed');
  assert.equal(ctx.state.drawdownPauseUntil, null);
  assert.equal(ctx.state.lossStreakPauseActive, false);
  // Peak preserved (NOT reset to the current 950000000), so a later real dump still trips at 30%.
  assert.equal(ctx.state.peakSessionSolBalanceLamports, '1000000000');
});

test('portfolio evaluateDrawdownBreaker uses the real wallet balance in live mode', async () => {
  const ctx = createCtx({ paperTrading: false, maxDailyDrawdownPct: 0.3 });
  ctx.state.peakSessionSolBalanceLamports = '1000000000';

  // Live balance is 0.8 SOL → 20% drawdown. If the old `currentSol = 0` bug were present this
  // would compute as 100% and block; proving it does NOT block proves the wallet balance is used.
  await withPatchedMembers(
    portfolioService,
    { getCurrentBalanceLamports: async () => 800000000n },
    async () => {
      assert.deepEqual(await evaluateDrawdownBreaker(ctx), { blocked: false });
    }
  );
});

test('portfolio evaluateDrawdownBreaker is a no-op when disabled', async () => {
  const ctx = createCtx({
    paperTrading: true,
    circuitBreakerEnabled: false,
    maxDailyDrawdownPct: 0.3,
  });
  ctx.state.peakSessionSolBalanceLamports = '1000000000';
  ctx.state.paperSolBalanceLamports = '100000000'; // 90% drawdown, but breaker is off
  assert.deepEqual(await evaluateDrawdownBreaker(ctx), { blocked: false });
  assert.equal(ctx.state.drawdownPauseUntil, null);
});

test('portfolio getAdjustedBuySize scales buy size on loss streak', () => {
  const ctx = createCtx({ dynamicSizingEnabled: true });
  const baseSize = 100_000_000n;

  // No loss streak (no closed trades)
  const size1 = getAdjustedBuySize(ctx, baseSize);
  assert.equal(size1, baseSize);

  // Dynamic sizing disabled
  const ctxDisabled = createCtx({ dynamicSizingEnabled: false });
  ctxDisabled.state.closedTrades = [
    { realizedPnlUsd: -10 },
    { realizedPnlUsd: -5 },
    { realizedPnlUsd: -2 },
  ] as any[];
  const size2 = getAdjustedBuySize(ctxDisabled, baseSize);
  assert.equal(size2, baseSize);

  // 3 consecutive losses with dynamic sizing enabled
  ctx.state.closedTrades = [
    { realizedPnlUsd: -10 },
    { realizedPnlUsd: -5 },
    { realizedPnlUsd: -2 },
  ] as any[];
  const size3 = getAdjustedBuySize(ctx, baseSize);
  assert.equal(size3, baseSize / 2n);
});
