import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { SQLiteDb } from '../db.js';
import { log, safeJsonStringify } from '../utils.js';
import type { WorkerRequest } from './state.persistence.js';

if (!parentPort) throw new Error('Must run as a worker thread');

const { dbPath, logFile, flushIntervalMs } = workerData as {
  dbPath: string;
  logFile: string;
  flushIntervalMs: number;
};
const sqlite = new SQLiteDb(dbPath, logFile);
sqlite.init();
const db = sqlite.db;

const stmts: Record<string, Database.Statement> = {
  upsertPosition: db.prepare(`
    INSERT OR REPLACE INTO positions (mint, symbol, name, opened_at, entry_price_usd, data)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  removePosition: db.prepare('DELETE FROM positions WHERE mint = ?'),
  addClosedTrade: db.prepare(`
    INSERT INTO closed_trades (mint, symbol, exit_reason, realized_pnl_usd, realized_pnl_sol, closed_at, data, is_ghost)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
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
  addTrainingSample: db.prepare(`
    INSERT INTO ml_training_samples
      (mint, symbol, label, features_json, realized_pnl_usd, entry_score, tp_profile, launchpad, closed_at,
       exit_reason, hold_seconds, highest_price_usd, targets_hit, entry_price_usd, sequence_json, hold_time_series_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
};

const writeQueue: Array<() => void> = [];
let isFlushing = false;
const pendingFlushIds: number[] = [];

function drainPendingFlushIds() {
  for (const id of pendingFlushIds.splice(0)) {
    parentPort?.postMessage({ type: 'flush_complete', id });
  }
}

// Cap consecutive transient re-enqueues so a genuinely stuck batch can never wedge the queue
// into an infinite retry loop (which would spin the worker and grow writeQueue without bound).
const MAX_TRANSIENT_RETRIES = 5;
let transientRetries = 0;
let _inTransientRetry = false;

/** True for retryable SQLite errors (lock contention) — distinct from permanent errors such as
 * constraint violations, bad parameter types, or a full disk, which will never succeed on retry. */
function isTransientSqliteError(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? '';
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return true;
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(
    err instanceof Error ? err.message : String(err)
  );
}

/** Replay each write in its own implicit transaction so good writes still commit; a poisoned
 * write is logged and dropped rather than re-enqueued forever. */
function replayIndividually(writes: Array<() => void>): void {
  for (let i = 0; i < writes.length; i += 1) {
    try {
      writes[i]!();
    } catch (err) {
      log(
        logFile,
        `SQLite worker dropping poisoned write [${i}/${writes.length}]: ${err instanceof Error ? err.message : String(err)}`,
        'error'
      );
    }
  }
}

function flush() {
  if (isFlushing) return; // defer pending acks — drainPendingFlushIds fires in finally
  if (writeQueue.length === 0) {
    drainPendingFlushIds();
    return;
  }
  // Reset retry counter when starting a fresh (non-retry) batch so new writes that
  // arrived while a previous batch was retrying get their full retry budget.
  if (!_inTransientRetry) transientRetries = 0;
  isFlushing = true;
  const batch = writeQueue.splice(0);
  try {
    db.transaction((writes: Array<() => void>) => {
      for (const write of writes) write();
    })(batch);
    _inTransientRetry = false;
    transientRetries = 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isTransientSqliteError(err) && transientRetries < MAX_TRANSIENT_RETRIES) {
      // Transient lock contention: re-enqueue and retry on the next flush tick.
      transientRetries += 1;
      _inTransientRetry = true;
      writeQueue.unshift(...batch);
      log(
        logFile,
        `SQLite worker persistence retry ${transientRetries}/${MAX_TRANSIENT_RETRIES} (transient): ${message}`,
        'warn'
      );
    } else {
      // Permanent error, or transient retries exhausted: isolate the failing write(s) by
      // replaying the batch individually. Drops only the poison, never wedges the queue.
      _inTransientRetry = false;
      transientRetries = 0;
      log(
        logFile,
        `SQLite worker persistence failed (${message}); replaying ${batch.length} writes individually`,
        'error'
      );
      replayIndividually(batch);
    }
  } finally {
    isFlushing = false;
    if (writeQueue.length > 0) {
      flush();
    } else {
      drainPendingFlushIds();
    }
  }
}

const flushTimer = setInterval(flush, flushIntervalMs);

parentPort.on('message', (msg: WorkerRequest) => {
  if (msg.type === 'run') {
    const { stmt, params: rawParams } = msg;
    writeQueue.push(() => {
      // Stringify object parameters in the worker to spare the main thread event loop.
      const params = rawParams.map((p) =>
        typeof p === 'object' && p !== null ? safeJsonStringify(p) : p
      );
      const statement = stmts[stmt];
      if (statement) {
        statement.run(...params);
      } else {
        log(logFile, `SQLite worker: unknown statement '${stmt}' — write dropped`, 'error');
      }
    });
  } else if (msg.type === 'flush') {
    pendingFlushIds.push(msg.id);
    flush();
  } else if (msg.type === 'shutdown') {
    clearInterval(flushTimer);
    flush();
    try {
      sqlite.close();
    } catch {
      // Ignore close errors
    }
    parentPort?.postMessage({ type: 'shutdown_complete', id: msg.id });
    parentPort?.close();
  }
});
