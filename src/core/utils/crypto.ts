import bs58 from 'bs58';
import readline from 'node:readline';

/**
 * Prompt for a password from stdin without echoing characters.
 */
export async function promptPassword(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(query, (password) => {
      rl.close();
      resolve(password);
    });
    const rlExt = rl as unknown as {
      output: NodeJS.WritableStream;
      _writeToOutput: (s: string) => void;
    };
    rlExt._writeToOutput = function _writeToOutput(stringToWrite: string) {
      if (stringToWrite === '\n' || stringToWrite === '\r' || stringToWrite === '\r\n') {
        rlExt.output.write(stringToWrite);
      } else if (stringToWrite.length > 0) {
        // rlExt.output.write('*'); // Optionally show asterisks
      }
    };
  });
}

/**
 * Global abort controller for managing application-wide cancellation signals.
 */
export const shutdownController = new AbortController();

/**
 * Decodes a private key from Base58 or a JSON byte array.
 * @param privateKeyText - The raw private key string.
 * @returns The decoded private key as a Uint8Array.
 * @throws Error if the key is missing or the format is invalid.
 */
export function decodePrivateKeyBytes(privateKeyText: string): Uint8Array {
  const trimmed = String(privateKeyText || '').trim();
  if (!trimmed) throw new Error('PRIVATE_KEY or PRIVATE_KEY_PATH is required.');

  const validateDecodedKey = (bytes: Uint8Array, source: string): Uint8Array => {
    if (bytes.length !== 64) {
      throw new Error(`${source} must decode to a 64-byte Solana keypair, got ${bytes.length}.`);
    }
    return bytes;
  };

  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (e) {
      throw new Error('Failed to parse private key as JSON array.', { cause: e });
    }
    if (
      !Array.isArray(parsed) ||
      parsed.some((value) => !Number.isInteger(value) || Number(value) < 0 || Number(value) > 255)
    ) {
      throw new Error('Private key JSON must be an array of byte values from 0 to 255.');
    }
    return validateDecodedKey(Uint8Array.from(parsed), 'Private key JSON array');
  }

  // Handle various bs58 import styles
  const decoder =
    bs58.decode ||
    (bs58 as unknown as { default?: { decode: (s: string) => Uint8Array } }).default?.decode;

  if (typeof decoder !== 'function') {
    throw new Error('bs58 decode function not found.');
  }

  let decoded: Uint8Array;
  try {
    decoded = decoder(trimmed);
  } catch (e) {
    throw new Error('Failed to decode private key from Base58.', { cause: e });
  }
  return validateDecodedKey(decoded, 'PRIVATE_KEY Base58 value');
}
