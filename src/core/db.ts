import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { log } from './utils.js';

/**
 * Interface for database providers used by the application.
 */
export interface DbProvider {
  /**
   * The underlying database connection instance.
   */
  db: Database.Database;

  /**
   * Initializes the database connection and schema.
   */
  init(): void;

  /**
   * Closes the database connection.
   */
  close(): void;
}

/**
 * SQLite implementation of the DbProvider interface using better-sqlite3.
 */
export class SQLiteDb implements DbProvider {
  /**
   * The active better-sqlite3 database instance.
   */
  public db!: Database.Database;

  private dbPath: string;
  private logFile?: string;

  /**
   * Creates an instance of SQLiteDb.
   * @param dbPath - The file path to the SQLite database.
   * @param logFile - Optional path for logging database events.
   */
  constructor(dbPath: string, logFile?: string) {
    this.dbPath = path.resolve(dbPath);
    this.logFile = logFile;
  }

  /**
   * Initializes the database, ensuring the directory exists and setting performance pragmas.
   */
  public init(): void {
    const dbDir = path.dirname(this.dbPath);
    fs.mkdirSync(dbDir, { recursive: true });

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this._createTables();
    log(this.logFile || '', `SQLite database initialized at ${this.dbPath}`, 'info');
  }

  /**
   * Creates the necessary database tables if they do not exist.
   * @private
   */
  private _createTables(): void {
    const schema = `
      CREATE TABLE IF NOT EXISTS positions (
        mint TEXT PRIMARY KEY,
        symbol TEXT,
        name TEXT,
        opened_at TEXT,
        entry_price_usd REAL,
        data TEXT
      );

      CREATE TABLE IF NOT EXISTS closed_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mint TEXT,
        symbol TEXT,
        exit_reason TEXT,
        realized_pnl_usd REAL,
        realized_pnl_sol REAL,
        closed_at TEXT,
        data TEXT,
        is_ghost INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS processed_mints (
        mint TEXT PRIMARY KEY,
        timestamp INTEGER
      );

      CREATE TABLE IF NOT EXISTS metrics (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS rechecks (
        mint TEXT PRIMARY KEY,
        data TEXT
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        mint TEXT PRIMARY KEY,
        data TEXT
      );

      CREATE TABLE IF NOT EXISTS launch_history (
        mint TEXT PRIMARY KEY,
        timestamp INTEGER,
        data TEXT
      );

      CREATE TABLE IF NOT EXISTS cooldowns (
        mint TEXT PRIMARY KEY,
        data TEXT
      );

      CREATE TABLE IF NOT EXISTS retired_mints (
        mint TEXT PRIMARY KEY,
        data TEXT
      );

      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS ml_training_samples (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        mint             TEXT NOT NULL,
        symbol           TEXT,
        label            INTEGER NOT NULL CHECK(label IN (0, 1)),
        features_json    TEXT NOT NULL,
        realized_pnl_usd REAL NOT NULL,
        entry_score      REAL,
        tp_profile       TEXT,
        launchpad        TEXT,
        closed_at        TEXT NOT NULL,
        created_at       INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
        exit_reason      TEXT,
        hold_seconds     REAL,
        highest_price_usd REAL,
        targets_hit      INTEGER,
        entry_price_usd  REAL,
        sequence_json    TEXT,
        hold_time_series_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_ml_samples_closed_at
        ON ml_training_samples (closed_at DESC);
    `;

    this.db.exec(schema);

    // Add enrichment columns to ml_training_samples for existing databases.
    // SQLite does not support IF NOT EXISTS for ALTER TABLE, so we try/catch each.
    const enrichCols = [
      'ADD COLUMN exit_reason TEXT',
      'ADD COLUMN hold_seconds REAL',
      'ADD COLUMN highest_price_usd REAL',
      'ADD COLUMN targets_hit INTEGER',
      'ADD COLUMN entry_price_usd REAL',
      // Pre-entry price-history sequence (JSON) for the LSTM scorer.
      'ADD COLUMN sequence_json TEXT',
      // Post-entry price/liquidity/volume time-series for LSTM hold-quality scoring.
      'ADD COLUMN hold_time_series_json TEXT',
    ];
    for (const col of enrichCols) {
      try {
        this.db.exec(`ALTER TABLE ml_training_samples ${col}`);
      } catch {
        // Expected if column already exists
      }
    }

    try {
      this.db.exec(`ALTER TABLE closed_trades ADD COLUMN is_ghost INTEGER DEFAULT 0`);
    } catch {
      // Expected if column already exists
    }
  }

  /**
   * Safely closes the database connection.
   */
  public close(): void {
    if (this.db) {
      this.db.close();
    }
  }
}
