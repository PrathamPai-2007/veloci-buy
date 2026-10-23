import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { localMarketState } from '#services/market-state/index.js';
import { monitorPositions } from '#services/monitor/monitor.service.js';
import { scheduleSurvivalDelay } from '#services/scanner/scan-scheduler.js';
import { StateStore } from '#core/state/state.store.js';

describe('Post-Migration Simulation & Metrics Benchmark', () => {
  it('Exercises 1 candidate, 1 position, 1 survival window', async () => {
    const store = new StateStore({} as any);

    const posMint = 'PositionMint222';
    const survMint = 'SurvivalMint333';

    const now = Date.now();

    // Populate local market state for position and survival candidate
    localMarketState.updateSnapshot({
      mint: posMint,
      venue: 'pumpfun',
      priceUsd: 0.005,
      liquidityUsd: 50000,
      fdvUsd: 5000000,
      totalSupply: 1_000_000_000n,
      updatedAt: now,
      sourceSlot: 1000,
      source: 'geyser',
      buyVolume1m: 10,
      sellVolume1m: 5,
      tradeCount1m: 15,
      top5ConcentrationPct: 12,
      top10ConcentrationPct: 22,
      holderCount: 300,
    });

    localMarketState.updateSnapshot({
      mint: survMint,
      venue: 'pumpfun',
      priceUsd: 0.001,
      liquidityUsd: 15000,
      fdvUsd: 1000000,
      totalSupply: 1_000_000_000n,
      updatedAt: now,
      sourceSlot: 1001,
      source: 'geyser',
      buyVolume1m: 20,
      sellVolume1m: 2,
      tradeCount1m: 22,
      top5ConcentrationPct: 15,
      top10ConcentrationPct: 25,
      holderCount: 150,
    });

    // 1. Position Monitor Check
    const mockCtx: any = {
      state: {
        positions: new Map([[posMint, { mint: posMint, openedAt: now }]]),
        vaultSubscriptions: new Set(),
      },
      config: { jupiterPositionApiKey: 'test-key' },
      store,
      logger: () => {},
    };

    let externalPricesCalled = false;
    await monitorPositions(mockCtx, async () => {
      externalPricesCalled = true;
      return {};
    });

    // 2. Survival Window Check
    const survCtx: any = {
      config: { survivalDelaySeconds: 1.5 },
      store,
      state: {
        pendingCandidateRechecks: new Map([[survMint, {} as any]]),
        prefetchedMintSignals: new Map(),
      },
    };

    const workItem = {
      token: { id: survMint, usdPrice: 0.001 } as any,
    };

    scheduleSurvivalDelay(survCtx, workItem, 85);

    // Verify Metrics
    const metrics = store.state.metrics;

    assert.equal(externalPricesCalled, false, 'Jupiter position price fetch should NOT be called');
    assert.equal(metrics.localMarketReads! >= 1, true, 'localMarketReads should be >= 1');
    assert.equal(metrics.localMarketMisses ?? 0, 0, 'localMarketMisses should be 0');
    assert.equal(metrics.externalPriceFallbacks ?? 0, 0, 'externalPriceFallbacks should be 0');
    assert.equal(metrics.jupiterPriceRequests, 0, 'jupiterPriceRequests should be 0');
    assert.equal(
      metrics.getTokenLargestAccountsRequests,
      0,
      'getTokenLargestAccountsRequests should be 0'
    );
    assert.equal(metrics.getMultipleAccountsRequests, 0, 'getMultipleAccountsRequests should be 0');
  });
});
