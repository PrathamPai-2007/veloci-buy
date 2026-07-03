'use strict';
import assert from 'node:assert/strict';
import test from 'node:test';
import { GhostTrader } from '../src/ml/ghost-trader.js';
import { MlService } from '../src/ml/ml-service.js';
import { EvaluationResult, TrainingSample } from '../src/types/index.js';
import { createCtx } from './_test_helpers.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvalResult(
  mint: string,
  score: number,
  usdPrice = 0.00001,
  overrides: Partial<EvaluationResult> = {}
): EvaluationResult {
  return {
    approved: true,
    blockers: [],
    rejectionReasons: [],
    notes: [],
    candidateScore: score,
    volatilityScaler: 1.0,
    launchpadProfile: { name: 'pumpfun' },
    adjustedThresholds: { minLiquidityUsd: 500 },
    token: {
      id: mint,
      symbol: mint.toUpperCase(),
      liquidity: 1000,
      fdv: 50000,
      holderCount: 40,
      organicScore: 5,
      usdPrice,
      isVerified: true,
      website: 'x',
      twitter: 'y',
      stats5m: { numBuys: 30, numSells: 10 },
      firstPool: { createdAt: new Date(Date.now() - 300_000).toISOString() },
      priceHistory: [{ price: 1 }, { price: 1.1 }],
    },
    ...overrides,
  } as unknown as EvaluationResult;
}

function makeFakeMlService(): MlService {
  return {
    runParamOptimizerNow: async () => {},
    runEntryTunerNow: async () => {},
  } as unknown as MlService;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('notifyCandidate is a no-op before start()', () => {
  const gt = new GhostTrader();
  gt.notifyCandidate(makeEvalResult('ABC', 70));
  assert.equal(gt.getCandidateQueueLength(), 0);
});

test('notifyCandidate fills queue after start()', () => {
  const gt = new GhostTrader();
  const ctx = createCtx({ minCandidateScore: 60 });
  gt.start(ctx, makeFakeMlService());
  gt.notifyCandidate(makeEvalResult('ABC', 70));
  gt.notifyCandidate(makeEvalResult('XYZ', 65));
  assert.equal(gt.getCandidateQueueLength(), 2);
  gt.stop();
});

test('notifyCandidate filters out candidates below minScore', () => {
  process.env.GHOST_MIN_SCORE = '75';
  const gt = new GhostTrader();
  const ctx = createCtx({ minCandidateScore: 60 });
  gt.start(ctx, makeFakeMlService());
  gt.notifyCandidate(makeEvalResult('LOW', 60)); // below threshold
  gt.notifyCandidate(makeEvalResult('HIGH', 80)); // above threshold
  assert.equal(gt.getCandidateQueueLength(), 1);
  gt.stop();
  delete process.env.GHOST_MIN_SCORE;
});

test('notifyCandidate caps queue at 50 entries', () => {
  const gt = new GhostTrader();
  const ctx = createCtx({ minCandidateScore: 0 });
  gt.start(ctx, makeFakeMlService());
  for (let i = 0; i < 60; i++) {
    gt.notifyCandidate(makeEvalResult(`MINT${i}`, 70));
  }
  assert.equal(gt.getCandidateQueueLength(), 50);
  gt.stop();
});

test('tick opens a ghost from the highest-scoring candidate', async () => {
  process.env.GHOST_TICK_INTERVAL_MS = '999999'; // prevent auto-tick
  const gt = new GhostTrader();
  const ctx = createCtx({ minCandidateScore: 0 });
  gt.start(ctx, makeFakeMlService());

  gt.notifyCandidate(makeEvalResult('LOW', 62, 0.0001));
  gt.notifyCandidate(makeEvalResult('HIGH', 90, 0.0002));
  gt.notifyCandidate(makeEvalResult('MED', 75, 0.00015));

  await (gt as any)._tick();

  assert.equal(gt.getGhostCount(), 1);
  const ghost = gt.getGhost('HIGH');
  assert.ok(ghost, 'highest-score candidate should be ghosted');
  assert.equal(ghost!.entryScore, 90);
  assert.equal(gt.getCandidateQueueLength(), 2); // HIGH removed from queue

  gt.stop();
  delete process.env.GHOST_TICK_INTERVAL_MS;
});

test('tick does not open duplicate ghost for same mint', async () => {
  const gt = new GhostTrader();
  const ctx = createCtx({ minCandidateScore: 0 });
  gt.start(ctx, makeFakeMlService());

  gt.notifyCandidate(makeEvalResult('DUP', 80, 0.0001));
  await (gt as any)._tick();
  assert.equal(gt.getGhostCount(), 1);

  // Re-add same mint and tick again
  gt.notifyCandidate(makeEvalResult('DUP', 80, 0.0001));
  await (gt as any)._tick();
  assert.equal(gt.getGhostCount(), 1, 'should not open a second ghost for the same mint');

  gt.stop();
});

test('stop-loss trigger: label=0 when price drops below SL threshold', async () => {
  const savedSamples: TrainingSample[] = [];
  const gt = new GhostTrader();
  const ctx = createCtx({ stopLossPct: 0.2, takeProfitMultiples: [1.5], minCandidateScore: 0 });
  ctx.store.addTrainingSample = (s) => savedSamples.push(s);
  gt.start(ctx, makeFakeMlService());

  const entryPrice = 0.001;
  gt.notifyCandidate(makeEvalResult('SL_TOKEN', 75, entryPrice));
  await (gt as any)._tick(); // opens ghost

  // Simulate price dropping 25% (below 20% SL)
  ctx.state.marketSnapshots.set('SL_TOKEN', {
    launchpad: 'pumpfun',
    usdPrice: entryPrice * 0.75,
  });
  await (gt as any)._tick(); // should trigger SL and close

  assert.equal(savedSamples.length, 1);
  assert.equal(savedSamples[0]!.label, 0);
  assert.equal(gt.getGhostCount(), 0);

  gt.stop();
});

test('take-profit trigger: label=1 when price hits tp[0]', async () => {
  const savedSamples: TrainingSample[] = [];
  const gt = new GhostTrader();
  const ctx = createCtx({ stopLossPct: 0.2, takeProfitMultiples: [1.5], minCandidateScore: 0 });
  ctx.store.addTrainingSample = (s) => savedSamples.push(s);
  gt.start(ctx, makeFakeMlService());

  const entryPrice = 0.001;
  gt.notifyCandidate(makeEvalResult('TP_TOKEN', 75, entryPrice));
  await (gt as any)._tick(); // opens ghost

  // Price hits 1.5× TP target
  ctx.state.marketSnapshots.set('TP_TOKEN', {
    launchpad: 'pumpfun',
    usdPrice: entryPrice * 1.5,
  });
  await (gt as any)._tick(); // should trigger TP and close

  assert.equal(savedSamples.length, 1);
  assert.equal(savedSamples[0]!.label, 1);
  assert.equal(gt.getGhostCount(), 0);

  gt.stop();
});

test('trailing stop trigger: label=0 when price retreats from peak', async () => {
  const savedSamples: TrainingSample[] = [];
  const gt = new GhostTrader();
  const ctx = createCtx({
    stopLossPct: 0.2,
    takeProfitMultiples: [2.0],
    trailingStopDrawdownPct: 0.2,
    minCandidateScore: 0,
  });
  ctx.store.addTrainingSample = (s) => savedSamples.push(s);
  gt.start(ctx, makeFakeMlService());

  const entryPrice = 0.001;
  gt.notifyCandidate(makeEvalResult('TRAIL_TOKEN', 75, entryPrice));
  await (gt as any)._tick(); // opens ghost

  // Price rises to arm trailing stop (≥ midpoint of 1.0 and 2.0 = 1.5×)
  ctx.state.marketSnapshots.set('TRAIL_TOKEN', {
    launchpad: 'pumpfun',
    usdPrice: entryPrice * 1.6,
  });
  await (gt as any)._tick(); // updates high water mark, no exit

  // Price drops 20% from peak (1.6 * 0.8 = 1.28×) — triggers trailing stop
  ctx.state.marketSnapshots.set('TRAIL_TOKEN', {
    launchpad: 'pumpfun',
    usdPrice: entryPrice * 1.6 * 0.79,
  });
  await (gt as any)._tick(); // should close via trailing stop

  assert.equal(savedSamples.length, 1);
  assert.equal(savedSamples[0]!.label, 1, 'exit above entry is still a win');
  assert.equal(gt.getGhostCount(), 0);

  gt.stop();
});

test('max-hold force-close: label=0 regardless of final price (momentum faded without hitting a target)', async () => {
  const savedSamples: TrainingSample[] = [];
  process.env.GHOST_MAX_HOLD_MINUTES = '0'; // 0 min = immediate expiry after first tick
  const gt = new GhostTrader();
  const ctx = createCtx({ stopLossPct: 0.2, takeProfitMultiples: [1.5], minCandidateScore: 0 });
  ctx.store.addTrainingSample = (s) => savedSamples.push(s);
  gt.start(ctx, makeFakeMlService());

  const entryPrice = 0.001;
  gt.notifyCandidate(makeEvalResult('HOLD_TOKEN', 75, entryPrice));

  // Manually inject a ghost with old openedAt to bypass normal tick-open
  const fakeGhost = {
    mint: 'HOLD_TOKEN',
    symbol: 'HOLD_TOKEN',
    entryPriceUsd: entryPrice,
    entryScore: 75,
    highestPriceUsd: entryPrice,
    openedAt: Date.now() - 1, // immediately expired
    featuresJson: '[]',
    tpProfile: null,
    launchpad: null,
    targetsHit: 0,
  };
  (gt as any).ghosts.set('HOLD_TOKEN', fakeGhost);
  ctx.state.marketSnapshots.set('HOLD_TOKEN', {
    launchpad: 'pumpfun',
    usdPrice: entryPrice * 1.1, // 10% profit
  });

  await (gt as any)._tick();

  assert.equal(savedSamples.length, 1);
  assert.equal(savedSamples[0]!.label, 0, 'max-hold without hitting a TP → label=0');

  gt.stop();
  delete process.env.GHOST_MAX_HOLD_MINUTES;
});
