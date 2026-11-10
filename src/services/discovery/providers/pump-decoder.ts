import bs58 from 'bs58';
import {
  PUMP_FUN_CREATE_EVENT_DISCRIMINATOR,
  PUMP_FUN_TRADE_EVENT_DISCRIMINATOR,
} from '#core/config.js';

export interface PumpCreateEvent {
  name: string;
  symbol: string;
  mint: string;
  /** Wallet that launched the token (the `creator` field, which survives creator hand-offs). */
  creator: string | null;
}

export interface PumpTradeEvent {
  mint: string;
  solAmount: bigint;
  tokenAmount: bigint;
  isBuy: boolean;
  user: string;
  /** Unix seconds, from the on-chain clock. */
  timestamp: number;
  /** Curve reserves AFTER this trade. */
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
}

/** Decodes the payload of a `Program data:` line if it starts with `discriminator`. */
function eventPayload(line: string, discriminator: Uint8Array): Buffer | null {
  if (!line.startsWith('Program data:')) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(line.slice('Program data:'.length).trim(), 'base64');
  } catch {
    return null;
  }
  if (buf.length < 8 || !buf.subarray(0, 8).equals(discriminator)) return null;
  return buf;
}

/**
 * Decodes a pump.fun `CreateEvent` carried on a `Program data:` log line.
 * The redeployed program no longer prints a human-readable `mint:` line, so this decodes the borsh event
 * inline to keep the WS fast-path (avoids the extra getTransaction the signature fallback needs).
 * Layout after the 8-byte discriminator: borsh string name, symbol, uri (each u32-LE length + bytes),
 * then 32-byte pubkeys mint, bondingCurve, user, creator. Returns null if the line isn't a
 * CreateEvent or is malformed; `creator` is null on an older, shorter event.
 */
export function decodePumpCreateEvent(line: string): PumpCreateEvent | null {
  const buf = eventPayload(line, PUMP_FUN_CREATE_EVENT_DISCRIMINATOR);
  if (!buf) return null;
  let pos = 8;
  const strings: string[] = [];
  for (let i = 0; i < 3; i++) {
    if (pos + 4 > buf.length) return null;
    const len = buf.readUInt32LE(pos);
    if (pos + 4 + len > buf.length) return null;
    strings.push(buf.subarray(pos + 4, pos + 4 + len).toString('utf8'));
    pos += 4 + len;
  }
  if (pos + 32 > buf.length) return null;
  const mint = bs58.encode(buf.subarray(pos, pos + 32));
  const creatorAt = pos + 96; // skip mint, bondingCurve, user
  const creator =
    creatorAt + 32 <= buf.length ? bs58.encode(buf.subarray(creatorAt, creatorAt + 32)) : null;
  return { name: strings[0]!, symbol: strings[1]!, mint, creator };
}

/** Mint-only convenience wrapper around {@link decodePumpCreateEvent}. */
export function decodePumpCreateEventMint(line: string): string | null {
  return decodePumpCreateEvent(line)?.mint ?? null;
}

/** Bytes of the fixed TradeEvent prefix this decoder reads (discriminator included). */
const TRADE_EVENT_PREFIX_LEN = 129;

/**
 * Decodes a pump.fun `TradeEvent` (one per bonding-curve buy or sell) from a `Program data:` line.
 * Fixed prefix after the 8-byte discriminator: mint (32), solAmount u64, tokenAmount u64, isBuy u8,
 * user (32), timestamp i64, virtualSolReserves u64, virtualTokenReserves u64, realSolReserves u64,
 * realTokenReserves u64. The program keeps appending fee/creator fields after that, so only this
 * prefix is read. Layout checked against live mainnet logs (2026-11).
 */
export function decodePumpTradeEvent(line: string): PumpTradeEvent | null {
  const buf = eventPayload(line, PUMP_FUN_TRADE_EVENT_DISCRIMINATOR);
  if (!buf || buf.length < TRADE_EVENT_PREFIX_LEN) return null;
  return {
    mint: bs58.encode(buf.subarray(8, 40)),
    solAmount: buf.readBigUInt64LE(40),
    tokenAmount: buf.readBigUInt64LE(48),
    isBuy: buf.readUInt8(56) === 1,
    user: bs58.encode(buf.subarray(57, 89)),
    timestamp: Number(buf.readBigInt64LE(89)),
    virtualSolReserves: buf.readBigUInt64LE(97),
    virtualTokenReserves: buf.readBigUInt64LE(105),
    realSolReserves: buf.readBigUInt64LE(113),
    realTokenReserves: buf.readBigUInt64LE(121),
  };
}
