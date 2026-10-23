import type { BubbleMapsSignals, MintSignals, RugCheckSignals } from './signals.js';

export interface Position {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  openedAt: string;
  mode: 'paper' | 'live';
  entryPriceUsd: number;
  entryPriceSol?: number;
  entryUsdValue: number;
  entryScore: number;
  initialTokenAmountRaw: string;
  // Reserved "runner" tranche (raw token units). Routine de-risk exits will not sell below this;
  // it rides on a wide trailing stop (moonBagTrailingDrawdownPct) to capture moonshots. Only hard
  // exits (stop-loss, liquidity/security rug, shutdown, moon-bag trailing) may sell into it.
  moonBagRaw?: string;
  buySignature?: string;
  highestPriceUsd: number;
  partiallyClosed: boolean;
  takeProfitMultiples: number[];
  takeProfitFractions: number[];
  trailingStopDrawdownPctResolved: number;
  maxHoldMinutesResolved: number;
  volatilityScaler: number;
  entryLiquidityUsd: number;
  lastDriftAuditTime?: number;
  lastSecurityAuditAt?: number;
  targetsHit?: number;
  earlyGuardExits?: number;
  lastTakeProfitAt?: string;
  lastTakeProfitMultiple?: number | null;
  lastKnownBalanceRaw?: string;
  balanceZeroSince?: number;
  lastKnownPriceUsd?: number;
  remainingCostUsd?: number;
  remainingCostSol?: number;
  realizedPnlUsd?: number;
  realizedPnlSol?: number;
  realizedProceedsUsd?: number;
  realizedProceedsSol?: number;
  insiderDrifts?: Record<string, boolean>;
  lastExitReason?: string;
  lastSellSignature?: string;
  stopLossWarningSent?: boolean;
  minTpArmed?: boolean;
  minTpReached?: boolean;
  minTpFirstReachedAt?: number | null;
  initialBuyAmountSol?: string | number | null;
  initialBuyAmountLamports?: string;
  paperEntryQuoteOutAmount?: string;
  trailingArmed?: boolean;
  breakEvenStopArmed?: boolean;
  mintSignals?: MintSignals;
  securitySignals?: {
    rugCheck: RugCheckSignals | null;
    bubbleMaps: BubbleMapsSignals | null;
  };
  marketData?: {
    price: number | undefined;
    liquidity: number | undefined;
    volume24h: number | undefined;
    buyPressure: number | undefined;
    sellPressure: number | undefined;
  };
  highGrowthConfidence?: boolean;
  lastKnownLiquidityUsd?: number;
  launchpad?: string | null;
  tpProfile?: string | null;
  highestSeenPriceUsd?: number;
  priceHistory?: { price: number; timestamp: number; liquidity?: number }[];
  tapeHistory?: { buys: number; sells: number; timestamp: number }[];
  spreadHistory?: { spread: number; timestamp: number }[];
  mlFeaturesJson?: string;
  entryProfile?: 'standard';
  timeSeries?: [number, number, number][];
  entryMarketCapUsd?: number;
  exitPriceUsd?: number;
  orphan?: boolean;
  /** Pool address for local swap routing (Raydium/Meteora). Populated at entry time from mintToPool. */
  poolAddress?: string;
  /** ML confidence at entry time [0,1]. Used to size exit Jito tips. */
  entryConfidence?: number;
  /** Explicit lifecycle state tracking. */
  lifecycleState?: PositionLifecycle;
  /** Authoritative price timestamp (ms epoch). */
  lastKnownPriceTimestamp?: number;
  /** Source of last known price (e.g., 'local-authoritative', 'refresh-authoritative', 'stale-fallback'). */
  lastKnownPriceSource?: string;
  /** Exit price source metadata. */
  exitPriceSource?: string;
  /** Exit price timestamp (ms epoch). */
  exitPriceTimestamp?: number;
  /** Exit price age at exit time (ms). */
  exitPriceAgeMs?: number;
  /** Slot number associated with market snapshot if available. */
  marketSnapshotSlot?: number;
}

export type PositionLifecycle =
  | 'OPEN'
  | 'EXIT_PENDING'
  | 'EXITING'
  | 'PARTIALLY_EXITED'
  | 'CLOSED'
  | 'EXIT_FAILED';

export interface ExitResult {
  success: boolean;
  mint: string;
  reason: string;
  stage?: string;
  error?: string;
  priceUsd?: number;
  priceSource?: string;
  priceTimestamp?: number;
  priceAgeMs?: number;
  solPriceUsd?: number;
  solPriceSource?: string;
  solPriceTimestamp?: number;
  solPriceAgeMs?: number;
  soldRaw?: string;
  proceedsLamports?: string;
  proceedsUsd?: number;
  proceedsSol?: number;
}

export interface GhostPosition {
  mint: string;
  symbol: string;
  entryPriceUsd: number;
  entryScore: number;
  highestPriceUsd: number;
  openedAt: number;
  featuresJson: string;
  tpProfile: string | null;
  launchpad: string | null;
  targetsHit: number;
  sequenceJson?: string;
  timeSeries?: [number, number, number][];
  // Full Parity: enriched to mirror Position fields so evaluateExitChain can run faithfully (fee-free).
  priceHistory?: { price: number; timestamp: number; liquidity?: number }[];
  tapeHistory?: { buys: number; sells: number; timestamp: number }[];
  spreadHistory?: { spread: number; timestamp: number }[];
  entryMarketCapUsd?: number;
  entryLiquidityUsd?: number;
  lastKnownLiquidityUsd?: number;
  volatilityScaler?: number;
  earlyGuardExits?: number;
  trailingArmed?: boolean;
  stopLossWarningSent?: boolean;
  breakEvenStopArmed?: boolean;
  takeProfitMultiples?: number[];
}

export interface ClosedTrade {
  mint: string;
  symbol: string;
  exitReason: string;
  realizedPnlUsd: number;
  realizedPnlSol?: number;
  realizedProceedsUsd: number;
  realizedProceedsSol?: number;
  entryUsdValue: number;
  entryPriceUsd: number;
  entryPriceSol?: number;
  highestPriceUsd: number;
  holdSeconds: number;
  closedAt: string;
  entryScore: number;
  tpProfile?: string | null;
  takeProfitMultiples?: number[] | null;
  takeProfitFractions?: number[] | null;
  trailingStopDrawdownPctResolved: number;
  maxHoldMinutesResolved: number;
  volatilityScaler: number;
  entryLiquidityUsd: number;
  launchpad?: string | null;
  targetsHit: number;
  initialBuyAmountSol?: string | number | null;
  isGhost?: boolean;
  mode?: 'paper' | 'live' | 'ghost';
  orphan?: boolean;
  holdTimeSeriesJson?: string;
  entryMarketCapUsd?: number;
  exitPriceUsd?: number;
}
