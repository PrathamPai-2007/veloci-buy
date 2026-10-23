# Operations

Running the bot day to day: modes, the CLI and TUI, session data, and what to do when things
go wrong.

## Running

```bash
npm start                              # CLI, logs to the console
npm start -- --tui                     # terminal UI
npm start -- --strategy conservative   # same as STRATEGY=conservative
npm run build && npm run start:prod    # compiled build from dist/
```

Stop the bot with `Ctrl+C`; it shuts down gracefully. With `CLOSE_POSITIONS_ON_SHUTDOWN=true`
(the default), open positions are sold first. A watchdog force-exits after 20 s.

## Trading modes

| `PAPER_TRADING` | `DRY_RUN` | `LIVE_TRADING_ENABLED` | Mode                                                        |
| --------------- | --------- | ---------------------- | ----------------------------------------------------------- |
| `true`          | any       | any                    | **Paper**: simulated fills, paper SOL balance               |
| `false`         | `true`    | any                    | **Dry run**: live quotes and balances, no transactions sent |
| `false`         | `false`   | `true`                 | **Live**: real swaps                                        |
| `false`         | `false`   | `false`                | Refused at startup                                          |

The startup line confirms the mode: `VelociBuyBot PAPER started. Strategy: standard. Wallet: ...xxxxx.`

**Before going live:**

1. Run in paper mode long enough to trust the strategy (`npm run analyze-pnl` on the sessions).
2. Use a dedicated wallet funded only with what you're willing to lose.
3. Prefer `KEYSTORE_PATH` (`npm run manage-keystore`) over `PRIVATE_KEY`.
4. Use a dedicated RPC. On a public node the free-tier caps slow everything down.
5. Set `JUPITER_POSITION_API_KEY` from a separate Jupiter organisation, so exits never compete
   with discovery for budget.
6. Run `DRY_RUN=true` once, to confirm quotes and balances work with the live wallet.

## Sessions, logs and data

Each run creates `logs/<paper-trading|live-trading>/<YYYY-MM-DD_HH-MM-SS>/`:

| File                                                | Contents                        |
| --------------------------------------------------- | ------------------------------- |
| `bot.log`                                           | Full log at every level         |
| `bot.db`                                            | SQLite session state (WAL mode) |
| `trade-journal.jsonl` / `paper-trade-journal.jsonl` | One line per closed trade       |
| `ghost-trade-journal.jsonl`                         | Ghost-trader trades (ML only)   |
| `scanned-memecoins.jsonl`                           | Scan decisions                  |
| `metrics.json`, `performance-stats.json`            | Session metrics                 |

`bot.db` tables:

| Table                        | Contents                                                 |
| ---------------------------- | -------------------------------------------------------- |
| `positions`                  | Open positions (full JSON)                               |
| `closed_trades`              | Realized trades (`is_ghost` separates ghost trades)      |
| `processed_mints`            | Mints already evaluated (dedupe)                         |
| `rechecks`                   | Pending survival, recheck and waitlist entries           |
| `snapshots`                  | Market snapshots                                         |
| `cooldowns`, `retired_mints` | Re-entry control                                         |
| `kv_store`, `metrics`        | Balances, counters, model state                          |
| `ml_training_samples`        | Labeled samples (also written to `data/ml-reservoir.db`) |

`data/ml-reservoir.db` is shared across sessions and imported into each new session at
startup. `STATE_FILE` pins one database across runs; use it only if you need to resume a
specific session.

When you inspect a DB while the bot is running, open it **read-only**. The bot retries on a
lock, but a writer holding the lock delays persistence.

## Reading the log

| Line                                                                    | Meaning                                                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `[SCAN] N items. pos, buys, skip, rchk, rej, err (Total: …ms)`          | One scan cycle: positions, buys, skips, rechecks, rejects, errors.                          |
| `[TRADE] PAPER buy SYMBOL (score N)`                                    | Entry.                                                                                      |
| `[TRADE] PAPER take-profit-1.3x on …`, `stop-loss`, `liquidity-exit`, … | Exit, with the rule that fired.                                                             |
| `Jupiter rate-limited (429); circuit OPEN for 30s`                      | The Jupiter breaker tripped; on-chain prices are in use.                                    |
| `getTokenLargestAccounts rate limited (429)`                            | The RPC capped the heavy method. The audit uses fallbacks and the token is rechecked later. |
| `[CONFIG] X is no longer read from .env`                                | Legacy key; move it to the strategy YAML.                                                   |
| `WebSocket … failed … Retrying in Ns`                                   | Reconnect with backoff.                                                                     |

## Offline tools

| Command                             | Input                                 | Output                                                        |
| ----------------------------------- | ------------------------------------- | ------------------------------------------------------------- |
| `npm run analyze-pnl <session dir>` | A session directory                   | Markdown PnL report                                           |
| `npm run fetch-data`                | Jupiter → DexScreener → GeckoTerminal | `logs/market-data/<ts>/`: 1-minute OHLCV per token + manifest |
| `npm run backtest`                  | Session DBs under `logs/`             | Entry-model AUC / precision / recall                          |
| `npm run optimizer`                 | `logs/**/trade-journal.jsonl`         | A new `strategies/<name>.yaml`                                |
| `npm run train-history`             | Session DBs + journals                | `ml-pretrained-weights.json`                                  |
| `npm run manage-keystore`           | —                                     | Create or inspect the encrypted wallet keystore               |

## Troubleshooting

**Exits fail with Jupiter 429**

- The Free tier allows 1 req/s per organisation, shared by every key in it.
- Fixes: move `JUPITER_POSITION_API_KEY` to a second organisation, or upgrade and raise
  `JUPITER_RPS`.
- Exits already take priority over discovery inside a bucket, and monitor prices fall back to
  on-chain reads while the position breaker is open.

**Frequent RPC 429s**

- Use a dedicated endpoint, or add one with an independent limit to `RPC_URL`.
- Set `RPC_TIER` and `RPC_RATE_LIMITS` to your plan's real numbers.
- Lower `scanParallelism*` and `maxConcurrentAudits` in your strategy.

**No tokens discovered**

- Check that the WebSocket subscriptions logged `subscription active`.
- If they keep reconnecting, the WebSocket endpoint is unhealthy; set `WS_RPC_URL` explicitly.

**Everything rejected**

- Check the `rej` counts and the rejection reasons in `scanned-memecoins.jsonl`.
- Thresholds may be too strict for current market conditions.
- Starvation relaxes the score gate automatically, but only down to `minCandidateScoreFloor`.

**Buying paused**

- The log names the cause: drawdown, loss-streak, expectancy or mood breaker.
- Each pause expires after its cooldown.

**`database is locked`**

- Another process has the DB open for writing. Open viewers read-only.

**Negative token ages**

- The system clock is behind. Resync it (`w32tm /resync` on Windows, or NTP).

**Strategy rejected at startup**

- The error names the bad key or type.
- An invalid non-standard strategy falls back to `standard`; an invalid `standard.yaml` stops
  startup.
