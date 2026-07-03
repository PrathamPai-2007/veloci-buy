// Shapes shared between the dashboard and the bot's WebSocket API
// (mirrors the payloads built in src/services/api.service.ts).

export interface RecentTrade {
  status: string;
  symbol: string;
  mint: string;
  platform: string;
  color: string;
}

export interface LivePayload {
  activeSignals: number;
  sessionWinRate: number;
  tokensTraded: number;
  pnl: string | number;
  recentTrades: RecentTrade[];
  isPaperTrading: boolean;
  burstModeEnabled: boolean;
  logs?: string[];
  mlMetrics?: unknown;
  mlMetricsHistory?: unknown[];
}

/** Full position / closed-trade detail returned by GET_TRADE_DETAILS. */
export interface TradeDetails {
  symbol?: string;
  mint: string;
  isGhost?: boolean;
  realizedPnlSol?: number;
  entryPriceUsd?: number;
  highestPriceUsd?: number;
  entryUsdValue?: number;
  exitReason?: string;
  holdSeconds?: number;
  targetsHit?: number;
  entryScore?: number;
  tpProfile?: string;
  volatilityScaler?: number;
  launchpad?: string;
}

export type TradingMode = 'paper' | 'live';

export type WsClientMessage =
  | { type: 'SET_TRADING_MODE'; mode: TradingMode }
  | { type: 'GET_TRADE_DETAILS'; mint: string }
  | { type: 'GET_STRATEGIES' }
  | { type: 'SET_STRATEGY'; strategy: string }
  | { type: 'SET_BURST_MODE'; enabled: boolean };

export type WsServerMessage =
  | LivePayload
  | { type: 'TRADE_DETAILS_RESULT'; data?: TradeDetails; error?: string }
  | { type: 'STRATEGIES_RESULT'; data?: string[]; current?: string; error?: string }
  | { type: 'STRATEGY_SET_SUCCESS' }
  | { type: 'BURST_MODE_SET_SUCCESS' };
