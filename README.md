# Veloci-Buy

A Solana memecoin **sniper**. It discovers newly launched pump.fun, Raydium and Meteora tokens
within a second, puts each one through a staged safety audit, buys through Jupiter (or direct
curve routing, optionally as a Jito bundle) and manages every position with a layered exit
monitor. It runs as a plain CLI or with a terminal UI.

> Trading memecoins is extremely risky. Run in paper mode first, use a dedicated wallet, and
> only trade what you can afford to lose.

## Quick start

**Requirements:** Node.js ≥ 20.19, a Solana RPC endpoint (dedicated strongly recommended) and a
free [Jupiter API key](https://dev.jup.ag).

```bash
npm install
cp .env.example .env      # set RPC_URL, JUPITER_API_KEY and one wallet option
npm start                 # paper trading (simulated fills against live prices)
npm start -- --tui        # same, with the terminal UI
```

Each run writes to its own `logs/<mode>/<timestamp>/` directory: `bot.log`, a SQLite state DB
and trade journals.

## How it works

```
discover ─► survive ─► cheap audit ─► deep audit ─► score ─► buy ─► monitor ─► exit
WebSocket   observe     liquidity,     authorities,   0-100 +   Jupiter /   price every   12-rule
logs,       price &     FDV, meme,     holder concen- momentum  local       scanIntervalMs exit chain:
Helius,     flow for    anti-top,      tration,                 router /                 rug guards,
Geyser,     N seconds   re-entry       RugCheck,                Jito                     stops, TP
Jupiter                                BubbleMaps                                        ladder
```

Every outbound request goes through a priority rate limiter, so exits are never queued behind
discovery traffic.

## Configuration

| File                       | Holds                                                                    |
| -------------------------- | ------------------------------------------------------------------------ |
| `.env`                     | RPC endpoints, API keys, wallet, trading mode, rate budgets              |
| `strategies/standard.yaml` | Every tuning knob: entry gates, exits, fees, loop cadence, risk breakers |

To make a variant, add `strategies/<name>.yaml` with only the keys you change and run
`STRATEGY=<name> npm start`.

**Going live** needs `PAPER_TRADING=false`, `DRY_RUN=false` **and** `LIVE_TRADING_ENABLED=true`.

## Documentation

| Doc                                                  | Read it for                                                            |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)         | Process layout, the `Context`, module map, data flow, failure handling |
| [docs/trading-pipeline.md](docs/trading-pipeline.md) | Discovery, scanning, audits, execution, every exit rule, risk controls |
| [docs/configuration.md](docs/configuration.md)       | Every `.env` key and every strategy key, with defaults                 |
| [docs/rate-limits.md](docs/rate-limits.md)           | Budgets, priorities and retry rules for each upstream                  |
| [docs/operations.md](docs/operations.md)             | Modes, sessions and data, reading logs, offline tools, troubleshooting |
| [docs/development.md](docs/development.md)           | Conventions, common changes, testing, CI                               |
| [geyser-plugin/README.md](geyser-plugin/README.md)   | The optional validator-side Geyser stream                              |
| [CHANGELOG.md](CHANGELOG.md)                         | What changed                                                           |

## Commands

| Command                                                        | Purpose                   |
| -------------------------------------------------------------- | ------------------------- |
| `npm start` / `npm start -- --tui`                             | Run the bot               |
| `npm test` / `npm run ci`                                      | Tests / full quality gate |
| `npm run manage-keystore`                                      | Encrypted wallet keystore |
| `npm run analyze-pnl <session dir>`                            | PnL report for a session  |
| `npm run backtest`, `optimizer`, `fetch-data`, `train-history` | Offline research tools    |

## Project layout

```
src/core/       orchestrator, config, strategy loading, state + SQLite, RPC/HTTP/rate-limit utils
src/services/   discovery, scanner, engine, audit, trading, monitor, market state, TUI
src/ml/         optional ML scoring and ghost trader (ML_ENABLED)
strategies/     strategy YAML (standard.yaml = complete defaults) + scoring weights
tests/          node:test suite
geyser-plugin/  optional Rust Geyser plugin
rust-ml-core/   native ML addon (napi-rs)
```
