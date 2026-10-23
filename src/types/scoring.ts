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

export interface ScoringConfig {
  scoringWeights: ScoringWeights;
  moodThresholds: MoodThresholds;
  momentumFilters: MomentumFilters;
  momentumScoring: MomentumScoring;
}
