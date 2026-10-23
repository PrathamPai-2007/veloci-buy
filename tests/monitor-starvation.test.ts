import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { localMarketState } from '../src/services/market-state/local-market-state.js';
import { monitorPositions } from '../src/services/monitor/monitor.service.js';
import { securityAuditWorker } from '../src/services/monitor/security-audit-worker.js';
import { createCtx, createTestPosition } from './_test_helpers.js';

describe('Section 7: RPC Starvation & Bounded Background Audit Test', () => {
  it('executes 10 monitor ticks smoothly during heavy RPC 429 storms with 0 aborted ticks', async () => {
    localMarketState.clear();
    securityAuditWorker.clear();

    const mint = 'StarvationTestMint111111111111111111111';

    // Seed local market state
    localMarketState.updateSnapshot({
      mint,
      venue: 'pumpfun',
      priceUsd: 0.005,
      liquidityUsd: 25000,
      fdvUsd: 5000000,
      totalSupply: 1_000_000_000_000_000n,
      updatedAt: Date.now(),
      sourceSlot: 200,
      source: 'test',
      status: 'authoritative',
      buyVolume1m: 50,
      sellVolume1m: 10,
      tradeCount1m: 30,
      top5ConcentrationPct: 15,
      top10ConcentrationPct: 25,
      holderCount: 150,
    });

    const ctx = createCtx({ paperTrading: false });
    const pos = createTestPosition({
      mint,
      symbol: 'STARVE',
      name: 'Starve Test Token',
      decimals: 6,
      entryPriceUsd: 0.005,
      entryLiquidityUsd: 25000,
      initialTokenAmountRaw: '2000000000',
      lastKnownBalanceRaw: '2000000000',
      lastKnownPriceUsd: 0.005,
      highestPriceUsd: 0.005,
      openedAt: new Date(Date.now() - 60000).toISOString(), // 60s old, due for security audit
    });
    ctx.store.state.positions.set(mint, pos);

    // Mock RPC calls: audit call takes 100ms (in flight during rapid ticks) and throws 429
    ctx.rpc = {
      getTokenAccountsByOwner: () => ({
        send: async () => {
          throw new Error('HTTP 429 Too Many Requests (getTokenAccountsByOwner)');
        },
      }),
      getTokenLargestAccounts: () => ({
        send: async () => {
          await new Promise((r) => setTimeout(r, 100));
          throw new Error('HTTP 429 Too Many Requests (getTokenLargestAccounts)');
        },
      }),
      getMultipleAccounts: () => ({
        send: async () => {
          await new Promise((r) => setTimeout(r, 100));
          throw new Error('HTTP 429 Too Many Requests (getMultipleAccounts)');
        },
      }),
    } as any;

    const dummyFetchPrices = async () => ({});

    // Execute 10 monitor ticks rapidly while RPC calls return 429
    for (let i = 0; i < 10; i++) {
      const newPrice = 0.005 * (1 + (i + 1) * 0.02); // +2% per tick
      localMarketState.updateSnapshot({
        ...localMarketState.getSnapshot(mint)!,
        priceUsd: newPrice,
        updatedAt: Date.now() + i * 100,
      });

      const tickStart = Date.now();
      await monitorPositions(ctx, dummyFetchPrices);
      const tickDuration = Date.now() - tickStart;

      // Prove tick duration is fast (< 500ms) and never stalls on 8s RPC timeouts
      assert.ok(
        tickDuration < 500,
        `Tick ${i + 1} should be fast (<500ms), took ${tickDuration}ms`
      );

      // Prove observed price is updated
      assert.equal(
        pos.lastKnownPriceUsd,
        newPrice,
        `Tick ${i + 1} must observe updated local price ${newPrice}`
      );
    }

    // Verify in-flight deduplication by calling triggerSecurityReaudit twice synchronously
    securityAuditWorker.clear();
    securityAuditWorker.triggerSecurityReaudit(ctx, [mint]);
    securityAuditWorker.triggerSecurityReaudit(ctx, [mint]);

    const metrics = ctx.store.state.metrics;

    // Assert key invariants
    assert.equal(
      metrics.monitorTicksAborted ?? 0,
      0,
      'monitorTicksAborted must remain 0 during RPC failures'
    );
    assert.ok((metrics.monitorTicks ?? 0) >= 10, 'monitorTicks must be >= 10');
    assert.ok(
      (metrics.securityAuditsSkippedInFlight ?? 0) >= 1,
      'In-flight audit deduplication should skip duplicate requests'
    );
  });
});
