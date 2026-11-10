/**
 * Pure order-flow signals computed from the local pump.fun trade tape.
 * No I/O: the tape is filled for free from the program-log stream (see pump-trade-ingest).
 */
import { clamp } from '#core/utils.js';
import type { TapeSignalWeights } from '#types/scoring.js';
import type { SwapTick } from '../market-state/market-tape-manager.js';

export interface TapeSignals {
  trades: number;
  buys: number;
  sells: number;
  /** Buy SOL minus sell SOL over the window: how much SOL actually entered the curve. */
  netInflowSol: number;
  /** netInflowSol per second (window clamped to >= 5 s so a single early trade can't spike it). */
  inflowPerSec: number;
  uniqueBuyers: number;
  /** Wallets that bought and then sold within the wash window. */
  roundTripWallets: number;
  /** The launching wallet sold on this tape. */
  creatorSold: boolean;
}

const MIN_WINDOW_SECONDS = 5;

export function analyzeTape(
  ticks: SwapTick[],
  opts: { creator?: string; now: number; windowSeconds: number; washWindowSeconds: number }
): TapeSignals {
  const windowMs = opts.windowSeconds * 1000;
  const inWindow = ticks.filter((t) => t.timestamp >= opts.now - windowMs);

  let buys = 0;
  let sells = 0;
  let buySol = 0;
  let sellSol = 0;
  const buyers = new Set<string>();
  const lastBuyAt = new Map<string, number>();
  const roundTrippers = new Set<string>();
  let creatorSold = false;
  const washMs = opts.washWindowSeconds * 1000;

  // Creator sales are checked over the whole tape, not just the window: a dev dump 90 s ago
  // still means the token's supply is in the open.
  for (const t of ticks) {
    if (opts.creator && t.side === 'sell' && t.trader === opts.creator) creatorSold = true;
  }
  for (const t of inWindow) {
    if (t.side === 'buy') {
      buys++;
      buySol += t.amountSol;
      if (t.trader) {
        buyers.add(t.trader);
        lastBuyAt.set(t.trader, t.timestamp);
      }
    } else {
      sells++;
      sellSol += t.amountSol;
      const bought = t.trader ? lastBuyAt.get(t.trader) : undefined;
      if (t.trader && bought !== undefined && t.timestamp - bought <= washMs) {
        roundTrippers.add(t.trader);
      }
    }
  }

  const first = inWindow[0]?.timestamp ?? opts.now;
  const spanSec = Math.min(
    opts.windowSeconds,
    Math.max(MIN_WINDOW_SECONDS, (opts.now - first) / 1000)
  );
  const netInflowSol = buySol - sellSol;
  return {
    trades: buys + sells,
    buys,
    sells,
    netInflowSol,
    inflowPerSec: netInflowSol / spanSec,
    uniqueBuyers: buyers.size,
    roundTripWallets: roundTrippers.size,
    creatorSold,
  };
}

/** Score delta from the tape. Neutral (0) when there are too few trades to judge. */
export function computeTapeScore(sig: TapeSignals, w: TapeSignalWeights): number {
  if (sig.trades < w.minTrades) return 0;
  let delta = 0;
  if (w.liquidityVelocityMax > 0 && w.liquidityVelocityFullSolPerSec > 0) {
    delta +=
      clamp(sig.inflowPerSec / w.liquidityVelocityFullSolPerSec, -1, 1) * w.liquidityVelocityMax;
  }
  if (w.uniqueBuyersMax > 0 && w.uniqueBuyersFull > 0) {
    delta += clamp(sig.uniqueBuyers / w.uniqueBuyersFull, 0, 1) * w.uniqueBuyersMax;
  }
  if (w.washPenalty > 0 && sig.roundTripWallets > 0) {
    delta -= w.washPenalty;
  }
  return delta;
}
