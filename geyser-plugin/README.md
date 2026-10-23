# veloci-buy Geyser Plugin

A Solana Geyser plugin that streams account updates from a validator straight to
the bot over a Unix Domain Socket (Linux) or TCP (any OS), bypassing RPC polling
latency. It is **optional** — the bot runs fine without it and falls back to RPC.

> **Status: deferred build.** This crate is *not* compiled by `npm`/CI. It links
> against the validator's `agave-geyser-plugin-interface`, whose version must
> match the validator you deploy on, and it can only be meaningfully tested
> against a live validator. Build it on the validator host.

## Architecture

```
┌────────────┐   account updates    ┌──────────────────┐   NDJSON over     ┌──────────────┐
│  Validator │ ───────────────────▶ │  this plugin     │ ─ UDS/TCP socket ▶│   bot        │
│ (Agave)    │   (in-process)       │  (cdylib)        │                   │ GeyserClient │
└────────────┘                      └──────────────────┘                   └──────────────┘
```

The plugin is a **thin transport**: it forwards raw account bytes (base64) plus
metadata. Pool-specific decoding (bytes → price) lives in the bot
(`src/services/ingestion/geyser-client.ts`) because it is DEX-specific and
changes independently of the validator-side code.

## Build

On the validator host, with a Rust toolchain installed:

```bash
# 1. Pin agave-geyser-plugin-interface in Cargo.toml to your validator release.
# 2. Build the dynamic library.
cargo build --release
# Produces target/release/libveloci_geyser_plugin.{so,dylib} (or .dll on Windows).
```

## Deploy

1. Copy `config.example.json` to `config.json` and set `libpath` to the built
   library, plus either `socket_path` (Linux UDS) or `tcp_addr`.
2. Optionally restrict `owner_allowlist` to the DEX programs you trade (Raydium,
   pump.fun, …) to cut stream volume.
3. Start the validator with `--geyser-plugin-config /path/to/config.json`.

## Consume (bot side)

```bash
GEYSER_ENABLED=true GEYSER_TCP_ADDR=127.0.0.1:9123 npm start
# or, on the same Linux host as the validator:
GEYSER_ENABLED=true GEYSER_SOCKET_PATH=/tmp/veloci-geyser.sock npm start
```

If the stream is unavailable the bot logs a warning, reconnects with backoff, and
continues on RPC polling via `src/services/ingestion/geyser-client.ts:1`
(coordinated by `src/core/bot-internals/geyser-coordinator.ts:1`). The bot-side
`GeyserClient` + `localMarketState` consume the NDJSON frames as authoritative
`marketSnapshots` price updates. Ghost exits reuse the same `marketSnapshots` via `marketDataProvider` (`readOnly:true`) — never `upsertPosition`.
