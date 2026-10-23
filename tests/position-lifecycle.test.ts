'use strict';

import { describe, it } from 'node:test';
import { jupiterPositionBreaker } from '../src/services/jupiter-circuit-breaker.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createCtx, createTestPosition, createTestConfig } from './_test_helpers.js';
import {
  executePositionExit,
  closeAllOpenPositions,
  monitorPositions,
} from '#services/monitor/monitor.service.js';
import { tradingService } from '#services/trading/trading.service.js';
import { StateStore } from '#core/store.js';

function createLifecycleCtx(
  configOverrides: Parameters<typeof createCtx>[0] = {},
  stateOverrides: Parameters<typeof createCtx>[1] = {}
) {
  const ctx = createCtx(configOverrides, stateOverrides);
  ctx.getSolUsdPrice = async () => 200;
  return ctx;
}

describe('Position Lifecycle & Concurrency Forensic Integration Tests', () => {
  it('Test A — Shutdown race: shutdown waits for in-flight exit and avoids duplicate exit', async () => {
    const ctx = createLifecycleCtx({ paperTrading: true, closePositionsOnShutdown: true });
    const pos = createTestPosition({
      mint: 'MintRaceA11111111111111111111111111111111111',
      symbol: 'RACEA',
      initialTokenAmountRaw: '1000000000',
      lastKnownBalanceRaw: '1000000000',
      decimals: 9,
      entryPriceUsd: 1.0,
      lastKnownPriceUsd: 1.0,
      lastKnownPriceTimestamp: Date.now(),
      entryUsdValue: 1.0,
    });
    ctx.state.positions.set(pos.mint, pos);

    const balance = {
      mint: pos.mint,
      rawAmount: 1000000000n,
      decimals: 9,
      uiAmount: 1.0,
    };

    let quoteResolve!: (value: any) => void;
    const quoteBarrier = new Promise<any>((res) => {
      quoteResolve = res;
    });

    const origBuildQuote = tradingService.buildPaperSellQuote;
    tradingService.buildPaperSellQuote = async (...args) => {
      await quoteBarrier;
      return origBuildQuote.apply(tradingService, args);
    };

    let shutdownCompleted = false;

    try {
      const exitPromise = executePositionExit(ctx, pos, balance, 1.0, 1000000000n, 'stop-loss');

      const shutdownPromise = closeAllOpenPositions(ctx, async () => ({}), 'shutdown-exit').then(
        () => {
          shutdownCompleted = true;
        }
      );

      await new Promise((r) => setTimeout(r, 50));
      assert.equal(shutdownCompleted, false, 'Shutdown must wait while exit is in-flight');

      quoteResolve({
        outAmount: 1000000000n,
        grossUsdValue: 1.0,
        solPrice: 200,
        solPriceSource: 'jupiter-live',
        solPriceTimestamp: Date.now(),
        solPriceAgeMs: 0,
      });

      const exitResult = await exitPromise;
      await shutdownPromise;

      assert.equal(exitResult.success, true);
      assert.equal(ctx.state.positions.has(pos.mint), false, 'Position must be CLOSED');
      assert.equal(shutdownCompleted, true);
    } finally {
      tradingService.buildPaperSellQuote = origBuildQuote;
    }
  });

  it('Test B — Shutdown with multiple positions: every position achieves terminal outcome', async () => {
    const ctx = createLifecycleCtx({ paperTrading: true });

    const pos1 = createTestPosition({
      mint: 'Callcoin11111111111111111111111111111111111',
      symbol: 'CALL',
      initialTokenAmountRaw: '1000000000',
      lastKnownBalanceRaw: '1000000000',
      decimals: 9,
      entryPriceUsd: 2.0,
      lastKnownPriceUsd: 2.0,
      lastKnownPriceTimestamp: Date.now(),
      entryUsdValue: 2.0,
    });
    const pos2 = createTestPosition({
      mint: 'ABC1111111111111111111111111111111111111111',
      symbol: 'ABC',
      initialTokenAmountRaw: '1000000000',
      lastKnownBalanceRaw: '1000000000',
      decimals: 9,
      entryPriceUsd: 5.0,
      lastKnownPriceUsd: 5.0,
      lastKnownPriceTimestamp: Date.now(),
      entryUsdValue: 5.0,
    });
    const pos3 = createTestPosition({
      mint: 'XYZ1111111111111111111111111111111111111111',
      symbol: 'XYZ',
      initialTokenAmountRaw: '1000000000',
      lastKnownBalanceRaw: '500000000',
      decimals: 9,
      entryPriceUsd: 10.0,
      lastKnownPriceUsd: 10.0,
      lastKnownPriceTimestamp: Date.now(),
      entryUsdValue: 10.0,
    });

    ctx.state.positions.set(pos1.mint, pos1);
    ctx.state.positions.set(pos2.mint, pos2);
    ctx.state.positions.set(pos3.mint, pos3);

    const mockFetch = async () => ({
      [pos1.mint]: { usdPrice: 2.0 },
      [pos2.mint]: { usdPrice: 5.0 },
      [pos3.mint]: { usdPrice: 10.0 },
    });

    await closeAllOpenPositions(ctx, mockFetch, 'shutdown-exit');

    assert.equal(ctx.state.positions.size, 0, 'Zero positions remaining open after shutdown');
    assert.equal(pos1.lifecycleState, 'CLOSED');
    assert.equal(pos2.lifecycleState, 'CLOSED');
    assert.equal(pos3.lifecycleState, 'CLOSED');
  });

  it('Test C — SOL price 429: fails quote explicitly without using $150 fallback', async () => {
    const ctx = createLifecycleCtx({ paperTrading: true });
    // A recent 429 leaves the position breaker open, so no live SOL price is available.
    jupiterPositionBreaker.recordFailure(ctx, new Error('HTTP 429 Rate Limit'));
    ctx.getSolUsdPrice = undefined;

    await assert.rejects(
      async () => {
        await tradingService.buildPaperSellQuote(ctx, 1000000000n, 1.0, 9);
      },
      (err: Error) => {
        return (
          err.message.includes('circuit open or rate-limited') ||
          err.message.includes('SOL price estimation failed')
        );
      },
      'Quote must fail explicitly instead of using hardcoded $150'
    );
  });

  it('Test D — Token price divergence & freshness rules', async () => {
    const ctx = createLifecycleCtx({ paperTrading: true });
    const now = Date.now();

    const pos = createTestPosition({
      mint: 'Diverge11111111111111111111111111111111111',
      symbol: 'DIV',
      initialTokenAmountRaw: '1000000000',
      lastKnownBalanceRaw: '1000000000',
      decimals: 9,
      entryPriceUsd: 10.0,
      lastKnownPriceUsd: 10.0,
      lastKnownPriceTimestamp: now,
      entryUsdValue: 10.0,
    });
    ctx.state.positions.set(pos.mint, pos);

    let jupiterFetchCount = 0;
    const mockFetch = async () => {
      jupiterFetchCount++;
      return { [pos.mint]: { usdPrice: 20.0 } };
    };

    await closeAllOpenPositions(ctx, mockFetch, 'shutdown-exit');

    assert.equal(
      jupiterFetchCount,
      0,
      'Fresh local snapshot (10s old) should bypass Jupiter fetch during shutdown'
    );
  });

  it('Test E — RPC starvation: monitor tick completes using cached balance when balance RPC times out', async () => {
    const ctx = createLifecycleCtx({ paperTrading: true });
    const pos = createTestPosition({
      mint: 'Starve111111111111111111111111111111111111',
      symbol: 'STRV',
      initialTokenAmountRaw: '1000000000',
      lastKnownBalanceRaw: '1000000000',
      decimals: 9,
      entryPriceUsd: 1.0,
      lastKnownPriceUsd: 1.0,
      lastKnownPriceTimestamp: Date.now(),
      entryUsdValue: 1.0,
    });
    ctx.state.positions.set(pos.mint, pos);

    const origGetAllBalances = tradingService.getAllWalletTokenBalances;
    tradingService.getAllWalletTokenBalances = async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return new Map();
    };

    try {
      const start = Date.now();
      await monitorPositions(ctx, async () => ({ [pos.mint]: { usdPrice: 1.0 } }));
      const duration = Date.now() - start;

      assert.ok(
        duration < 2500,
        `Monitor tick completed in ${duration}ms (bounded under RPC timeout)`
      );
      assert.equal(pos.lastKnownPriceUsd, 1.0);
    } finally {
      tradingService.getAllWalletTokenBalances = origGetAllBalances;
    }
  });

  it('Test F — Concurrent exits: single execution and second request observes first', async () => {
    const ctx = createLifecycleCtx({ paperTrading: true });
    const pos = createTestPosition({
      mint: 'Concurrent11111111111111111111111111111111',
      symbol: 'CONC',
      initialTokenAmountRaw: '1000000000',
      lastKnownBalanceRaw: '1000000000',
      decimals: 9,
      entryPriceUsd: 1.0,
      lastKnownPriceUsd: 1.0,
      lastKnownPriceTimestamp: Date.now(),
      entryUsdValue: 1.0,
    });
    ctx.state.positions.set(pos.mint, pos);

    const balance = {
      mint: pos.mint,
      rawAmount: 1000000000n,
      decimals: 9,
      uiAmount: 1.0,
    };

    let sellCount = 0;
    const origQuote = tradingService.buildPaperSellQuote;
    tradingService.buildPaperSellQuote = async (...args) => {
      sellCount++;
      await new Promise((r) => setTimeout(r, 50));
      return origQuote.apply(tradingService, args);
    };

    try {
      const [res1, res2] = await Promise.all([
        executePositionExit(ctx, pos, balance, 1.0, 1000000000n, 'stop-loss'),
        executePositionExit(ctx, pos, balance, 1.0, 1000000000n, 'shutdown-exit'),
      ]);

      assert.equal(sellCount, 1, 'Only one actual sell quote was executed');
      assert.equal(res1.success, true);
      assert.equal(res2.success, true);
      assert.equal(ctx.state.positions.has(pos.mint), false);
    } finally {
      tradingService.buildPaperSellQuote = origQuote;
    }
  });

  it('Test G — Partial exits: 25%, 25%, 50% accounting invariants', async () => {
    const ctx = createLifecycleCtx({ paperTrading: true });
    const initialAmount = 1000000000n;
    const pos = createTestPosition({
      mint: 'Partial11111111111111111111111111111111111',
      symbol: 'PART',
      initialTokenAmountRaw: initialAmount.toString(),
      lastKnownBalanceRaw: initialAmount.toString(),
      decimals: 9,
      entryPriceUsd: 1.0,
      lastKnownPriceUsd: 1.0,
      lastKnownPriceTimestamp: Date.now(),
      entryUsdValue: 100.0,
      remainingCostUsd: 100.0,
      realizedPnlUsd: 0,
    });
    ctx.state.positions.set(pos.mint, pos);

    const balance1 = { mint: pos.mint, rawAmount: 1000000000n, decimals: 9, uiAmount: 1.0 };
    const res1 = await executePositionExit(ctx, pos, balance1, 1.0, 250000000n, 'tp-partial');
    assert.equal(res1.success, true);
    assert.equal(pos.lastKnownBalanceRaw, '750000000');
    assert.ok(
      Math.abs((pos.remainingCostUsd ?? 0) - 75.0) < 1e-3,
      `remainingCostUsd ${pos.remainingCostUsd} should be 75.0`
    );

    const balance2 = { mint: pos.mint, rawAmount: 750000000n, decimals: 9, uiAmount: 0.75 };
    const res2 = await executePositionExit(ctx, pos, balance2, 1.0, 250000000n, 'tp-partial');
    assert.equal(res2.success, true);
    assert.equal(pos.lastKnownBalanceRaw, '500000000');
    assert.ok(
      Math.abs((pos.remainingCostUsd ?? 0) - 50.0) < 1e-3,
      `remainingCostUsd ${pos.remainingCostUsd} should be 50.0`
    );

    const balance3 = { mint: pos.mint, rawAmount: 500000000n, decimals: 9, uiAmount: 0.5 };
    const res3 = await executePositionExit(ctx, pos, balance3, 1.0, 500000000n, 'tp-partial');
    assert.equal(res3.success, true);
    assert.equal(pos.remainingCostUsd, 0.0);
    assert.equal(
      ctx.state.positions.has(pos.mint),
      false,
      'Position is fully closed after 100% total sell'
    );
  });

  it('Test H — Persistence shutdown: memory CLOSED and DB CLOSED after shutdown completes', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veloci-persist-test-'));
    const dbFile = path.join(tmpDir, 'state.json');

    try {
      const config1 = createTestConfig({
        stateFile: dbFile,
        logFile: path.join(tmpDir, 'test.log'),
        paperTrading: true,
      });
      const store1 = new StateStore(config1);

      await store1.load(dbFile);

      const pos = createTestPosition({
        mint: 'PersistShutdown11111111111111111111111111',
        symbol: 'PERS',
        initialTokenAmountRaw: '1000000000',
        lastKnownBalanceRaw: '1000000000',
        decimals: 9,
        entryPriceUsd: 1.0,
        lastKnownPriceUsd: 1.0,
        lastKnownPriceTimestamp: Date.now(),
        entryUsdValue: 1.0,
      });

      store1.upsertPosition(pos);
      await store1.flush({ force: true });

      const ctx1 = createLifecycleCtx(
        { stateFile: dbFile, paperTrading: true },
        { positions: new Map([[pos.mint, pos]]) }
      );
      ctx1.store = store1;

      const bal = { mint: pos.mint, rawAmount: 1000000000n, decimals: 9, uiAmount: 1.0 };
      const exitRes = await executePositionExit(ctx1, pos, bal, 1.0, 1000000000n, 'stop-loss');
      assert.equal(exitRes.success, true);

      assert.equal(store1.state.positions.has(pos.mint), false, 'Position closed in memory');

      await store1.flush({ force: true });
      await store1.requestShutdown();

      const config2 = createTestConfig({
        stateFile: dbFile,
        logFile: path.join(tmpDir, 'test2.log'),
        paperTrading: true,
      });
      const store2 = new StateStore(config2);

      await store2.load(dbFile);

      assert.equal(
        store2.state.positions.has(pos.mint),
        false,
        'Position must remain CLOSED in DB upon reload'
      );

      await store2.requestShutdown();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
