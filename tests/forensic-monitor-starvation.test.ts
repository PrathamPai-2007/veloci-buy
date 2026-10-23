import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { localMarketState } from '../src/services/market-state/local-market-state.js';
import {
  evaluateSinglePosition,
  monitorPositions,
} from '../src/services/monitor/monitor.service.js';
import { tradingService } from '../src/services/trading/trading.service.js';
import { createCtx, createTestPosition, withPatchedMembers } from './_test_helpers.js';

describe('Forensic Audit: Position Monitor & RPC Starvation', () => {
  it('proves position monitor correctly tracks local price updates (1.0 -> 1.10 -> 0.90)', async () => {
    localMarketState.clear();
    const mint = 'TestPosMint111111111111111111111111111111';

    // Seed local market state at entry price = 1.0
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

    const ctx = createCtx();
    const pos = createTestPosition({
      mint,
      symbol: 'TEST',
      name: 'Test Token',
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

    const balance = { mint, rawAmount: 1_000_000_000n, decimals: 6, uiAmount: 1000 };

    // Tick 1: Local price = 1.0
    let pRecord = { usdPrice: localMarketState.getPrice(mint)!, liquidity: 10000 };
    await evaluateSinglePosition(ctx, mint, pos, balance, pRecord, undefined);
    assert.equal(pos.lastKnownPriceUsd, 1.0);
    assert.equal((pos.lastKnownPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd, 0);

    // Tick 2: Update local state to 1.10 (+10%)
    localMarketState.updateSnapshot({
      ...localMarketState.getSnapshot(mint)!,
      priceUsd: 1.1,
      updatedAt: Date.now() + 100,
    });
    pRecord = { usdPrice: localMarketState.getPrice(mint)!, liquidity: 10000 };
    await evaluateSinglePosition(ctx, mint, pos, balance, pRecord, undefined);
    assert.equal(pos.lastKnownPriceUsd, 1.1);
    assert.equal(pos.highestPriceUsd, 1.1);
    const returnPctGain = ((pos.lastKnownPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;
    assert.equal(Math.round(returnPctGain), 10);

    // Tick 3: Update local state to 0.90 (-10%)
    localMarketState.updateSnapshot({
      ...localMarketState.getSnapshot(mint)!,
      priceUsd: 0.9,
      updatedAt: Date.now() + 200,
    });
    pRecord = { usdPrice: localMarketState.getPrice(mint)!, liquidity: 10000 };
    await evaluateSinglePosition(ctx, mint, pos, balance, pRecord, undefined);
    assert.equal(pos.lastKnownPriceUsd, 0.9);
    assert.equal(pos.highestPriceUsd, 1.1); // Highest preserved
    const returnPctLoss = ((pos.lastKnownPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;
    assert.equal(Math.round(returnPctLoss), -10);
  });

  it('demonstrates resilience of monitorPositions() when wallet balance RPC throws 429', async () => {
    localMarketState.clear();
    const mint = 'StarvedMint111111111111111111111111111111';
    localMarketState.updateSnapshot({
      mint,
      venue: 'pumpfun',
      priceUsd: 1.5,
      liquidityUsd: 10000,
      fdvUsd: 1500000,
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
      symbol: 'STARVED',
      name: 'Starved Token',
      decimals: 6,
      entryPriceUsd: 1.0,
      lastKnownPriceUsd: 1.0,
      lastKnownBalanceRaw: '1000000000',
      initialTokenAmountRaw: '1000000000',
      openedAt: new Date().toISOString(),
    });
    ctx.store.state.positions.set(mint, pos);

    const mockFetchPrices = async () => ({});

    await withPatchedMembers(
      tradingService,
      {
        getAllWalletTokenBalances: async () => {
          throw new Error('HTTP 429 Too Many Requests (getAllWalletTokenBalances)');
        },
      },
      async () => {
        // Call monitorPositions - should NOT abort, but fallback to cached balance and evaluate local price
        await monitorPositions(ctx, mockFetchPrices);

        // Assert that pos.lastKnownPriceUsd was updated to 1.50 from local market state!
        assert.equal(
          pos.lastKnownPriceUsd,
          1.5,
          'Position must be evaluated with local price 1.50 despite balance RPC 429'
        );
        assert.equal(
          ctx.store.state.metrics.monitorRpcFailures,
          1,
          'monitorRpcFailures metric should be incremented'
        );
        assert.equal(
          ctx.store.state.metrics.monitorTicksAborted ?? 0,
          0,
          'monitorTicksAborted must remain 0'
        );
      }
    );
  });
});
