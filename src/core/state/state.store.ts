import { EventEmitter } from 'node:events';
import { MAX_TRACKED_MINTS } from '../config.js';
import {
  Config,
  State,
  Position,
  RecheckItem,
  MarketSnapshot,
  CoolDownEntry,
  ClosedTrade,
  RetiredMintEntry,
  TokenMetadata,
  LaunchHistoryEntry,
  StateMetrics,
  TrainingSample,
} from '#types/index.js';
import { StatePersistence } from './state.persistence.js';

export class StateStore extends EventEmitter {
  public config: Config;
  public state: State;
  public persistence: StatePersistence;
  // In-memory, session-scoped cooldown keyed on normalized symbol. The per-mint cooldown misses
  // copycat relaunches that reuse a name across different mints (e.g. JAMES bought 3x). Not
  // persisted — a short-lived guard whose loss on restart is harmless.
  private recentSymbolExits = new Map<string, number>();

  constructor(config: Config) {
    super();
    this.config = config;
    this.state = this._getDefaultState();
    this.persistence = new StatePersistence(config);
  }

  private _getDefaultState(): State {
    return {
      processedMintQueue: [],
      processedMints: new Set<string>(),
      pendingCandidateRechecks: new Map<string, RecheckItem>(),
      positions: new Map<string, Position>(),
      marketSnapshots: new Map<string, MarketSnapshot>(),
      curveToMint: new Map<string, string>(),
      launchHistory: [],
      paperSolBalanceLamports: this.config?.initialPaperSolLamports?.toString() || '100000000',
      tradeHistory: [],
      moodPauseUntil: null,
      moodPauseTradeCount: null,
      lastBuyAt: null,
      coolDownMints: new Map<string, CoolDownEntry>(),
      retiredMints: new Map<string, RetiredMintEntry>(),
      closedTrades: [],
      metrics: {
        discoveredCandidates: 0,
        passedCheapAudit: 0,
        passedSurvival: 0,
        boughtPositions: 0,
        passedAudit: 0,
        failedMomentum: 0,
        buyAttempts: 0,
        buyFailures: 0,
        buyRejectedThinLiquidity: 0,
        profitableTrades: 0,
        stopLosses: 0,
        trailingExits: 0,
        finalAuditQueued: 0,
        finalAuditPassed: 0,
        finalAuditDeferredIndexing: 0,
        finalAuditRejected: 0,
        exitReasonCounts: {},
        rejectionReasons: {},
      },
      sessionStartingSolBalanceLamports: null,
      peakSessionSolBalanceLamports: null,
      drawdownPauseUntil: null,
      consecutiveLosses: 0,
      recentPnlWindow: [],
      lossStreakPauseActive: false,
      jupiterPriceCooldownUntil: null,
      jupiterPositionPriceCooldownUntil: null,
      prefetchedMintSignals: new Map(),
      burstPriceSamples: new Map(),
      swingWatchlist: new Map(),
      swingJupiterCooldownUntil: null,
      mintToPool: new Map(),
    };
  }

  public async load(stateFile: string): Promise<void> {
    await this.persistence.init(stateFile);
    this.persistence.loadFromDb(this.state);
  }
  public trackMint(mint: string): void {
    if (this.state.processedMints.has(mint)) return;

    this.state.pendingCandidateRechecks.delete(mint);
    this.state.prefetchedMintSignals.delete(mint);
    this.state.burstPriceSamples.delete(mint);
    this.persistence.runRemoveRecheck(mint);

    this.state.processedMints.add(mint);
    this.state.processedMintQueue.push(mint);

    const now = Date.now();
    this.persistence.runTrackMint(mint, now);

    while (this.state.processedMintQueue.length > MAX_TRACKED_MINTS) {
      const removed = this.state.processedMintQueue.shift();
      if (removed) {
        this.state.processedMints.delete(removed);
        this.persistence.runUntrackMint(removed);
      }
    }

    this.emit('mintTracked', mint);
  }

  /**
   * Untracks a mint.
   * @param mint - The token mint address.
   */
  public untrackMint(mint: string): void {
    if (this.state.processedMints.delete(mint)) {
      this.state.processedMintQueue = this.state.processedMintQueue.filter((m) => m !== mint);
      this.persistence.runUntrackMint(mint);
      this.emit('mintUntracked', mint);
    }
    this.state.pendingCandidateRechecks.delete(mint);
    this.persistence.runRemoveRecheck(mint);
  }

  /**
   * Upserts a position into the state.
   * @param position - The position object.
   */
  public upsertPosition(position: Position): void {
    const isNew = !this.state.positions.has(position.mint);
    this.state.positions.set(position.mint, position);

    this.persistence.runUpsertPosition(
      position.mint,
      position.symbol,
      position.name,
      position.openedAt,
      position.entryPriceUsd,
      position
    );

    this.emit(isNew ? 'positionAdded' : 'positionUpdated', position);
  }

  /**
   * Removes a position from the state.
   * @param mint - The token mint address.
   */
  public removePosition(mint: string): void {
    const position = this.state.positions.get(mint);
    if (position) {
      this.state.positions.delete(mint);
      this.persistence.runRemovePosition(mint);
      this.emit('positionRemoved', position);
    }
  }

  /**
   * Increments a numeric metric value.
   * @param key - The metric key to increment.
   * @param amount - The amount to increment by (default: 1).
   */
  public incrementMetric(key: keyof StateMetrics, amount = 1): void {
    const value = this.state.metrics[key];
    if (typeof value === 'number') {
      const newValue = value + amount;
      (this.state.metrics as unknown as Record<string, number>)[key] = newValue;
      this.persistence.runUpsertMetric(key, String(newValue));
      this.emit('metricUpdated', { key, value: newValue });
    }
  }

  /**
   * Updates a metric value directly (e.g., for non-numeric or complex metrics).
   * @param key - The metric key.
   * @param value - The new value.
   */
  public updateMetric<K extends keyof StateMetrics>(key: K, value: StateMetrics[K]): void {
    this.state.metrics[key] = value;
    this.persistence.runUpsertMetric(key, value);
    this.emit('metricUpdated', { key, value });
  }

  /**
   * Records a rejection reason in metrics.
   * @param code - The rejection reason code.
   */
  public recordRejection(code: string): void {
    if (!code) return;
    this.state.metrics.rejectionReasons[code] =
      (this.state.metrics.rejectionReasons[code] || 0) + 1;
    this.persistence.runUpsertMetric('rejectionReasons', this.state.metrics.rejectionReasons);
    this.emit('rejectionRecorded', code);
  }

  /**
   * Updates the paper trading SOL balance.
   * @param amountLamports - The new balance in lamports.
   */
  public updatePaperSolBalance(amountLamports: bigint | string): void {
    this.state.paperSolBalanceLamports = amountLamports.toString();
    const value = this.state.paperSolBalanceLamports;
    this.persistence.runUpsertKV('paperSolBalanceLamports', value);
    this.emit('paperSolBalanceUpdated', this.state.paperSolBalanceLamports);
    this.updateSessionPeakBalance();
  }

  /**
   * Updates the session's peak SOL balance if the current balance is higher.
   * Defaults to the paper balance, but accepts an explicit lamports value so the live
   * drawdown breaker can track the real wallet balance as the high-water mark.
   */
  public updateSessionPeakBalance(currentLamports?: bigint | string): void {
    const current = BigInt(currentLamports ?? this.state.paperSolBalanceLamports);
    const peak = BigInt(this.state.peakSessionSolBalanceLamports || '0');
    if (current > peak) {
      this.state.peakSessionSolBalanceLamports = current.toString();
      const val = this.state.peakSessionSolBalanceLamports;
      this.persistence.runUpsertKV('peakSessionSolBalanceLamports', val);
      this.emit('sessionPeakBalanceUpdated', val);
    }
  }

  /**
   * Forces the session peak high-water mark to a specific value (used by the drawdown
   * breaker to re-baseline after a cooldown so trading resumes from a fresh baseline).
   * Unlike updateSessionPeakBalance this can move the peak *down*.
   */
  public setSessionPeakBalance(currentLamports: bigint | string): void {
    this.state.peakSessionSolBalanceLamports = BigInt(currentLamports).toString();
    const val = this.state.peakSessionSolBalanceLamports;
    this.persistence.runUpsertKV('peakSessionSolBalanceLamports', val);
    this.emit('sessionPeakBalanceUpdated', val);
  }

  /**
   * Adds a closed trade record to the history.
   * @param trade - The closed trade record.
   */
  public addClosedTrade(trade: ClosedTrade): void {
    this.state.closedTrades.push(trade);
    if (this.state.closedTrades.length > 500) {
      this.state.closedTrades.shift();
    }
    const payload = trade;
    this.persistence.runAddClosedTrade(
      trade.mint,
      trade.symbol,
      trade.exitReason,
      trade.realizedPnlUsd,
      trade.realizedPnlSol || 0,
      trade.closedAt,
      payload,
      trade.isGhost ? 1 : 0
    );
    this.emit('tradeClosed', trade);
  }

  /**
   * Increments an exit reason metric.
   * @param reason - The exit reason code.
   */
  public incrementExitReason(reason: string): void {
    if (!reason) return;
    this.state.metrics.exitReasonCounts[reason] =
      (this.state.metrics.exitReasonCounts[reason] || 0) + 1;
    this.persistence.runUpsertMetric('exitReasonCounts', this.state.metrics.exitReasonCounts);
    this.emit('exitReasonIncremented', {
      reason,
      count: this.state.metrics.exitReasonCounts[reason],
    });
  }

  /**
   * Pauses the bot's mood for a specified duration.
   * @param durationMs - The pause duration in milliseconds.
   */
  public pauseMood(durationMs: number, tradeCount: number): void {
    this.state.moodPauseUntil = Date.now() + durationMs;
    this.state.moodPauseTradeCount = tradeCount;
    this.persistence.runUpsertKV('moodPauseUntil', String(this.state.moodPauseUntil));
    this.persistence.runUpsertKV('moodPauseTradeCount', String(tradeCount));
    this.emit('moodPaused', this.state.moodPauseUntil);
  }

  /**
   * Records that a buy was just executed, resetting the trade-starvation clock.
   * Ephemeral runtime signal (not persisted) used by the adaptive entry floor.
   */
  public markBuyExecuted(): void {
    this.state.lastBuyAt = Date.now();
  }

  /**
   * Adds a trade result (win/loss) to the history.
   * @param isWin - Whether the trade was a win.
   */
  public addTradeResult(isWin: boolean): void {
    this.state.tradeHistory.push(isWin);
    if (this.state.tradeHistory.length > 50) {
      this.state.tradeHistory.shift();
    }
    this.persistence.runUpsertKV('tradeHistory', this.state.tradeHistory);
    this.emit('tradeResultAdded', isWin);
  }

  /**
   * Pushes a closed trade's realized PnL (USD) onto the rolling expectancy window, trimming to the
   * configured window size. Most-recent-last. In-memory only — the breaker is intentionally
   * session-local (it should re-arm fresh on restart, not inherit a stale window).
   */
  public addRealizedPnl(pnlUsd: number, windowSize: number): void {
    if (!Number.isFinite(pnlUsd)) return;
    this.state.recentPnlWindow.push(pnlUsd);
    const cap = Math.max(1, Math.floor(windowSize));
    while (this.state.recentPnlWindow.length > cap) {
      this.state.recentPnlWindow.shift();
    }
  }

  /**
   * Starts a cool-down period for a mint.
   * @param mint - The token mint address.
   * @param pUsd - The last exit price in USD.
   * @param expiresAt - Expiration timestamp in milliseconds.
   */
  public startCoolDown(mint: string, pUsd: number, expiresAt: number): void {
    const data = { expiresAt, lastExitPriceUsd: pUsd };
    this.state.coolDownMints.set(mint, data);
    const payload = data;
    this.persistence.runUpsertCooldown(mint, payload);
    this.emit('coolDownStarted', { mint, expiresAt });
  }

  /**
   * Records that a position for the given symbol was just exited, starting a symbol-level cooldown.
   * @param symbol - The token symbol.
   * @param expiresAt - Expiration timestamp in milliseconds.
   */
  public noteSymbolExit(symbol: string, expiresAt: number): void {
    const key = symbol?.trim().toLowerCase();
    if (!key) return;
    this.recentSymbolExits.set(key, expiresAt);
  }

  /**
   * Returns true if a symbol is within its post-exit cooldown window.
   * @param symbol - The token symbol.
   */
  public isSymbolOnCooldown(symbol: string): boolean {
    const key = symbol?.trim().toLowerCase();
    if (!key) return false;
    const expiresAt = this.recentSymbolExits.get(key);
    if (!expiresAt) return false;
    if (Date.now() >= expiresAt) {
      this.recentSymbolExits.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Updates a market snapshot for a mint.
   * @param mint - The token mint address.
   * @param snapshot - The snapshot object.
   */
  public updateMarketSnapshot(mint: string, snapshot: MarketSnapshot): void {
    this.state.marketSnapshots.set(mint, snapshot);
    const payload = snapshot;
    this.persistence.runUpsertSnapshot(mint, payload);
    this.emit('marketSnapshotUpdated', { mint, snapshot });
  }

  /**
   * Calculates the Global Momentum Index (GMI) based on the success rate of the last 100 launches.
   * Success is defined as hitting a 1.5x multiple from the first seen price.
   * @returns The GMI as a ratio (0-1).
   */
  public calculateGMI(): number {
    const history = this.state.launchHistory || [];
    if (history.length < 10) return 0.5; // Neutral default
    const successes = history.filter((l) => l.isSuccess).length;
    return successes / history.length;
  }

  /**
   * Updates the launch history with new data and calculates successes.
   * @param launches - Array of recent token launches.
   */
  public updateLaunchHistory(launches: TokenMetadata[]): void {
    const now = Date.now();
    const historyMap = new Map<string, LaunchHistoryEntry>(
      this.state.launchHistory.map((l) => [l.mint, l])
    );

    for (const token of launches) {
      if (!token.id) continue;
      const p = Number(token.usdPrice || 0);
      if (!(p > 0)) continue;

      const existingEntry = historyMap.get(token.id);
      if (!existingEntry) {
        const newEntry: LaunchHistoryEntry = {
          mint: token.id,
          firstSeenPrice: p,
          highestSeenPrice: p,
          isSuccess: false,
          timestamp: now,
        };
        this.state.launchHistory.push(newEntry);
        const payload = newEntry;
        this.persistence.runUpsertLaunch(newEntry.mint, newEntry.timestamp, payload);
        historyMap.set(token.id, newEntry);
      } else {
        existingEntry.highestSeenPrice = Math.max(existingEntry.highestSeenPrice, p);
        if (
          !existingEntry.isSuccess &&
          existingEntry.highestSeenPrice >= existingEntry.firstSeenPrice * 1.5
        ) {
          existingEntry.isSuccess = true;
        }
        const payload = existingEntry;
        this.persistence.runUpsertLaunch(existingEntry.mint, existingEntry.timestamp, payload);
      }
    }

    // Cap at 100 most recent launches in memory
    if (this.state.launchHistory.length > 100) {
      this.state.launchHistory = this.state.launchHistory.slice(-100);
    }
    this.emit('launchHistoryUpdated', this.state.launchHistory);
  }

  /**
   * Upserts a recheck entry into the state.
   * @param entry - The recheck entry object.
   */
  public upsertRecheckEntry(entry: RecheckItem): void {
    if (entry.scheduledTime && !entry.nextEligibleAt) {
      entry.nextEligibleAt = new Date(entry.scheduledTime).toISOString();
    }
    this.state.pendingCandidateRechecks.set(entry.mint, entry);
    const payload = entry;
    this.persistence.runUpsertRecheck(entry.mint, payload);
    this.emit('recheckEntryUpserted', entry);
  }

  /**
   * Removes a recheck entry from the state.
   * @param mint - The token mint address.
   */
  public removeRecheckEntry(mint: string): void {
    if (this.state.pendingCandidateRechecks.delete(mint)) {
      this.persistence.runRemoveRecheck(mint);
      this.emit('recheckEntryRemoved', mint);
    }
  }

  /**
   * Removes a cool-down entry.
   * @param mint - The token mint address.
   */
  public removeCoolDown(mint: string): void {
    if (this.state.coolDownMints.delete(mint)) {
      this.persistence.runRemoveCooldown(mint);
      this.emit('coolDownRemoved', mint);
    }
  }

  /**
   * Retires a mint from active trading.
   * @param mint - The token mint address.
   * @param data - Metadata for the retirement.
   */
  public retireMint(mint: string, data: RetiredMintEntry): void {
    this.state.retiredMints.set(mint, data);
    const payload = data;
    this.persistence.runUpsertRetired(mint, payload);
    this.emit('mintRetired', { mint, data });
  }

  /**
   * Unretires a mint.
   * @param mint - The token mint address.
   */
  public unretireMint(mint: string): void {
    if (this.state.retiredMints.delete(mint)) {
      this.persistence.runRemoveRetired(mint);
      this.emit('mintUnretired', mint);
    }
  }

  /**
   * Removes a market snapshot.
   * @param mint - The token mint address.
   */
  public removeMarketSnapshot(mint: string): void {
    if (this.state.marketSnapshots.delete(mint)) {
      this.persistence.runRemoveSnapshot(mint);
      this.emit('marketSnapshotRemoved', mint);
    }
  }

  /**
   * Flushes any pending state to the database (dummy for backward compatibility).
   * @param _options - Optional persistence options.
   */

  /**
   * Persists the state to the database (dummy for backward compatibility).
   * @param _options - Optional persistence options.
   */

  /**
   * Writes an arbitrary key-value pair to the kv_store table.
   */
  public upsertKV(key: string, value: string): void {
    this.persistence.runUpsertKV(key, value);
  }

  /**
   * Reads a value from the kv_store table synchronously.
   * Returns null if the key is not found or if SQLite is not initialized.
   */

  /**
   * Adds an ML training sample (derived from a closed trade) to the database.
   */
  public addTrainingSample(sample: TrainingSample): void {
    this.persistence.runAddTrainingSample(
      sample.mint,
      sample.symbol,
      sample.label,
      sample.featuresJson,
      sample.realizedPnlUsd,
      sample.entryScore,
      sample.tpProfile,
      sample.launchpad,
      sample.closedAt,
      sample.exitReason ?? null,
      sample.holdSeconds ?? null,
      sample.highestPriceUsd ?? null,
      sample.targetsHit ?? null,
      sample.entryPriceUsd ?? null,
      sample.sequenceJson ?? null,
      sample.holdTimeSeriesJson ?? null
    );
  }

  /**
   * Reads the most recent ML training samples from the database synchronously.
   */

  /**
   * Reads the most recent closed trades from the database synchronously.
   */

  /**
   * Signals that the store should prepare for shutdown.
   */

  public async flush(options?: { sync?: boolean; force?: boolean }): Promise<void> {
    return this.persistence.flush(options);
  }

  public async persist(options?: { sync?: boolean; force?: boolean }): Promise<void> {
    return this.persistence.persist(options);
  }

  public getKV(key: string): string | null {
    return this.persistence.getKV(key);
  }

  public getTrainingSamples(limit: number): TrainingSample[] {
    return this.persistence.getTrainingSamples(limit);
  }

  public getRecentClosedTrades(limit: number): ClosedTrade[] {
    return this.persistence.getRecentClosedTrades(limit);
  }

  public requestShutdown(): Promise<void> {
    return this.persistence.requestShutdown();
  }
}
