'use strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestConfig, serializeForSnapshot } from './_test_helpers.js';
import { StateStore } from '../src/core/store.js';
import { StatePersistence } from '../src/core/state/state.persistence.js';
import { SQLiteDb } from '../src/core/db.js';
import { Position, RecheckItem, MarketSnapshot, ClosedTrade } from '../src/types/index.js';

function makeTempDir(): {
  dir: string;
  stateFile: string;
  dbPath: string;
  logFile: string;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veloci-buy-snapshot-test-'));
  return {
    dir,
    stateFile: path.join(dir, 'state.json'),
    dbPath: path.join(dir, 'state.db'),
    logFile: path.join(dir, 'bot.log'),
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function createSyncPersistence(config: any, dbPath: string): { store: StateStore; db: SQLiteDb } {
  const sqlite = new SQLiteDb(dbPath, config.logFile);
  sqlite.init();
  const db = sqlite.db;

  const stmts: Record<string, any> = {
    upsertPosition: db.prepare(
      'INSERT OR REPLACE INTO positions (mint, symbol, name, opened_at, entry_price_usd, data) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    removePosition: db.prepare('DELETE FROM positions WHERE mint = ?'),
    addClosedTrade: db.prepare(
      'INSERT INTO closed_trades (mint, symbol, exit_reason, realized_pnl_usd, realized_pnl_sol, closed_at, data, is_ghost) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ),
    upsertRecheck: db.prepare('INSERT OR REPLACE INTO rechecks (mint, data) VALUES (?, ?)'),
    removeRecheck: db.prepare('DELETE FROM rechecks WHERE mint = ?'),
    upsertMetric: db.prepare('INSERT OR REPLACE INTO metrics (key, value) VALUES (?, ?)'),
    trackMint: db.prepare('INSERT OR REPLACE INTO processed_mints (mint, timestamp) VALUES (?, ?)'),
    untrackMint: db.prepare('DELETE FROM processed_mints WHERE mint = ?'),
    upsertKV: db.prepare('INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)'),
    upsertCooldown: db.prepare('INSERT OR REPLACE INTO cooldowns (mint, data) VALUES (?, ?)'),
    removeCooldown: db.prepare('DELETE FROM cooldowns WHERE mint = ?'),
    upsertRetired: db.prepare('INSERT OR REPLACE INTO retired_mints (mint, data) VALUES (?, ?)'),
    removeRetired: db.prepare('DELETE FROM retired_mints WHERE mint = ?'),
    upsertLaunch: db.prepare(
      'INSERT OR REPLACE INTO launch_history (mint, timestamp, data) VALUES (?, ?, ?)'
    ),
    upsertSnapshot: db.prepare('INSERT OR REPLACE INTO snapshots (mint, data) VALUES (?, ?)'),
    removeSnapshot: db.prepare('DELETE FROM snapshots WHERE mint = ?'),
    addTrainingSample: db.prepare(
      'INSERT INTO ml_training_samples (mint, symbol, label, features_json, realized_pnl_usd, entry_score, tp_profile, launchpad, closed_at, exit_reason, hold_seconds, highest_price_usd, targets_hit, entry_price_usd, sequence_json, hold_time_series_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ),
  };

  const persistence = new StatePersistence(config);
  persistence['_sqlite'] = sqlite;
  persistence['_shutdownRequested'] = false;
  // Write-through: run each queued write immediately so the test can read it back.
  persistence['_enqueueWrite'] = (stmt: string, params: any[]) => {
    const statement = stmts[stmt];
    if (!statement) return;
    const processed = params.map((p) =>
      typeof p === 'object' && p !== null ? JSON.stringify(p) : p
    );
    statement.run(...processed);
  };

  persistence.flush = async () => {};
  persistence.persist = async () => {};

  const store = new StateStore(config);
  store.persistence = persistence;

  return { store, db: sqlite };
}

test('state persistence round-trip: persisted fields match after DB reload', async (t) => {
  const { stateFile, dbPath, logFile, cleanup } = makeTempDir();
  const config = createTestConfig({ stateFile, logFile });

  const { store, db } = createSyncPersistence(config, dbPath);

  store.persistence.loadFromDb(store.state);

  const position: Position = {
    mint: 'PositionMint1',
    symbol: 'POS',
    name: 'Position Token',
    decimals: 9,
    openedAt: '2024-01-01T00:00:00.000Z',
    mode: 'paper',
    entryPriceUsd: 0.001,
    entryUsdValue: 100,
    entryScore: 85,
    initialTokenAmountRaw: '100000000',
    moonBagRaw: '5000000',
    highestPriceUsd: 0.002,
    partiallyClosed: false,
    takeProfitMultiples: [1.15, 1.75],
    takeProfitFractions: [0.75, 0.6],
    trailingStopDrawdownPctResolved: 0.16,
    maxHoldMinutesResolved: 20,
    volatilityScaler: 1,
    entryLiquidityUsd: 5000,
    targetsHit: 0,
    launchpad: 'pump.fun',
    tpProfile: 'low-confidence',
  } as Position;
  store.upsertPosition(position);

  const closedTrade: ClosedTrade = {
    mint: 'ClosedMint1',
    symbol: 'CLS',
    closedAt: '2024-01-01T01:00:00.000Z',
    entryPriceUsd: 0.001,
    exitPriceUsd: 0.0015,
    entryUsdValue: 100,
    realizedPnlUsd: 50,
    realizedPnlSol: 0.025,
    exitReason: 'take-profit',
    realizedProceedsUsd: 150,
    highestPriceUsd: 0.002,
    holdSeconds: 3600,
    entryScore: 80,
    trailingStopDrawdownPctResolved: 0.16,
    maxHoldMinutesResolved: 20,
    volatilityScaler: 1,
    entryLiquidityUsd: 5000,
    targetsHit: 0,
  } as ClosedTrade;
  store.addClosedTrade(closedTrade);

  const snapshotMint = 'SnapMint1';
  const snapshot: MarketSnapshot = {
    usdPrice: 0.001,
    liquidity: 5000,
    launchpad: 'pump.fun',
    observedAt: '2024-01-01T00:00:00.000Z',
  } as MarketSnapshot;
  store.updateMarketSnapshot(snapshotMint, snapshot);

  const entry: RecheckItem = {
    mint: 'RecheckMint1',
    tokenSnapshot: {
      id: 'RecheckMint1',
      symbol: 'RCK',
      name: 'Recheck Token',
      usdPrice: 0.001,
      liquidity: 5000,
    } as any,
    reason: 'low-liquidity',
    scheduledTime: 1700000030000,
    basePriceUsd: 0.001,
    nextEligibleAt: new Date(1700000030000).toISOString(),
    auditAttempts: 1,
    isSurvivalWait: false,
  } as RecheckItem;
  store.upsertRecheckEntry(entry);

  store.startCoolDown('CooldownMint1', 0.001, 1700000300000);
  store.retireMint('RetiredMint1', { reason: 'rug-pull', retiredAt: '2024-01-01T00:00:00.000Z' });
  store.trackMint('TrackedMint1');
  store.trackMint('TrackedMint2');

  store.incrementMetric('discoveredCandidates', 5);
  store.incrementMetric('passedCheapAudit', 3);
  store.incrementMetric('passedAudit', 2);
  store.incrementMetric('boughtPositions', 1);
  store.recordRejection('low-liquidity');
  store.upsertKV('customKey1', 'customValue1');
  store.upsertKV('customKey2', 'customValue2');
  store.upsertKV('paperSolBalanceLamports', '1000000000');
  store.state.paperSolBalanceLamports = '1000000000';

  const originalPersisted = serializeForSnapshot({
    positions: Array.from(store.state.positions.values()),
    closedTrades: store.state.closedTrades,
    marketSnapshots: Array.from(store.state.marketSnapshots.entries()),
    pendingCandidateRechecks: Array.from(store.state.pendingCandidateRechecks.entries()),
    processedMints: Array.from(store.state.processedMints).sort(),
    coolDownMints: Array.from(store.state.coolDownMints.entries()),
    retiredMints: Array.from(store.state.retiredMints.entries()),
    metrics: store.state.metrics,
    paperSolBalanceLamports: store.state.paperSolBalanceLamports,
    tradeHistory: store.state.tradeHistory,
  });

  const freshStore = new StateStore(config);
  freshStore.persistence = store.persistence;
  freshStore.persistence.loadFromDb(freshStore.state);

  const reloadedPersisted = serializeForSnapshot({
    positions: Array.from(freshStore.state.positions.values()),
    closedTrades: freshStore.state.closedTrades,
    marketSnapshots: Array.from(freshStore.state.marketSnapshots.entries()),
    pendingCandidateRechecks: Array.from(freshStore.state.pendingCandidateRechecks.entries()),
    processedMints: Array.from(freshStore.state.processedMints).sort(),
    coolDownMints: Array.from(freshStore.state.coolDownMints.entries()),
    retiredMints: Array.from(freshStore.state.retiredMints.entries()),
    metrics: freshStore.state.metrics,
    paperSolBalanceLamports: freshStore.state.paperSolBalanceLamports,
    tradeHistory: freshStore.state.tradeHistory,
  });

  t.assert.snapshot(originalPersisted);
  t.assert.snapshot(reloadedPersisted);

  t.assert.deepEqual(reloadedPersisted, originalPersisted);

  db.close();
  cleanup();
});

test('state persistence round-trip: empty state matches default state', async (t) => {
  const { stateFile, dbPath, logFile, cleanup } = makeTempDir();
  const config = createTestConfig({ stateFile, logFile });

  const { store, db } = createSyncPersistence(config, dbPath);

  store.persistence.loadFromDb(store.state);

  const originalState = serializeForSnapshot({
    positions: Array.from(store.state.positions.entries()),
    processedMints: Array.from(store.state.processedMints).sort(),
    pendingCandidateRechecks: Array.from(store.state.pendingCandidateRechecks.entries()),
    marketSnapshots: Array.from(store.state.marketSnapshots.entries()),
    coolDownMints: Array.from(store.state.coolDownMints.entries()),
    retiredMints: Array.from(store.state.retiredMints.entries()),
    closedTrades: store.state.closedTrades,
    metrics: store.state.metrics,
    tradeHistory: store.state.tradeHistory,
    paperSolBalanceLamports: store.state.paperSolBalanceLamports,
  });

  const freshStore = new StateStore(config);
  freshStore.persistence = store.persistence;
  freshStore.persistence.loadFromDb(freshStore.state);

  const reloadedState = serializeForSnapshot({
    positions: Array.from(freshStore.state.positions.entries()),
    processedMints: Array.from(freshStore.state.processedMints).sort(),
    pendingCandidateRechecks: Array.from(freshStore.state.pendingCandidateRechecks.entries()),
    marketSnapshots: Array.from(freshStore.state.marketSnapshots.entries()),
    coolDownMints: Array.from(freshStore.state.coolDownMints.entries()),
    retiredMints: Array.from(freshStore.state.retiredMints.entries()),
    closedTrades: freshStore.state.closedTrades,
    metrics: freshStore.state.metrics,
    tradeHistory: freshStore.state.tradeHistory,
    paperSolBalanceLamports: freshStore.state.paperSolBalanceLamports,
  });

  t.assert.snapshot(originalState);
  t.assert.snapshot(reloadedState);

  t.assert.deepEqual(reloadedState, originalState);

  db.close();
  cleanup();
});

test('state persistence snapshot: SQLite schema and row counts', async (t) => {
  const { stateFile, dbPath, logFile, cleanup } = makeTempDir();
  const config = createTestConfig({ stateFile, logFile });

  const { store, db } = createSyncPersistence(config, dbPath);
  store.persistence.loadFromDb(store.state);

  store.trackMint('MintA');
  store.trackMint('MintB');

  const pos: Position = {
    mint: 'PosA',
    symbol: 'A',
    name: 'A',
    decimals: 9,
    openedAt: '2024-01-01T00:00:00.000Z',
    mode: 'paper',
    entryPriceUsd: 0.001,
    entryUsdValue: 100,
    entryScore: 80,
    initialTokenAmountRaw: '1000',
    highestPriceUsd: 0.001,
    partiallyClosed: false,
    takeProfitMultiples: [1.15],
    takeProfitFractions: [0.6],
    trailingStopDrawdownPctResolved: 0.16,
    maxHoldMinutesResolved: 20,
    volatilityScaler: 1,
    entryLiquidityUsd: 5000,
  } as Position;
  store.upsertPosition(pos);

  store.updateMarketSnapshot('SnapA', {
    usdPrice: 0.001,
    liquidity: 5000,
    launchpad: 'pump.fun',
    observedAt: '2024-01-01T00:00:00.000Z',
  });

  store.startCoolDown('CoolA', 0.001, 1700000300000);
  store.retireMint('RetiredA', { reason: 'test', retiredAt: '2024-01-01T00:00:00.000Z' });
  store.upsertRecheckEntry({
    mint: 'RecheckA',
    tokenSnapshot: { id: 'RecheckA' } as any,
    reason: 'test',
    scheduledTime: 1700000010000,
    basePriceUsd: 0.001,
  });

  store.addClosedTrade({
    mint: 'ClosedA',
    symbol: 'CL',
    closedAt: '2024-01-01T01:00:00.000Z',
    entryPriceUsd: 0.001,
    entryUsdValue: 100,
    realizedPnlUsd: 50,
    realizedPnlSol: 0.025,
    exitReason: 'time-exit',
    realizedProceedsUsd: 150,
    highestPriceUsd: 0.002,
    holdSeconds: 3600,
    entryScore: 80,
    trailingStopDrawdownPctResolved: 0.16,
    maxHoldMinutesResolved: 20,
    volatilityScaler: 1,
    entryLiquidityUsd: 5000,
    targetsHit: 0,
  } as ClosedTrade);

  store.incrementMetric('profitableTrades', 1);
  store.upsertKV('customKey1', 'customValue1');
  store.upsertKV('customKey2', 'customValue2');
  store.upsertKV('paperSolBalanceLamports', '1000000000');
  store.state.paperSolBalanceLamports = '1000000000';

  const dbHandle = db.db;
  const tables = dbHandle
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];

  const tableNames = tables.map((tt) => tt.name);
  const rowCounts: Record<string, number> = {};
  for (const table of tableNames) {
    const result = dbHandle.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get() as {
      cnt: number;
    };
    rowCounts[table] = result.cnt;
  }

  const snapshot = serializeForSnapshot({ tableNames, rowCounts });
  t.assert.snapshot(snapshot);

  db.close();
  cleanup();
});
