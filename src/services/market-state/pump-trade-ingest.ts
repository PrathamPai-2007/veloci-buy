import type { Context } from '#types/index.js';
import type { PumpTradeEvent } from '../discovery/providers/pump-decoder.js';
import { estimateSolUsdPrice, getCachedSolUsdPrice } from '../trading/paper-broker.js';
import { localMarketState } from './local-market-state.js';
import { marketTapeManager } from './market-tape-manager.js';
import { priceHistoryEngine } from './price-history-engine.js';
import { applyHolderTrade } from './holder-ledger.js';

/** Mints we want trades for: just launched / queued by the scanner, or held. Everything else is dropped. */
const WATCH_TTL_MS = 10 * 60 * 1000;
const MAX_WATCHED = 5000;
const watched = new Map<string, number>();

const SOL_PRICE_REFRESH_MS = 60_000;
/** pump.fun mints are 6-decimal, 1B supply. */
const PUMP_SUPPLY_TOKENS = 1_000_000_000;

/** Recent real-curve liquidity readings per mint, so a pull during the survival window is visible. */
const liquidityTrail = new Map<string, { t: number; usd: number }[]>();
const TRAIL_MAX_POINTS = 200;

/** Highest curve liquidity seen at or after `sinceMs`, or undefined when none was recorded. */
export function getLiquidityPeak(mint: string, sinceMs: number): number | undefined {
  let peak: number | undefined;
  for (const p of liquidityTrail.get(mint) ?? []) {
    if (p.t >= sinceMs && (peak === undefined || p.usd > peak)) peak = p.usd;
  }
  return peak;
}

export function watchMint(mint: string, now = Date.now()): void {
  if (watched.size >= MAX_WATCHED && !watched.has(mint)) {
    for (const [m, at] of watched) if (now - at > WATCH_TTL_MS) watched.delete(m);
    if (watched.size >= MAX_WATCHED) return;
  }
  watched.set(mint, now);
}

function isWatched(ctx: Context, mint: string, now: number): boolean {
  if (ctx.state?.positions?.has(mint) || ctx.state?.pendingCandidateRechecks?.has(mint))
    return true;
  const at = watched.get(mint);
  return at !== undefined && now - at <= WATCH_TTL_MS;
}

/**
 * Feeds one pump.fun TradeEvent into the local trade tape, price history and market snapshot.
 * Free: it rides the program-log subscription the bot already holds, no RPC/Jupiter call.
 * Returns true when the trade was recorded.
 */
export function ingestPumpTrade(ctx: Context, trade: PumpTradeEvent, now = Date.now()): boolean {
  if (!isWatched(ctx, trade.mint, now)) return false;

  const sol = getCachedSolUsdPrice();
  if (!(sol.price > 0) || sol.ageMs > SOL_PRICE_REFRESH_MS) {
    // Refresh in the background; coalesced inside estimateSolUsdPrice.
    void estimateSolUsdPrice(ctx).catch(() => {});
  }

  marketTapeManager.recordTick(
    trade.mint,
    trade.isBuy ? 'buy' : 'sell',
    Number(trade.solAmount) / 1e9,
    now,
    trade.user
  );
  applyHolderTrade(
    trade.mint,
    trade.user,
    trade.isBuy,
    trade.tokenAmount,
    trade.realTokenReserves,
    now
  );

  if (!(sol.price > 0)) return true; // tape recorded; price needs a SOL/USD rate first
  const vSol = Number(trade.virtualSolReserves) / 1e9;
  const vTok = Number(trade.virtualTokenReserves) / 1e6;
  if (!(vSol > 0) || !(vTok > 0)) return true;

  const priceUsd = (vSol / vTok) * sol.price;
  const liquidityUsd = (Number(trade.realSolReserves) / 1e9) * 2 * sol.price;
  priceHistoryEngine.pushPrice(trade.mint, 0, priceUsd, now);
  const trail = liquidityTrail.get(trade.mint) ?? [];
  trail.push({ t: now, usd: liquidityUsd });
  if (trail.length > TRAIL_MAX_POINTS) trail.shift();
  liquidityTrail.set(trade.mint, trail);
  if (liquidityTrail.size > MAX_WATCHED) {
    liquidityTrail.delete(liquidityTrail.keys().next().value as string);
  }

  const existing = localMarketState.getSnapshot(trade.mint);
  const flow = marketTapeManager.getSwapVolume(trade.mint, 60_000);
  localMarketState.updateSnapshot({
    mint: trade.mint,
    symbol: existing?.symbol,
    venue: 'pumpfun',
    priceUsd,
    liquidityUsd,
    fdvUsd: priceUsd * PUMP_SUPPLY_TOKENS,
    totalSupply: existing?.totalSupply ?? 1_000_000_000_000_000n,
    updatedAt: now,
    sourceSlot: 0,
    source: 'pump-trade-log',
    status: 'authoritative',
    buyVolume1m: flow.buyVolumeSol,
    sellVolume1m: flow.sellVolumeSol,
    tradeCount1m: flow.tradeCount,
    top5ConcentrationPct: existing?.top5ConcentrationPct ?? 0,
    top10ConcentrationPct: existing?.top10ConcentrationPct ?? 0,
    holderCount: existing?.holderCount ?? 0,
  });
  return true;
}

/** @testOnly */
export function _resetPumpTradeIngestForTest(): void {
  watched.clear();
}
