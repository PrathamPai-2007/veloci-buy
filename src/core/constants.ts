import { LaunchpadProfile } from '../types/index.js';

/**
 * The mint address for native SOL on Solana.
 */
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Common constants used across the application.
 */
export const constants = { SOL_MINT };

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
 * Percentage of the position to sell at each take-profit level.
 */
export const TP_SELL_PERCENT = Math.round(TAKE_PROFIT_FRACTION * 100);

/**
 * Percentage of the position to hold after a take-profit sell.
 */
export const TP_HOLD_PERCENT = 100 - TP_SELL_PERCENT;

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

/**
 * Default timeout for HTTP fetch operations.
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

/**
 * Default number of retries for HTTP fetch operations.
 */
export const DEFAULT_FETCH_RETRIES = 2;

/**
 * Default delay between retries for HTTP fetch operations.
 */
export const DEFAULT_FETCH_RETRY_DELAY_MS = 750;

/**
 * Weights used in the scoring algorithm for new tokens.
 */
export const SCORING_WEIGHTS = {
  socialLinkHigh: 15,
  socialLinkLow: 5,
  isVerified: 5,
  organicScoreClamp: 20,
  liquidityRatioHigh: 10,
  liquidityRatioLow: 5,
  holderCountHigh: 5,
  buyPressureBonus: 5,
  suspiciousAuditPenalty: 5,
  // Volume/FDV ratio: organic activity signal. High turnover vs market cap = genuine interest.
  volFdvHigh: 5, // volume24h > 10% of FDV
  volFdvMid: 3, // volume24h > 5% of FDV
  volFdvLow: -3, // volume24h < 0.5% of FDV (stagnant)
};

/**
 * Thresholds for determining market "mood" and adjusting trading behavior.
 */
export const MOOD_THRESHOLDS = {
  winRateCritical: 0.2,
  winRateCautious: 0.4,
  sizeMultiplierCautious: 0.5,
  windowLarge: 10,
  windowSmall: 5,
};

/**
 * Configuration for momentum-based filters and guards.
 */
export const MOMENTUM_FILTERS = {
  minAccelerationFactor: 0.3,
  minBuysFirstHalf: 5,
  buyVelocityDecayFactor: 0.4,
  maxExhaustionRangePct: 1.6,
  minMomentumConsistency: 0.6,
};

/**
 * Weights for the signed momentum delta added to a candidate's entry score
 * (see `computeMomentumScore`). The existing `computeCandidateScore` measures token
 * *cleanliness* (socials, organic, liquidity, holders) but almost nothing about *thrust* —
 * paper sessions showed a 95-score token go flat while the only mover scored lowest. This
 * delta tilts the score toward order-flow/price thrust without flipping a clean high score on
 * its own (moderate band). It is validated mainly as a *downside* filter: tokens visibly
 * dumping in the survival window get demoted. Sum of positive sub-scores (5+4+5=14) is clamped
 * to +12; negatives (-14) to -10.
 */
export const MOMENTUM_SCORING = {
  imbalanceMax: 5, // graded 5m buy/sell imbalance (replaces nothing; uses stats5m, not buyPressure)
  accelMax: 4, // buy-flow acceleration: second-half vs first-half tape buys
  trajectoryMax: 5, // price climb off survival baseline, weighted by green-snapshot consistency
  min: -10,
  max: 12,
  growthBandPct: 0.3, // +/-30% maps trajectory to the full [-1,1] range before weighting
};
