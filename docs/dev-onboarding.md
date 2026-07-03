# Veloci-Buy Developer Onboarding Manual

Welcome to the **Veloci-Buy** project. This manual provides a professional, deep-dive guide to the technical architecture, operational pipelines, database systems, execution mechanics, machine learning infrastructure, and developer workflows of the Veloci-Buy Solana discovery and execution engine.

---

### 📑 Table of Contents

1. [Architecture Overview & Lifecycle](#-1-architecture-overview--lifecycle)
2. [Sub-Second Token Ingestion & Discovery](#-2-sub-second-token-ingestion--discovery)
3. [Staged Auditing & Decision Funnel](#-3-staged-auditing--decision-funnel)
4. [Execution Routing & Confirmation Engine](#-4-execution-routing--confirmation-engine)
5. [Position Risk & Exit Monitors](#-5-position-risk--exit-monitors)
6. [Swing Bot — Graduated Token Swing Trader](#-6-swing-bot--graduated-token-swing-trader)
7. [Multi-Threaded SQLite Storage Engine](#-7-multi-threaded-sqlite-storage-engine)
8. [Machine Learning Pipeline & Rust ML Core](#-8-machine-learning-pipeline--rust-ml-core)
9. [Offline Data Pipeline](#-9-offline-data-pipeline)
10. [Operational Developer Playbook](#-10-operational-developer-playbook)
    - [Environment Parameters Reference](#environment-parameters-reference)
    - [Command Cheat Sheet](#command-cheat-sheet)
    - [Troubleshooting](#troubleshooting-common-developer-issues)

### 📂 Project Directory Map

| Directory                     | Purpose                                                                                                                                       |
| :---------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                | Bootstrap: loads config, decrypts wallet, starts bot + dashboard API                                                                          |
| `src/core/`                   | Configuration, constants, state store, SQLite persistence, and shared utilities                                                               |
| `src/services/discovery/`     | WebSocket log ingestion and new-mint signal detection                                                                                         |
| `src/services/scanner/`       | Candidate queuing, survival delays, and recheck scheduling                                                                                    |
| `src/services/engine/`        | Decision engine and entry scoring logic                                                                                                       |
| `src/services/audit/`         | Security auditing (authority checks, holder analysis, RugCheck, BubbleMaps)                                                                   |
| `src/services/trading/`       | Execution adapters, Jito bundles, fee management, and paper broker                                                                            |
| `src/services/monitor/`       | Position monitoring, exit calculation, and trade logging                                                                                      |
| `src/services/swing/`         | Swing bot discovery, signals, tape parsing, and entry/exit                                                                                    |
| `src/services/burst/`         | Burst mode engine, exit calculator, and monitor                                                                                               |
| `src/services/ingestion/`     | Geyser plugin client for low-latency validator streams                                                                                        |
| `src/services/api.service.ts` | WebSocket dashboard API (port `API_PORT`). Intercepts the bot logger to stream engine log lines to the dashboard activity panel in real time. |
| `src/ml/`                     | LSTM scoring, ghost trader, RL exit optimizer, and parameter tuning                                                                           |
| `rust-ml-core/`               | Native Rust LSTM and PPO crate compiled via `napi-rs`                                                                                         |
| `geyser-plugin/`              | Rust Geyser plugin binary (validator-side low-latency stream)                                                                                 |
| `scripts/`                    | Offline tools: backtester, optimizer, market data fetcher, trainer                                                                            |
| `strategies/`                 | YAML strategy preset files (hot-swappable at runtime)                                                                                         |
| `tests/`                      | Full test suite (287 tests across all subsystems)                                                                                             |
| `website/`                    | React SPA dashboard (Vite + GSAP)                                                                                                             |

---

## 📖 1. Architecture Overview & Lifecycle

Veloci-Buy has evolved from a monolithic polling script into a highly optimized, event-driven quantitative trading bot. The architecture decouples data ingestion, signal evaluation, trade execution, position monitoring, and machine learning into dedicated modules to maximize throughput and isolate failure domains.

### 🔄 End-to-End Trade Lifecycle

The path of a candidate token from discovery to exit follows a deterministic, staged pipeline:

```
[Solana Log Ingestion / Geyser / API]
                 │
                 ▼
  [Discovery: Signal Received]
                 │
                 ▼
  [Scanner: Enqueue Recheck / Delay] ──► Pullback checks & Starvation relaxations
                 │
                 ▼
     [Audit Phase 1: Cheap Checks]   ──► Filters liquidity, symbol keywords, and basic criteria
                 │
                 ▼
     [Audit Phase 2: Deep Checks]    ──► Fetches Mint/Freeze auth, Top 1/5 hold %, RugCheck & BubbleMaps
                 │
                 ▼
    [Decision: ML LSTM Scorer Gate]  ──► Evaluates multi-dimensional price sequence shape
                 │
                 ▼
    [Execution: Jupiter / Jito Swap] ──► Jito Bundle (tip + swap) or Jupiter direct swap (auto-slippage retries)
                 │
                 ▼
  [Active Position Risk Monitoring]  ──► Evaluates SL, TP, Trailing stop, Breakeven ratchet, and Insider drift
                 │
                 ▼
      [Position Close & Exit]        ──► Records outcomes, streams data to Ghost Trader & ML retrain loops
```

---

### 🏗️ Technical Architecture & Microservices

Veloci-Buy uses a decoupled, event-driven service architecture to isolate failure domains and maintain low latency under extreme network loads.

```mermaid
flowchart TD
    subgraph Ingestion["Log Ingestion Layer"]
        A[Solana WebSocket Stream] -->|RAW Log Events| B([Log Discovery Service])
    end

    subgraph Analysis["Security & Valuation Layer"]
        B -->|Mint Signal| C([Candidate Scanner])
        C -->|Batch Request| D([Security Auditor])
        D -->|On-Chain Audit Signals| E([Decision Engine])
    end

    subgraph Execution["Execution & Risk Layer"]
        E -->|Candidate Score > Threshold| F([Execution Service])
        F -->|Validator Bundle / Swap| G[Solana Blockchain / Simulated Database Store]
        G -->|Active Position Tracking| H([Position Monitor])
        H -->|TP / SL / Drawdown Trigger| F
    end

    subgraph ML["Adaptive Learning Layer"]
        E -->|Rule-approved candidate| I([Ghost Position Engine])
        I -->|Virtual SL/TP close → Training Sample| J([Machine Learning Manager])
        J -->|Retrained weights| E
    end

    subgraph State["Persistence Engine"]
        C -.->|Atomic State updates| K[([SQLite Transaction Store])]
        H -.->|Commit Position / PnL| K
        J -.->|KV weights + training samples| K
    end
```

---

## ⚡ 2. Sub-Second Token Ingestion & Discovery

To gain a competitive edge in fast-moving Solana markets, Veloci-Buy ingests new token mint signals via three concurrent ingestion pathways:

### A. WebSocket Log Ingestion ([discovery.service.ts](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/src/services/discovery/discovery.service.ts))

The `DiscoveryService` manages persistent WebSocket subscriptions (`logsNotifications` and `slotNotifications`) to Solana RPC nodes:

- **Pattern Matching**: The handler scans raw instruction logs for program-specific initialization signatures:
  - **Pump.fun**: `PUMP_FUN_CREATE_LOG_PATTERN` (`/create/i`) and `PUMP_FUN_MINT_LOG_PATTERN` (`/mintTo/i`).
  - **Raydium AMM V4**: `RAYDIUM_INIT_LOG_PATTERN` (`/initialize2/i`).
  - **Meteora DLMM**: `METEORA_INIT_LOG_PATTERN` (`/initializeLbPair/i`).
- **Debounced Signal Flush**: Discovered mint signatures are pushed to a pending queue. A debounced flush handler triggers candidate evaluations after a configurable delay (`discoveryWsDebounceMs`, e.g., 100ms) to bundle concurrent signals. Re-entrant execution of flush is protected by an `isFlushing` lock flag. When flushing, the signatures are processed concurrently using a bounded pool (`runBoundedPool` with a concurrency limit of 5) instead of sequential iteration to speed up retrieval and avoid RPC queuing backlogs. Signatures that cannot be indexed immediately by the RPC are tracked with an attempt counter (up to 2 retries) and deferred to the next tick to mitigate indexing lag.
- **Global WebSocket Heartbeat Watchdog**: A watchdog timer monitors slot updates. If slot or program logs notifications remain silent beyond `websocketStaleThresholdMs` (default 90s), the service rotates to a backup node in the RPC pool and restarts the subscription controller.

### B. Solana Geyser Plugin Integration ([geyser-client.ts](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/src/services/ingestion/geyser-client.ts))

For low-latency execution, developers can toggle `GEYSER_ENABLED=true` to parse account changes directly from a local or hosted validator's Geyser stream:

- **Pump.fun Curve Decoder**: Decodes bonding curve state variables (`virtualSolReserves`, `virtualTokenReserves`, and `realSolReserves`) directly from the binary account updates, providing sub-millisecond price and liquidity updates.
- **Raydium AMM Decoder**: Monitors state updates for AMM pools. It resolves base and quote vault balances to extract live price and liquidity metrics directly, bypassing RPC query queues.
- **Memory Safety**: Maintains a deduplication filter (`geyserSeenPools`) that is strictly capped at 10,000 items, periodically flushing to prevent unbounded memory leaks during high-volume bursts.

### C. Trending Discovery Feed ([market-data.ts](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/src/services/market-data.ts))

Alongside raw mint listening, the engine queries the Jupiter top-traded feed (`/tokens/v2/toptraded`) if `TRENDING_DISCOVERY_ENABLED=true`:

- **Sorting & Prioritization**: Trending tokens are queued for auditing first.
- **Relaxed Guards**: Because trending tokens have proven market viability, the scanner marks them `isTrending=true` and applies relaxed anti-top growth guards to avoid premature rejections.

---

## 🔍 3. Staged Auditing & Decision Funnel

A candidate token is evaluated through three progressive audit gates coordinated by [scanner.service.ts](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/src/services/scanner/scanner.service.ts) and evaluated in [engine.service.ts](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/src/services/engine/engine.service.ts):

### Phase 1: Survival Wait Window

To eliminate instant rug-pull tokens created by automated developer scripts, the scanner places new mints in a `rechecks` queue for a configurable delay (`survivalDelaySeconds`, e.g., 20s). During this delay, the bot:

1. Spawns timers to sample the on-chain bonding curve price and liquidity (e.g. at T=0, T=1.5s, T=3.0s, T=4.5s).
2. Stores the price ticks inside `burstPriceSamples` to construct a high-frequency price history.

### Phase 2: Cheap Audit Gate

Once the survival delay elapses, the engine runs cheap, local evaluation rules:

- **Keyword Matching**: Checks if the token name/symbol resembles standard memecoin indicators using configured keywords (`memeKeywords`).
- **Liquidity & FDV Floors**: Verifies that liquidity and fully diluted valuation (FDV) are above strategy floors (e.g., `$1000` liquidity in the `standard` preset).
- **Launchpad Restriction**: Only pump.fun launches proceed. Graduated/non-pump tokens (e.g. Raydium graduates, which arrive via `launchpad:'raydium'`) are rejected here and pre-filtered out of the `/tokens/v2/recent` discovery feed — the bot's edge is in early bonding-curve mechanics, not already-run tokens. Fresh mints that arrive untagged (`launchpad:null`) are still allowed through.
- **Starvation-Relaxed Entry Score**: Evaluates the candidate's static heuristics (social links, verify status, organic score) to calculate a structural cleanliness score from 0 to 100, then — when `MOMENTUM_SCORING_ENABLED=true` (default) — layers a signed momentum/flow delta (≈ −10..+12) on top from 5m buy/sell imbalance, buy-flow acceleration, and price trajectory off the survival baseline, so a token visibly dumping in the survival window is demoted.
  - **Starvation Control**: If the bot hasn't executed a trade within `tradeStarvationMinutes` (default 10m) due to quiet markets, it progressively reduces the required entry score gate by `starvationRelaxStep` points every interval down to a hard floor (`minCandidateScoreFloor`), preventing the engine from freezing.

### Phase 3: Deep Audit Gate

If cheap checks pass, the scanner triggers an intensive deep audit:

- **Authority Checks**: Decodes the token mint account. The audit **hard rejects** the token if either `mintAuthority` or `freezeAuthority` are set to non-null values.
- **Unconditional Top-5 Hold Gate**: Reuses holder distributions computed during token account lookup. If the top 5 holder accounts control more than `maxTokenAccountTop5Pct` (default 54%) of the circulating supply, the token is rejected. This check is critical for filtering developer multi-wallet sybil clusters.
- **RugCheck Integration**: Calls `GET /tokens/{mint}/report` on RugCheck.xyz (free, requires key — 60 req/min). Blocks on `danger`-level risks (previously-rugged token, honeypot, etc.) and adds `warn`-level risks as notes. `RUGCHECK_API_KEY` is mandatory; the bot refuses to start without it.
- **BubbleMaps Integration** (optional): Calls the BubbleMaps paid API for wallet clustering / decentralization scoring. Wrapped in a 2-second timeout — if the response is late, the call is abandoned and the on-chain top5 threshold tightens by -10% as a fallback (`bubblemaps-fail-safe-concentration`).
- **Wallet Risk Check**: Top-holder wallet addresses are checked against RugCheck's `/wallet/{addr}/risk` endpoint. Addresses returning `riskLevel: "high"` trigger a `rugcheck-malicious-owner` blocker.

---

## 💸 4. Execution Routing & Confirmation Engine

Veloci-Buy routes swap transactions either through the Jupiter Swap API or via direct Jito Block Engine bundles.

### A. Jupiter Swap API vs SDK Path

The execution adapter ([trading.service.ts](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/src/services/trading/trading.service.ts)) supports two Jupiter paths:

- **REST API Route**: Compiles swap transactions via GET/POST requests targeting the configured Jupiter API endpoint.
- **TS Client SDK Route**: Uses `@jup-ag/api` client instance to fetch quote routes and compile transactions.
- **Local Router Fallback**: Direct smart-contract calls bypass external routers entirely, enabling direct Pump.fun bonding curve swaps.

### B. Auto-Slippage Retry Loop

If a transaction fails with a slippage error (Solana error code `6001` or `0x1771`), `executeSwapOrderWithSmartRetry` catches the error, increments the slippage by `autoSlippageIncrementBps` (e.g., 100 BPS), re-compiles the swap order, and resubmits, up to `maxAutoSlippageRetry` times.

### C. Jito Bundles & Dynamic Tip Engine ([swap-executor.ts](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/src/services/trading/swap-executor.ts))

When `USE_JITO=true`, trades are routed to Jito block engines to remain 100% MEV-proof:

1. **Dynamic Tip Scaling**: Fetches Jito tip percentiles (`getTipFloor`) from the Block Engine API. The tip is scaled dynamically using current network congestion and machine learning confidence scores, applying a panic multiplier during market dumps.
2. **Bundle Construction**: Creates a multi-transaction bundle containing:
   - The signed Jupiter swap transaction.
   - A Jito tip transaction transferring the tip amount in SOL from the trade wallet to a Jito tip account.
3. **Submission & Recheck Loop**: Submits the bundle to the Jito block engine endpoint (e.g., `https://mainnet.block-engine.jito.wtf/api/v1/bundles`). It queries bundle landing status via `getBundleStatuses`.
4. **Re-signing Watchdog**: If the bundle does not land within `jitoConfirmTimeoutMs` (default 30s), the engine fetches a fresh blockhash, re-signs both transactions, and resubmits to prevent transaction expiration.

---

## 🛡️ 5. Position Risk & Exit Monitors

Once a trade executes, a position entry is stored in the SQLite state. The monitoring loop runs at high frequency to execute dynamic exit triggers:

#### Sniper Exit Rules

| Exit Rule                   | Rationale & Mechanics                                                                                                                                                                                               | Config Trigger                                                                                 |
| :-------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------------------- |
| **Stop-Loss**               | Voluntary stop-loss scaled by token price standard deviation (volatility).                                                                                                                                          | `stopLossPct`                                                                                  |
| **Trailing Stop**           | Clamps exits to a trailing drawdown from the highest observed peak. Trailing stop bounds accelerate once the token exceeds a 1.8x multiple.                                                                         | `trailingStopDrawdownPct`                                                                      |
| **Moon-Bag Runner**         | Retains `MOON_BAG_FRACTION` (default 10%) of the entry size. The runner rides a wide `moonBagTrailingDrawdownPct` stop (default 24% drawdown — exits once it gives back 24% of peak) to capture vertical rallies.   | `moonBagRaw`                                                                                   |
| **Breakeven Ratchet**       | Once the token banks its first TP ladder target, the stop-loss is raised to the entry price + fees to protect capital.                                                                                              | `breakevenRatchetEnabled`                                                                      |
| **Midpoint Profit Guard**   | Exits the position if the price reaches the midpoint of a TP target and then falls back, avoiding complete target failures.                                                                                         | `minTpArmed`                                                                                   |
| **Rug-Exit Guard**          | Fires in the first 15s of a position. Exits 100% immediately if the price drops (scaled dynamically by MC/volatility), the spread blows out, or trade/buy volume collapses. Takes priority over EPG in this window. | `rugExitDropPct`, `rugExitWindowSec`, `rugExitSpreadGuardEnabled`, `rugExitVolumeGuardEnabled` |
| **Early Performance Guard** | Active from 15s to 60s after entry (after rug-exit closes). Exits the position if the token drops >10% or the buy-volume tape stalls (zero new buys on two consecutive ticks).                                      | `earlyPerformanceDropPct`, `earlyPerformanceGuardSeconds`                                      |
| **Graduated Stop-Loss**     | Tightens the stop in the first 30s (8%) and 30–120s (13%) after entry, relaxing to the normal volatility-adjusted stop thereafter. Acts as the quantitative backstop throughout all early windows.                  | `earlyStopLossPct`, `midStopLossPct`                                                           |
| **Spread Velocity Exit**    | Triggers an immediate exit if the bid-ask spread widens by more than 50% within 15 seconds.                                                                                                                         | `spread-velocity-exit`                                                                         |
| **Insider Drift Exit**      | Monitors top holder wallets. If a concentrated token shows top wallets exiting, the bot executes an emergency full exit.                                                                                            | `insider-rug-exit`                                                                             |
| **Liquidity Collapse**      | Closes the position if pool liquidity drops below a hard floor or drops beneath a ratio of the entry pool depth.                                                                                                    | `liquidityCollapseThresholdUsd`                                                                |

#### Swing Exit Rules

Swing positions carry `entryProfile:'swing'` and are routed to a dedicated exit path — none of the sniper guards above apply.

| Exit Rule                    | Rationale & Mechanics                                                                                  | Config Trigger                                               |
| :--------------------------- | :----------------------------------------------------------------------------------------------------- | :----------------------------------------------------------- |
| **Swing Flat Stop**          | Flat stop-loss (default 25%) before trailing arms. Fires on `entryProfile:'swing'` positions only.     | `SWING_TRAILING_STOP_PCT`                                    |
| **Swing Trailing Exit**      | Trailing stop arms when price rises ≥5% above entry; thereafter exits when price drops >25% from peak. | `swingTrailingStopPct`, `trailingArmed`                      |
| **Swing Take-Profit Ladder** | Partial sells at 1.5×, 3.0×, and 7.0× entry price (default fractions: 40%, 30%, 20%).                  | `SWING_TAKE_PROFIT_MULTIPLES`, `SWING_TAKE_PROFIT_FRACTIONS` |
| **Swing Time Exit**          | Full exit after `SWING_MAX_HOLD_HOURS` (default 24h) regardless of price.                              | `SWING_MAX_HOLD_HOURS`                                       |

---

## 📈 6. Swing Bot — Graduated Token Swing Trader

The Swing Bot (`SWING_BOT_ENABLED=true`) is a **fourth parallel loop** inside `VelociBuyBot`. It targets the opposite end of the token lifecycle to the sniper: tokens whose bonding curve is complete (graduated to Raydium/Meteora, FDV > $10k) and holds for minutes-to-hours rather than seconds.

### Architecture ([src/services/swing/](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/src/services/swing))

| File                 | Role                                                                                                                                     |
| :------------------- | :--------------------------------------------------------------------------------------------------------------------------------------- |
| `swing-discovery.ts` | Watchlist management: polls `/tokens/v2/toptraded/1h`, filters graduated tokens by FDV, accumulates price history via batch price fetch. |
| `swing-tape.ts`      | Per-pool WebSocket swap subscriptions: pool lookup + log parsing for Raydium AMM V4, Raydium CLMM, and Meteora DLMM.                     |
| `swing-signals.ts`   | Pure signal math: `findLocalMinima`, `detectDoubleDip`, `detectSwapTapeAccumulation`, `computeSwingSignals`.                             |
| `swing-engine.ts`    | Combines signals into a `SwingEvaluationResult` with a 0–100 composite score and blocker list.                                           |
| `swing-monitor.ts`   | Exit logic: flat stop → trail arm → trailing stop → TP ladder → time exit.                                                               |
| `swing-buy.ts`       | Entry execution: creates a `swingCtx` with the swing Jupiter key and calls the shared swap executor.                                     |
| `index.ts`           | Barrel re-export for all swing services.                                                                                                 |

### Signal Pipeline

1. **Watchlist**: Refreshed each poll cycle from Jupiter's top-traded/1h feed. Only tokens where `launchpad === 'raydium'/'meteora'` OR the mint does **not** end with `'pump'` (graduation heuristic) within the configured FDV range are kept. Up to 50 items, 2-hour eviction.

2. **Price accumulation**: Each poll tick appends one `{price, timestamp, liquidity?}` point to `item.priceHistory` (max 180 points) via a single batch `/price/v3?ids=…` call covering all watchlist mints at once.

3. **Double-Dip detection** (`detectDoubleDip`): Requires ≥30 price points. Identifies two local minima separated by a local maximum; requires ≥5% recovery from the second dip. Scoring: base 40 pts + 15 if `higherLow` (dip2 shallower than dip1) + min(10, recoveryPct).

4. **Volume accumulation** (`detectSwapTapeAccumulation`): Compares SOL buy/sell volume in ±5-minute windows around each dip using `item.swapTape` (tick-level WebSocket data). `detected = buyDip2 > buyDip1 AND buySellRatioTrend > 0`. Scoring: base 25 + min(10, `buySellRatioTrend × 5`). Falls back to `detectVolumeAccumulation` on `item.tapeHistory` only if tape is unavailable.

5. **Score gate**: `totalScore = min(100, doubleDipScore + volumeScore)`. Entry fires when score ≥ `SWING_MIN_SCORE` (default 60) with no blockers.

### Exit Model (swing positions only)

Swing positions carry `entryProfile:'swing'`. The monitor loop routes them to `getSwingExitDecision` and **hard returns** — no sniper guards (rug-exit, EPG, breakeven ratchet, moon-bag) ever run on swing positions.

```
1. Max hold time       → full exit if ageHours >= SWING_MAX_HOLD_HOURS
2. Flat stop           → full exit if pUsd <= entry × (1 − 0.25)  [before trailing arms]
3. Arm trailing        → arms when pUsd >= entry × 1.05
4. Trailing stop       → full exit if pUsd <= highestPrice × (1 − 0.25)  [armed only]
5. TP ladder           → partial exits at 1.5×, 3.0×, 7.0× entry
```

### Rate-Limit Isolation

`state.swingJupiterCooldownUntil` is a separate cooldown field from the sniper's `jupiterPriceCooldownUntil`. A 429 on the swing key backs off swing calls for 30s without affecting any sniper price fetch.

### Volume Accuracy — Swap Tape (`swing-tape.ts`)

Volume accumulation uses tick-level on-chain swap data. `SwingTapeManager` resolves a pool address for each watchlist item and opens a persistent `logsSubscribe` WebSocket subscription filtered to that pool account — no HTTP polling, no rate-limit cost. Each swap log is decoded into a `SwingSwapTick {side, amountSol, timestamp}` and appended to `item.swapTape[]` (max 500 ticks). `detectSwapTapeAccumulation` then compares SOL buy/sell volume in ±5-minute windows around each dip. When `item.swapTape.length >= 4`, `computeSwingSignals` uses it automatically.

Three pool types are supported, each with its own pool-lookup and log-parsing path:

**Raydium AMM V4:** Pool ID from `api-v3.raydium.io/pools/info/mint?poolType=standard`. Each swap emits `Program log: ray_log: <base64>` — a 57-byte binary struct parsed by `parseRayLog`:

```
offset 0  — log_type (u8)  : 3 = swap
offset 1  — amount_in (u64): SOL lamports when direction=2 (buy)
offset 17 — direction (u64): 1=sell(coin→pc), 2=buy(pc→coin)
offset 49 — out_amount (u64): SOL lamports received when direction=1 (sell)
```

**Raydium CLMM (concentrated liquidity):** Auto-detected fallthrough — subscribe first tries AMM V4; if no pool found, retries with `poolType=concentrated`. Pool ID from same Raydium v3 API endpoint. Swaps emit Anchor `Program data: <base64>` with discriminator `sha256("event:SwapEvent")[:8]`. Parsed by `parseRaydiumClmmSwapLog` — key fields: `amount_0` (offset 136), `amount_1` (offset 152), `zero_for_one` (offset 168, bool). `solIsTokenX` (resolved at pool-lookup from `mintA.address === SOL_MINT`) determines which amount is SOL and which direction is buy. Pool type stored in `item.raydiumPoolType: 'amm-v4' | 'clmm'`.

**Meteora DLMM:** Pool ID from `dlmm-api.meteora.ag/pair/all_with_pagination?search_term={mint}`. Same Anchor event format — discriminator identical, different field offsets. Parsed by `parseMeteoraSwapLog` — key fields: `amount_in` (offset 80), `amount_out` (offset 88), `swap_for_y` (offset 96, bool). `solIsTokenX` (from `mint_x === SOL_MINT` in API response) determines direction. Both Anchor parsers share the `ANCHOR_SWAP_EVENT_DISCRIMINATOR` constant.

### Two-Speed Polling

Normal cycle: 30s (`SWING_WATCHLIST_POLL_INTERVAL_MS`, default 30 000 ms). After `detectPartialW` fires (dip1 + bounce present, dip2 not yet formed), the item gets `fastPollUntil = now + 30min`. The `fastSwingTimer` (15s) polls only fast-poll items and evaluates them immediately — tighter entry timing without burning rate-limit budget on the full watchlist.

---

## 💾 7. Multi-Threaded SQLite Storage Engine

Veloci-Buy utilizes a multi-threaded state store to avoid blocking the main execution thread during database serialization.

### The Storage Schema

The database runs on SQLite in Write-Ahead Log (WAL) mode. The schema contains the following core tables:

```
                  ┌──────────────────────┐
                  │    SQLite Database   │
                  └──────────┬───────────┘
      ┌──────────────────────┼──────────────────────┐
      ▼                      ▼                      ▼
┌───────────┐          ┌────────────┐         ┌───────────┐
│ positions │          │closed_trades│         │processed_ │
└───────────┘          └────────────┘         │   mints   │
                                              └───────────┘
      ┌──────────────────────┼──────────────────────┐
      ▼                      ▼                      ▼
┌───────────┐          ┌────────────┐         ┌───────────┐
│ kv_store  │          │  rechecks  │         │ml_training│
└───────────┘          └────────────┘         │  samples  │
                                              └───────────┘
```

1. **`positions`**: Holds currently open positions, entry prices, tokens held, and time-series history.
2. **`closed_trades`**: Historical records of completed trades, realized PnL in SOL and USD, exit reasons, and simulated ghost flags (`is_ghost`).
3. **`processed_mints`**: Index of all evaluated mints to prevent duplicate snipes.
4. **`kv_store`**: Key-value pair storage for global values like dynamic model weights, GMI metrics, and paper balances.
5. **`rechecks`**: Pending candidate tokens waiting for survival delay or pullback checks.
6. **`ml_training_samples`**: Labeled feature JSON arrays and price sequences compiled from completed ghost and real trades.

### Asynchronous Write Worker Thread ([state.worker.ts](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/src/core/state/state.worker.ts))

- **Message Passing**: The main thread communicates with the worker using thread-safe `parentPort.postMessage` calls. Parameters are serialized in the worker thread to minimize main thread latency.
- **Batch Transactions**: Statements are queued in a thread-safe array (`writeQueue`). Every `stateFlushIntervalMs` (default 250ms), the worker drains the queue and executes the statements inside an ACID-compliant SQLite transaction.
- **SQLITE_BUSY Recovery**: If the database is locked (e.g. by external analytical tools), the worker catches the error, rolls back the transaction, and unshifts the batch back to the front of the queue to retry on the next interval.

---

## 🧠 8. Machine Learning Pipeline & Rust ML Core

Veloci-Buy implements a hybrid machine learning pipeline combining a native Rust training engine with Node.js automation:

### A. The Native Rust Crate (`rust-ml-core/`)

Compiled via `napi-rs` to export high-performance C++ binary addons:

- **LSTM Network (`lstm.rs`)**: A custom Long Short-Term Memory sequence model. It processes a rolling sequence of price-history points (`sequence: Vec<Vec<f64>>`) and static entry features (`static_features: Vec<f64>`) to calculate candidate entry confidence.
- **RL PPO Exit Policy (`ppo.rs`)**: A continuous reinforcement learning policy utilizing Proximal Policy Optimization. It evaluates market regimes to output stop-loss, take-profit, and trailing stop values.

### B. Ghost Trading Engine ([ghost-trader.ts](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/src/ml/ghost-trader.ts))

To bypass the lack of training data, the bot continuously simulates trades in shadow mode:

- Virtual positions are opened on candidates passing the rule-based filters.
- High-frequency price updates are monitored to track exits (SL, TP ladders).
- Closed virtual trades are saved to `ml_training_samples` with binary labels (1 for profit, 0 for loss) to retrain the entry model.

### C. Entry & Exit Optimizers

- **Entry Tuner**: Every retrain cycle, the engine estimates entry gradients from historical trade outcomes and applies online gradient descent to adjust entry gates like `minCandidateScore` and `minLiquidityUsd`.
- **Exit Optimizer & Drift Guard**: The exit tuner optimizes stop-loss and take-profits parameters. To prevent the model from drifting into unprofitable parameters, a **Drift Guard** runs a simulated PnL replay over historical trades with the new parameters. If the new parameters yield a lower net PnL, the update is rejected and reverted.

---

## 📊 9. Offline Data Pipeline

These scripts operate on historical data independently of the live bot. They read from and write to `logs/` and do not require a running RPC or wallet.

> **Session artifacts:** `sniper-state.db` (SQLite state snapshot) and `trade-journal.jsonl` (closed-trade log) are written automatically by the live bot on every run. Find them under `logs/<session-type>/<timestamp>/` — e.g. `logs/paper-trading/2026-06-12_10-00-00/`.

| Script                  | Command                 | Input                                             | Output                                                                     |
| :---------------------- | :---------------------- | :------------------------------------------------ | :------------------------------------------------------------------------- |
| **Market data fetcher** | `npm run fetch-data`    | Jupiter top-traded feed + GeckoTerminal           | `logs/market-data/<ts>/` — per-token 1m OHLCV JSONL + manifest (FDV ≥ $2k) |
| **Entry backtester**    | `npm run backtest`      | `logs/**/sniper-state.db`                         | Console AUC / precision / recall report                                    |
| **ML trainer**          | `npm run train-history` | `logs/**/sniper-state.db` + `trade-journal.jsonl` | `ml-pretrained-weights.json`                                               |
| **Parameter optimizer** | `npm run optimizer`     | `logs/**/trade-journal.jsonl`                     | Hot-swappable YAML strategy files                                          |
| **PnL analyzer**        | `npm run analyze-pnl`   | Session log directory path                        | Markdown PnL report                                                        |

### Market Data Fetcher (`scripts/fetch-market-data.ts`)

Fetches OHLCV candle history for the top-100 Solana tokens that are less than 24 hours old and have FDV ≥ $2k. Uses only free APIs — no extra keys required beyond `JUPITER_API_KEY`.

**Pipeline per token:**

1. **Jupiter** `/tokens/v2/toptraded/24h` — volume-ranked list; filter by `firstPool.createdAt` (< 24h) and `fdvUsd` (≥ $2k).
2. **DexScreener** `/latest/dex/tokens/{mint}` — resolves the highest-liquidity Solana pool address. Also captures `creator`/`deployer` wallet if present.
3. **GeckoTerminal** `/api/v2/networks/solana/pools/{pool}/ohlcv/minute` — fetches up to 1440 × 1m bars (24h lookback, paginated). 30-second backoff on 429 with one retry.

**Output layout:**

```
logs/market-data/YYYY-MM-DD_HH-MM-SS/
  manifest.jsonl        ← one JSON line per token: mint, symbol, fdvUsd, volume24hUsd,
                           ageHours, candleCount, creator, source, outputFile
  <MINT_ADDRESS>.jsonl  ← one JSON line per candle: {timestamp, open, high, low, close, volume}
  errors.jsonl          ← skipped tokens with reason (no fallback; failures are logged and skipped)
```

**Rate limiting:** tokens fetched sequentially (1.5s between tokens, 500ms after pool lookup, 1s between pagination pages). Expected runtime for 100 tokens: ~4–5 minutes.

**Backtest integration:** `manifest.jsonl` acts as the token universe index. Future backtest scripts can scan `logs/market-data/` for manifests and stream candle files with `readline` — the same pattern used by `train-from-history.ts`.

---

## 💻 10. Operational Developer Playbook

### Environment Parameters Reference

Env vars override the active strategy preset (`strategies/*.yaml`) when set. See [`.env.example`](.env.example) for the full annotated template.

#### Core & Network

| Variable          | Default     | Purpose                                                                                                                                          |
| :---------------- | :---------- | :----------------------------------------------------------------------------------------------------------------------------------------------- |
| `RPC_URL`         | _Required_  | Comma-separated Solana JSON-RPC endpoints (failover pool).                                                                                       |
| `WS_RPC_URL`      | _Optional_  | WebSocket RPC nodes (derived from `RPC_URL` if blank). Leaving blank enables automatic WS rotation failover matching the derived `RPC_URL` pool. |
| `JUPITER_API_KEY` | _Required_  | Jupiter API key for swap routing and price data.                                                                                                 |
| `STRATEGY`        | `standard`  | Active strategy preset name (maps to `strategies/*.yaml`).                                                                                       |
| `API_PORT`        | `8080`      | WebSocket dashboard API port.                                                                                                                    |
| `API_HOST`        | `127.0.0.1` | Interface the API binds to. Set `0.0.0.0` for remote dashboard access (requires `API_TOKEN`).                                                    |
| `API_TOKEN`       | _Optional_  | Auth token for dashboard API; required to switch to LIVE. Auto-generated by `npm run dev:all` if absent.                                         |

#### Wallet & Trading Mode

| Variable               | Default    | Purpose                                                             |
| :--------------------- | :--------- | :------------------------------------------------------------------ |
| `PRIVATE_KEY`          | _Optional_ | Base58 wallet secret (or use `KEYSTORE_PATH` / `PRIVATE_KEY_PATH`). |
| `DRY_RUN`              | `true`     | Signs transactions but never broadcasts them.                       |
| `PAPER_TRADING`        | `false`    | Simulates fills against a virtual SOL balance.                      |
| `LIVE_TRADING_ENABLED` | `false`    | Hard arming switch — real swaps refused unless `true`.              |
| `INITIAL_PAPER_SOL`    | `0.1`      | Starting virtual SOL balance for paper sessions.                    |

#### Sniper — Order Size & Execution

| Variable                      | Default | Purpose                                                       |
| :---------------------------- | :------ | :------------------------------------------------------------ |
| `BUY_AMOUNT_SOL`              | `0.05`  | SOL spent per sniper entry.                                   |
| `MAX_OPEN_POSITIONS`          | `5`     | Maximum concurrent open sniper positions.                     |
| `SLIPPAGE_BPS`                | `500`   | Default swap slippage tolerance (basis points).               |
| `MAX_AUTO_SLIPPAGE_RETRY`     | `3`     | Retries on slippage failure, incrementing slippage each time. |
| `AUTO_SLIPPAGE_INCREMENT_BPS` | `100`   | Slippage bump per retry (basis points).                       |
| `USE_JITO`                    | `false` | Route swaps through Jito block-engine bundles.                |
| `JITO_TIP_SOL`                | `0.001` | Static Jito tip (SOL) when dynamic tipping is off.            |
| `ENABLE_LOCAL_ROUTING`        | `true`  | Direct Pump.fun bonding-curve swaps (bypass Jupiter).         |

#### Sniper — Discovery & Entry Gates

| Variable                     | Default | Purpose                                                           |
| :--------------------------- | :------ | :---------------------------------------------------------------- |
| `TRENDING_DISCOVERY_ENABLED` | `true`  | Poll Jupiter top-traded feed for trending candidates.             |
| `GEYSER_ENABLED`             | `false` | Low-latency Geyser plugin account-stream ingestion.               |
| `MOMENTUM_SCORING_ENABLED`   | `true`  | Adds momentum/flow delta (≈ −10..+12) on top of structural score. |
| `MIN_CANDIDATE_SCORE`        | `75`    | Minimum entry score (0–100) to pass the engine gate.              |
| `MIN_LIQUIDITY_USD`          | `750`   | Liquidity floor (USD).                                            |
| `SURVIVAL_DELAY_SECONDS`     | `10`    | Seconds to observe a new mint before cheap audit runs.            |
| `MAX_BUY_TOP_GROWTH_PCT`     | `120`   | Reject candidates already parabolic since survival start.         |
| `TRADE_STARVATION_MINUTES`   | `10`    | Minutes with no buy before the score gate starts relaxing.        |
| `STARVATION_RELAX_STEP`      | `3`     | Points removed from the score gate per starvation interval.       |
| `MIN_CANDIDATE_SCORE_FLOOR`  | `50`    | Hard floor the starvation controller will not relax below.        |

#### Sniper — Risk & Exits

| Variable                           | Default | Purpose                                                         |
| :--------------------------------- | :------ | :-------------------------------------------------------------- |
| `STOP_LOSS_PCT`                    | `0.2`   | Static stop-loss from entry (0.2 = 20%).                        |
| `TRAILING_STOP_DRAWDOWN_PCT`       | `0.20`  | Trailing stop: exit on this drawdown from peak (0.20 = 20%).    |
| `TAKE_PROFIT_MULTIPLES`            | `1.5`   | Comma-separated TP price multiples (ladder rungs).              |
| `TAKE_PROFIT_FRACTION`             | `0.60`  | Fraction of position sold at each TP rung.                      |
| `MOON_BAG_FRACTION`                | `0.1`   | Fraction reserved as a moon-bag runner (wide trailing stop).    |
| `MOON_BAG_TRAILING_DRAWDOWN_PCT`   | `0.24`  | Trailing drawdown for the moon-bag tranche.                     |
| `BREAKEVEN_RATCHET_ENABLED`        | `true`  | Raise stop to entry after first TP banks.                       |
| `EARLY_STOP_LOSS_PCT`              | `0.08`  | Tighter stop in the first 30s after entry.                      |
| `MID_STOP_LOSS_PCT`                | `0.13`  | Tighter stop from 30s–120s after entry.                         |
| `RUG_EXIT_DROP_PCT`                | `0.05`  | Base price drop percentage to trigger a rug-exit.               |
| `RUG_EXIT_WINDOW_SEC`              | `15`    | First N seconds where the rug-exit guard is active.             |
| `EARLY_PERFORMANCE_DROP_PCT`       | `10`    | Exit if price drops this % during the early-performance window. |
| `EARLY_PERFORMANCE_GUARD_SECONDS`  | `60`    | Upper bound (seconds) of the early-performance guard window.    |
| `MAX_HOLD_MINUTES`                 | `60`    | Time-based full exit after this many minutes.                   |
| `LIQUIDITY_COLLAPSE_THRESHOLD_USD` | `750`   | Emergency exit if pool liquidity falls below this USD floor.    |
| `COOL_DOWN_MINUTES`                | `20`    | Minutes before re-evaluating the same mint after an exit.       |

#### ML, Burst & Circuit Breakers

| Variable                  | Default | Purpose                                                  |
| :------------------------ | :------ | :------------------------------------------------------- |
| `ML_ENABLED`              | `false` | LSTM scoring gate + online training loops.               |
| `ML_RL_OPTIMIZER`         | `true`  | Native PPO RL exit optimizer (requires Rust addon).      |
| `ML_GATE_MIN_REAL_TRADES` | `5`     | Real closed trades before ML gate leaves advisory mode.  |
| `BURST_MODE_ENABLED`      | `false` | High-speed breakout overlay (overrides strategy preset). |
| `CIRCUIT_BREAKER_ENABLED` | `true`  | Pause new buys on session drawdown breach.               |
| `MAX_DAILY_DRAWDOWN_PCT`  | `0.30`  | Drawdown fraction that trips the circuit breaker.        |

#### Swing Bot

| Variable                           | Default                             | Purpose                                                        |
| :--------------------------------- | :---------------------------------- | :------------------------------------------------------------- |
| `SWING_BOT_ENABLED`                | `false`                             | Enables the graduated-token swing trader loop.                 |
| `SWING_JUPITER_API_KEY`            | _(falls back to `JUPITER_API_KEY`)_ | Dedicated Jupiter key for swing calls (rate-limit isolated).   |
| `SWING_MIN_MARKET_CAP_USD`         | `10000`                             | Minimum FDV (USD) for graduated tokens to enter the watchlist. |
| `SWING_MAX_MARKET_CAP_USD`         | `10000000`                          | Maximum FDV (USD) for graduated tokens.                        |
| `SWING_BUY_AMOUNT_SOL`             | `0.05`                              | SOL to spend per swing entry.                                  |
| `SWING_MAX_OPEN_POSITIONS`         | `3`                                 | Maximum concurrent swing positions.                            |
| `SWING_WATCHLIST_POLL_INTERVAL_MS` | `30000`                             | Milliseconds between watchlist refresh + signal evaluation.    |
| `SWING_MIN_OBSERVATION_MINUTES`    | `30`                                | Minimum minutes a token must be watched before evaluation.     |
| `SWING_DOUBLE_DIP_ENABLED`         | `true`                              | Enable double-dip (W-pattern) signal detection.                |
| `SWING_VOLUME_ACCUM_ENABLED`       | `true`                              | Enable volume-accumulation signal (requires double-dip).       |
| `SWING_MIN_SCORE`                  | `60`                                | Minimum composite signal score (0–100) required to enter.      |
| `SWING_TRAILING_STOP_PCT`          | `0.25`                              | Flat stop / trailing stop width for swing positions.           |
| `SWING_TAKE_PROFIT_MULTIPLES`      | `1.5,3.0,7.0`                       | Comma-separated TP multipliers for the ladder.                 |
| `SWING_TAKE_PROFIT_FRACTIONS`      | `0.4,0.3,0.2`                       | Fraction of remaining balance sold at each TP rung.            |
| `SWING_MAX_HOLD_HOURS`             | `24`                                | Hours before a time-exit closes the swing position.            |

#### Notifications

| Variable              | Default    | Purpose                              |
| :-------------------- | :--------- | :----------------------------------- |
| `TELEGRAM_BOT_TOKEN`  | _Optional_ | Telegram bot token for trade alerts. |
| `TELEGRAM_CHAT_ID`    | _Optional_ | Telegram chat ID for trade alerts.   |
| `DISCORD_WEBHOOK_URL` | _Optional_ | Discord webhook for trade alerts.    |

---

### Command Cheat Sheet

Use these commands to build, test, and manage the project:

```bash
# Install NPM packages
npm install

# Compile the native Rust ML Core
# On Windows (Automatically configures MSVC build environment):
npm run build:rust:win
# On Linux/macOS:
npm run build:rust

# Compile the TypeScript files
npm run build

# Start the React dashboard only — no bot (for frontend dev/testing)
npm run dev

# Start bot and React dashboard concurrently (cyan BOT logs, magenta WEB logs)
npm run dev:all

# Start the interactive terminal UI (TUI)
npm start -- --tui

# Run the test suite
npm test

# Generate a PnL Report from a paper trading log directory
npm run analyze-pnl logs/paper-trading/2026-06-12_10-00-00

# Fetch 1m OHLCV candles for the top-100 new tokens (< 24h old, FDV ≥ $2k)
# Writes per-token JSONL candle files + manifest to logs/market-data/<timestamp>/
# Sources: Jupiter (token list) → DexScreener (pool lookup) → GeckoTerminal (OHLCV)
npm run fetch-data

# Evolve trading parameters using the Genetic Algorithm Optimizer
npm run optimizer
```

---

### Troubleshooting Common Developer Issues

#### 1. Rust Compilation Errors on Windows (`napi build` failure)

- **Problem**: Compilation fails due to missing MSVC linkages or missing C++ compiler workloads.
- **Solution**: Install the **Desktop development with C++** workload inside Visual Studio Build Tools. Run the build command using the specialized script:
  ```bash
  npm run build:rust:win
  ```
  This script automatically locates and sources the MSVC environment variables before compiling.

#### 2. SQLite Database Lockups (`database is locked` / `SQLITE_BUSY`)

- **Problem**: The database locks up when writing state updates while external analytical tools are reading the database.
- **Solution**: Ensure your SQLite explorer tool is connected in **Read-Only** mode. The state worker will automatically catch `SQLITE_BUSY` errors, roll back the transaction, and retry on the next interval (`stateFlushIntervalMs`).

#### 3. Stale WebSocket Connections

- **Problem**: The bot stops discovering tokens when WebSocket connections go stale without triggering a hard network drop.
- **Solution**: Check your `RPC_URL` node latency. The watchdog timer in `discovery.service.ts` will automatically rotate the RPC endpoint if slot updates remain silent for longer than `websocketStaleThresholdMs`. If subscriptions hang silently at startup (no logs after boot), the `WEBSOCKET_HANDSHAKE_TIMEOUT_MS` timeout (default 15s) will fire and cause a reconnect — lower it (e.g., `8000`) if your node is known to be fast but occasionally drops the initial handshake.

#### 4. Jupiter 429 Errors on Exits (`Jupiter SDK error 429`)

- **Problem**: The bot logs `Failed to exit <TOKEN> for take-profit-X: Jupiter SDK error 429: {"code":429,"message":"[API Gateway] Too many requests"}`. The exit is dropped and the position stays open.
- **Root cause**: Jupiter rate-limits per **account**, not per API key. Discovery scans, position price fetches, and exit swaps all share the same RPS bucket. When they fire simultaneously — a scan quote + price fetch + exit swap within the same second — the last caller gets 429'd. Creating additional keys from the same Jupiter account does **not** help; they deplete the same limit. See: https://developers.jup.ag/docs/portal/rate-limits
- **Solution A (free)**: Register a second Jupiter account at https://dev.jup.ag and generate a new API key. Set it as `JUPITER_POSITION_API_KEY` in `.env`. The bot routes discovery through `JUPITER_API_KEY` and all monitor/exit calls through `JUPITER_POSITION_API_KEY` — separate accounts means separate rate-limit buckets.
- **Solution B (paid)**: Upgrade to a paid Jupiter API tier. Higher RPS cap eliminates contention from a single account.

#### 5. Implausible Negative Token Age (Clock Skew)

- **Problem**: The bot rejects all discovered tokens because they appear to be created "in the future" (resulting in negative age).
- **Solution**: This error indicates that your local system clock is behind real time. Resync your system clock using NTP:
  ```powershell
  w32tm /resync
  ```
  The scoring engine will automatically clamp negative token ages to 0 to prevent trading halts while displaying a warning.
