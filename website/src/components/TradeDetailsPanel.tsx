import { useEffect, useRef } from 'react';
import gsap from 'gsap';
import type { TradeDetails } from '../types';
import { prefersReducedMotion } from '../lib/motion';

interface TradeDetailsPanelProps {
  trade: TradeDetails;
  onClose: () => void;
}

export function TradeDetailsPanel({ trade, onClose }: TradeDetailsPanelProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const drawerContentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!prefersReducedMotion()) {
      gsap.fromTo(overlayRef.current, { opacity: 0 }, { opacity: 1, duration: 0.3 });
      gsap.fromTo(panelRef.current, { x: '100%' }, { x: '0%', duration: 0.4, ease: 'power3.out' });
    }
    // Stagger drawer content after the panel slides in
    requestAnimationFrame(() => {
      if (drawerContentRef.current) {
        gsap.fromTo(
          drawerContentRef.current.children,
          { opacity: 0, y: 15 },
          { opacity: 1, y: 0, duration: 0.45, stagger: 0.08, ease: 'power2.out', delay: 0.15 }
        );
      }
    });
  }, []);

  const handleClose = () => {
    if (prefersReducedMotion()) {
      onClose();
      return;
    }
    gsap.to(overlayRef.current, { opacity: 0, duration: 0.3 });
    gsap.to(panelRef.current, {
      x: '100%',
      duration: 0.3,
      ease: 'power3.in',
      onComplete: onClose,
    });
  };

  const pnl = trade.realizedPnlSol ?? 0;
  const isProfitable = pnl > 0;

  return (
    <div
      ref={overlayRef}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.4)',
        backdropFilter: 'blur(2px)',
        zIndex: 200,
      }}
      onClick={handleClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Trade details for ${trade.symbol || 'token'}`}
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: 'min(450px, 100vw)',
          background: 'var(--color-canvas)',
          borderLeft: '1px solid var(--color-hairline)',
          boxShadow: '-10px 0 30px rgba(0,0,0,0.1)',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: 'var(--space-xl)',
            borderBottom: '1px solid var(--color-hairline)',
          }}
        >
          <div
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}
          >
            <div>
              <h2 className="text-display-md" style={{ marginBottom: '4px' }}>
                {trade.symbol || 'UNKNOWN'}
              </h2>
              <div className="text-caption-mono text-body" style={{ fontSize: '12px' }}>
                {trade.mint}
              </div>
            </div>
            <button
              onClick={handleClose}
              aria-label="Close trade details"
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--color-body)',
                cursor: 'pointer',
                fontSize: '24px',
              }}
            >
              &times;
            </button>
          </div>
          <div
            style={{
              marginTop: '16px',
              display: 'inline-block',
              padding: '4px 10px',
              borderRadius: '4px',
              backgroundColor: trade.isGhost
                ? 'rgba(138,43,226,0.1)'
                : isProfitable
                  ? 'rgba(39,201,63,0.1)'
                  : 'rgba(255,95,86,0.1)',
              color: trade.isGhost
                ? 'var(--color-violet)'
                : isProfitable
                  ? 'var(--color-cyan-deep)'
                  : 'var(--color-error)',
              fontWeight: 600,
              fontSize: '12px',
              letterSpacing: '0.5px',
            }}
          >
            {trade.isGhost ? 'GHOST TRADE' : isProfitable ? 'PROFITABLE' : 'LOSS'}
          </div>
        </div>

        {/* Content */}
        <div ref={drawerContentRef} style={{ padding: 'var(--space-xl)', flex: 1 }}>
          <h3 className="text-caption-mono text-body" style={{ marginBottom: '12px' }}>
            FINANCIALS
          </h3>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '16px',
              marginBottom: '32px',
            }}
          >
            <div>
              <div
                className="text-caption-mono"
                style={{ color: 'var(--color-body)', fontSize: '11px', marginBottom: '4px' }}
              >
                ENTRY PRICE
              </div>
              <div style={{ fontWeight: 500 }}>${trade.entryPriceUsd?.toFixed(6) || 'N/A'}</div>
            </div>
            <div>
              <div
                className="text-caption-mono"
                style={{ color: 'var(--color-body)', fontSize: '11px', marginBottom: '4px' }}
              >
                HIGHEST PRICE
              </div>
              <div style={{ fontWeight: 500 }}>${trade.highestPriceUsd?.toFixed(6) || 'N/A'}</div>
            </div>
            <div>
              <div
                className="text-caption-mono"
                style={{ color: 'var(--color-body)', fontSize: '11px', marginBottom: '4px' }}
              >
                REALIZED P&L (SOL)
              </div>
              <div
                style={{
                  fontWeight: 600,
                  color: isProfitable ? 'var(--color-cyan-deep)' : 'var(--color-error)',
                }}
              >
                {isProfitable ? '+' : ''}
                {pnl.toFixed(4)} SOL
              </div>
            </div>
            <div>
              <div
                className="text-caption-mono"
                style={{ color: 'var(--color-body)', fontSize: '11px', marginBottom: '4px' }}
              >
                ENTRY VALUE (USD)
              </div>
              <div style={{ fontWeight: 500 }}>${trade.entryUsdValue?.toFixed(2) || 'N/A'}</div>
            </div>
          </div>

          <h3 className="text-caption-mono text-body" style={{ marginBottom: '12px' }}>
            EXECUTION
          </h3>
          <div
            style={{
              background: 'var(--color-canvas-soft)',
              padding: '16px',
              borderRadius: '8px',
              border: '1px solid var(--color-hairline)',
              marginBottom: '32px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
              <span style={{ color: 'var(--color-body)' }}>Exit Reason:</span>
              <span style={{ fontWeight: 500 }}>{trade.exitReason || 'Unknown'}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
              <span style={{ color: 'var(--color-body)' }}>Hold Time:</span>
              <span style={{ fontWeight: 500 }}>
                {trade.holdSeconds ? `${trade.holdSeconds}s` : 'N/A'}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--color-body)' }}>Targets Hit:</span>
              <span style={{ fontWeight: 500 }}>{trade.targetsHit || 0}</span>
            </div>
          </div>

          <h3 className="text-caption-mono text-body" style={{ marginBottom: '12px' }}>
            ENGINE INSIGHTS
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <div>
              <div
                className="text-caption-mono"
                style={{ color: 'var(--color-body)', fontSize: '11px', marginBottom: '4px' }}
              >
                ML CONFIDENCE
              </div>
              <div style={{ fontWeight: 500 }}>
                {typeof trade.entryScore === 'number'
                  ? Math.min(
                      100,
                      Math.max(0, trade.entryScore > 1 ? trade.entryScore : trade.entryScore * 100)
                    ).toFixed(1) + '%'
                  : 'N/A'}
              </div>
            </div>
            <div>
              <div
                className="text-caption-mono"
                style={{ color: 'var(--color-body)', fontSize: '11px', marginBottom: '4px' }}
              >
                TP PROFILE
              </div>
              <div style={{ fontWeight: 500 }}>{trade.tpProfile || 'Default'}</div>
            </div>
            <div>
              <div
                className="text-caption-mono"
                style={{ color: 'var(--color-body)', fontSize: '11px', marginBottom: '4px' }}
              >
                VOLATILITY SCALER
              </div>
              <div style={{ fontWeight: 500 }}>{trade.volatilityScaler?.toFixed(2) || '1.00'}x</div>
            </div>
            <div>
              <div
                className="text-caption-mono"
                style={{ color: 'var(--color-body)', fontSize: '11px', marginBottom: '4px' }}
              >
                LAUNCHPAD
              </div>
              <div style={{ fontWeight: 500 }}>{trade.launchpad || 'pump.fun'}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
