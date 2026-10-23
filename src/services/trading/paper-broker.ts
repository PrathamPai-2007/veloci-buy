import { Context, TokenMetadata } from '#types/index.js';
import {
  fetchJson,
  coalesce,
  atomicToDecimalString,
  decimalToAtomic,
  jupiterRateLimit,
  PRIORITY,
} from '#core/utils.js';
import { SOL_MINT } from '../../core/constants.js';
import { jupiterPositionBreaker } from '../jupiter-circuit-breaker.js';

const SOL_PRICE_CACHE_TTL_MS = 15_000;
const SOL_PRICE_MAX_ACCOUNTING_AGE_MS = 3_600_000; // 1 hour

export interface SolPriceDetails {
  price: number;
  source: 'mock-override' | 'jupiter-live' | 'cache';
  timestamp: number;
  ageMs: number;
}

let _solPriceCache = { price: 0, fetchedAt: 0 };
let _solPriceInflight: Promise<SolPriceDetails> | null = null;

export async function estimateSolUsdPriceDetails(
  ctx: Context,
  apiKey: string | null = null
): Promise<SolPriceDetails> {
  const walletAny = ctx as unknown as Record<string, unknown>;
  if (typeof walletAny.getSolUsdPrice === 'function') {
    const overriddenPrice = Number(await (walletAny.getSolUsdPrice as () => Promise<number>)());
    if (overriddenPrice > 0) {
      return {
        price: overriddenPrice,
        source: 'mock-override',
        timestamp: Date.now(),
        ageMs: 0,
      };
    }
  }

  const now = Date.now();
  if (_solPriceCache.price > 0 && now - _solPriceCache.fetchedAt < SOL_PRICE_CACHE_TTL_MS) {
    return {
      price: _solPriceCache.price,
      source: 'cache',
      timestamp: _solPriceCache.fetchedAt,
      ageMs: now - _solPriceCache.fetchedAt,
    };
  }

  // SOL/USD drives position accounting, so it rides the position breaker and key.
  const { allowed } = jupiterPositionBreaker.canExecute(ctx);

  if (!allowed) {
    if (
      _solPriceCache.price > 0 &&
      now - _solPriceCache.fetchedAt <= SOL_PRICE_MAX_ACCOUNTING_AGE_MS
    ) {
      return {
        price: _solPriceCache.price,
        source: 'cache',
        timestamp: _solPriceCache.fetchedAt,
        ageMs: now - _solPriceCache.fetchedAt,
      };
    }
    throw new Error(
      `SOL price estimation failed: Jupiter API circuit open or rate-limited and no valid fresh SOL price cache available.`
    );
  }

  return coalesce(
    async () => {
      let timeoutId: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<SolPriceDetails>((_, reject) => {
        timeoutId = setTimeout(() => {
          if (_solPriceCache.price > 0) {
            ctx.logger(
              'Jupiter SOL price fetch timed out after 10000ms; using cached value.',
              'warn'
            );
            reject(new Error('Jupiter SOL price fetch timed out.'));
          } else {
            reject(
              new Error('Jupiter SOL price fetch timed out and no cached SOL price available.')
            );
          }
        }, 10000);
      });

      const fetchPromise = (async (): Promise<SolPriceDetails> => {
        try {
          jupiterPositionBreaker.recordRequest(ctx);
          const url = `${ctx.config.jupiterBaseUrl}/price/v3?ids=${SOL_MINT}`;
          const key = apiKey || ctx.config.jupiterPositionApiKey || ctx.config.jupiterApiKey;
          let response: Record<string, unknown>;
          try {
            response = (await fetchJson(url, {
              headers: { 'x-api-key': key },
              retries: 2,
              timeoutMs: 8000,
              rateLimit: jupiterRateLimit(ctx, key, PRIORITY.MEDIUM),
            })) as Record<string, unknown>;
          } catch (error: unknown) {
            jupiterPositionBreaker.recordFailure(ctx, error);
            if (
              _solPriceCache.price > 0 &&
              now - _solPriceCache.fetchedAt <= SOL_PRICE_MAX_ACCOUNTING_AGE_MS
            ) {
              return {
                price: _solPriceCache.price,
                source: 'cache',
                timestamp: _solPriceCache.fetchedAt,
                ageMs: now - _solPriceCache.fetchedAt,
              };
            }
            throw new Error(
              `SOL price fetch failed: ${error instanceof Error ? error.message : String(error)} and no valid fresh cached SOL price available.`,
              { cause: error }
            );
          }

          jupiterPositionBreaker.recordSuccess(ctx);

          const priceMap = (response?.data ?? response) as Record<
            string,
            { usdPrice?: string | number; price?: string | number }
          >;
          if (!priceMap?.[SOL_MINT]) {
            throw new Error('Jupiter price response missing SOL.');
          }

          const record = priceMap[SOL_MINT];
          const p = Number(record.usdPrice || record.price || 0);

          if (!(p > 0)) {
            throw new Error('Jupiter SOL price is zero or invalid.');
          }

          _solPriceCache = { price: p, fetchedAt: now };
          return {
            price: p,
            source: 'jupiter-live',
            timestamp: now,
            ageMs: 0,
          };
        } finally {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
        }
      })();

      return Promise.race([fetchPromise, timeoutPromise]).catch((err) => {
        if (_solPriceCache.price > 0) {
          return {
            price: _solPriceCache.price,
            source: 'cache' as const,
            timestamp: _solPriceCache.fetchedAt,
            ageMs: Date.now() - _solPriceCache.fetchedAt,
          };
        }
        throw err;
      });
    },
    () => _solPriceInflight,
    (p) => {
      _solPriceInflight = p;
    }
  );
}

export async function estimateSolUsdPrice(
  ctx: Context,
  apiKey: string | null = null
): Promise<number> {
  const details = await estimateSolUsdPriceDetails(ctx, apiKey);
  return details.price;
}

export async function estimateSolUsdValue(
  ctx: Context,
  amountLamports: bigint | string,
  apiKey: string | null = null
): Promise<number> {
  const p = await estimateSolUsdPrice(ctx, apiKey);
  return p * Number(atomicToDecimalString(amountLamports, 9, 9));
}

export async function buildPaperBuyQuote(
  ctx: Context,
  token: TokenMetadata,
  decimals: number,
  buyLamports: bigint | string
): Promise<{
  outAmount: bigint;
  entryUsdValue: number;
  entryPriceUsd: number;
  solPrice: number;
  solPriceSource: string;
  solPriceTimestamp: number;
  solPriceAgeMs: number;
}> {
  const p = Number(token.usdPrice || 0);
  if (!(p > 0)) throw new Error(`No price for paper buy ${token.symbol}.`);
  const solDetails = await estimateSolUsdPriceDetails(ctx);
  const val = solDetails.price * Number(atomicToDecimalString(buyLamports, 9, 9));
  const units = val / p;
  const raw = BigInt(decimalToAtomic(units.toFixed(Math.min(decimals, 9)), decimals));
  const out = (raw * BigInt(Math.max(0, 10000 - ctx.config.slippageBps))) / 10000n;
  if (out <= 0n) throw new Error('Paper buy rounded to zero.');
  return {
    outAmount: out,
    entryUsdValue: val,
    entryPriceUsd: p,
    solPrice: solDetails.price,
    solPriceSource: solDetails.source,
    solPriceTimestamp: solDetails.timestamp,
    solPriceAgeMs: solDetails.ageMs,
  };
}

export async function buildPaperSellQuote(
  ctx: Context,
  rawAmount: bigint | string,
  pUsd: number,
  dec: number,
  apiKey: string | null = null
): Promise<{
  outAmount: bigint;
  grossUsdValue: number;
  solPrice: number;
  solPriceSource: string;
  solPriceTimestamp: number;
  solPriceAgeMs: number;
}> {
  if (!(pUsd > 0)) throw new Error('No price for paper sell.');
  const solDetails = await estimateSolUsdPriceDetails(ctx, apiKey);
  const val = Number(atomicToDecimalString(rawAmount, dec, 9)) * pUsd;
  const rawLamports = BigInt(decimalToAtomic((val / solDetails.price).toFixed(9), 9));
  const out = (rawLamports * BigInt(Math.max(0, 10000 - ctx.config.slippageBps))) / 10000n;
  if (out <= 0n) throw new Error('Paper sell rounded to zero.');
  return {
    outAmount: out,
    grossUsdValue: val,
    solPrice: solDetails.price,
    solPriceSource: solDetails.source,
    solPriceTimestamp: solDetails.timestamp,
    solPriceAgeMs: solDetails.ageMs,
  };
}
