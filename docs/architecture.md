# Architecture

Veloci-Buy is a single Node.js process that snipes newly launched Solana tokens. It is
I/O-bound: almost all of its latency comes from RPC, Jupiter and WebSocket round trips, not
from computation. That is why it is written in TypeScript and why most of the design is about
budgeting and prioritizing network calls.

## Runtime shape

```
src/index.ts
  └─ loadConfig()                  .env + strategies/<name>.yaml → Config
  └─ StateStore.load()             SQLite session DB → in-memory State
  └─ new VelociBuyBot(...)         RPC pools, Context, timers
       ├─ discovery loop           every discoveryPollIntervalMs
       ├─ trending loop            every trendingPollIntervalMs
       ├─ monitor loop             every scanIntervalMs
       ├─ WebSocket discovery      continuous (program logs + heartbeat)
       ├─ Geyser stream            continuous, optional
       └─ ML service + ghost       optional (ML_ENABLED=true)
  └─ TuiService                    optional (--tui), renders from the store
```

`VelociBuyBot` ([src/core/bot.ts](../src/core/bot.ts)) owns:

- **Timers.** Each loop has a busy flag, so a slow cycle is skipped rather than stacked.
- **RPC pools.** It keeps one `@solana/kit` RPC client per `RPC_URL` and one subscription
  client per WebSocket URL. A failing WebSocket rotates to the next URL.
- **Graceful shutdown.** It stops the timers and discovery and, when
  `CLOSE_POSITIONS_ON_SHUTDOWN=true`, closes positions. Persistence is flushed and closed last.

## The Context

Every service is a plain function that takes a `Context` (`ctx`)
([src/types/context.ts](../src/types/context.ts)):

| Field                                                                          | What it is                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `config`                                                                       | The resolved `Config` (read-only after startup)                    |
| `state`                                                                        | Mutable in-memory `State`: positions, rechecks, snapshots, metrics |
| `store`                                                                        | `StateStore`: state mutations that also queue persistence writes   |
| `rpc`, `rpcs`, `getCurrentRpc()`                                               | RPC clients (always call them through `rpcCall`)                   |
| `rpcSubscriptions`, `getCurrentRpcSubscriptions()`, `rotateRpcSubscriptions()` | WebSocket clients                                                  |
| `wallet`                                                                       | Address and signer                                                 |
| `logger(message, level, opts)`                                                 | Session log, plus the console or TUI                               |

The rules:

- Mutate state through `ctx.store`, so changes are persisted.
- Make network calls through `rpcCall` or `fetchJson`, so they are rate limited.

## Module map

```
src/
├── index.ts                     entry point: CLI flags, config, wallet, store, bot, TUI
├── core/
│   ├── bot.ts                   orchestrator
│   ├── bot-internals/           geyser coordinator, vault subscriptions, backpressure
│   ├── config.ts                config facade (loads .env)
│   ├── config-internals/        builder.ts, env-loaders.ts, validators.ts
│   ├── strategy-loader.ts       strategy YAML load / merge / validate
│   ├── tuning-keys.ts           the list of strategy-owned Config keys
│   ├── scoring-loader.ts        strategies/scoring.yaml (score weights)
│   ├── state/                   state.store.ts, state.persistence.ts
│   ├── db.ts, migrate.ts        SQLite schema and legacy JSON import
│   ├── keystore.ts              encrypted wallet keystore
│   ├── errors.ts                RateLimitError, RpcError, …
│   └── utils/                   solana.ts (rpcCall), fetch.ts (fetchJson), rate-limit.ts,
│                                io.ts, math.ts, pool.ts, crypto.ts, notifier.ts
├── services/
│   ├── discovery/               WebSocket log ingestion, Helius subscriber, pump decoder
│   ├── ingestion/               Geyser client
│   ├── scanner/                 coordinator, scheduler, executor, stages
│   ├── engine/                  evaluation (engine.service.ts), scoring, ML gate stage
│   ├── audit/                   on-chain auditor, RugCheck, BubbleMaps
│   ├── market-state/            local price/liquidity/tape state, pool decoders
│   ├── account-index/           token-account index (top-holder tracking)
│   ├── market-data.ts           Jupiter feeds and prices, on-chain curve prices
│   ├── jupiter-circuit-breaker.ts
│   ├── buy.ts                   entry execution and bookkeeping
│   ├── trading/                 swap executor, Jito, fees, paper broker, wallet, adapters
│   ├── monitor/                 position monitor, exit executor, exit rules, trade logger
│   └── tui.service.ts           blessed terminal UI
├── ml/                          ML scoring, ghost trader, optimizers
└── types/                       config, market, position, state, signals, context, solana
```

`#core/*`, `#services/*`, `#ml/*` and `#types/*` are path aliases for these directories.

## Data flow

```
                 ┌──────────────── discovery ────────────────┐
 program logs ──►│ DiscoveryService ─► mint signals (debounced)│
 Helius txs   ──►│                                            │──► scanCoordinator.requestScan
 Jupiter feeds ─►│ market-data (recent / trending)            │
                 └────────────────────────────────────────────┘
                                     │
                                     ▼
          scanner: dedupe → survival delay → recheck queue (state.pendingCandidateRechecks)
                                     │  due
                                     ▼
          engine.evaluateCandidate: cheap audit → deep audit → score → decision
                                     │  approved
                                     ▼
          buy.buyCandidate → trading (Jupiter / local router / Jito / paper) → Position
                                     │
                                     ▼
          monitor loop: price → exit chain → exit-executor (sell) → trade-logger → ClosedTrade
```

Market data has two sources:

- **Local market state** (`services/market-state/`) holds price, liquidity and swap tape, fed
  by Geyser, vault subscriptions and curve reads. It's free and fast, so the monitor and the
  scanner check it first.
- **Remote sources** are Jupiter prices and RPC `getAccountInfo`/`getMultipleAccounts` curve
  reads. They're used only when local state is missing or stale.

## Persistence

Each run gets a session directory, `logs/<paper-trading|live-trading>/<timestamp>/`, containing
`bot.db` (SQLite in WAL mode), `bot.log` and the JSONL journals.

`StateStore` updates memory first, then `StatePersistence` queues the write:

- Objects are serialized when they are queued.
- The queue is committed in one transaction every `stateFlushIntervalMs`, on the main thread.
- Lock contention (`SQLITE_BUSY`) is retried, up to 5 times.
- Any other failure replays the batch one write at a time, dropping only the bad write.

On startup, `loadFromDb` rebuilds the state. See [operations.md](operations.md#sessions-logs-and-data)
for the tables.

## Failure handling at a glance

| Failure                    | Behaviour                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| Upstream 429               | That bucket runs at half rate for 30 s. A Jupiter 429 opens its circuit breaker for 30 s.    |
| Jupiter down               | The breaker opens after 3 failures; prices come from on-chain reads.                         |
| RPC endpoint errors        | The call rotates to another endpoint; 3 consecutive errors quarantine the endpoint for 60 s. |
| RPC error rate high        | Backpressure scales scan parallelism down (`backpressureErrorRateThreshold`).                |
| WebSocket silent or broken | It reconnects with backoff (5 s → 60 s, jittered); repeated failures rotate the URL pool.    |
| Drawdown or loss streak    | Risk breakers pause buying (`circuitBreakerEnabled`, `lossStreakBreakerEnabled`).            |
| SQLite busy                | The batch is retried; other errors isolate the bad write.                                    |

The full rate-limit design is in [rate-limits.md](rate-limits.md).
