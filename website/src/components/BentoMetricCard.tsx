import type { ReactNode } from 'react';

interface Props {
  label: string;
  value: ReactNode;
  topBorderColor?: string;
  boxShadow?: string;
  valueColor?: string;
}

export function BentoMetricCard({ label, value, topBorderColor, boxShadow, valueColor }: Props) {
  return (
    <div
      className="glass-card"
      style={{
        padding: 'var(--space-lg)',
        borderTop: topBorderColor ? `2px solid ${topBorderColor}` : undefined,
        boxShadow,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-xs)',
      }}
    >
      <div
        className="text-caption-mono"
        style={{
          color: 'var(--color-mute)',
          fontSize: '10px',
          letterSpacing: '1.5px',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </div>
      <div className="text-display-md" style={{ color: valueColor ?? 'var(--color-ink)' }}>
        {value}
      </div>
    </div>
  );
}
