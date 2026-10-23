import bs58 from 'bs58';
import { PUMP_FUN_CREATE_EVENT_DISCRIMINATOR } from '#core/config.js';

/**
 * Extracts the new mint from a pump.fun `CreateEvent` carried on a `Program data:` log line.
 * The redeployed program no longer prints a human-readable `mint:` line, so this decodes the borsh event
 * inline to keep the WS fast-path (avoids the extra getTransaction the signature fallback needs).
 * Layout after the 8-byte discriminator: borsh string name, symbol, uri (each u32-LE length + bytes),
 * then the 32-byte mint pubkey. Returns null if the line isn't a CreateEvent or is malformed.
 */
export function decodePumpCreateEventMint(line: string): string | null {
  if (!line.startsWith('Program data:')) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(line.slice('Program data:'.length).trim(), 'base64');
  } catch {
    return null;
  }
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PUMP_FUN_CREATE_EVENT_DISCRIMINATOR))
    return null;
  let pos = 8;
  for (let i = 0; i < 3; i++) {
    if (pos + 4 > buf.length) return null;
    const len = buf.readUInt32LE(pos);
    pos += 4 + len;
  }
  if (pos + 32 > buf.length) return null;
  return bs58.encode(buf.subarray(pos, pos + 32));
}
