import { useEffect, useRef } from 'react';
import gsap from 'gsap';
import { prefersReducedMotion } from '../lib/motion';

interface LiveModeModalProps {
  onConfirm: () => void;
  onCancel: () => void;
}

export function LiveModeModal({ onConfirm, onCancel }: LiveModeModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (prefersReducedMotion()) return;
    gsap.fromTo(overlayRef.current, { opacity: 0 }, { opacity: 1, duration: 0.2 });
    gsap.fromTo(
      contentRef.current,
      { opacity: 0, y: 20, scale: 0.95 },
      { opacity: 1, y: 0, scale: 1, duration: 0.4, ease: 'back.out(1.5)' }
    );
  }, []);

  const animateOut = (then: () => void) => {
    if (prefersReducedMotion()) {
      then();
      return;
    }
    gsap.to(overlayRef.current, { opacity: 0, duration: 0.2 });
    gsap.to(contentRef.current, {
      opacity: 0,
      scale: 0.95,
      duration: 0.2,
      onComplete: then,
    });
  };

  return (
    <div
      ref={overlayRef}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
      onClick={() => animateOut(onCancel)}
    >
      <div
        ref={contentRef}
        role="dialog"
        aria-modal="true"
        aria-label="Enable live trading confirmation"
        style={{
          background: 'var(--color-canvas)',
          padding: 'var(--space-2xl)',
          borderRadius: 'var(--rounded-lg)',
          boxShadow: 'var(--shadow-level5)',
          maxWidth: '420px',
          width: '90%',
          textAlign: 'center',
          border: '1px solid var(--color-error)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            width: '48px',
            height: '48px',
            backgroundColor: 'rgba(255, 95, 86, 0.1)',
            color: 'var(--color-error)',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto var(--space-md)',
          }}
        >
          <svg
            viewBox="0 0 24 24"
            width="24"
            height="24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>
        <h2 className="text-display-sm" style={{ marginBottom: 'var(--space-sm)' }}>
          Enable Live Trading?
        </h2>
        <p
          className="text-body-md"
          style={{ color: 'var(--color-body)', marginBottom: 'var(--space-xl)' }}
        >
          You are about to switch the engine into <strong>LIVE MODE</strong>. Actual funds will be
          used for execution. Ensure your risk parameters and stop-losses are configured correctly.
        </p>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button
            className="btn-secondary"
            onClick={() => animateOut(onCancel)}
            style={{ flex: 1 }}
          >
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => animateOut(onConfirm)}
            style={{
              flex: 1,
              backgroundColor: 'var(--color-error)',
              color: 'white',
              border: 'none',
            }}
          >
            Confirm Live
          </button>
        </div>
      </div>
    </div>
  );
}
