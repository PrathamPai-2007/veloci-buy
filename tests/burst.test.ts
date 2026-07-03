'use strict';
import { createCtx } from './_test_helpers.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeBurstCandidate,
  getBurstExitDecision,
  getBurstTakeProfitPlan,
} from '../src/services/burst/index.js';
import { Position, TokenMetadata, WalletBalance } from '../src/types/index.js';

const now = Date.now();

function burstToken(overrides: Partial<TokenMetadata> = {}): TokenMetadata {
  return {
    id: 'BurstMint',
    symbol: 'BRST',
    name: 'Burst Token',
    decimals: 6,
    usdPrice: 1.22,
    liquidity: 5000,
    stats5m: { numBuys: 18, numSells: 3 },
    ...overrides,
  };
}

test('burst engine approves early buy-dominant momentum', () => {
  const ctx = createCtx({ burstModeEnabled: true });
  const result = analyzeBurstCandidate(
    ctx,
    burstToken(),
    [
      { price: 1, timestamp: now - 8000 },
      { price: 1.04, timestamp: now - 6000 },
      { price: 1.09, timestamp: now - 4000 },
      { price: 1.16, timestamp: now - 2000 },
    ],
    1,
    5000,
    { buys: 1, sells: 1 },
    [
      { buys: 1, sells: 1, timestamp: now - 8000 },
      { buys: 8, sells: 2, timestamp: now - 4000 },
      { buys: 18, sells: 3, timestamp: now - 1000 },
    ]
  );

  assert.equal(result.approved, true);
  assert.ok(result.entryMomentum >= 1.2);
  assert.ok(result.buySellRatio >= 1.5);
});

test('burst engine rejects post-peak dumps before entry', () => {
  const ctx = createCtx({ burstModeEnabled: true, burstMaxEntryDrawdownPct: 8 });
  const result = analyzeBurstCandidate(
    ctx,
    burstToken({ usdPrice: 1.08 }),
    [
      { price: 1, timestamp: now - 8000 },
      { price: 1.35, timestamp: now - 4000 },
      { price: 1.22, timestamp: now - 2000 },
    ],
    1,
    5000,
    { buys: 1, sells: 1 },
    [
      { buys: 1, sells: 1 },
      { buys: 12, sells: 2 },
      { buys: 18, sells: 3 },
    ]
  );

  assert.equal(result.approved, false);
  assert.ok(result.blockers.some((b) => b.includes('drawdown')));
});

test('burst engine rejects buy velocity decay and high sell pressure', () => {
  const ctx = createCtx({ burstModeEnabled: true, burstMinBuySellRatio: 2 });
  const decayed = analyzeBurstCandidate(
    ctx,
    burstToken({ stats5m: { numBuys: 12, numSells: 4 } }),
    [
      { price: 1, timestamp: now - 8000 },
      { price: 1.08, timestamp: now - 6000 },
      { price: 1.14, timestamp: now - 4000 },
      { price: 1.2, timestamp: now - 2000 },
    ],
    1,
    5000,
    { buys: 1, sells: 1 },
    [
      { buys: 1, sells: 1 },
      { buys: 11, sells: 2 },
      { buys: 12, sells: 4 },
    ]
  );
  assert.equal(decayed.approved, false);
  assert.ok(decayed.blockers.some((b) => b.includes('velocity')));

  const sellPressure = analyzeBurstCandidate(
    ctx,
    burstToken({ stats5m: { numBuys: 10, numSells: 8 } }),
    [
      { price: 1, timestamp: now - 8000 },
      { price: 1.07, timestamp: now - 6000 },
      { price: 1.12, timestamp: now - 4000 },
      { price: 1.18, timestamp: now - 2000 },
    ],
    1,
    5000,
    { buys: 1, sells: 1 },
    []
  );
  assert.equal(sellPressure.approved, false);
  assert.ok(sellPressure.blockers.some((b) => b.includes('buy/sell')));
});

test('burst take-profit plan resolves fast de-risk settings', () => {
  const ctx = createCtx({ burstTrailingDrawdownPct: 0.18, burstMaxHoldMinutes: 10 });
  const plan = getBurstTakeProfitPlan(ctx);

  assert.equal(plan.profileId, 'burst-fast-de-risk');
  assert.deepEqual(plan.takeProfitMultiples, [1.06, 1.12]);
  assert.deepEqual(plan.takeProfitFractions, [0.75, 0.25]);
  assert.equal(plan.trailingStopDrawdownPct, 0.18);
  assert.equal(plan.maxHoldMinutesResolved, 10);
});

function burstPosition(overrides: Partial<Position> = {}): Position {
  return {
    mint: 'BurstMint',
    symbol: 'BRST',
    name: 'Burst Token',
    decimals: 6,
    openedAt: new Date(now - 120_000).toISOString(),
    mode: 'paper',
    entryPriceUsd: 1,
    entryUsdValue: 100,
    entryScore: 80,
    initialTokenAmountRaw: '100000000',
    highestPriceUsd: 1.3,
    partiallyClosed: false,
    takeProfitMultiples: [1.2, 1.6],
    takeProfitFractions: [0.6, 0.3],
    trailingStopDrawdownPctResolved: 0.18,
    maxHoldMinutesResolved: 10,
    volatilityScaler: 0,
    entryLiquidityUsd: 5000,
    targetsHit: 0,
    entryProfile: 'burst',
    burstTrailingDrawdownPct: 0.18,
    ...overrides,
  };
}

const balance: WalletBalance = {
  mint: 'BurstMint',
  rawAmount: 100_000_000n,
  decimals: 6,
  uiAmount: 100,
};

test('burst monitor exits on trailing drawdown', () => {
  const ctx = createCtx({ burstTrailingDrawdownPct: 0.18 });
  const decision = getBurstExitDecision(ctx, burstPosition(), balance, 1.05, now);

  assert.equal(decision?.reason, 'burst-trailing-exit');
  assert.equal(decision?.sellRaw, balance.rawAmount);
});

test('burst monitor exits stale positions by max hold', () => {
  const ctx = createCtx({ burstMaxHoldMinutes: 10 });
  const decision = getBurstExitDecision(
    ctx,
    burstPosition({
      openedAt: new Date(now - 601_000).toISOString(),
      highestPriceUsd: 1.1,
    }),
    balance,
    1.1,
    now
  );

  assert.equal(decision?.reason, 'burst-time-exit');
});

test('burst monitor de-risks early failure with full exit', () => {
  const ctx = createCtx({
    burstMinMomentum: 1.02,
    earlyPerformanceGuardSeconds: 15,
    earlyPerformanceSellPct: 50,
  });
  const decision = getBurstExitDecision(
    ctx,
    burstPosition({
      openedAt: new Date(now - 5000).toISOString(),
      highestPriceUsd: 1,
    }),
    balance,
    1,
    now
  );

  assert.equal(decision?.reason, 'burst-early-failure');
  assert.equal(decision?.sellRaw, 100_000_000n);
});

test('burst take-profit plan uses burstTakeProfitMultiples from config', () => {
  const ctx = createCtx({
    burstTrailingDrawdownPct: 0.04,
    burstMaxHoldMinutes: 2,
    burstTakeProfitMultiples: [1.06, 1.12],
    burstTakeProfitFractions: [0.75, 0.25],
  });
  const plan = getBurstTakeProfitPlan(ctx);

  assert.deepEqual(plan.takeProfitMultiples, [1.06, 1.12]);
  assert.deepEqual(plan.takeProfitFractions, [0.75, 0.25]);
  assert.equal(plan.trailingStopDrawdownPct, 0.04);
  assert.equal(plan.maxHoldMinutesResolved, 2);
});
