import type { Context } from '#types/index.js';

export enum PRIORITY {
  ULTRA_HIGH = 0,
  HIGH = 1,
  MEDIUM = 2,
  LOW = 3,
}

const PRIORITY_ORDER = [PRIORITY.ULTRA_HIGH, PRIORITY.HIGH, PRIORITY.MEDIUM, PRIORITY.LOW];

export interface TokenBucket {
  /** Resolves when a token is granted; higher priorities are always served first. */
  acquire(priority?: PRIORITY, signal?: AbortSignal): Promise<void>;
  /** Halves the refill rate for `ms` (call on an upstream 429). */
  penalize(ms: number): void;
  /** Estimated ms until a request at `priority` would be granted (0 = immediately). */
  estimateWaitMs(priority?: PRIORITY): number;
}

/**
 * Priority token bucket: capacity = one second of tokens, refilled continuously.
 * Waiters are queued per priority so latency-critical calls (exits) never wait behind scans.
 */
export function makePriorityTokenBucket(ratePerSec: number): TokenBucket {
  const capacity = Math.max(1, ratePerSec);
  let tokens = capacity;
  let lastRefillAt = Date.now();
  let penaltyUntil = 0;

  type QueueItem = { resolve: () => void; reject: (e: Error) => void; signal?: AbortSignal };
  const queues: Record<PRIORITY, QueueItem[]> = {
    [PRIORITY.ULTRA_HIGH]: [],
    [PRIORITY.HIGH]: [],
    [PRIORITY.MEDIUM]: [],
    [PRIORITY.LOW]: [],
  };

  const intervalMs = (): number => {
    const rate = Date.now() < penaltyUntil ? ratePerSec / 2 : ratePerSec;
    return 1000 / rate;
  };

  const refill = (): void => {
    const now = Date.now();
    const step = intervalMs();
    const refilled = Math.floor((now - lastRefillAt) / step);
    if (refilled > 0) {
      tokens = Math.min(capacity, tokens + refilled);
      lastRefillAt += refilled * step;
    }
  };

  let timerId: NodeJS.Timeout | null = null;

  const processQueues = (): void => {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    refill();

    while (tokens >= 1) {
      const p = PRIORITY_ORDER.find((pri) => queues[pri].length > 0);
      if (p === undefined) break;
      tokens -= 1;
      queues[p].shift()?.resolve();
    }

    if (PRIORITY_ORDER.some((pri) => queues[pri].length > 0)) {
      const msUntilNext = Math.max(1, intervalMs() - (Date.now() - lastRefillAt));
      timerId = setTimeout(processQueues, msUntilNext);
    }
  };

  return {
    acquire(priority: PRIORITY = PRIORITY.MEDIUM, signal?: AbortSignal): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('Aborted before queue'));

        const onAbort = (): void => {
          const q = queues[priority];
          const idx = q.indexOf(item);
          if (idx !== -1) q.splice(idx, 1);
          reject(new Error('Aborted in queue'));
        };
        const item: QueueItem = {
          resolve: () => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          },
          reject,
          signal,
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        queues[priority].push(item);
        processQueues();
      });
    },
    penalize(ms: number): void {
      refill();
      penaltyUntil = Math.max(penaltyUntil, Date.now() + ms);
    },
    estimateWaitMs(priority: PRIORITY = PRIORITY.MEDIUM): number {
      refill();
      // Waiters at this priority or higher are served before us.
      const ahead = PRIORITY_ORDER.filter((p) => p <= priority).reduce(
        (n, p) => n + queues[p].length,
        0
      );
      const missing = ahead + 1 - tokens;
      if (missing <= 0) return 0;
      const step = intervalMs();
      return Math.max(0, Math.ceil(missing) * step - (Date.now() - lastRefillAt));
    },
  };
}

const namedBuckets = new Map<string, { rate: number; bucket: TokenBucket }>();

/** Returns the shared bucket for `key`, creating it (or replacing it if the rate changed). */
export function getBucket(key: string, ratePerSec: number): TokenBucket {
  const existing = namedBuckets.get(key);
  if (existing && existing.rate === ratePerSec) return existing.bucket;
  const bucket = makePriorityTokenBucket(ratePerSec);
  namedBuckets.set(key, { rate: ratePerSec, bucket });
  return bucket;
}

/** @testOnly */
export function _resetBucketsForTest(): void {
  namedBuckets.clear();
}

/**
 * Strips secrets from a URL or message: query strings, Telegram `/bot<token>`, Discord webhook
 * tokens and `api-key=` pairs.
 */
export function redactUrl(text: string): string {
  return text
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/g, '$1?<redacted>')
    .replace(/\/bot[0-9]+:[A-Za-z0-9_-]+/g, '/bot<redacted>')
    .replace(/\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/g, '/api/webhooks/<redacted>')
    .replace(/(api[-_]?key=)[^&\s]+/gi, '$1<redacted>');
}

/**
 * Jupiter limits per organisation, so each distinct API key gets its own bucket; when the
 * discovery and position keys are the same they share one, and priority keeps exits first.
 */
export function jupiterRateLimit(
  ctx: Context,
  apiKey: string,
  priority: PRIORITY
): { key: string; rps: number; priority: PRIORITY } {
  return { key: `jup:${apiKey}`, rps: ctx.config.jupiterRps || 1, priority };
}

export function jitoRateLimit(
  ctx: Context,
  priority: PRIORITY
): { key: string; rps: number; priority: PRIORITY } {
  return { key: 'jito', rps: ctx.config.jitoRps || 1, priority };
}
