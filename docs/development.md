# Development

Everything needed to change the code safely. Read [architecture.md](architecture.md) first.

## Setup

```bash
npm install
cp .env.example .env      # RPC_URL, JUPITER_API_KEY and a wallet are enough for paper mode
npm test
npm start
```

**Requirements:**

- Node.js ≥ 20.19 (CI runs Node 24).
- A Rust toolchain only for the native ML addon: `npm run build:rust`, or
  `npm run build:rust:win` on Windows, which sets up MSVC. On Windows the "Desktop development
  with C++" Build Tools workload is required.

## Scripts

| Command                         | What it does                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `npm start`                     | Run from source (tsx). Add `-- --tui` for the terminal UI.                                |
| `npm test`                      | Full `node:test` suite                                                                    |
| `npm run test:update-snapshots` | Re-record snapshot files                                                                  |
| `npm run test:coverage`         | Tests with coverage                                                                       |
| `npm run typecheck`             | `tsc --noEmit` over `src`, `tests` and `scripts`                                          |
| `npm run lint` / `format`       | ESLint / Prettier                                                                         |
| `npm run build`                 | Compile `src` to `dist/`                                                                  |
| `npm run ci`                    | Syntax check, lint, format check, typecheck, build, tests (CI also builds the Rust addon) |

## Conventions

- **Services are functions of `ctx`.** There are no classes with hidden state beyond a few
  deliberate singletons: the Jupiter breakers, rate buckets, local market state and the
  token-account index.
- **State goes through `ctx.store`.** Never write `ctx.state` collections that need to persist
  without the matching store method.
- **Network calls go through the wrappers.**
  - RPC: `rpcCall(ctx, method, params, { priority, maxAttempts, cacheTtlMs })` in
    `core/utils/solana.ts`.
  - HTTP: `fetchJson(url, { rateLimit: { key, rps, priority }, retries, timeoutMs })` in
    `core/utils/fetch.ts`.
  - Never call `fetch` or an RPC client directly. Never retry a call that already retries
    inside its wrapper. See [rate-limits.md](rate-limits.md).
- **Priorities:**
  - `ULTRA_HIGH`: anything that moves money.
  - `HIGH`: position monitoring.
  - `MEDIUM`: accounting.
  - `LOW`: discovery, scanning and auditing.
- **Config:** tuning values belong in the strategy YAML; `.env` is for infrastructure only.
- **No secrets in logs.** Errors from the wrappers are already redacted; don't log raw URLs or
  headers yourself.
- **Style:** strict TypeScript (`noUncheckedIndexedAccess` included), ESLint and Prettier.
  Comment the _why_, not the _what_.

## Common changes

### Add a tuning knob

1. Add the field to `Config` in [src/types/config.ts](../src/types/config.ts).
2. Add the name to `TUNING_KEYS` in [src/core/tuning-keys.ts](../src/core/tuning-keys.ts).
3. Add the default to [strategies/standard.yaml](../strategies/standard.yaml), in the right
   section.
4. Read it as `ctx.config.yourKey`.
5. Document it in [configuration.md](configuration.md#strategy-reference).
6. Refresh the config snapshot: `npm run test:update-snapshots`, then review the diff.

The test config factory ([tests/factories/config.ts](../tests/factories/config.ts)) needs the
field too, or the typecheck fails.

### Add an infrastructure / `.env` setting

1. Add the field to `Config`.
2. Parse it in `builder.ts`, with `p.int` / `p.float` / `p.boolean` / `env.X || default`.
3. Add it to `.env.example` and the `.env` reference in [configuration.md](configuration.md).

### Add an exit rule

1. Create `src/services/monitor/exits/rules/<name>.ts` exporting an `ExitRule`. It receives the
   position, the current price, its age, signals and `readOnly`, and returns an `ExitDecision`
   or `null`.
2. Insert it into `defaultExitChain` in `exits/exit-chain.ts`. **Order matters:** earlier rules
   win.
3. If the rule mutates the position (arming a stop, say), do it only when `!readOnly`. The
   ghost trader replays the chain read-only.
4. Add the reason to `URGENCY_MAP` in `exit-executor.ts` if it needs a non-default urgency.
5. Add a test next to `tests/exit-calculator*.test.ts` and `tests/monitor*.test.ts`.

### Add an upstream API

1. Choose a bucket key and a budget (requests per second). Add a config key if users need to
   tune it.
2. Call it only through `fetchJson` with `rateLimit` and an explicit `retries`.
3. Decide what happens on 429 or timeout (soft-fail versus block) and document it in
   [rate-limits.md](rate-limits.md).

## Testing

- **Runner:** the built-in `node:test`, run through tsx. Test files are
  `tests/**/*.test.ts`.
- **Contexts:** use `createCtx(configOverrides, stateOverrides)` from
  [tests/\_test_helpers.ts](../tests/_test_helpers.ts).
  - It resets the process-wide Jupiter breakers and rate buckets, so tests don't leak state
    into each other.
  - The test config gives every bucket a very high budget, so tests never wait on rate limits.
    [tests/rate-limit.test.ts](../tests/rate-limit.test.ts) exercises real buckets.
- **Network:** `withMockedFetch(handler, fn)` swaps `fetch`. RPC calls are mocked through
  `ctx.rpc` / `ctx.rpcs`.
- **Factories:** `tests/factories/` covers config, positions and tokens.
- **Snapshots:** `*.test.ts.snapshot` files sit next to their tests. Keep machine-specific
  values (paths, timestamps) out of snapshots; `config-fields-snapshot.test.ts` shows the
  pattern.
- **Persistence:** tests create a temporary directory and call `requestShutdown()` in `finally`.

## CI

[.github/workflows/ci.yml](../.github/workflows/ci.yml) runs on every push and pull request:
`npm ci`, `npm audit`, the syntax check, lint, format, build, the Rust addon build, then tests.
Run `npm run ci` locally before pushing.

## Gotchas

- `#core/*`, `#services/*`, `#ml/*` and `#types/*` resolve to `src/`. `package.json` `imports`
  also points them at `dist/` for the compiled build. If you delete a module but a stale
  `dist/` still has it, the typecheck can silently resolve to the old `.d.ts`. Delete `dist/`
  when that happens.
- Files are LF. Prettier enforces this, so run `npm run format` if an editor converts line
  endings.
- Process-wide singletons (breakers, buckets, `localMarketState`, `tokenAccountIndex`) persist
  across tests in one file. Reset them, or build contexts with `createCtx`.
