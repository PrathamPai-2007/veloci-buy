import type { LaunchHistoryEntry, MarketSnapshot, TokenMetadata } from './market.js';
import type { ClosedTrade, Position } from './position.js';
import type { MintSignals, TrainingSample } from './signals.js';

export interface RecheckItem {
  mint: string;
  tokenSnapshot?: TokenMetadata;
  attempts?: number;
  lastAttemptTime?: number;
  scheduledTime?: number;
  basePriceUsd?: number;
  reason?: string;
  candidateScore?: number;
  highestSeenPriceUsd?: number;
  priceAtStartOfDelay?: number;
  liquidityAtStartOfDelay?: number;
  priceHistory?: { price: number; timestamp: number; liquidity?: number }[];
  tapeAtStart?: { buys: number; sells: number };
  tapeHistory?: { buys: number; sells: number; timestamp: number }[];
  spreadHistory?: { spread: number; timestamp: number }[];
  /** Epoch ms the mint first entered the recheck pipeline. */
  firstSeenAt?: number;
  /** Epoch ms the survival window began; local price/tape history is measured from here. */
  survivalStartedAt?: number;
  isSurvivalWait?: boolean;
  isFinalAudit?: boolean;
  isWaitlist?: boolean;
  auditAttempts?: number;
  indexingLagRetries?: number;
  nextEligibleAt?: string;
}

export interface StateMetrics {
  discoveredCandidates: number;
  passedCheapAudit: number;
  passedSurvival: number;
  passedAudit: number;
  boughtPositions: number;
  failedMomentum: number;
  buyAttempts: number;
  buyFailures: number;
  buyRejectedThinLiquidity: number;
  profitableTrades: number;
  stopLosses: number;
  trailingExits: number;
  finalAuditQueued: number;
  finalAuditPassed: number;
  finalAuditDeferredIndexing: number;
  finalAuditRejected: number;
  localMarketReads?: number;
  localMarketMisses?: number;
  externalPriceFallbacks?: number;
  jupiterPriceRequests?: number;
  getTokenLargestAccountsRequests?: number;
  getMultipleAccountsRequests?: number;
  tokenAccountInitializations?: number;
  candidateDiscoveries?: number;
  cheapGatePasses?: number;
  deepAuditCandidates?: number;
  tokenLargestInitializations?: number;
  tokenLargestFallbacks?: number;
  tokenLargest429s?: number;
  invalidMintSkips?: number;
  jupiterCircuitOpens?: number;
  jupiterCircuitCloses?: number;
  jupiterCircuitProbes?: number;
  jupiterSuppressedRequests?: number;
  consecutiveJupiterFailures?: number;
  tokenLargestRequestQueued?: number;
  tokenLargestRequestCaller?: number;
  tokenLargestRequestMint?: number;
  tokenLargestRequestStarted?: number;
  tokenLargestRequestFinished?: number;
  holderInitRequests?: number;
  holderInit429s?: number;
  batchOwnerLookupRequests?: number;
  batchOwnerLookup429s?: number;
  batchAuditDurationMs?: number;
  scanStarted?: number;
  scanCompleted?: number;
  jupiterDiscoveryRequests?: number;
  jupiterDiscoveryTimeouts?: number;
  monitorTicks?: number;
  monitorTicksAborted?: number;
  monitorRpcFailures?: number;
  monitorTicksUsingCachedBalance?: number;
  securityAuditsQueued?: number;
  securityAuditsSkippedInFlight?: number;
  securityAuditsCompleted?: number;
  securityAuditsFailed?: number;
  exitReasonCounts: Record<string, number>;
  rejectionReasons: Record<string, number>;
  orphanExits?: number;
}

export interface CoolDownEntry {
  expiresAt: number;
  lastExitPriceUsd: number;
}

export interface RetiredMintEntry {
  lastExitPriceUsd?: number;
  retiredAt: string;
  reason?: string;
}

export interface State {
  processedMintQueue: string[];
  processedMints: Set<string>;
  pendingCandidateRechecks: Map<string, RecheckItem>;
  positions: Map<string, Position>;
  marketSnapshots: Map<string, MarketSnapshot>;
  curveToMint: Map<string, string>;
  launchHistory: LaunchHistoryEntry[];
  paperSolBalanceLamports: string;
  tradeHistory: boolean[];
  moodPauseUntil: number | null;
  /** tradeHistory.length captured when the last mood pause was triggered. Used to prevent
   * re-pausing on the same (unchanged) history after a pause expires, which would otherwise
   * lock the bot into a permanent pause. null when no pause is active. */
  moodPauseTradeCount: number | null;
  /** Epoch ms of the last executed buy this session; null until the first buy. Drives the starvation-relaxation controller. Ephemeral (not persisted). */
  lastBuyAt: number | null;
  coolDownMints: Map<string, CoolDownEntry>;
  retiredMints: Map<string, RetiredMintEntry>;
  closedTrades: ClosedTrade[];
  metrics: StateMetrics;
  sessionStartingSolBalanceLamports: string | null;
  peakSessionSolBalanceLamports: string | null;
  /** Epoch ms until which the drawdown circuit breaker pauses new buys. In-memory, not persisted. */
  drawdownPauseUntil: number | null;
  /** Running count of consecutive losing positions, for the loss-streak breaker. In-memory, not persisted. */
  consecutiveLosses: number;
  /**
   * Rolling buffer of recent realized PnL (USD), most-recent-last, capped at lossStreakWindowSize.
   * Drives the expectancy breaker: a net-negative trailing window pauses new buys even when losses
   * are interleaved with small wins (which a consecutive counter would reset). In-memory, not persisted.
   */
  recentPnlWindow: number[];
  /**
   * True when the active drawdownPauseUntil was set by the loss-streak breaker rather than the
   * drawdown breaker. Used so resuming a loss-streak pause does NOT re-baseline the drawdown
   * high-water mark (that reset is only correct after a real drawdown trip). In-memory, not persisted.
   */
  lossStreakPauseActive: boolean;
  /** In-memory cache of mint signals pre-fetched during survival delays. Not persisted. */
  prefetchedMintSignals: Map<string, MintSignals>;
  /** Maps token mint → pool address for Raydium/Meteora pools. Populated by Geyser handlers. Not persisted. */
  mintToPool: Map<string, string>;
  /** In-memory cache of vault token balances updated via Geyser. Not persisted. */
  vaultBalanceCache?: Map<string, bigint>;
  /** Active vault balance push subscriptions. Tracked by mint. Not persisted. */
  vaultSubscriptions?: Map<string, AbortController>;
  /** Active ATA push subscriptions. Tracked by mint. Not persisted. */
  ataSubscriptions?: Map<string, AbortController>;
  /** In-memory cache of wallet token balances updated via ATA push. Not persisted. */
  ataBalanceCache?: Map<
    string,
    { mint: string; rawAmount: bigint; decimals: number; uiAmount: number }
  >;
  /** The latest slot processed by Geyser. Used for discovery synchronization. Not persisted. */
  latestGeyserSlot?: number;
}

export interface StateStore {
  state: State;
  load(stateFile: string): void;
  trackMint(mint: string): void;
  untrackMint(mint: string): void;
  upsertPosition(position: Position): void;
  removePosition(mint: string): void;
  incrementMetric(key: keyof StateMetrics, amount?: number): void;
  recordRejection(code: string): void;
  updatePaperSolBalance(amountLamports: bigint | string): void;
  addClosedTrade(trade: ClosedTrade): void;
  incrementExitReason(reason: string): void;
  pauseMood(durationMs: number, tradeCount: number): void;
  markBuyExecuted(): void;
  addTradeResult(isWin: boolean): void;
  addRealizedPnl(pnlUsd: number, windowSize: number): void;
  startCoolDown(mint: string, pUsd: number, expiresAt: number): void;
  noteSymbolExit(symbol: string, expiresAt: number): void;
  isSymbolOnCooldown(symbol: string): boolean;
  updateMarketSnapshot(mint: string, snapshot: MarketSnapshot): void;
  calculateGMI(): number;
  updateSessionPeakBalance(currentLamports?: bigint | string): void;
  setSessionPeakBalance(currentLamports: bigint | string): void;
  updateLaunchHistory(launches: TokenMetadata[]): void;
  upsertRecheckEntry(entry: RecheckItem): void;
  removeRecheckEntry(mint: string): void;
  removeCoolDown(mint: string): void;
  retireMint(mint: string, data: RetiredMintEntry): void;
  unretireMint(mint: string): void;
  removeMarketSnapshot(mint: string): void;
  requestShutdown(): Promise<void>;
  persist(options?: { sync?: boolean; force?: boolean }): Promise<void>;
  addTrainingSample(sample: TrainingSample): void;
  getTrainingSamples(limit: number): TrainingSample[];
  getRecentClosedTrades(limit: number): ClosedTrade[];
  upsertKV(key: string, value: string): void;
  getKV(key: string): string | null;
  flush(options?: { sync?: boolean; force?: boolean }): Promise<void>;
  updateMetric<K extends keyof StateMetrics>(key: K, value: StateMetrics[K]): void;
}

export interface DiscoveryLoopTrigger {
  reason?: string;
  forceDiscovery?: boolean;
  skipMonitor?: boolean;
  websocketSignalCount?: number;
  mints?: string[];
  mintLaunchpads?: Record<string, string>;
}
