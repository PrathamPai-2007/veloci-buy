'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLocalEvalInputs } from '../src/services/scanner/stages/local-inputs.js';
import { marketTapeManager } from '../src/services/market-state/market-tape-manager.js';
import { priceHistoryEngine } from '../src/services/market-state/price-history-engine.js';
import { localMarketState } from '../src/services/market-state/local-market-state.js';
import * as engine from '../src/services/engine/engine.service.js';
import type { RecheckItem, TokenMetadata } from '../src/types/index.js';
import { createCtx } from './_test_helpers.js';

function reset(): void {
  marketTapeManager.clear();
  priceHistoryEngine.clear();
  localMarketState.clear();
}

test('buildLocalEvalInputs without local data passes the token through unchanged', () => {
  reset();
  const token: TokenMetadata = { id: 'NoLocal', symbol: 'N', name: 'N', decimals: 6, usdPrice: 2 };
  const out = buildLocalEvalInputs(token);
  assert.equal(out.token.usdPrice, 2);
  assert.equal(out.token.stats5m, undefined);
  assert.deepEqual(out.priceHistory, []);
  assert.deepEqual(out.tapeHistory, []);
  assert.equal(out.tapeAtStart, null);
  assert.equal(out.highestSeenPriceUsd, 2);
});

test('buildLocalEvalInputs builds price history, tape and high-water mark from local state', () => {
  reset();
  const mint = 'LocalMint';
  const now = 1_000_000;
  const startedAt = now - 20_000;
  const entry: RecheckItem = { mint, survivalStartedAt: startedAt, firstSeenAt: startedAt };

  // 2 buys before the survival window, then 4 buys + 1 sell inside it.
  marketTapeManager.recordTick(mint, 'buy', 1, startedAt - 5_000, 'w1');
  marketTapeManager.recordTick(mint, 'buy', 1, startedAt - 1_000, 'w2');
  for (const [i, side] of (['buy', 'buy', 'sell', 'buy', 'buy'] as const).entries()) {
    marketTapeManager.recordTick(mint, side, 1, startedAt + 2_000 * (i + 1), `x${i}`);
  }
  const prices = [1, 1.1, 1.3, 1.2, 1.25, 1.4];
  prices.forEach((p, i) => priceHistoryEngine.pushPrice(mint, 0, p, startedAt + 3_000 * i));
  priceHistoryEngine.pushPrice(mint, 0, 0.5, startedAt - 10_000); // before the window: excluded
  localMarketState.updateSnapshot({
    mint,
    venue: 'pumpfun',
    priceUsd: 1.4,
    liquidityUsd: 5_000,
    fdvUsd: 1_400_000_000,
    totalSupply: 1_000_000_000_000_000n,
    updatedAt: Date.now(),
    sourceSlot: 0,
    source: 'pump-trade-log',
    status: 'authoritative',
    buyVolume1m: 0,
    sellVolume1m: 0,
    tradeCount1m: 0,
    top5ConcentrationPct: 0,
    top10ConcentrationPct: 0,
    holderCount: 0,
  });

  const token: TokenMetadata = { id: mint, symbol: 'L', name: 'L', decimals: 6, usdPrice: 1 };
  const out = buildLocalEvalInputs(token, entry, now);

  assert.equal(out.token.usdPrice, 1.4, 'fresh local price overrides the carried one');
  assert.equal(out.token.liquidity, 5_000);
  assert.equal(out.priceHistory.length, 6, 'only points inside the survival window');
  assert.equal(out.highestSeenPriceUsd, 1.4);
  assert.deepEqual(out.tapeAtStart, { buys: 2, sells: 0 });
  assert.deepEqual(out.token.stats5m, { numBuys: 6, numSells: 1 });
  assert.equal(out.tapeHistory[0]!.timestamp, startedAt);
  assert.deepEqual(
    { buys: out.tapeHistory[0]!.buys, sells: out.tapeHistory[0]!.sells },
    { buys: 2, sells: 0 }
  );
  const last = out.tapeHistory[out.tapeHistory.length - 1]!;
  assert.deepEqual({ buys: last.buys, sells: last.sells }, { buys: 6, sells: 1 });
});

test('engine: a young or unknown-age mint with zero buys is recheck-eligible, an old one is not', async () => {
  const ctx = createCtx();
  const base: TokenMetadata = {
    id: 'ZeroBuyMint',
    symbol: 'ZB',
    name: 'Zero Buy',
    decimals: 6,
    usdPrice: 1,
    liquidity: 10_000,
    holderCount: 100,
    stats5m: { numBuys: 0, numSells: 0 },
    organicScore: 100,
  };
  const eligible = (r: Awaited<ReturnType<typeof engine.evaluateCandidate>>): boolean | undefined =>
    r.rejectionReasons.find((x) => x.code === 'zero-buys')?.recheckEligible;

  assert.equal(eligible(await engine.evaluateCandidate(ctx, base)), true, 'unknown age');

  const young = { ...base, firstPool: { createdAt: new Date(Date.now() - 30_000).toISOString() } };
  assert.equal(eligible(await engine.evaluateCandidate(ctx, young)), true, '30s old');

  const old = { ...base, firstPool: { createdAt: new Date(Date.now() - 600_000).toISOString() } };
  assert.equal(eligible(await engine.evaluateCandidate(ctx, old)), false, '10m old');
});

test('scheduler carries the survival baseline forward and gives up on never-traded mints', async () => {
  const { scheduleSurvivalDelay, scheduleFinalAudit, scheduleRecheckEligibleWaitlist } =
    await import('../src/services/scanner/scan-scheduler.js');
  const upserts: RecheckItem[] = [];
  const tracked: string[] = [];
  const ctx = createCtx();
  (ctx as any).store = {
    upsertRecheckEntry: (e: RecheckItem) => upserts.push(e),
    trackMint: (m: string) => tracked.push(m),
    incrementMetric: () => {},
  };
  const token: TokenMetadata = { id: 'Sched', symbol: 'S', name: 'S', decimals: 6, usdPrice: 3 };

  scheduleSurvivalDelay(ctx, { token }, 80);
  const survival = upserts.pop()!;
  assert.ok(survival.survivalStartedAt && survival.firstSeenAt);
  assert.equal(survival.highestSeenPriceUsd, 3);

  scheduleFinalAudit(ctx, { token, recheckEntry: { ...survival, highestSeenPriceUsd: 9 } });
  const final = upserts.pop()!;
  assert.equal(final.survivalStartedAt, survival.survivalStartedAt, 'baseline survives requeue');
  assert.equal(final.highestSeenPriceUsd, 9, 'high-water mark survives requeue');

  // zero-buys waits without burning attempts...
  scheduleRecheckEligibleWaitlist(
    ctx,
    { token, recheckEntry: { mint: 'Sched', auditAttempts: 1 } },
    'zero-buys'
  );
  assert.equal(upserts.pop()!.auditAttempts, 1);
  // ...but not forever.
  scheduleRecheckEligibleWaitlist(
    ctx,
    { token, recheckEntry: { mint: 'Sched', firstSeenAt: Date.now() - 200_000 } },
    'zero-buys'
  );
  assert.deepEqual(tracked, ['Sched']);
  assert.equal(upserts.length, 0);
});
