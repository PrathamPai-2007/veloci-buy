# Changelog

## Unreleased

Commits made before this restructuring are prefixed `legacy-` in the history.

### Removed

- **Burst mode and the swing bot**, with their strategies, exit rules, config and tests. The
  bot is a single-strategy sniper. Previously open burst or swing positions load as `standard`
  and are managed by the sniper monitor.
- **React dashboard (`website/`) and its WebSocket API** (`api.service.ts`,
  `API_PORT` / `API_HOST` / `API_TOKEN`, `npm run dev`, `dev:all`). Use `npm start` or
  `npm start -- --tui`.
- **SQLite worker thread.** Writes are batched on the main thread, one transaction per
  `stateFlushIntervalMs`.
- **About 160 tuning environment variables** (see Configuration).

### Rate limiting

- **Priority token buckets** for every upstream (`src/core/utils/rate-limit.ts`):
  - `fetchJson` takes a token on every attempt, retries included.
  - A 429 halves the bucket's rate for 30 s.
- **Jupiter:**
  - One bucket per API key at `JUPITER_RPS` (Free tier: 1 req/s per organisation).
  - Exit swaps (`ULTRA_HIGH`) and monitor prices (`HIGH`) are served before discovery (`LOW`).
  - `/swap/v2/execute` has its own bucket and is never auto-retried.
  - Swaps use `JUPITER_POSITION_API_KEY`.
- **Jupiter circuit breakers:** discovery and position traffic have separate breakers. A 429
  opens a breaker immediately, replacing the old cooldown state fields.
- **Newly rate-limited upstreams:**
  - Jito (`JITO_RPS`, 1 req/s per IP).
  - RugCheck (`RUGCHECK_RPS`).
  - BubbleMaps (`BUBBLEMAPS_RPM`, 2 s timeout, no retries).
  - Telegram and Discord notifications.
- **RPC:**
  - The heavy-method slot (`getTokenLargestAccounts`, `getProgramAccounts`) is held for the
    whole call, with a 300 ms gap between calls.
  - A 429 penalizes that endpoint's bucket.
  - Identical cacheable reads share one in-flight request, and the response cache is bounded.
  - Abort listeners are cleaned up after each call.
- **Retry budgets:** on-chain auditor reads use a single retry budget instead of nested 3 × 3
  retries.
- **Priorities:** discovery `getTransaction` runs at `LOW` priority.
- **WebSocket reconnects** use exponential backoff with jitter (5 s → 60 s).
- **Secrets are scrubbed** from errors and logs: Telegram tokens, Discord webhook tokens, query
  strings and `api-key=` values.

### Configuration

- `.env` holds only endpoints, secrets, wallet, mode and rate budgets.
- `strategies/standard.yaml` holds every tuning default, and other strategy files merge over
  it. Unknown keys and wrong types fail at startup.
- Legacy tuning env keys are ignored with a warning that names the YAML key to use. Effective
  defaults are unchanged.
- `GEYSER_*` and `PUMP_FEE_RECIPIENT` are now read through config.

### Internals

- `src/types/index.ts` is split into `config`, `market`, `position`, `state`, `signals`,
  `context` and `solana` modules.
- Documentation has been rewritten from scratch (`docs/`).
