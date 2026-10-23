# Trading pipeline

How a token gets from "just launched" to "closed trade", stage by stage. The keys named here
are the strategy settings from [configuration.md](configuration.md#strategy-reference).

## 1. Discovery

Four sources feed the scanner. Each one dedupes against `processed_mints`.

**WebSocket program logs** ([discovery.service.ts](../src/services/discovery/discovery.service.ts))

- Subscribes to `logsNotifications` for the pump.fun, Raydium AMM and Meteora DLMM programs
  (`discovery*Enabled`), plus a `slotNotifications` heartbeat.
- Log lines are matched against each program's create/initialize patterns, and pump.fun
  `CreateV2` events are decoded directly.
- Signals are debounced (`discoveryWsDebounceMs`). Signatures without a decodable mint are
  resolved with `getTransaction` at `LOW` priority, 5 at a time.
- A watchdog (`websocketWatchdogIntervalMs`) restarts silent subscriptions
  (`websocketStaleThresholdMs`). Reconnects back off exponentially with jitter (5 s → 60 s),
  and three consecutive failures rotate the WebSocket pool.

**Helius `transactionSubscribe`**

- Runs only when `HELIUS_API_KEY` is set. It delivers parsed transactions directly.

**Geyser plugin** (optional; [geyser-client.ts](../src/services/ingestion/geyser-client.ts),
[geyser-plugin/](../geyser-plugin))

- Streams account updates from a validator.
- pump.fun curves and Raydium/Meteora pools are decoded into local market state, which gives
  sub-millisecond price and liquidity without polling RPC.

**Jupiter feeds** ([market-data.ts](../src/services/market-data.ts))

- `/tokens/v2/recent` is polled every discovery cycle.
- `/tokens/v2/toptraded/<trendingInterval>` is polled when `trendingDiscoveryEnabled` is on.
- Trending tokens are tagged `isTrending` and use the `trending*` gate overrides.

## 2. Scanner

[src/services/scanner/](../src/services/scanner) turns signals into scheduled work.

| Stage          | What happens                                                                                                                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intake         | New tokens are deduped, then gated by age (`maxCandidateAgeMinutes`) and per-mint cooldown (`coolDownMinutes`).                                                                                           |
| Survival delay | The token waits `survivalDelaySeconds`. High scores shorten the wait (`survivalDelayThreshold*`). Meanwhile price, liquidity and tape history accumulate.                                                 |
| Rechecks       | Borderline scores, low holder counts (`holderCountWaitlistSeconds`) and pullbacks are rescheduled, up to `maxRecheckAttempts`. An entry whose price falls `recheckPriceDropPct` from its high is dropped. |
| Final audit    | After the deep audit passes, a last check runs `finalAuditSeconds` later. In live mode a buy quote is prefetched.                                                                                         |

Concurrency is bounded by `maxConcurrentAudits` and `scanParallelism*`, and drops automatically
when the RPC error rate is high (backpressure).

## 3. Evaluation

[engine.service.ts](../src/services/engine/engine.service.ts) evaluates each candidate in two
depths.

### Cheap audit (local data only)

- **Meme filter:** `memeKeywords`, `allowVerifiedTokens`, `maxMemeFdvUsd`.
- **Floors:** `minLiquidityUsd`, `minMarketCapUsd`, `maxFdvToLiquidity`, `minBuys5m`,
  `minPoolAgeSeconds`.
- **Launchpad profile:** per-launchpad multipliers; pump.fun is the target.
- **Survival behaviour:**
  - Price movement: `minSurvivalMomentum`, `minBreakoutMultiplier`, `maxPriceDumpPct`,
    `maxSurvivalGrowthPct`.
  - Liquidity: `maxLiquidityDrawdownPct`.
  - Order flow: `maxSellPressureIncreasePct`, `minAccelerationFactor`,
    `minMomentumConsistency`, `maxExhaustionRangePct`.
- **Anti-top guards:** `maxBuyTopGrowthPct` and `buyTopAthBufferPct`.
- **Re-entry:** a mint traded before only re-enters after a `reentryDipPct` dip or a
  `reentryBreakoutPct` breakout.
- **Score:**
  - A structural score (0–100) is built from socials, verification, organic score,
    liquidity ratio, holders and volume/FDV. Weights are in
    [strategies/scoring.yaml](../strategies/scoring.yaml).
  - With `momentumScoringEnabled`, a signed momentum delta (about −10..+12) is added.
  - The total must reach `minCandidateScore`. During trade starvation (`tradeStarvationMinutes`)
    the gate relaxes by `starvationRelaxStep`, down to `minCandidateScoreFloor`.

### Deep audit

Runs on cheap-audit survivors ([audit/providers/](../src/services/audit/providers)):

- **Authorities:** a set mint authority or freeze authority is a hard reject.
- **Concentration:** top-1/3/5 token-account shares (`maxTokenAccountTop*Pct`) come from the
  token-account index or a single-budget RPC read.
  - Top-5 is the main sybil gate.
  - `getTokenLargestAccounts` is paced through the heavy-RPC slot.
- **RugCheck** (`RUGCHECK_ENABLED`): `danger` risks block the token; `warn` risks become notes.
  Top-holder wallets with `riskLevel: high` block it too.
- **BubbleMaps** (optional): checks the decentralization score and largest-cluster share. On a
  timeout or error, the on-chain concentration result stands.
- **Soft quality gates:** holders, organic score, social links, top-holder %.

### Decision

The candidate ends up approved, rejected, or sent to a recheck or waitlist. With
`ML_ENABLED=true`, the ML gate can veto the candidate or blend its score in
(`mlScoreGateThreshold`, `mlScoreWeight`). It only enforces after enough real trades have
accumulated.

## 4. Execution

[buy.ts](../src/services/buy.ts) checks the conditions first, then sizes and routes the order
([trading/](../src/services/trading)).

**Pre-checks:**

- Market state must be authoritative.
- The risk breakers and mood must not be paused.
- `maxOpenPositions`, `maxPositionsPerLaunchpad` and `maxBuysPerScan` must have room.

**Sizing:**

- The base size is `BUY_AMOUNT_SOL`, optionally adjusted by `dynamicSizingEnabled` or
  `kellyEnabled`.
- Orders larger than `maxBuyLiquidityFraction` of the pool are vetoed.

**Routes:**

- **Jupiter:** `/swap/v2/order` + `/swap/v2/execute`, or the SDK quote + swap
  (`USE_JUPITER_SDK`). Both use the position key at `ULTRA_HIGH` priority.
- **Local router** (`enableLocalRouting`): builds pump.fun, Raydium or Meteora instructions
  directly.
- **Jito** (`USE_JITO`): sends the swap plus a tip as a bundle.
  - The tip comes from the tip floor (`jitoTipPercentile`), urgency and confidence when
    `dynamicJitoTipEnabled` is on, capped at `jitoTipMaxFractionOfEv`.
  - If the bundle hasn't landed after `jitoConfirmTimeoutMs`, it's re-signed with a fresh
    blockhash and resent, up to `jitoBundleRetryAttempts` times.

**Priority fees** use `priorityFee*`; urgent exits multiply the fee by
`priorityFeePanicMultiplier`.

**Slippage:** each attempt starts at `slippageBps`. A slippage failure is retried with a fresh
order and `autoSlippageIncrementBps` more, up to `maxAutoSlippageRetry` times. A signed
`/swap/v2/execute` call is never resent blindly.

**Paper mode** ([paper-broker.ts](../src/services/trading/paper-broker.ts)) simulates fills,
fees and slippage against live prices and tracks a paper SOL balance.

The new `Position` records entry price and liquidity, the holder snapshot, the take-profit plan
(`takeProfitMultiples`, or `takeProfitMultiplesHigh` when the score reaches
`highGrowthConfidenceScore`) and the moon-bag tranche (`moonBagFraction`).

## 5. Monitoring and exits

On every monitor tick ([monitor.service.ts](../src/services/monitor/monitor.service.ts)), each
position is priced, local market state first. When local state is missing, it falls back to
on-chain curve reads, then to Jupiter on the position key.

The position then goes through the exit chain
([exits/exit-chain.ts](../src/services/monitor/exits/exit-chain.ts)). Rules run in this order,
and the first decision wins:

| #   | Rule                   | Exits when                                                                                                                                                            |
| --- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `security-rug`         | Mint or freeze authority appears after entry.                                                                                                                         |
| 2   | `insider-rug`          | Entry top-5 ≥ `insiderDriftConcentrationTop5` and top holders start exiting.                                                                                          |
| 3   | `spread-velocity`      | The bid/ask spread widens sharply.                                                                                                                                    |
| 4   | `adaptive-tp`          | Price reached a take-profit midpoint and fell back to it.                                                                                                             |
| 5   | `breakeven-stop`       | Armed at `breakEvenStopTriggerMultiple`; protects `breakEvenStopFloorPct` above entry.                                                                                |
| 6   | `early-guard`          | Rug-exit window (`rugExit*`: scaled drop, spread blow-out, sell dominance), then the early performance guard (`earlyPerformance*`).                                   |
| 7   | `stop-loss`            | Volatility-scaled `stopLossPct`; tighter in the first `earlyStopLossWindowSec` / `midStopLossWindowSec`; ratchets to breakeven (`breakevenRatchet*`, `slBreakeven*`). |
| 8   | `performance-momentum` | After `minHoldTimeSeconds`, price is still below `performanceMinMomentum` × entry.                                                                                    |
| 9   | `trailing-stop`        | Drawdown from the peak exceeds `trailingStopDrawdownPct`.                                                                                                             |
| 10  | `moon-bag-trailing`    | The runner gives back `moonBagTrailingDrawdownPct`.                                                                                                                   |
| 11  | `time-exit`            | `maxHoldMinutes` (or `holdDurationHighConfidenceMinutes`) has passed and price is below `timeExitMinMultiple`.                                                        |
| 12  | `take-profit-ladder`   | The next `takeProfitMultiples` step is hit; sells `takeProfitFractions` of the remainder.                                                                             |

A liquidity collapse (`liquidityCollapseThreshold*`) also forces an exit.

[exit-executor.ts](../src/services/monitor/exit-executor.ts) performs the sell:

- Urgency sets the priority fee and Jito tip.
- Full exits close the token account in the background (`backgroundAtaClose`).
- The mint goes on cooldown (`coolDownMinutes`).

[trade-logger.ts](../src/services/monitor/trade-logger.ts) then:

- writes the `ClosedTrade` and its journal line;
- updates session PnL and the risk breakers (drawdown, loss streak, expectancy, mood).

## 6. Risk controls

| Control             | Keys                                                                                                   | Effect                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Drawdown breaker    | `circuitBreakerEnabled`, `maxDailyDrawdownPct`, `drawdownCooldownMinutes`                              | Pauses buys after a session drawdown.                                  |
| Loss-streak breaker | `lossStreakBreakerEnabled`, `lossStreakThreshold`, `lossStreakWindowSize`, `lossStreakCooldownMinutes` | Pauses buys after a run of losses.                                     |
| Expectancy breaker  | `expectancyBreakerEnabled`                                                                             | Pauses when recent expectancy turns negative.                          |
| Mood                | `moodPauseDurationMinutes`                                                                             | Halves size when the win rate is cautious; pauses when it is critical. |
| Position caps       | `maxOpenPositions`, `maxPositionsPerLaunchpad`, `maxBuysPerScan`                                       | Limits exposure.                                                       |
| Live-trading lock   | `PAPER_TRADING`, `DRY_RUN`, `LIVE_TRADING_ENABLED`                                                     | Real swaps need all three set explicitly.                              |
