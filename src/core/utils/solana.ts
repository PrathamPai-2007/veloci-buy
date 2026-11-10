import { address, getProgramDerivedAddress, getAddressEncoder } from '@solana/addresses';
import { SolanaRpcApi } from '@solana/rpc';
import bs58 from 'bs58';
import { Context } from '#types/index.js';
import { safeJsonStringify, sleep } from './io.js';
import { PUMP_FUN_PROGRAM_ID } from '../constants.js';
import { RateLimitError, RpcError } from '../errors.js';
import { PRIORITY, TokenBucket, makePriorityTokenBucket, redactUrl } from './rate-limit.js';

export { PRIORITY };

export function normalizeLaunchpad(value: string): string {
  return String(value || 'unknown')
    .trim()
    .toLowerCase();
}

export function deriveWsRpcUrl(rpcUrl: string): string {
  try {
    const parsedUrl = new URL(rpcUrl);
    if (parsedUrl.protocol === 'https:') {
      parsedUrl.protocol = 'wss:';
      return parsedUrl.toString();
    }
    if (parsedUrl.protocol === 'http:') {
      parsedUrl.protocol = 'ws:';
      return parsedUrl.toString();
    }
    return rpcUrl;
  } catch {
    return rpcUrl;
  }
}

export function isTransientOperationError(error: unknown): boolean {
  const msg = String((error as { message?: string })?.message || error || '').toLowerCase();
  return (
    msg.includes('rate limit') ||
    msg.includes('429') ||
    msg.includes('503') ||
    msg.includes('504') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('too many requests') ||
    msg.includes('slippage') ||
    msg.includes('blockhash') ||
    msg.includes('simulation failed') ||
    msg.includes('custom program error')
  );
}

const RPC_CACHE_MAX_ENTRIES = 5000;

class ShortTermCache {
  private store = new Map<string, { value: unknown; expiresAt: number }>();

  set(key: string, value: unknown, ttlMs: number = 5000): void {
    if (this.store.size >= RPC_CACHE_MAX_ENTRIES) {
      const now = Date.now();
      for (const [k, entry] of this.store) {
        if (entry.expiresAt <= now) this.store.delete(k);
      }
      // Still full: evict oldest inserts (Map preserves insertion order).
      for (const k of this.store.keys()) {
        if (this.store.size < RPC_CACHE_MAX_ENTRIES) break;
        this.store.delete(k);
      }
    }
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  get(key: string): unknown | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  clear(): void {
    this.store.clear();
  }
}

const rpcCache = new ShortTermCache();

type RpcRequest<T> = {
  send: (options?: { abortSignal?: AbortSignal }) => Promise<T>;
};

function isRpcRequest<T>(value: unknown): value is RpcRequest<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'send' in value &&
    typeof value.send === 'function'
  );
}

type RpcMethod<TMethod extends keyof SolanaRpcApi> = (
  ...args: Parameters<SolanaRpcApi[TMethod]>
) =>
  | RpcRequest<ReturnType<SolanaRpcApi[TMethod]>>
  | ReturnType<SolanaRpcApi[TMethod]>
  | Promise<ReturnType<SolanaRpcApi[TMethod]>>;

export const RPC_MAX_REQUESTS_PER_SEC = 10;
export const RPC_MAX_SEND_TX_PER_SEC = 1;

export function setRpcRateLimits(rpcRateLimits: number[], sendTxLimits: number[]): void {
  // Called from bot startup after config is known; overrides per-endpoint creation.
  // Actual per-index buckets are lazy; we store overrides for acquireRpcToken to consult.
  perIndexRpcLimits = rpcRateLimits;
  perIndexSendTxLimits = sendTxLimits;
  // Reset buckets so next acquire picks up new rates (e.g. in tests)
  rpcBuckets.clear();
  sendTxBuckets.clear();
}

let perIndexRpcLimits: number[] | null = null;
let perIndexSendTxLimits: number[] | null = null;

const HEAVY_RPC_METHODS = new Set(['getTokenLargestAccounts', 'getProgramAccounts']);
const HEAVY_RPC_SPACING_MS = 300;
let heavyRpcQueue: Promise<void> = Promise.resolve();

/**
 * Runs `fn` while holding the single heavy-RPC slot: at most one heavy call in flight,
 * and the next one starts no sooner than 300ms after the previous one settled.
 */
export async function withHeavySlot<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new Error('Aborted before heavy RPC queue');
  const previous = heavyRpcQueue;
  let release: () => void = () => {};
  heavyRpcQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    setTimeout(release, HEAVY_RPC_SPACING_MS);
  }
}

// Per-endpoint token buckets, keyed by RPC pool index. The pool size isn't known at
// module load, so buckets are created lazily on first use for each index. Each RPC_URL
// entry is assumed to have its OWN rate limit: listing the same provider/key twice would
// let this issue 2× the rate against one key and earn 429s. Only add endpoints with
// independent limits.
// ponytail: per-index buckets, not per-provider; index keying is enough for a 1-2 endpoint
// setup. Revisit only if running many URLs that share a key.
const rpcBuckets = new Map<number, TokenBucket>();
const sendTxBuckets = new Map<number, TokenBucket>();

export function getRpcBucket(index: number): TokenBucket {
  let bucket = rpcBuckets.get(index);
  if (!bucket) {
    bucket = makePriorityTokenBucket(perIndexRpcLimits?.[index] ?? RPC_MAX_REQUESTS_PER_SEC);
    rpcBuckets.set(index, bucket);
  }
  return bucket;
}

function getSendTxBucket(index: number): TokenBucket {
  let bucket = sendTxBuckets.get(index);
  if (!bucket) {
    bucket = makePriorityTokenBucket(perIndexSendTxLimits?.[index] ?? RPC_MAX_SEND_TX_PER_SEC);
    sendTxBuckets.set(index, bucket);
  }
  return bucket;
}

/** A free-tier endpoint backed up by more than this lets LOW calls spill to an idle premium one. */
const LOW_SPILLOVER_WAIT_MS = 250;

/**
 * Picks the endpoint whose bucket would grant this request soonest, rotating through ties so
 * idle endpoints still share load. Plain round-robin queued calls on a busy or penalized
 * endpoint while another one had free tokens.
 */
export function pickLeastLoaded<T extends { index: number }>(
  candidates: T[],
  priority: PRIORITY,
  rotation: number
): T | undefined {
  if (candidates.length <= 1) return candidates[0];
  const waits = candidates.map((c) => getRpcBucket(c.index).estimateWaitMs(priority));
  const best = Math.min(...waits);
  // Treat waits within 50ms as a tie so a hair of difference doesn't pin all traffic to one node.
  const tied = candidates.filter((_, i) => waits[i]! <= best + 50);
  return tied[rotation % tied.length];
}

/** Penalty applied to an endpoint's bucket after the provider answers 429. */
const RPC_429_PENALTY_MS = 30_000;
const rpcInFlight = new Map<string, Promise<unknown>>();

export interface RpcEndpointHealth {
  index: number;
  url: string;
  rpcTier?: string;
  rpcRateLimit?: number;
  rpcSendTxRateLimit?: number;
  errorCount: number;
  rateLimitCount: number;
  totalRequests: number;
  avgLatencyMs: number;
  lastSuccessAt: number;
  lastErrorAt: number;
  isQuarantined: boolean;
}

interface RpcHealthEntry {
  errorCount: number;
  rateLimitCount: number;
  totalRequests: number;
  totalLatencyMs: number;
  lastSuccessAt: number;
  lastErrorAt: number;
}

const rpcHealth = new Map<number, RpcHealthEntry>();
let _rpcIndex = 0;

export function getRpcHealthStatus(ctx?: Context): RpcEndpointHealth[] {
  const rpcPool =
    ctx && Array.isArray(ctx.rpcs) && ctx.rpcs.length > 0 ? ctx.rpcs : ctx?.rpc ? [ctx.rpc] : [];
  const now = Date.now();
  const urls = ctx?.config?.rpcUrls || [];

  const tiers = (ctx?.config?.rpcTiers as string[] | undefined) || [];
  const limits = (ctx?.config?.rpcRateLimits as number[] | undefined) || [];
  const sendLimits = (ctx?.config?.rpcSendTxRateLimits as number[] | undefined) || [];
  const results: RpcEndpointHealth[] = [];
  const totalEntries = Math.max(rpcPool.length, rpcHealth.size, 1);

  for (let i = 0; i < totalEntries; i++) {
    const entry = rpcHealth.get(i) || {
      errorCount: 0,
      rateLimitCount: 0,
      totalRequests: 0,
      totalLatencyMs: 0,
      lastSuccessAt: 0,
      lastErrorAt: 0,
    };
    const isQuarantined = entry.errorCount >= 3 && now - entry.lastErrorAt <= 60000;
    const avgLatencyMs =
      entry.totalRequests > 0 ? Math.round(entry.totalLatencyMs / entry.totalRequests) : 0;
    results.push({
      index: i,
      url: urls[i] || `RPC #${i + 1}`,
      rpcTier: tiers[i],
      rpcRateLimit: limits[i],
      rpcSendTxRateLimit: sendLimits[i],
      errorCount: entry.errorCount,
      rateLimitCount: entry.rateLimitCount,
      totalRequests: entry.totalRequests,
      avgLatencyMs,
      lastSuccessAt: entry.lastSuccessAt,
      lastErrorAt: entry.lastErrorAt,
      isQuarantined,
    });
  }

  return results;
}

export async function rpcCall<TMethod extends keyof SolanaRpcApi>(
  ctx: Context,
  method: TMethod,
  params: Parameters<SolanaRpcApi[TMethod]> | [] = [] as unknown as Parameters<
    SolanaRpcApi[TMethod]
  >,
  options: {
    priority?: PRIORITY;
    maxAttempts?: number;
    cacheTtlMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {}
): Promise<ReturnType<SolanaRpcApi[TMethod]>> {
  if (options.signal?.aborted) {
    throw new Error('rpcCall aborted');
  }

  const cacheTtlMs = options.cacheTtlMs ?? 0;
  const cacheKey = cacheTtlMs > 0 ? `${String(method)}:${safeJsonStringify(params)}` : null;
  if (!cacheKey) return rpcCallUncached(ctx, method, params, options, null);

  const cached = rpcCache.get(cacheKey);
  if (cached !== null) return cached as ReturnType<SolanaRpcApi[TMethod]>;
  // Single-flight: identical cacheable reads share one request (and one bucket token).
  const inFlight = rpcInFlight.get(cacheKey);
  if (inFlight) return inFlight as Promise<ReturnType<SolanaRpcApi[TMethod]>>;
  const request = rpcCallUncached(ctx, method, params, options, cacheKey).finally(() => {
    rpcInFlight.delete(cacheKey);
  });
  rpcInFlight.set(cacheKey, request);
  return request;
}

async function rpcCallUncached<TMethod extends keyof SolanaRpcApi>(
  ctx: Context,
  method: TMethod,
  params: Parameters<SolanaRpcApi[TMethod]> | [],
  options: {
    priority?: PRIORITY;
    maxAttempts?: number;
    cacheTtlMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
  cacheKey: string | null
): Promise<ReturnType<SolanaRpcApi[TMethod]>> {
  const priority = options.priority ?? PRIORITY.MEDIUM;
  const maxAttempts = options.maxAttempts ?? 3;
  const cacheTtlMs = options.cacheTtlMs ?? 0;
  const timeoutMs = options.timeoutMs ?? 12000;
  let lastError: unknown = null;

  const currentRpc = ctx.getCurrentRpc?.() ?? ctx.rpc;
  const rpcPool =
    Array.isArray(ctx.rpcs) && ctx.rpcs.length > 0 ? ctx.rpcs : currentRpc ? [currentRpc] : [];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (options.signal?.aborted) {
      throw new Error('rpcCall aborted');
    }

    const now = Date.now();

    let candidates = rpcPool
      .map((rpc, index) => ({ rpc, index }))
      .filter(({ index }) => {
        const health = rpcHealth.get(index) || {
          errorCount: 0,
          rateLimitCount: 0,
          totalRequests: 0,
          totalLatencyMs: 0,
          lastSuccessAt: 0,
          lastErrorAt: 0,
        };
        return health.errorCount < 3 || now - health.lastErrorAt > 60000;
      });

    if (candidates.length === 0) {
      candidates = rpcPool.map((rpc, index) => ({ rpc, index }));
    }

    // Tier-aware sharding for Helius+public pool: HIGH/ULTRA/MEDIUM (monitor/exit/position curves) prefer premium,
    // LOW (scan curves) prefer free. Falls back to any if preferred tier has no healthy candidate.
    const tiers: ('premium' | 'free')[] | undefined = ctx.config?.rpcTiers as
      | ('premium' | 'free')[]
      | undefined;
    if (tiers) {
      if (tiers.length !== rpcPool.length && rpcPool.length > 0) {
        ctx.logger?.(
          `RPC tier/pool length mismatch (tiers=${tiers.length} pool=${rpcPool.length}); sharding disabled for this call.`,
          'warn'
        );
      } else if (candidates.length > 1) {
        const preferredTier: 'premium' | 'free' | null =
          priority === PRIORITY.LOW ? 'free' : 'premium';
        const tiered = candidates.filter(({ index }) => tiers[index] === preferredTier);
        if (tiered.length > 0) {
          const all = candidates;
          candidates = tiered;
          // Scan traffic normally stays on the free tier, but when that tier is backed up it may
          // use a premium endpoint that has nobody waiting (zero wait counts every queued call,
          // so a premium bucket with queued exits never qualifies).
          if (priority === PRIORITY.LOW) {
            const tieredWait = Math.min(
              ...tiered.map((c) => getRpcBucket(c.index).estimateWaitMs(priority))
            );
            const idle = all.filter(
              (c) => !tiered.includes(c) && getRpcBucket(c.index).estimateWaitMs(priority) === 0
            );
            if (tieredWait > LOW_SPILLOVER_WAIT_MS && idle.length > 0) candidates = idle;
          }
        }
      }
    }

    const selected = pickLeastLoaded(candidates, priority, _rpcIndex);
    if (!selected) {
      throw new Error('No RPC candidate selected.');
    }
    const { rpc, index } = selected;
    _rpcIndex++;

    const startTime = Date.now();

    try {
      if (method === ('sendTransaction' as keyof SolanaRpcApi)) {
        await getSendTxBucket(index).acquire(PRIORITY.ULTRA_HIGH, options.signal);
      }
      await getRpcBucket(index).acquire(priority, options.signal);

      const rpcMethod = rpc[method] as RpcMethod<TMethod>;
      const controller = new AbortController();
      let timeoutHandle: NodeJS.Timeout;
      const forwardAbort = (): void => controller.abort();
      options.signal?.addEventListener('abort', forwardAbort, { once: true });

      // Promise.race guarantees the timeout rejects even if .send() ignores the AbortSignal
      // (which @solana/kit can do under certain transports, causing silent 60s+ hangs).
      let result: ReturnType<SolanaRpcApi[TMethod]>;
      const send = async (): Promise<ReturnType<SolanaRpcApi[TMethod]>> => {
        // Timeout starts once the request is actually sent (not while queued for a slot).
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            controller.abort();
            reject(new Error(`rpcCall ${String(method)} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        });
        const response = rpcMethod(...(params as Parameters<SolanaRpcApi[TMethod]>));
        const sendPromise = isRpcRequest<ReturnType<SolanaRpcApi[TMethod]>>(response)
          ? response.send({ abortSignal: controller.signal })
          : Promise.resolve(response);
        // Prevent UnhandledPromiseRejection if send rejects after timeout wins
        sendPromise.catch(() => {});
        timeoutPromise.catch(() => {});
        return Promise.race([sendPromise, timeoutPromise]);
      };
      try {
        result = HEAVY_RPC_METHODS.has(String(method))
          ? await withHeavySlot(send, options.signal)
          : await send();
      } catch (e: unknown) {
        controller.abort();
        throw e;
      } finally {
        clearTimeout(timeoutHandle!);
        options.signal?.removeEventListener('abort', forwardAbort);
      }

      const latency = Date.now() - startTime;
      const stats = rpcHealth.get(index) || {
        errorCount: 0,
        rateLimitCount: 0,
        totalRequests: 0,
        totalLatencyMs: 0,
        lastSuccessAt: 0,
        lastErrorAt: 0,
      };
      stats.errorCount = 0;
      stats.totalRequests++;
      stats.totalLatencyMs += latency;
      stats.lastSuccessAt = Date.now();
      rpcHealth.set(index, stats);

      if (cacheKey) rpcCache.set(cacheKey, result, cacheTtlMs);
      return result as ReturnType<SolanaRpcApi[TMethod]>;
    } catch (e: unknown) {
      lastError = e;

      if (options.signal?.aborted) {
        throw new Error('rpcCall aborted', { cause: e });
      }

      const errMsg = String((e as { message?: string })?.message || e || '').toLowerCase();
      const isRateLimit =
        errMsg.includes('429') ||
        errMsg.includes('rate limit') ||
        errMsg.includes('too many requests');

      const stats = rpcHealth.get(index) || {
        errorCount: 0,
        rateLimitCount: 0,
        totalRequests: 0,
        totalLatencyMs: 0,
        lastSuccessAt: 0,
        lastErrorAt: 0,
      };
      stats.errorCount++;
      if (isRateLimit) {
        stats.rateLimitCount++;
        getRpcBucket(index).penalize(RPC_429_PENALTY_MS);
      }
      stats.lastErrorAt = Date.now();
      rpcHealth.set(index, stats);

      if (isTransientOperationError(e) && attempt < maxAttempts - 1) {
        if (candidates.length > 1) continue;

        const backoffMs = isRateLimit ? 1000 * Math.pow(2, attempt) : 500 * (attempt + 1);
        await sleep(backoffMs);
        continue;
      }

      if (isRateLimit) {
        throw new RateLimitError(
          `RPC rate limit exceeded on method ${String(method)}: ${redactUrl(String((e as Error)?.message || e))}`,
          1000 * Math.pow(2, attempt),
          e
        );
      }

      throw new RpcError(
        `RPC method ${String(method)} failed: ${redactUrl(String((e as Error)?.message || e))}`,
        index,
        e
      );
    }
  }
  throw lastError;
}

export function decodePumpCurve(buffer: Buffer): {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  totalSupply: bigint;
  isCompleted: boolean;
  creator?: string;
} | null {
  if (!buffer || buffer.length < 49) return null;
  return {
    virtualTokenReserves: buffer.readBigUInt64LE(8),
    virtualSolReserves: buffer.readBigUInt64LE(16),
    realTokenReserves: buffer.readBigUInt64LE(24),
    realSolReserves: buffer.readBigUInt64LE(32),
    totalSupply: buffer.readBigUInt64LE(40),
    isCompleted: buffer.readUInt8(48) === 1,
    creator: buffer.length >= 81 ? bs58.encode(buffer.subarray(49, 81)) : undefined,
  };
}

export function decodeRaydiumPool(buffer: Buffer): {
  baseVault: string;
  quoteVault: string;
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  nonce: number;
  needTakePnlCoin: bigint;
  needTakePnlPc: bigint;
} | null {
  if (!buffer || buffer.length < 752) return null;
  // AMM V4 layout (native program, no Anchor discriminator):
  // offset 8: nonce (u8 stored in low byte of u64)
  // offset 32/40: base/quote decimals
  // offset 192: needTakePnlCoin (u64), 200: needTakePnlPc (u64)
  // offset 336/368: coin/pc vaults, 400/432: coin/pc mints
  const nonce = buffer.readUInt8(8);
  const baseDecimals = Number(buffer.readBigUInt64LE(32));
  const quoteDecimals = Number(buffer.readBigUInt64LE(40));
  const needTakePnlCoin = buffer.readBigUInt64LE(192);
  const needTakePnlPc = buffer.readBigUInt64LE(200);
  const baseVault = buffer.subarray(336, 368);
  const quoteVault = buffer.subarray(368, 400);
  const baseMint = buffer.subarray(400, 432);
  const quoteMint = buffer.subarray(432, 464);

  return {
    baseVault: address(bs58.encode(new Uint8Array(baseVault))),
    quoteVault: address(bs58.encode(new Uint8Array(quoteVault))),
    baseMint: address(bs58.encode(new Uint8Array(baseMint))),
    quoteMint: address(bs58.encode(new Uint8Array(quoteMint))),
    baseDecimals,
    quoteDecimals,
    nonce,
    needTakePnlCoin,
    needTakePnlPc,
  };
}

/**
 * Decodes a Meteora DLMM LbPair account to extract price and liquidity data.
 *
 * LbPair binary layout (Anchor, 8-byte discriminator prefix):
 *   offset   8 — StaticParameters (32 bytes)
 *   offset  40 — VariableParameters (32 bytes)
 *   offset  72 — bumpSeed [u8; 1]
 *   offset  73 — binStepSeed [u8; 2]
 *   offset  75 — pairType u8
 *   offset  76 — activeId i32  (current price bin)
 *   offset  80 — binStep u16   (basis points per bin step)
 *   offset  82 — status u8
 *   offset  83 — requireBaseFactorSeed u8
 *   offset  84 — baseFactorSeed [u8; 2]
 *   offset  86 — _padding1 [u8; 2]
 *   offset  88 — tokenXMint Pubkey (32)
 *   offset 120 — tokenYMint Pubkey (32)
 *   offset 152 — reserveX Pubkey (32)
 *   offset 184 — reserveY Pubkey (32)
 *
 * Verify offsets against a live account if layout ever changes:
 *   solana account <lb_pair_pubkey> --output json | python3 -c "import sys,json,base64; d=json.load(sys.stdin); b=base64.b64decode(d['account']['data'][0]); print(len(b))"
 */
export function decodeMeteoraPool(buffer: Buffer): {
  tokenXMint: string;
  tokenYMint: string;
  reserveX: string;
  reserveY: string;
  activeId: number;
  binStep: number;
  baseFactor: number;
} | null {
  if (!buffer || buffer.length < 216) return null;
  try {
    // LbPair layout (Anchor, 8-byte discriminator prefix):
    // offset  8: StaticParameters — first field is baseFactor (u16)
    // offset 76: activeId (i32), 80: binStep (u16)
    // offset 88/120/152/184: tokenXMint, tokenYMint, reserveX, reserveY
    const baseFactor = buffer.readUInt16LE(8);
    const activeId = buffer.readInt32LE(76);
    const binStep = buffer.readUInt16LE(80);
    if (binStep === 0) return null;
    const tokenXMint = address(bs58.encode(new Uint8Array(buffer.subarray(88, 120))));
    const tokenYMint = address(bs58.encode(new Uint8Array(buffer.subarray(120, 152))));
    const reserveX = address(bs58.encode(new Uint8Array(buffer.subarray(152, 184))));
    const reserveY = address(bs58.encode(new Uint8Array(buffer.subarray(184, 216))));
    return { tokenXMint, tokenYMint, reserveX, reserveY, activeId, binStep, baseFactor };
  } catch {
    return null;
  }
}

export async function derivePumpCurvePda(mint: string): Promise<string> {
  const cacheKey = `pump_curve_pda:${mint}`;
  const cached = rpcCache.get(cacheKey);
  if (typeof cached === 'string') {
    return cached;
  }

  try {
    const programId = address(PUMP_FUN_PROGRAM_ID);
    const mintAddress = address(mint);

    const [pda] = await getProgramDerivedAddress({
      programAddress: programId,
      seeds: [new TextEncoder().encode('bonding-curve'), getAddressEncoder().encode(mintAddress)],
    });

    if (pda) {
      rpcCache.set(cacheKey, pda, 300_000); // 5 min TTL (curve PDAs are immutable)
    }
    return pda;
  } catch {
    return '';
  }
}
