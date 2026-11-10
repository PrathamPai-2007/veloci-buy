'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeTape, computeTapeScore } from '../src/services/engine/tape-signals.js';
import {
  MarketTapeManager,
  marketTapeManager,
} from '../src/services/market-state/market-tape-manager.js';
import {
  registerLaunch,
  isCopycat,
  _resetLaunchRegistryForTest,
} from '../src/services/market-state/launch-registry.js';
import * as engine from '../src/services/engine/engine.service.js';
import { TAPE_SIGNALS } from '../src/core/config.js';
import type { TapeSignalWeights } from '../src/types/scoring.js';
import type { TokenMetadata } from '../src/types/index.js';
import { createCtx } from './_test_helpers.js';

const NOW = 1_000_000;
const OPTS = { now: NOW, windowSeconds: 60, washWindowSeconds: 10 };
const W: TapeSignalWeights = {
  windowSeconds: 60,
  minTrades: 3,
  liquidityVelocityMax: 6,
  liquidityVelocityFullSolPerSec: 0.1,
  uniqueBuyersMax: 4,
  uniqueBuyersFull: 8,
  washPenalty: 0,
  washWindowSeconds: 10,
  copycatPenalty: 8,
};

function tape(
  rows: [number, 'buy' | 'sell', number, string][]
): ReturnType<MarketTapeManager['getTicks']> {
  const m = new MarketTapeManager();
  for (const [ageSec, side, sol, who] of rows)
    m.recordTick('m', side, sol, NOW - ageSec * 1000, who);
  return m.getTicks('m');
}

test('analyzeTape measures net inflow, unique buyers and the window', () => {
  const sig = analyzeTape(
    tape([
      [120, 'buy', 50, 'old'], // outside the 60s window
      [30, 'buy', 2, 'a'],
      [20, 'buy', 1, 'b'],
      [10, 'buy', 1, 'a'],
      [5, 'sell', 0.5, 'c'],
    ]),
    OPTS
  );
  assert.equal(sig.trades, 4);
  assert.equal(sig.buys, 3);
  assert.equal(sig.uniqueBuyers, 2);
  assert.ok(Math.abs(sig.netInflowSol - 3.5) < 1e-9);
  // 30 s of tape => 3.5 SOL / 30 s
  assert.ok(Math.abs(sig.inflowPerSec - 3.5 / 30) < 1e-9);
});

test('analyzeTape flags round-trip wallets and a creator sale anywhere on the tape', () => {
  const sig = analyzeTape(
    tape([
      [100, 'sell', 1, 'dev'], // 100 s ago: outside the window but still a creator sale
      [20, 'buy', 1, 'w'],
      [15, 'sell', 1, 'w'], // round trip within 10 s? no: 5 s apart => yes
      [14, 'buy', 1, 'z'],
    ]),
    { ...OPTS, creator: 'dev' }
  );
  assert.equal(sig.creatorSold, true);
  assert.equal(sig.roundTripWallets, 1);
  assert.equal(
    analyzeTape(tape([[20, 'buy', 1, 'dev']]), { ...OPTS, creator: 'dev' }).creatorSold,
    false
  );
});

test('computeTapeScore is neutral on thin tape, rewards inflow, punishes outflow', () => {
  const thin = analyzeTape(tape([[5, 'buy', 9, 'a']]), OPTS);
  assert.equal(computeTapeScore(thin, W), 0);

  const hot = analyzeTape(
    tape(
      Array.from({ length: 10 }, (_, i): [number, 'buy', number, string] => [
        30 - i,
        'buy',
        1,
        `w${i}`,
      ])
    ),
    OPTS
  );
  const hotScore = computeTapeScore(hot, W);
  assert.ok(hotScore > 8 && hotScore <= 10, `hot ${hotScore}`); // 6 (velocity) + 4 (buyers) max

  const dump = analyzeTape(
    tape(
      Array.from({ length: 6 }, (_, i): [number, 'sell', number, string] => [
        30 - i,
        'sell',
        1,
        `s${i}`,
      ])
    ),
    OPTS
  );
  assert.ok(computeTapeScore(dump, W) <= -5);

  const wash = analyzeTape(
    tape([
      [9, 'buy', 1, 'w'],
      [8, 'sell', 1, 'w'],
      [7, 'buy', 1, 'x'],
    ]),
    OPTS
  );
  assert.equal(wash.roundTripWallets, 1);
  assert.equal(computeTapeScore(wash, W), computeTapeScore(wash, { ...W, washPenalty: 0 }));
  assert.equal(computeTapeScore(wash, { ...W, washPenalty: 5 }), computeTapeScore(wash, W) - 5);
});

test('launch registry flags later launches reusing a name+symbol, ignoring case and unknowns', () => {
  _resetLaunchRegistryForTest();
  registerLaunch('first', 'Tesla Roadster', 'SOL');
  registerLaunch('second', ' tesla roadster ', 'sol');
  registerLaunch('other', 'Tesla Roadster', 'TSLA');
  registerLaunch('anon1', '?', '?');
  registerLaunch('anon2', '?', '?');
  assert.equal(isCopycat('first'), false);
  assert.equal(isCopycat('second'), true);
  assert.equal(isCopycat('other'), false);
  assert.equal(isCopycat('anon1'), false);
  assert.equal(isCopycat('anon2'), false);
  assert.equal(isCopycat('never-seen'), false);
});

function plainToken(id: string, extra: Partial<TokenMetadata> = {}): TokenMetadata {
  return {
    id,
    symbol: 'T',
    name: 'T',
    decimals: 6,
    usdPrice: 1,
    liquidity: 10_000,
    holderCount: 100,
    stats5m: { numBuys: 20, numSells: 5 },
    ...extra,
  };
}

test('engine: copycat launches lose the configured penalty', async () => {
  _resetLaunchRegistryForTest();
  marketTapeManager.clear();
  registerLaunch('OrigMint', 'Same Name', 'SAME');
  registerLaunch('CopyMint', 'Same Name', 'SAME');
  const ctx = createCtx();
  const orig = await engine.evaluateCandidate(ctx, plainToken('OrigMint'));
  const copy = await engine.evaluateCandidate(ctx, plainToken('CopyMint'));
  assert.ok(orig.candidateScore < 100, 'score must not be clamped for this comparison');
  assert.ok(
    Math.abs(orig.candidateScore - copy.candidateScore - TAPE_SIGNALS.copycatPenalty) < 1e-9,
    `${orig.candidateScore} vs ${copy.candidateScore}`
  );
  assert.ok(copy.notes.some((n) => n.startsWith('Copycat')));
});

test('engine: a creator sale on the tape is a hard, non-recheckable rejection', async () => {
  _resetLaunchRegistryForTest();
  marketTapeManager.clear();
  const mint = 'DevDumpMint';
  marketTapeManager.recordTick(mint, 'buy', 1, Date.now() - 5000, 'buyer');
  marketTapeManager.recordTick(mint, 'sell', 2, Date.now() - 1000, 'CreatorWallet');
  const ctx = createCtx();
  const res = await engine.evaluateCandidate(ctx, plainToken(mint, { creator: 'CreatorWallet' }));
  assert.equal(res.approved, false);
  assert.deepEqual(
    res.rejectionReasons.find((r) => r.code === 'creator-sold'),
    { code: 'creator-sold', recheckEligible: false }
  );
  marketTapeManager.clear();
});

test('engine: hot tape order flow raises the entry score over a quiet tape', async () => {
  _resetLaunchRegistryForTest();
  marketTapeManager.clear();
  const ctx = createCtx();
  const quiet = await engine.evaluateCandidate(ctx, plainToken('QuietMint'));
  const now = Date.now();
  for (let i = 0; i < 10; i++)
    marketTapeManager.recordTick('HotMint', 'buy', 1, now - 30_000 + i * 1000, `w${i}`);
  const hot = await engine.evaluateCandidate(ctx, plainToken('HotMint'));
  assert.ok(
    hot.candidateScore > quiet.candidateScore,
    `${hot.candidateScore} vs ${quiet.candidateScore}`
  );
  assert.ok(hot.notes.some((n) => n.startsWith('[Tape]')));
  marketTapeManager.clear();
});
