import path from 'node:path';
import { Config } from '../../src/types/index.js';

export class TestConfigBuilder {
  private config: Config;

  constructor() {
    const rpcUrl = 'http://localhost:8899';
    this.config = {
      strategyName: 'test',
      logFile: path.join(process.cwd(), '.test-artifacts', 'bot.log'),
      stateFile: '',
      dbFile: '',
      mlReservoirFile: '',
      metricsFile: '',
      mintsFile: '',
      scannedTokensFile: '',
      paperTradeJournalFile: '',
      tradeJournalFile: '',
      ghostTradeJournalFile: '',
      performanceStatsFile: '',
      sessionDir: '',
      stateFlushIntervalMs: 250,
      jupiterBaseUrl: 'http://mock',
      jupiterApiKey: 'test-key',
      jupiterPositionApiKey: 'position-key',
      // Effectively unthrottled in tests; rate-limit.test.ts exercises the real buckets.
      jupiterRps: 1000,
      geyserEnabled: false,
      geyserTcpAddr: '',
      geyserSocketPath: '',
      pumpFeeRecipient: '',
      jitoRps: 1000,
      rugcheckRps: 1000,
      bubbleMapsRpm: 60_000,
      rugcheckBaseUrl: 'http://mock-rugcheck',
      rugcheckApiKey: 'test-rugcheck-key',
      bubbleMapsBaseUrl: 'http://mock-bubblemaps',
      bubbleMapsApiKey: '',
      minBubbleMapsScore: 0,
      maxBubbleMapsLargestClusterShare: 100,
      minMarketCapUsd: 0,
      trendingDiscoveryEnabled: true,
      trendingPollIntervalMs: 20_000,
      trendingInterval: '5m',
      trendingMaxSurvivalGrowthPct: 900,
      trendingMaxBuyTopGrowthPct: 250,
      trendingMaxPriceDumpPct: 30,
      trendingMaxTokenAccountTop1Pct: 80,
      trendingMaxTokenAccountTop5Pct: 80,
      trendingMinBubbleMapsScore: 40,
      rpcUrl,
      rpcUrls: [rpcUrl],
      wsRpcUrl: 'ws://localhost:8900',
      wsRpcUrls: ['ws://localhost:8900'],
      buyAmountLamports: 50_000_000n,
      buyAmountSolText: '0.05',
      initialPaperSolText: '0.1',
      initialPaperSolLamports: 100_000_000n,
      paperTrading: true,
      dryRun: false,
      liveTradingEnabled: false,
      closePositionsOnShutdown: true,
      slippageBps: 500,
      takeProfitMultiples: [1.15, 1.75],
      takeProfitMultiplesHigh: [1.24, 2.0],
      takeProfitFractions: [0.75, 0.6],
      takeProfitFraction: 0.6,
      highGrowthConfidenceScore: 70,
      holdDurationHighConfidenceMinutes: 10,
      moodPauseDurationMinutes: 60,
      coolDownMinutes: 5,
      minLiquidityUsd: 750,
      minHolderCount: 4,
      minBuys5m: 1,
      minPoolAgeSeconds: 0,
      maxCandidateAgeMinutes: 30,
      minOrganicScore: 0,
      minSocialLinks: 0,
      allowVerifiedTokens: true,
      maxAuditTopHoldersPct: 95,
      maxTokenAccountTop1Pct: 70,
      maxTokenAccountTop3Pct: 30,
      maxTokenAccountTop5Pct: 54,
      maxBuyLiquidityFraction: 0,
      moonBagFraction: 0,
      moonBagTrailingDrawdownPct: 0.4,
      insiderDriftConcentrationTop5: 0.6,
      memeKeywords: ['pepe', 'doge'],
      maxMemeFdvUsd: 10_000_000,
      maxFdvToLiquidity: 80,
      borderlineThresholdBufferRatio: 0.2,
      borderlineRecheckEnabled: true,
      borderlineRecheckMinDelayMs: 10_000,
      maxLiquidityDrawdownPct: 15,
      maxSurvivalGrowthPct: 200,
      minSurvivalMomentum: 1.0,
      minBreakoutMultiplier: 1.001,
      earlyPerformanceGuardSeconds: 60,
      earlyPerformanceDropPct: 10,
      earlyPerformanceSellPct: 60,
      minAccelerationFactor: 0.16,
      maxExhaustionRangePct: 1.6,
      minMomentumConsistency: 0.45,
      maxPriceDumpPct: 20,
      maxSellPressureIncreasePct: 100,
      minCandidateScore: 60,
      reentryDipPct: 15,
      reentryBreakoutPct: 20,
      liquidityCollapseThresholdUsd: 750,
      liquidityCollapseThresholdRatio: 0.25,
      minHoldTimeSeconds: 60,
      performanceCheckSeconds: 75,
      performanceMinMomentum: 1.05,
      stopLossPct: 0.2,
      trailingStopDrawdownPct: 0.2,
      maxHoldMinutes: 60,
      timeExitMinMultiple: 1.25,
      holderCountWaitlistSeconds: 60,
      recheckPriceDropPct: 15,
      maxConcurrentAudits: 10,
      scanParallelismLight: 10,
      scanParallelismHeavy: 4,
      ownerAuditParallelism: 4,
      priceFallbackParallelism: 6,
      parallelismMinFactor: 0.5,
      errorRateWindow: 20,
      backpressureErrorRateThreshold: 0.3,
      mintSignalMaxAttempts: 3,
      mintSignalRetryDelayMs: 750,
      maxRecheckAttempts: 5,
      maxAutoSlippageRetry: 3,
      autoSlippageIncrementBps: 100,
      priorityFeeBaseMicroLamports: 25_000,
      priorityFeeMaxMicroLamports: 5_000_000,
      priorityFeePanicMultiplier: 2,
      priorityFeePercentile: 75,
      useJito: false,
      jitoTipLamports: 1_000_000n,
      jitoBlockEngineUrl: 'http://mock-jito',
      jitoTipPercentile: 75,
      jitoTipFloorApiUrl: '',
      jitoConfirmTimeoutMs: 30000,
      jitoBundleRetryAttempts: 3,
      priorityFeeAccountLocal: true,
      priorityFeeVolatilityMultiplier: 1.0,
      maxOpenPositions: 10,
      maxBuysPerScan: 2,
      scanIntervalMs: 5000,
      discoveryPollIntervalMs: 10_000,
      discoveryWsDebounceMs: 750,
      websocketWatchdogIntervalMs: 30_000,
      websocketStaleThresholdMs: 90_000,
      websocketHandshakeTimeoutMs: 15_000,
      survivalDelaySeconds: 20,
      survivalDelayThresholdHigh: 75,
      survivalDelayThresholdVeryHigh: 90,
      finalAuditSeconds: 5,
      maxBuyTopGrowthPct: 120,
      buyTopAthBufferPct: 2,
      discoveryWsEnabled: true,
      discoveryPumpEnabled: true,
      discoveryRaydiumEnabled: true,
      discoveryMeteoraEnabled: true,
      useJupiterSdk: false,
      inlineSwapSimulation: true,
      backgroundAtaClose: true,
      privateKey: '',
      privateKeyPath: '',
      telegramBotToken: '',
      telegramChatId: '',
      discordWebhookUrl: '',
      maxDailyDrawdownPct: 0.15,
      circuitBreakerEnabled: true,
      drawdownCooldownMinutes: 30,
      lossStreakBreakerEnabled: false,
      lossStreakThreshold: 3,
      lossStreakCooldownMinutes: 15,
      expectancyBreakerEnabled: false,
      lossStreakWindowSize: 4,
      maxPositionsPerLaunchpad: 3,
      dynamicSizingEnabled: true,
      mlGateMinRealTrades: 5,
      adaptiveFloorEnabled: true,
      adaptiveFloorLiveEnabled: false,
      minCandidateScoreFloor: 50,
      tradeStarvationMinutes: 10,
      starvationRelaxStep: 3,
      rugExitGuardEnabled: true,
      rugExitWindowSec: 15,
      rugExitDropPct: 0.05,
      rugExitDynamicScalingEnabled: true,
      rugExitMicroCapThresholdUsd: 100_000,
      rugExitMicroCapMultiplier: 1.8,
      rugExitHighCapThresholdUsd: 500_000,
      rugExitHighCapMultiplier: 0.7,
      rugExitVolatilityScalingEnabled: true,
      rugExitSpreadGuardEnabled: true,
      rugExitMaxSpreadPct: 0.15,
      rugExitSpreadExpansionMultiplier: 2.0,
      rugExitVolumeGuardEnabled: true,
      rugExitSellDominanceMultiplier: 2.5,
    } as Config;
  }

  public static default(): TestConfigBuilder {
    return new TestConfigBuilder();
  }

  public withPaperTrading(enabled = true): this {
    this.config.paperTrading = enabled;
    this.config.liveTradingEnabled = !enabled;
    return this;
  }

  public withLiveTrading(enabled = true): this {
    this.config.liveTradingEnabled = enabled;
    this.config.paperTrading = !enabled;
    return this;
  }

  public withMinLiquidity(minLiquidityUsd: number): this {
    this.config.minLiquidityUsd = minLiquidityUsd;
    return this;
  }

  public withSlippage(slippageBps: number): this {
    this.config.slippageBps = slippageBps;
    return this;
  }

  public withBuyAmountSol(solText: string): this {
    this.config.buyAmountSolText = solText;
    const sol = parseFloat(solText);
    this.config.buyAmountLamports = BigInt(Math.floor(sol * 1_000_000_000));
    return this;
  }

  public withStrategy(strategyName: string): this {
    this.config.strategyName = strategyName;
    return this;
  }

  public withStateFile(stateFile: string): this {
    this.config.stateFile = stateFile;
    return this;
  }

  public withOverrides(overrides: Partial<Config>): this {
    this.config = { ...this.config, ...overrides };
    return this;
  }

  public build(): Config {
    return { ...this.config };
  }
}

export function createTestConfig(overrides: Partial<Config> = {}): Config {
  return TestConfigBuilder.default().withOverrides(overrides).build();
}
