import { Context, TokenMetadata } from '#types/index.js';
import {
  fetchJson,
  atomicToDecimalString,
  decimalToAtomic,
  safeJsonStringify,
} from '#core/utils.js';
import { SOL_MINT } from '#core/config.js';

const SOL_PRICE_CACHE_TTL_MS = 180_000;
const JUPITER_SOL_COOLDOWN_MS = 30_000;
// Last-resort SOL/USD value when rate-limited before any successful fetch and with no cached price.
// NOTE: this helper is re-exported via trading.service and is also reached on LIVE paths — it backs
// USD valuations for accounting (entrySolValue in buy.ts, proceedsUsd in exit-executor.ts) and the
// on-chain price fallback in market-data.fetchDirectMarketData. The actual swap amounts come from the
// live quote path, so this fallback never sizes a real trade, but a stale value here skews recorded
// USD PnL. Keep it roughly in line with the prevailing SOL price.
const SOL_PRICE_FALLBACK_USD = 150;
let _solPriceCache = { price: 0, fetchedAt: 0 };
let _solPriceInflight: Promise<number> | null = null;

function isSolPriceRateLimitError(e: unknown): boolean {
  return /\b429\b|too many requests/i.test(e instanceof Error ? e.message : String(e));
}

export async function estimateSolUsdPrice(
  ctx: Context,
  apiKey: string | null = null
): Promise<number> {
  const walletAny = ctx as unknown as Record<string, unknown>;
  if (typeof walletAny.getSolUsdPrice === 'function') {
    const overriddenPrice = Number(await (walletAny.getSolUsdPrice as () => Promise<number>)());
    if (overriddenPrice > 0) return overriddenPrice;
  }

  const now = Date.now();
  if (_solPriceCache.price > 0 && now - _solPriceCache.fetchedAt < SOL_PRICE_CACHE_TTL_MS) {
    return _solPriceCache.price;
  }

  // While rate-limited, serve stale cache rather than hammering Jupiter again.
  const cooldownUntil = ctx.state.jupiterPriceCooldownUntil;
  if (cooldownUntil != null && now < cooldownUntil) {
    if (_solPriceCache.price > 0) return _solPriceCache.price;
    ctx.logger(
      `Jupiter SOL price rate-limited with no cached value; using fallback $${SOL_PRICE_FALLBACK_USD} for paper trade.`,
      'warn'
    );
    return SOL_PRICE_FALLBACK_USD;
  }

  // Coalesce concurrent callers (e.g. parallel fetchDirectMarketData pool) onto a single
  // in-flight request rather than each firing their own Jupiter hit.
  if (_solPriceInflight) return _solPriceInflight;

  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<number>((resolve) => {
    timeoutId = setTimeout(() => {
      const fallback = _solPriceCache.price > 0 ? _solPriceCache.price : SOL_PRICE_FALLBACK_USD;
      ctx.logger(
        `Jupiter SOL price fetch timed out after 10000ms; using ${
          _solPriceCache.price > 0 ? 'cached' : 'fallback'
        } value $${fallback}.`,
        'warn'
      );
      resolve(fallback);
    }, 10000);
  });

  const fetchPromise = (async () => {
    try {
      const url = `${ctx.config.jupiterBaseUrl}/price/v3?ids=${SOL_MINT}`;
      let response: Record<string, unknown>;
      try {
        response = (await fetchJson(url, {
          headers: { 'x-api-key': apiKey || ctx.config.jupiterApiKey },
          // No retries — a 429 should trigger the cooldown, not three immediate re-requests.
          retries: 0,
          timeoutMs: 8000,
        })) as Record<string, unknown>;
      } catch (error: unknown) {
        if (isSolPriceRateLimitError(error)) {
          ctx.state.jupiterPriceCooldownUntil = now + JUPITER_SOL_COOLDOWN_MS;
          const fallback = _solPriceCache.price > 0 ? _solPriceCache.price : SOL_PRICE_FALLBACK_USD;
          ctx.logger(
            `Jupiter SOL price rate-limited (429); backing off ${JUPITER_SOL_COOLDOWN_MS / 1000}s, ` +
              `using ${_solPriceCache.price > 0 ? 'cached' : 'fallback'} value $${fallback}.`,
            'warn'
          );
          return fallback;
        }
        if (_solPriceCache.price > 0) {
          ctx.logger(
            `Failed to fetch SOL price, using cached value: ${error instanceof Error ? error.message : String(error)}`,
            'warn'
          );
          return _solPriceCache.price;
        }
        throw error;
      }

      const priceMap = (response?.data ?? response) as Record<
        string,
        { usdPrice?: string | number; price?: string | number }
      >;
      if (!priceMap?.[SOL_MINT]) {
        ctx.logger(`Jupiter price response missing SOL: ${safeJsonStringify(response)}`, 'error');
        throw new Error('No SOL price available.');
      }

      const record = priceMap[SOL_MINT];
      const p = Number(record.usdPrice || record.price || 0);

      if (!(p > 0)) {
        ctx.logger(`Jupiter SOL price is zero or invalid: ${safeJsonStringify(record)}`, 'error');
        throw new Error('No SOL price available.');
      }

      _solPriceCache = { price: p, fetchedAt: now };
      return p;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  })();

  _solPriceInflight = Promise.race([fetchPromise, timeoutPromise]).finally(() => {
    _solPriceInflight = null;
  });

  return _solPriceInflight;
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
}> {
  const p = Number(token.usdPrice || 0);
  if (!(p > 0)) throw new Error(`No price for paper buy ${token.symbol}.`);
  const solPrice = await estimateSolUsdPrice(ctx);
  const val = await estimateSolUsdValue(ctx, buyLamports);
  const units = val / p;
  const raw = BigInt(decimalToAtomic(units.toFixed(Math.min(decimals, 9)), decimals));
  const out = (raw * BigInt(Math.max(0, 10000 - ctx.config.slippageBps))) / 10000n;
  if (out <= 0n) throw new Error('Paper buy rounded to zero.');
  return { outAmount: out, entryUsdValue: val, entryPriceUsd: p, solPrice };
}

export async function buildPaperSellQuote(
  ctx: Context,
  rawAmount: bigint | string,
  pUsd: number,
  dec: number,
  apiKey: string | null = null
): Promise<{ outAmount: bigint; grossUsdValue: number; solPrice: number }> {
  if (!(pUsd > 0)) throw new Error('No price for paper sell.');
  const solPrice = await estimateSolUsdPrice(ctx, apiKey);
  const val = Number(atomicToDecimalString(rawAmount, dec, 9)) * pUsd;
  const rawLamports = BigInt(decimalToAtomic((val / solPrice).toFixed(9), 9));
  const out = (rawLamports * BigInt(Math.max(0, 10000 - ctx.config.slippageBps))) / 10000n;
  if (out <= 0n) throw new Error('Paper sell rounded to zero.');
  return { outAmount: out, grossUsdValue: val, solPrice };
}
