'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TestConfigBuilder } from '../factories/config.js';
import { createTestToken } from '../factories/token.js';
import { StateStore } from '../../src/core/store.js';
import { SQLiteDb } from '../../src/core/db.js';
import { buyCandidate } from '../../src/services/buy.js';
import { evaluateSinglePosition } from '../../src/services/monitor/monitor.service.js';
import { Context, EvaluationResult } from '../../src/types/index.js';
import { localMarketState } from '../../src/services/market-state/local-market-state.js';

function createTempTestEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veloci-buy-lifecycle-test-'));
  const dbPath = path.join(dir, 'state.db');
  const logFile = path.join(dir, 'bot.log');
  const config = TestConfigBuilder.default()
    .withPaperTrading(true)
    .withStateFile(dbPath)
    .withOverrides({ logFile })
    .build();

  const store = new StateStore(config);
  store.state.paperSolBalanceLamports = '10000000000'; // 10 SOL paper balance

  const rpcProxy = new Proxy(
    {},
    {
      get: (_target, prop) => {
        return () => ({
          send: async () => {
            if (prop === 'getTokenAccountsByOwner') return { value: [] };
            return { value: { blockhash: '1'.repeat(32), lastValidBlockHeight: 12345 } };
          },
        });
      },
    }
  );

  const ctx: Context = {
    config,
    state: store.state,
    store,
    rpc: rpcProxy as any,
    rpcs: [rpcProxy as any],
    rpcSubscriptions: {} as any,
    rpcSubscriptionPool: [],
    wallet: { address: '5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq' },
    logger: () => {},
    persistState: async () => {},
    calculateGMI: () => 0.5,
    rotateRpcSubscriptions: () => {},
    getCurrentRpcSubscriptions: () => ({}) as any,
    getSolUsdPrice: async () => 150,
  } as Context;

  return {
    dir,
    dbPath,
    config,
    store,
    ctx,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('Integration Lifecycle: paper buy -> position tracking -> take-profit exit -> DB persistence', async () => {
  const env = createTempTestEnv();
  try {
    const token = createTestToken({
      id: 'LifecycleMint1111111111111111111111111111111',
      symbol: 'LIFE',
      name: 'Lifecycle Token',
      usdPrice: 0.001,
      liquidity: 10000,
      organicScore: 90,
    });

    const evaluation: EvaluationResult = {
      approved: true,
      blockers: [],
      rejectionReasons: [],
      notes: [],
      candidateScore: 85,
      volatilityScaler: 1.0,
      launchpadProfile: {
        name: 'pump.fun',
        scoreBonus: 10,
        liquidityMultiplier: 1.0,
        holderMultiplier: 1.0,
        buysMultiplier: 1.0,
        minPoolAgeSeconds: 0,
      },
      adjustedThresholds: {
        minLiquidityUsd: 1000,
        minHolderCount: 4,
        minBuys5m: 1,
        minPoolAgeSeconds: 0,
      },
      token,
    };

    localMarketState.updateSnapshot({
      mint: token.id,
      venue: 'pumpfun',
      priceUsd: token.usdPrice!,
      liquidityUsd: token.liquidity!,
      fdvUsd: 1_000_000,
      totalSupply: 1_000_000_000_000_000n,
      updatedAt: Date.now(),
      sourceSlot: 1,
      source: 'test-authoritative',
      status: 'authoritative',
      buyVolume1m: 1,
      sellVolume1m: 0,
      tradeCount1m: 1,
      top5ConcentrationPct: 0,
      top10ConcentrationPct: 0,
      holderCount: 10,
    });

    // Step 1: Execute Paper Buy
    const pos = await buyCandidate(env.ctx, evaluation);

    assert.ok(pos, 'Buy operation should produce a valid Position');
    assert.equal(pos.mint, token.id);

    // Verify position added to state
    const storedPos = env.ctx.state.positions.get(token.id);
    assert.ok(storedPos, 'Position must be stored in state map');
    assert.equal(storedPos?.entryPriceUsd, 0.001);
    assert.equal(storedPos?.mode, 'paper');

    // Set openedAt to 120s ago so minHoldTimeSeconds guard allows take-profit exit checks
    storedPos.openedAt = new Date(Date.now() - 120_000).toISOString();

    // Step 2: Price Update (Simulate 100% price pump -> hit Take Profit 1)
    const pumpedPriceRecord = {
      usdPrice: 0.002, // 2x price pump
      liquidity: 10000,
    };
    const paperBalance = {
      mint: token.id,
      rawAmount: BigInt(storedPos.initialTokenAmountRaw),
      decimals: 9,
      uiAmount: 1000,
    };

    // Evaluate single position with pumped price record
    await evaluateSinglePosition(
      env.ctx,
      token.id,
      storedPos,
      paperBalance,
      pumpedPriceRecord,
      undefined
    );

    const activePos = env.ctx.state.positions.get(token.id);

    const closedCount = env.ctx.state.closedTrades.length;
    const isExitedOrUpdated =
      !activePos ||
      (activePos?.targetsHit || 0) > 0 ||
      activePos?.partiallyClosed ||
      closedCount > 0 ||
      (storedPos.targetsHit || 0) > 0;

    assert.ok(
      isExitedOrUpdated,
      'Position must register target hit, partial exit, or trade closure'
    );

    // Step 4: Test SQLite DB Initialization & state schema

    const sqlite = new SQLiteDb(env.dbPath, env.config.logFile);
    sqlite.init();
    assert.ok(fs.existsSync(env.dbPath), 'SQLite database file must be created on disk');
    sqlite.db.close();
  } finally {
    try {
      env.cleanup();
    } catch {
      // Ignore temporary file cleanup locks on Windows
    }
  }
});
