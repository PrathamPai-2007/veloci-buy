import path from 'node:path';
import fs from 'node:fs';
import { decimalToAtomic, deriveWsRpcUrl, safeConsole } from './utils.js';
import { Config } from '../types/index.js';

// --- Environment Loading ---

/**
 * Simple .env loader to support local development without external dependencies.
 */
function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;

  try {
    const content = fs.readFileSync(envPath, 'utf8');
    content.split(/\r?\n/).forEach((line) => {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith('#')) return;

      const [key, ...valueParts] = trimmedLine.split('=');
      if (!key) return;
      const keyTrimmed = key.trim();
      const valueRaw = valueParts.join('=').trim();

      // Shell-provided values win over .env so production deploys can inject secrets safely.
      if (keyTrimmed && !process.env[keyTrimmed]) {
        // Remove optional surrounding quotes
        process.env[keyTrimmed] = valueRaw.replace(/^["'](.*)["']$/, '$1');
      }
    });
  } catch (err: unknown) {
    safeConsole(
      'error',
      `[CONFIG] Failed to parse .env file: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

loadDotEnv();

export * from './constants.js';
export * from './strategy-loader.js';
import { loadStrategy, DEFAULT_STRATEGY } from './strategy-loader.js';
import { DEFAULT_MEME_KEYWORDS, DEFAULT_STATE_FILE } from './constants.js';

// Burst's higher throughput (raised maxConcurrentAudits, tight survival rechecks) plus all-on-chain
// pricing via getMultipleAccounts assumes a premium dedicated RPC. On a public/free node this preset
// will trigger repeated 429s. See docs/rate-limits.md and src/services/burst/README.md.
const BURST_PRESET: Partial<import('../types/index.js').PresetStrategy> = {
  name: 'Burst',
  minLiquidityUsd: 2600,
  minHolderCount: 0,
  maxRecheckAttempts: 2,
  minCandidateScore: 45,
  stopLossPct: 0.05,
  takeProfitMultiples: [1.2],
  survivalDelaySeconds: 2,
  maxOpenPositions: 8,
  minSurvivalMomentum: 1.0,
  minBreakoutMultiplier: 1.0,
  maxPriceDumpPct: 12,
  maxSurvivalGrowthPct: 5000,
  maxSellPressureIncreasePct: 180,
  maxAuditTopHoldersPct: 90,
  minMomentumConsistency: 0.55,
  minAccelerationFactor: 0.18,
  maxConcurrentAudits: 20,
  scanParallelismLight: 10,
  scanParallelismHeavy: 10,
  ownerAuditParallelism: 5,
  priceFallbackParallelism: 10,
  parallelismMinFactor: 0.4,
  errorRateWindow: 50,
  backpressureErrorRateThreshold: 0.35,
  mintSignalMaxAttempts: 1,
  mintSignalRetryDelayMs: 200,
  rpcIndexingRetryDelayMs: 2000,
  mlScoreGateThreshold: 0.15,
  mlScoreWeight: 0.25,
  slippageBps: 300,
  burstSurvivalSeconds: 5,
  burstMinMomentum: 1.005,
  burstMaxSolOutflowPct: 0.05,
  burstMaxEntryDrawdownPct: 5,
  burstMinBuySellRatio: 1.15,
  burstTrailingDrawdownPct: 0.08,
  burstMaxHoldMinutes: 5,
  burstTakeProfitMultiples: [1.2],
  burstTakeProfitFractions: [1.0],
  // Skip the final-audit delay — survival window already provides all needed price history.
  finalAuditSeconds: 0,
};
/**
 * Retrieves a required environment variable or throws an error.
 * @param name - The name of the environment variable.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Parses a number from an environment variable with a fallback value.
 * @param name - The name of the environment variable.
 * @param fallback - The fallback value if the environment variable is not set.
 */
function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid number in ${name}: ${raw}`);
  }
  return value;
}

/**
 * Parses a boolean from an environment variable with a fallback value.
 * @param name - The name of the environment variable.
 * @param fallback - The fallback value if the environment variable is not set.
 */
function booleanFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

/**
 * Loads and constructs the application configuration from environment variables and presets.
 * @throws {Error} If critical configuration is missing or invalid.
 */
export function loadConfig(): Config {
  const rugcheckEnabled = booleanFromEnv('RUGCHECK_ENABLED', false);
  const bubblemapsEnabled = booleanFromEnv('BUBBLEMAPS_ENABLED', false);
  const burstModeEnabled = booleanFromEnv('BURST_MODE_ENABLED', false);
  const strategyName = burstModeEnabled
    ? 'burst'
    : (process.env.STRATEGY || 'standard').toLowerCase();
  const preset = burstModeEnabled
    ? { ...DEFAULT_STRATEGY, ...BURST_PRESET }
    : loadStrategy(strategyName);

  const rpcUrlRaw = requireEnv('RPC_URL');
  const rpcUrls = rpcUrlRaw
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);

  const wsRpcUrlRaw = process.env.WS_RPC_URL;
  const wsRpcUrls = wsRpcUrlRaw
    ? wsRpcUrlRaw
        .split(',')
        .map((u) => u.trim())
        .filter(Boolean)
    : rpcUrls.map((u) => deriveWsRpcUrl(u));

  const jupiterApiKey = requireEnv('JUPITER_API_KEY');
  const jupiterPositionApiKey = process.env.JUPITER_POSITION_API_KEY || jupiterApiKey;
  const privateKey = process.env.PRIVATE_KEY || '';
  const privateKeyPath = process.env.PRIVATE_KEY_PATH || '';
  const keystorePath = process.env.KEYSTORE_PATH || '';
  const keystorePassword = process.env.KEYSTORE_PASSWORD || '';

  if (!privateKey && !privateKeyPath && !keystorePath) {
    throw new Error(
      'Startup configuration error: PRIVATE_KEY, PRIVATE_KEY_PATH, or KEYSTORE_PATH is required.'
    );
  }

  const buyAmountText = process.env.BUY_AMOUNT_SOL || '0.05';
  if (!/^\d+(\.\d+)?$/.test(String(buyAmountText).trim())) {
    throw new Error(
      `Startup configuration error: BUY_AMOUNT_SOL must be a positive decimal, got "${buyAmountText}".`
    );
  }

  const scanIntervalMs = numberFromEnv('SCAN_INTERVAL_MS', 4000);
  const discoveryPollIntervalMs = numberFromEnv('DISCOVERY_POLL_INTERVAL_MS', 20000);

  const paperTrading = booleanFromEnv('PAPER_TRADING', false);
  // Each run gets an isolated session directory so state, metrics, and journals do not overwrite prior runs.
  const sessionType = paperTrading ? 'paper-trading' : 'live-trading';
  const timestamp = new Date().toISOString().replace('T', '_').replace(/[:.]/g, '-').slice(0, 19);
  const sessionDir = path.join('logs', sessionType, timestamp);

  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const stateFile = process.env.STATE_FILE || DEFAULT_STATE_FILE;
  const resolvedStateFile = stateFile
    ? path.isAbsolute(stateFile)
      ? stateFile
      : path.join('data', path.basename(stateFile))
    : '';

  if (resolvedStateFile) {
    const stateDir = path.dirname(resolvedStateFile);
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }
  }

  const logFile = process.env.LOG_FILE || './bot.log';
  const scannedTokensFile = process.env.SCANNED_TOKENS_FILE || './scanned-memecoins.jsonl';

  return {
    strategyName,
    rpcUrls,
    wsRpcUrls,
    rpcUrl: rpcUrls[0] || '',
    wsRpcUrl: wsRpcUrls[0] || '',
    jupiterApiKey,
    jupiterPositionApiKey,
    jupiterBaseUrl: (process.env.JUPITER_BASE_URL || 'https://api.jup.ag').replace(/\/+$/, ''),
    rugcheckBaseUrl: (process.env.RUGCHECK_BASE_URL || 'https://api.rugcheck.xyz/v1').replace(
      /\/+$/,
      ''
    ),
    rugcheckApiKey: process.env.RUGCHECK_API_KEY || '',
    bubbleMapsBaseUrl: (process.env.BUBBLEMAPS_BASE_URL || 'https://api.bubblemaps.io').replace(
      /\/+$/,
      ''
    ),
    scanIntervalMs,
    discoveryPollIntervalMs,
    discoveryWsEnabled: booleanFromEnv('DISCOVERY_WS_ENABLED', true),
    discoveryPumpEnabled: booleanFromEnv('DISCOVERY_PUMP_ENABLED', true),
    discoveryRaydiumEnabled: booleanFromEnv('DISCOVERY_RAYDIUM_ENABLED', true),
    discoveryMeteoraEnabled: booleanFromEnv('DISCOVERY_METEORA_ENABLED', true),
    discoveryWsDebounceMs: numberFromEnv('DISCOVERY_WS_DEBOUNCE_MS', 300),
    buyAmountSolText: buyAmountText,
    buyAmountLamports: BigInt(decimalToAtomic(buyAmountText, 9)),
    slippageBps: numberFromEnv('SLIPPAGE_BPS', preset.slippageBps ?? 500),
    maxConcurrentAudits: numberFromEnv('MAX_CONCURRENT_AUDITS', preset.maxConcurrentAudits),
    scanParallelismLight: numberFromEnv('SCAN_PARALLELISM_LIGHT', preset.scanParallelismLight),
    scanParallelismHeavy: numberFromEnv('SCAN_PARALLELISM_HEAVY', preset.scanParallelismHeavy),
    ownerAuditParallelism: numberFromEnv('OWNER_AUDIT_PARALLELISM', preset.ownerAuditParallelism),
    priceFallbackParallelism: numberFromEnv(
      'PRICE_FALLBACK_PARALLELISM',
      preset.priceFallbackParallelism
    ),
    parallelismMinFactor: numberFromEnv('PARALLELISM_MIN_FACTOR', preset.parallelismMinFactor),
    errorRateWindow: numberFromEnv('ERROR_RATE_WINDOW', preset.errorRateWindow),
    backpressureErrorRateThreshold: numberFromEnv(
      'BACKPRESSURE_ERROR_RATE_THRESHOLD',
      preset.backpressureErrorRateThreshold
    ),
    mintSignalMaxAttempts: numberFromEnv('MINT_SIGNAL_MAX_ATTEMPTS', preset.mintSignalMaxAttempts),
    mintSignalRetryDelayMs: numberFromEnv(
      'MINT_SIGNAL_RETRY_DELAY_MS',
      preset.mintSignalRetryDelayMs
    ),
    rpcIndexingRetryDelayMs: numberFromEnv(
      'RPC_INDEXING_RETRY_DELAY_MS',
      preset.rpcIndexingRetryDelayMs
    ),
    maxOpenPositions: numberFromEnv('MAX_OPEN_POSITIONS', preset.maxOpenPositions),
    maxBuysPerScan: numberFromEnv('MAX_BUYS_PER_SCAN', 2),
    maxCandidatesPerScan: numberFromEnv('MAX_CANDIDATES_PER_SCAN', 9),
    dryRun: booleanFromEnv('DRY_RUN', true),
    paperTrading,
    liveTradingEnabled: booleanFromEnv('LIVE_TRADING_ENABLED', false),
    apiPort: numberFromEnv('API_PORT', 8080),
    apiHost: process.env.API_HOST || '127.0.0.1',
    apiToken: process.env.API_TOKEN || '',
    initialPaperSolText: process.env.INITIAL_PAPER_SOL || '0.1',
    initialPaperSolLamports: BigInt(decimalToAtomic(process.env.INITIAL_PAPER_SOL || '0.1', 9)),
    sessionDir,
    stateFile: resolvedStateFile,
    logFile: path.join(sessionDir, path.basename(logFile)),
    scannedTokensFile: path.join(sessionDir, path.basename(scannedTokensFile)),
    paperTradeJournalFile: path.join(sessionDir, 'paper-trade-journal.jsonl'),
    tradeJournalFile: path.join(sessionDir, 'trade-journal.jsonl'),
    performanceStatsFile: path.join(sessionDir, 'performance-stats.json'),
    metricsFile: path.join(sessionDir, 'metrics.json'),
    stateFlushIntervalMs: numberFromEnv('STATE_FLUSH_INTERVAL_MS', 250),
    minLiquidityUsd: numberFromEnv('MIN_LIQUIDITY_USD', preset.minLiquidityUsd),
    minOrganicScore: numberFromEnv('MIN_ORGANIC_SCORE', 0),
    minHolderCount: numberFromEnv('MIN_HOLDER_COUNT', preset.minHolderCount),
    minBuys5m: numberFromEnv('MIN_BUYS_5M', 1),
    minPoolAgeSeconds: numberFromEnv('MIN_POOL_AGE_SECONDS', 0),
    maxCandidateAgeMinutes: numberFromEnv('MAX_CANDIDATE_AGE_MINUTES', 30),
    minSocialLinks: numberFromEnv('MIN_SOCIAL_LINKS', 0),
    maxAuditTopHoldersPct: numberFromEnv('MAX_AUDIT_TOP_HOLDERS_PCT', preset.maxAuditTopHoldersPct),
    // Tightened 70 -> 40: research shows a single wallet holding >40% can rug in one transaction.
    // 70% was far too permissive — effectively only blocked extreme edge cases.
    maxTokenAccountTop1Pct: numberFromEnv('MAX_TOKEN_ACCOUNT_TOP1_PCT', 40),
    // New: top-3 concentration gate to catch bundler/insider coordinated launches.
    // Research: top-3 wallets holding >20-25% = likely bundled sniper acquisition.
    maxTokenAccountTop3Pct: numberFromEnv('MAX_TOKEN_ACCOUNT_TOP3_PCT', 30),
    // Lowered 85 -> 65 -> 54: across 21 post-optimization paper trades, entry top5 share was a
    // razor-clean separator — every winner sat at <=0.540 (incl. all 3 runners) and every loser at
    // >=0.547. 65 still let the entire 0.547-0.625 loser cluster through; 54 blocks it while keeping
    // all winners. Runs unconditionally (see engine.service.ts), not only when BubbleMaps is present.
    maxTokenAccountTop5Pct: numberFromEnv('MAX_TOKEN_ACCOUNT_TOP5_PCT', 48),
    // Cap the buy as a fraction of pool liquidity. Buying ~$1.6k into a $2-4k pool makes the bot
    // a huge share of liquidity (bad fills, can't exit). 0.15 keeps entries to depth that can
    // actually be exited. Enforced at execution time in buy.ts (past the latency-critical snipe).
    maxBuyLiquidityFraction: numberFromEnv('MAX_BUY_LIQUIDITY_FRACTION', 0.15),
    // Moon-bag: fraction of each position reserved as a runner. Exempt from routine de-risk
    // exits; rides on a wide trailing stop so one 10x pays for many small losses (expectancy).
    // Steady profile: smaller speculative runner and a tighter moon-bag trailing stop so the
    // reserved runner round-trips less of its peak.
    moonBagFraction: numberFromEnv('MOON_BAG_FRACTION', 0.1),
    moonBagTrailingDrawdownPct: numberFromEnv('MOON_BAG_TRAILING_DRAWDOWN_PCT', 0.3),
    // top5 share above which an insider dump is treated as a rug (full panic exit) rather than a
    // routine 40% de-risk. Below it, holder churn is normal and we stop trimming on it.
    insiderDriftConcentrationTop5: numberFromEnv('INSIDER_DRIFT_CONCENTRATION_TOP5', 0.6),
    maxFdvToLiquidity: numberFromEnv('MAX_FDV_TO_LIQUIDITY', 80),
    maxMemeFdvUsd: numberFromEnv('MAX_MEME_FDV_USD', 10000000),
    minMarketCapUsd: numberFromEnv('MIN_MARKET_CAP_USD', preset.minMarketCapUsd ?? 1000),
    allowVerifiedTokens: booleanFromEnv('ALLOW_VERIFIED_TOKENS', true),
    memeKeywords: (process.env.MEME_KEYWORDS || DEFAULT_MEME_KEYWORDS.join(','))
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
    bubbleMapsApiKey: process.env.BUBBLEMAPS_API_KEY || '',
    heliusApiKey: process.env.HELIUS_API_KEY || '',
    minBubbleMapsScore: numberFromEnv('MIN_BUBBLEMAPS_SCORE', 60),
    maxBubbleMapsLargestClusterShare: numberFromEnv('MAX_BUBBLEMAPS_LARGEST_CLUSTER_SHARE', 0.2),
    trendingDiscoveryEnabled: booleanFromEnv('TRENDING_DISCOVERY_ENABLED', true),
    trendingPollIntervalMs: numberFromEnv('TRENDING_POLL_INTERVAL_MS', 20_000),
    trendingInterval: process.env.TRENDING_INTERVAL || '5m',
    trendingMaxSurvivalGrowthPct: numberFromEnv('TRENDING_MAX_SURVIVAL_GROWTH_PCT', 900),
    trendingMaxBuyTopGrowthPct: numberFromEnv('TRENDING_MAX_BUY_TOP_GROWTH_PCT', 250),
    trendingMaxPriceDumpPct: numberFromEnv('TRENDING_MAX_PRICE_DUMP_PCT', 30),
    trendingMaxTokenAccountTop1Pct: numberFromEnv('TRENDING_MAX_TOKEN_ACCOUNT_TOP1_PCT', 80),
    trendingMaxTokenAccountTop5Pct: numberFromEnv('TRENDING_MAX_TOKEN_ACCOUNT_TOP5_PCT', 80),
    trendingMinBubbleMapsScore: numberFromEnv('TRENDING_MIN_BUBBLEMAPS_SCORE', 40),
    minCandidateScore: numberFromEnv('MIN_CANDIDATE_SCORE', preset.minCandidateScore),
    // Adds a signed momentum/flow delta to the structural entry score (computeMomentumScore).
    // Flag-gated for A/B; on by default. Demotes tokens dumping in the survival window.
    momentumScoringEnabled: booleanFromEnv('MOMENTUM_SCORING_ENABLED', true),
    maxRecheckAttempts: numberFromEnv('MAX_RECHECK_ATTEMPTS', preset.maxRecheckAttempts),
    minMomentumConsistency: numberFromEnv(
      'MIN_MOMENTUM_CONSISTENCY',
      preset.minMomentumConsistency
    ),
    maxExhaustionRangePct: numberFromEnv('MAX_EXHAUSTION_RANGE_PCT', 1.6),
    highGrowthConfidenceScore: numberFromEnv('HIGH_GROWTH_CONFIDENCE_SCORE', 80),
    standardGrowthConfidenceScore: numberFromEnv('STANDARD_GROWTH_CONFIDENCE_SCORE', 70),
    borderlineRecheckEnabled: booleanFromEnv('BORDERLINE_RECHECK_ENABLED', true),
    borderlineRecheckMinDelayMs: numberFromEnv('BORDERLINE_RECHECK_MIN_DELAY_MS', 2),
    borderlineRecheckMaxDelayMs: numberFromEnv('BORDERLINE_RECHECK_MAX_DELAY_MS', 20_000),
    borderlineRecheckMaxAttempts: numberFromEnv('BORDERLINE_RECHECK_MAX_ATTEMPTS', 6),
    borderlineThresholdBufferRatio: numberFromEnv('BORDERLINE_THRESHOLD_BUFFER_PCT', 20) / 100,
    survivalDelaySeconds: numberFromEnv('SURVIVAL_DELAY_SECONDS', preset.survivalDelaySeconds),
    survivalDelayThresholdHigh: numberFromEnv('SURVIVAL_DELAY_THRESHOLD_HIGH', 75),
    survivalDelayThresholdVeryHigh: numberFromEnv('SURVIVAL_DELAY_THRESHOLD_VERY_HIGH', 90),
    finalAuditSeconds: numberFromEnv('FINAL_AUDIT_SECONDS', preset.finalAuditSeconds ?? 5),
    minSurvivalMomentum: numberFromEnv('MIN_SURVIVAL_MOMENTUM', preset.minSurvivalMomentum),
    minBreakoutMultiplier: numberFromEnv('MIN_BREAKOUT_MULTIPLIER', preset.minBreakoutMultiplier),
    maxPriceDumpPct: numberFromEnv('MAX_PRICE_DUMP_PCT', preset.maxPriceDumpPct),
    maxLiquidityDrawdownPct: numberFromEnv('MAX_LIQUIDITY_DRAWDOWN_PCT', 15),
    // Lowered 120 -> 70: the early-performance-guard cluster (JAMES x3, MAGICS) was the bot buying
    // late-stage parabolic pumps that immediately reversed. Reject candidates already >70% up since
    // the survival window started so we stop buying the top.
    maxBuyTopGrowthPct: numberFromEnv('MAX_BUY_TOP_GROWTH_PCT', 70),
    buyTopAthBufferPct: numberFromEnv('BUY_TOP_ATH_BUFFER_PCT', 2),
    buyingTheTopSlPct: numberFromEnv('BUYING_THE_TOP_SL_PCT', 25),
    performanceCheckSeconds: numberFromEnv('PERFORMANCE_CHECK_SECONDS', 240),
    performanceMinMomentum: numberFromEnv('PERFORMANCE_MIN_MOMENTUM', 1.05),
    minHoldTimeSeconds: numberFromEnv('MIN_HOLD_TIME_SECONDS', 1),
    websocketWatchdogIntervalMs: numberFromEnv('WEBSOCKET_WATCHDOG_INTERVAL_MS', 10_000),
    websocketStaleThresholdMs: numberFromEnv('WEBSOCKET_STALE_THRESHOLD_MS', 90_000),
    websocketHandshakeTimeoutMs: numberFromEnv('WEBSOCKET_HANDSHAKE_TIMEOUT_MS', 15_000),
    stopLossPct: numberFromEnv('STOP_LOSS_PCT', preset.stopLossPct),
    // Tightened 0.2 -> 0.15 for the steady-profit profile. baseTrailing feeds the resolved per-
    // profile trailing in exit-calculator (high = base+0.04, standard = base), so
    // this also pulls the high-confidence runner stop down from 0.24 to 0.19.
    trailingStopDrawdownPct: numberFromEnv(
      'TRAILING_STOP_DRAWDOWN_PCT',
      preset.trailingStopDrawdownPct ?? 0.15
    ),
    // Breakeven ratchet: after a TP target is banked, lock the stop to ~entry so a winner can't
    // become a net loser. Buffer covers fees/slippage. See monitor.service.ts.
    breakevenRatchetEnabled: booleanFromEnv('BREAKEVEN_RATCHET_ENABLED', true),
    breakevenRatchetBufferPct: numberFromEnv('BREAKEVEN_RATCHET_BUFFER_PCT', 0.01),
    // SL breakeven: once the position has ever seen >= threshold% unrealized gain,
    // lift the stop floor to ~entry so a pump-and-dump can't turn into a net loss.
    // Complements the ratchet (post-TP) by covering pre-TP pumps. Uses highestPriceUsd.
    // (Operates inside the stop-loss computation as a floor adjustment.)
    slBreakevenEnabled: booleanFromEnv('SL_BREAKEVEN_ENABLED', true),
    slBreakevenThresholdPct: numberFromEnv('SL_BREAKEVEN_THRESHOLD_PCT', 0.07),
    slBreakevenBufferPct: numberFromEnv('SL_BREAKEVEN_BUFFER_PCT', 0.005),
    // Break-even stop: dedicated monitor guard that fires BEFORE early-performance-guard.
    // Arms once highestPriceUsd >= entry * triggerMultiple (default +10%). Thereafter, if price
    // retreats to <= entry * (1 + floorPct), exit immediately with reason 'breakeven-stop'.
    // Prevents positions that peaked significantly from closing at a loss through any exit path.
    breakEvenStopEnabled: booleanFromEnv('BREAK_EVEN_STOP_ENABLED', true),
    breakEvenStopTriggerMultiple: numberFromEnv(
      'BREAK_EVEN_STOP_TRIGGER_MULTIPLE',
      preset.breakEvenStopTriggerMultiple ?? 1.06
    ),
    breakEvenStopFloorPct: numberFromEnv(
      'BREAK_EVEN_STOP_FLOOR_PCT',
      preset.breakEvenStopFloorPct ?? 0.04
    ),
    // Graduated initial stop: tighten stop in first N seconds after entry so a stale fill or
    // immediate dump exits at a smaller loss. Relaxes to normal adjustedSlPct after midWindow.
    earlyStopLossPct: numberFromEnv('EARLY_STOP_LOSS_PCT', 0.1),
    earlyStopLossWindowSec: numberFromEnv('EARLY_STOP_LOSS_WINDOW_SEC', 30),
    midStopLossPct: numberFromEnv('MID_STOP_LOSS_PCT', 0.15),
    midStopLossWindowSec: numberFromEnv('MID_STOP_LOSS_WINDOW_SEC', 120),
    takeProfitMultiples: (process.env.TAKE_PROFIT_MULTIPLES || preset.takeProfitMultiples.join(','))
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((v) => !isNaN(v)),
    takeProfitMultiplesHigh: (
      process.env.TAKE_PROFIT_MULTIPLES_HIGH ||
      preset.takeProfitMultiplesHigh?.join(',') ||
      preset.takeProfitMultiples.join(',')
    )
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((v) => !isNaN(v) && v > 1),
    takeProfitFractions: (
      process.env.TAKE_PROFIT_FRACTIONS ||
      preset.takeProfitFractions?.join(',') ||
      '0.75,0.6'
    )
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((v) => !isNaN(v)),
    takeProfitFraction: numberFromEnv('TAKE_PROFIT_FRACTION', 0.6),
    // Widened window (15 -> 25s) and full bail (50 -> 100%) on an instant post-entry reversal.
    // The MAGICS/JAMES pattern is a hard reversal within seconds — half-exiting just bleeds the
    // rest into a stop-loss, so fully exit.
    earlyPerformanceGuardSeconds: numberFromEnv('EARLY_PERFORMANCE_GUARD_SECONDS', 60),
    earlyPerformanceDropPct: numberFromEnv('EARLY_PERFORMANCE_DROP_PCT', 10),
    earlyPerformanceSellPct: numberFromEnv('EARLY_PERFORMANCE_SELL_PCT', 50),
    // Rug-exit guard: if price drops, spread widens, or volume collapses within first N seconds,
    // exit immediately to cut losses. Fires before EPG window opens.
    rugExitGuardEnabled: booleanFromEnv('RUG_EXIT_GUARD_ENABLED', true),
    rugExitWindowSec: numberFromEnv('RUG_EXIT_WINDOW_SEC', 10),
    rugExitDropPct: numberFromEnv('RUG_EXIT_DROP_PCT', 0.05),
    rugExitDynamicScalingEnabled: booleanFromEnv('RUG_EXIT_DYNAMIC_SCALING_ENABLED', true),
    rugExitMicroCapThresholdUsd: numberFromEnv('RUG_EXIT_MICRO_CAP_THRESHOLD_USD', 100_000),
    rugExitMicroCapMultiplier: numberFromEnv('RUG_EXIT_MICRO_CAP_MULTIPLIER', 1.8),
    rugExitHighCapThresholdUsd: numberFromEnv('RUG_EXIT_HIGH_CAP_THRESHOLD_USD', 500_000),
    rugExitHighCapMultiplier: numberFromEnv('RUG_EXIT_HIGH_CAP_MULTIPLIER', 0.7),
    rugExitVolatilityScalingEnabled: booleanFromEnv('RUG_EXIT_VOLATILITY_SCALING_ENABLED', true),
    rugExitSpreadGuardEnabled: booleanFromEnv('RUG_EXIT_SPREAD_GUARD_ENABLED', true),
    rugExitMaxSpreadPct: numberFromEnv('RUG_EXIT_MAX_SPREAD_PCT', 0.15),
    rugExitSpreadExpansionMultiplier: numberFromEnv('RUG_EXIT_SPREAD_EXPANSION_MULTIPLIER', 2.0),
    rugExitVolumeGuardEnabled: booleanFromEnv('RUG_EXIT_VOLUME_GUARD_ENABLED', true),
    rugExitSellDominanceMultiplier: numberFromEnv('RUG_EXIT_SELL_DOMINANCE_MULTIPLIER', 2.5),
    maxHoldMinutes: numberFromEnv('MAX_HOLD_MINUTES', preset.maxHoldMinutes ?? 20),
    timeExitMinMultiple: numberFromEnv('TIME_EXIT_MIN_MULTIPLE', 1.25),
    liquidityCollapseThresholdUsd: numberFromEnv('LIQUIDITY_COLLAPSE_THRESHOLD_USD', 750),
    liquidityCollapseThresholdRatio: numberFromEnv('LIQUIDITY_COLLAPSE_THRESHOLD_RATIO', 0.25),
    holdDurationHighConfidenceMinutes: numberFromEnv(
      'HOLD_DURATION_HIGH_CONFIDENCE_MINUTES',
      preset.holdDurationHighConfidenceMinutes ?? 30
    ),
    holdDurationLowConfidenceMinutes: numberFromEnv('HOLD_DURATION_LOW_CONFIDENCE_MINUTES', 5),
    recheckPriceDropPct: numberFromEnv('RECHECK_PRICE_DROP_PCT', 15),
    moodPauseDurationMinutes: numberFromEnv('MOOD_PAUSE_DURATION_MINUTES', 60),
    coolDownMinutes: numberFromEnv('COOL_DOWN_MINUTES', 5),
    holderCountWaitlistSeconds: numberFromEnv('HOLDER_COUNT_WAITLIST_SECONDS', 33),
    reentryDipPct: numberFromEnv('REENTRY_DIP_PCT', 15),
    reentryBreakoutPct: numberFromEnv('REENTRY_BREAKOUT_PCT', 20),
    maxSurvivalGrowthPct: numberFromEnv('MAX_SURVIVAL_GROWTH_PCT', preset.maxSurvivalGrowthPct),
    minAccelerationFactor: numberFromEnv('MIN_ACCELERATION_FACTOR', preset.minAccelerationFactor),
    maxSellPressureIncreasePct: numberFromEnv(
      'MAX_SELL_PRESSURE_INCREASE_PCT',
      preset.maxSellPressureIncreasePct
    ),
    priorityFeeBaseMicroLamports: numberFromEnv('PRIORITY_FEE_BASE_MICRO_LAMPORTS', 25_000),
    priorityFeeMaxMicroLamports: numberFromEnv('PRIORITY_FEE_MAX_MICRO_LAMPORTS', 5_000_000),
    priorityFeePanicMultiplier: numberFromEnv('PRIORITY_FEE_PANIC_MULTIPLIER', 2.0),
    priorityFeePercentile: numberFromEnv('PRIORITY_FEE_PERCENTILE', 75),
    useJito: booleanFromEnv('USE_JITO', false),
    dynamicJitoTipEnabled: booleanFromEnv('DYNAMIC_JITO_TIP_ENABLED', false),
    jitoTipLamports: BigInt(decimalToAtomic(process.env.JITO_TIP_SOL || '0.001', 9)),
    jitoBlockEngineUrl:
      process.env.JITO_BLOCK_ENGINE_URL || 'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
    jitoTipPercentile: numberFromEnv('JITO_TIP_PERCENTILE', 75),
    jitoTipFloorApiUrl: process.env.JITO_TIP_FLOOR_API_URL || '',
    jitoTipMaxFractionOfEv: numberFromEnv('JITO_TIP_MAX_FRACTION_OF_EV', 0.25),
    jitoConfirmTimeoutMs: numberFromEnv('JITO_CONFIRM_TIMEOUT_MS', 30000),
    jitoBundleRetryAttempts: numberFromEnv('JITO_BUNDLE_RETRY_ATTEMPTS', 3),
    priorityFeeAccountLocal: booleanFromEnv('PRIORITY_FEE_ACCOUNT_LOCAL', true),
    priorityFeeVolatilityMultiplier: numberFromEnv('PRIORITY_FEE_VOLATILITY_MULTIPLIER', 1.0),
    maxAutoSlippageRetry: numberFromEnv('MAX_AUTO_SLIPPAGE_RETRY', 3),
    autoSlippageIncrementBps: numberFromEnv('AUTO_SLIPPAGE_INCREMENT_BPS', 100),
    useJupiterSdk: booleanFromEnv('USE_JUPITER_SDK', true),
    inlineSwapSimulation: booleanFromEnv('INLINE_SWAP_SIMULATION', true),
    backgroundAtaClose: booleanFromEnv('BACKGROUND_ATA_CLOSE', true),
    closePositionsOnShutdown: booleanFromEnv('CLOSE_POSITIONS_ON_SHUTDOWN', true),
    privateKey,
    privateKeyPath,
    keystorePath,
    keystorePassword,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
    maxDailyDrawdownPct: numberFromEnv('MAX_DAILY_DRAWDOWN_PCT', 0.3),
    circuitBreakerEnabled: booleanFromEnv('CIRCUIT_BREAKER_ENABLED', true),
    drawdownCooldownMinutes: numberFromEnv('DRAWDOWN_COOLDOWN_MINUTES', 30),
    // Loss-streak brake: the 30% portfolio-drawdown breaker above is too coarse to catch a slow
    // bleed (a paper session lost ~$2.4 over 9 small losses in 80m without ever tripping it).
    // After N consecutive losing positions, pause new entries for a short cooldown so the bot stops
    // firing into a hostile tape. Reuses the drawdownPauseUntil pause plumbing.
    lossStreakBreakerEnabled: booleanFromEnv('LOSS_STREAK_BREAKER_ENABLED', true),
    lossStreakThreshold: numberFromEnv('LOSS_STREAK_THRESHOLD', 3),
    lossStreakCooldownMinutes: numberFromEnv('LOSS_STREAK_COOLDOWN_MINUTES', 20),
    // Expectancy breaker: the consecutive-loss brake above resets on any win, so a session that
    // bleeds via small losses interleaved with small wins (L,L,W,L,L,W…) never arms it even while
    // net-negative. This pauses new buys when the trailing window of realized PnL sums below zero —
    // i.e. when the regime has negative realized expectancy. Reuses lossStreakCooldownMinutes.
    expectancyBreakerEnabled: booleanFromEnv('EXPECTANCY_BREAKER_ENABLED', true),
    lossStreakWindowSize: numberFromEnv('LOSS_STREAK_WINDOW_SIZE', 4),
    maxPositionsPerLaunchpad: numberFromEnv('MAX_POSITIONS_PER_LAUNCHPAD', 3),
    dynamicSizingEnabled: booleanFromEnv('DYNAMIC_SIZING_ENABLED', false),
    kellyEnabled: booleanFromEnv('KELLY_ENABLED', false),
    maxKellyFraction: numberFromEnv('MAX_KELLY_FRACTION', 0.25),
    kellyMinTrades: numberFromEnv('KELLY_MIN_TRADES', 10),
    mlScoreGateThreshold: numberFromEnv(
      'ML_SCORE_GATE_THRESHOLD',
      preset.mlScoreGateThreshold ?? 0.35
    ),
    mlScoreWeight: numberFromEnv('ML_SCORE_WEIGHT', preset.mlScoreWeight ?? 0.3),
    mlGateMinRealTrades: numberFromEnv('ML_GATE_MIN_REAL_TRADES', preset.mlGateMinRealTrades ?? 3),
    entryTunerEnabled: booleanFromEnv('ENTRY_TUNER_ENABLED', true),
    entryTunerLiveEnabled: booleanFromEnv('ENTRY_TUNER_LIVE_ENABLED', false),
    entryTunerMinSamples: numberFromEnv('ENTRY_TUNER_MIN_SAMPLES', 25),
    adaptiveFloorEnabled: booleanFromEnv('ADAPTIVE_FLOOR_ENABLED', true),
    adaptiveFloorLiveEnabled: booleanFromEnv('ADAPTIVE_FLOOR_LIVE_ENABLED', false),
    minCandidateScoreFloor: numberFromEnv('MIN_CANDIDATE_SCORE_FLOOR', 50),
    tradeStarvationMinutes: numberFromEnv('TRADE_STARVATION_MINUTES', 45),
    starvationRelaxStep: numberFromEnv('STARVATION_RELAX_STEP', 4),
    rugcheckEnabled,
    bubblemapsEnabled,
    burstModeEnabled,
    burstSurvivalSeconds: numberFromEnv(
      'BURST_SURVIVAL_SECONDS',
      preset.burstSurvivalSeconds ?? 1.5
    ),
    burstMinMomentum: numberFromEnv('BURST_MIN_MOMENTUM', preset.burstMinMomentum ?? 1.02),
    burstMaxEntryDrawdownPct: numberFromEnv(
      'BURST_MAX_ENTRY_DRAWDOWN_PCT',
      preset.burstMaxEntryDrawdownPct ?? 8
    ),
    burstMinBuySellRatio: numberFromEnv(
      'BURST_MIN_BUY_SELL_RATIO',
      preset.burstMinBuySellRatio ?? 1.5
    ),
    burstTrailingDrawdownPct: numberFromEnv(
      'BURST_TRAILING_DRAWDOWN_PCT',
      preset.burstTrailingDrawdownPct ?? 0.18
    ),
    burstMaxHoldMinutes: numberFromEnv('BURST_MAX_HOLD_MINUTES', preset.burstMaxHoldMinutes ?? 10),
    burstTakeProfitMultiples: process.env.BURST_TAKE_PROFIT_MULTIPLES
      ? process.env.BURST_TAKE_PROFIT_MULTIPLES.split(',')
          .map((v) => Number(v.trim()))
          .filter((v) => !isNaN(v))
      : preset.burstTakeProfitMultiples,
    burstTakeProfitFractions: process.env.BURST_TAKE_PROFIT_FRACTIONS
      ? process.env.BURST_TAKE_PROFIT_FRACTIONS.split(',')
          .map((v) => Number(v.trim()))
          .filter((v) => !isNaN(v))
      : preset.burstTakeProfitFractions,
    burstMaxSolOutflowPct: numberFromEnv(
      'BURST_MAX_SOL_OUTFLOW_PCT',
      preset.burstMaxSolOutflowPct ?? 0.05
    ),
    enableLocalRouting: booleanFromEnv('ENABLE_LOCAL_ROUTING', true),
    localRoutingComputeUnitLimit: numberFromEnv('LOCAL_ROUTING_COMPUTE_UNIT_LIMIT', 100_000),
    swingBotEnabled: booleanFromEnv('SWING_BOT_ENABLED', false),
    swingJupiterApiKey: process.env.SWING_JUPITER_API_KEY || jupiterApiKey,
    swingJupiterBaseUrl: (
      process.env.SWING_JUPITER_BASE_URL ||
      process.env.JUPITER_BASE_URL ||
      'https://api.jup.ag'
    ).replace(/\/+$/, ''),
    swingMinMarketCapUsd: numberFromEnv('SWING_MIN_MARKET_CAP_USD', 10_000),
    swingMaxMarketCapUsd: numberFromEnv('SWING_MAX_MARKET_CAP_USD', 10_000_000),
    swingBuyAmountSol: process.env.SWING_BUY_AMOUNT_SOL || '0.05',
    swingBuyAmountLamports: BigInt(decimalToAtomic(process.env.SWING_BUY_AMOUNT_SOL || '0.05', 9)),
    swingMaxOpenPositions: numberFromEnv('SWING_MAX_OPEN_POSITIONS', 3),
    swingTrailingStopPct: numberFromEnv('SWING_TRAILING_STOP_PCT', 0.25),
    swingTakeProfitMultiples: (process.env.SWING_TAKE_PROFIT_MULTIPLES || '1.5,3.0,7.0')
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((v) => !isNaN(v) && v > 1),
    swingTakeProfitFractions: (process.env.SWING_TAKE_PROFIT_FRACTIONS || '0.4,0.3,0.2')
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((v) => !isNaN(v) && v > 0),
    swingMaxHoldHours: numberFromEnv('SWING_MAX_HOLD_HOURS', 24),
    swingWatchlistPollIntervalMs: numberFromEnv('SWING_WATCHLIST_POLL_INTERVAL_MS', 30_000),
    swingMinObservationMinutes: numberFromEnv('SWING_MIN_OBSERVATION_MINUTES', 30),
    swingDoubleDipEnabled: booleanFromEnv('SWING_DOUBLE_DIP_ENABLED', true),
    swingVolumeAccumEnabled: booleanFromEnv('SWING_VOLUME_ACCUM_ENABLED', true),
    swingMinScore: numberFromEnv('SWING_MIN_SCORE', 60),
    swingAllowDoubleDipOnly: booleanFromEnv('SWING_ALLOW_DOUBLE_DIP_ONLY', false),
    swingMinScoreNoVolume: numberFromEnv('SWING_MIN_SCORE_NO_VOLUME', 55),
  };
}

/**
 * Validates the startup configuration for correctness and safety.
 * @param config - The configuration object to validate.
 * @returns True if the configuration is valid.
 * @throws {Error} If validation errors are found.
 */
export function validateStartupConfig(config: Config): boolean {
  if (!config || typeof config !== 'object') {
    throw new Error('Startup configuration error: config object is required.');
  }

  const errors: string[] = [];
  const positiveFields: Array<keyof Config> = [
    'scanIntervalMs',
    'discoveryPollIntervalMs',
    'discoveryWsDebounceMs',
    'websocketWatchdogIntervalMs',
    'websocketStaleThresholdMs',
    'websocketHandshakeTimeoutMs',
    'buyAmountLamports',
    'minLiquidityUsd',
    'maxOpenPositions',
    'maxBuysPerScan',
    'maxCandidatesPerScan',
    'maxConcurrentAudits',
    'scanParallelismLight',
    'scanParallelismHeavy',
    'ownerAuditParallelism',
    'priceFallbackParallelism',
    'errorRateWindow',
    'mintSignalMaxAttempts',
    'mintSignalRetryDelayMs',
    'rpcIndexingRetryDelayMs',
    'maxRecheckAttempts',
    'borderlineRecheckMaxAttempts',
    'maxAutoSlippageRetry',
    'autoSlippageIncrementBps',
    'stateFlushIntervalMs',
    'rugExitMicroCapThresholdUsd',
    'rugExitMicroCapMultiplier',
    'rugExitHighCapThresholdUsd',
    'rugExitHighCapMultiplier',
    'rugExitMaxSpreadPct',
    'rugExitSpreadExpansionMultiplier',
    'rugExitSellDominanceMultiplier',
  ];
  for (const field of positiveFields) {
    const value = Number(config[field]);
    if (!Number.isFinite(value) || value <= 0) {
      errors.push(`${String(field)} must be a positive number.`);
    }
  }

  if (config.rugExitWindowSec >= config.earlyPerformanceGuardSeconds) {
    errors.push(
      `rugExitWindowSec (${config.rugExitWindowSec}) must be less than earlyPerformanceGuardSeconds (${config.earlyPerformanceGuardSeconds}); otherwise EPG can never fire.`
    );
  }

  if (!Number.isFinite(config.slippageBps) || config.slippageBps < 1 || config.slippageBps > 5000) {
    errors.push('slippageBps must be between 1 and 5000.');
  }
  if (!Number.isFinite(config.stopLossPct) || config.stopLossPct <= 0 || config.stopLossPct >= 1) {
    errors.push('stopLossPct must be > 0 and < 1.');
  }
  if (
    !Number.isFinite(config.takeProfitFraction) ||
    config.takeProfitFraction <= 0 ||
    config.takeProfitFraction > 1
  ) {
    errors.push('takeProfitFraction must be > 0 and <= 1.');
  }
  if (
    !Number.isFinite(config.parallelismMinFactor) ||
    config.parallelismMinFactor <= 0 ||
    config.parallelismMinFactor > 1
  ) {
    errors.push('parallelismMinFactor must be > 0 and <= 1.');
  }
  if (
    !Number.isFinite(config.backpressureErrorRateThreshold) ||
    config.backpressureErrorRateThreshold <= 0 ||
    config.backpressureErrorRateThreshold > 1
  ) {
    errors.push('backpressureErrorRateThreshold must be > 0 and <= 1.');
  }
  if (
    !Number.isFinite(config.trailingStopDrawdownPct) ||
    config.trailingStopDrawdownPct <= 0 ||
    config.trailingStopDrawdownPct >= 1
  ) {
    errors.push('trailingStopDrawdownPct must be > 0 and < 1.');
  }
  if (
    !Array.isArray(config.takeProfitMultiples) ||
    config.takeProfitMultiples.length === 0 ||
    config.takeProfitMultiples.some((v) => !Number.isFinite(v) || v <= 1)
  ) {
    errors.push('takeProfitMultiples must contain one or more values greater than 1.');
  }
  if (
    !Number.isFinite(config.priorityFeeBaseMicroLamports) ||
    !Number.isFinite(config.priorityFeeMaxMicroLamports) ||
    config.priorityFeeBaseMicroLamports <= 0 ||
    config.priorityFeeMaxMicroLamports < config.priorityFeeBaseMicroLamports
  ) {
    errors.push('Priority fee range is invalid.');
  }
  if (
    !Number.isFinite(config.priorityFeePercentile) ||
    config.priorityFeePercentile < 1 ||
    config.priorityFeePercentile > 100
  ) {
    errors.push('priorityFeePercentile must be between 1 and 100.');
  }
  if (config.websocketStaleThresholdMs < config.websocketWatchdogIntervalMs) {
    errors.push(
      'websocketStaleThresholdMs must be greater than or equal to websocketWatchdogIntervalMs.'
    );
  }
  if (!config.rpcUrl || !config.jupiterBaseUrl || !config.jupiterApiKey) {
    errors.push('rpcUrl, jupiterBaseUrl, and jupiterApiKey are required.');
  }
  if (!config.paperTrading && !config.dryRun && !config.liveTradingEnabled) {
    errors.push(
      'LIVE_TRADING_ENABLED=true is required when PAPER_TRADING=false and DRY_RUN=false.'
    );
  }

  if (config.useJito) {
    if (!config.jitoBlockEngineUrl) {
      errors.push('jitoBlockEngineUrl is required when USE_JITO=true.');
    }
    if (config.jitoTipLamports <= 0n) {
      errors.push('jitoTipLamports must be greater than 0 when USE_JITO=true.');
    }
  }

  if (errors.length > 0) {
    throw new Error(`Startup configuration error:\n- ${errors.join('\n- ')}`);
  }
  return true;
}
