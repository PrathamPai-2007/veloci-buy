import { SQLiteDb } from '../db.js';
import { migrateJsonToSqlite } from '../migrate.js';
import { log } from '../utils.js';
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

/** A value safe to bind to a SQLite statement, or an object the worker serializes to JSON. */
export type WorkerRunParam = string | number | bigint | null | object;

/** Messages sent from the main thread to the persistence worker. */
export type WorkerRequest =
  | { type: 'run'; stmt: string; params: WorkerRunParam[] }
  | { type: 'flush'; id: number }
  | { type: 'shutdown'; id: number };

/** Acknowledgements sent from the worker back to the main thread. */
export interface WorkerResponse {
  type: 'flush_complete' | 'shutdown_complete';
  id: number;
}

export class StatePersistence {
  private _sqlite: SQLiteDb | null = null;
  private _shutdownRequested = false;
  private _worker: import('node:worker_threads').Worker | null = null;
  private _msgSeq = 0;
  private _pendingFlushes = new Map<number, () => void>();
  private _pendingShutdown: (() => void) | null = null;

  constructor(private config: Config) {}

  public async init(stateFile: string): Promise<void> {
    if (!stateFile) return;
    const dbPath = stateFile.replace(/\.json$/, '.db');
    this._sqlite = new SQLiteDb(dbPath, this.config.logFile);
    this._sqlite.init();

    const mintsFile = stateFile.replace(/\.json$/, '_mints.json');
    await migrateJsonToSqlite(stateFile, mintsFile, this._sqlite, this.config.logFile);

    const { Worker } = await import('node:worker_threads');
    const { fileURLToPath } = await import('node:url');
    const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
    const workerPath = fileURLToPath(new URL(`./state.worker${ext}`, import.meta.url));
    const delayMs = Math.max(1, Number(this.config.stateFlushIntervalMs || 250));

    const workerOptions: import('node:worker_threads').WorkerOptions = {
      workerData: { dbPath, logFile: this.config.logFile, flushIntervalMs: delayMs },
    };

    if (ext === '.ts') {
      let tsxApiUrl: string;
      try {
        tsxApiUrl = import.meta.resolve('tsx/esm/api');
      } catch {
        tsxApiUrl = 'tsx/esm/api';
      }
      const loaderCode = `import { register } from ${JSON.stringify(tsxApiUrl)}; register();`;
      workerOptions.execArgv = ['--import', `data:text/javascript,${loaderCode}`];
    }

    this._worker = new Worker(workerPath, workerOptions);

    this._worker.on('message', (msg: WorkerResponse) => {
      if (msg.type === 'flush_complete') {
        const resolve = this._pendingFlushes.get(msg.id);
        if (resolve) {
          this._pendingFlushes.delete(msg.id);
          resolve();
        }
      } else if (msg.type === 'shutdown_complete') {
        this._sqlite?.close();
        this._sqlite = null;
        this._pendingShutdown?.();
        this._pendingShutdown = null;
      }
    });

    this._worker.on('error', (err) => {
      log(this.config.logFile, `State worker error: ${err}`, 'error');
      for (const resolve of this._pendingFlushes.values()) resolve();
      this._pendingFlushes.clear();
      this._pendingShutdown?.();
      this._pendingShutdown = null;
    });
  }

  private _enqueueWorkerWrite(stmt: string, params: WorkerRunParam[]): void {
    if (this._shutdownRequested || !this._worker) return;
    this._worker.postMessage({ type: 'run', stmt, params });
  }

  public loadFromDb(state: State): void {
    if (!this._sqlite) return;
    const { db } = this._sqlite;

    // Load Positions
    const positions = db.prepare('SELECT data FROM positions').all() as { data: string }[];
    state.positions = new Map(
      positions.map((p) => {
        const parsed = JSON.parse(p.data) as Position;
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
      this._enqueueWorkerWrite('upsertKV', ['sessionStartingSolBalanceLamports', startVal]);
      this._enqueueWorkerWrite('upsertKV', ['peakSessionSolBalanceLamports', peakVal]);
    }

    log(
      this.config.logFile,
      `State loaded from SQLite: ${state.positions.size} positions, ${state.processedMints.size} mints.`,
      'info'
    );
  }

  public async flush(_options?: { sync?: boolean; force?: boolean }): Promise<void> {
    if (!this._worker || this._shutdownRequested) return;
    return new Promise((resolve) => {
      const id = ++this._msgSeq;
      this._pendingFlushes.set(id, resolve);
      this._worker?.postMessage({ type: 'flush', id });
    });
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
    if (!this._worker || this._shutdownRequested) return;
    this._shutdownRequested = true;
    return new Promise((resolve) => {
      const id = ++this._msgSeq;
      this._pendingShutdown = resolve;
      this._worker?.postMessage({ type: 'shutdown', id });
    });
  }

  public runTrackMint(mint: string, now: number): void {
    this._enqueueWorkerWrite('trackMint', [mint, now]);
  }
  public runUntrackMint(mint: string): void {
    this._enqueueWorkerWrite('untrackMint', [mint]);
  }
  public runRemoveRecheck(mint: string): void {
    this._enqueueWorkerWrite('removeRecheck', [mint]);
  }
  public runUpsertPosition(
    mint: string,
    symbol: string,
    name: string,
    openedAt: string | null,
    entryPriceUsd: number,
    data: Position
  ): void {
    this._enqueueWorkerWrite('upsertPosition', [mint, symbol, name, openedAt, entryPriceUsd, data]);
  }
  public runRemovePosition(mint: string): void {
    this._enqueueWorkerWrite('removePosition', [mint]);
  }
  public runUpsertMetric(key: string, value: string | number | Record<string, number>): void {
    this._enqueueWorkerWrite('upsertMetric', [key, value]);
  }
  public runUpsertKV(key: string, value: string | boolean[]): void {
    this._enqueueWorkerWrite('upsertKV', [key, value]);
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
    this._enqueueWorkerWrite('addClosedTrade', [
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
    this._enqueueWorkerWrite('upsertCooldown', [mint, data]);
  }
  public runUpsertSnapshot(mint: string, data: MarketSnapshot): void {
    this._enqueueWorkerWrite('upsertSnapshot', [mint, data]);
  }
  public runUpsertLaunch(mint: string, timestamp: number, data: LaunchHistoryEntry): void {
    this._enqueueWorkerWrite('upsertLaunch', [mint, timestamp, data]);
  }
  public runUpsertRecheck(mint: string, data: RecheckItem): void {
    this._enqueueWorkerWrite('upsertRecheck', [mint, data]);
  }
  public runRemoveCooldown(mint: string): void {
    this._enqueueWorkerWrite('removeCooldown', [mint]);
  }
  public runUpsertRetired(mint: string, data: RetiredMintEntry): void {
    this._enqueueWorkerWrite('upsertRetired', [mint, data]);
  }
  public runRemoveRetired(mint: string): void {
    this._enqueueWorkerWrite('removeRetired', [mint]);
  }
  public runRemoveSnapshot(mint: string): void {
    this._enqueueWorkerWrite('removeSnapshot', [mint]);
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
    this._enqueueWorkerWrite('addTrainingSample', [
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
  }
}
