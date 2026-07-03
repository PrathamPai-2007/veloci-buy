import { Rpc, SolanaRpcApi } from '@solana/rpc';
import { RpcSubscriptions, SolanaRpcSubscriptionsApi } from '@solana/rpc-subscriptions';
import type { KeyPairSigner } from '@solana/signers';

export type LogLevel = 'info' | 'warn' | 'error' | 'trade' | 'debug';

export interface LaunchpadProfile {
  scoreBonus: number;
  liquidityMultiplier: number;
  holderMultiplier: number;
  buysMultiplier: number;
  minPoolAgeSeconds: number;
}

export interface PresetStrategy {
  name?: string;
  description?: string;
  minLiquidityUsd: number;
  minHolderCount: number;
  maxRecheckAttempts: number;
  minCandidateScore: number;
  minMarketCapUsd?: number;
  stopLossPct: number;
  takeProfitMultiples: number[];
  survivalDelaySeconds: number;
  maxOpenPositions: number;
  minSurvivalMomentum: number;
  minBreakoutMultiplier: number;
  maxPriceDumpPct: number;
  maxSurvivalGrowthPct: number;
  maxSellPressureIncreasePct: number;
  maxAuditTopHoldersPct: number;
  minMomentumConsistency: number;
  minAccelerationFactor: number;
  maxConcurrentAudits: number;
  scanParallelismLight: number;
  scanParallelismHeavy: number;
  ownerAuditParallelism: number;
  priceFallbackParallelism: number;
  parallelismMinFactor: number;
  errorRateWindow: number;
  backpressureErrorRateThreshold: number;
  mintSignalMaxAttempts: number;
  mintSignalRetryDelayMs: number;
  rpcIndexingRetryDelayMs: number;
  mlScoreGateThreshold?: number;
  mlScoreWeight?: number;
  mlGateMinRealTrades?: number;
  slippageBps?: number;
  burstSurvivalSeconds?: number;
  burstMinMomentum?: number;
  burstMaxEntryDrawdownPct?: number;
  burstMinBuySellRatio?: number;
  burstTrailingDrawdownPct?: number;
  burstMaxHoldMinutes?: number;
  burstTakeProfitMultiples?: number[];
  burstTakeProfitFractions?: number[];
  burstMaxSolOutflowPct?: number;
  breakEvenStopTriggerMultiple?: number;
  breakEvenStopFloorPct?: number;
  finalAuditSeconds?: number;
  takeProfitMultiplesHigh?: number[];
  takeProfitFractions?: number[];
  trailingStopDrawdownPct?: number;
  maxHoldMinutes?: number;
  holdDurationHighConfidenceMinutes?: number;
}

export interface Config {
  strategyName: string;
  rpcUrls: string[];
  wsRpcUrls: string[];
  rpcUrl: string;
  wsRpcUrl: string;
  jupiterApiKey: string;
  jupiterPositionApiKey: string;
  jupiterBaseUrl: string;
  rugcheckBaseUrl: string;
  rugcheckApiKey: string;
  bubbleMapsBaseUrl: string;
  heliusApiKey: string;
  scanIntervalMs: number;
  discoveryPollIntervalMs: number;
  discoveryWsEnabled: boolean;
  discoveryPumpEnabled: boolean;
  discoveryRaydiumEnabled: boolean;
  discoveryMeteoraEnabled: boolean;
  discoveryWsDebounceMs: number;
  buyAmountSolText: string;
  buyAmountLamports: bigint;
  slippageBps: number;
  maxConcurrentAudits: number;
  scanParallelismLight: number;
  scanParallelismHeavy: number;
  ownerAuditParallelism: number;
  priceFallbackParallelism: number;
  parallelismMinFactor: number;
  errorRateWindow: number;
  backpressureErrorRateThreshold: number;
  mintSignalMaxAttempts: number;
  mintSignalRetryDelayMs: number;
  rpcIndexingRetryDelayMs: number;
  maxOpenPositions: number;
  maxBuysPerScan: number;
  maxCandidatesPerScan: number;
  dryRun: boolean;
  paperTrading: boolean;
  liveTradingEnabled: boolean;
  apiPort: number;
  apiHost: string;
  apiToken: string;
  initialPaperSolText: string;
  initialPaperSolLamports: bigint;
  sessionDir: string;
  stateFile: string;
  logFile: string;
  scannedTokensFile: string;
  paperTradeJournalFile: string;
  tradeJournalFile: string;
  performanceStatsFile: string;
  metricsFile: string;
  mintsFile?: string;
  stateFlushIntervalMs: number;
  minLiquidityUsd: number;
  minOrganicScore: number;
  minHolderCount: number;
  minBuys5m: number;
  minPoolAgeSeconds: number;
  maxCandidateAgeMinutes: number;
  minSocialLinks: number;
  maxAuditTopHoldersPct: number;
  maxTokenAccountTop1Pct: number;
  maxTokenAccountTop3Pct: number;
  maxTokenAccountTop5Pct: number;
  maxBuyLiquidityFraction: number;
  moonBagFraction: number;
  moonBagTrailingDrawdownPct: number;
  insiderDriftConcentrationTop5: number;
  maxFdvToLiquidity: number;
  maxMemeFdvUsd: number;
  minMarketCapUsd: number;
  allowVerifiedTokens: boolean;
  memeKeywords: string[];
  bubbleMapsApiKey: string;
  minBubbleMapsScore: number;
  maxBubbleMapsLargestClusterShare: number;
  // Trending-coin discovery (Jupiter top-traded, filtered to pump.fun) and the
  // moderate, trending-only relaxations applied to the anti-top entry guards.
  trendingDiscoveryEnabled: boolean;
  trendingPollIntervalMs: number;
  trendingInterval: string;
  trendingMaxSurvivalGrowthPct: number;
  trendingMaxBuyTopGrowthPct: number;
  trendingMaxPriceDumpPct: number;
  trendingMaxTokenAccountTop1Pct: number;
  trendingMaxTokenAccountTop5Pct: number;
  trendingMinBubbleMapsScore: number;
  minCandidateScore: number;
  momentumScoringEnabled: boolean;
  maxRecheckAttempts: number;
  minMomentumConsistency: number;
  maxExhaustionRangePct: number;
  highGrowthConfidenceScore: number;
  standardGrowthConfidenceScore: number;
  borderlineRecheckEnabled: boolean;
  borderlineRecheckMinDelayMs: number;
  borderlineRecheckPageDelayMs?: number;
  borderlineRecheckMaxDelayMs: number;
  borderlineRecheckMaxAttempts: number;
  borderlineThresholdBufferRatio: number;
  survivalDelaySeconds: number;
  survivalDelayThresholdHigh: number;
  survivalDelayThresholdVeryHigh: number;
  finalAuditSeconds: number;
  minSurvivalMomentum: number;
  minBreakoutMultiplier: number;
  maxPriceDumpPct: number;
  maxLiquidityDrawdownPct: number;
  maxBuyTopGrowthPct: number;
  buyTopAthBufferPct: number;
  buyingTheTopSlPct: number;
  performanceCheckSeconds: number;
  performanceMinMomentum: number;
  minHoldTimeSeconds: number;
  websocketWatchdogIntervalMs: number;
  websocketStaleThresholdMs: number;
  websocketHandshakeTimeoutMs: number;
  stopLossPct: number;
  trailingStopDrawdownPct: number;
  breakevenRatchetEnabled: boolean;
  breakevenRatchetBufferPct: number;
  slBreakevenEnabled: boolean;
  slBreakevenThresholdPct: number;
  slBreakevenBufferPct: number;
  breakEvenStopEnabled: boolean;
  breakEvenStopTriggerMultiple: number;
  breakEvenStopFloorPct: number;
  earlyStopLossPct: number;
  earlyStopLossWindowSec: number;
  midStopLossPct: number;
  midStopLossWindowSec: number;
  takeProfitMultiples: number[];
  takeProfitMultiplesHigh: number[];
  takeProfitFractions: number[];
  takeProfitFraction: number;
  earlyPerformanceGuardSeconds: number;
  earlyPerformanceDropPct: number;
  earlyPerformanceSellPct: number;
  rugExitGuardEnabled: boolean;
  rugExitWindowSec: number;
  rugExitDropPct: number;
  rugExitDynamicScalingEnabled: boolean;
  rugExitMicroCapThresholdUsd: number;
  rugExitMicroCapMultiplier: number;
  rugExitHighCapThresholdUsd: number;
  rugExitHighCapMultiplier: number;
  rugExitVolatilityScalingEnabled: boolean;
  rugExitSpreadGuardEnabled: boolean;
  rugExitMaxSpreadPct: number;
  rugExitSpreadExpansionMultiplier: number;
  rugExitVolumeGuardEnabled: boolean;
  rugExitSellDominanceMultiplier: number;
  maxHoldMinutes: number;
  timeExitMinMultiple: number;
  liquidityCollapseThresholdUsd: number;
  liquidityCollapseThresholdRatio: number;
  holdDurationHighConfidenceMinutes: number;
  holdDurationLowConfidenceMinutes: number;
  recheckPriceDropPct: number;
  moodPauseDurationMinutes: number;
  coolDownMinutes: number;
  holderCountWaitlistSeconds: number;
  reentryDipPct: number;
  reentryBreakoutPct: number;
  maxSurvivalGrowthPct: number;
  minAccelerationFactor: number;
  maxSellPressureIncreasePct: number;
  priorityFeeBaseMicroLamports: number;
  priorityFeeMaxMicroLamports: number;
  priorityFeePanicMultiplier: number;
  priorityFeePercentile: number;
  useJito: boolean;
  dynamicJitoTipEnabled: boolean;
  jitoTipLamports: bigint;
  jitoBlockEngineUrl: string;
  jitoTipPercentile: number;
  jitoTipFloorApiUrl: string;
  // Probabilistic tip: cap the tip at this fraction of a trade's expected profit
  // so a high-confidence bid never overpays relative to what the trade is worth.
  jitoTipMaxFractionOfEv: number;
  jitoConfirmTimeoutMs: number;
  jitoBundleRetryAttempts: number;
  priorityFeeAccountLocal: boolean;
  priorityFeeVolatilityMultiplier: number;
  maxAutoSlippageRetry: number;
  autoSlippageIncrementBps: number;
  useJupiterSdk: boolean;
  inlineSwapSimulation: boolean;
  backgroundAtaClose: boolean;
  closePositionsOnShutdown: boolean;
  privateKey: string;
  privateKeyPath: string;
  keystorePath: string;
  keystorePassword?: string;
  telegramBotToken: string;
  telegramChatId: string;
  discordWebhookUrl: string;
  maxDailyDrawdownPct: number;
  circuitBreakerEnabled: boolean;
  drawdownCooldownMinutes: number;
  lossStreakBreakerEnabled: boolean;
  lossStreakThreshold: number;
  lossStreakCooldownMinutes: number;
  expectancyBreakerEnabled: boolean;
  lossStreakWindowSize: number;
  maxPositionsPerLaunchpad: number;
  dynamicSizingEnabled: boolean;
  mlScoreGateThreshold: number;
  mlScoreWeight: number;
  mlGateMinRealTrades: number;
  entryTunerEnabled: boolean;
  entryTunerLiveEnabled: boolean;
  entryTunerMinSamples: number;
  adaptiveFloorEnabled: boolean;
  adaptiveFloorLiveEnabled: boolean;
  minCandidateScoreFloor: number;
  tradeStarvationMinutes: number;
  starvationRelaxStep: number;
  rugcheckEnabled: boolean;
  bubblemapsEnabled: boolean;
  burstModeEnabled: boolean;
  burstSurvivalSeconds: number;
  burstMinMomentum: number;
  burstMaxEntryDrawdownPct: number;
  burstMinBuySellRatio: number;
  burstTrailingDrawdownPct: number;
  burstMaxHoldMinutes: number;
  burstTakeProfitMultiples: number[] | undefined;
  burstTakeProfitFractions: number[] | undefined;
  burstMaxSolOutflowPct: number;
  enableLocalRouting: boolean;
  localRoutingComputeUnitLimit: number;
  kellyEnabled: boolean;
  maxKellyFraction: number;
  kellyMinTrades: number;
  swingBotEnabled: boolean;
  swingJupiterApiKey: string;
  swingJupiterBaseUrl: string;
  swingMinMarketCapUsd: number;
  swingMaxMarketCapUsd: number;
  swingBuyAmountSol: string;
  swingBuyAmountLamports: bigint;
  swingMaxOpenPositions: number;
  swingTrailingStopPct: number;
  swingTakeProfitMultiples: number[];
  swingTakeProfitFractions: number[];
  swingMaxHoldHours: number;
  swingWatchlistPollIntervalMs: number;
  swingMinObservationMinutes: number;
  swingDoubleDipEnabled: boolean;
  swingVolumeAccumEnabled: boolean;
  swingMinScore: number;
  swingAllowDoubleDipOnly: boolean;
  swingMinScoreNoVolume: number;
}

export interface TokenMetadata {
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  usdPrice?: number;
  liquidity?: number;
  launchpad?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  isVerified?: boolean;
  fdvUsd?: number;
  marketCapUsd?: number;
  /** Set when the candidate came from the Jupiter top-traded ("trending") feed. */
  isTrending?: boolean;
  priceUsd?: number;
  organicScore?: number | string;
  fdv?: number | string;
  holderCount?: number | string;
  stats5m?: {
    numBuys: number;
    numSells: number;
  };
  snapshotQuality?: string;
  historicalSource?: string;
  firstPool?: {
    createdAt: string | number;
  };
  audit?: {
    isSus?: boolean;
    topHoldersPercentage?: number;
  };
  source?: string;
  priceHistory?: { price: number; timestamp: number; liquidity?: number }[];
  tapeAtStart?: { buys: number; sells: number };
  tapeHistory?: { buys: number; sells: number; timestamp: number }[];
  volume24h?: number;
  buyPressure?: number;
  sellPressure?: number;
}

export interface Position {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  openedAt: string;
  mode: 'paper' | 'live';
  entryPriceUsd: number;
  entryPriceSol?: number;
  entryUsdValue: number;
  entryScore: number;
  initialTokenAmountRaw: string;
  // Reserved "runner" tranche (raw token units). Routine de-risk exits will not sell below this;
  // it rides on a wide trailing stop (moonBagTrailingDrawdownPct) to capture moonshots. Only hard
  // exits (stop-loss, liquidity/security rug, shutdown, moon-bag trailing) may sell into it.
  moonBagRaw?: string;
  buySignature?: string;
  highestPriceUsd: number;
  partiallyClosed: boolean;
  takeProfitMultiples: number[];
  takeProfitFractions: number[];
  trailingStopDrawdownPctResolved: number;
  maxHoldMinutesResolved: number;
  volatilityScaler: number;
  entryLiquidityUsd: number;
  lastDriftAuditTime?: number;
  lastSecurityAuditAt?: number;
  targetsHit?: number;
  earlyGuardExits?: number;
  lastTakeProfitAt?: string;
  lastTakeProfitMultiple?: number | null;
  lastKnownBalanceRaw?: string;
  balanceZeroSince?: number;
  lastKnownPriceUsd?: number;
  remainingCostUsd?: number;
  remainingCostSol?: number;
  realizedPnlUsd?: number;
  realizedPnlSol?: number;
  realizedProceedsUsd?: number;
  realizedProceedsSol?: number;
  insiderDrifts?: Record<string, boolean>;
  lastExitReason?: string;
  lastSellSignature?: string;
  stopLossWarningSent?: boolean;
  minTpArmed?: boolean;
  minTpReached?: boolean;
  minTpFirstReachedAt?: number | null;
  initialBuyAmountSol?: string | number | null;
  initialBuyAmountLamports?: string;
  paperEntryQuoteOutAmount?: string;
  trailingArmed?: boolean;
  breakEvenStopArmed?: boolean;
  mintSignals?: MintSignals;
  securitySignals?: {
    rugCheck: RugCheckSignals | null;
    bubbleMaps: BubbleMapsSignals | null;
  };
  marketData?: {
    price: number | undefined;
    liquidity: number | undefined;
    volume24h: number | undefined;
    buyPressure: number | undefined;
    sellPressure: number | undefined;
  };
  highGrowthConfidence?: boolean;
  lastKnownLiquidityUsd?: number;
  launchpad?: string | null;
  tpProfile?: string | null;
  highestSeenPriceUsd?: number;
  priceHistory?: { price: number; timestamp: number; liquidity?: number }[];
  tapeHistory?: { buys: number; sells: number; timestamp: number }[];
  spreadHistory?: { spread: number; timestamp: number }[];
  mlFeaturesJson?: string;
  entryProfile?: 'standard' | 'burst' | 'swing';
  burstEntryMomentum?: number;
  burstBuySellRatio?: number;
  burstTrailingDrawdownPct?: number;
  timeSeries?: [number, number, number][];
  entryMarketCapUsd?: number;
  exitPriceUsd?: number;
  /** Pool address for local swap routing (Raydium/Meteora). Populated at entry time from mintToPool. */
  poolAddress?: string;
  /** ML confidence at entry time [0,1]. Used to size exit Jito tips. */
  entryConfidence?: number;
}

export interface GhostPosition {
  mint: string;
  symbol: string;
  entryPriceUsd: number;
  entryScore: number;
  highestPriceUsd: number;
  openedAt: number;
  featuresJson: string;
  tpProfile: string | null;
  launchpad: string | null;
  targetsHit: number;
  sequenceJson?: string;
  timeSeries?: [number, number, number][];
}

export interface MarketSnapshot {
  launchpad: string;
  fdvUsd?: number;
  liquidityUsd?: number;
  liquidity?: number;
  usdPrice?: number;
  observedAt?: string;
  holderCount?: number;
  isVerified?: boolean;
}

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
  exitReasonCounts: Record<string, number>;
  rejectionReasons: Record<string, number>;
}

export interface LaunchHistoryEntry {
  mint: string;
  firstSeenPrice: number;
  highestSeenPrice: number;
  isSuccess: boolean;
  timestamp: number;
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

export interface ClosedTrade {
  mint: string;
  symbol: string;
  exitReason: string;
  realizedPnlUsd: number;
  realizedPnlSol?: number;
  realizedProceedsUsd: number;
  realizedProceedsSol?: number;
  entryUsdValue: number;
  entryPriceUsd: number;
  entryPriceSol?: number;
  highestPriceUsd: number;
  holdSeconds: number;
  closedAt: string;
  entryScore: number;
  tpProfile?: string | null;
  takeProfitMultiples?: number[] | null;
  takeProfitFractions?: number[] | null;
  trailingStopDrawdownPctResolved: number;
  maxHoldMinutesResolved: number;
  volatilityScaler: number;
  entryLiquidityUsd: number;
  launchpad?: string | null;
  targetsHit: number;
  initialBuyAmountSol?: string | number | null;
  isGhost?: boolean;
  holdTimeSeriesJson?: string;
  entryMarketCapUsd?: number;
  exitPriceUsd?: number;
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
  /**
   * Epoch ms until which Jupiter price calls are skipped after a 429, to back off instead of
   * amplifying the rate limit. The on-chain fallback covers prices meanwhile. Not persisted.
   */
  jupiterPriceCooldownUntil: number | null;
  /** Per-key cooldown for the position/monitor path (`JUPITER_POSITION_API_KEY`). Separate from
   *  the scan-path cooldown so a monitor 429 never suppresses discovery price fetches. */
  jupiterPositionPriceCooldownUntil: number | null;
  /** In-memory cache of mint signals pre-fetched during burst survival delays. Not persisted. */
  prefetchedMintSignals: Map<string, MintSignals>;
  /** On-chain bonding curve samples collected during burst survival windows. Not persisted. */
  burstPriceSamples: Map<string, { price: number; liquidity: number; timestamp: number }[]>;
  /** Graduated tokens being observed for swing-bot entry. Not persisted; repopulates after restart. */
  swingWatchlist: Map<string, SwingWatchlistItem>;
  /** Epoch ms until which swing Jupiter price calls are rate-limited. Isolated from sniper cooldown. Not persisted. */
  swingJupiterCooldownUntil: number | null;
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

export interface AdjustedThresholds {
  minLiquidityUsd: number;
  minHolderCount: number;
  minBuys5m: number;
  minPoolAgeSeconds: number;
}

export interface MintSignals {
  decimals: number;
  supplyRaw: bigint;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  top1Share: number;
  top3Share: number;
  top5Share: number;
  topAccounts: Array<{
    address: string;
    rawAmount: bigint;
    share: number;
    owner: string | null;
    ownerLookupError?: string;
  }>;
}

export interface RugCheckSignals {
  status: 'ok' | 'error';
  blockers: string[];
  notes: string[];
  riskScore: number | null;
  rugged: boolean;
  error?: string;
}

export interface BubbleMapsSignals {
  status: 'ok' | 'timeout' | 'error';
  blockers: string[];
  score: number | null;
  largestClusterShare: number | null;
  raw?: unknown;
  error?: string;
}

export interface MlScoreResult {
  confidence: number;
  tpProfile: 'high' | 'standard';
  shadowMode: boolean;
  blocked: boolean;
}

export interface TrainingSample {
  mint: string;
  symbol: string;
  label: 0 | 1;
  featuresJson: string;
  realizedPnlUsd: number;
  entryScore: number;
  tpProfile: string | null;
  launchpad: string | null;
  closedAt: string;
  exitReason?: string;
  holdSeconds?: number;
  highestPriceUsd?: number;
  targetsHit?: number;
  entryPriceUsd?: number;
  sequenceJson?: string;
  holdTimeSeriesJson?: string;
}

export interface DiscoveryLoopTrigger {
  reason?: string;
  forceDiscovery?: boolean;
  skipMonitor?: boolean;
  websocketSignalCount?: number;
  mints?: string[];
  mintLaunchpads?: Record<string, string>;
}

export interface EvaluationResult {
  approved: boolean;
  blockers: string[];
  rejectionReasons: { code: string; recheckEligible: boolean }[];
  notes: string[];
  candidateScore: number;
  volatilityScaler: number;
  launchpadProfile: LaunchpadProfile & { name: string };
  adjustedThresholds: AdjustedThresholds;
  token: TokenMetadata;
  mintSignals?: MintSignals;
  rugCheckSignals?: RugCheckSignals | null;
  bubbleMapsSignals?: BubbleMapsSignals | null;
  mlScore?: MlScoreResult;
  tpProfileOverride?: 'high' | 'standard';
  mlFeaturesJson?: string;
  entryProfile?: 'standard' | 'burst';
  burstEntryMomentum?: number;
  burstBuySellRatio?: number;
  burstTrailingDrawdownPct?: number;
}

export interface SwingSwapTick {
  side: 'buy' | 'sell';
  amountSol: number;
  timestamp: number;
}

export interface SwingWatchlistItem {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  fdvUsd: number;
  addedAt: number;
  lastPolledAt: number;
  priceHistory: { price: number; timestamp: number; liquidity?: number }[];
  tapeHistory: { buys: number; sells: number; timestamp: number }[];
  lastKnownPrice: number;
  lastKnownLiquidity: number;
  pool: 'raydium' | 'meteora' | 'unknown';
  launchpad?: string;
  fastPollUntil?: number;
  ammId?: string;
  solIsTokenX?: boolean;
  raydiumPoolType?: 'amm-v4' | 'clmm';
  swapTape?: SwingSwapTick[];
}

export interface SwingSignals {
  doubleDipDetected: boolean;
  dip1LowPrice: number;
  dip1LowIdx: number;
  bounceHighPrice: number;
  bounceHighIdx: number;
  dip2LowPrice: number;
  dip2LowIdx: number;
  recoveryPct: number;
  higherLow: boolean;
  volumeAccumDetected: boolean;
  buySellRatioTrend: number;
  buyCountDip1: number;
  buyCountDip2: number;
  sellCountDip1: number;
  sellCountDip2: number;
  totalScore: number;
  approved: boolean;
  blockers: string[];
}

export interface SwingEvaluationResult {
  approved: boolean;
  score: number;
  blockers: string[];
  signals: SwingSignals;
  item: SwingWatchlistItem;
}

export interface Context {
  config: Config;
  state: State;
  rpc: Rpc<SolanaRpcApi>;
  rpcs: Rpc<SolanaRpcApi>[];
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  rpcSubscriptionPool: RpcSubscriptions<SolanaRpcSubscriptionsApi>[];
  wallet: { address: string; keypair?: KeyPairSigner };
  logger: (
    message: string,
    level?: LogLevel,
    options?: { console?: boolean; sync?: boolean }
  ) => void;
  persistState: (options?: { sync?: boolean; force?: boolean }) => Promise<void>;
  calculateGMI: () => number;
  rotateRpcSubscriptions: () => void;
  getCurrentRpcSubscriptions: () => RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  store: StateStore;
  tui?: {
    log: (message: string, level?: LogLevel) => void;
    refresh: (backpressureFactor?: number) => void;
  };
  getBackpressureFactor?: () => number;
  recordScanBackpressureEvent?: (error: unknown) => void;
  getEffectiveParallelism?: (base: number) => number;
  scanBackpressureFactor?: number;
  subscribeToVaultBalances?: (
    mint: string,
    poolAddress: string,
    type: 'raydium' | 'meteora'
  ) => Promise<void>;
  unsubscribeFromVaultBalances?: (mint: string) => void;
}

/**
 * Optional inputs for the probabilistic Jito tip on a buy. When present, the tip
 * is scaled by ML confidence and block congestion and capped at a fraction of the
 * trade's expected profit. Absent → the plain tip-floor logic is used (e.g. sells).
 */
export interface TipContext {
  /** ML confidence in [0,1]. */
  confidence: number;
  /** Expected gross profit of the trade, in lamports (caps the tip). */
  expectedValueLamports: bigint;
  /** Override panic multiplier with a graduated urgency factor (replaces binary isPanic scaling). */
  urgencyMultiplier?: number;
}

export interface SwapOrder {
  transaction: string;
  lastValidBlockHeight?: number;
  requestId?: string;
  errorMessage?: string;
  error?: string;
  inUsdValue?: number | string;
  outAmount?: string;
}

export interface WalletBalance {
  mint: string;
  rawAmount: bigint;
  decimals: number;
  uiAmount: number;
}

export interface ParsedInstruction {
  parsed?: {
    type?: string;
    info?: {
      mint?: string;
    };
  };
}

export interface InnerInstruction {
  instructions: ParsedInstruction[];
}

export interface TxTokenBalance {
  mint: string;
  owner: string;
  uiTokenAmount: {
    amount: string;
    decimals: number;
  };
}

export interface TransactionData {
  transaction?: {
    message?: {
      instructions: ParsedInstruction[];
    };
  };
  meta?: {
    innerInstructions?: InnerInstruction[];
    postTokenBalances?: TxTokenBalance[];
    preTokenBalances?: TxTokenBalance[];
  };
}
