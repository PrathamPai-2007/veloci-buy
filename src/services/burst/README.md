# Burst Mode: Architecture, Developer Guide & Configuration

Burst Mode is an optional, event-driven overlay strategy for capturing short-lived pump waves on newly-launched Solana memecoins. It layers on top of the standard scanner pipeline — sharing all infrastructure (RPC, scanner loop, audit service, monitor) — and overrides only the parameters and logic that differ for high-frequency, short-hold trading.

Enable with `BURST_MODE_ENABLED=true` in `.env` or toggle from the web dashboard. When enabled, `loadConfig()` in `src/core/config.ts` automatically merges the hardcoded `BURST_PRESET` constant over `DEFAULT_STRATEGY` — no separate YAML file is needed or used. The dashboard toggle writes `BURST_MODE_ENABLED` to `.env` and triggers a process restart so the new config takes effect.

---

## Files in this folder

| File                       | Purpose                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `burst-engine.ts`          | Entry signal analysis (`analyzeBurstCandidate`) and the evaluation overlay (`applyBurstOverlay`) that plugs into `engine.service.ts` |
| `burst-exit-calculator.ts` | Builds the burst-specific take-profit plan (`getBurstTakeProfitPlan`) passed to the buy path                                         |
| `burst-monitor.ts`         | Position monitoring — checks every open burst position for early-failure, trailing-stop, distribution, and time exits                |
| `index.ts`                 | Re-exports the public surface of all three files                                                                                     |

---

## Full Pipeline (step-by-step for new developers)

```
Discovery (pump.fun / Raydium / Meteora WS)
        │
        ▼
   Light Audit (cheap)           ← standard burst thresholds applied (minLiquidityUsd=100, minHolderCount=0)
        │  approved
        ▼
  scheduleSurvivalDelay()        ← 5-second survival window (burstSurvivalSeconds)
    ├─ getMintSignals (fire-and-forget, cached to prefetchedMintSignals)
    └─ fetchDirectMarketData ×4  ← prices sampled at T=0s, T=1.5s, T=3s, T=4.5s
         (bonding curve: SOL reserves → USD price + liquidity, cached to burstPriceSamples)
        │
        ▼ (after 5 seconds)
  Survival Recheck
    ├─ Merges burstPriceSamples → enrichedPriceHistory (4 real price points)
    ├─ liquidityAtStart from first curve sample
    └─ applyBurstOverlay called inside evaluateCandidate
         ├─ entryMomentum ≥ 1.005  (price at recheck / price at start of window)
         ├─ drawdown from intra-window peak ≤ 5%
         ├─ buySellRatio ≥ 1.05
         ├─ consistency ≥ 55% green candles (requires ≥4 price points; no-ops with fewer)
         ├─ SOL outflow: bonding curve liquidity drop > 5% → reject
         └─ buy-velocity decay: second-half buy rate < 35% of first-half → reject
        │  approved
        ▼
  scheduleFinalAudit()           ← standard 2-second final audit delay
        │
        ▼
  Full Audit (full depth)        ← authority/freeze, GoPlus, holder concentration,
        │  approved               liquidity, ML gate, applyBurstOverlay runs again
        ▼
  buyCandidate()
    ├─ entryProfile set to 'burst' on the Position object
    └─ getBurstTakeProfitPlan()  ← TP tiers: 75% @ +6%, 25% @ +12%
        │
        ▼
  monitorPositions() (every tick, ~1s interval)
    └─ getBurstExitDecision()     ← runs BEFORE standard TP/SL checks
         ├─ burst-early-failure   within earlyPerformanceGuardSeconds: price < entry × burstMinMomentum
         ├─ burst-trailing-exit   drawdown from all-time high ≥ 4%, AND high was ≥ 5% above entry
         ├─ burst-distribution-exit  after ≥1 TP hit: drawdown ≥ 3% (75% of trailing pct)
         └─ burst-time-exit       age ≥ 2 min AND price < 1.8× entry
```

### Why background curve sampling?

Pump.fun's RPC indexer has a 500ms–3s lag: Jupiter's token data returns `usdPrice: 0` and `holderCount: 0` for freshly-minted tokens. The burst survival window solves this by sampling the pump.fun **bonding curve account directly** at four points during the 5-second wait, giving real SOL reserves and a live USD price. The four samples are stored in `ctx.state.burstPriceSamples.get(mint)` as `BurstPriceSample[]` and merged into `token.enrichedPriceHistory` before `applyBurstOverlay` runs.

---

## Entry Signal Logic (`burst-engine.ts`)

### `analyzeBurstCandidate(ctx, token)`

Called from `applyBurstOverlay` when at least one curve sample exists. Returns `{ passed: boolean; reason?: string }`. Runs six ordered checks — any failure short-circuits and returns immediately with a descriptive reason string.

**Check 1 — Entry momentum** (`burstMinMomentum = 1.005`)

```
currentPrice / priceAtStartOfDelay ≥ 1.005
```

`priceAtStartOfDelay` is recorded by the scanner when the survival timer fires. A multiplier of 1.005 allows gradual consistent growth (0.5% over 5 seconds) while rejecting flat or declining launches. This threshold is intentionally low — burst relies on the other five checks to filter quality, not momentum alone.

**Check 2 — Entry drawdown** (`burstMaxEntryDrawdownPct = 5%`)

```
(peakPrice - currentPrice) / peakPrice ≤ 0.05
```

If the token spiked and already pulled back more than 5% from its intra-window high, entry is blocked. This catches the "already topped" pattern where early buyers are distributing.

**Check 3 — Buy/sell ratio** (`burstMinBuySellRatio = 1.05`)

```
(newBuys - startBuys) / max(1, newSells - startSells) ≥ 1.05
```

Uses `token.stats5m.buys`/`sells` if available (Jupiter tape), falls back to delta of buy/sell counts in `token.tapeHistory`. A ratio ≥ 1.05 means buying pressure exceeds selling — necessary for the pump to continue.

**Check 4 — Consistency** (`minMomentumConsistency = 0.55`, requires ≥ 4 samples)

```
(count of green steps) / (total steps - 1) ≥ 0.55
```

A "green step" is `priceHistory[i] > priceHistory[i-1]`. With 4 curve samples (T=0/1.5/3/4.5s), there are 3 steps — at least 2 must be green. This check no-ops when fewer than 4 samples exist, so it never blocks on data scarcity.

**Check 5 — SOL outflow** (`burstMaxSolOutflowPct = 5%`)

```
(liquidityStart - liquidityEnd) / liquidityStart ≤ 0.05
```

Reads SOL reserves from the first and last `burstPriceSamples` entry. A >5% drop in bonding curve SOL during the survival window indicates a large sell has already happened — likely an insider or early bot exiting. Pump.fun only; Raydium/Meteora tokens fall back to Jupiter liquidity values.

**Check 6 — Buy-velocity decay** (requires ≥ 3 tape points)

```
(second half buys) / (first half buys) ≥ 0.35
```

Compares the buy rate in the second half of the tape window vs. the first half. A decay below 35% suggests the pump is running out of buyers — the wave has peaked before entry. No-ops without at least 3 tape history entries.

### `applyBurstOverlay(ctx, token, pos)`

The glue function called from `engine.service.ts` after `applyMlGate`, on both the cheap-depth pass (survival recheck) and the full-depth pass (final audit). On the first (pre-survival) call, `priceAtStartOfDelay` is null — `applyBurstOverlay` no-ops immediately. Only when `burstModeEnabled` is true does this function run the checks.

---

## Exit Logic (`burst-monitor.ts`)

### `getBurstExitDecision(ctx, pos, balance, pUsd, now?)`

Runs **before** the standard stop-loss/take-profit chain in `monitorPositions`. Returns a `BurstExitDecision | null`. If non-null, `monitorService.executePositionExit` is called immediately and the standard checks are skipped for that tick.

Position is identified as burst by `pos.entryProfile === 'burst'`. Non-burst positions return `null` immediately.

| Exit reason               | Trigger condition                                                                                                                                                                                              | Sell amount                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `burst-early-failure`     | Within `earlyPerformanceGuardSeconds`, price has not reached `entry × burstMinMomentum` (1.005×). The launch is dead — exit immediately to recover capital.                                                    | 100% of `balance.rawAmount` |
| `burst-trailing-exit`     | Drawdown from all-time high ≥ `burstTrailingDrawdownPct` (4%), AND the high was ≥ 5% above entry. The wave has peaked and reversed — lock in the gain.                                                         | 100% of `balance.rawAmount` |
| `burst-distribution-exit` | At least one TP target already hit (`targetsHit > 0`), AND drawdown from high ≥ `burstTrailingDrawdownPct × 0.75` (3%). After partial de-risk, a smaller pullback is sufficient to exit the remainder quickly. | 100% of `balance.rawAmount` |
| `burst-time-exit`         | Position age ≥ `burstMaxHoldMinutes` (2 minutes) AND current price < 1.8× entry. Forces closure of stagnant positions that didn't return enough to justify holding.                                            | 100% of `balance.rawAmount` |

All four exits sell 100% of the remaining raw token balance — burst mode does not hold through reversals after its tight conditions are violated.

### Note on `balance.rawAmount` in paper mode

`balance` is obtained from `tradingService.getWalletTokenBalance`, which in paper mode returns `pos.initialTokenAmountRaw` (the original entry amount, not the post-sell remaining balance). However, `executePositionExit` in `exit-executor.ts` corrects for this internally: it derives the true remaining balance from `pos.lastKnownBalanceRaw` and caps every sell to that amount before processing. Passing `balance.rawAmount` to `getBurstExitDecision` is safe — it is only used to gate on `balance.rawAmount <= 0n`, which correctly returns `null` for all open positions (whose `initialTokenAmountRaw` is always > 0).

---

## Take-Profit Plan (`burst-exit-calculator.ts`)

### `getBurstTakeProfitPlan(ctx)`

Returns a `TakeProfitPlan` compatible with the standard monitor TP machinery:

```
TP1: sell 75% of position at entry × 1.06  (+6% gross → ~+2% net after 200 BPS round-trip)
TP2: sell 25% of position at entry × 1.12  (+12% gross → ~+8% net)
Trailing stop: 4% drawdown from session high (armed after ≥5% gain)
Max hold: 2 minutes
```

The fractions `[0.75, 0.25]` are applied against `initialTokenAmountRaw` (the original purchase amount) via `computeTakeProfitSellAmount`. After TP1 sells 75%, `lastKnownBalanceRaw` becomes 25% of original. When TP2 fires at `0.25 × initialTokenAmountRaw`, this exactly matches the remaining balance — `lastKnownBalanceRaw` drops to 0 and the position closes automatically. The `burst-distribution-exit` catches the residual if price pulls back before TP2 executes.

---

## How Burst Mode Integrates with the Standard Pipeline

### Config layer (`src/core/config.ts`)

When `BURST_MODE_ENABLED=true`, `loadConfig()` applies the hardcoded `BURST_PRESET` constant over `DEFAULT_STRATEGY` before any env-var overrides. Individual burst parameters can still be overridden by shell env vars (e.g. `BURST_TRAILING_DRAWDOWN_PCT=0.03`). The strategy dropdown in the dashboard is disabled when burst mode is active — strategy selection is irrelevant because the preset is fully replaced.

### Scanner (`src/services/scanner/scanner.service.ts`)

Burst tokens flow through the exact same `scanForCandidates` loop as standard tokens. The scanner uses `burstSurvivalSeconds` from config as the survival delay and calls `fetchDirectMarketData` four times during the window to populate `ctx.state.burstPriceSamples`.

### Engine (`src/services/engine/engine.service.ts`)

After rule evaluation, `applyBurstOverlay` is called. If burst checks fail, the candidate is rejected with a `burst-*` reason. If they pass, `evaluateCandidate` returns with `entryProfile: 'burst'`.

### Buy path (`src/services/buy.ts`)

When `result.entryProfile === 'burst'`, `getBurstTakeProfitPlan` is called instead of the standard `getTakeProfitPlan`. The returned plan is stored directly on the `Position` object as `pos.takeProfitMultiples` and `pos.takeProfitFractions`.

### Monitor (`src/services/monitor/monitor.service.ts`)

`getBurstExitDecision` runs at the top of the per-position check loop, before all standard SL/TP checks. If it returns non-null, the position exits immediately and standard logic is skipped for that tick.

---

## Configuration Reference

All parameters live in `BURST_PRESET` in `src/core/config.ts` and can be overridden by shell env vars (shell always wins). Defaults shown are the `BURST_PRESET` values.

| Parameter                  | Env var                        | Default        | Description                                                                                         |
| -------------------------- | ------------------------------ | -------------- | --------------------------------------------------------------------------------------------------- |
| `burstModeEnabled`         | `BURST_MODE_ENABLED`           | `false`        | Master toggle. Set via `.env` or the web dashboard. When true, fully overrides the strategy preset. |
| `burstSurvivalSeconds`     | `BURST_SURVIVAL_SECONDS`       | `5`            | Duration of the survival window. Drives the 4 curve-sampling intervals.                             |
| `burstMinMomentum`         | `BURST_MIN_MOMENTUM`           | `1.005`        | Minimum price ratio (end / start of window). 0.5% gain required over 5 seconds.                     |
| `burstMaxEntryDrawdownPct` | `BURST_MAX_ENTRY_DRAWDOWN_PCT` | `5`            | Max intra-window drawdown from peak (%). Blocks tokens that already reversed.                       |
| `burstMinBuySellRatio`     | `BURST_MIN_BUY_SELL_RATIO`     | `1.05`         | Minimum buy/sell transaction ratio during the window.                                               |
| `burstTrailingDrawdownPct` | `BURST_TRAILING_DRAWDOWN_PCT`  | `0.04`         | Trailing stop depth from position high (4%).                                                        |
| `burstMaxHoldMinutes`      | `BURST_MAX_HOLD_MINUTES`       | `2`            | Hard time cap per position in minutes.                                                              |
| `burstTakeProfitMultiples` | `BURST_TAKE_PROFIT_MULTIPLES`  | `[1.06, 1.12]` | TP price targets as multiples of entry price.                                                       |
| `burstTakeProfitFractions` | `BURST_TAKE_PROFIT_FRACTIONS`  | `[0.75, 0.25]` | Fraction of original position to sell at each TP. Must sum to ≤ 1.0.                                |
| `burstMaxSolOutflowPct`    | `BURST_MAX_SOL_OUTFLOW_PCT`    | `0.05`         | Max allowed bonding curve SOL drop during the survival window (5%).                                 |

Strategy-level parameters overridden by the burst preset:

| Parameter             | Burst Value | Standard Default | Rationale                                                                                             |
| --------------------- | ----------- | ---------------- | ----------------------------------------------------------------------------------------------------- |
| `slippageBps`         | `200`       | `500`            | 2% max slippage per leg; round-trip ~4% vs ~10% at default. Tight targets require tight fill costs.   |
| `minLiquidityUsd`     | `100`       | `1000`           | Fresh tokens have minimal liquidity at launch. On-chain signals replace liquidity as the safety gate. |
| `minHolderCount`      | `0`         | `10`             | Jupiter indexing lag returns 0 for new tokens.                                                        |
| `maxRecheckAttempts`  | `2`         | `5`              | Fast discard of non-viable tokens to prevent queue flooding.                                          |
| `minCandidateScore`   | `45`        | `60`             | Lowered because burst relies on momentum signals more than composite score.                           |
| `stopLossPct`         | `0.05`      | `0.20`           | 5% stop-loss matches the tight 4% trailing stop and minimizes drawdown on failed entries.             |
| `maxOpenPositions`    | `8`         | `5`              | Burst positions turn over quickly; higher concurrency is safe at lower per-trade exposure.            |
| `maxConcurrentAudits` | `20`        | `10`             | Higher audit parallelism to handle increased signal throughput.                                       |

---

## Solana Network Constraints

**RPC provider requirement — use a premium/dedicated node.** Burst mode is far more RPC-intensive than standard mode. Standard mode prices most tokens via Jupiter; burst targets fresh pump.fun mints Jupiter cannot price, so all pricing falls onto on-chain `getMultipleAccounts` bonding-curve reads (`batchFetchDirectMarketData`), and the tight survival/recheck cadence bursts those reads in tight clusters. On a public/free node this manifests as repeated `getMultipleAccounts ... HTTP error (429)` during discovery waves. Run burst only on a premium dedicated RPC (Helius/QuickNode/Alchemy paid tier), or set multiple comma-separated endpoints in `RPC_URL` so `rpcCall` rotates off a 429'd endpoint. See `docs/rate-limits.md` (Solana RPC section) for details.

**Block time (~400ms):** The 5-second survival window spans ~12 blocks, giving AMM pools enough time to settle multiple swaps and reflect real price movement. Windows shorter than 1.5s risk sampling within a single block where price hasn't moved, making consistency checks meaningless.

**RPC indexing lag (500ms–3s):** Jupiter's `/tokens/v2/recent` returns `holderCount: 0`, `usdPrice: 0`, and `liquidity: 0` for newly-minted tokens. The on-chain bonding curve sampling (`fetchDirectMarketData`) bypasses Jupiter entirely — it reads the pump.fun curve account directly via RPC, returning real SOL reserves and a live USD price. Only pump.fun tokens have a readable bonding curve; Raydium/Meteora tokens fall back gracefully to Jupiter values.

**Transaction slippage:** The 200 BPS setting rejects fills worse than 2% from the quote. Some buys will fail during extreme congestion — this is the correct trade-off. A missed entry costs nothing; a 5% buy-side loss on a 6% gross target turns it into a net loss.

---

## Adding New Burst Checks (Developer Guide)

All six entry checks live in `analyzeBurstCandidate` in `burst-engine.ts`. To add a seventh:

1. Add the check inside `analyzeBurstCandidate`, following the existing pattern (early return on failure with a descriptive reason string).
2. If the check needs a new config parameter, add it to `Config` and `PresetStrategy` in `src/types/index.ts`, add it to `BURST_PRESET` in `src/core/config.ts`, and add an env-var mapping in `loadConfig()`.
3. Add a test case in `tests/burst.test.ts` that exercises the new check via the `applyBurstOverlay` path.

To add a new exit condition:

1. Add a new `if` block in `getBurstExitDecision` in `burst-monitor.ts`, returning `{ reason: 'burst-your-reason', sellRaw: ... }`.
2. If the exit should be a "panic" exit (skip TUI confirmation, bypass dry-run on live), add the reason string to the `isPanic` array in `exit-executor.ts`.
3. The exit reason is automatically tracked in metrics via `incrementExitReasonMetric` — no additional wiring needed.

---

## When to Disable Burst Mode

Burst mode is aggressive by design. Switch back to a standard strategy when:

- **Network congestion is high**: 200 BPS slippage means more failed fills during peak traffic. Standard mode's 500 BPS tolerance handles congestion better.
- **Market conditions are sideways or bearish**: The 0.5% momentum threshold and 2-minute hold are calibrated for active pump conditions. In quiet markets, positions time out near break-even.
- **You want longer holds**: Burst's 2-minute hard cap exits positions that are still pumping. Standard mode's trailing stop lets winners run for 20+ minutes.
