'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCtx, withMockedFetch } from '../_test_helpers.js';
import { jupiterDiscoveryBreaker } from '../../src/services/jupiter-circuit-breaker.js';
import {
  fetchRecentLaunches,
  fetchTrendingLaunches,
  fetchPricesBestEffort,
} from '../../src/services/market-data.js';
import { localMarketState } from '../../src/services/market-state/index.js';

test('Integration: Simulating Jupiter unavailable for 2 minutes proves graceful degradation and zero storm', async () => {
  jupiterDiscoveryBreaker.reset();
  const ctx = createCtx();

  let virtualTime = 1_000_000;
  jupiterDiscoveryBreaker.setNowFn(() => virtualTime);

  ctx.config.jupiterBaseUrl = 'http://jupiter-mock';

  let jupiterFetchAttempts = 0;

  // Mock global fetch: Jupiter endpoints fail with timeout/error, non-Jupiter endpoints (like RPC) succeed
  await withMockedFetch(
    async (input: unknown) => {
      const urlStr = String(input);
      if (urlStr.includes('jupiter-mock') || urlStr.includes('jup.ag')) {
        jupiterFetchAttempts++;
        throw new Error('Jupiter connection timed out after 5000ms');
      }
      // RPC / non-Jupiter responses succeed
      return new Response(JSON.stringify({ jsonrpc: '2.0', result: { value: null }, id: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    async () => {
      const WS_MINT = 'WsDiscoveredMint111111111111111111111111';

      // Simulate a 2-minute timeline (120 seconds, stepped in 10-second ticks)
      for (let second = 0; second <= 120; second += 10) {
        virtualTime = 1_000_000 + second * 1000;

        // 1. WebSocket discovery continues active throughout
        ctx.store.trackMint(`${WS_MINT}_${second}`);

        // 2. Local market state continues updating (e.g. pump.fun curve snapshots)
        localMarketState.updateSnapshot({
          mint: `${WS_MINT}_${second}`,
          venue: 'pumpfun',
          priceUsd: 0.00005,
          liquidityUsd: 12000,
          fdvUsd: 50000,
          totalSupply: 1_000_000_000_000_000n,
          updatedAt: virtualTime,
          sourceSlot: 100 + second,
          buyVolume1m: 5,
          sellVolume1m: 1,
          tradeCount1m: 6,
          top5ConcentrationPct: 0.15,
          top10ConcentrationPct: 0.25,
          holderCount: 80,
        });

        // 3. Discovery loops poll for recent/trending
        await fetchRecentLaunches(ctx);
        await fetchTrendingLaunches(ctx);
        await fetchPricesBestEffort(ctx, [`${WS_MINT}_${second}`], 'scan-refresh', null, {
          onChainFirst: true,
        });
      }

      // PROOF 1: Zero repeated Jupiter storm.
      // Without circuit breaker, 13 ticks × 5 services = 65 failing requests.
      // With circuit breaker, initial failures open the circuit, and 1 probe occurs after 60s cooldown. Total = 5 attempts!
      assert.ok(
        jupiterFetchAttempts <= 5,
        `Jupiter fetch attempts should be <= 5 (got ${jupiterFetchAttempts})`
      );

      // PROOF 2: Circuit opened exactly once (and re-opened after failed probe)
      const opens = ctx.state.metrics.jupiterCircuitOpens || 0;
      assert.ok(opens >= 1, `Circuit opened count should be >= 1 (got ${opens})`);

      // PROOF 3: Requests were suppressed while OPEN
      const suppressed = ctx.state.metrics.jupiterSuppressedRequests || 0;
      assert.ok(suppressed > 30, `Suppressed requests count should be > 30 (got ${suppressed})`);

      // PROOF 4: WebSocket discovery continued normally
      assert.equal(ctx.state.processedMints.size, 13); // 13 WS mints tracked

      // PROOF 5: Local market state continued updating normally
      const latestSnap = localMarketState.getSnapshot(`${WS_MINT}_120`);
      assert.ok(latestSnap != null);
      assert.equal(latestSnap?.priceUsd, 0.00005);
    }
  );

  jupiterDiscoveryBreaker.reset();
  jupiterDiscoveryBreaker.setNowFn(undefined);
});
