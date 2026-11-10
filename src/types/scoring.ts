export interface ScoringWeights {
  socialLinkHigh: number;
  socialLinkLow: number;
  isVerified: number;
  organicScoreClamp: number;
  liquidityRatioHigh: number;
  liquidityRatioLow: number;
  holderCountHigh: number;
  buyPressureBonus: number;
  suspiciousAuditPenalty: number;
  volFdvHigh: number;
  volFdvMid: number;
  volFdvLow: number;
}

export interface MoodThresholds {
  winRateCritical: number;
  winRateCautious: number;
  sizeMultiplierCautious: number;
  windowLarge: number;
  windowSmall: number;
}

export interface MomentumFilters {
  minAccelerationFactor: number;
  minBuysFirstHalf: number;
  buyVelocityDecayFactor: number;
  maxExhaustionRangePct: number;
  minMomentumConsistency: number;
}

export interface MomentumScoring {
  imbalanceMax: number;
  accelMax: number;
  trajectoryMax: number;
  min: number;
  max: number;
  growthBandPct: number;
}

/**
 * Order-flow signals computed from the pump.fun trade tape (no extra requests).
 * Every bonus/penalty can be zeroed in strategies/scoring.yaml.
 */
export interface TapeSignalWeights {
  /** Trailing window of tape the signals are measured over. */
  windowSeconds: number;
  /** Fewer trades than this in the window => signals stay neutral (too little to judge). */
  minTrades: number;
  /** Max +/- score for net SOL inflow to the curve per second (liquidity velocity). */
  liquidityVelocityMax: number;
  /** Inflow (SOL/s) that earns the full liquidityVelocityMax. */
  liquidityVelocityFullSolPerSec: number;
  /** Max bonus for distinct buying wallets. */
  uniqueBuyersMax: number;
  /** Distinct buyers that earn the full uniqueBuyersMax. */
  uniqueBuyersFull: number;
  /** Penalty when wallets round-trip (buy then sell) within washWindowSeconds. 0 = detect only. */
  washPenalty: number;
  washWindowSeconds: number;
  /** Penalty for a launch reusing the name+symbol of an earlier launch seen this session. */
  copycatPenalty: number;
}

export interface ScoringConfig {
  scoringWeights: ScoringWeights;
  tapeSignals: TapeSignalWeights;
  moodThresholds: MoodThresholds;
  momentumFilters: MomentumFilters;
  momentumScoring: MomentumScoring;
}
