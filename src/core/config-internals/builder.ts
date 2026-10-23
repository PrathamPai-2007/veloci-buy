import path from 'node:path';
import fs from 'node:fs';
import { Config, PresetStrategy } from '#types/index.js';
import { TUNING_KEYS, type TuningKey } from '../tuning-keys.js';
import { NumberParser, numberParser, loadDotEnv } from './env-loaders.js';
import { loadStrategy, DEFAULT_STRATEGY, pickStrategyFields } from '../strategy-loader.js';
import { safeConsole } from '../utils/io.js';
import { validateStartupConfig } from './validators.js';
import { deriveWsRpcUrl, decimalToAtomic } from '../utils.js';

/**
 * Legacy env keys whose values now live in the strategy YAML. Kept only to warn on startup so an
 * old .env never changes behaviour silently.
 * ponytail: migration aid; delete once no legacy .env files remain.
 */
const MOVED_TO_STRATEGY_ENV_KEYS = [
  'ALLOW_VERIFIED_TOKENS',
  'AUTO_SLIPPAGE_INCREMENT_BPS',
  'BACKGROUND_ATA_CLOSE',
  'BACKPRESSURE_ERROR_RATE_THRESHOLD',
  'BORDERLINE_RECHECK_ENABLED',
  'BORDERLINE_RECHECK_MAX_ATTEMPTS',
  'BORDERLINE_RECHECK_MAX_DELAY_MS',
  'BORDERLINE_RECHECK_MIN_DELAY_MS',
  'BORDERLINE_THRESHOLD_BUFFER_PCT',
  'BREAKEVEN_RATCHET_BUFFER_PCT',
  'BREAKEVEN_RATCHET_ENABLED',
  'BREAK_EVEN_STOP_ENABLED',
  'BREAK_EVEN_STOP_FLOOR_PCT',
  'BREAK_EVEN_STOP_TRIGGER_MULTIPLE',
  'BUYING_THE_TOP_SL_PCT',
  'BUY_TOP_ATH_BUFFER_PCT',
  'CIRCUIT_BREAKER_ENABLED',
  'COOL_DOWN_MINUTES',
  'DISCOVERY_METEORA_ENABLED',
  'DISCOVERY_POLL_INTERVAL_MS',
  'DISCOVERY_PUMP_ENABLED',
  'DISCOVERY_RAYDIUM_ENABLED',
  'DISCOVERY_WS_DEBOUNCE_MS',
  'DISCOVERY_WS_ENABLED',
  'DRAWDOWN_COOLDOWN_MINUTES',
  'DYNAMIC_JITO_TIP_ENABLED',
  'DYNAMIC_SIZING_ENABLED',
  'EARLY_PERFORMANCE_DROP_PCT',
  'EARLY_PERFORMANCE_GUARD_SECONDS',
  'EARLY_PERFORMANCE_SELL_PCT',
  'EARLY_STOP_LOSS_PCT',
  'EARLY_STOP_LOSS_WINDOW_SEC',
  'ENABLE_LOCAL_ROUTING',
  'ERROR_RATE_WINDOW',
  'EXPECTANCY_BREAKER_ENABLED',
  'FINAL_AUDIT_SECONDS',
  'HIGH_GROWTH_CONFIDENCE_SCORE',
  'HOLDER_COUNT_WAITLIST_SECONDS',
  'HOLD_DURATION_HIGH_CONFIDENCE_MINUTES',
  'HOLD_DURATION_LOW_CONFIDENCE_MINUTES',
  'INLINE_SWAP_SIMULATION',
  'INSIDER_DRIFT_CONCENTRATION_TOP5',
  'JITO_BUNDLE_RETRY_ATTEMPTS',
  'JITO_CONFIRM_TIMEOUT_MS',
  'JITO_TIP_MAX_FRACTION_OF_EV',
  'JITO_TIP_PERCENTILE',
  'KELLY_ENABLED',
  'KELLY_MIN_TRADES',
  'LIQUIDITY_COLLAPSE_THRESHOLD_RATIO',
  'LIQUIDITY_COLLAPSE_THRESHOLD_USD',
  'LOCAL_ROUTING_COMPUTE_UNIT_LIMIT',
  'LOSS_STREAK_BREAKER_ENABLED',
  'LOSS_STREAK_COOLDOWN_MINUTES',
  'LOSS_STREAK_THRESHOLD',
  'LOSS_STREAK_WINDOW_SIZE',
  'MAX_AUDIT_TOP_HOLDERS_PCT',
  'MAX_AUTO_SLIPPAGE_RETRY',
  'MAX_BUBBLEMAPS_LARGEST_CLUSTER_SHARE',
  'MAX_BUYS_PER_SCAN',
  'MAX_BUY_LIQUIDITY_FRACTION',
  'MAX_BUY_TOP_GROWTH_PCT',
  'MAX_CANDIDATES_PER_SCAN',
  'MAX_CANDIDATE_AGE_MINUTES',
  'MAX_CONCURRENT_AUDITS',
  'MAX_DAILY_DRAWDOWN_PCT',
  'MAX_EXHAUSTION_RANGE_PCT',
  'MAX_FDV_TO_LIQUIDITY',
  'MAX_HOLD_MINUTES',
  'MAX_KELLY_FRACTION',
  'MAX_LIQUIDITY_DRAWDOWN_PCT',
  'MAX_MEME_FDV_USD',
  'MAX_OPEN_POSITIONS',
  'MAX_POSITIONS_PER_LAUNCHPAD',
  'MAX_PRICE_DUMP_PCT',
  'MAX_RECHECK_ATTEMPTS',
  'MAX_SELL_PRESSURE_INCREASE_PCT',
  'MAX_SURVIVAL_GROWTH_PCT',
  'MAX_TOKEN_ACCOUNT_TOP1_PCT',
  'MAX_TOKEN_ACCOUNT_TOP3_PCT',
  'MAX_TOKEN_ACCOUNT_TOP5_PCT',
  'MEME_KEYWORDS',
  'MID_STOP_LOSS_PCT',
  'MID_STOP_LOSS_WINDOW_SEC',
  'MINT_SIGNAL_MAX_ATTEMPTS',
  'MINT_SIGNAL_RETRY_DELAY_MS',
  'MIN_ACCELERATION_FACTOR',
  'MIN_BREAKOUT_MULTIPLIER',
  'MIN_BUBBLEMAPS_SCORE',
  'MIN_BUYS_5M',
  'MIN_CANDIDATE_SCORE',
  'MIN_CANDIDATE_SCORE_FLOOR',
  'MIN_HOLDER_COUNT',
  'MIN_HOLD_TIME_SECONDS',
  'MIN_LIQUIDITY_USD',
  'MIN_MARKET_CAP_USD',
  'MIN_MOMENTUM_CONSISTENCY',
  'MIN_ORGANIC_SCORE',
  'MIN_POOL_AGE_SECONDS',
  'MIN_SOCIAL_LINKS',
  'MIN_SURVIVAL_MOMENTUM',
  'MOMENTUM_SCORING_ENABLED',
  'MOOD_PAUSE_DURATION_MINUTES',
  'MOON_BAG_FRACTION',
  'MOON_BAG_TRAILING_DRAWDOWN_PCT',
  'OWNER_AUDIT_PARALLELISM',
  'PARALLELISM_MIN_FACTOR',
  'PERFORMANCE_CHECK_SECONDS',
  'PERFORMANCE_MIN_MOMENTUM',
  'PRICE_FALLBACK_PARALLELISM',
  'PRIORITY_FEE_ACCOUNT_LOCAL',
  'PRIORITY_FEE_BASE_MICRO_LAMPORTS',
  'PRIORITY_FEE_MAX_MICRO_LAMPORTS',
  'PRIORITY_FEE_PANIC_MULTIPLIER',
  'PRIORITY_FEE_PERCENTILE',
  'PRIORITY_FEE_VOLATILITY_MULTIPLIER',
  'RECHECK_PRICE_DROP_PCT',
  'REENTRY_BREAKOUT_PCT',
  'REENTRY_DIP_PCT',
  'RPC_INDEXING_RETRY_DELAY_MS',
  'RUG_EXIT_DROP_PCT',
  'RUG_EXIT_DYNAMIC_SCALING_ENABLED',
  'RUG_EXIT_GUARD_ENABLED',
  'RUG_EXIT_HIGH_CAP_MULTIPLIER',
  'RUG_EXIT_HIGH_CAP_THRESHOLD_USD',
  'RUG_EXIT_MAX_SPREAD_PCT',
  'RUG_EXIT_MICRO_CAP_MULTIPLIER',
  'RUG_EXIT_MICRO_CAP_THRESHOLD_USD',
  'RUG_EXIT_SELL_DOMINANCE_MULTIPLIER',
  'RUG_EXIT_SPREAD_EXPANSION_MULTIPLIER',
  'RUG_EXIT_SPREAD_GUARD_ENABLED',
  'RUG_EXIT_VOLATILITY_SCALING_ENABLED',
  'RUG_EXIT_VOLUME_GUARD_ENABLED',
  'RUG_EXIT_WINDOW_SEC',
  'SCAN_INTERVAL_MS',
  'SCAN_PARALLELISM_HEAVY',
  'SCAN_PARALLELISM_LIGHT',
  'SLIPPAGE_BPS',
  'SL_BREAKEVEN_BUFFER_PCT',
  'SL_BREAKEVEN_ENABLED',
  'SL_BREAKEVEN_THRESHOLD_PCT',
  'STANDARD_GROWTH_CONFIDENCE_SCORE',
  'STARVATION_RELAX_STEP',
  'STATE_FLUSH_INTERVAL_MS',
  'STOP_LOSS_PCT',
  'SURVIVAL_DELAY_SECONDS',
  'SURVIVAL_DELAY_THRESHOLD_HIGH',
  'SURVIVAL_DELAY_THRESHOLD_VERY_HIGH',
  'TAKE_PROFIT_FRACTION',
  'TAKE_PROFIT_FRACTIONS',
  'TAKE_PROFIT_MULTIPLES',
  'TAKE_PROFIT_MULTIPLES_HIGH',
  'TIME_EXIT_MIN_MULTIPLE',
  'TRADE_STARVATION_MINUTES',
  'TRAILING_STOP_DRAWDOWN_PCT',
  'TRENDING_DISCOVERY_ENABLED',
  'TRENDING_INTERVAL',
  'TRENDING_MAX_BUY_TOP_GROWTH_PCT',
  'TRENDING_MAX_PRICE_DUMP_PCT',
  'TRENDING_MAX_SURVIVAL_GROWTH_PCT',
  'TRENDING_MAX_TOKEN_ACCOUNT_TOP1_PCT',
  'TRENDING_MAX_TOKEN_ACCOUNT_TOP5_PCT',
  'TRENDING_MIN_BUBBLEMAPS_SCORE',
  'TRENDING_POLL_INTERVAL_MS',
  'WEBSOCKET_HANDSHAKE_TIMEOUT_MS',
  'WEBSOCKET_STALE_THRESHOLD_MS',
  'WEBSOCKET_WATCHDOG_INTERVAL_MS',
];

/** Legacy env keys for removed features (burst mode, swing bot, dashboard API). */
const REMOVED_ENV_KEYS = [
  'ALLOW_BURST_ON_FREE',
  'API_HOST',
  'API_PORT',
  'API_TOKEN',
  'BURST_MAX_ENTRY_DRAWDOWN_PCT',
  'BURST_MAX_HOLD_MINUTES',
  'BURST_MAX_SOL_OUTFLOW_PCT',
  'BURST_MIN_BUY_SELL_RATIO',
  'BURST_MIN_MOMENTUM',
  'BURST_MODE_ENABLED',
  'BURST_SURVIVAL_SECONDS',
  'BURST_TAKE_PROFIT_FRACTIONS',
  'BURST_TAKE_PROFIT_MULTIPLES',
  'BURST_TRAILING_DRAWDOWN_PCT',
  'SWING_ALLOW_DOUBLE_DIP_ONLY',
  'SWING_BOT_ENABLED',
  'SWING_BUY_AMOUNT_SOL',
  'SWING_DOUBLE_DIP_ENABLED',
  'SWING_JUPITER_API_KEY',
  'SWING_JUPITER_BASE_URL',
  'SWING_MAX_HOLD_HOURS',
  'SWING_MAX_MARKET_CAP_USD',
  'SWING_MAX_OPEN_POSITIONS',
  'SWING_MIN_MARKET_CAP_USD',
  'SWING_MIN_OBSERVATION_MINUTES',
  'SWING_MIN_SCORE',
  'SWING_MIN_SCORE_NO_VOLUME',
  'SWING_TAKE_PROFIT_FRACTIONS',
  'SWING_TAKE_PROFIT_MULTIPLES',
  'SWING_TRAILING_STOP_PCT',
  'SWING_VOLUME_ACCUM_ENABLED',
  'SWING_WATCHLIST_POLL_INTERVAL_MS',
];

function warnAboutLegacyEnv(env: NodeJS.ProcessEnv, strategyName: string): void {
  for (const key of MOVED_TO_STRATEGY_ENV_KEYS) {
    if (env[key] !== undefined) {
      safeConsole(
        'error',
        `[CONFIG] ${key} is no longer read from .env: set it in strategies/${strategyName}.yaml instead.`
      );
    }
  }
  for (const key of REMOVED_ENV_KEYS) {
    if (env[key] !== undefined) {
      safeConsole('error', `[CONFIG] ${key} is ignored: that feature has been removed.`);
    }
  }
}

export class ConfigBuilder {
  private readonly parser: NumberParser;
  private readonly env: NodeJS.ProcessEnv;
  private strategy: PresetStrategy;
  private strategyLabel = 'standard';
  private overrides: Partial<Config>;

  constructor(env?: NodeJS.ProcessEnv, parser?: NumberParser) {
    this.env = env ?? process.env;
    this.parser = parser ?? (env ? new NumberParser(env) : numberParser);
    this.strategy = DEFAULT_STRATEGY;
    this.overrides = {};
  }

  static withDotEnv(): ConfigBuilder {
    loadDotEnv();
    return new ConfigBuilder();
  }

  fromEnv(env: NodeJS.ProcessEnv = process.env): ConfigBuilder {
    const parser = new NumberParser(env);
    return new ConfigBuilder(env, parser);
  }

  withStrategy(name: string): ConfigBuilder {
    this.strategy = loadStrategy(name);
    this.strategyLabel = name;
    return this;
  }

  withPreset(preset: PresetStrategy): ConfigBuilder {
    // Partial presets (tests, tools) are completed from standard.yaml.
    this.strategy = { ...DEFAULT_STRATEGY, ...preset };
    return this;
  }

  withOverrides(overrides: Partial<Config>): ConfigBuilder {
    this.overrides = overrides;
    return this;
  }

  build(): Config {
    return {
      ...this.buildConfig(),
      ...this.overrides,
    };
  }

  validate(): Config {
    const config = this.build();
    validateStartupConfig(config);
    return config;
  }

  private buildConfig(): Config {
    const p = this.parser;
    const env = this.env;

    // STRATEGY selects strategies/<name>.yaml (merged over standard.yaml); it is the only
    // source of tuning values. .env carries infrastructure, secrets and mode only.
    const strategyName = (env.STRATEGY || this.strategyLabel).toLowerCase();
    const resolvedStrategy =
      env.STRATEGY && strategyName !== this.strategyLabel
        ? loadStrategy(strategyName)
        : this.strategy;
    warnAboutLegacyEnv(env, strategyName);

    const rpcUrlRaw = p.require('RPC_URL');
    const rpcUrls = rpcUrlRaw
      .split(',')
      .map((u: string) => u.trim())
      .filter(Boolean);

    const wsRpcUrlRaw = env.WS_RPC_URL;
    const wsRpcUrls = wsRpcUrlRaw
      ? wsRpcUrlRaw
          .split(',')
          .map((u: string) => u.trim())
          .filter(Boolean)
      : rpcUrls.map((u: string) => deriveWsRpcUrl(u));

    // --- RPC tier & per-endpoint rate limits ---
    // Research (2026): public api.mainnet-beta = 100 req/10s per IP (≈10 RPS, 40 per 10s per method),
    // Helius Free = 10 RPS (getProgramAccounts 5/s, sendTransaction 1/s),
    // Helius Developer ($49/mo) = 50 RPS (getProgramAccounts 25/s, sendTransaction 5/s).
    // Auto heuristic: hostname containing 'api.mainnet-beta' or 'public' → free (5 RPS conservative),
    // helius/quicknode/alchemy/etc → premium (10 RPS free baseline, override via RPC_RATE_LIMITS for $10+/paid).
    const rpcTierRaw = env.RPC_TIER?.trim();
    const rpcRateLimitsRaw = env.RPC_RATE_LIMITS?.trim();
    const rawTierTokens = rpcTierRaw
      ? rpcTierRaw
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      : null;
    // Strict validation: invalid token or wrong length fails fast instead of silent fallback
    if (rawTierTokens) {
      for (const t of rawTierTokens) {
        if (t !== 'premium' && t !== 'free') {
          throw new Error(
            `Startup configuration error: RPC_TIER entry "${t}" must be premium or free. Got "${rpcTierRaw}". Example: RPC_TIER=premium,free`
          );
        }
      }
      if (rawTierTokens.length !== 1 && rawTierTokens.length !== rpcUrls.length) {
        throw new Error(
          `Startup configuration error: RPC_TIER has ${rawTierTokens.length} entries but RPC_URL has ${rpcUrls.length}. Use 1 value (broadcast) or ${rpcUrls.length} values (per-endpoint).`
        );
      }
    }
    const rpcTierOverride = rawTierTokens;
    const isPremiumHost = (url: string): boolean => {
      const lower = url.toLowerCase();
      if (lower.includes('api.mainnet-beta.solana.com') || lower.includes('public')) return false;
      if (
        lower.includes('helius') ||
        lower.includes('quicknode') ||
        lower.includes('quiknode') ||
        lower.includes('alchemy') ||
        lower.includes('chainstack') ||
        lower.includes('triton') ||
        lower.includes('ankr') ||
        lower.includes('drpc') ||
        lower.includes('getblock') ||
        lower.includes('swiftnodes')
      )
        return true;
      return false;
    };
    const rpcTiers: ('premium' | 'free')[] = rpcUrls.map((url, i) => {
      if (rpcTierOverride) {
        const v = rpcTierOverride.length === 1 ? rpcTierOverride[0] : rpcTierOverride[i];
        if (v === 'premium' || v === 'free') return v as 'premium' | 'free';
        // validated above, unreachable
        throw new Error(`Invalid RPC_TIER entry at index ${i}`);
      }
      return isPremiumHost(url) ? 'premium' : 'free';
    });
    const isPremiumRpc = rpcTiers.includes('premium');
    const parseRateList = (raw: string | undefined, name: string): number[] => {
      if (!raw) return [];
      const tokens = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (tokens.length === 0) return [];
      const nums = tokens.map((t) => Number(t));
      for (let i = 0; i < nums.length; i++) {
        const n = nums[i]!;
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(
            `Startup configuration error: ${name} entry "${tokens[i]}" must be a positive number. Got "${raw}". Example: ${name}=50,5`
          );
        }
      }
      if (nums.length !== 1 && nums.length !== rpcUrls.length) {
        throw new Error(
          `Startup configuration error: ${name} has ${nums.length} entries but RPC_URL has ${rpcUrls.length}. Use 1 value (broadcast) or ${rpcUrls.length} values.`
        );
      }
      return nums;
    };
    const parsedRateLimits = parseRateList(rpcRateLimitsRaw, 'RPC_RATE_LIMITS');
    // Defaults from research: free public ~5 RPS conservative (40/10s per method), helius free ~10 RPS,
    // $10/paid path override via RPC_RATE_LIMITS (e.g. 50 for Helius Developer + 5 for public).
    const rpcRateLimits: number[] = rpcUrls.map((_url, i) => {
      if (parsedRateLimits.length === 1) return parsedRateLimits[0]!;
      if (parsedRateLimits[i] != null) return parsedRateLimits[i]!;
      return rpcTiers[i] === 'premium' ? 10 : 5;
    });
    const rpcSendTxRaw = env.RPC_SEND_TX_RATE_LIMITS?.trim();
    const parsedSendTx = parseRateList(rpcSendTxRaw, 'RPC_SEND_TX_RATE_LIMITS');
    // Helius Free 1/s, Developer 5/s, public 1/s conservative. If RPC_SEND_TX_RATE_LIMITS not set,
    // auto-upgrade to 5/s when premium rate >=50 (Helius Developer heuristic).
    const rpcSendTxRateLimits: number[] = rpcUrls.map((_, i) => {
      if (parsedSendTx.length === 1) return parsedSendTx[0]!;
      if (parsedSendTx[i] != null) return parsedSendTx[i]!;
      return rpcTiers[i] === 'premium' && rpcRateLimits[i]! >= 50 ? 5 : 1;
    });

    const jupiterApiKey = p.require('JUPITER_API_KEY');
    const jupiterPositionApiKey = env.JUPITER_POSITION_API_KEY || jupiterApiKey;
    const privateKey = env.PRIVATE_KEY || '';
    const privateKeyPath = env.PRIVATE_KEY_PATH || '';
    const keystorePath = env.KEYSTORE_PATH || '';
    const keystorePassword = env.KEYSTORE_PASSWORD || '';

    if (!privateKey && !privateKeyPath && !keystorePath) {
      throw new Error(
        'Startup configuration error: PRIVATE_KEY, PRIVATE_KEY_PATH, or KEYSTORE_PATH is required.'
      );
    }

    const buyAmountText = env.BUY_AMOUNT_SOL || '0.05';
    if (!/^\d+(\.\d+)?$/.test(String(buyAmountText).trim())) {
      throw new Error(
        `Startup configuration error: BUY_AMOUNT_SOL must be a positive decimal, got "${buyAmountText}".`
      );
    }

    // Free-tier RPC (5 RPS public caps): slow the loops and cap concurrency so the strategy's
    // values can't 429 the node. A mixed premium+free pool still protects the free endpoint.
    const hasFreeTier = rpcTiers.includes('free');
    // ML knobs are resolved separately below (env ML_* overrides the strategy).
    const tuning = pickStrategyFields(resolvedStrategy, TUNING_KEYS) as Pick<Config, TuningKey>;
    if (hasFreeTier) {
      tuning.scanIntervalMs = Math.max(tuning.scanIntervalMs, 8000);
      tuning.discoveryPollIntervalMs = Math.max(tuning.discoveryPollIntervalMs, 30000);
      tuning.maxConcurrentAudits = Math.min(tuning.maxConcurrentAudits, 3);
      tuning.scanParallelismLight = Math.min(tuning.scanParallelismLight, 3);
      tuning.scanParallelismHeavy = Math.min(tuning.scanParallelismHeavy, 1);
      tuning.ownerAuditParallelism = 1;
      tuning.priceFallbackParallelism = 1;
      tuning.mintSignalMaxAttempts = 1;
    }

    const paperTrading = p.boolean('PAPER_TRADING', false);
    const sessionType = paperTrading ? 'paper-trading' : 'live-trading';
    const timestamp = new Date().toISOString().replace('T', '_').replace(/[:.]/g, '-').slice(0, 19);
    const sessionDir = path.join('logs', sessionType, timestamp);

    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    // Per-session bot.db: every run gets its own bot.db inside sessionDir.
    // STATE_FILE env var is only an explicit override (escape hatch).
    let stateFile: string;
    let dbFile: string;
    if (env.STATE_FILE) {
      const raw = env.STATE_FILE;
      const absRaw = path.isAbsolute(raw) ? raw : path.join('data', path.basename(raw));
      if (absRaw.endsWith('.db')) {
        dbFile = absRaw;
        stateFile = absRaw.replace(/\.db$/, '.json');
      } else {
        stateFile = absRaw;
        dbFile = absRaw.replace(/\.json$/, '.db');
        if (dbFile === stateFile) dbFile = path.join(path.dirname(stateFile), 'bot.db');
      }
    } else {
      stateFile = path.join(sessionDir, 'bot-state.json');
      dbFile = path.join(sessionDir, 'bot.db');
    }

    for (const f of [stateFile, dbFile]) {
      const dir = path.dirname(f);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    const mlReservoirFile = env.ML_RESERVOIR_FILE
      ? path.isAbsolute(env.ML_RESERVOIR_FILE)
        ? env.ML_RESERVOIR_FILE
        : path.join('data', path.basename(env.ML_RESERVOIR_FILE))
      : path.join('data', 'ml-reservoir.db');
    // Ensure data dir exists for reservoir file
    try {
      const rDir = path.dirname(mlReservoirFile);
      if (!fs.existsSync(rDir)) fs.mkdirSync(rDir, { recursive: true });
    } catch {}

    const logFile = env.LOG_FILE || './bot.log';
    const scannedTokensFile = env.SCANNED_TOKENS_FILE || './scanned-memecoins.jsonl';

    return {
      strategyName,
      rpcUrls,
      wsRpcUrls,
      rpcUrl: rpcUrls[0] || '',
      wsRpcUrl: wsRpcUrls[0] || '',
      rpcTiers,
      rpcRateLimits,
      rpcSendTxRateLimits,
      isPremiumRpc,
      jupiterApiKey,
      jupiterPositionApiKey,
      // Upstream budgets (requests/sec). Jupiter Free = 1 RPS per organisation; Jito default =
      // 1 RPS per IP per region; BubbleMaps is undocumented, so stay conservative.
      jupiterRps: p.float('JUPITER_RPS', 1),
      jitoRps: p.float('JITO_RPS', 1),
      rugcheckRps: p.float('RUGCHECK_RPS', 1),
      bubbleMapsRpm: p.float('BUBBLEMAPS_RPM', 6),
      jupiterBaseUrl: (env.JUPITER_BASE_URL || 'https://api.jup.ag').replace(/\/+$/, ''),
      rugcheckBaseUrl: (env.RUGCHECK_BASE_URL || 'https://api.rugcheck.xyz/v1').replace(/\/+$/, ''),
      rugcheckApiKey: env.RUGCHECK_API_KEY || '',
      bubbleMapsBaseUrl: (env.BUBBLEMAPS_BASE_URL || 'https://api.bubblemaps.io').replace(
        /\/+$/,
        ''
      ),
      buyAmountSolText: buyAmountText,
      buyAmountLamports: BigInt(decimalToAtomic(buyAmountText, 9)),
      dryRun: p.boolean('DRY_RUN', true),
      paperTrading,
      liveTradingEnabled: p.boolean('LIVE_TRADING_ENABLED', false),
      initialPaperSolText: env.INITIAL_PAPER_SOL || '0.1',
      initialPaperSolLamports: BigInt(decimalToAtomic(env.INITIAL_PAPER_SOL || '0.1', 9)),
      sessionDir,
      stateFile,
      dbFile,
      mlReservoirFile,
      logFile: path.join(sessionDir, path.basename(logFile)),
      scannedTokensFile: path.join(sessionDir, path.basename(scannedTokensFile)),
      paperTradeJournalFile: path.join(sessionDir, 'paper-trade-journal.jsonl'),
      tradeJournalFile: path.join(sessionDir, 'trade-journal.jsonl'),
      ghostTradeJournalFile: path.join(sessionDir, 'ghost-trade-journal.jsonl'),
      performanceStatsFile: path.join(sessionDir, 'performance-stats.json'),
      metricsFile: path.join(sessionDir, 'metrics.json'),
      bubbleMapsApiKey: env.BUBBLEMAPS_API_KEY || '',
      heliusApiKey: env.HELIUS_API_KEY || '',
      useJito: p.boolean('USE_JITO', false),
      jitoTipLamports: BigInt(decimalToAtomic(env.JITO_TIP_SOL || '0.001', 9)),
      jitoBlockEngineUrl:
        env.JITO_BLOCK_ENGINE_URL || 'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
      jitoTipFloorApiUrl: env.JITO_TIP_FLOOR_API_URL || '',
      useJupiterSdk: p.boolean('USE_JUPITER_SDK', true),
      closePositionsOnShutdown: p.boolean('CLOSE_POSITIONS_ON_SHUTDOWN', true),
      privateKey,
      privateKeyPath,
      keystorePath,
      keystorePassword,
      geyserEnabled: p.boolean('GEYSER_ENABLED', true),
      geyserTcpAddr: env.GEYSER_TCP_ADDR || '',
      geyserSocketPath: env.GEYSER_SOCKET_PATH || '',
      pumpFeeRecipient: env.PUMP_FEE_RECIPIENT || '',
      telegramBotToken: env.TELEGRAM_BOT_TOKEN || '',
      telegramChatId: env.TELEGRAM_CHAT_ID || '',
      discordWebhookUrl: env.DISCORD_WEBHOOK_URL || '',
      mlScoreGateThreshold: p.float(
        'ML_SCORE_GATE_THRESHOLD',
        resolvedStrategy.mlScoreGateThreshold ?? 0.35
      ),
      mlScoreWeight: p.float('ML_SCORE_WEIGHT', resolvedStrategy.mlScoreWeight ?? 0.3),
      mlGateMinRealTrades: p.int(
        'ML_GATE_MIN_REAL_TRADES',
        resolvedStrategy.mlGateMinRealTrades ?? 3
      ),
      entryTunerEnabled: p.boolean('ENTRY_TUNER_ENABLED', true),
      entryTunerLiveEnabled: p.boolean('ENTRY_TUNER_LIVE_ENABLED', false),
      entryTunerMinSamples: p.int('ENTRY_TUNER_MIN_SAMPLES', 25),
      entryTunerPersist: p.boolean('ENTRY_TUNER_PERSIST', false),
      adaptiveFloorEnabled: p.boolean('ADAPTIVE_FLOOR_ENABLED', true),
      adaptiveFloorLiveEnabled: p.boolean('ADAPTIVE_FLOOR_LIVE_ENABLED', false),
      rugcheckEnabled: p.boolean('RUGCHECK_ENABLED', false),
      bubblemapsEnabled: p.boolean('BUBBLEMAPS_ENABLED', false),
      ...tuning,
    };
  }
}

export function loadConfig(): Config {
  return ConfigBuilder.withDotEnv().withStrategy('standard').build();
}

export { validateStartupConfig };
