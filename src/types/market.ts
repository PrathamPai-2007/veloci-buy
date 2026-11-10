export interface TokenMetadata {
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  usdPrice?: number;
  liquidity?: number;
  launchpad?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  isVerified?: boolean;
  fdvUsd?: number;
  marketCapUsd?: number;
  /** Launching wallet, from the pump.fun CreateEvent (WS discovery only). */
  creator?: string;
  /** Set when the candidate came from the Jupiter top-traded ("trending") feed. */
  isTrending?: boolean;
  priceUsd?: number;
  organicScore?: number | string;
  fdv?: number | string;
  holderCount?: number | string;
  stats5m?: {
    numBuys: number;
    numSells: number;
  };
  snapshotQuality?: string;
  historicalSource?: string;
  firstPool?: {
    createdAt: string | number;
  };
  audit?: {
    isSus?: boolean;
    topHoldersPercentage?: number;
  };
  source?: string;
  priceHistory?: { price: number; timestamp: number; liquidity?: number }[];
  tapeAtStart?: { buys: number; sells: number };
  tapeHistory?: { buys: number; sells: number; timestamp: number }[];
  volume24h?: number;
  buyPressure?: number;
  sellPressure?: number;
}

export interface MarketSnapshot {
  launchpad: string;
  fdvUsd?: number;
  liquidityUsd?: number;
  liquidity?: number;
  usdPrice?: number;
  observedAt?: string;
  holderCount?: number;
  isVerified?: boolean;
}

export interface LaunchHistoryEntry {
  mint: string;
  firstSeenPrice: number;
  highestSeenPrice: number;
  isSuccess: boolean;
  timestamp: number;
}
