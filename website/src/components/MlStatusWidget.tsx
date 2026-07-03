interface MlMetricsShape {
  accuracy?: number;
  precision?: number;
  totalSamples?: number;
  trainedAt?: string | number;
  [key: string]: unknown;
}

interface Props {
  mlMetrics?: unknown;
  topBorderColor?: string;
  boxShadow?: string;
}

export function MlStatusWidget({ mlMetrics, topBorderColor, boxShadow }: Props) {
  const metrics = mlMetrics as MlMetricsShape | null | undefined;
  const isActive = !!metrics && typeof metrics === 'object';

  const accuracy = isActive && typeof metrics?.accuracy === 'number' ? metrics.accuracy : null;
  const samples =
    isActive && typeof metrics?.totalSamples === 'number' ? metrics.totalSamples : null;

  return (
    <div
      className="glass-card"
      style={{
        padding: 'var(--space-md)',
        borderTop: topBorderColor ? `2px solid ${topBorderColor}` : undefined,
        boxShadow,
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
        ML Model
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <div
          style={{
            display: 'inline-flex',
            padding: '2px 8px',
            borderRadius: '100px',
            fontSize: '10px',
            fontFamily: 'var(--font-mono)',
            letterSpacing: '0.5px',
            backgroundColor: isActive ? 'rgba(37,99,235,0.10)' : 'rgba(136,136,136,0.10)',
            border: `1px solid ${isActive ? 'rgba(37,99,235,0.30)' : 'rgba(136,136,136,0.18)'}`,
            color: isActive ? '#2563eb' : 'var(--color-mute)',
          }}
        >
          {isActive ? 'ACTIVE' : 'OFFLINE'}
        </div>
      </div>

      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '11px',
          color: 'var(--color-body)',
          display: 'flex',
          flexDirection: 'column',
          gap: '2px',
          marginTop: '2px',
        }}
      >
        {accuracy !== null && <div>ACC {(accuracy * 100).toFixed(1)}%</div>}
        {samples !== null && <div>{samples.toLocaleString()} samples</div>}
        {!isActive && (
          <div style={{ color: 'var(--color-mute)', fontSize: '10px' }}>Set ML_ENABLED=true</div>
        )}
      </div>
    </div>
  );
}
