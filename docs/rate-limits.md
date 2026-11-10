# Rate limits

Every outbound call goes through a **priority token bucket** (`src/core/utils/rate-limit.ts`).
HTTP calls take a token on **every attempt**, retries included (`fetchJson({ rateLimit })`).
RPC calls take one in `rpcCall`. When a bucket's upstream answers 429, the bucket halves its rate
for 30 s, or for the `Retry-After` the server sent (capped at 2 min).

Priorities, highest first: `ULTRA_HIGH` (swap orders, Jito sends) → `HIGH` (monitor/exit
prices) → `MEDIUM` → `LOW` (discovery, scans, audits, notifications). A waiting exit is always
served before queued scan traffic in the same bucket.

| Upstream                                         | Bucket key                | Default budget             | Config                                       |
| ------------------------------------------------ | ------------------------- | -------------------------- | -------------------------------------------- |
| Jupiter (per API key)                            | `jup:<apiKey>`            | 1 req/s                    | `JUPITER_RPS`                                |
| Jupiter `/swap/v2/execute`                       | `jup-execute:<apiKey>`    | 50 req/s (separate bucket) | —                                            |
| RugCheck                                         | `rugcheck`                | 1 req/s                    | `RUGCHECK_RPS`                               |
| BubbleMaps                                       | `bubblemaps`              | 6 req/min                  | `BUBBLEMAPS_RPM`                             |
| Jito block engine                                | `jito`                    | 1 req/s                    | `JITO_RPS`                                   |
| Telegram / Discord                               | `notify:telegram/discord` | 1 req/s / 0.5 req/s        | —                                            |
| Solana RPC (per `RPC_URL`)                       | per pool index            | tier-based, see below      | `RPC_RATE_LIMITS`, `RPC_SEND_TX_RATE_LIMITS` |
| `getTokenLargestAccounts` / `getProgramAccounts` | single slot               | 1 in flight, 300 ms gap    | —                                            |

---

## Jupiter

- **Free tier: 1 req/s (60/min, sliding window) per organisation**, not per key. Price, Tokens
  and Swap requests all share that bucket. Only `/swap/v2/execute` has its own (50 req/s).
  Source: developers.jup.ag/docs/api-rate-limit.
- **Keys and priorities:**
  - `JUPITER_API_KEY` covers discovery: the recent and trending feeds and scan-path prices, at
    `LOW` priority.
  - `JUPITER_POSITION_API_KEY` covers monitor prices (`HIGH`), SOL/USD accounting (`MEDIUM`), and
    swap orders and SDK quotes (`ULTRA_HIGH`).
- **Two keys from the same Jupiter organisation still share one upstream limit.** Locally they
  get separate buckets, so set `JUPITER_RPS` to your plan's rate divided by the number of keys.
  For truly isolated budgets, use a key from a second organisation.
- **Circuit breakers:** there are two, `jupiterDiscoveryBreaker` and `jupiterPositionBreaker`,
  so discovery failures never suppress position pricing.
  - Three consecutive failures open a breaker for 60 s.
  - A 429 opens it immediately for 30 s, or for the server's `Retry-After` when it sends one.
  - After the cooldown, a single probe call decides whether it closes.
  - While a breaker is open, prices come from on-chain curve reads.
- **Retries:**
  - `/swap/v2/order` is retried once.
  - `/swap/v2/execute` is **never** auto-retried, because a signed transaction can still land
    after a timeout.
  - Price and feed calls use `retries: 0`.
- **Position pricing is one Jupiter batch plus one on-chain batch** (a single
  `getMultipleAccounts` for every pump curve). There is no per-mint Jupiter retry after a batch
  failure: N single calls on the same 1 req/s bucket fail the same way and only starve exits.
  Mints still unpriced fall back to local market state.
- **Fresh local prices skip the network.** Pump.fun `TradeEvent`s from the program-log
  subscription keep price, liquidity and the trade tape current for watched mints, so the scan
  pre-fetch and the monitor only call out for mints with no recent local trade.
- **Graduated tokens** (curve complete, 0 real SOL) are priced by Jupiter, not the empty curve.

## RugCheck

The free account key allows 60 req/min, so the bucket runs at 1 req/s. The token report and
wallet-risk checks share that budget and use `retries: 0`. Wallet risk levels are cached for
10 minutes per address (failures are never cached), so recurring insiders cost one call.

On a failure, `fetchRugCheckSignals` returns `status: 'error'`. The engine then continues with
on-chain mint, freeze and concentration signals only.

## BubbleMaps

BubbleMaps is optional and only used when `BUBBLEMAPS_API_KEY` is set. It has no published
limit, so the bucket defaults to 6 req/min. Calls use a 2 s timeout and `retries: 0`. On a
timeout or error, the on-chain top-5 concentration fallback applies.

## Jito block engine

The default limit is **1 req/s per IP per region**, for all methods (docs.jito.wtf). `sendBundle`
(`ULTRA_HIGH`), `getBundleStatuses` (`MEDIUM`) and the tip floor (`LOW`) share the `jito`
bucket. `sendBundle` uses `retries: 0`: the executor's own attempt loop rebuilds and resends.

## Solana RPC

`rpcCall` (`src/core/utils/solana.ts`) keeps one bucket per `RPC_URL` entry. The tier is
auto-detected or set with `RPC_TIER=premium,free`:

| Tier                    | Default               |
| ----------------------- | --------------------- |
| public/free             | ≈5 req/s, 1 sendTx/s  |
| Helius Free and similar | ≈10 req/s, 1 sendTx/s |

Override them with `RPC_RATE_LIMITS` (e.g. `50,5`) and `RPC_SEND_TX_RATE_LIMITS`.

- **Sharding:** `HIGH`, `ULTRA_HIGH` and `MEDIUM` calls prefer premium endpoints; `LOW` calls
  (scans, discovery `getTransaction`) prefer free ones.
- **Endpoint choice:** within the preferred tier, each call goes to the endpoint whose bucket
  would grant it soonest (ties rotate), not strict round-robin. `LOW` calls may spill onto a
  premium endpoint only while the free tier is backed up and that premium bucket has no waiters.
- **Multiple endpoints:** only list endpoints with independent limits. The same key listed twice
  will 429.
- **429 handling:** a 429 penalizes that endpoint's bucket for 30 s and rotates the call to
  another healthy endpoint.
- **Quarantine:** an endpoint with 3 consecutive errors is skipped for 60 s.
- **Single-flight reads:** identical cacheable reads (`cacheTtlMs > 0`) share one in-flight
  request. The response cache holds at most 5,000 entries.

### Heavy methods (`getTokenLargestAccounts`, `getProgramAccounts`)

> [!CAUTION]
> Do not remove this pacing. Providers cap these methods at 2–5 req/s, and unpaced bursts cause
> 429 retry storms that stall the scan loop for 15–20 s.

- `withHeavySlot` allows **one heavy call in flight**. The slot is held until the call settles,
  and the next call starts at least 300 ms later.
- The request timeout starts when the call is sent, not while it is queued for the slot.
- Holder snapshots (`getTokenLargestAccounts`) queue by priority: a final audit about to buy is
  served before queued scan-side lookups.
- **One retry budget per call.** The on-chain auditor calls `rpcCall` with `maxAttempts: 1`
  inside its own `MINT_SIGNAL_MAX_ATTEMPTS` loop, which also absorbs RPC indexing lag. Nested
  loops of 3 × 3 = 9 retries are gone.

## WebSockets

When a log subscription or the heartbeat fails, it reconnects with exponential backoff and ±20%
jitter (5 s → 60 s cap). The backoff resets once the stream delivers an event. After three
consecutive failures the subscription pool rotates to the next WebSocket URL. Leave `WS_RPC_URL`
blank to derive one URL per `RPC_URL` entry.

## Secrets in logs

`redactUrl` scrubs every fetch and RPC error message before it is thrown or logged. It removes
query strings, Telegram `/bot<token>`, Discord webhook tokens and `api-key=` values.
