import https from 'node:https';
import { safeJsonStringify, sleep } from './io.js';
import { RateLimitError } from '../errors.js';
import { PRIORITY, getBucket, redactUrl } from './rate-limit.js';

// Declare require for compiler compatibility in CommonJS compilation target
declare const require: (id: string) => unknown;

const keepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 25,
  maxFreeSockets: 10,
});
let fetchTransportOptionName = 'agent';
let fetchTransportOptionValue: unknown = keepAliveAgent;
try {
  const undici = require('undici') as { Agent: new (options: Record<string, unknown>) => unknown };
  fetchTransportOptionName = 'dispatcher';
  fetchTransportOptionValue = new undici.Agent({
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 30_000,
    connections: 25,
  });
} catch {}

function isAbortError(error: unknown): boolean {
  return (
    (error as { name?: string })?.name === 'AbortError' ||
    /aborted/i.test(String((error as { message?: string })?.message || ''))
  );
}

function isTransientFetchError(error: unknown): boolean {
  const message = String((error as { message?: string })?.message || '');
  return (
    isAbortError(error) ||
    /fetch failed/i.test(message) ||
    /ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|socket hang up/i.test(message) ||
    /HTTP 408|HTTP 425|HTTP 429|HTTP 500|HTTP 502|HTTP 503|HTTP 504/i.test(message)
  );
}

function formatFetchError(url: string, error: unknown, timeoutMs: number): string {
  const safeUrl = redactUrl(url);
  if (isAbortError(error)) return `Request timed out after ${timeoutMs}ms for ${safeUrl}`;
  const message = redactUrl(String((error as { message?: string })?.message || ''));
  if (message.includes(safeUrl)) return message;
  return `Request failed for ${safeUrl}: ${message}`;
}

/**
 * Coalesces concurrent calls to an async function onto a single in-flight Promise.
 */
export function coalesce<T>(
  fn: () => Promise<T>,
  getInFlight: () => Promise<T> | null,
  setInFlight: (promise: Promise<T> | null) => void
): Promise<T> {
  const existing = getInFlight();
  if (existing) return existing;
  const promise = fn().finally(() => {
    setInFlight(null);
  });
  setInFlight(promise);
  return promise;
}

export function isRateLimitError(e: unknown): boolean {
  return /\b429\b|too many requests/i.test(e instanceof Error ? e.message : String(e));
}

export async function fetchJson<T = unknown>(
  url: string,
  options: {
    timeoutMs?: number;
    retries?: number;
    retryDelayMs?: number;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    /** Shared token bucket for this upstream; a token is taken before EVERY attempt. */
    rateLimit?: { key: string; rps: number; priority?: PRIORITY };
  } = {}
): Promise<T> {
  const bucket = options.rateLimit ? getBucket(options.rateLimit.key, options.rateLimit.rps) : null;
  const safeUrl = redactUrl(url);
  const timeoutMs = options.timeoutMs || 15000;
  const retries = options.retries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 750;
  const headers = { Accept: 'application/json', ...(options.headers || {}) };

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (bucket) await bucket.acquire(options.rateLimit?.priority ?? PRIORITY.MEDIUM);
    const controller = new AbortController();
    // Promise.race guarantees the timeout rejects even if fetch / the undici transport
    // stalls on the body read and does not actively honor the AbortSignal.
    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error(`Request timed out after ${timeoutMs}ms for ${safeUrl}`));
      }, timeoutMs);
    });
    try {
      const fetchOptions: RequestInit & { [key: string]: unknown } = {
        method: options.method || 'GET',
        headers,
        body: options.body ? safeJsonStringify(options.body) : undefined,
        signal: controller.signal,
      };
      if (fetchTransportOptionName) {
        fetchOptions[fetchTransportOptionName] = fetchTransportOptionValue;
      }

      const fetchTask = fetch(url, fetchOptions);
      fetchTask.catch(() => {});
      const response = await Promise.race([fetchTask, timeoutPromise]);
      const textTask = response.text();
      textTask.catch(() => {});
      const text = await Promise.race([textTask, timeoutPromise]);
      let data: T | null = null;
      if (text) {
        try {
          data = JSON.parse(text) as T;
        } catch (e: unknown) {
          throw new Error(
            `Failed to parse JSON from ${safeUrl}: ${e instanceof Error ? e.message : String(e)}`,
            {
              cause: e,
            }
          );
        }
      }
      if (!response.ok) {
        const details = data ? safeJsonStringify(data) : text || '(empty body)';
        if (response.status === 429) {
          bucket?.penalize(30_000);
          throw new RateLimitError(
            `HTTP 429 Rate Limit for ${safeUrl}: ${details}`,
            retryDelayMs * Math.pow(2, attempt)
          );
        }
        throw new Error(`HTTP ${response.status} for ${safeUrl}: ${details}`);
      }
      if (data === null) {
        // A successful response with no body cannot be deserialized; treat as an error
        // so callers always receive a valid T rather than a type-unsafe null cast.
        throw new Error(`Empty response body from ${safeUrl}`);
      }
      return data as T;
    } catch (error: unknown) {
      clearTimeout(timeoutId);
      lastError = error;
      if (attempt >= retries || !isTransientFetchError(error)) {
        if (isRateLimitError(error) || error instanceof RateLimitError) {
          throw error instanceof RateLimitError
            ? error
            : new RateLimitError(
                formatFetchError(url, error, timeoutMs),
                retryDelayMs * Math.pow(2, attempt),
                error
              );
        }
        throw new Error(formatFetchError(url, error, timeoutMs), { cause: error });
      }
      const backoffMs = isRateLimitError(error)
        ? retryDelayMs * Math.pow(2, attempt + 1)
        : retryDelayMs * (attempt + 1);
      await sleep(backoffMs);
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw new Error(
    formatFetchError(url, lastError || new Error('Unknown fetch failure'), timeoutMs),
    { cause: lastError }
  );
}
