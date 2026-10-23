import type Database from 'better-sqlite3';
import { SQLiteDb } from '../db.js';
import { migrateJsonToSqlite } from '../migrate.js';
import { log, safeJsonStringify } from '../utils.js';
import {
  Config,
  State,
  Position,
  RecheckItem,
  MarketSnapshot,
  CoolDownEntry,
  ClosedTrade,
  RetiredMintEntry,
  LaunchHistoryEntry,
  StateMetrics,
  TrainingSample,
} from '#types/index.js';

/** A value safe to bind to a SQLite statement, or an object serialized to JSON on enqueue. */
export type WriteParam = string | number | bigint | null | object;
type BoundParam = string | number | bigint | null;

/** Retry budget for SQLITE_BUSY/LOCKED before a batch is replayed write-by-write. */
const MAX_TRANSIENT_RETRIES = 5;

function isTransientSqliteError(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? '';
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return true;
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(
    err instanceof Error ? err.message : String(err)
  );
}

function prepareWriteStatements(db: Database.Database): Record<string, Database.Statement> {
  return {
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
}

export class StatePersistence {
  private _sqlite: SQLiteDb | null = null;
  private _shutdownRequested = false;
  /**
   * Writes are queued and committed in one transaction every stateFlushIntervalMs on the main
   * thread (better-sqlite3 + WAL handles this volume without a worker).
   */
  private _stmts: Record<string, Database.Statement> | null = null;
  private _writeQueue: Array<{ stmt: string; params: BoundParam[] }> = [];
  private _flushTimer: NodeJS.Timeout | null = null;
  private _transientRetries = 0;

  constructor(private config: Config) {}

  public async init(stateFile: string): Promise<void> {
    if (!stateFile) return;
    const configuredDb = (this.config as { dbFile?: string }).dbFile;
    const dbPath = configuredDb || stateFile.replace(/\.json$/, '.db');
    this._sqlite = new SQLiteDb(dbPath, this.config.logFile);
    this._sqlite.init();

    log(this.config.logFile, `SQLite per-session at ${dbPath} (stateFile: ${stateFile})`, 'info');

    // ML reservoir carryover: import prior samples from shared reservoir into fresh session DB
    const reservoirPath = (this.config as { mlReservoirFile?: string }).mlReservoirFile;
    if (reservoirPath && dbPath !== reservoirPath) {
      await this._importMlReservoir(reservoirPath, dbPath);
    }

    const mintsFile = stateFile.replace(/\.json$/, '_mints.json');
    await migrateJsonToSqlite(stateFile, mintsFile, this._sqlite, this.config.logFile);

    this._stmts = prepareWriteStatements(this._sqlite.db);
    const delayMs = Math.max(1, Number(this.config.stateFlushIntervalMs || 250));
    this._flushTimer = setInterval(() => this._flushQueue(), delayMs);
    this._flushTimer.unref();
  }

  private _enqueueWrite(stmt: string, params: WriteParam[]): void {
    if (this._shutdownRequested || !this._stmts) return;
    // Serialize now: callers keep mutating the objects they pass (positions, snapshots).
    this._writeQueue.push({
      stmt,
      params: params.map((p) =>
        typeof p === 'object' && p !== null ? safeJsonStringify(p) : (p as BoundParam)
      ),
    });
  }

  private _runWrite(write: { stmt: string; params: BoundParam[] }): void {
    const statement = this._stmts?.[write.stmt];
    if (statement) {
      statement.run(...write.params);
    } else {
      log(
        this.config.logFile,
        `SQLite: unknown statement '${write.stmt}' — write dropped`,
        'error'
      );
    }
  }

  /** Commits the queue in one transaction; isolates poisoned writes instead of wedging. */
  private _flushQueue(): void {
    if (!this._sqlite || this._writeQueue.length === 0) return;
    const batch = this._writeQueue.splice(0);
    try {
      this._sqlite.db.transaction(() => {
        for (const write of batch) this._runWrite(write);
      })();
      this._transientRetries = 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isTransientSqliteError(err) && this._transientRetries < MAX_TRANSIENT_RETRIES) {
        this._transientRetries += 1;
        this._writeQueue.unshift(...batch);
        log(
          this.config.logFile,
          `SQLite persistence retry ${this._transientRetries}/${MAX_TRANSIENT_RETRIES} (transient): ${message}`,
          'warn'
        );
        return;
      }
      this._transientRetries = 0;
      log(
        this.config.logFile,
        `SQLite persistence failed (${message}); replaying ${batch.length} writes individually`,
        'error'
      );
      batch.forEach((write, i) => {
        try {
          this._runWrite(write);
        } catch (writeErr) {
          log(
            this.config.logFile,
            `SQLite dropping poisoned write [${i}/${batch.length}]: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
            'error'
          );
        }
      });
    }
  }

  public loadFromDb(state: State): void {
    if (!this._sqlite) return;
    const { db } = this._sqlite;

    // Load Positions
    const positions = db.prepare('SELECT data FROM positions').all() as { data: string }[];
    state.positions = new Map(
      positions.map((p) => {
        const parsed = JSON.parse(p.data) as Position;
        // Positions from the removed burst/swing modes are managed by the standard sniper monitor.
        const legacyProfile = (parsed as { entryProfile?: string }).entryProfile;
        if (legacyProfile && legacyProfile !== 'standard') {
          log(
            this.config.logFile,
            `Position ${parsed.mint} had removed entry profile "${legacyProfile}"; treating as standard.`,
            'warn'
          );
          parsed.entryProfile = 'standard';
        }
        return [parsed.mint, parsed];
      })
    );

    // Load Rechecks
    const rechecks = db.prepare('SELECT data FROM rechecks').all() as { data: string }[];
    state.pendingCandidateRechecks = new Map(
      rechecks.map((r) => {
        const parsed = JSON.parse(r.data) as RecheckItem;
        return [parsed.mint, parsed];
      })
    );

    // Load Metrics
    const metrics = db.prepare('SELECT key, value FROM metrics').all() as {
      key: string;
      value: string;
    }[];
    for (const m of metrics) {
      const key = m.key as keyof StateMetrics;
      if (key === 'exitReasonCounts' || key === 'rejectionReasons') {
        state.metrics[key] = JSON.parse(m.value) as Record<string, number>;
      } else if (typeof state.metrics[key] === 'number') {
        (state.metrics as unknown as Record<string, number>)[key] = Number(m.value);
      }
    }

    // Load Processed Mints
    const mints = db.prepare('SELECT mint FROM processed_mints ORDER BY timestamp ASC').all() as {
      mint: string;
    }[];
    state.processedMintQueue = mints.map((m) => m.mint);
    state.processedMints = new Set(state.processedMintQueue);

    // Load Closed Trades (limit to last 500)
    const closedTrades = db
      .prepare('SELECT data FROM closed_trades ORDER BY id DESC LIMIT 500')
      .all() as { data: string }[];
    state.closedTrades = closedTrades.map((t) => JSON.parse(t.data) as ClosedTrade).reverse();

    // Load Launch History (last 100)
    const launchHistory = db
      .prepare('SELECT data FROM launch_history ORDER BY timestamp DESC LIMIT 100')
      .all() as { data: string }[];
    state.launchHistory = launchHistory
      .map((l) => JSON.parse(l.data) as LaunchHistoryEntry)
      .reverse();

    // Load Cooldowns
    const cooldowns = db.prepare('SELECT mint, data FROM cooldowns').all() as {
      mint: string;
      data: string;
    }[];
    state.coolDownMints = new Map(
      cooldowns.map((c) => [c.mint, JSON.parse(c.data) as CoolDownEntry])
    );

    // Load Retired Mints
    const retired = db.prepare('SELECT mint, data FROM retired_mints').all() as {
      mint: string;
      data: string;
    }[];
    state.retiredMints = new Map(
      retired.map((r) => [r.mint, JSON.parse(r.data) as RetiredMintEntry])
    );

    // Load Market Snapshots
    const snapshots = db.prepare('SELECT mint, data FROM snapshots').all() as {
      mint: string;
      data: string;
    }[];
    state.marketSnapshots = new Map(
      snapshots.map((s) => [s.mint, JSON.parse(s.data) as MarketSnapshot])
    );

    // Load KV Store
    const kv = db.prepare('SELECT key, value FROM kv_store').all() as {
      key: string;
      value: string;
    }[];
    for (const item of kv) {
      if (item.key === 'paperSolBalanceLamports') state.paperSolBalanceLamports = item.value;
      if (item.key === 'tradeHistory') state.tradeHistory = JSON.parse(item.value) as boolean[];
      if (item.key === 'moodPauseUntil')
        state.moodPauseUntil = item.value === 'null' ? null : Number(item.value);
      if (item.key === 'moodPauseTradeCount')
        state.moodPauseTradeCount = item.value === 'null' ? null : Number(item.value);
      if (item.key === 'sessionStartingSolBalanceLamports')
        state.sessionStartingSolBalanceLamports = item.value === 'null' ? null : item.value;
      if (item.key === 'peakSessionSolBalanceLamports')
        state.peakSessionSolBalanceLamports = item.value === 'null' ? null : item.value;
    }

    // Initialize session starting balance if not set (first run of session)
    if (state.sessionStartingSolBalanceLamports == null) {
      state.sessionStartingSolBalanceLamports = state.paperSolBalanceLamports;
      state.peakSessionSolBalanceLamports = state.paperSolBalanceLamports;
      const startVal = state.sessionStartingSolBalanceLamports;
      const peakVal = state.peakSessionSolBalanceLamports;
      this._enqueueWrite('upsertKV', ['sessionStartingSolBalanceLamports', startVal]);
      this._enqueueWrite('upsertKV', ['peakSessionSolBalanceLamports', peakVal]);
    }

    log(
      this.config.logFile,
      `State loaded from SQLite: ${state.positions.size} positions, ${state.processedMints.size} mints.`,
      'info'
    );
  }

  public async flush(_options?: { sync?: boolean; force?: boolean }): Promise<void> {
    if (!this._sqlite || this._shutdownRequested) return;
    this._flushQueue();
  }

  public async persist(options?: { sync?: boolean; force?: boolean }): Promise<void> {
    if (options?.force || options?.sync) {
      await this.flush(options);
    }
  }

  public getKV(key: string): string | null {
    if (!this._sqlite) return null;
    const row = this._sqlite.db.prepare('SELECT value FROM kv_store WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  public getTrainingSamples(limit: number): TrainingSample[] {
    if (!this._sqlite) return [];
    const rows = this._sqlite.db
      .prepare(
        `SELECT mint, symbol, label, features_json, realized_pnl_usd,
                entry_score, tp_profile, launchpad, closed_at,
                exit_reason, hold_seconds, highest_price_usd, targets_hit, entry_price_usd, sequence_json, hold_time_series_json
         FROM ml_training_samples
         ORDER BY closed_at DESC
         LIMIT ?`
      )
      .all(limit) as {
      mint: string;
      symbol: string;
      label: number;
      features_json: string;
      realized_pnl_usd: number;
      entry_score: number;
      tp_profile: string | null;
      launchpad: string | null;
      closed_at: string;
      exit_reason: string | null;
      hold_seconds: number | null;
      highest_price_usd: number | null;
      targets_hit: number | null;
      entry_price_usd: number | null;
      sequence_json: string | null;
      hold_time_series_json: string | null;
    }[];

    return rows.map((r) => ({
      mint: r.mint,
      symbol: r.symbol ?? '',
      label: (r.label === 1 ? 1 : 0) as 0 | 1,
      featuresJson: r.features_json,
      realizedPnlUsd: r.realized_pnl_usd,
      entryScore: r.entry_score ?? 0,
      tpProfile: r.tp_profile,
      launchpad: r.launchpad,
      closedAt: r.closed_at,
      exitReason: r.exit_reason ?? undefined,
      holdSeconds: r.hold_seconds ?? undefined,
      highestPriceUsd: r.highest_price_usd ?? undefined,
      targetsHit: r.targets_hit ?? undefined,
      entryPriceUsd: r.entry_price_usd ?? undefined,
      sequenceJson: r.sequence_json ?? undefined,
      holdTimeSeriesJson: r.hold_time_series_json ?? undefined,
    }));
  }

  public getRecentClosedTrades(limit: number): ClosedTrade[] {
    if (!this._sqlite) return [];
    const rows = this._sqlite.db
      .prepare('SELECT data FROM closed_trades ORDER BY id DESC LIMIT ?')
      .all(limit) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as ClosedTrade).reverse();
  }

  public async requestShutdown(): Promise<void> {
    if (!this._sqlite || this._shutdownRequested) return;
    if (this._flushTimer) clearInterval(this._flushTimer);
    this._flushTimer = null;
    this._flushQueue();
    // A transient lock may have re-queued the batch; make one final attempt before closing.
    if (this._writeQueue.length > 0) this._flushQueue();
    this._shutdownRequested = true;
    this._sqlite.close();
    this._sqlite = null;
    this._stmts = null;
  }

  public runTrackMint(mint: string, now: number): void {
    this._enqueueWrite('trackMint', [mint, now]);
  }
  public runUntrackMint(mint: string): void {
    this._enqueueWrite('untrackMint', [mint]);
  }
  public runRemoveRecheck(mint: string): void {
    this._enqueueWrite('removeRecheck', [mint]);
  }
  public runUpsertPosition(
    mint: string,
    symbol: string,
    name: string,
    openedAt: string | null,
    entryPriceUsd: number,
    data: Position
  ): void {
    this._enqueueWrite('upsertPosition', [mint, symbol, name, openedAt, entryPriceUsd, data]);
  }
  public runRemovePosition(mint: string): void {
    this._enqueueWrite('removePosition', [mint]);
  }
  public runUpsertMetric(key: string, value: string | number | Record<string, number>): void {
    this._enqueueWrite('upsertMetric', [key, value]);
  }
  public runUpsertKV(key: string, value: string | boolean[]): void {
    this._enqueueWrite('upsertKV', [key, value]);
  }
  public runAddClosedTrade(
    mint: string,
    symbol: string,
    exitReason: string,
    pnlUsd: number,
    pnlSol: number,
    closedAt: string | null,
    data: ClosedTrade,
    isGhost: number
  ): void {
    this._enqueueWrite('addClosedTrade', [
      mint,
      symbol,
      exitReason,
      pnlUsd,
      pnlSol,
      closedAt,
      data,
      isGhost,
    ]);
  }
  public runUpsertCooldown(mint: string, data: CoolDownEntry): void {
    this._enqueueWrite('upsertCooldown', [mint, data]);
  }
  public runUpsertSnapshot(mint: string, data: MarketSnapshot): void {
    this._enqueueWrite('upsertSnapshot', [mint, data]);
  }
  public runUpsertLaunch(mint: string, timestamp: number, data: LaunchHistoryEntry): void {
    this._enqueueWrite('upsertLaunch', [mint, timestamp, data]);
  }
  public runUpsertRecheck(mint: string, data: RecheckItem): void {
    this._enqueueWrite('upsertRecheck', [mint, data]);
  }
  public runRemoveCooldown(mint: string): void {
    this._enqueueWrite('removeCooldown', [mint]);
  }
  public runUpsertRetired(mint: string, data: RetiredMintEntry): void {
    this._enqueueWrite('upsertRetired', [mint, data]);
  }
  public runRemoveRetired(mint: string): void {
    this._enqueueWrite('removeRetired', [mint]);
  }
  public runRemoveSnapshot(mint: string): void {
    this._enqueueWrite('removeSnapshot', [mint]);
  }
  public runAddTrainingSample(
    mint: string,
    symbol: string,
    label: number,
    featuresJson: string,
    realizedPnlUsd: number,
    entryScore: number,
    tpProfile: string | null,
    launchpad: string | null,
    closedAt: string,
    exitReason: string | null,
    holdSeconds: number | null,
    highestPriceUsd: number | null,
    targetsHit: number | null,
    entryPriceUsd: number | null,
    sequenceJson: string | null,
    holdTimeSeriesJson: string | null
  ): void {
    this._enqueueWrite('addTrainingSample', [
      mint,
      symbol,
      label,
      featuresJson,
      realizedPnlUsd,
      entryScore,
      tpProfile,
      launchpad,
      closedAt,
      exitReason,
      holdSeconds,
      highestPriceUsd,
      targetsHit,
      entryPriceUsd,
      sequenceJson,
      holdTimeSeriesJson,
    ]);
    // Dual-write to shared reservoir (fire-and-forget, never blocks exit path)
    this._writeToMlReservoir(
      mint,
      symbol,
      label,
      featuresJson,
      realizedPnlUsd,
      entryScore,
      tpProfile,
      launchpad,
      closedAt,
      exitReason,
      holdSeconds,
      highestPriceUsd,
      targetsHit,
      entryPriceUsd,
      sequenceJson,
      holdTimeSeriesJson
    );
  }

  private async _importMlReservoir(reservoirPath: string, sessionDbPath: string): Promise<void> {
    try {
      const fs = await import('node:fs');
      if (!fs.existsSync(reservoirPath)) return;
      const { default: Database } = await import('better-sqlite3');
      const reservoir = new (Database as unknown as new (
        p: string,
        o?: unknown
      ) => {
        prepare: (s: string) => {
          all: (...a: unknown[]) => unknown[];
          run: (...a: unknown[]) => unknown;
        };
        pragma: (s: string) => unknown;
        close: () => void;
      })(reservoirPath, { readonly: true } as unknown as Record<string, unknown>);
      try {
        const rows = (
          reservoir as unknown as {
            prepare: (s: string) => { all: (...a: unknown[]) => unknown[] };
          }
        )
          .prepare(
            `SELECT mint, symbol, label, features_json, realized_pnl_usd, entry_score, tp_profile, launchpad, closed_at, exit_reason, hold_seconds, highest_price_usd, targets_hit, entry_price_usd, sequence_json, hold_time_series_json FROM ml_training_samples ORDER BY closed_at DESC LIMIT 20000`
          )
          .all() as Array<Record<string, unknown>>;
        if (rows.length === 0) return;
        const insert = this._sqlite!.db.prepare(
          `INSERT OR IGNORE INTO ml_training_samples (mint, symbol, label, features_json, realized_pnl_usd, entry_score, tp_profile, launchpad, closed_at, exit_reason, hold_seconds, highest_price_usd, targets_hit, entry_price_usd, sequence_json, hold_time_series_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        const tx = this._sqlite!.db.transaction((batch: typeof rows) => {
          for (const r of batch) {
            insert.run(
              r.mint,
              r.symbol,
              r.label,
              r.features_json,
              r.realized_pnl_usd,
              r.entry_score,
              r.tp_profile,
              r.launchpad,
              r.closed_at,
              r.exit_reason,
              r.hold_seconds,
              r.highest_price_usd,
              r.targets_hit,
              r.entry_price_usd,
              r.sequence_json,
              r.hold_time_series_json
            );
          }
        });
        tx(rows);
        log(
          this.config.logFile,
          `ML reservoir: imported ${rows.length} samples from ${reservoirPath} into ${sessionDbPath}`,
          'info'
        );
      } finally {
        try {
          (reservoir as unknown as { close: () => void }).close();
        } catch {}
      }
    } catch (e: unknown) {
      log(
        this.config.logFile,
        `ML reservoir import skipped: ${e instanceof Error ? e.message : String(e)}`,
        'warn'
      );
    }
  }

  private _reservoirDb: InstanceType<typeof import('../db.js').SQLiteDb> | null = null;
  private _reservoirInitialized = false;

  private _writeToMlReservoir(
    mint: string,
    symbol: string,
    label: number,
    featuresJson: string,
    realizedPnlUsd: number,
    entryScore: number,
    tpProfile: string | null,
    launchpad: string | null,
    closedAt: string,
    exitReason: string | null,
    holdSeconds: number | null,
    highestPriceUsd: number | null,
    targetsHit: number | null,
    entryPriceUsd: number | null,
    sequenceJson: string | null,
    holdTimeSeriesJson: string | null
  ): void {
    const reservoirPath = (this.config as { mlReservoirFile?: string }).mlReservoirFile;
    if (!reservoirPath) return;
    try {
      if (!this._reservoirInitialized) {
        this._reservoirInitialized = true;
        try {
          const db = new SQLiteDb(reservoirPath, this.config.logFile);
          db.init();
          this._reservoirDb = db;
        } catch {
          return;
        }
      }
      const db = this._reservoirDb;
      if (!db) return;
      db.db
        .prepare(
          `INSERT OR IGNORE INTO ml_training_samples (mint, symbol, label, features_json, realized_pnl_usd, entry_score, tp_profile, launchpad, closed_at, exit_reason, hold_seconds, highest_price_usd, targets_hit, entry_price_usd, sequence_json, hold_time_series_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          mint,
          symbol,
          label,
          featuresJson,
          realizedPnlUsd,
          entryScore,
          tpProfile,
          launchpad,
          closedAt,
          exitReason,
          holdSeconds,
          highestPriceUsd,
          targetsHit,
          entryPriceUsd,
          sequenceJson,
          holdTimeSeriesJson
        );
    } catch {
      // Best-effort: never throw on reservoir write
    }
  }
}
