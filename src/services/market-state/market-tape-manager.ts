import {
  parseRayLog,
  parseMeteoraSwapLog,
  parseRaydiumClmmSwapLog,
} from './decoders/swap-log-parsers.js';

export interface SwapTick {
  mint: string;
  side: 'buy' | 'sell';
  amountSol: number;
  timestamp: number;
  /** Wallet that made the trade, when the source reports it (pump.fun TradeEvent does). */
  trader?: string;
}

export interface TapeStats {
  buys: number;
  sells: number;
  buyVolumeSol: number;
  sellVolumeSol: number;
  /** Distinct wallets that bought in the window (0 when the source has no trader field). */
  uniqueBuyers: number;
}

/** Mints tracked before idle tapes are pruned, and how long a tape may sit idle. */
const MAX_TAPE_MINTS = 2000;
const TAPE_IDLE_MS = 10 * 60 * 1000;

export class MarketTapeManager {
  private readonly tapeMap = new Map<string, SwapTick[]>();
  private readonly maxTapeSize: number;

  constructor(maxTapeSize = 500) {
    this.maxTapeSize = maxTapeSize;
  }

  recordTick(
    mint: string,
    side: 'buy' | 'sell',
    amountSol: number,
    timestamp = Date.now(),
    trader?: string
  ): void {
    let tape = this.tapeMap.get(mint);
    if (!tape) {
      if (this.tapeMap.size >= MAX_TAPE_MINTS) this.pruneIdle(timestamp);
      tape = [];
      this.tapeMap.set(mint, tape);
    }
    tape.push({ mint, side, amountSol, timestamp, trader });
    if (tape.length > this.maxTapeSize) {
      tape.shift();
    }
  }

  private pruneIdle(now: number): void {
    for (const [mint, tape] of this.tapeMap) {
      const last = tape[tape.length - 1];
      if (!last || now - last.timestamp > TAPE_IDLE_MS) this.tapeMap.delete(mint);
    }
  }

  parseAndRecordLog(
    mint: string,
    pool: 'pumpfun' | 'raydium' | 'meteora',
    logLine: string,
    solIsTokenX = true
  ): SwapTick | null {
    let tick: { side: 'buy' | 'sell'; amountSol: number } | null = null;

    if (pool === 'meteora') {
      tick = parseMeteoraSwapLog(logLine, solIsTokenX);
    } else if (pool === 'raydium') {
      tick = parseRaydiumClmmSwapLog(logLine, solIsTokenX) ?? parseRayLog(logLine);
    }

    if (tick && tick.amountSol > 0) {
      this.recordTick(mint, tick.side, tick.amountSol);
      return { mint, side: tick.side, amountSol: tick.amountSol, timestamp: Date.now() };
    }

    return null;
  }

  /** All ticks for `mint` at or after `sinceMs` (epoch ms), oldest first. */
  getTicks(mint: string, sinceMs = 0): SwapTick[] {
    const tape = this.tapeMap.get(mint);
    if (!tape) return [];
    return sinceMs > 0 ? tape.filter((t) => t.timestamp >= sinceMs) : tape.slice();
  }

  /** Whether any trade has ever been recorded for `mint`. */
  hasTape(mint: string): boolean {
    return (this.tapeMap.get(mint)?.length ?? 0) > 0;
  }

  /** Buy/sell counts, SOL volume and distinct buyers over the trailing `windowMs`. */
  getTapeStats(mint: string, windowMs = 300_000, now = Date.now()): TapeStats {
    const stats: TapeStats = {
      buys: 0,
      sells: 0,
      buyVolumeSol: 0,
      sellVolumeSol: 0,
      uniqueBuyers: 0,
    };
    const tape = this.tapeMap.get(mint);
    if (!tape) return stats;
    const cutoff = now - windowMs;
    const buyers = new Set<string>();
    for (const tick of tape) {
      if (tick.timestamp < cutoff) continue;
      if (tick.side === 'buy') {
        stats.buys++;
        stats.buyVolumeSol += tick.amountSol;
        if (tick.trader) buyers.add(tick.trader);
      } else {
        stats.sells++;
        stats.sellVolumeSol += tick.amountSol;
      }
    }
    stats.uniqueBuyers = buyers.size;
    return stats;
  }

  getSwapVolume(
    mint: string,
    windowMs = 60_000
  ): { buyVolumeSol: number; sellVolumeSol: number; tradeCount: number } {
    const s = this.getTapeStats(mint, windowMs);
    return {
      buyVolumeSol: s.buyVolumeSol,
      sellVolumeSol: s.sellVolumeSol,
      tradeCount: s.buys + s.sells,
    };
  }

  clear(mint?: string): void {
    if (mint) {
      this.tapeMap.delete(mint);
    } else {
      this.tapeMap.clear();
    }
  }
}

export const marketTapeManager = new MarketTapeManager();
