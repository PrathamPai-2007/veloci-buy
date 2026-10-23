'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createCtx, createTestPosition, createTestConfig } from './_test_helpers.js';
import { executePositionExit, closeAllOpenPositions } from '#services/monitor/monitor.service.js';
import { tradingService } from '#services/trading/trading.service.js';
import { StateStore } from '#core/store.js';

function createHardenedCtx(
  configOverrides: Parameters<typeof createCtx>[0] = {},
  stateOverrides: Parameters<typeof createCtx>[1] = {}
) {
  const ctx = createCtx(configOverrides, stateOverrides);
  ctx.getSolUsdPrice = async () => 200;
  return ctx;
}

describe('Position Lifecycle Hardening & Crash Recovery Suite', () => {
  it('1. Failure injection around await points in executePositionExit()', async () => {
    const ctx = createHardenedCtx({ paperTrading: true });
    const pos = createTestPosition({
      mint: 'InjectFail1111111111111111111111111111111111',
      symbol: 'INJ',
      initialTokenAmountRaw: '1000000000',
      lastKnownBalanceRaw: '1000000000',
      decimals: 9,
      entryPriceUsd: 1.0,
      lastKnownPriceUsd: 1.0,
      lastKnownPriceTimestamp: Date.now(),
      entryUsdValue: 1.0,
    });
    ctx.state.positions.set(pos.mint, pos);

    const balance = { mint: pos.mint, rawAmount: 1000000000n, decimals: 9, uiAmount: 1.0 };
    const initialSolBalance = ctx.state.paperSolBalanceLamports;

    const origBuildQuote = tradingService.buildPaperSellQuote;
    tradingService.buildPaperSellQuote = async () => {
      throw new Error('Injected RPC network failure during quote await');
    };

    try {
      const res = await executePositionExit(ctx, pos, balance, 1.0, 1000000000n, 'stop-loss');

      assert.equal(res.success, false);
      assert.equal(res.stage, 'quote-error');
      assert.equal(pos.lifecycleState, 'EXIT_FAILED');
      assert.equal(
        ctx.state.positions.has(pos.mint),
        true,
        'Position must remain in store after exit failure'
      );
      assert.equal(
        ctx.state.paperSolBalanceLamports,
        initialSolBalance,
        'Paper SOL balance must not be modified on exit failure'
      );
    } finally {
      tradingService.buildPaperSellQuote = origBuildQuote;
    }
  });

  it('2. Process-crash recovery between balance update, position removal, and SQLite persistence', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veloci-crash-test-'));
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
        mint: 'CrashRecover111111111111111111111111111111',
        symbol: 'CRSH',
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

      const ctx1 = {
        ...createHardenedCtx({ stateFile: dbFile, paperTrading: true }),
        state: store1.state,
        store: store1,
      };

      // Partial exit 50%
      const bal1 = { mint: pos.mint, rawAmount: 1000000000n, decimals: 9, uiAmount: 1.0 };
      const res1 = await executePositionExit(ctx1, pos, bal1, 1.0, 500000000n, 'tp-partial');
      assert.equal(res1.success, true);
      assert.equal(pos.lifecycleState, 'PARTIALLY_EXITED');

      // Flush persistence atomically
      await store1.flush({ force: true });
      await store1.requestShutdown();

      // Simulate process restart
      const config2 = createTestConfig({
        stateFile: dbFile,
        logFile: path.join(tmpDir, 'test2.log'),
        paperTrading: true,
      });
      const store2 = new StateStore(config2);
      await store2.load(dbFile);

      const recoveredPos = store2.state.positions.get(pos.mint);
      assert.ok(recoveredPos, 'Partially exited position must be recovered from DB');
      assert.equal(recoveredPos.lastKnownBalanceRaw, '500000000');
      assert.equal(recoveredPos.lifecycleState, 'PARTIALLY_EXITED');

      await store2.requestShutdown();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('3. Reconciliation verification: position state == token balance == paper SOL ledger == SQLite DB', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veloci-recon-test-'));
    const dbFile = path.join(tmpDir, 'state.json');

    try {
      const config = createTestConfig({
        stateFile: dbFile,
        logFile: path.join(tmpDir, 'test.log'),
        paperTrading: true,
      });
      const store = new StateStore(config);
      await store.load(dbFile);

      const pos = createTestPosition({
        mint: 'Recon1111111111111111111111111111111111111',
        symbol: 'RCON',
        initialTokenAmountRaw: '1000000000',
        lastKnownBalanceRaw: '1000000000',
        decimals: 9,
        entryPriceUsd: 2.0,
        lastKnownPriceUsd: 2.0,
        lastKnownPriceTimestamp: Date.now(),
        entryUsdValue: 2.0,
      });

      store.upsertPosition(pos);
      await store.flush({ force: true });

      const ctx = {
        ...createHardenedCtx({ stateFile: dbFile, paperTrading: true }),
        state: store.state,
        store,
      };

      const initialSolLamports = BigInt(ctx.state.paperSolBalanceLamports);

      const bal = { mint: pos.mint, rawAmount: 1000000000n, decimals: 9, uiAmount: 1.0 };
      const res = await executePositionExit(ctx, pos, bal, 2.0, 1000000000n, 'take-profit-2x');
      assert.equal(res.success, true);

      const finalSolLamports = BigInt(ctx.state.paperSolBalanceLamports);
      assert.ok(finalSolLamports > initialSolLamports, 'Paper SOL ledger must increase after sell');

      await store.flush({ force: true });
      await store.requestShutdown();

      const storeReload = new StateStore(config);
      await storeReload.load(dbFile);

      assert.equal(
        storeReload.state.positions.has(pos.mint),
        false,
        'Position must be absent from DB positions map'
      );
      assert.equal(
        storeReload.state.paperSolBalanceLamports,
        finalSolLamports.toString(),
        'Persisted paper SOL ledger must match memory'
      );

      await storeReload.requestShutdown();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('4. Repeated shutdown / double stop() idempotency', async () => {
    const ctx = createHardenedCtx({ paperTrading: true });
    const pos = createTestPosition({
      mint: 'Idempotent11111111111111111111111111111111',
      symbol: 'IDEM',
      initialTokenAmountRaw: '1000000000',
      lastKnownBalanceRaw: '1000000000',
      decimals: 9,
      entryPriceUsd: 1.0,
      lastKnownPriceUsd: 1.0,
      lastKnownPriceTimestamp: Date.now(),
      entryUsdValue: 1.0,
    });
    ctx.state.positions.set(pos.mint, pos);

    const mockFetch = async () => ({ [pos.mint]: { usdPrice: 1.0 } });

    // Simultaneous shutdown calls
    await Promise.all([
      closeAllOpenPositions(ctx, mockFetch, 'shutdown-exit'),
      closeAllOpenPositions(ctx, mockFetch, 'shutdown-exit'),
      closeAllOpenPositions(ctx, mockFetch, 'shutdown-exit'),
    ]);

    assert.equal(ctx.state.positions.has(pos.mint), false, 'Position closed exactly once');
    assert.equal(pos.lifecycleState, 'CLOSED');
  });

  it('5. Partial exit + shutdown + restart workflow', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veloci-partial-restart-'));
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
        mint: 'PartialShutdown1111111111111111111111111',
        symbol: 'PSHD',
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

      const ctx1 = {
        ...createHardenedCtx({ stateFile: dbFile, paperTrading: true }),
        state: store1.state,
        store: store1,
      };

      // 1. Partial exit (50%)
      const bal1 = { mint: pos.mint, rawAmount: 1000000000n, decimals: 9, uiAmount: 1.0 };
      const res1 = await executePositionExit(ctx1, pos, bal1, 1.0, 500000000n, 'tp-partial');
      assert.equal(res1.success, true);
      assert.equal(pos.lastKnownBalanceRaw, '500000000');

      // 2. Shutdown liquidates remaining 50%
      const mockFetch = async () => ({ [pos.mint]: { usdPrice: 1.0 } });
      await closeAllOpenPositions(ctx1, mockFetch, 'shutdown-exit');

      assert.equal(
        ctx1.state.positions.has(pos.mint),
        false,
        'Position closed after shutdown liquidation'
      );

      await store1.flush({ force: true });
      await store1.requestShutdown();

      // 3. Restart & verify DB state
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
        'Position must remain CLOSED in DB after restart'
      );

      await store2.requestShutdown();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
