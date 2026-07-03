import { useEffect, useState } from 'react';

interface Props {
  pnlSol: string | number;
  solPrice: number | null;
  isPaperTrading: boolean;
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function SessionStatsWidget({ pnlSol, solPrice, isPaperTrading }: Props) {
  const [sessionStart] = useState(() => Date.now());
  const [uptime, setUptime] = useState('0s');

  useEffect(() => {
    const id = setInterval(() => {
      setUptime(formatUptime(Date.now() - sessionStart));
    }, 1000);
    return () => clearInterval(id);
  }, [sessionStart]);

  const pnlNum = parseFloat(pnlSol as string) || 0;
  const pnlUsd = solPrice !== null ? pnlNum * solPrice : null;
  const pnlColor = pnlNum >= 0 ? '#14a37f' : '#ff5f56';

  return (
    <div
      className="glass-card"
      style={{
        padding: 'var(--space-md)',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      }}
    >
      <div
        className="text-caption-mono"
        style={{
          fontSize: '10px',
          letterSpacing: '1.5px',
          color: 'var(--color-mute)',
          textTransform: 'uppercase',
        }}
      >
        Session
      </div>

      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '11px',
          color: 'var(--color-body)',
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
        }}
      >
        <div>↑ {uptime}</div>
        {pnlUsd !== null && (
          <div style={{ color: pnlColor, fontWeight: 600, fontSize: '13px' }}>
            {pnlUsd >= 0 ? '+' : ''}
            {pnlUsd.toFixed(2)} USD
          </div>
        )}
        <div
          style={{
            display: 'inline-flex',
            alignSelf: 'flex-start',
            padding: '2px 7px',
            borderRadius: '100px',
            fontSize: '9px',
            letterSpacing: '0.5px',
            fontFamily: 'var(--font-mono)',
            backgroundColor: isPaperTrading ? 'rgba(121,40,202,0.10)' : 'rgba(255,95,86,0.10)',
            border: `1px solid ${isPaperTrading ? 'rgba(121,40,202,0.22)' : 'rgba(255,95,86,0.22)'}`,
            color: isPaperTrading ? 'var(--color-violet)' : 'var(--color-error)',
            marginTop: '2px',
          }}
        >
          {isPaperTrading ? 'PAPER' : 'LIVE'}
        </div>
      </div>
    </div>
  );
}
