import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { localMarketState } from '../src/services/market-state/local-market-state.js';
import { monitorPositions } from '../src/services/monitor/monitor.service.js';
import { securityAuditWorker } from '../src/services/monitor/security-audit-worker.js';
import { createCtx, createTestPosition } from './_test_helpers.js';

describe('Section 6: Critical Position Monitor Resilience Test', () => {
  it('evaluates local price updates and exits cleanly even when balance & audit RPCs throw 429 or block', async () => {
    localMarketState.clear();
    securityAuditWorker.clear();

    const mint = 'ResilientPosMint11111111111111111111111111';

    // Seed local market state at entryPrice = 1.00
    localMarketState.updateSnapshot({
      mint,
      venue: 'pumpfun',
      priceUsd: 1.0,
      liquidityUsd: 10000,
      fdvUsd: 1000000,
      totalSupply: 1_000_000_000_000_000n,
      updatedAt: Date.now(),
      sourceSlot: 100,
      source: 'test',
      status: 'authoritative',
      buyVolume1m: 10,
      sellVolume1m: 0,
      tradeCount1m: 5,
      top5ConcentrationPct: 10,
      top10ConcentrationPct: 20,
      holderCount: 50,
    });

    const ctx = createCtx({ paperTrading: false });
    const pos = createTestPosition({
      mint,
      symbol: 'RESILIENT',
      name: 'Resilient Token',
      decimals: 6,
      entryPriceUsd: 1.0,
      entryLiquidityUsd: 10000,
      initialTokenAmountRaw: '1000000000',
      lastKnownBalanceRaw: '1000000000',
      lastKnownPriceUsd: 1.0,
      highestPriceUsd: 1.0,
      openedAt: new Date().toISOString(),
      remainingCostUsd: 100,
      remainingCostSol: 0.5,
    });
    ctx.store.state.positions.set(mint, pos);

    // Mock RPC methods:
    // 1. getTokenAccountsByOwner throws HTTP 429
    // 2. getTokenLargestAccounts / audit methods block > 8s / throw 429
    ctx.rpc = {
      getTokenAccountsByOwner: () => ({
        send: async () => {
          throw new Error('HTTP 429 Too Many Requests (getTokenAccountsByOwner)');
        },
      }),
      getTokenLargestAccounts: () => ({
        send: async () => {
          await new Promise((r) => setTimeout(r, 10_000));
          throw new Error('HTTP 429 Too Many Requests (getTokenLargestAccounts)');
        },
      }),
    } as any;

    const dummyFetchPrices = async () => ({});

    // 1. Update local price to 1.10 (+10%)
    localMarketState.updateSnapshot({
      ...localMarketState.getSnapshot(mint)!,
      priceUsd: 1.1,
      updatedAt: Date.now() + 100,
    });

    const tick1Start = Date.now();
    await monitorPositions(ctx, dummyFetchPrices);
    const tick1Duration = Date.now() - tick1Start;

    // Assert tick finished instantly (< 50ms) without waiting for RPC
    assert.ok(
      tick1Duration < 50,
      `Monitor tick 1 duration should be instant (<50ms), got ${tick1Duration}ms`
    );
    assert.equal(pos.lastKnownPriceUsd, 1.1, 'Position lastKnownPriceUsd must be updated to 1.10');
    assert.equal(pos.highestPriceUsd, 1.1, 'Position highestPriceUsd must be updated to 1.10');
    const returnPct1 = ((pos.lastKnownPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;
    assert.equal(Math.round(returnPct1), 10, 'Return % must be +10%');

    // 2. Update local price to 0.90 (-10%)
    localMarketState.updateSnapshot({
      ...localMarketState.getSnapshot(mint)!,
      priceUsd: 0.9,
      updatedAt: Date.now() + 200,
    });

    const tick2Start = Date.now();
    await monitorPositions(ctx, dummyFetchPrices);
    const tick2Duration = Date.now() - tick2Start;

    assert.ok(
      tick2Duration < 50,
      `Monitor tick 2 duration should be instant (<50ms), got ${tick2Duration}ms`
    );
    assert.equal(pos.lastKnownPriceUsd, 0.9, 'Position lastKnownPriceUsd must be updated to 0.90');
    assert.equal(pos.highestPriceUsd, 1.1, 'Highest price must remain preserved at 1.10');
    const returnPct2 = ((pos.lastKnownPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;
    assert.equal(Math.round(returnPct2), -10, 'Return % must be -10%');

    // Assert observability metrics
    const metrics = ctx.store.state.metrics;
    assert.equal(
      metrics.monitorTicksAborted ?? 0,
      0,
      'monitorTicksAborted must remain 0 during RPC failures'
    );
    assert.ok((metrics.monitorTicks ?? 0) >= 2, 'monitorTicks count should be incremented');
  });
});
