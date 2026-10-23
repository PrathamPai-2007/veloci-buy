# Configuration

Configuration lives in exactly two places:

| File                                                                            | Holds                                                               | Changes how often |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------- |
| `.env` (template: [`.env.example`](../.env.example))                            | Endpoints, API keys, wallet, trading mode, rate budgets, file paths | Per machine       |
| `strategies/<name>.yaml` (base: [`standard.yaml`](../strategies/standard.yaml)) | Every tuning knob: gates, exits, fees, loop cadence, breakers       | Per experiment    |

Nothing else is configurable at runtime. Defaults in code are only a safety net for the
infrastructure keys. Every tuning default lives in `standard.yaml`.

## How a config is built

[`src/core/config-internals/builder.ts`](../src/core/config-internals/builder.ts) builds the
config in four steps:

1. **Read `.env`** for the infrastructure, secret and mode keys listed below.
2. **Pick the strategy.** The name comes from `STRATEGY` (or `npm start -- --strategy <name>`)
   and defaults to `standard`.
3. **Merge the strategy over the base.** [`strategy-loader.ts`](../src/core/strategy-loader.ts)
   loads `strategies/standard.yaml`, then merges `strategies/<name>.yaml` over it. A strategy
   file only needs the keys it changes. The loader validates the result:
   - Unknown keys are rejected, so a typo fails startup instead of being ignored.
   - A value whose type differs from `standard.yaml` (number, boolean, string or list) is rejected.
   - `stopLossPct` must be between 0 and 1, and `takeProfitMultiples` must be non-empty with
     every value above 1.
   - Numbers can't be negative.

   If the selected strategy is invalid or missing, the loader logs why and falls back to
   `standard`. If `standard.yaml` itself is incomplete or invalid, startup fails.

4. **Apply the free-tier caps.** When any RPC endpoint is free tier, these limits apply so a
   strategy can't 429 a public node:

   | Key                                                                          | Free-tier rule  |
   | ---------------------------------------------------------------------------- | --------------- |
   | `scanIntervalMs`                                                             | at least 8,000  |
   | `discoveryPollIntervalMs`                                                    | at least 30,000 |
   | `maxConcurrentAudits`, `scanParallelismLight`                                | at most 3       |
   | `scanParallelismHeavy`                                                       | at most 1       |
   | `ownerAuditParallelism`, `priceFallbackParallelism`, `mintSignalMaxAttempts` | forced to 1     |

`validateStartupConfig` then checks cross-field rules. For example, live trading needs
`LIVE_TRADING_ENABLED=true`.

### Legacy `.env` keys

Older `.env` files set tuning values directly (for example `STOP_LOSS_PCT`). Those keys are no
longer read, and each one present prints a warning at startup:

```
[CONFIG] STOP_LOSS_PCT is no longer read from .env: set it in strategies/standard.yaml instead.
[CONFIG] BURST_MODE_ENABLED is ignored: that feature has been removed.
```

The YAML key is the camelCase form of the env name (`STOP_LOSS_PCT` → `stopLossPct`). One
exception: `BORDERLINE_THRESHOLD_BUFFER_PCT` (a percentage) became
`borderlineThresholdBufferRatio` (a ratio). Delete legacy keys from `.env` once they're
migrated.

## Creating a strategy

```yaml
# strategies/conservative.yaml: only the keys that differ from standard.yaml
name: 'Conservative'
description: 'Fewer, safer entries'
minCandidateScore: 85
maxOpenPositions: 2
stopLossPct: 0.1
takeProfitMultiples: [1.2, 1.6]
```

```bash
STRATEGY=conservative npm start
```

The startup log line `Strategy: conservative` confirms which strategy is active. The
`npm run optimizer` tool writes strategy files in this same format.

---

## `.env` reference

### Mode

| Key                           | Default    | Meaning                                                        |
| ----------------------------- | ---------- | -------------------------------------------------------------- |
| `PAPER_TRADING`               | `false`    | Simulated fills against live prices with a paper SOL balance.  |
| `DRY_RUN`                     | `true`     | Live quotes and balances; never sends a transaction.           |
| `LIVE_TRADING_ENABLED`        | `false`    | Must be `true` when `PAPER_TRADING=false` and `DRY_RUN=false`. |
| `STRATEGY`                    | `standard` | Strategy file in `strategies/`.                                |
| `BUY_AMOUNT_SOL`              | `0.05`     | SOL per entry (positive decimal).                              |
| `INITIAL_PAPER_SOL`           | `0.1`      | Starting paper balance.                                        |
| `CLOSE_POSITIONS_ON_SHUTDOWN` | `true`     | Sell every open position on graceful shutdown.                 |

> `.env.example` sets `PAPER_TRADING=true` and `DRY_RUN=false`. Start there.

### Wallet (exactly one is required)

| Key                 | Meaning                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `KEYSTORE_PATH`     | Encrypted keystore created by `npm run manage-keystore` (preferred). |
| `KEYSTORE_PASSWORD` | Keystore password. Leave it unset to be prompted at startup.         |
| `PRIVATE_KEY_PATH`  | Path to a `keypair.json`.                                            |
| `PRIVATE_KEY`       | Base58 secret key (least safe).                                      |

### Solana RPC

| Key                       | Default            | Meaning                                                                                                  |
| ------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------- |
| `RPC_URL`                 | **required**       | Comma-separated endpoints. List several only when their limits are independent.                          |
| `WS_RPC_URL`              | derived            | WebSocket endpoints. When blank, one is derived per `RPC_URL` entry.                                     |
| `RPC_TIER`                | auto               | `premium` or `free`, per endpoint or a single value for all. Auto-detection treats public hosts as free. |
| `RPC_RATE_LIMITS`         | premium 10, free 5 | Requests per second, per endpoint or a single value for all.                                             |
| `RPC_SEND_TX_RATE_LIMITS` | 1                  | `sendTransaction` per second. Defaults to 5 for premium endpoints rated at 50 req/s or more.             |
| `HELIUS_API_KEY`          | —                  | Enables Helius `transactionSubscribe` discovery.                                                         |

### Jupiter

| Key                        | Default              | Meaning                                                                                                   |
| -------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------- |
| `JUPITER_API_KEY`          | **required**         | Discovery key: recent and trending feeds, scan-path prices.                                               |
| `JUPITER_POSITION_API_KEY` | = `JUPITER_API_KEY`  | Monitor prices, SOL/USD and swaps. A key from a second Jupiter organisation gets its own upstream budget. |
| `JUPITER_BASE_URL`         | `https://api.jup.ag` | API base.                                                                                                 |
| `JUPITER_RPS`              | `1`                  | Local bucket rate per key. The Free tier allows 1 req/s per organisation.                                 |
| `USE_JUPITER_SDK`          | `true`               | Use `@jup-ag/api` quote + swap instead of `/swap/v2/order` + `/execute`.                                  |

### Security providers

| Key                   | Default                       | Meaning                                                 |
| --------------------- | ----------------------------- | ------------------------------------------------------- |
| `RUGCHECK_ENABLED`    | `false`                       | Run RugCheck reports and top-holder wallet-risk checks. |
| `RUGCHECK_API_KEY`    | —                             | A free account key allows 60 req/min.                   |
| `RUGCHECK_BASE_URL`   | `https://api.rugcheck.xyz/v1` | API base.                                               |
| `RUGCHECK_RPS`        | `1`                           | Local bucket rate.                                      |
| `BUBBLEMAPS_ENABLED`  | `false`                       | Run BubbleMaps clustering checks.                       |
| `BUBBLEMAPS_API_KEY`  | —                             | Required for BubbleMaps.                                |
| `BUBBLEMAPS_BASE_URL` | `https://api.bubblemaps.io`   | API base.                                               |
| `BUBBLEMAPS_RPM`      | `6`                           | Local bucket rate (requests per minute).                |

### Jito

| Key                      | Default                                                | Meaning                                                                  |
| ------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------ |
| `USE_JITO`               | `false`                                                | Send swaps as Jito bundles (swap + tip).                                 |
| `JITO_BLOCK_ENGINE_URL`  | `https://mainnet.block-engine.jito.wtf/api/v1/bundles` | Block engine.                                                            |
| `JITO_TIP_FLOOR_API_URL` | derived from the engine URL                            | Tip-floor endpoint.                                                      |
| `JITO_TIP_SOL`           | `0.001`                                                | Fixed tip (used when `dynamicJitoTipEnabled` is off, and as a fallback). |
| `JITO_RPS`               | `1`                                                    | Local bucket rate. The default allowance is 1 req/s per IP per region.   |

### Geyser plugin

| Key                  | Default | Meaning                                               |
| -------------------- | ------- | ----------------------------------------------------- |
| `GEYSER_ENABLED`     | `true`  | Connects only when one of the endpoints below is set. |
| `GEYSER_TCP_ADDR`    | —       | `host:port` of the plugin sink.                       |
| `GEYSER_SOCKET_PATH` | —       | Unix socket of the plugin sink.                       |

See [geyser-plugin/README.md](../geyser-plugin/README.md).

### Notifications, files, advanced

| Key                   | Default                   | Meaning                                         |
| --------------------- | ------------------------- | ----------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`  | —                         | Telegram alerts (with `TELEGRAM_CHAT_ID`).      |
| `TELEGRAM_CHAT_ID`    | —                         |                                                 |
| `DISCORD_WEBHOOK_URL` | —                         | Discord alerts.                                 |
| `LOG_FILE`            | `bot.log`                 | Log file name inside the session directory.     |
| `SCANNED_TOKENS_FILE` | `scanned-memecoins.jsonl` | Scan journal name inside the session directory. |
| `STATE_FILE`          | per session               | Pins a fixed state DB. Escape hatch only.       |
| `ML_RESERVOIR_FILE`   | `data/ml-reservoir.db`    | Shared cross-session ML sample store.           |
| `PUMP_FEE_RECIPIENT`  | pinned constant           | Overrides the pump.fun buyback fee recipient.   |

### ML

The ML module is configured separately through `ML_ENABLED`, `ML_*`, `GHOST_*`,
`ENTRY_TUNER_*` and `ADAPTIVE_FLOOR_*`. See the ML block in [`.env.example`](../.env.example).
The ML module isn't covered by this config split yet.

---

## Strategy reference

All keys and defaults in `strategies/standard.yaml`, in file order. Units:

- `*Pct` keys are percentages (e.g. `20` = 20%), unless the meaning says "ratio".
- Ratios are fractions (e.g. `0.15` = 15%).
- `*Ms` keys are milliseconds; `*Seconds`, `*Sec` and `*Minutes` keys use the unit in their name.

Keys marked **Not currently read by the code** are accepted and validated, but nothing uses them.

### Loop cadence & discovery

| Key                           | Default | Meaning                                                                                                                            |
| ----------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `scanIntervalMs`              | `4000`  | Monitor loop period: how often open positions are priced and run through the exit chain. Raised to at least 8000 on free-tier RPC. |
| `discoveryPollIntervalMs`     | `20000` | Discovery loop period (Jupiter recent feed + WebSocket signal flush). Raised to at least 30000 on free-tier RPC.                   |
| `discoveryWsEnabled`          | `true`  | Subscribe to program logs over WebSocket for new-mint signals.                                                                     |
| `discoveryPumpEnabled`        | `true`  | Listen to pump.fun program logs.                                                                                                   |
| `discoveryRaydiumEnabled`     | `true`  | Listen to Raydium AMM program logs.                                                                                                |
| `discoveryMeteoraEnabled`     | `true`  | Listen to Meteora DLMM program logs.                                                                                               |
| `discoveryWsDebounceMs`       | `500`   | Debounce window for batching WebSocket mint signals before they reach the scanner.                                                 |
| `trendingDiscoveryEnabled`    | `true`  | Poll the Jupiter top-traded feed and queue trending pump.fun tokens.                                                               |
| `trendingPollIntervalMs`      | `20000` | Trending feed poll period.                                                                                                         |
| `trendingInterval`            | `'5m'`  | Jupiter top-traded window (for example `'5m'` or `'1h'`).                                                                          |
| `websocketWatchdogIntervalMs` | `10000` | How often the WebSocket watchdog checks for stale subscriptions.                                                                   |
| `websocketStaleThresholdMs`   | `90000` | A program subscription silent for this long is restarted (the global heartbeat uses 2x).                                           |
| `websocketHandshakeTimeoutMs` | `15000` | Maximum wait for a subscription handshake before reconnecting.                                                                     |
| `stateFlushIntervalMs`        | `250`   | How often queued SQLite writes are committed (one transaction per flush).                                                          |

### Throughput & RPC backpressure (capped automatically on free-tier RPC)

| Key                              | Default | Meaning                                                                                                                                                  |
| -------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxConcurrentAudits`            | `20`    | Upper bound on candidates audited at once. Capped at 3 on free-tier RPC.                                                                                 |
| `scanParallelismLight`           | `8`     | Concurrency for cheap audits. Capped at 3 on free-tier RPC.                                                                                              |
| `scanParallelismHeavy`           | `3`     | Concurrency for deep (RPC-heavy) audits. Capped at 1 on free-tier RPC.                                                                                   |
| `ownerAuditParallelism`          | `2`     | Concurrency for top-holder owner and wallet-risk lookups. Forced to 1 on free-tier RPC.                                                                  |
| `priceFallbackParallelism`       | `6`     | Concurrency for on-chain price fallbacks. Forced to 1 on free-tier RPC.                                                                                  |
| `parallelismMinFactor`           | `0.55`  | Floor multiplier applied to scan parallelism while RPC backpressure is active.                                                                           |
| `errorRateWindow`                | `30`    | Number of recent RPC outcomes used to compute the backpressure error rate.                                                                               |
| `backpressureErrorRateThreshold` | `0.22`  | RPC error rate (0-1) above which scan parallelism is scaled down by `parallelismMinFactor`.                                                              |
| `mintSignalMaxAttempts`          | `2`     | Attempts to read a mint account and its holders (absorbs RPC indexing lag). This is the only retry budget for those reads. Forced to 1 on free-tier RPC. |
| `mintSignalRetryDelayMs`         | `500`   | Base delay between mint-signal attempts (multiplied by the attempt number).                                                                              |
| `rpcIndexingRetryDelayMs`        | `5000`  | **Not currently read by the code.**                                                                                                                      |

### Entry gates

| Key                                | Default          | Meaning                                                                                  |
| ---------------------------------- | ---------------- | ---------------------------------------------------------------------------------------- |
| `minLiquidityUsd`                  | `300`            | Minimum pool liquidity (USD).                                                            |
| `minOrganicScore`                  | `0`              | Minimum Jupiter organic score.                                                           |
| `minHolderCount`                   | `5`              | Minimum holder count. Below it the token is waitlisted for `holderCountWaitlistSeconds`. |
| `minBuys5m`                        | `1`              | Minimum buys in the last 5 minutes.                                                      |
| `minPoolAgeSeconds`                | `0`              | Minimum pool age.                                                                        |
| `maxCandidateAgeMinutes`           | `30`             | Tokens older than this are ignored.                                                      |
| `minSocialLinks`                   | `0`              | Minimum number of social links (website, twitter, telegram).                             |
| `maxAuditTopHoldersPct`            | `66`             | Maximum share (%) held by the audited top holders.                                       |
| `maxTokenAccountTop1Pct`           | `40`             | Maximum supply share (%) of the largest token account.                                   |
| `maxTokenAccountTop3Pct`           | `30`             | Maximum combined share (%) of the top 3 token accounts.                                  |
| `maxTokenAccountTop5Pct`           | `48`             | Maximum combined share (%) of the top 5 token accounts (hard sybil gate).                |
| `maxFdvToLiquidity`                | `80`             | Maximum FDV-to-liquidity ratio.                                                          |
| `maxMemeFdvUsd`                    | `10000000`       | Maximum FDV (USD) for a meme candidate.                                                  |
| `minMarketCapUsd`                  | `1000`           | Minimum market cap (USD).                                                                |
| `allowVerifiedTokens`              | `true`           | Let Jupiter-verified tokens through the meme filters.                                    |
| `memeKeywords`                     | `list, see file` | Keywords that mark a token name or symbol as a memecoin.                                 |
| `minBubbleMapsScore`               | `60`             | Minimum BubbleMaps decentralization score (only when BubbleMaps is enabled).             |
| `maxBubbleMapsLargestClusterShare` | `0.2`            | Maximum supply share (ratio) of the largest BubbleMaps wallet cluster.                   |
| `minCandidateScore`                | `75`             | Structural + momentum score (0-100) required to buy.                                     |
| `momentumScoringEnabled`           | `true`           | Add the signed momentum/flow delta (about -10..+12) to the structural score.             |
| `minMomentumConsistency`           | `0.65`           | Minimum share of rising intervals during the survival window.                            |
| `maxExhaustionRangePct`            | `1.6`            | Reject when the recent price range indicates an exhausted move.                          |

### Survival window & rechecks

| Key                              | Default | Meaning                                                                                                      |
| -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `survivalDelaySeconds`           | `20`    | How long a new mint is observed before the cheap audit.                                                      |
| `survivalDelayThresholdHigh`     | `75`    | Score at or above which the survival delay shrinks to 50%.                                                   |
| `survivalDelayThresholdVeryHigh` | `90`    | Score at or above which the survival delay shrinks to 10%.                                                   |
| `finalAuditSeconds`              | `5`     | Delay between passing the deep audit and the final pre-buy audit.                                            |
| `minSurvivalMomentum`            | `1.05`  | Minimum price multiple across the survival window.                                                           |
| `minBreakoutMultiplier`          | `1.05`  | Minimum breakout momentum at evaluation.                                                                     |
| `maxPriceDumpPct`                | `18`    | Reject if price dumped more than this (%) during the survival window.                                        |
| `maxLiquidityDrawdownPct`        | `15`    | Reject if liquidity fell more than this (%) during the survival window.                                      |
| `maxSurvivalGrowthPct`           | `450`   | Reject if price grew more than this (%) during the survival window.                                          |
| `minAccelerationFactor`          | `0.3`   | Minimum buy-flow acceleration.                                                                               |
| `maxSellPressureIncreasePct`     | `110`   | Reject when sells dominate and sell pressure rose more than this (%).                                        |
| `maxRecheckAttempts`             | `2`     | Maximum rechecks for a candidate before it is dropped.                                                       |
| `recheckPriceDropPct`            | `15`    | Drop a recheck entry if price fell more than this (%) from its high.                                         |
| `borderlineRecheckEnabled`       | `true`  | Recheck candidates that miss the score gate by a small margin.                                               |
| `borderlineRecheckMinDelayMs`    | `2`     | Delay before a borderline or waitlist recheck.                                                               |
| `borderlineRecheckMaxDelayMs`    | `20000` | **Not currently read by the code.**                                                                          |
| `borderlineRecheckMaxAttempts`   | `6`     | **Not currently read by the code.**                                                                          |
| `borderlineThresholdBufferRatio` | `0.2`   | How close to the gate (ratio) a score must be to count as borderline.                                        |
| `holderCountWaitlistSeconds`     | `33`    | Waitlist delay for tokens below `minHolderCount`.                                                            |
| `reentryDipPct`                  | `15`    | Re-entering a previously traded mint is blocked unless price dipped more than this (%) from the last exit... |
| `reentryBreakoutPct`             | `20`    | ...or broke out more than this (%) above it.                                                                 |
| `coolDownMinutes`                | `5`     | Per-mint cooldown after an exit.                                                                             |

### Trending-token overrides

| Key                              | Default | Meaning                                       |
| -------------------------------- | ------- | --------------------------------------------- |
| `trendingMaxSurvivalGrowthPct`   | `900`   | `maxSurvivalGrowthPct` for trending tokens.   |
| `trendingMaxBuyTopGrowthPct`     | `250`   | `maxBuyTopGrowthPct` for trending tokens.     |
| `trendingMaxPriceDumpPct`        | `30`    | `maxPriceDumpPct` for trending tokens.        |
| `trendingMaxTokenAccountTop1Pct` | `80`    | `maxTokenAccountTop1Pct` for trending tokens. |
| `trendingMaxTokenAccountTop5Pct` | `80`    | `maxTokenAccountTop5Pct` for trending tokens. |
| `trendingMinBubbleMapsScore`     | `40`    | `minBubbleMapsScore` for trending tokens.     |

### Sizing & execution

| Key                            | Default  | Meaning                                                                          |
| ------------------------------ | -------- | -------------------------------------------------------------------------------- |
| `maxOpenPositions`             | `5`      | Maximum concurrent open positions.                                               |
| `maxBuysPerScan`               | `2`      | Maximum buys per scan cycle.                                                     |
| `maxCandidatesPerScan`         | `9`      | **Not currently read by the code.**                                              |
| `maxPositionsPerLaunchpad`     | `3`      | Maximum concurrent positions from one launchpad.                                 |
| `maxBuyLiquidityFraction`      | `0.15`   | Veto buys larger than this fraction of pool liquidity.                           |
| `slippageBps`                  | `500`    | Base swap slippage (basis points).                                               |
| `maxAutoSlippageRetry`         | `3`      | Retries with more slippage after a slippage failure.                             |
| `autoSlippageIncrementBps`     | `100`    | Slippage added per auto-slippage retry (bps).                                    |
| `inlineSwapSimulation`         | `true`   | Simulate swaps before sending them.                                              |
| `backgroundAtaClose`           | `true`   | Close emptied token accounts in the background after full exits (reclaims rent). |
| `enableLocalRouting`           | `true`   | Allow direct pump.fun / Raydium / Meteora routing without Jupiter.               |
| `localRoutingComputeUnitLimit` | `100000` | **Not currently read by the code.**                                              |
| `dynamicSizingEnabled`         | `false`  | Scale position size with recent performance.                                     |
| `kellyEnabled`                 | `false`  | Use Kelly-fraction sizing once enough trades exist.                              |
| `maxKellyFraction`             | `0.25`   | Cap on the Kelly fraction.                                                       |
| `kellyMinTrades`               | `10`     | Closed trades required before Kelly sizing applies.                              |

### Priority fees & Jito tips

| Key                               | Default   | Meaning                                                                                        |
| --------------------------------- | --------- | ---------------------------------------------------------------------------------------------- |
| `priorityFeeBaseMicroLamports`    | `25000`   | Base priority fee (micro-lamports per compute unit).                                           |
| `priorityFeeMaxMicroLamports`     | `5000000` | Priority fee ceiling.                                                                          |
| `priorityFeePanicMultiplier`      | `2`       | Fee multiplier for urgent exits.                                                               |
| `priorityFeePercentile`           | `75`      | Percentile of recent prioritization fees to target.                                            |
| `priorityFeeAccountLocal`         | `true`    | Sample fees for the swap accounts on every call (`false` reuses a cached global estimate).     |
| `priorityFeeVolatilityMultiplier` | `1`       | Extra fee multiplier during high market volatility.                                            |
| `dynamicJitoTipEnabled`           | `false`   | Size Jito tips from the tip floor, urgency and confidence instead of the fixed `JITO_TIP_SOL`. |
| `jitoTipPercentile`               | `75`      | Landed-tip percentile used as the tip floor (25, 50, 75, 95 or 99).                            |
| `jitoTipMaxFractionOfEv`          | `0.25`    | Cap on the tip as a fraction of the trade's expected value.                                    |
| `jitoConfirmTimeoutMs`            | `30000`   | Wait for bundle confirmation before re-signing and resending.                                  |
| `jitoBundleRetryAttempts`         | `3`       | Bundle send attempts.                                                                          |

### Take profit & holding

| Key                                 | Default       | Meaning                                                               |
| ----------------------------------- | ------------- | --------------------------------------------------------------------- |
| `takeProfitMultiples`               | `[1.3, 2.1]`  | Take-profit ladder price multiples (standard plan).                   |
| `takeProfitMultiplesHigh`           | `[1.24, 2]`   | Take-profit ladder for high-confidence entries.                       |
| `takeProfitFractions`               | `[0.75, 0.6]` | Fraction of the remaining position sold at each ladder step.          |
| `takeProfitFraction`                | `0.6`         | Single-step take-profit fraction used by the ghost trader.            |
| `highGrowthConfidenceScore`         | `80`          | Score at or above which the high-confidence take-profit plan is used. |
| `standardGrowthConfidenceScore`     | `70`          | **Not currently read by the code.**                                   |
| `maxHoldMinutes`                    | `20`          | Time exit for standard-confidence positions.                          |
| `timeExitMinMultiple`               | `1.25`        | The time exit only fires while price is below this entry multiple.    |
| `holdDurationHighConfidenceMinutes` | `30`          | Time exit for high-confidence positions.                              |
| `holdDurationLowConfidenceMinutes`  | `5`           | **Not currently read by the code.**                                   |
| `minHoldTimeSeconds`                | `1`           | The performance-momentum exit is not evaluated before this age.       |
| `moonBagFraction`                   | `0.1`         | Fraction of the initial size kept as a runner (0 disables it).        |
| `moonBagTrailingDrawdownPct`        | `0.3`         | Trailing drawdown (ratio) that closes the runner.                     |
| `performanceCheckSeconds`           | `240`         | Age at which the performance-momentum exit checks progress.           |
| `performanceMinMomentum`            | `1.05`        | Exit if price is below this entry multiple at the performance check.  |

### Stops

| Key                            | Default | Meaning                                                                            |
| ------------------------------ | ------- | ---------------------------------------------------------------------------------- |
| `stopLossPct`                  | `0.15`  | Base stop-loss (ratio); scaled by volatility.                                      |
| `trailingStopDrawdownPct`      | `0.15`  | Trailing stop drawdown from the peak (ratio).                                      |
| `breakevenRatchetEnabled`      | `true`  | Raise the stop to breakeven after the first take-profit target.                    |
| `breakevenRatchetBufferPct`    | `0.01`  | Buffer above entry for the ratcheted stop (ratio).                                 |
| `slBreakevenEnabled`           | `true`  | Move the stop to breakeven once price has run up `slBreakevenThresholdPct`.        |
| `slBreakevenThresholdPct`      | `0.07`  | Run-up (ratio) that arms that breakeven stop.                                      |
| `slBreakevenBufferPct`         | `0.005` | Buffer above entry for that stop (ratio).                                          |
| `breakEvenStopEnabled`         | `true`  | Enable the breakeven-stop exit rule.                                               |
| `breakEvenStopTriggerMultiple` | `1.06`  | Entry multiple that arms the breakeven-stop rule.                                  |
| `breakEvenStopFloorPct`        | `0.04`  | Floor above entry (ratio) the breakeven-stop rule protects.                        |
| `earlyStopLossPct`             | `0.1`   | Tighter stop during the first `earlyStopLossWindowSec`.                            |
| `earlyStopLossWindowSec`       | `30`    | Length of the early-stop window.                                                   |
| `midStopLossPct`               | `0.15`  | Stop used after the early window until `midStopLossWindowSec`.                     |
| `midStopLossWindowSec`         | `120`   | End of the mid-stop window.                                                        |
| `earlyPerformanceGuardSeconds` | `60`    | Window in which the early performance guard is active.                             |
| `earlyPerformanceDropPct`      | `10`    | The early guard exits if price drops more than this (%).                           |
| `earlyPerformanceSellPct`      | `50`    | Share (%) of the position the early guard sells.                                   |
| `buyingTheTopSlPct`            | `25`    | **Not currently read by the code.**                                                |
| `buyTopAthBufferPct`           | `2`     | Reject if the current price is within this % of the highest seen price.            |
| `maxBuyTopGrowthPct`           | `70`    | Reject if price already grew more than this (%) since first seen (anti-top guard). |

### Rug & liquidity exits

| Key                                | Default  | Meaning                                                           |
| ---------------------------------- | -------- | ----------------------------------------------------------------- |
| `rugExitGuardEnabled`              | `true`   | Enable the rug-exit guard in the first seconds of a position.     |
| `rugExitWindowSec`                 | `10`     | Length of the rug-exit window.                                    |
| `rugExitDropPct`                   | `0.05`   | Base price drop (ratio) that triggers a rug exit.                 |
| `rugExitDynamicScalingEnabled`     | `true`   | Scale the drop threshold by market cap.                           |
| `rugExitMicroCapThresholdUsd`      | `100000` | Market cap below which the micro-cap multiplier applies.          |
| `rugExitMicroCapMultiplier`        | `1.8`    | Drop-threshold multiplier for micro caps (looser).                |
| `rugExitHighCapThresholdUsd`       | `500000` | Market cap above which the high-cap multiplier applies.           |
| `rugExitHighCapMultiplier`         | `0.7`    | Drop-threshold multiplier for high caps (tighter).                |
| `rugExitVolatilityScalingEnabled`  | `true`   | Scale the drop threshold by observed volatility.                  |
| `rugExitSpreadGuardEnabled`        | `true`   | Exit on spread blow-outs inside the rug window.                   |
| `rugExitMaxSpreadPct`              | `0.15`   | Absolute spread (ratio) that triggers the spread guard.           |
| `rugExitSpreadExpansionMultiplier` | `2`      | Spread expansion versus entry that triggers the spread guard.     |
| `rugExitVolumeGuardEnabled`        | `true`   | Exit when sell volume dominates inside the rug window.            |
| `rugExitSellDominanceMultiplier`   | `2.5`    | Sells-to-buys ratio that counts as dominance.                     |
| `liquidityCollapseThresholdUsd`    | `750`    | Exit if pool liquidity falls below this (USD)...                  |
| `liquidityCollapseThresholdRatio`  | `0.25`   | ...or below this ratio of entry liquidity.                        |
| `insiderDriftConcentrationTop5`    | `0.6`    | Top-5 concentration at entry that enables the insider-drift exit. |

### Risk breakers & adaptivity

| Key                         | Default | Meaning                                                      |
| --------------------------- | ------- | ------------------------------------------------------------ |
| `maxDailyDrawdownPct`       | `0.3`   | Session drawdown (ratio) that trips the drawdown breaker.    |
| `circuitBreakerEnabled`     | `true`  | Pause buying once `maxDailyDrawdownPct` is hit.              |
| `drawdownCooldownMinutes`   | `30`    | Pause length after the drawdown breaker trips.               |
| `lossStreakBreakerEnabled`  | `true`  | Pause buying after a loss streak.                            |
| `lossStreakThreshold`       | `3`     | Losses within the window that trip the streak breaker.       |
| `lossStreakCooldownMinutes` | `20`    | Pause length after the streak breaker trips.                 |
| `lossStreakWindowSize`      | `4`     | Number of recent trades examined for the streak.             |
| `expectancyBreakerEnabled`  | `true`  | Pause when recent expectancy turns negative.                 |
| `moodPauseDurationMinutes`  | `60`    | Pause length when the recent win rate is critical.           |
| `minCandidateScoreFloor`    | `50`    | Lowest the score gate may relax to during trade starvation.  |
| `tradeStarvationMinutes`    | `45`    | Minutes without a buy before the score gate starts relaxing. |
| `starvationRelaxStep`       | `4`     | Points removed from the score gate per starvation interval.  |

### ML gate (read by src/ml; env ML*SCORE*\* still overrides)

| Key                    | Default | Meaning                                                                                      |
| ---------------------- | ------- | -------------------------------------------------------------------------------------------- |
| `mlScoreGateThreshold` | `0.35`  | ML confidence required when the ML gate is active (env `ML_SCORE_GATE_THRESHOLD` overrides). |
| `mlScoreWeight`        | `0.3`   | Weight of the ML score in the blended entry score (env `ML_SCORE_WEIGHT` overrides).         |
