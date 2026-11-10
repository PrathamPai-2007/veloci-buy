import { LaunchpadProfile } from '../types/index.js';

/**
 * The mint address for native SOL on Solana.
 */
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Default state file path (relative to session directory).
 */
export const DEFAULT_STATE_FILE = '';

/**
 * Maximum number of mints to track in memory to prevent memory exhaustion.
 */
export const MAX_TRACKED_MINTS = 5_000;

/**
 * Default multiples for take-profit sell orders.
 */
export const TAKE_PROFIT_MULTIPLES = [1.5];

/**
 * Fraction of the position to sell at each take-profit level.
 */
export const TAKE_PROFIT_FRACTION = 0.6;

/**
 * Known addresses representing burned or null owners.
 */
export const BURN_OWNERS = new Set<string>([
  '11111111111111111111111111111111',
  '1nc1nerator11111111111111111111111111111111',
]);

/**
 * Default keywords used to identify meme-related tokens.
 */
export const DEFAULT_MEME_KEYWORDS = [
  'ai',
  'ape',
  'bonk',
  'cat',
  'chad',
  'coin',
  'dog',
  'elon',
  'frog',
  'inu',
  'kitty',
  'meme',
  'moon',
  'pepe',
  'pump',
  'sol',
  'wojak',
];

/**
 * Scoring and liquidity profiles for various launchpads and AMMs.
 */
export const DEFAULT_LAUNCHPAD_PROFILES: Record<string, LaunchpadProfile> = {
  'pump.fun': {
    scoreBonus: 10,
    liquidityMultiplier: 0.75,
    holderMultiplier: 0.7,
    buysMultiplier: 0.75,
    minPoolAgeSeconds: 5,
  },
  'bags.fun': {
    scoreBonus: 6,
    liquidityMultiplier: 0.7,
    holderMultiplier: 0.6,
    buysMultiplier: 0.5,
    minPoolAgeSeconds: 5,
  },
  raydium: {
    scoreBonus: 8,
    liquidityMultiplier: 1,
    holderMultiplier: 1,
    buysMultiplier: 1,
    minPoolAgeSeconds: 10,
  },
  meteora: {
    scoreBonus: 7,
    liquidityMultiplier: 1,
    holderMultiplier: 1,
    buysMultiplier: 1,
    minPoolAgeSeconds: 10,
  },
  moonshot: {
    scoreBonus: 9,
    liquidityMultiplier: 0.8,
    holderMultiplier: 0.75,
    buysMultiplier: 0.75,
    minPoolAgeSeconds: 5,
  },
};

/**
 * Program IDs for SPL Token and Token-2022 programs.
 */
export const SPL_TOKEN_PROGRAM_IDS = [
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
];

/**
 * Program ID for Pump.fun. Pump.fun redeployed to this program (Token-2022 mints); the legacy
 * program `6EF8rrecth7QZ77z27Y9RQmP22JdK89pX6X1N1B8bN2` no longer backs new launches, so its
 * `bonding-curve` PDAs return null and on-chain price reads silently yield nothing.
 * Curve seed and reserve layout (vTok@8, vSol@16, realSol@32, creator@49) are unchanged.
 * src/services/trading/adapters/pumpfun.ts now builds buy/sell against this program (Token-2022
 * ATAs, 16/14-account layout from the on-chain IDL) and imports this constant.
 */
export const PUMP_FUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

/**
 * Program ID for Raydium AMM V4.
 */
export const RAYDIUM_AMM_V4_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

/**
 * Program ID for Meteora DLMM.
 */
export const METEORA_DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';

/**
 * Regex to detect token initialization instructions in transaction logs.
 */
export const INITIALIZE_MINT_LOG_PATTERN = /Instruction:\s+InitializeMint2?/i;

/**
 * Regex to detect Pump.fun create instructions in transaction logs.
 */
export const PUMP_FUN_CREATE_LOG_PATTERN = /Instruction:\s+Create/i;

/**
 * Regex to extract the mint address from Pump.fun create log messages.
 */
export const PUMP_FUN_MINT_LOG_PATTERN = /Program log:\s+Create[\s\S]*?mint:\s*([\w\d]+)/i;

/**
 * Fallback regex for pump.fun JSON-style event logs: {"e":"create","mint":"<addr>",...}
 */
export const PUMP_FUN_MINT_JSON_PATTERN = /"mint"\s*:\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/;

/**
 * Anchor event discriminator (first 8 bytes) for the redeployed pump.fun `CreateEvent`, emitted on a
 * `Program data:` log line by the `CreateV2` instruction. The mint pubkey follows the 8-byte
 * discriminator and three borsh-string fields (name, symbol, uri); see `decodePumpCreateEventMint`.
 */
export const PUMP_FUN_CREATE_EVENT_DISCRIMINATOR = new Uint8Array([
  27, 114, 169, 77, 222, 235, 99, 118,
]);

/**
 * Anchor event discriminator for the pump.fun `TradeEvent`, emitted on a `Program data:` log line
 * by every bonding-curve buy and sell; see `decodePumpTradeEvent`.
 */
export const PUMP_FUN_TRADE_EVENT_DISCRIMINATOR = new Uint8Array([
  0xbd, 0xdb, 0x7f, 0xd3, 0x4e, 0xe6, 0x61, 0xee,
]);

/**
 * Regex to detect Raydium AMM V4 initialization instructions in transaction logs.
 */
export const RAYDIUM_INIT_LOG_PATTERN = /Instruction:\s+(?:Initialize2|Monitor)/i;

/**
 * Regex to detect Meteora DLMM initialization instructions in transaction logs.
 */
export const METEORA_INIT_LOG_PATTERN = /Instruction:\s+(?:Initialize|CreateLbPair)/i;

/**
 * Solana Memo program ID (used in Meteora DLMM swap instructions).
 */
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

/**
 * Time duration to retain discovery signals in memory.
 */
export const DISCOVERY_SIGNAL_RETENTION_MS = 10 * 60 * 1000;

/**
 * Time duration to retain market snapshots in memory.
 */
export const MARKET_SNAPSHOT_RETENTION_MS = 60 * 60 * 1000;

export {
  SCORING_WEIGHTS,
  TAPE_SIGNALS,
  MOOD_THRESHOLDS,
  MOMENTUM_FILTERS,
  MOMENTUM_SCORING,
} from './scoring-loader.js';
