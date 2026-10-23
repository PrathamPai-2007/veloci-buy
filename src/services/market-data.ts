import {
  fetchJson,
  isRateLimitError,
  rpcCall,
  decodePumpCurve,
  PRIORITY,
  runBoundedPool,
  jupiterRateLimit,
} from '../core/utils.js';
import { PUMP_FUN_PROGRAM_ID } from '../core/config.js';
import { address, getProgramDerivedAddress, getAddressEncoder } from '@solana/addresses';
import * as engine from './engine/engine.service.js';
import * as trading from './trading/trading.service.js';
import { Context, TokenMetadata } from '../types/index.js';
import { localMarketState, priceHistoryEngine, marketDataProvider } from './market-state/index.js';
import { jupiterDiscoveryBreaker, jupiterPositionBreaker } from './jupiter-circuit-breaker.js';

const PUMP_FUN_CURVE_SEED = 'bonding-curve';

export type DirectMarketData = {
  usdPrice: number;
  liquidity: number;
  isCompleted: boolean;
  source: string;
};

const PUMP_CURVE_CACHE_TTL_MS = 2000;
const pumpCurveMicroCache = new Map<string, { data: DirectMarketData; fetchedAt: number }>();

export function invalidatePumpCurveCache(mint: string): void {
  pumpCurveMicroCache.delete(mint);
}

/**
 * Fetches recent token launches from Jupiter API.
 * @param ctx - The application context.
 * @returns Array of recent token metadata.
 */
export async function fetchRecentLaunches(ctx: Context): Promise<TokenMetadata[]> {
  const url = `${ctx.config.jupiterBaseUrl}/tokens/v2/recent`;
  return jupiterDiscoveryBreaker.execute<TokenMetadata[]>(ctx, async () => {
    const data = (await fetchJson(url, {
      headers: { 'x-api-key': ctx.config.jupiterApiKey },
      timeoutMs: 5000,
      retries: 0,
      rateLimit: jupiterRateLimit(ctx, ctx.config.jupiterApiKey, PRIORITY.LOW),
    })) as TokenMetadata[];
    if (!Array.isArray(data)) throw new Error('Unexpected Jupiter recent response shape.');
    return data.filter(
      (t) =>
        t?.id && (t.launchpad === 'pump.fun' || !t.launchpad || t.id.toLowerCase().endsWith('pump'))
    );
  }, []);
}

/**
 * Fetches the current "trending" set from Jupiter's top-traded feed and narrows it to
 * pump.fun tokens. Unlike `fetchRecentLaunches` (which surfaces *new* mints), this ranks by
 * trading activity, so it returns the coins the crowd is actually buying. Each survivor is
 * tagged `isTrending` so downstream stages can prioritise it and apply relaxed entry guards.
 * @param ctx - The application context.
 * @returns Array of pump.fun trending token metadata.
 */
export async function fetchTrendingLaunches(ctx: Context): Promise<TokenMetadata[]> {
  const interval = ctx.config.trendingInterval || '5m';
  const url = `${ctx.config.jupiterBaseUrl}/tokens/v2/toptraded/${encodeURIComponent(interval)}`;
  return jupiterDiscoveryBreaker.execute<TokenMetadata[]>(ctx, async () => {
    const data = (await fetchJson(url, {
      headers: { 'x-api-key': ctx.config.jupiterApiKey },
      timeoutMs: 5000,
      retries: 0,
      rateLimit: jupiterRateLimit(ctx, ctx.config.jupiterApiKey, PRIORITY.LOW),
    })) as TokenMetadata[];
    if (!Array.isArray(data)) throw new Error('Unexpected Jupiter toptraded response shape.');
    return data
      .filter((t) => t?.id && (t.launchpad === 'pump.fun' || t.id.toLowerCase().endsWith('pump')))
      .map((t) => ({ ...t, launchpad: t.launchpad || 'pump.fun', isTrending: true }));
  }, []);
}

/**
 * Fetches market data (price, liquidity) directly from on-chain RPC for supported launchpads (e.g., Pump.fun).
 * This acts as a high-speed fallback when Jupiter API is lagging.
 * @param ctx - The application context.
 * @param mint - Token mint address.
 * @param launchpadName - Optional launchpad hint.
 */
export async function fetchDirectMarketData(
  ctx: Context,
  mint: string,
  launchpadName: string | null = null
): Promise<DirectMarketData | null> {
  const cached = pumpCurveMicroCache.get(mint);
  if (cached && Date.now() - cached.fetchedAt < PUMP_CURVE_CACHE_TTL_MS) {
    return cached.data;
  }

  let effectiveLaunchpad = launchpadName || ctx.state.marketSnapshots.get(mint)?.launchpad;
  if (!effectiveLaunchpad || effectiveLaunchpad === 'unknown') {
    if (mint.toLowerCase().endsWith('pump')) {
      effectiveLaunchpad = 'pump.fun';
    }
  }

  const launchpad = engine.getLaunchpadProfile(effectiveLaunchpad || 'pump.fun');
  if (launchpad.name !== 'pump.fun') return null;

  try {
    const programId = address(PUMP_FUN_PROGRAM_ID);
    const mintAddress = address(mint);
    const [curveAddress] = await getProgramDerivedAddress({
      programAddress: programId,
      seeds: [Buffer.from(PUMP_FUN_CURVE_SEED, 'utf8'), getAddressEncoder().encode(mintAddress)],
    });

    const account = (await rpcCall(
      ctx,
      'getAccountInfo',
      [
        curveAddress,
        {
          encoding: 'base64',
          commitment: 'confirmed',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ],
      { priority: PRIORITY.MEDIUM, cacheTtlMs: 5000 }
    )) as { value: { data: string[] } | null };

    const data = account.value?.data;
    if (!data || !Array.isArray(data) || !data[0]) return null;
    const curve = decodePumpCurve(Buffer.from(data[0], 'base64'));
    if (!curve) return null;

    const solPrice = await trading.estimateSolUsdValue(ctx, 1000000000n);
    const virtualSolReserves = Number(curve.virtualSolReserves) / 1e9;
    const virtualTokenReserves = Number(curve.virtualTokenReserves) / 1e6;
    if (virtualTokenReserves === 0 || virtualSolReserves === 0) return null;
    const usdPrice = (virtualSolReserves / virtualTokenReserves) * solPrice;

    const realSolReserves = Number(curve.realSolReserves) / 1e9;
    const liquidity = realSolReserves * 2 * solPrice;

    const result = {
      usdPrice,
      liquidity,
      isCompleted: curve.isCompleted,
      source: 'rpc-direct',
    };
    pumpCurveMicroCache.set(mint, { data: result, fetchedAt: Date.now() });
    return result;
  } catch (e: unknown) {
    ctx.logger(
      `Direct RPC market data fetch failed for ${mint}: ${e instanceof Error ? e.message : String(e)}`,
      'debug'
    );
    return null;
  }
}

/**
 * Batch variant of fetchDirectMarketData. Derives all pump.fun curve PDAs locally, then fetches
 * all accounts in a single getMultipleAccounts call at LOW priority (candidates, not positions).
 * Reduces N individual getAccountInfo calls to 1 RPC call per scan batch.
 */
export async function batchFetchDirectMarketData(
  ctx: Context,
  mints: string[],
  signal?: AbortSignal
): Promise<Record<string, DirectMarketData>> {
  try {
    const now = Date.now();
    const result: Record<string, DirectMarketData> = {};
    const missingMints: string[] = [];

    for (const m of mints) {
      const isPump =
        m.toLowerCase().endsWith('pump') ||
        ctx.state.marketSnapshots.get(m)?.launchpad === 'pump.fun';
      if (!isPump) continue;
      const cached = pumpCurveMicroCache.get(m);
      if (cached && now - cached.fetchedAt < PUMP_CURVE_CACHE_TTL_MS) {
        result[m] = cached.data;
      } else {
        missingMints.push(m);
      }
    }

    if (missingMints.length === 0) return result;

    const pumpMints = missingMints;

    const programId = address(PUMP_FUN_PROGRAM_ID);
    const encoder = getAddressEncoder();

    const pdasWithMints = (
      await Promise.allSettled(
        pumpMints.map(async (mint) => {
          const [curveAddress] = await getProgramDerivedAddress({
            programAddress: programId,
            seeds: [Buffer.from(PUMP_FUN_CURVE_SEED, 'utf8'), encoder.encode(address(mint))],
          });
          return { mint, curveAddress };
        })
      )
    )
      .filter(
        (
          r
        ): r is PromiseFulfilledResult<{
          mint: string;
          curveAddress: ReturnType<typeof address>;
        }> => r.status === 'fulfilled'
      )
      .map((r) => r.value);

    const solPrice = await trading.estimateSolUsdValue(ctx, 1000000000n);

    // ponytail: parallel chunks — sequential loop was the bottleneck (N chunks × 12s RPC timeout
    // = scan watchdog hits at 60s on WS bursts). Token bucket in rpcCall still rate-limits.
    const chunkSize = 25;
    const chunks: (typeof pdasWithMints)[] = [];
    for (let i = 0; i < pdasWithMints.length; i += chunkSize) {
      chunks.push(pdasWithMints.slice(i, i + chunkSize));
    }

    // Fresh pump.fun mints are priced only through these curve reads (Jupiter can't price them);
    // clustered scans can 429 a public node. See docs/rate-limits.md (Solana RPC section).
    const chunkResults = await Promise.allSettled(
      chunks.map(async (chunk) => {
        const res = (await rpcCall(
          ctx,
          'getMultipleAccounts',
          [
            chunk.map((p) => p.curveAddress),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { encoding: 'base64', commitment: 'confirmed' } as any,
          ],
          // Tighter than the rpcCall defaults (12s × 3 = 36s): on a slow/degraded RPC the full
          // retry budget here stacked with the SOL-price fetch blew the 60s scan watchdog. 8s × 2
          // = 16s worst case keeps the scan pre-fetch under budget. Candidates are scan-side, not
          // positions — a missed price just defers the buy one cycle.
          { priority: PRIORITY.LOW, timeoutMs: 8000, maxAttempts: 2, signal }
        )) as { value: Array<{ data: string[] } | null> };

        const partial: Record<string, DirectMarketData> = {};
        if (!res?.value) return partial;

        for (let j = 0; j < chunk.length; j++) {
          const entry = chunk[j];
          if (!entry) continue;
          const { mint } = entry;
          const account = res.value[j];
          if (!account?.data?.[0]) continue;
          const curve = decodePumpCurve(Buffer.from(account.data[0], 'base64'));
          if (!curve) continue;
          const vToken = Number(curve.virtualTokenReserves) / 1e6;
          if (vToken === 0) continue;
          const vSol = Number(curve.virtualSolReserves) / 1e9;
          const resData = {
            usdPrice: (vSol / vToken) * solPrice,
            liquidity: (Number(curve.realSolReserves) / 1e9) * 2 * solPrice,
            isCompleted: curve.isCompleted,
            source: 'rpc-direct',
          };
          partial[mint] = resData;
          pumpCurveMicroCache.set(mint, { data: resData, fetchedAt: Date.now() });
        }
        return partial;
      })
    );

    for (const r of chunkResults) {
      if (r.status === 'fulfilled') Object.assign(result, r.value);
    }

    return result;
  } catch (err) {
    ctx.logger(
      `Batch on-chain price fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      'warn'
    );
    return {};
  }
}

/**
 * Fetches current prices for a batch of mints from Jupiter V3 Price API.
 * @param ctx - The application context.
 * @param mints - Array of mint addresses.
 * @param apiKey - Optional API key override.
 */
export async function fetchPrices(
  ctx: Context,
  mints: string[],
  apiKey: string | null = null
): Promise<Record<string, { usdPrice: number; [key: string]: unknown }>> {
  if (mints.length === 0) return {};

  // Position-key calls (monitor/exits) use their own breaker and a higher-priority slot in
  // the key's bucket, so discovery failures or load never starve position pricing.
  const isPositionKey = apiKey != null && apiKey === ctx.config.jupiterPositionApiKey;
  const breaker = isPositionKey ? jupiterPositionBreaker : jupiterDiscoveryBreaker;
  const key = apiKey || ctx.config.jupiterApiKey;

  const { allowed } = breaker.canExecute(ctx);
  if (!allowed) return {};

  breaker.recordRequest(ctx);
  const url = `${ctx.config.jupiterBaseUrl}/price/v3?ids=${encodeURIComponent(mints.join(','))}`;

  try {
    const response = (await fetchJson(url, {
      headers: { 'x-api-key': key },
      timeoutMs: 1500,
      retries: 0,
      rateLimit: jupiterRateLimit(ctx, key, isPositionKey ? PRIORITY.HIGH : PRIORITY.LOW),
    })) as { data?: Record<string, { usdPrice?: number; price?: number; [key: string]: unknown }> };

    breaker.recordSuccess(ctx);

    const priceMap = (response?.data ?? response) as Record<
      string,
      { usdPrice?: number; price?: number; [key: string]: unknown }
    >;
    if (!priceMap || typeof priceMap !== 'object') return {};

    const normalized: Record<string, { usdPrice: number; [key: string]: unknown }> = {};
    for (const [id, record] of Object.entries(priceMap)) {
      if (record) {
        normalized[id] = {
          ...record,
          source: 'jupiter-price-api',
          usdPrice: Number(record.usdPrice || record.price || 0),
        };
      }
    }
    return normalized;
  } catch (e: unknown) {
    breaker.recordFailure(ctx, e);
    if (!isRateLimitError(e)) {
      ctx.logger(
        `Jupiter price fetch failed: ${e instanceof Error ? e.message : String(e)}`,
        'warn'
      );
    }
    return {};
  }
}

/**
 * Whether a mint is a pump.fun bonding-curve token, by suffix convention or a known snapshot tag.
 * Mirrors the classification in {@link fetchDirectMarketData} — pump mints are priced from the
 * on-chain curve, so the scan path can skip Jupiter for them entirely.
 */
function isPumpMint(ctx: Context, mint: string): boolean {
  if (mint.toLowerCase().endsWith('pump')) return true;
  return ctx.state.marketSnapshots.get(mint)?.launchpad === 'pump.fun';
}

type PriceMap = Record<string, { usdPrice: number; [key: string]: unknown }>;

/**
 * Scan-path partition rule: which mints still warrant a Jupiter call after the on-chain curve pass.
 * A mint qualifies only if the curve left it unpriced AND it is not a pump.fun token (Jupiter can't
 * price fresh pump mints, so asking is pure 429 fuel — they're skipped until the curve fills).
 * Pure and exported so the rule that governs scan-side Jupiter volume is unit-testable.
 */
export function selectScanJupiterMints(ctx: Context, mints: string[], prices: PriceMap): string[] {
  return mints.filter((m) => (!prices[m] || !(prices[m].usdPrice > 0)) && !isPumpMint(ctx, m));
}

/** Merges on-chain curve results into `prices` (price wins over a zero from Jupiter). Returns the
 *  number of mints the curve priced. */
function mergeOnChainResults(
  prices: PriceMap,
  onChainResults: { status: string; value?: unknown; item: string }[]
): number {
  let directCount = 0;
  for (const result of onChainResults) {
    if (result.status === 'fulfilled' && result.value) {
      const mint = result.item;
      const directData = (result.value as PriceMap)[mint];
      if (directData) {
        directCount++;
        if (prices[mint]) {
          prices[mint] = {
            ...prices[mint],
            ...directData,
            usdPrice: directData.usdPrice > 0 ? directData.usdPrice : prices[mint].usdPrice,
          };
        } else {
          prices[mint] = directData;
        }
      }
    }
  }
  return directCount;
}

/**
 * Fetches prices with a hybrid approach: Jupiter API + Direct RPC Fallback.
 * This ensures high availability and accuracy for volatile tokens.
 * @param ctx - The application context.
 * @param mints - Array of mint addresses to refresh.
 * @param contextLabel - Label for logging context.
 * @param apiKey - Optional API key override.
 * @param opts - `onChainFirst` (scan path): price pump mints from the bonding curve and reserve
 *   Jupiter for the non-pump residual only. Avoids spending scan-key Jupiter requests on fresh
 *   pump mints Jupiter can't price — the dominant source of scan-side 429s.
 */
export async function fetchPricesBestEffort(
  ctx: Context,
  mints: string[],
  contextLabel = 'price refresh',
  apiKey: string | null = null,
  opts: { onChainFirst?: boolean; signal?: AbortSignal } = {}
): Promise<Record<string, { usdPrice: number; [key: string]: unknown }>> {
  const uniqueMints = [...new Set(mints.filter(Boolean))];
  if (uniqueMints.length === 0) return {};
  const startedAt = Date.now();
  const key = apiKey || ctx.config.jupiterApiKey;

  const runOnChain = (list: string[]) =>
    runBoundedPool(
      list,
      async (mint) => {
        const direct = await fetchDirectMarketData(ctx, mint);
        return direct ? { [mint]: direct } : null;
      },
      { concurrency: ctx.config.priceFallbackParallelism || 5 }
    );

  const prices: PriceMap = {};
  let apiResult: PriceMap = {};
  let directCount: number;
  let fallbackCount: number;

  if (opts.onChainFirst) {
    // Curve-first: pump mints get their canonical on-chain price; Jupiter is used only for the
    // non-pump residual it can actually price. Batch pump.fun curve reads into one
    // getMultipleAccounts call (LOW priority) instead of N individual getAccountInfo calls,
    // preventing RPC burst 429s during scan.
    const batchResult = await batchFetchDirectMarketData(ctx, uniqueMints, opts.signal);
    const batchAsList = Object.entries(batchResult).map(([m, d]) => ({
      status: 'fulfilled' as const,
      value: { [m]: d },
      item: m,
    }));
    directCount = mergeOnChainResults(prices, batchAsList);
    // We know these are pump.fun even though the curve fallback doesn't return a launchpad tag;
    // record it so skipping Jupiter doesn't downgrade the snapshot to 'unknown'.
    for (const mint of uniqueMints) {
      if (
        prices[mint] &&
        prices[mint].usdPrice > 0 &&
        !prices[mint].launchpad &&
        isPumpMint(ctx, mint)
      ) {
        prices[mint] = { ...prices[mint], launchpad: 'pump.fun' };
      }
    }
    const jupiterMints = selectScanJupiterMints(ctx, uniqueMints, prices);
    fallbackCount = jupiterMints.length;
    if (jupiterMints.length > 0) {
      apiResult = await fetchPrices(ctx, jupiterMints, key);
      for (const [mint, rec] of Object.entries(apiResult)) {
        if (rec && (!prices[mint] || !(prices[mint].usdPrice > 0))) prices[mint] = rec;
      }
    }
  } else {
    // Default (monitor/position path): Jupiter batch + on-chain in parallel, then a per-mint
    // Jupiter fan-out for anything still missing. Higher Jupiter volume, but this path runs on the
    // separate position API key and needs Jupiter for graduated tokens the curve can't price.
    const [api, onChainResults] = await Promise.all([
      fetchPrices(ctx, uniqueMints, key),
      runOnChain(uniqueMints),
    ]);
    apiResult = api;
    Object.assign(prices, apiResult);
    directCount = mergeOnChainResults(prices, onChainResults);

    const stillMissingMints = uniqueMints.filter((m) => !prices[m] || !(prices[m].usdPrice > 0));
    fallbackCount = stillMissingMints.length;
    if (stillMissingMints.length > 0) {
      const fallbackResults = await runBoundedPool(
        stillMissingMints,
        async (mint) => fetchPrices(ctx, [mint], key),
        { concurrency: ctx.config.priceFallbackParallelism || 1 }
      );
      for (const r of fallbackResults) {
        if (r.status === 'fulfilled' && r.value) {
          Object.assign(prices, r.value);
        }
      }
    }
  }

  // Sync all resolved prices into Local Market State Store & Price History Engine
  const now = Date.now();
  for (const [mint, rec] of Object.entries(prices)) {
    if (rec && rec.usdPrice > 0) {
      priceHistoryEngine.pushPrice(mint, 0, rec.usdPrice, now);
      const existingSnap = localMarketState.getSnapshot(mint);
      localMarketState.updateSnapshot({
        mint,
        venue:
          (rec.launchpad as 'pumpfun' | 'raydium' | 'meteora') || existingSnap?.venue || 'pumpfun',
        priceUsd: rec.usdPrice,
        liquidityUsd: Number(rec.liquidity || existingSnap?.liquidityUsd || 0),
        fdvUsd: Number(rec.fdvUsd || existingSnap?.fdvUsd || 0),
        totalSupply: existingSnap?.totalSupply ?? 1_000_000_000_000_000n,
        updatedAt: now,
        sourceSlot: 0,
        buyVolume1m: existingSnap?.buyVolume1m ?? 0,
        sellVolume1m: existingSnap?.sellVolume1m ?? 0,
        tradeCount1m: existingSnap?.tradeCount1m ?? 0,
        top5ConcentrationPct: existingSnap?.top5ConcentrationPct ?? 0,
        top10ConcentrationPct: existingSnapshotTop10(existingSnap),
        holderCount: existingSnap?.holderCount ?? 0,
        source: String(rec.source || 'market-data-fetch'),
        status: 'authoritative',
      });
    }
  }

  // Local state fallback for any mints still unpriced after network attempts
  for (const mint of uniqueMints) {
    if (!prices[mint] || !(prices[mint].usdPrice > 0)) {
      const localPrice = marketDataProvider.getPrice(mint);
      if (localPrice != null && localPrice > 0) {
        prices[mint] = { usdPrice: localPrice, source: 'local-market-state' };
      }
    }
  }

  const duration = Date.now() - startedAt;
  if (duration > 2000) {
    ctx.logger(
      `Slow ${contextLabel}: duration=${duration}ms, mints=${uniqueMints.length}, direct=${directCount}, api=${Object.keys(apiResult).length}, fallback=${fallbackCount}`,
      'debug'
    );
  }

  return prices;
}

function existingSnapshotTop10(snap: ReturnType<typeof localMarketState.getSnapshot>): number {
  return snap?.top10ConcentrationPct ?? 0;
}
