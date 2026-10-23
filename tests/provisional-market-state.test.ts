import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LocalMarketStateStore } from '#services/market-state/local-market-state.js';

describe('Provisional vs Authoritative Market Snapshot Behavior', () => {
  it('Seeds provisional snapshot on discovery and atomically promotes to authoritative on real Geyser update', () => {
    const store = new LocalMarketStateStore();
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    // 1. Seed initial discovery snapshot
    store.seedInitialPumpFunSnapshot(mint, 200);

    const seededSnap = store.getSnapshot(mint);
    assert.ok(seededSnap !== null);
    assert.equal(seededSnap.status, 'provisional', 'Initial seeded snapshot must be provisional');
    assert.equal(
      store.isAuthoritative(mint),
      false,
      'isAuthoritative must return false for provisional state'
    );

    // 2. Simulate first REAL Geyser account update arriving from Solana stream
    const accepted = store.updateSnapshot({
      mint,
      venue: 'pumpfun',
      priceUsd: 0.005,
      liquidityUsd: 15000,
      fdvUsd: 500000,
      totalSupply: 1_000_000_000_000_000n,
      updatedAt: Date.now(),
      sourceSlot: 12345678,
      source: 'geyser-stream',
      status: 'authoritative',
      buyVolume1m: 5000,
      sellVolume1m: 1000,
      tradeCount1m: 45,
      top5ConcentrationPct: 15,
      top10ConcentrationPct: 25,
      holderCount: 150,
    });

    assert.equal(accepted, true, 'Real update accepted');

    const authoritativeSnap = store.getSnapshot(mint);
    assert.ok(authoritativeSnap !== null);
    assert.equal(authoritativeSnap.status, 'authoritative', 'Promoted to authoritative');
    assert.equal(authoritativeSnap.priceUsd, 0.005, 'Price updated to real value');
    assert.equal(authoritativeSnap.liquidityUsd, 15000, 'Liquidity updated to real value');
    assert.equal(
      store.isAuthoritative(mint),
      true,
      'isAuthoritative returns true after real update'
    );
  });
});
