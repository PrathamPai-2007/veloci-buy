import { fetchJson, isRateLimitError } from '#core/utils.js';
import { Context, SwingWatchlistItem, TokenMetadata } from '#types/index.js';
import { detectPartialW } from './swing-signals.js';
import { swingTapeManager } from './swing-tape.js';

const MAX_WATCHLIST_AGE_MS = 120 * 60 * 1000; // 2 hours
const MAX_WATCHLIST_SIZE = 50;
const SWING_JUPITER_PRICE_COOLDOWN_MS = 30_000;
const MAX_PRICE_HISTORY = 180;

function removeFromWatchlist(ctx: Context, mint: string): void {
  ctx.state.swingWatchlist.delete(mint);
  swingTapeManager.unsubscribe(mint);
}

/**
 * Returns true when a token appears to be on Raydium/Meteora (graduated from pump.fun).
 * Heuristic: launchpad is explicitly 'raydium' or 'meteora', OR token mint does NOT end
 * with the 'pump' suffix (pre-graduation pump.fun mints always end with 'pump').
 */
export function isGraduatedToken(token: { id: string; launchpad?: string | null }): boolean {
  const lp = (token.launchpad ?? '').toLowerCase().trim();
  if (lp === 'raydium' || lp === 'meteora') return true;
  // Tokens that end with 'pump' are still on the bonding curve; anything else is graduated
  return !token.id.toLowerCase().endsWith('pump');
}

const MAX_TAPE_HISTORY = 50;

async function fetchTopTraded(
  baseUrl: string,
  apiKey: string,
  sortBy?: string
): Promise<TokenMetadata[]> {
  const url = `${baseUrl}/tokens/v2/toptraded/1h` + (sortBy ? `?sortBy=${sortBy}&order=desc` : '');
  const raw = await fetchJson<TokenMetadata[]>(url, {
    headers: { 'x-api-key': apiKey },
    timeoutMs: 8000,
    retries: 1,
  });
  return Array.isArray(raw) ? (raw as TokenMetadata[]) : [];
}

/**
 * Polls Jupiter's top-traded/1h feed (two sort passes: default + volume) and adds graduated
 * tokens within the configured market-cap window to the swing watchlist. For already-watchlisted
 * tokens that reappear in the feed, updates their tapeHistory with the current stats5m snapshot
 * so detectVolumeAccumulation has real data even when the WebSocket tape is unavailable.
 */
export async function refreshSwingWatchlist(ctx: Context): Promise<void> {
  const { swingJupiterBaseUrl, swingJupiterApiKey, swingMinMarketCapUsd, swingMaxMarketCapUsd } =
    ctx.config;

  let tokens: TokenMetadata[];

  try {
    const [primary, secondary] = await Promise.all([
      fetchTopTraded(swingJupiterBaseUrl, swingJupiterApiKey),
      fetchTopTraded(swingJupiterBaseUrl, swingJupiterApiKey, 'volume'),
    ]);
    // Deduplicate by mint — primary feed wins on duplicates
    const seen = new Set<string>();
    tokens = [];
    for (const t of [...primary, ...secondary]) {
      if (t?.id && !seen.has(t.id)) {
        seen.add(t.id);
        tokens.push(t);
      }
    }
  } catch (e: unknown) {
    ctx.logger(
      `Swing discovery fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      'warn'
    );
    return;
  }

  const now = Date.now();
  let added = 0;

  for (const token of tokens) {
    if (!token?.id || !isGraduatedToken(token)) continue;

    const fdvUsd = Number(token.fdvUsd ?? token.fdv ?? token.marketCapUsd ?? 0);
    if (fdvUsd < swingMinMarketCapUsd || fdvUsd > swingMaxMarketCapUsd) continue;

    const mint = token.id;

    // Update tapeHistory for already-watchlisted tokens using the stats5m from the feed
    const existing = ctx.state.swingWatchlist.get(mint);
    if (existing) {
      const numBuys = Number(token.stats5m?.numBuys ?? 0);
      const numSells = Number(token.stats5m?.numSells ?? 0);
      if (numBuys > 0 || numSells > 0) {
        existing.tapeHistory.push({ buys: numBuys, sells: numSells, timestamp: now });
        if (existing.tapeHistory.length > MAX_TAPE_HISTORY) existing.tapeHistory.shift();
      }
      continue;
    }

    if (ctx.state.positions.has(mint)) continue;
    if (ctx.state.retiredMints.has(mint)) continue;

    // Evict oldest entry if at capacity
    if (ctx.state.swingWatchlist.size >= MAX_WATCHLIST_SIZE) {
      let oldestMint = '';
      let oldestTime = Infinity;
      for (const [m, item] of ctx.state.swingWatchlist) {
        if (item.addedAt < oldestTime) {
          oldestTime = item.addedAt;
          oldestMint = m;
        }
      }
      if (oldestMint) removeFromWatchlist(ctx, oldestMint);
    }

    const lp = (token.launchpad ?? '').toLowerCase().trim();
    const pool: SwingWatchlistItem['pool'] =
      lp === 'raydium' ? 'raydium' : lp === 'meteora' ? 'meteora' : 'unknown';

    // Seed tapeHistory with the initial stats5m snapshot from the discovery feed
    const initialTape: SwingWatchlistItem['tapeHistory'] = [];
    const numBuys = Number(token.stats5m?.numBuys ?? 0);
    const numSells = Number(token.stats5m?.numSells ?? 0);
    if (numBuys > 0 || numSells > 0) {
      initialTape.push({ buys: numBuys, sells: numSells, timestamp: now });
    }

    const item: SwingWatchlistItem = {
      mint,
      symbol: token.symbol ?? '?',
      name: token.name ?? '?',
      decimals: Number(token.decimals ?? 6),
      fdvUsd,
      addedAt: now,
      lastPolledAt: 0,
      priceHistory: [],
      tapeHistory: initialTape,
      lastKnownPrice: Number(token.usdPrice ?? token.priceUsd ?? 0),
      lastKnownLiquidity: Number(token.liquidity ?? 0),
      pool,
      launchpad: token.launchpad ?? undefined,
    };

    ctx.state.swingWatchlist.set(mint, item);
    // Subscribe to on-chain swap logs for this pool (Phase 3A); async, non-blocking
    void swingTapeManager.subscribe(ctx, item);
    added++;
  }

  if (added > 0) {
    ctx.logger(
      `Swing watchlist: added ${added} graduated tokens (total ${ctx.state.swingWatchlist.size}).`,
      'debug'
    );
  }
}

const FAST_POLL_DURATION_MS = 30 * 60_000; // 30 min fast-poll window per item

/**
 * Polls current price and 5-minute tape (buy/sell counts) for watchlist items.
 *
 * @param fastOnly - when true, only polls items currently in fast-poll mode
 *   (fastPollUntil is set and not expired). Used by the 15s fast-poll timer.
 *
 * Uses a separate cooldown state (swingJupiterCooldownUntil) to avoid contaminating
 * the sniper's rate-limit tracking.
 */
export async function pollWatchlistPrices(ctx: Context, fastOnly = false): Promise<void> {
  if (ctx.state.swingWatchlist.size === 0) return;

  const cooldownUntil = ctx.state.swingJupiterCooldownUntil;
  if (cooldownUntil != null && Date.now() < cooldownUntil) return;

  const now = Date.now();

  // When fastOnly, restrict to items whose fast-poll window is still active
  const eligibleMints = Array.from(ctx.state.swingWatchlist.keys()).filter((mint) => {
    if (!fastOnly) return true;
    const item = ctx.state.swingWatchlist.get(mint)!;
    return item.fastPollUntil != null && now < item.fastPollUntil;
  });

  if (eligibleMints.length === 0) return;

  const mints = eligibleMints;
  const { swingJupiterBaseUrl, swingJupiterApiKey } = ctx.config;

  // Batch price fetch
  const priceUrl = `${swingJupiterBaseUrl}/price/v3?ids=${encodeURIComponent(mints.join(','))}`;
  let priceMap: Record<string, { usdPrice?: number; price?: number; liquidity?: number }> = {};

  try {
    const resp = await fetchJson<{
      data?: Record<string, { usdPrice?: number; price?: number }>;
    }>(priceUrl, {
      headers: { 'x-api-key': swingJupiterApiKey },
      timeoutMs: 5000,
      retries: 0,
    });
    priceMap = (resp?.data ?? resp ?? {}) as typeof priceMap;
  } catch (e: unknown) {
    if (isRateLimitError(e)) {
      ctx.state.swingJupiterCooldownUntil = Date.now() + SWING_JUPITER_PRICE_COOLDOWN_MS;
      ctx.logger('Swing Jupiter price API rate-limited; backing off 30s.', 'warn');
    } else {
      ctx.logger(
        `Swing price fetch failed: ${e instanceof Error ? e.message : String(e)}`,
        'debug'
      );
    }
    return;
  }

  for (const mint of eligibleMints) {
    const item = ctx.state.swingWatchlist.get(mint)!;
    const priceRecord = priceMap[mint];
    const price = Number(priceRecord?.usdPrice ?? (priceRecord as { price?: number })?.price ?? 0);
    const liquidity = Number((priceRecord as { liquidity?: number })?.liquidity ?? 0);

    if (price > 0) {
      item.lastKnownPrice = price;
      item.priceHistory.push({ price, timestamp: now, liquidity: liquidity || undefined });
      if (item.priceHistory.length > MAX_PRICE_HISTORY) {
        item.priceHistory.shift();
      }

      // Phase 2: arm fast-poll when partial W (dip1+bounce) is forming
      if (item.fastPollUntil != null && now >= item.fastPollUntil) {
        item.fastPollUntil = undefined; // expired — clear
      } else if (item.fastPollUntil == null && detectPartialW(item.priceHistory)) {
        item.fastPollUntil = now + FAST_POLL_DURATION_MS;
        ctx.logger(`Swing fast-poll armed for ${item.symbol} (partial W detected).`, 'debug');
      }
    }

    if (liquidity > 0) item.lastKnownLiquidity = liquidity;
    item.lastPolledAt = now;
  }
}

/**
 * Removes watchlist items that are too old or already have an open position.
 */
export function evictStaleWatchlistItems(ctx: Context): void {
  const now = Date.now();
  for (const [mint, item] of ctx.state.swingWatchlist) {
    if (now - item.addedAt > MAX_WATCHLIST_AGE_MS || ctx.state.positions.has(mint)) {
      removeFromWatchlist(ctx, mint);
    }
  }
}
