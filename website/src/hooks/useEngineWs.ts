import { useCallback, useEffect, useRef, useState } from 'react';
import type { LivePayload, TradeDetails, WsClientMessage, WsServerMessage } from '../types';

const WS_BASE = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8080';
const WS_TOKEN = import.meta.env.VITE_WS_TOKEN as string | undefined;
const WS_URL = WS_TOKEN ? `${WS_BASE}?token=${encodeURIComponent(WS_TOKEN)}` : WS_BASE;

const DEFAULT_LIVE_DATA: LivePayload = {
  activeSignals: 0,
  sessionWinRate: 0,
  tokensTraded: 0,
  pnl: '0.0000',
  recentTrades: [],
  isPaperTrading: true,
  burstModeEnabled: false,
  logs: [],
  mlMetrics: null,
  mlMetricsHistory: [],
};

export interface EngineWsState {
  wsConnected: boolean;
  authFailed: boolean;
  liveData: LivePayload;
  strategies: string[];
  currentStrategy: string;
  burstModeEnabled: boolean;
  selectedTrade: TradeDetails | null;
  showTradePanel: boolean;
}

export interface EngineWsActions {
  send: (msg: WsClientMessage) => void;
  setShowTradePanel: (v: boolean) => void;
  setSelectedTrade: (v: TradeDetails | null) => void;
  setBurstModeEnabled: (v: boolean) => void;
  setCurrentStrategy: (v: string) => void;
}

/**
 * Manages the WebSocket connection to the bot engine.
 * Owns connection state and reconnection logic; returns typed send/state accessors.
 */
export function useEngineWs(): EngineWsState & EngineWsActions {
  const [wsConnected, setWsConnected] = useState(false);
  const [authFailed, setAuthFailed] = useState(false);
  const [liveData, setLiveData] = useState<LivePayload>(DEFAULT_LIVE_DATA);
  const [strategies, setStrategies] = useState<string[]>([]);
  const [currentStrategy, setCurrentStrategy] = useState('');
  const [burstModeEnabled, setBurstModeEnabled] = useState(false);
  const [selectedTrade, setSelectedTrade] = useState<TradeDetails | null>(null);
  const [showTradePanel, setShowTradePanel] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);

  const send = useCallback((msg: WsClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout>;
    // Prevents scheduling a reconnect after the component has unmounted, which
    // would call setState on a dead component and leak a WebSocket connection.
    let unmounted = false;

    const connect = () => {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsConnected(true);
        setAuthFailed(false);
        ws.send(JSON.stringify({ type: 'GET_STRATEGIES' } satisfies WsClientMessage));
      };

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data as string) as WsServerMessage;

          if ('type' in payload && payload.type === 'TRADE_DETAILS_RESULT') {
            if (payload.data) {
              setSelectedTrade(payload.data);
              setShowTradePanel(true);
            } else {
              console.error('Trade details error:', payload.error);
            }
          } else if ('type' in payload && payload.type === 'STRATEGIES_RESULT') {
            if (payload.data) {
              setStrategies(payload.data);
              if (payload.current) setCurrentStrategy(payload.current);
            }
          } else if ('type' in payload && payload.type === 'STRATEGY_SET_SUCCESS') {
            // Bot restarts after strategy change — reconnect will happen automatically.
          } else if ('type' in payload && payload.type === 'BURST_MODE_SET_SUCCESS') {
            // Bot restarts after burst mode change — reconnect will happen automatically.
          } else if (!('type' in payload)) {
            // Periodic live-data broadcast (no `type` field).
            const lp = payload as LivePayload;
            setLiveData(lp);
            setBurstModeEnabled(lp.burstModeEnabled ?? false);
          }
        } catch (e) {
          console.error('Failed to parse WS data', e);
        }
      };

      ws.onclose = (event) => {
        setWsConnected(false);
        // Close code 1008 = the bot rejected our token (see api.service.ts). Retrying
        // with the same bad token won't help, so flag it for the UI and back off hard
        // instead of hammering a connection that can never succeed.
        const isAuthFailure = event.code === 1008;
        if (isAuthFailure) setAuthFailed(true);
        if (!unmounted) {
          reconnectTimer = setTimeout(connect, isAuthFailure ? 15000 : 3000);
        }
      };
    };

    connect();

    return () => {
      unmounted = true;
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, []);

  return {
    wsConnected,
    authFailed,
    liveData,
    strategies,
    currentStrategy,
    burstModeEnabled,
    selectedTrade,
    showTradePanel,
    send,
    setShowTradePanel,
    setSelectedTrade,
    setBurstModeEnabled,
    setCurrentStrategy,
  };
}
