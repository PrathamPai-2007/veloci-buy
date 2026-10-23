import { createHash } from 'node:crypto';

// Raydium AMM V4 swap log prefix emitted by the on-chain program
const RAY_LOG_PREFIX = 'Program log: ray_log: ';

// Shared Anchor event discriminator for SwapEvent = sha256("event:SwapEvent")[:8]
// Used by both Meteora DLMM and Raydium CLMM (both Anchor programs with same event name)
const ANCHOR_SWAP_EVENT_DISCRIMINATOR = createHash('sha256')
  .update('event:SwapEvent')
  .digest()
  .subarray(0, 8);
const ANCHOR_EVENT_LOG_PREFIX = 'Program data: ';

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
