import type { LaunchpadProfile } from './config.js';
import type { TokenMetadata } from './market.js';

export interface AdjustedThresholds {
  minLiquidityUsd: number;
  minHolderCount: number;
  minBuys5m: number;
  minPoolAgeSeconds: number;
}

export interface MintSignals {
  decimals: number;
  supplyRaw: bigint;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  top1Share: number;
  top3Share: number;
  top5Share: number;
  /** False when no holder data could be obtained (rate limit / failure): the shares are not real. */
  holdersKnown?: boolean;
  topAccounts: Array<{
    address: string;
    rawAmount: bigint;
    share: number;
    owner: string | null;
    ownerLookupError?: string;
  }>;
}

export interface RugCheckSignals {
  status: 'ok' | 'error';
  blockers: string[];
  notes: string[];
  riskScore: number | null;
  rugged: boolean;
  error?: string;
}

export interface BubbleMapsSignals {
  status: 'ok' | 'timeout' | 'error';
  blockers: string[];
  score: number | null;
  largestClusterShare: number | null;
  raw?: unknown;
  error?: string;
}

export interface MlScoreResult {
  confidence: number;
  tpProfile: 'high' | 'standard';
  shadowMode: boolean;
  blocked: boolean;
}

export interface TrainingSample {
  mint: string;
  symbol: string;
  label: 0 | 1;
  featuresJson: string;
  realizedPnlUsd: number;
  entryScore: number;
  tpProfile: string | null;
  launchpad: string | null;
  closedAt: string;
  exitReason?: string;
  holdSeconds?: number;
  highestPriceUsd?: number;
  targetsHit?: number;
  entryPriceUsd?: number;
  sequenceJson?: string;
  holdTimeSeriesJson?: string;
}

export interface EvaluationResult {
  approved: boolean;
  blockers: string[];
  rejectionReasons: { code: string; recheckEligible: boolean }[];
  notes: string[];
  candidateScore: number;
  volatilityScaler: number;
  launchpadProfile: LaunchpadProfile & { name: string };
  adjustedThresholds: AdjustedThresholds;
  token: TokenMetadata;
  mintSignals?: MintSignals;
  rugCheckSignals?: RugCheckSignals | null;
  bubbleMapsSignals?: BubbleMapsSignals | null;
  mlScore?: MlScoreResult;
  tpProfileOverride?: 'high' | 'standard';
  mlFeaturesJson?: string;
  entryProfile?: 'standard';
}
