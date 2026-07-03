/**
 * Fetches 1-minute OHLCV candle data for the top-traded Solana tokens launched in the
 * last 24 hours with FDV >= $2k.  Data is written to logs/market-data/<timestamp>/ and
 * is suitable for backtesting and ML training.
 *
 * Usage:  npm run fetch-data
 *
 * APIs used (all free, no extra keys required):
 *  - Jupiter  /tokens/v2/toptraded/24h  — volume-ranked token list
 *  - DexScreener /latest/dex/tokens/{}  — pool address lookup
 *  - GeckoTerminal /api/v2/networks/solana/pools/{}/ohlcv/minute — OHLCV candles
 */

import fs from 'node:fs';
import path from 'node:path';
import { fetchJson } from '../src/core/utils/fetch.js';
import { sleep } from '../src/core/utils/io.js';

// --- .env loader (mirrors src/core/config.ts) --------------------------------

function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const k = trimmed.slice(0, eqIdx).trim();
      const v = trimmed
        .slice(eqIdx + 1)
        .trim()
        .replace(/^["'](.*)["']$/, '$1');
      if (k && !process.env[k]) process.env[k] = v;
    }
  } catch {}
}

loadDotEnv();

// --- Config ------------------------------------------------------------------

const CONFIG = {
  lookbackHours: 24,
  minMcapUsd: 2_000,
  limit: 100,
  interTokenDelayMs: 1_500, // between tokens
  poolLookupDelayMs: 500, // after DexScreener call
  paginationDelayMs: 1_000, // between GeckoTerminal page calls
  priceApiBatchDelayMs: 1_200, // between Jupiter price batches
  gtRateLimitBackoffMs: 30_000,
} as const;

const jupBase = (process.env['JUPITER_BASE_URL'] ?? 'https://api.jup.ag').replace(/\/$/, '');
const jupKey = process.env['JUPITER_API_KEY'] ?? '';
const jupHeaders: Record<string, string> = jupKey ? { 'x-api-key': jupKey } : {};

// --- Types -------------------------------------------------------------------

interface OhlcvCandle {
  timestamp: number; // Unix seconds, bar start
  open: number; // USD
  high: number;
  low: number;
  close: number;
  volume: number; // USD volume (from GeckoTerminal)
}

interface ManifestRecord {
  mint: string;
  symbol: string;
  name: string;
  fdvUsd: number;
  volume24hUsd: number;
  ageHours: number;
  fetchedAt: string;
  interval: '1m';
  lookbackHours: number;
  candleCount: number;
  source: 'geckoterminal';
  creator: string | null; // deployer wallet; null if not available from APIs
  outputFile: string;
}

interface ErrorRecord {
  mint: string;
  symbol: string;
  reason: string;
  timestamp: string;
}

interface Candidate {
  mint: string;
  symbol: string;
  name: string;
  fdvUsd: number;
  volume24hUsd: number;
  ageHours: number;
  firstPoolCreatedAt: string | number | undefined;
  creator: string | null; // deployer wallet address; null if unavailable
}

// Raw shape from Jupiter toptraded response
interface JupToken {
  id: string;
  symbol?: string;
  name?: string;
  fdvUsd?: number;
  marketCapUsd?: number;
  volume24h?: number;
  firstPool?: { createdAt: string | number };
  creator?: string; // wallet that deployed the token (present on some launchpads)
  mintAuthority?: string; // current mint authority (often null after renounce)
}

interface DexScreenerPair {
  pairAddress: string;
  chainId: string;
  info?: {
    socials?: unknown[];
    imageUrl?: string;
  };
  // Some responses include deployer/maker under non-standard keys
  maker?: string;
  deployer?: string;
}

interface DexScreenerResponse {
  pairs?: DexScreenerPair[] | null;
}

type OhlcvRow = [number, number, number, number, number, number];

interface GeckoTerminalResponse {
  data: {
    attributes: {
      ohlcv_list: OhlcvRow[];
    };
  };
}

// --- Helpers -----------------------------------------------------------------

function appendLine(filePath: string, data: unknown): void {
  fs.appendFileSync(filePath, JSON.stringify(data) + '\n', 'utf8');
}

function toAgeHours(createdAt: string | number | undefined, nowMs: number): number {
  if (createdAt === undefined || createdAt === null) return 9999;
  let ms: number;
  if (typeof createdAt === 'string') {
    ms = new Date(createdAt).getTime();
    if (isNaN(ms)) return 9999;
  } else {
    ms = createdAt > 1e12 ? createdAt : createdAt * 1000;
  }
  return (nowMs - ms) / (1000 * 3600);
}

function is429(err: unknown): boolean {
  return /\b429\b|too many requests/i.test(err instanceof Error ? err.message : String(err));
}

// --- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const nowMs = Date.now();
  const nowUnix = Math.floor(nowMs / 1000);
  const timeFrom = nowUnix - CONFIG.lookbackHours * 3600;

  const ts = new Date(nowMs).toISOString().replace('T', '_').slice(0, 19).replace(/:/g, '-');
  const outDir = path.join('logs', 'market-data', ts);
  fs.mkdirSync(outDir, { recursive: true });
  const manifestPath = path.join(outDir, 'manifest.jsonl');
  const errorsPath = path.join(outDir, 'errors.jsonl');

  console.log(`\nveloci-buy market data fetcher`);
  console.log(`Output : ${outDir}`);
  console.log(
    `Config : top ${CONFIG.limit} | FDV >= $${CONFIG.minMcapUsd.toLocaleString()} | age < 24h | 1m candles × 24h\n`
  );

  // ── Step 1: top-traded list ──────────────────────────────────────────────
  console.log('[1/3] Fetching top-traded tokens from Jupiter...');
  let rawTokens: JupToken[];
  try {
    const data = await fetchJson<JupToken[]>(`${jupBase}/tokens/v2/toptraded/24h`, {
      headers: jupHeaders,
      timeoutMs: 10_000,
      retries: 2,
    });
    if (!Array.isArray(data)) throw new Error('Unexpected toptraded response shape');
    rawTokens = data;
    console.log(`  ${rawTokens.length} tokens in feed.`);
  } catch (err) {
    console.error(`  FATAL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // ── Step 2: filter + sort ────────────────────────────────────────────────
  console.log('[2/3] Filtering by age and market cap...');
  const candidates: Candidate[] = [];

  for (const t of rawTokens) {
    if (!t?.id) continue;
    const fdv = t.fdvUsd ?? t.marketCapUsd ?? 0;
    if (fdv < CONFIG.minMcapUsd) continue;
    const age = toAgeHours(t.firstPool?.createdAt, nowMs);
    if (age > 24) continue;
    candidates.push({
      mint: t.id,
      symbol: t.symbol ?? t.id.slice(0, 8),
      name: t.name ?? t.symbol ?? t.id.slice(0, 8),
      fdvUsd: fdv,
      volume24hUsd: t.volume24h ?? 0,
      ageHours: Math.round(age * 10) / 10,
      firstPoolCreatedAt: t.firstPool?.createdAt,
      creator: t.creator ?? t.mintAuthority ?? null,
    });
  }

  // Sort by 24h volume descending, cap at limit
  candidates.sort((a, b) => b.volume24hUsd - a.volume24hUsd);
  const selected = candidates.slice(0, CONFIG.limit);
  console.log(`  ${selected.length} candidates selected after filtering.\n`);

  if (selected.length === 0) {
    console.log('No candidates found — try lowering --min-mcap or check Jupiter key.');
    process.exit(0);
  }

  // ── Step 3: fetch candles ────────────────────────────────────────────────
  console.log(`[3/3] Fetching 1m candles for ${selected.length} tokens...\n`);
  let fetched = 0;
  let errCount = 0;
  let totalCandles = 0;
  const startTime = Date.now();

  for (let idx = 0; idx < selected.length; idx++) {
    const token = selected[idx];
    if (!token) continue;
    const { mint, symbol } = token;
    const label = `[${idx + 1}/${selected.length}] ${symbol.padEnd(12)}`;

    // ── pool lookup (DexScreener) ──
    process.stdout.write(`${label} pool... `);
    let poolAddress: string | null;
    let resolvedCreator: string | null = token.creator;
    try {
      const ds = await fetchJson<DexScreenerResponse>(
        `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
        { timeoutMs: 8_000, retries: 1 }
      );
      const solanaPairs = (ds.pairs ?? []).filter((p) => p.chainId === 'solana');
      const topPair = solanaPairs[0];
      poolAddress = topPair?.pairAddress ?? null;
      // Pick up deployer from DexScreener if Jupiter didn't have it
      if (!resolvedCreator && topPair) {
        resolvedCreator = topPair.deployer ?? topPair.maker ?? null;
      }
    } catch (err) {
      const reason = `DexScreener failed: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`FAIL\n  ${reason}`);
      appendLine(errorsPath, {
        mint,
        symbol,
        reason,
        timestamp: new Date().toISOString(),
      } satisfies ErrorRecord);
      errCount++;
      await sleep(CONFIG.interTokenDelayMs);
      continue;
    }

    if (!poolAddress) {
      const reason = 'No Solana pool on DexScreener';
      console.error(`FAIL\n  ${reason}`);
      appendLine(errorsPath, {
        mint,
        symbol,
        reason,
        timestamp: new Date().toISOString(),
      } satisfies ErrorRecord);
      errCount++;
      await sleep(CONFIG.poolLookupDelayMs + CONFIG.interTokenDelayMs);
      continue;
    }

    await sleep(CONFIG.poolLookupDelayMs);
    process.stdout.write(`candles... `);

    // ── OHLCV fetch (GeckoTerminal, up to 3 pages of 1000 bars) ──
    const candles: OhlcvCandle[] = [];
    let beforeTs = nowUnix;
    let fetchFailed = false;

    for (let page = 0; page < 3 && candles.length < CONFIG.lookbackHours * 60; page++) {
      const gtUrl =
        `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}/ohlcv/minute` +
        `?aggregate=1&limit=1000&before_timestamp=${beforeTs}&currency=usd&token=base`;

      const tryFetch = async (): Promise<OhlcvRow[] | null> => {
        try {
          const resp = await fetchJson<GeckoTerminalResponse>(gtUrl, {
            timeoutMs: 15_000,
            retries: 0,
          });
          return resp.data?.attributes?.ohlcv_list ?? [];
        } catch (err) {
          if (is429(err)) {
            process.stdout.write('[429→30s] ');
            await sleep(CONFIG.gtRateLimitBackoffMs);
            // single retry after backoff
            const resp = await fetchJson<GeckoTerminalResponse>(gtUrl, {
              timeoutMs: 15_000,
              retries: 0,
            });
            return resp.data?.attributes?.ohlcv_list ?? [];
          }
          throw err;
        }
      };

      let rows: OhlcvRow[];
      try {
        const result = await tryFetch();
        if (result === null || result.length === 0) break;
        rows = result;
      } catch (err) {
        const reason = `GeckoTerminal failed: ${err instanceof Error ? err.message : String(err)}`;
        console.error(`FAIL\n  ${reason}`);
        appendLine(errorsPath, {
          mint,
          symbol,
          reason,
          timestamp: new Date().toISOString(),
        } satisfies ErrorRecord);
        fetchFailed = true;
        break;
      }

      for (const row of rows) {
        const [t, o, h, l, c, v] = row;
        if (t >= timeFrom) {
          candles.push({ timestamp: t, open: o, high: h, low: l, close: c, volume: v });
        }
      }

      // GeckoTerminal returns newest-first; oldest bar is last entry
      const lastRow = rows[rows.length - 1];
      if (!lastRow || lastRow[0] <= timeFrom) break;
      beforeTs = lastRow[0];

      if (page < 2) await sleep(CONFIG.paginationDelayMs);
    }

    if (fetchFailed) {
      errCount++;
      await sleep(CONFIG.interTokenDelayMs);
      continue;
    }

    if (candles.length === 0) {
      const reason = 'GeckoTerminal returned 0 candles in lookback window';
      console.error(`FAIL\n  ${reason}`);
      appendLine(errorsPath, {
        mint,
        symbol,
        reason,
        timestamp: new Date().toISOString(),
      } satisfies ErrorRecord);
      errCount++;
      await sleep(CONFIG.interTokenDelayMs);
      continue;
    }

    // Sort chronologically (GeckoTerminal returns newest-first)
    candles.sort((a, b) => a.timestamp - b.timestamp);

    // Write candle file
    const candleFile = path.join(outDir, `${mint}.jsonl`);
    for (const candle of candles) appendLine(candleFile, candle);

    // Append manifest record
    const record: ManifestRecord = {
      mint,
      symbol: token.symbol,
      name: token.name,
      fdvUsd: token.fdvUsd,
      volume24hUsd: token.volume24hUsd,
      ageHours: token.ageHours,
      fetchedAt: new Date().toISOString(),
      interval: '1m',
      lookbackHours: CONFIG.lookbackHours,
      candleCount: candles.length,
      source: 'geckoterminal',
      creator: resolvedCreator,
      outputFile: path.relative(process.cwd(), candleFile).replace(/\\/g, '/'),
    };
    appendLine(manifestPath, record);

    fetched++;
    totalCandles += candles.length;
    console.log(`${candles.length} candles`);

    if (idx < selected.length - 1) await sleep(CONFIG.interTokenDelayMs);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n─────────────────────────────────`);
  console.log(`  Fetched : ${fetched} tokens`);
  console.log(`  Failed  : ${errCount} tokens`);
  console.log(`  Candles : ${totalCandles.toLocaleString()}`);
  console.log(`  Time    : ${elapsed}s`);
  console.log(`  Output  : ${outDir}`);
  console.log(`─────────────────────────────────\n`);
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
