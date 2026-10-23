import { Config } from '#types/index.js';

export interface BackpressureEvent {
  error: boolean;
  at: number;
}

/**
 * Manages scan backpressure calculation based on sliding window error rates.
 */
export class ScanBackpressureManager {
  public events: BackpressureEvent[] = [];
  public factor = 1;

  /**
   * Tracks an RPC error event and recalculates the backpressure factor.
   * @param error - The error object or null/undefined if success.
   * @param config - Application configuration settings.
   */
  public recordEvent(error: unknown, config: Config): void {
    const windowSize = Math.max(1, Math.floor(config.errorRateWindow || 20));
    this.events.push({ error: Boolean(error), at: Date.now() });

    while (this.events.length > windowSize) {
      this.events.shift();
    }

    const errorCount = this.events.filter((event) => event.error).length;
    const errorRate = errorCount / this.events.length;
    const minFactor = Math.min(1, Math.max(0.1, Number(config.parallelismMinFactor || 0.5)));

    this.factor = errorRate >= Number(config.backpressureErrorRateThreshold || 0.3) ? minFactor : 1;
  }

  /**
   * Calculates effective parallelism scaled by backpressure factor.
   * @param base - Target base parallelism count.
   * @returns Health-adjusted parallelism count.
   */
  public getEffectiveParallelism(base: number): number {
    const numericBase = Math.max(1, Math.floor(Number(base) || 1));
    return Math.max(1, Math.floor(numericBase * this.factor));
  }
}
