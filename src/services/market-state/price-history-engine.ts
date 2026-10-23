import { PricePoint } from './market-state.types.js';

export class RingBuffer<T> {
  private buffer: T[];
  private head = 0;
  private size = 0;

  constructor(private readonly capacity: number) {
    this.buffer = new Array<T>(capacity);
  }

  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) {
      this.size++;
    }
  }

  toArray(): T[] {
    const result: T[] = [];
    if (this.size === 0) return result;
    const start = this.size < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.size; i++) {
      const idx = (start + i) % this.capacity;
      result.push(this.buffer[idx]!);
    }
    return result;
  }

  get length(): number {
    return this.size;
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
  }
}

export class PriceHistoryEngine {
  private readonly buffers = new Map<string, RingBuffer<PricePoint>>();
  private readonly maxCapacity: number;

  constructor(maxCapacity = 300) {
    // Stores up to 300 data points per token (~5 mins at 1s intervals)
    this.maxCapacity = maxCapacity;
  }

  pushPrice(mint: string, slot: number, price: number, timestamp = Date.now()): void {
    let buf = this.buffers.get(mint);
    if (!buf) {
      buf = new RingBuffer<PricePoint>(this.maxCapacity);
      this.buffers.set(mint, buf);
    }
    buf.push({ timestamp, slot, price });
  }

  getPriceHistory(mint: string): PricePoint[] {
    const buf = this.buffers.get(mint);
    return buf ? buf.toArray() : [];
  }

  /**
   * Returns fractional price return over the specified window in milliseconds:
   * (P_current - P_windowStart) / P_windowStart
   */
  getMomentum(mint: string, windowMs = 60_000): number {
    const history = this.getPriceHistory(mint);
    if (history.length < 2) return 0;

    const latest = history[history.length - 1]!;
    const current = latest.price;
    const targetTime = latest.timestamp - windowMs;

    const pastPoint = history.find((p) => p.timestamp >= targetTime) ?? history[0]!;
    if (pastPoint.price <= 0) return 0;

    return (current - pastPoint.price) / pastPoint.price;
  }

  /**
   * Returns price velocity ($/sec) over the specified window.
   */
  getVelocity(mint: string, windowMs = 10_000): number {
    const history = this.getPriceHistory(mint);
    if (history.length < 2) return 0;

    const current = history[history.length - 1]!;
    const past = history.find((p) => current.timestamp - p.timestamp >= windowMs) ?? history[0]!;
    const elapsedSec = (current.timestamp - past.timestamp) / 1000;
    if (elapsedSec <= 0) return 0;

    return (current.price - past.price) / elapsedSec;
  }

  /**
   * Returns rolling volatility (standard deviation of fractional returns) over window.
   */
  getVolatility(mint: string, windowMs = 60_000): number {
    const history = this.getPriceHistory(mint);
    if (history.length < 3) return 0;

    const cutoff = Date.now() - windowMs;
    const windowPoints = history.filter((p) => p.timestamp >= cutoff);
    if (windowPoints.length < 3) return 0;

    const returns: number[] = [];
    for (let i = 1; i < windowPoints.length; i++) {
      const prev = windowPoints[i - 1]!.price;
      const curr = windowPoints[i]!.price;
      if (prev > 0) {
        returns.push((curr - prev) / prev);
      }
    }

    if (returns.length < 2) return 0;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance =
      returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1);

    return Math.sqrt(variance);
  }

  clear(mint?: string): void {
    if (mint) {
      this.buffers.delete(mint);
    } else {
      this.buffers.clear();
    }
  }
}

export const priceHistoryEngine = new PriceHistoryEngine();
