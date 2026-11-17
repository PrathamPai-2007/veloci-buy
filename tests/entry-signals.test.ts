'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEntrySignals } from '../src/services/entry-signals.js';
import { marketTapeManager } from '../src/services/market-state/market-tape-manager.js';

test('buildEntrySignals snapshots holders, tape and age at entry', () => {
  const mint = 'EntrySignalsMint';
  const now = Date.now();
  marketTapeManager.recordTick(mint, 'buy', 0.5, now - 5_000, 'walletA');
  marketTapeManager.recordTick(mint, 'buy', 0.5, now - 4_000, 'walletB');
  marketTapeManager.recordTick(mint, 'sell', 0.1, now - 3_000, 'walletC');
  const sig = buildEntrySignals(
    {
      id: mint,
      liquidity: 900,
      creator: 'walletC',
      firstPool: { createdAt: new Date(now - 40_000).toISOString() },
    } as never,
    { mintSignals: { top1Share: 0.2, top3Share: 0.3, top5Share: 0.4, holdersKnown: true } } as never,
    now
  );
  assert.equal(sig.ageSeconds, 40);
  assert.equal(sig.liquidityUsd, 900);
  assert.equal(sig.top1Share, 0.2);
  assert.equal(sig.holdersKnown, true);
  assert.equal(sig.tapeBuys, 2);
  assert.equal(sig.tapeUniqueBuyers, 2);
  assert.equal(sig.creatorSold, true);
});
