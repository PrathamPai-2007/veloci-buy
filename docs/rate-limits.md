# API Rate Limits Reference

Rate limits for every external API the bot calls. All figures are per-key unless noted.

---

## RugCheck.xyz

| Tier             | Limit      | Notes                                                |
| ---------------- | ---------- | ---------------------------------------------------- |
| Unauthenticated  | 10 req/min | Unusable at scan speed — bot will hit cap in seconds |
| Free account key | 60 req/min | Sufficient for normal operation                      |
| Paid plans       | Higher     | See https://rugcheck.xyz for current tiers           |

**Bot usage per token evaluated:**

- 1 call to `/tokens/{mint}/report` (heavy audit, parallel with BubbleMaps)
- Up to N calls to `/wallet/{addr}/risk` (one per unique top-holder owner)

**At 60 req/min:**

- Token reports: 60 tokens/min max, but heavy audit parallelism (`SCAN_PARALLELISM_HEAVY`) caps it at `SCAN_PARALLELISM_HEAVY` concurrent calls
- Wallet checks: up to 5 per token (one per top holder) — at `OWNER_AUDIT_PARALLELISM=2` concurrency
- Practical throughput with defaults: ~6–10 full audits/min before wallet checks consume budget

**429 behavior:** `fetchRugCheckSignals` logs a warning and returns `status: 'error'`. The engine treats this as a soft failure and continues with on-chain mint/freeze/concentration signals only. The token is not blocked solely because RugCheck failed.

**Recommendation:** Always set `RUGCHECK_API_KEY`. Free account key is sufficient for solo bots. If running multiple bot instances on the same key, reduce `SCAN_PARALLELISM_HEAVY` and `OWNER_AUDIT_PARALLELISM` proportionally.

---

## Jupiter

| Tier           | Limit                 | Notes                                                      |
| -------------- | --------------------- | ---------------------------------------------------------- |
| Free (default) | ~10 req/s per account | Shared across ALL calls from the same account, not per key |
| Paid           | Higher RPS            | See https://developers.jup.ag/docs/portal/rate-limits      |

**Critical:** Jupiter rate-limits per **account**, not per API key. Creating extra keys from the same account does NOT increase the limit.

**Bot usage:**

- Discovery: price fetches + token lookups + swap quotes
- Monitor: position price fetches (every `scanIntervalMs`, one per open position)
- Exit sells: swap quotes + transaction builds (latency-critical — a 429 here drops the exit)

**429 behavior (position price calls):** `jupiterPriceCooldownUntil` (or `jupiterPositionPriceCooldownUntil` for the position key) is set for ~30s. Bot leans on on-chain price fallback during the cooldown. Exit sells are not retried — a 429 on an exit drops it silently.

**Recommendation:** Register a **second Jupiter account** and set `JUPITER_POSITION_API_KEY` to isolate monitor/exit calls from discovery. This is the only free fix — separate accounts = separate rate-limit buckets.

| Key                        | Used for                                             |
| -------------------------- | ---------------------------------------------------- |
| `JUPITER_API_KEY`          | Discovery scans, trending feed, market price fetches |
| `JUPITER_POSITION_API_KEY` | Position monitor price fetches, exit swap builds     |

---

## BubbleMaps

| Tier | Limit                                       | Notes                                  |
| ---- | ------------------------------------------- | -------------------------------------- |
| Free | Not publicly listed; de-facto ~5–10 req/min | Often rate-limited or requires API key |
| Paid | Per plan                                    | See https://bubblemaps.io              |

**Bot usage per token:** 1 call to `/maps/solana/{mint}` (heavy audit). Wrapped in a 2-second `Promise.race` — if BubbleMaps doesn't respond within 2s the call is abandoned and the bot falls back to the on-chain top5 threshold (`maxTokenAccountTop5Pct - 10`).

**429 / timeout behavior:** Treated as soft failure. On-chain top5 fallback kicks in with a tighter `-10%` threshold (`bubblemaps-fail-safe-concentration` blocker). No retry.

**Recommendation:** BubbleMaps is optional. If absent (`BUBBLEMAPS_API_KEY` unset), the on-chain fallback runs unconditionally. Only add BubbleMaps if you have a paid key and need the clustering signal.

---

## Solana RPC

No hard external rate limit — depends entirely on the RPC provider and plan. The bot implements adaptive backpressure internally:

- `BACKPRESSURE_ERROR_RATE_THRESHOLD` (default 0.30): if >30% of recent RPC calls fail, concurrency is reduced by `PARALLELISM_MIN_FACTOR`
- `ERROR_RATE_WINDOW` (default 20): rolling window size for the error rate calculation
- `MINT_SIGNAL_MAX_ATTEMPTS` / `MINT_SIGNAL_RETRY_DELAY_MS`: retry budget for mint account lookups
- `RPC_INDEXING_RETRY_DELAY_MS`: wait before retrying on RPC indexing lag (token not yet confirmed)

**Recommendation:** Use a dedicated Solana RPC node (Helius, QuickNode, Alchemy) rather than public nodes. Public nodes apply aggressive rate limits that will interfere with heavy-audit parallelism.

**Internal rate limiting:** `rpcCall` gates outbound requests with a per-endpoint priority token bucket (10 req/s + 1 tx/s **per RPC_URL entry**, `src/core/utils/solana.ts`). Because buckets are keyed per pool index, **adding a second independent endpoint to `RPC_URL` raises aggregate throughput** (2 endpoints ≈ 20 req/s) in addition to giving `rpcCall` a healthy node to rotate to on a 429. Caveat: the two endpoints must have genuinely independent limits — listing the same provider/key twice issues 2× the rate against one key and earns 429s. Scan-path curve reads run at `LOW` priority so they yield the bucket to monitor/exit reads and buys.

**WebSocket Failover & Rotation:** The bot supports automatic WebSocket rotation for log discovery. If log subscriptions for tracked programs (pump.fun, Raydium, Meteora) fail to connect 3 times consecutively (e.g., due to rate limits or intermittent endpoint outages), the discovery service automatically rotates the active WebSocket connection to the next URL in the pool. To take full advantage of this, it is recommended to leave `WS_RPC_URL` blank so the bot can automatically derive a list of fallback WebSocket URLs from the `RPC_URL` endpoints.

**Burst mode requires a premium RPC.** Standard mode prices most tokens via Jupiter and barely touches the node. Burst mode targets fresh pump.fun mints that Jupiter cannot price, so 100% of pricing falls onto on-chain `getMultipleAccounts` bonding-curve reads (`batchFetchDirectMarketData`). Combined with burst's tight survival/recheck cadence, this bursts curve reads past what a public/free node allows per second — observed as repeated `getMultipleAccounts ... HTTP error (429)` and `Batch on-chain price fetch failed: 429`. A premium dedicated node absorbs this; a public node does not. If you must run burst on a tighter node, add independent comma-separated endpoints in `RPC_URL` to widen the aggregate bucket and let `rpcCall` rotate off a 429'd endpoint.

---

## Jito Block Engine

No hard rate limit on bundle submission for normal usage. The `JITO_CONFIRM_TIMEOUT_MS` (default 30s) and `JITO_BUNDLE_RETRY_ATTEMPTS` (default 3) control retries on unconfirmed bundles. Tip floor is fetched once per bundle via `getTipFloor` — not rate-limited in practice.

---

## Summary Table

| API                     | Hard limit            | 429 on exit?               | Mandatory?                     |
| ----------------------- | --------------------- | -------------------------- | ------------------------------ |
| RugCheck                | 60 req/min (free key) | No (soft fail)             | **Yes**                        |
| Jupiter (discovery)     | ~10 req/s / account   | N/A                        | Yes                            |
| Jupiter (position/exit) | ~10 req/s / account   | **Yes — exits dropped**    | Recommended                    |
| BubbleMaps              | ~5–10 req/min         | No (2s timeout + fallback) | No                             |
| Solana RPC              | Provider-dependent    | No (backpressure)          | Yes                            |
| Jito                    | Generous              | No                         | No (USE_JITO=false to disable) |
