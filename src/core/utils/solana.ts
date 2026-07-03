import { address, getProgramDerivedAddress, getAddressEncoder } from '@solana/addresses';
import { SolanaRpcApi } from '@solana/rpc';
import bs58 from 'bs58';
import { Context } from '#types/index.js';
import { safeJsonStringify, sleep } from './io.js';
import { PUMP_FUN_PROGRAM_ID } from '../constants.js';

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

export enum PRIORITY {
  ULTRA_HIGH = 0,
  HIGH = 1,
  MEDIUM = 2,
  LOW = 3,
}

class ShortTermCache {
  private store = new Map<string, { value: unknown; expiresAt: number }>();

  set(key: string, value: unknown, ttlMs: number = 5000): void {
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

function makePriorityTokenBucket(
  ratePerSec: number
): (priority?: PRIORITY, signal?: AbortSignal) => Promise<void> {
  const intervalMs = 1000 / ratePerSec;
  let tokens = ratePerSec;
  let lastRefillAt = Date.now();

  type QueueItem = { resolve: () => void; reject: (e: Error) => void; signal?: AbortSignal };

  const queues: Record<PRIORITY, QueueItem[]> = {
    [PRIORITY.ULTRA_HIGH]: [],
    [PRIORITY.HIGH]: [],
    [PRIORITY.MEDIUM]: [],
    [PRIORITY.LOW]: [],
  };

  const refill = (): void => {
    const now = Date.now();
    const elapsed = now - lastRefillAt;
    const refilled = Math.floor(elapsed / intervalMs);
    if (refilled > 0) {
      tokens = Math.min(ratePerSec, tokens + refilled);
      lastRefillAt += refilled * intervalMs;
    }
  };

  const processQueues = (): void => {
    refill();

    // Clear any items that were aborted while waiting
    for (const pri of [PRIORITY.ULTRA_HIGH, PRIORITY.HIGH, PRIORITY.MEDIUM, PRIORITY.LOW]) {
      const q = queues[pri as PRIORITY];
      for (let i = q.length - 1; i >= 0; i--) {
        if (q[i]?.signal?.aborted) {
          const item = q.splice(i, 1)[0];
          item?.reject(new Error('Aborted in queue'));
        }
      }
    }

    while (tokens >= 1) {
      const p = [PRIORITY.ULTRA_HIGH, PRIORITY.HIGH, PRIORITY.MEDIUM, PRIORITY.LOW].find(
        (pri) => queues[pri as PRIORITY].length > 0
      );
      if (p === undefined) break;

      tokens -= 1;
      const item = queues[p as PRIORITY].shift();
      if (item) item.resolve();
    }

    const hasWaiters = Object.values(queues).some((q) => q.length > 0);
    if (hasWaiters) {
      const msUntilNext = Math.max(1, intervalMs - (Date.now() - lastRefillAt));
      setTimeout(processQueues, msUntilNext);
    }
  };

  return function acquireToken(
    priority: PRIORITY = PRIORITY.MEDIUM,
    signal?: AbortSignal
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        return reject(new Error('Aborted before queue'));
      }

      const item: QueueItem = { resolve, reject, signal };

      if (signal) {
        const onAbort = () => {
          const q = queues[priority];
          const idx = q.indexOf(item);
          if (idx !== -1) {
            q.splice(idx, 1);
          }
          reject(new Error('Aborted in queue'));
          signal.removeEventListener('abort', onAbort);
        };
        signal.addEventListener('abort', onAbort);
      }

      queues[priority].push(item);
      processQueues();
    });
  };
}

const RPC_MAX_REQUESTS_PER_SEC = 10;
const RPC_MAX_SEND_TX_PER_SEC = 1;

// Per-endpoint token buckets, keyed by RPC pool index. The pool size isn't known at
// module load, so buckets are created lazily on first use for each index. Each RPC_URL
// entry is assumed to have its OWN rate limit: listing the same provider/key twice would
// let this issue 2× the rate against one key and earn 429s. Only add endpoints with
// independent limits.
// ponytail: per-index buckets, not per-provider; index keying is enough for a 1-2 endpoint
// setup. Revisit only if running many URLs that share a key.
const rpcBuckets = new Map<number, (priority?: PRIORITY, signal?: AbortSignal) => Promise<void>>();
const sendTxBuckets = new Map<
  number,
  (priority?: PRIORITY, signal?: AbortSignal) => Promise<void>
>();

function acquireRpcToken(index: number, priority?: PRIORITY, signal?: AbortSignal): Promise<void> {
  let bucket = rpcBuckets.get(index);
  if (!bucket) {
    bucket = makePriorityTokenBucket(RPC_MAX_REQUESTS_PER_SEC);
    rpcBuckets.set(index, bucket);
  }
  return bucket(priority, signal);
}

function acquireSendTxToken(
  index: number,
  priority?: PRIORITY,
  signal?: AbortSignal
): Promise<void> {
  let bucket = sendTxBuckets.get(index);
  if (!bucket) {
    bucket = makePriorityTokenBucket(RPC_MAX_SEND_TX_PER_SEC);
    sendTxBuckets.set(index, bucket);
  }
  return bucket(priority, signal);
}

const rpcHealth = new Map<number, { errorCount: number; lastErrorAt: number }>();
let _rpcIndex = 0;

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

  const priority = options.priority ?? PRIORITY.MEDIUM;
  const maxAttempts = options.maxAttempts ?? 3;
  const cacheTtlMs = options.cacheTtlMs ?? 0;
  const timeoutMs = options.timeoutMs ?? 12000;
  let lastError: unknown = null;

  const cacheKey = cacheTtlMs > 0 ? `${String(method)}:${safeJsonStringify(params)}` : null;
  if (cacheKey) {
    const cached = rpcCache.get(cacheKey);
    if (cached !== null) return cached as ReturnType<SolanaRpcApi[TMethod]>;
  }

  const rpcPool = Array.isArray(ctx.rpcs) && ctx.rpcs.length > 0 ? ctx.rpcs : [ctx.rpc];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (options.signal?.aborted) {
      throw new Error('rpcCall aborted');
    }

    const now = Date.now();

    let candidates = rpcPool
      .map((rpc, index) => ({ rpc, index }))
      .filter(({ index }) => {
        const health = rpcHealth.get(index) || { errorCount: 0, lastErrorAt: 0 };
        return health.errorCount < 3 || now - health.lastErrorAt > 60000;
      });

    if (candidates.length === 0) {
      candidates = rpcPool.map((rpc, index) => ({ rpc, index }));
    }

    const selected = candidates[_rpcIndex % candidates.length];
    if (!selected) {
      throw new Error('No RPC candidate selected.');
    }
    const { rpc, index } = selected;
    _rpcIndex++;

    try {
      if (method === ('sendTransaction' as keyof SolanaRpcApi)) {
        await acquireSendTxToken(index, PRIORITY.ULTRA_HIGH, options.signal);
      }
      await acquireRpcToken(index, priority, options.signal);

      const rpcMethod = rpc[method] as (...args: unknown[]) => {
        send: (opts?: { abortSignal?: AbortSignal }) => Promise<ReturnType<SolanaRpcApi[TMethod]>>;
      };
      const controller = new AbortController();
      let timeoutHandle: NodeJS.Timeout;

      if (options.signal) {
        options.signal.addEventListener('abort', () => controller.abort());
        if (options.signal.aborted) controller.abort();
      }

      // Promise.race guarantees the timeout rejects even if .send() ignores the AbortSignal
      // (which @solana/kit can do under certain transports, causing silent 60s+ hangs).
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          controller.abort();
          reject(new Error(`rpcCall ${String(method)} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });
      let result: ReturnType<SolanaRpcApi[TMethod]>;
      try {
        result = await Promise.race([
          rpcMethod(...(params as unknown[])).send({ abortSignal: controller.signal }),
          timeoutPromise,
        ]);
      } catch (e: unknown) {
        clearTimeout(timeoutHandle!);
        controller.abort();
        throw e;
      }
      clearTimeout(timeoutHandle!);

      rpcHealth.set(index, { errorCount: 0, lastErrorAt: 0 });

      if (cacheKey) rpcCache.set(cacheKey, result, cacheTtlMs);
      return result as ReturnType<SolanaRpcApi[TMethod]>;
    } catch (e: unknown) {
      lastError = e;

      if (options.signal?.aborted) {
        throw new Error('rpcCall aborted', { cause: e });
      }

      const health = rpcHealth.get(index) || { errorCount: 0, lastErrorAt: 0 };
      health.errorCount++;
      health.lastErrorAt = now;
      rpcHealth.set(index, health);

      if (isTransientOperationError(e) && attempt < maxAttempts - 1) {
        if (candidates.length > 1) continue;

        await sleep(500 * (attempt + 1));
        continue;
      }
      throw e;
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
  const virtualTokenReserves = buffer.readBigUInt64LE(8);
  const virtualSolReserves = buffer.readBigUInt64LE(16);
  const realTokenReserves = buffer.readBigUInt64LE(24);
  const realSolReserves = buffer.readBigUInt64LE(32);
  const totalSupply = buffer.readBigUInt64LE(40);
  const isCompleted = buffer.readUInt8(48) === 1;
  // `creator` (pubkey @49) only exists on the redeployed Token-2022 curve layout (>= 81 bytes);
  // legacy/short buffers used for price reads don't carry it, so it stays optional.
  const creator = buffer.length >= 81 ? bs58.encode(buffer.subarray(49, 81)) : undefined;

  return {
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    totalSupply,
    isCompleted,
    creator,
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
  try {
    const programId = address(PUMP_FUN_PROGRAM_ID);
    const mintAddress = address(mint);

    const [pda] = await getProgramDerivedAddress({
      programAddress: programId,
      seeds: [new TextEncoder().encode('bonding-curve'), getAddressEncoder().encode(mintAddress)],
    });

    return pda;
  } catch {
    return '';
  }
}
