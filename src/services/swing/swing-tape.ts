import { createHash } from 'node:crypto';
import { address } from '@solana/addresses';
import { fetchJson, sleep } from '#core/utils.js';
import { Context, SwingWatchlistItem } from '#types/index.js';

// Raydium AMM V4 swap log prefix emitted by the on-chain program
const RAY_LOG_PREFIX = 'Program log: ray_log: ';

// Raydium v3 public API for pool discovery (no auth required)
const RAYDIUM_V3_API = 'https://api-v3.raydium.io';
const SOL_MINT_STR = 'So11111111111111111111111111111111111111112';

// Meteora DLMM public API
const METEORA_DLMM_API = 'https://dlmm.datapi.meteora.ag';

// Shared Anchor event discriminator for SwapEvent = sha256("event:SwapEvent")[:8]
// Used by both Meteora DLMM and Raydium CLMM (both Anchor programs with same event name)
const ANCHOR_SWAP_EVENT_DISCRIMINATOR = createHash('sha256')
  .update('event:SwapEvent')
  .digest()
  .subarray(0, 8);
const ANCHOR_EVENT_LOG_PREFIX = 'Program data: ';

const MAX_SWAP_TAPE = 500;

/**
 * Parses a single Raydium AMM V4 `ray_log` log line into a swap tick.
 *
 * ray_log binary layout (57 bytes):
 *   offset 0  — log_type  (u8)   : 3 = swap
 *   offset 1  — amount_in (u64)  : SOL lamports (direction=2) or token raw (direction=1)
 *   offset 9  — minimum_out (u64)
 *   offset 17 — direction (u64)  : 1 = coin→pc (sell token), 2 = pc→coin (buy token)
 *   offset 25 — user_source (u64)
 *   offset 33 — pool_coin (u64)
 *   offset 41 — pool_pc (u64)
 *   offset 49 — out_amount (u64) : SOL lamports received when direction=1 (sell)
 */
export function parseRayLog(logLine: string): { side: 'buy' | 'sell'; amountSol: number } | null {
  if (!logLine.startsWith(RAY_LOG_PREFIX)) return null;
  try {
    const b64 = logLine.slice(RAY_LOG_PREFIX.length).trim();
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 57) return null;
    if (buf.readUInt8(0) !== 3) return null; // not a swap log
    const direction = Number(buf.readBigUInt64LE(17));
    if (direction === 2) {
      // pc→coin: user pays SOL to buy token
      return { side: 'buy', amountSol: Number(buf.readBigUInt64LE(1)) / 1e9 };
    }
    if (direction === 1) {
      // coin→pc: user sells token and receives SOL
      return { side: 'sell', amountSol: Number(buf.readBigUInt64LE(49)) / 1e9 };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Queries the Raydium v3 public API to find the AMM pool ID for a token/SOL pair.
 * Returns null when no pool is found or the request fails.
 */
export async function fetchRaydiumAmmId(mint: string): Promise<string | null> {
  try {
    const url =
      `${RAYDIUM_V3_API}/pools/info/mint` +
      `?mint1=${encodeURIComponent(mint)}` +
      `&mint2=${SOL_MINT_STR}` +
      `&poolType=standard&poolSortField=default&sortType=desc&pageSize=1&page=1`;

    const resp = await fetchJson<{
      data?: { data?: { id?: string }[] };
    }>(url, { timeoutMs: 6000, retries: 1 });

    const id = resp?.data?.data?.[0]?.id;
    return id ?? null;
  } catch {
    return null;
  }
}

/**
 * Parses a Meteora DLMM SwapEvent from an Anchor `Program data:` log line.
 *
 * SwapEvent binary layout (offset after 8-byte discriminator):
 *   offset 8  — lb_pair (Pubkey, 32 bytes)
 *   offset 40 — from (Pubkey, 32 bytes)
 *   offset 72 — start_bin_id (i32, 4 bytes)
 *   offset 76 — end_bin_id (i32, 4 bytes)
 *   offset 80 — amount_in (u64, 8 bytes)  : SOL lamports when swap_for_y==solIsTokenX (buy)
 *   offset 88 — amount_out (u64, 8 bytes) : SOL lamports when swap_for_y!=solIsTokenX (sell)
 *   offset 96 — swap_for_y (bool, 1 byte) : true=paying tokenX / receiving tokenY
 *
 * @param solIsTokenX - true when SOL is tokenX in this DLMM pair (resolved at pool-lookup time)
 */
export function parseMeteoraSwapLog(
  logLine: string,
  solIsTokenX: boolean
): { side: 'buy' | 'sell'; amountSol: number } | null {
  if (!logLine.startsWith(ANCHOR_EVENT_LOG_PREFIX)) return null;
  try {
    const b64 = logLine.slice(ANCHOR_EVENT_LOG_PREFIX.length).trim();
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 97) return null;
    for (let i = 0; i < 8; i++) {
      if (buf[i] !== ANCHOR_SWAP_EVENT_DISCRIMINATOR[i]) return null;
    }
    const swapForY = buf.readUInt8(96) !== 0;
    const isBuy = swapForY === solIsTokenX;
    const amountSol = isBuy
      ? Number(buf.readBigUInt64LE(80)) / 1e9
      : Number(buf.readBigUInt64LE(88)) / 1e9;
    if (amountSol <= 0) return null;
    return { side: isBuy ? 'buy' : 'sell', amountSol };
  } catch {
    return null;
  }
}

/**
 * Queries the Meteora DLMM public API to find the pool address for a token/SOL pair.
 * Also resolves whether SOL is tokenX or tokenY so swap direction can be inferred.
 * Returns null when no pool is found or the request fails.
 */
export async function fetchMeteoraPoolId(
  mint: string
): Promise<{ poolId: string; solIsTokenX: boolean } | null> {
  try {
    const url =
      `${METEORA_DLMM_API}/pools` +
      `?query=${encodeURIComponent(mint)}` +
      `&limit=10&sort_key=liquidity&order_by=desc`;

    const resp = await fetchJson<{
      data?: {
        address?: string;
        token_x?: { address: string };
        token_y?: { address: string };
      }[];
    }>(url, { timeoutMs: 6000, retries: 1 });

    const pairs = resp?.data;
    if (!Array.isArray(pairs) || pairs.length === 0) return null;

    for (const pair of pairs) {
      if (!pair.address || !pair.token_x?.address || !pair.token_y?.address) continue;
      const mintX = pair.token_x.address;
      const mintY = pair.token_y.address;

      if (mintX === mint || mintY === mint) {
        if (mintX === SOL_MINT_STR || mintY === SOL_MINT_STR) {
          const solIsTokenX = mintX === SOL_MINT_STR;
          return { poolId: pair.address, solIsTokenX };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Queries the Raydium v3 public API to find the CLMM (concentrated liquidity) pool ID
 * for a token/SOL pair and resolves which mint is token0 for swap direction inference.
 * Returns null when no pool is found or the request fails.
 */
export async function fetchRaydiumClmmId(
  mint: string
): Promise<{ poolId: string; solIsTokenX: boolean } | null> {
  try {
    const url =
      `${RAYDIUM_V3_API}/pools/info/mint` +
      `?mint1=${encodeURIComponent(mint)}` +
      `&mint2=${SOL_MINT_STR}` +
      `&poolType=concentrated&poolSortField=liquidity&sortType=desc&pageSize=1&page=1`;

    const resp = await fetchJson<{
      data?: { data?: { id?: string; mintA?: { address?: string } }[] };
    }>(url, { timeoutMs: 6000, retries: 1 });

    const pool = resp?.data?.data?.[0];
    if (!pool?.id) return null;
    const solIsTokenX = pool.mintA?.address === SOL_MINT_STR;
    return { poolId: pool.id, solIsTokenX };
  } catch {
    return null;
  }
}

/**
 * Parses a Raydium CLMM SwapEvent from an Anchor `Program data:` log line.
 *
 * SwapEvent binary layout (205 bytes):
 *   offset 8   — pool_state (Pubkey, 32)
 *   offset 40  — sender (Pubkey, 32)
 *   offset 72  — token_account_0 (Pubkey, 32)
 *   offset 104 — token_account_1 (Pubkey, 32)
 *   offset 136 — amount_0 (u64) : token0 volume
 *   offset 144 — transfer_fee_0 (u64)
 *   offset 152 — amount_1 (u64) : token1 volume
 *   offset 160 — transfer_fee_1 (u64)
 *   offset 168 — zero_for_one (bool) : true = token0→token1
 *
 * @param solIsTokenX - true when SOL is token0 (mintA) in this CLMM pool
 */
export function parseRaydiumClmmSwapLog(
  logLine: string,
  solIsTokenX: boolean
): { side: 'buy' | 'sell'; amountSol: number } | null {
  if (!logLine.startsWith(ANCHOR_EVENT_LOG_PREFIX)) return null;
  try {
    const b64 = logLine.slice(ANCHOR_EVENT_LOG_PREFIX.length).trim();
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 169) return null;
    for (let i = 0; i < 8; i++) {
      if (buf[i] !== ANCHOR_SWAP_EVENT_DISCRIMINATOR[i]) return null;
    }
    const zeroForOne = buf.readUInt8(168) !== 0;
    const isBuy = zeroForOne === solIsTokenX;
    const amountSol = solIsTokenX
      ? Number(buf.readBigUInt64LE(136)) / 1e9
      : Number(buf.readBigUInt64LE(152)) / 1e9;
    if (amountSol <= 0) return null;
    return { side: isBuy ? 'buy' : 'sell', amountSol };
  } catch {
    return null;
  }
}

/**
 * Manages per-mint WebSocket log subscriptions to Raydium AMM pools.
 * Parses swap events from on-chain logs and writes tick-level data to
 * `item.swapTape`, giving `detectSwapTapeAccumulation` real SOL-volume data
 * instead of the coarse 5-minute aggregates from Jupiter stats5m.
 */
class SwingTapeManager {
  private readonly controllers = new Map<string, AbortController>();

  /**
   * Subscribes to swap logs for a watchlist item.
   * If `item.ammId` is not yet set, looks it up via the Raydium v3 API first.
   * No-ops silently when the pool cannot be found.
   */
  async subscribe(ctx: Context, item: SwingWatchlistItem): Promise<void> {
    // Resolve pool ID if not already stored on the item
    if (!item.ammId) {
      if (item.pool === 'raydium') {
        const id = await fetchRaydiumAmmId(item.mint);
        if (id) {
          item.ammId = id;
          item.raydiumPoolType = 'amm-v4';
        } else {
          const clmm = await fetchRaydiumClmmId(item.mint);
          if (!clmm) {
            ctx.logger(
              `Swing tape: no Raydium pool (AMM V4 or CLMM) found for ${item.symbol}.`,
              'debug'
            );
            return;
          }
          item.ammId = clmm.poolId;
          item.solIsTokenX = clmm.solIsTokenX;
          item.raydiumPoolType = 'clmm';
        }
      } else if (item.pool === 'meteora') {
        const result = await fetchMeteoraPoolId(item.mint);
        if (!result) {
          ctx.logger(`Swing tape: no Meteora pool found for ${item.symbol}.`, 'debug');
          return;
        }
        item.ammId = result.poolId;
        item.solIsTokenX = result.solIsTokenX;
      } else {
        return;
      }
    }

    // Abort any existing subscription for this mint
    this.controllers.get(item.mint)?.abort();

    const controller = new AbortController();
    this.controllers.set(item.mint, controller);
    item.swapTape = item.swapTape ?? [];

    void this._listenLoop(ctx, item, controller);
  }

  private async _listenLoop(
    ctx: Context,
    item: SwingWatchlistItem,
    controller: AbortController
  ): Promise<void> {
    const handshakeMs = ctx.config.websocketHandshakeTimeoutMs || 15_000;
    while (!controller.signal.aborted) {
      let timeoutId: NodeJS.Timeout | undefined;
      try {
        const rpcSub = ctx.getCurrentRpcSubscriptions();
        const notifications = await Promise.race([
          rpcSub
            .logsNotifications({ mentions: [address(item.ammId!)] }, { commitment: 'processed' })
            .subscribe({ abortSignal: controller.signal }),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error('Swing tape subscription handshake timeout')),
              handshakeMs
            );
          }),
        ]);
        clearTimeout(timeoutId);

        ctx.logger(
          `Swing tape: subscribed to ${item.symbol} pool ${item.ammId!.slice(0, 8)}…`,
          'debug'
        );

        for await (const notification of notifications) {
          if (controller.signal.aborted) return;
          const val = (notification?.value ?? notification) as unknown as {
            logs?: readonly string[];
          };
          if (!Array.isArray(val?.logs)) continue;

          const now = Date.now();
          for (const line of val.logs) {
            const tick =
              item.pool === 'meteora'
                ? parseMeteoraSwapLog(line, item.solIsTokenX ?? true)
                : item.raydiumPoolType === 'clmm'
                  ? parseRaydiumClmmSwapLog(line, item.solIsTokenX ?? true)
                  : parseRayLog(line);
            if (!tick) continue;
            item.swapTape = item.swapTape ?? [];
            item.swapTape.push({ ...tick, timestamp: now });
            if (item.swapTape.length > MAX_SWAP_TAPE) item.swapTape.shift();
          }
        }
        if (!controller.signal.aborted) {
          throw new Error('Swing tape subscription ended unexpectedly');
        }
      } catch (e: unknown) {
        clearTimeout(timeoutId);
        if (controller.signal.aborted) return;
        ctx.logger(
          `Swing tape subscription error for ${item.symbol}: ${e instanceof Error ? e.message : String(e)}. Retrying in 10s.`,
          'debug'
        );
        await sleep(10_000);
      }
    }
  }

  /** Closes the swap-log subscription for a specific mint. */
  unsubscribe(mint: string): void {
    this.controllers.get(mint)?.abort();
    this.controllers.delete(mint);
  }

  /** Closes all active subscriptions (called on bot shutdown). */
  unsubscribeAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }
}

export const swingTapeManager = new SwingTapeManager();
