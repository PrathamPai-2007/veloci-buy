export type Venue = 'pumpfun' | 'raydium' | 'meteora';

export interface PricePoint {
  timestamp: number;
  slot: number;
  price: number;
}

export interface LiquidityPoint {
  timestamp: number;
  liquidityUsd: number;
}

export interface TokenHolderState {
  owner: string;
  amount: bigint;
  percentage: number;
}

export interface LocalMarketSnapshot {
  mint: string;
  symbol?: string;
  venue: Venue;
  priceUsd: number;
  liquidityUsd: number;
  fdvUsd: number;
  totalSupply: bigint;
  updatedAt: number;
  sourceSlot: number;
  source?: string;
  rawState?: unknown;

  // Volume & flow metrics
  buyVolume1m: number;
  sellVolume1m: number;
  tradeCount1m: number;

  // Provenance & Authority Status
  status?: 'provisional' | 'authoritative';

  // Holder metrics
  top5ConcentrationPct: number;
  top10ConcentrationPct: number;
  holderCount: number;
}

export type MarketStateStatus = 'AVAILABLE' | 'PROVISIONAL' | 'AUTHORITATIVE' | 'MISSING';

export interface MarketPriceDetails {
  priceUsd: number | null;
  status: MarketStateStatus;
  source?: string;
  observedAt: number;
  ageMs: number;
  sourceSlot: number;
  isFresh: boolean;
}

export type MarketStateEventMap = {
  priceUpdated: (snapshot: LocalMarketSnapshot) => void;
  liquidityChanged: (mint: string, oldLiq: number, newLiq: number) => void;
  holderDrift: (mint: string, top5Pct: number) => void;
};
