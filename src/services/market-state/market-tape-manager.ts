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
}

export class MarketTapeManager {
  private readonly tapeMap = new Map<string, SwapTick[]>();
  private readonly maxTapeSize: number;

  constructor(maxTapeSize = 500) {
    this.maxTapeSize = maxTapeSize;
  }

  recordTick(mint: string, side: 'buy' | 'sell', amountSol: number, timestamp = Date.now()): void {
    let tape = this.tapeMap.get(mint);
    if (!tape) {
      tape = [];
      this.tapeMap.set(mint, tape);
    }
    tape.push({ mint, side, amountSol, timestamp });
    if (tape.length > this.maxTapeSize) {
      tape.shift();
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

  getSwapVolume(
    mint: string,
    windowMs = 60_000
  ): { buyVolumeSol: number; sellVolumeSol: number; tradeCount: number } {
    const tape = this.tapeMap.get(mint);
    if (!tape || tape.length === 0) {
      return { buyVolumeSol: 0, sellVolumeSol: 0, tradeCount: 0 };
    }

    const cutoff = Date.now() - windowMs;
    let buyVolumeSol = 0;
    let sellVolumeSol = 0;
    let tradeCount = 0;

    for (const tick of tape) {
      if (tick.timestamp >= cutoff) {
        tradeCount++;
        if (tick.side === 'buy') {
          buyVolumeSol += tick.amountSol;
        } else {
          sellVolumeSol += tick.amountSol;
        }
      }
    }

    return { buyVolumeSol, sellVolumeSol, tradeCount };
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
