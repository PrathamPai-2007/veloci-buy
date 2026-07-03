import { useEffect, useMemo, useRef, useState } from 'react';
import type { RecentTrade } from '../types';

interface LogLine {
  text: string;
  type: 'info' | 'warn' | 'error' | 'trade';
}

interface Props {
  logs: string[];
  trades: RecentTrade[];
  wsConnected: boolean;
}

function lineColor(type: LogLine['type']): string {
  switch (type) {
    case 'error':
      return '#ff5f56';
    case 'warn':
      return '#f97316';
    case 'trade':
      return '#2563eb';
    default:
      return 'var(--color-body)';
  }
}

function classifyLine(line: string): LogLine['type'] {
  if (line.includes('[ERR]')) return 'error';
  if (line.includes('[WRN]')) return 'warn';
  if (line.includes('[TRD]')) return 'trade';
  return 'info';
}

export function ActivityLog({ logs, trades, wsConnected }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [prevTrades, setPrevTrades] = useState<RecentTrade[]>([]);
  const [tsMap, setTsMap] = useState<Record<string, string>>({});

  if (trades !== prevTrades) {
    let changed = false;
    const nextMap = { ...tsMap };
    trades.forEach((t) => {
      const key = `${t.mint}:${t.status}`;
      if (!nextMap[key]) {
        nextMap[key] = new Date().toISOString().slice(11, 19);
        changed = true;
      }
    });
    setPrevTrades(trades);
    if (changed) {
      setTsMap(nextMap);
    }
  }

  const tradesAsFeed = useMemo((): LogLine[] => {
    return trades
      .slice()
      .reverse()
      .slice(0, 25)
      .map((t) => {
        const key = `${t.mint}:${t.status}`;
        const ts = tsMap[key] ?? new Date().toISOString().slice(11, 19);
        if (t.status === 'PROFIT') {
          return {
            text: `${ts} [TRD] CLOSED ${t.symbol} — profit on ${t.platform}`,
            type: 'trade' as const,
          };
        } else if (t.status === 'LOSS') {
          return {
            text: `${ts} [TRD] CLOSED ${t.symbol} — loss on ${t.platform}`,
            type: 'warn' as const,
          };
        } else if (t.status === 'ACTIVE LIVE') {
          return {
            text: `${ts} [INF] ACTIVE ${t.symbol} live on ${t.platform}`,
            type: 'info' as const,
          };
        } else if (t.status === 'ACTIVE GHOST') {
          return {
            text: `${ts} [INF] GHOST ${t.symbol} tracking ${t.platform}`,
            type: 'info' as const,
          };
        }
        return {
          text: `${ts} [INF] ${t.symbol} ${t.status} on ${t.platform}`,
          type: 'info' as const,
        };
      });
  }, [trades, tsMap]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs.length, trades.length]);

  const hasRealLogs = logs.length > 0;

  const displayLines: LogLine[] = hasRealLogs
    ? logs.map((line) => ({ text: line, type: classifyLine(line) }))
    : tradesAsFeed;

  return (
    <div className="glass-card bento-cell-log" style={{ overflow: 'hidden', height: '100%' }}>
      {/* Header */}
      <div
        style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--glass-border)',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '10px',
            letterSpacing: '1.5px',
            color: 'var(--color-mute)',
            textTransform: 'uppercase',
          }}
        >
          Activity Log
        </span>
        <div
          style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            backgroundColor: wsConnected ? '#2563eb' : '#555',
            boxShadow: wsConnected ? '0 0 6px #2563eb' : 'none',
            flexShrink: 0,
          }}
        />
        {!hasRealLogs && wsConnected && (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '9px',
              color: 'var(--color-mute)',
              marginLeft: 'auto',
              letterSpacing: '0.5px',
            }}
          >
            trade feed
          </span>
        )}
      </div>

      {/* Log body */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '10px 14px 16px',
          fontFamily: 'var(--font-mono)',
          fontSize: '11px',
          lineHeight: '1.75',
        }}
      >
        {!wsConnected ? (
          <span style={{ color: 'var(--color-mute)' }}>
            Waiting for engine
            <span className="terminal-cursor">_</span>
          </span>
        ) : displayLines.length === 0 ? (
          <span style={{ color: 'var(--color-mute)' }}>
            No activity yet
            <span className="terminal-cursor">_</span>
          </span>
        ) : (
          displayLines.map((line, i) => (
            <div key={i} style={{ color: lineColor(line.type), wordBreak: 'break-word' }}>
              {line.text}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
