import { Config } from '#types/index.js';

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
    'maxConcurrentAudits',
    'scanParallelismLight',
    'scanParallelismHeavy',
    'ownerAuditParallelism',
    'priceFallbackParallelism',
    'errorRateWindow',
    'mintSignalMaxAttempts',
    'mintSignalRetryDelayMs',
    'maxRecheckAttempts',
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
