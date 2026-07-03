/**
 * @module Analyze
 * Provides tools for replaying historical trades and performing parameter sensitivity analysis.
 * Used for optimizing trading strategies based on paper-trading or live-trading journals.
 */

'use strict';

/**
 * Interface for the reconstructed trade used in analysis.
 */
export interface AnalyzerTrade {
  sessionDir: string;
  mint: string;
  symbol: string;
  entryPriceUsd: number;
  entryUsdValue: number;
  entryScore: number;
  tpProfile: string | null;
  takeProfitMultiples: number[] | null;
  takeProfitFractions: number[] | null;
  trailingStopDrawdownPctResolved: number;
  maxHoldMinutesResolved: number;
  volatilityScaler: number;
  entryLiquidityUsd: number;
  launchpad: string | null;
  targetsHit: number;
  initialBuyAmountSol: number | null;
  highestPriceUsd: number;
  openedAt: string | null;
  closedAt: string | null;
  events: Array<{
    event: string;
    priceUsd: number;
    tokenAmount: string | number | null;
    proceedsUsd: number;
    realizedPnlUsd: number;
    reason: string | null;
    timestamp: string;
  }>;
  totalRealizedPnlUsd: number;
  totalProceedsUsd: number;
  actualExitReason: string | null;
  actualExitPrice: number;
  holdSeconds: number;
}

/**
 * Parameters for the trade replay simulation.
 */
export interface ReplayParams {
  /** Stop loss percentage (e.g., 0.2 for 20%) */
  stopLossPct: number;
  /** Trailing drawdown percentage (e.g., 0.15 for 15%) */
  trailingDrawdownPct: number;
  /** Array of take-profit multiples (e.g., [1.5, 2.0]) */
  takeProfitMultiples: number[];
  /** Fraction of position to sell at each TP target (e.g., 0.5 for 50%) */
  takeProfitFraction: number;
  /** Performance drop percentage for early exit guard */
  earlyPerformanceDropPct: number;
  /** Fraction of position to sell on early performance drop */
  earlyPerformanceSellPct: number;
  /** Maximum hold time in minutes before mandatory exit */
  maxHoldMinutes: number;
}

/**
 * Result of a single trade replay simulation.
 */
export interface ReplayResult {
  pnl: number;
  roi: number;
  exitReason: string;
  exitTime: number;
  targetsHit: number;
  totalProceeds: number;
}

/**
 * Aggregated results for a specific parameter combination.
 */
export interface AnalysisResult {
  params: ReplayParams;
  totalPnl: number;
  winRate: number;
  avgPnl: number;
  maxLoss: number;
  profitFactor: number | string;
  trades: number;
}
