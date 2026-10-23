import { LiquidityPoint } from './market-state.types.js';
import { RingBuffer } from './price-history-engine.js';

export interface LiquidityCollapseEvent {
  mint: string;
  previousUsd: number;
  currentUsd: number;
  dropPercentage: number;
  detectedAt: number;
}

export class LiquidityEngine {
  private readonly liquidityBuffers = new Map<string, RingBuffer<LiquidityPoint>>();

  pushLiquidity(
    mint: string,
    liquidityUsd: number,
    timestamp = Date.now()
  ): LiquidityCollapseEvent | null {
    let buf = this.liquidityBuffers.get(mint);
    if (!buf) {
      buf = new RingBuffer<LiquidityPoint>(100);
      this.liquidityBuffers.set(mint, buf);
    }

    const history = buf.toArray();
    buf.push({ timestamp, liquidityUsd });

    if (history.length === 0) return null;

    const initial = history[0]!.liquidityUsd;
    if (initial <= 0) return null;

    const dropPercentage = ((initial - liquidityUsd) / initial) * 100;

    // Detect collapse: >30% liquidity drop from peak/initial in buffer
    if (dropPercentage >= 30) {
      return {
        mint,
        previousUsd: initial,
        currentUsd: liquidityUsd,
        dropPercentage,
        detectedAt: timestamp,
      };
    }

    return null;
  }

  getLiquidityHistory(mint: string): LiquidityPoint[] {
    const buf = this.liquidityBuffers.get(mint);
    return buf ? buf.toArray() : [];
  }

  clear(mint?: string): void {
    if (mint) {
      this.liquidityBuffers.delete(mint);
    } else {
      this.liquidityBuffers.clear();
    }
  }
}

export const liquidityEngine = new LiquidityEngine();
