# Veloci-Buy: A High-Performance Solana Discovery & Execution Engine

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.19.0-blue?style=for-the-badge&logo=node.js)](https://nodejs.org)
[![Solana](https://img.shields.io/badge/blockchain-Solana-black?style=for-the-badge&logo=solana)](https://solana.com)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-blue?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/license-MIT-green?style=for-the-badge)](https://opensource.org/licenses/MIT)

---

> [!CAUTION]
>
> ### 🛑 LEGAL & FINANCIAL DISCLAIMER
>
> **1. Financial Risk Warning**
> Trading digital assets, particularly highly volatile memecoins on the Solana blockchain (e.g., decentralized liquidity pools), involves an extremely high level of risk and may not be suitable for all investors. You may lose all or more than your initial investment. Only trade with capital you can afford to lose.
>
> **2. No Warranties & Limitation of Liability**
> This software is provided "as is" and "as available", without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and non-infringement. In no event shall the authors, developers, or copyright holders be liable for any claim, damages, or other liability, whether in an action of contract, tort, or otherwise, arising from, out of, or in connection with the software or the use or other dealings in the software.
>
> **3. Simulation & Sandboxing**
> Users are strongly advised to run the bot in paper-trading and dry-run modes extensively before risking actual capital. Past performance is not indicative of future results.
>
> **4. Tax and Regulatory Compliance**
> Cryptocurrency taxation and regulations vary by jurisdiction. You are solely responsible for identifying, declaring, and paying any taxes due to your local tax authorities. The authors and contributors do not provide legal, tax, or investment advice.

---

Veloci-Buy was conceived as a lightweight script designed to snipe token liquidity pools on Solana. Today, it has matured into a production-grade, event-driven discovery and execution pipeline optimized for the most volatile trading environments.

### Core Components

- **Orchestration**: Coordinating service lifecycles, connection pool managers, failover clusters, and graceful shutdown watchdogs.
- **Event Ingestion**: Establishes high-speed WebSocket listeners tracking raw instruction logs to bypass explorer latency. Includes a built-in retry queue to recover transactions temporarily dropped by RPC indexing lag.
- **Trending Discovery**: Alongside new-mint discovery, polls top-traded feeds, filters to targets, and tags trending candidates to prioritize them in the audit queue and relax specific anti-top guards.
- **Scanner Service**: Identifies candidates, schedules recheck loops, and gates tokens using survival delays.
- **Security Audit**: Analyzes mint authorities and top holder concentrations. Falls back to local on-chain heuristics if external security APIs experience service degradation.
- **Decision Engine**: Evaluates candidate token metadata, social linking metrics, and volume momentum consistency, then layers a momentum/flow delta onto the structural score. Enforces a minimum market-cap floor, restricts entries to early mechanics, and swaps in relaxed thresholds for trending coins.
- **Execution Adapter**: Builds and signs transactions, utilizing priority-fee estimators and private validator bundle networks to prevent front-running and MEV sandwich attacks.
- **Risk Monitor**: Tracks open positions using real-time price feeds. Manages a layered early-exit stack (rug-exit guard, early-performance guard, graduated stop-loss), trailing drawdowns, concentration-aware insider-drift exits, a moon-bag runner on a wide trailing stop, and emergency liquidity-collapse shutdowns.
- **Swing Bot**: Graduated-token swing trader running on its own dedicated loop. Maintains a watchlist of graduated tokens, accumulates price history and on-chain swap tape, and enters on double-dip and volume-accumulation signals.
- **Ghost Trader**: Runs parallel virtual positions on top candidates, generating ground-truth training samples from real price movement with zero capital at risk.
- **Market Data Fetcher**: Offline pipeline that fetches historical candle data for top new tokens via external APIs for backtesting and machine learning training.
- **ML Service**: Orchestrates model training, weight persistence, parameter optimization, and cold-start gating. Runs off-thread to prevent blocking execution.
- **Native ML Core**: A compiled native addon hosting the sequence model and reinforcement learning exit policy.
- **Geyser Ingestion**: Optional low-latency account stream from a validator, layered on top of RPC polling. Includes memory-safe eviction caps to prevent deduplication leaks.
- **SQLite Store**: Encapsulates position tracking, completed trades, training samples, and operational statistics inside a transactional SQLite database. Writes are batched and flushed from a dedicated persistence worker thread to keep serialization off the execution path.

---

## The Evolutionary Journey: From Legacy Sniper to Quantitative Engine

### 🔹 V1.x era

- **Architecture**: Monolithic polling structures that fetched token updates directly from standard RPC endpoints.
- **Limitations**: Suffered from indexing lag and rate-limiting blocks. State was saved in flat, corruption-prone files. Strategies were hardcoded directly in code, preventing dynamic parameter tuning.

### 🔹 V2.x Era

- **Sub-Second WS Ingestion**: Integrated raw WebSocket subscription to Sol log streams, enabling mint address identification before transaction indexing completes.
- **Quant Indicator Upgrades**: Added market mood filtering via the Global Momentum Index, volatility-adaptive risk metrics, and multiple different exits.
- **Major Refactor**: Refactored the monolithic bot into smaller modules for cleaner execution and debugging.

### 🔹 V3.x Era

The V3.x era represents the most significant evolution of Veloci-Buy, transforming it from a reactive sniper into a quantitative trading engine with native machine learning, MEV-protected execution, and multiple parallel trading strategies.

#### Codebase Modernization

- **Full TypeScript Transition**: Ported all core logic and utility scripts to strict TypeScript, defining structured data contracts across the codebase.
- **ACID-Compliant State Store**: Replaced JSON writing with an active database engine operating in Write-Ahead Log (WAL) mode, achieving crash-resilient, non-blocking disk writes.
- **Reactive Cooldown Expiry**: Replaced coarse polling loops with non-blocking, event-driven timers registered dynamically to State Store events.
- **Modular Strategies**: Presets are externalized into configuration files, allowing hot-swapping configurations via CLI flags at runtime.

#### Execution & MEV Protection

- **MEV Protection & Smart Routing**: Built a multi-stage execution pipeline routing orders dynamically via validator bundles or swap paths with smart slippage auto-retries.
- **Dynamic Tip & Confirmation Engine**: Integrates real-time Block Engine queries to dynamically calculate percentile-based tips, monitor confirmation status, and execute transaction re-signing on bundle retry loops.

#### Entry Intelligence & Security Hardening

- **Expectancy-Driven Entry Optimization**: A financial-optimization pass driven by trading journals, tuned for net expectancy — eliminating catastrophic losers at entry and letting winners run — rather than raw win-rate.
- **Unconditional Top-5 Concentration Gate**: Rejects launches where the top 5 holders control more than a configured threshold. It reuses holder shares already computed during the audit (zero added snipe latency) and runs on every candidate, closing the gap that previously let wallet setups through on the top-1 check alone.
- **Momentum/Flow Entry Delta**: A signed delta layered on top of the structural score reads buy/sell imbalance, buy-flow acceleration, and price trajectory off the survival baseline — validated mainly as a downside filter that demotes tokens visibly dumping in the survival window.

#### Risk Management & Exit Controls

- **Moon-Bag Runner**: A reserved tranche of every non-burst position is exempt from routine take-profit and rides a much wider trailing stop, holding a free option on a moonshot while the bulk still books profit.
- **Loss-Streak Breaker**: After consecutive losing positions, new entries pause for a configured cooldown duration — catching a slow bleed of small losses that the coarse portfolio-drawdown breaker is too slow to react to.
- **Legal PnL Reporting**: Generates compliant Markdown reports documenting gross profits, losses, and transaction histories.

#### Machine Learning & Adaptive Intelligence

- **Native Machine Learning Core**: Replaced the pure-JS neural network with a high-performance native machine learning engine compiled via `napi-rs`.
  - **LSTM Sequence Model**: A custom Long Short-Term Memory network that scores a token's pre-entry price-history sequence — momentum shape rather than a single snapshot.
  - **RL Exit Optimizer**: An opt-in Proximal Policy Optimization agent that reads the market regime and outputs continuous, optimal exit parameters.
- **Continuous Ghost Trading**: Continuously opens zero-capital ghost positions on top candidates and tracks them against live market data to generate ground-truth training samples without capital risk, with full take-profit ladder simulation and calibrated labels.
- **Genetic Algorithm Optimizer**: A fast parallelized evolutionary algorithm that continuously evolves entry/exit parameters over trading journals, automatically compiling hot-swappable strategies.

#### Alternate Trading Modes & Ingestion

- **Geyser Plugin Integration**: An optional validator plugin that intercepts block/account updates and streams them over low-latency socket connections, bypassing RPC overhead. Includes native bonding-curve decoding to resolve prices and liquidity directly from the binary stream.
- **Burst Mode (Experimental)**: An optional high-speed scalp strategy targeting a single +20% exit on volatile memecoins. Uses a 5-minute maximum hold and an 8% trailing stop. Activated via a single flag or a dashboard toggle.
- **Swing Bot (Experimental)**: A patient swing-trading module that runs as a parallel loop alongside the sniper. Targets tokens whose bonding curve has completed (graduated to standard pools) and holds for minutes-to-hours. Signal types are combined into a composite score: a double-dip W-pattern detector and a volume-accumulation filter. Exit uses a wide flat stop, trailing stop arming, and a three-rung take-profit ladder. Dedicated API configurations keep swing rate-limit state isolated. A two-speed poll mechanism arms a fast-poll cycle once a partial W forms, yielding tighter entry timing. Volume accuracy comes from tick-level swap tape tracking, covering multiple pool types: Raydium AMM, Raydium CLMM, and Meteora DLMM.

---

## Token Evaluation Pipeline

Veloci-Buy filters out scams and high-risk setups through a series of automated check gates:

```
[MINT SIGNAL]
     │
     ▼
┌─────────────────────────┐
│ 1. Survival Delay Gate  │ ──► Dynamic wait times filtering out instant developer rug-pulls
└─────────────────────────┘
     │
     ▼
┌─────────────────────────┐
│ 2. Security Audit Gate  │ ──► Checks freeze authority, mint ownership, and holder concentration
└─────────────────────────┘
     │
     ▼
┌─────────────────────────┐
│ 3. Valuation & Depth    │ ──► Rejects tokens with unbalanced pool depth or excessive market caps
└─────────────────────────┘
     │
     ▼
┌─────────────────────────┐
│  4. Anti-FOMO Guard     │ ──► Pauses execution if token is experiencing extreme parabolic growth
└─────────────────────────┘
     │
     ▼
┌─────────────────────────┐
│  5. ML Confidence Gate  │ ──► Neural network blocks low-confidence candidates
└─────────────────────────┘
     │
     ▼
[BUY EXECUTION]
```

---

## 🖥️ Web Dashboard & UI

Veloci-Buy includes a React SPA dashboard connected directly to the Solana trading engine via high-speed WebSockets. The UI leverages a custom GSAP design system for a fluid and responsive feel.

- **Live Activity Log**: Engine log events are streamed in real time to the dashboard's activity panel — no separate terminal window needed to follow what the bot is doing.
- **Auth token auto-sync**: Running `npm run dev:all` automatically generates an `API_TOKEN` in `.env` (if absent) and mirrors it into `website/.env.local`, so the dashboard authenticates without any manual configuration.
- A custom process orchestrator prefixes backend engine logs as `[BOT]` (cyan) and web logs as `[WEB]` (magenta), cleaning up all child processes automatically upon exit.

---

## ⚡ Quick Start

### 1. Prerequisites

- **Node.js**: `>= 20.19.0`
- **RPC Endpoints**: High-quality Solana HTTP and WS endpoints.
- **Jupiter API Access**: Required to calculate swap pricing and route orders. Jupiter rate-limits per account — set `JUPITER_POSITION_API_KEY` (a key from a **second** Jupiter account) to avoid 429 collisions between discovery and exit sells. See [dev-onboarding.md](dev-onboarding.md#5-jupiter-429-errors-on-exits-jupiter-sdk-error-429) for setup steps.
- **Rust toolchain (optional)**: Required only to build the native machine learning core. Without it, the bot falls back to default execution and shadow mode.

### 2. Installation & Setup

```bash
# Install dependencies
npm install

# Configure environment secrets
# (Copy the environment variables template to your local environment file and fill in keys)

# (Optional) build the native machine learning core.
# On Linux/macOS with a Rust toolchain:
npm run build:rust
# On Windows (loads the build environment automatically):
npm run build:rust:win
```

### 3. Running the Bot

```bash

# Start the bot in plain, CLI log based mode
npm start

# Start paper trading with a CLI Terminal UI
npm start -- --tui

# Start the web dashboard only (no bot — for frontend dev/testing)
npm run dev

# Start the bot and web dashboard together
npm run dev:all

# Build and run the optimized production container
npm run build
npm run start:prod

# Generate a PnL report (Markdown) for a specific session directory
npm run analyze-pnl -- logs/session-xxx
```

---

## 🧪 Modular Test & Validation Suite

Veloci-Buy maintains high test coverage using a robust, modular test suite built entirely on the native testing framework. The suite is divided into logical test types:

### 1. Core Unit & Utility Validation

- **Unit Tests**: Validates core mathematical utilities (standard deviation, spread calculations), binary decoding, safe JSON serialization, file locks, and cache evictions.
- **Keystore Tests**: Assures encryption/decryption of operator private keys, password integrity checks, and validation error paths.

### 2. Strategy & Configuration Constraints

- **Config Tests**: Validates startup constraints (slippage limits, stop-loss percentages, fraction ranges), environment variable mapping, and invalid config rejections.
- **Strategy Tests**: Validates strategy loading, fallback behaviors for missing or deleted presets, and parser error recovery.

### 3. State Persistence & Legacy Migration

- **Migration Tests**: Exercises the conversion pipeline from legacy storage to the active database schema, ensuring data integrity and backups.

### 4. Real-time Ingestion & WebSocket Discovery

- **Discovery Tests**: Mocks WebSocket log notification channels to test parsing accuracy for Raydium, Meteora, and other pools. Verifies debounced flush intervals and connection watchdogs.
- **Scanner Tests**: Verifies candidate sorting queues, retry parameters, candidate queue scheduling, survival delays, and index lag requeues.

### 5. Dynamic Risk Control & PnL Monitoring

- **Monitor Tests**: Validates dynamic stop-loss levels, trailing drawdowns, take-profit target executions, minimum holding periods, and insider-wallet drift sensors.
- **Portfolio Tests**: Tests global risk controls including daily drawdown safety triggers, max open position counts, launchpad sector concentration limits, and dynamic position-size scaling.
- **Audit Tests**: Asserts mint authority audits, holder concentration metrics, and autonomous local-chain fallback audits when external APIs are down.

### 6. Execution, Jupiter Swap & Jito Routing

- **Trading Tests**: Validates priority fee scaling based on market congestion, Jupiter price caching, and swap order retries with dynamic slippage increments.
- **Jito Bundle Tests**: Verifies Block Engine tip floor queries, confirmation status polling, and bundle retry logic.

### 7. ML & Adaptive Learning

- **ML Tests**: Tests feature extraction, scoring model lifecycles, gradient parameter optimizers, and cold-start gating.
- **Ghost Trader Tests**: Covers the ghost position lifecycle — candidate queuing, exit triggers, label assignment, and retrain cadence.
- **RL & Ensemble Tests**: Validate reinforcement learning exit policies (bounded/ordered output, weight round-trips, reward improvement) and per-pool ensemble routing with general-model fallback.
- **Backtest Tests**: Validates walk-forward backtesters — chronological train/test splitting, statistical evaluation metrics, and shuffle controls.
- **Geyser & Fee Manager Tests**: Cover Geyser parser details and probabilistic MEV tip configurations.

### 8. End-to-End Simulation & UI Refresh Orchestration

- **Services Tests**: Simulates complete transaction loops including mock paper trades, dry-runs for live swaps, and database persistence verification.
- **Orchestration Tests**: Tests boot processes, error rate backpressure thresholds, automatic worker parallelism adjustments, and graceful process signals lifecycle termination.
- **TUI Tests**: Verifies terminal UI event loops, dashboard data rendering refresh cycles, and user input throttles.

### Test Orchestration Sandbox

- **Test Helpers**: Provides the core testing sandbox. Mocks HTTP RPC configurations, registers mock websocket channels, overrides fetch networks, and instantiates standardized mock configurations to ensure tests run fast and isolated without performing active external network calls.

```bash
# Execute the full testing suite
npm test

# Run tests with experimental test coverage metrics
node --import tsx --test --experimental-test-coverage tests/*.test.ts
```

---
