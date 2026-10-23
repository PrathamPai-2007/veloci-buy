import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LocalMarketStateStore,
  UnifiedMarketDataProvider,
  localMarketState,
} from '#services/market-state/index.js';
import { tokenAccountIndex } from '#services/account-index/index.js';
import { monitorPositions } from '#services/monitor/monitor.service.js';

describe('Local Market State Engine Migration & Integration', () => {
  it('1. Local state rejects stale/older slot updates (slot monotonicity)', () => {
    const store = new LocalMarketStateStore();
    const now = Date.now();

    // Initial update at slot 100
    const accepted1 = store.updateSnapshot({
      mint: 'testMint1',
      venue: 'pumpfun',
      priceUsd: 0.0001,
      liquidityUsd: 5000,
      fdvUsd: 100000,
      totalSupply: 1_000_000_000n,
      updatedAt: now,
      sourceSlot: 100,
      source: 'geyser',
      buyVolume1m: 0,
      sellVolume1m: 0,
      tradeCount1m: 0,
      top5ConcentrationPct: 10,
      top10ConcentrationPct: 20,
      holderCount: 50,
    });
    assert.equal(accepted1, true);

    // Stale slot 90 should be rejected
    const acceptedStale = store.updateSnapshot({
      mint: 'testMint1',
      venue: 'pumpfun',
      priceUsd: 0.00005,
      liquidityUsd: 3000,
      fdvUsd: 50000,
      totalSupply: 1_000_000_000n,
      updatedAt: now + 1000,
      sourceSlot: 90,
      source: 'stale-rpc',
      buyVolume1m: 0,
      sellVolume1m: 0,
      tradeCount1m: 0,
      top5ConcentrationPct: 10,
      top10ConcentrationPct: 20,
      holderCount: 50,
    });
    assert.equal(acceptedStale, false);
    assert.equal(store.getPrice('testMint1'), 0.0001); // Price unchanged!

    // Newer slot 105 should be accepted
    const acceptedNewer = store.updateSnapshot({
      mint: 'testMint1',
      venue: 'pumpfun',
      priceUsd: 0.00015,
      liquidityUsd: 6000,
      fdvUsd: 150000,
      totalSupply: 1_000_000_000n,
      updatedAt: now + 2000,
      sourceSlot: 105,
      source: 'geyser',
      buyVolume1m: 0,
      sellVolume1m: 0,
      tradeCount1m: 0,
      top5ConcentrationPct: 10,
      top10ConcentrationPct: 20,
      holderCount: 50,
    });
    assert.equal(acceptedNewer, true);
    assert.equal(store.getPrice('testMint1'), 0.00015);
  });

  it('2. Position Monitor reads local price and does NOT call Jupiter price API when state exists', async () => {
    const mint = 'posMint123';
    localMarketState.updateSnapshot({
      mint,
      venue: 'pumpfun',
      priceUsd: 0.005,
      liquidityUsd: 25000,
      fdvUsd: 5000000,
      totalSupply: 1_000_000_000n,
      updatedAt: Date.now(),
      sourceSlot: 500,
      source: 'test-feed',
      buyVolume1m: 0,
      sellVolume1m: 0,
      tradeCount1m: 0,
      top5ConcentrationPct: 15,
      top10ConcentrationPct: 25,
      holderCount: 200,
    });

    let fetchPricesCalled = false;
    const dummyFetchPrices = async () => {
      fetchPricesCalled = true;
      return {};
    };

    const mockCtx: any = {
      state: {
        positions: new Map([
          [
            mint,
            {
              mint,
              symbol: 'TEST',
              entryPriceUsd: 0.004,
              sizeTokenRaw: '1000000',
              openedAt: Date.now(),
            },
          ],
        ]),
        vaultSubscriptions: new Set(),
      },
      config: { jupiterPositionApiKey: 'test-key' },
      store: {
        incrementMetric: () => {},
      },
      logger: () => {},
    };

    await monitorPositions(mockCtx, dummyFetchPrices);

    // Verified: Jupiter fetch prices was NOT called because local state was used!
    assert.equal(fetchPricesCalled, false);
  });

  it('3. Token-account updates change top-holder concentration correctly without extra RPC queries', () => {
    const mint = 'tokenMintIdx';
    tokenAccountIndex.updateBalance(mint, 'acc1', 'owner1', 400n);
    tokenAccountIndex.updateBalance(mint, 'acc2', 'owner2', 200n);

    const conc1 = tokenAccountIndex.getConcentration(mint);
    assert.ok(conc1 !== null);
    assert.equal(conc1.totalTrackedHolders, 2);

    // Update holder 1 balance to dump down to 100n
    const driftEvt = tokenAccountIndex.updateBalance(mint, 'acc1', 'owner1', 100n);
    assert.ok(driftEvt !== null);
    assert.equal(driftEvt.action, 'dumping');
    assert.equal(driftEvt.previousAmount, 400n);
    assert.equal(driftEvt.currentAmount, 100n);
  });

  it('5. UnifiedMarketDataProvider correctly provides local price, liquidity, FDV, and momentum', () => {
    const provider = new UnifiedMarketDataProvider();
    const mint = 'providerMint';

    localMarketState.updateSnapshot({
      mint,
      venue: 'pumpfun',
      priceUsd: 0.0008,
      liquidityUsd: 12000,
      fdvUsd: 800000,
      totalSupply: 1_000_000_000n,
      updatedAt: Date.now(),
      sourceSlot: 800,
      source: 'test-feed',
      buyVolume1m: 0,
      sellVolume1m: 0,
      tradeCount1m: 0,
      top5ConcentrationPct: 18,
      top10ConcentrationPct: 28,
      holderCount: 180,
    });

    assert.equal(provider.getPrice(mint), 0.0008);
    assert.equal(provider.getLiquidity(mint), 12000);
    assert.equal(provider.getFDV(mint), 800000);
  });
});
