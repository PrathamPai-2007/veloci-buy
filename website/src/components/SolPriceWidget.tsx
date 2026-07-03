import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const POLL_MS = 120_000;
const URL = 'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT';

interface BinanceResponse {
  symbol: string;
  price: string;
}

interface Props {
  onPriceUpdate?: (price: number) => void;
  topBorderColor?: string;
  boxShadow?: string;
}

export function SolPriceWidget({ onPriceUpdate, topBorderColor, boxShadow }: Props) {
  const [price, setPrice] = useState<number | null>(null);
  const [prevPrice, setPrevPrice] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const prevRef = useRef<number | null>(null);
  const cbRef = useRef(onPriceUpdate);
  useLayoutEffect(() => {
    cbRef.current = onPriceUpdate;
  });

  useEffect(() => {
    let cancelled = false;

    const fetchPrice = async () => {
      try {
        const res = await fetch(URL);
        if (!res.ok) throw new Error(`${res.status}`);
        const json = (await res.json()) as BinanceResponse;
        const p = parseFloat(json.price);
        if (!isNaN(p) && !cancelled) {
          setPrevPrice(prevRef.current);
          prevRef.current = p;
          setPrice(p);
          setLoading(false);
          setError(false);
          cbRef.current?.(p);
        }
      } catch {
        if (!cancelled) {
          setError(true);
          setLoading(false);
        }
      }
    };

    fetchPrice();
    const id = setInterval(fetchPrice, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const direction =
    prevPrice !== null && price !== null
      ? price > prevPrice
        ? '▲'
        : price < prevPrice
          ? '▼'
          : ''
      : '';
  const dirColor = direction === '▲' ? '#2563eb' : direction === '▼' ? '#ff5f56' : 'transparent';

  return (
    <div
      className="glass-card"
      style={{
        padding: 'var(--space-md)',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        borderTop: topBorderColor ? `2px solid ${topBorderColor}` : undefined,
        boxShadow,
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
        SOL / USD
      </div>

      {loading ? (
        <div
          className="skeleton-loader"
          style={{ height: '28px', width: '100px', borderRadius: '6px' }}
        />
      ) : error ? (
        <div
          style={{ color: 'var(--color-error)', fontSize: '13px', fontFamily: 'var(--font-mono)' }}
        >
          Unavailable
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
          <span
            style={{
              fontSize: '22px',
              fontWeight: 600,
              color: 'var(--color-ink)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            ${price?.toFixed(2)}
          </span>
          <span
            style={{
              fontSize: '11px',
              color: dirColor,
              fontFamily: 'var(--font-mono)',
              transition: 'color 0.3s',
            }}
          >
            {direction || '—'}
          </span>
        </div>
      )}

      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '9px',
          color: 'var(--color-mute)',
          letterSpacing: '0.5px',
        }}
      >
        Binance · 2m
      </div>
    </div>
  );
}
