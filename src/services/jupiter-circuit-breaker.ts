import { Context } from '#types/index.js';
import { isRateLimitError } from '#core/utils/fetch.js';

/** A 429 opens the circuit at once for this long; the next call is a single probe. */
const RATE_LIMIT_COOLDOWN_MS = 30_000;

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface JupiterCircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  nowFn?: () => number;
}

export class JupiterCircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private failureThreshold: number;
  private baseCooldownMs: number;
  private currentCooldownMs: number;
  private openedAt: number | null = null;
  private probeInFlight = false;
  private lastThrottledDebugLogAt = 0;
  private backoffMultiplier = 1;
  private getNow: () => number;

  constructor(options?: JupiterCircuitBreakerOptions) {
    this.failureThreshold = options?.failureThreshold ?? 3;
    this.baseCooldownMs = options?.cooldownMs ?? 60_000;
    this.currentCooldownMs = this.baseCooldownMs;
    this.getNow = options?.nowFn ?? (() => Date.now());
  }

  public setNowFn(fn?: () => number): void {
    this.getNow = fn ?? (() => Date.now());
  }

  public getState(): CircuitState {
    if (this.state === 'OPEN' && this.openedAt !== null) {
      if (this.getNow() - this.openedAt >= this.currentCooldownMs) {
        this.state = 'HALF_OPEN';
      }
    }
    return this.state;
  }

  public getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  public getCurrentCooldownMs(): number {
    return this.currentCooldownMs;
  }

  public configure(options: JupiterCircuitBreakerOptions): void {
    if (options.failureThreshold !== undefined) {
      this.failureThreshold = options.failureThreshold;
    }
    if (options.cooldownMs !== undefined) {
      this.baseCooldownMs = options.cooldownMs;
      this.currentCooldownMs = options.cooldownMs;
    }
    if (options.nowFn !== undefined) {
      this.getNow = options.nowFn;
    }
  }

  public reset(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.probeInFlight = false;
    this.backoffMultiplier = 1;
    this.currentCooldownMs = this.baseCooldownMs;
    this.lastThrottledDebugLogAt = 0;
  }

  public canExecute(ctx?: Context): { allowed: boolean; isProbe: boolean } {
    const currentState = this.getState();

    if (currentState === 'CLOSED') {
      return { allowed: true, isProbe: false };
    }

    if (currentState === 'OPEN') {
      this.recordSuppression(ctx);
      this.maybeLogThrottledDebug(ctx);
      return { allowed: false, isProbe: false };
    }

    // HALF_OPEN
    if (!this.probeInFlight) {
      this.probeInFlight = true;
      if (ctx) {
        ctx.store.incrementMetric('jupiterCircuitProbes', 1);
      }
      return { allowed: true, isProbe: true };
    } else {
      this.recordSuppression(ctx);
      return { allowed: false, isProbe: false };
    }
  }

  public recordRequest(ctx?: Context): void {
    if (ctx) {
      ctx.store.incrementMetric('jupiterDiscoveryRequests', 1);
    }
  }

  public recordSuccess(ctx?: Context): void {
    this.consecutiveFailures = 0;
    if (ctx) {
      ctx.store.updateMetric('consecutiveJupiterFailures', 0);
    }

    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED';
      this.probeInFlight = false;
      this.backoffMultiplier = 1;
      this.currentCooldownMs = this.baseCooldownMs;
      if (ctx) {
        ctx.store.incrementMetric('jupiterCircuitCloses', 1);
        ctx.logger('Jupiter discovery circuit CLOSED (probe succeeded).', 'info');
      }
    } else if (this.state === 'CLOSED') {
      this.backoffMultiplier = 1;
      this.currentCooldownMs = this.baseCooldownMs;
    }
  }

  public recordFailure(ctx?: Context, error?: unknown): void {
    this.consecutiveFailures++;
    if (ctx) {
      ctx.store.incrementMetric('jupiterDiscoveryTimeouts', 1);
      ctx.store.updateMetric('consecutiveJupiterFailures', this.consecutiveFailures);
    }

    if (this.state === 'CLOSED' && error !== undefined && isRateLimitError(error)) {
      this.state = 'OPEN';
      this.openedAt = this.getNow();
      this.currentCooldownMs = Math.min(this.baseCooldownMs, RATE_LIMIT_COOLDOWN_MS);
      if (ctx) {
        ctx.store.incrementMetric('jupiterCircuitOpens', 1);
        ctx.logger(
          `Jupiter rate-limited (429); circuit OPEN for ${this.currentCooldownMs / 1000}s (on-chain fallback in use).`,
          'warn'
        );
      }
      return;
    }

    if (this.state === 'HALF_OPEN') {
      this.probeInFlight = false;
      // Exponential backoff with jitter around HALF_OPEN probe failure
      this.backoffMultiplier = Math.min(this.backoffMultiplier * 2, 8);
      const jitter = Math.random() * 0.2 - 0.1; // +/- 10%
      this.currentCooldownMs = Math.round(
        this.baseCooldownMs * this.backoffMultiplier * (1 + jitter)
      );

      this.state = 'OPEN';
      this.openedAt = this.getNow();
      if (ctx) {
        ctx.store.incrementMetric('jupiterCircuitOpens', 1);
        const secs = Math.round(this.currentCooldownMs / 1000);
        ctx.logger(`Jupiter discovery circuit OPEN; suppressing requests for ${secs}s`, 'warn');
      }
    } else if (this.state === 'CLOSED') {
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.state = 'OPEN';
        this.openedAt = this.getNow();
        this.currentCooldownMs = this.baseCooldownMs;
        if (ctx) {
          ctx.store.incrementMetric('jupiterCircuitOpens', 1);
          const secs = Math.round(this.currentCooldownMs / 1000);
          ctx.logger(`Jupiter discovery circuit OPEN; suppressing requests for ${secs}s`, 'warn');
        }
      }
    }
  }

  private recordSuppression(ctx?: Context): void {
    if (ctx) {
      ctx.store.incrementMetric('jupiterSuppressedRequests', 1);
    }
  }

  private maybeLogThrottledDebug(ctx?: Context): void {
    if (!ctx) return;
    const now = this.getNow();
    if (now - this.lastThrottledDebugLogAt >= this.currentCooldownMs) {
      this.lastThrottledDebugLogAt = now;
      ctx.logger('Jupiter discovery circuit OPEN; suppressing request.', 'debug');
    }
  }

  public async execute<T>(
    ctx: Context,
    requestFn: () => Promise<T>,
    fallback: T | (() => T)
  ): Promise<T> {
    this.recordRequest(ctx);
    const { allowed } = this.canExecute(ctx);
    if (!allowed) {
      return typeof fallback === 'function' ? (fallback as () => T)() : fallback;
    }
    try {
      const res = await requestFn();
      this.recordSuccess(ctx);
      return res;
    } catch (err) {
      this.recordFailure(ctx, err);
      return typeof fallback === 'function' ? (fallback as () => T)() : fallback;
    }
  }
}

/** Discovery/scan traffic (recent, trending, scan-path prices). */
export const jupiterDiscoveryBreaker = new JupiterCircuitBreaker();
/** Monitor/exit traffic on the position key; never tripped by discovery failures. */
export const jupiterPositionBreaker = new JupiterCircuitBreaker();
