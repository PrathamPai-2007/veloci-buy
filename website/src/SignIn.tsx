import { useEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { signInWithGoogle } from './lib/firebase';
import { useMagneticButton } from './lib/useMagneticButton';
import { prefersReducedMotion } from './lib/motion';

interface SignInProps {
  onBack: () => void;
}

export default function SignIn({ onBack }: SignInProps) {
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const elementsRef = useRef<HTMLDivElement>(null);

  const magnetic = useMagneticButton(0.3);

  useEffect(() => {
    if (prefersReducedMotion()) {
      gsap.set([containerRef.current, cardRef.current], { opacity: 1, y: 0, scale: 1 });
      return;
    }

    // Elegant entrance animation
    const tl = gsap.timeline();

    tl.fromTo(
      containerRef.current,
      { opacity: 0 },
      { opacity: 1, duration: 0.5, ease: 'power2.out' }
    )
      .fromTo(
        cardRef.current,
        { opacity: 0, y: 40, scale: 0.98 },
        { opacity: 1, y: 0, scale: 1, duration: 0.7, ease: 'power3.out' },
        '-=0.3'
      )
      .fromTo(
        elementsRef.current?.children ? Array.from(elementsRef.current.children) : [],
        { opacity: 0, y: 15 },
        { opacity: 1, y: 0, duration: 0.4, stagger: 0.1, ease: 'power2.out' },
        '-=0.4'
      );

    // Subtle breathing background for depth
    gsap.to('.hero-gradient', {
      backgroundPosition: '100% 100%',
      duration: 15,
      repeat: -1,
      yoyo: true,
      ease: 'sine.inOut',
    });
  }, []);

  // Shake effect on errorMsg trigger
  useEffect(() => {
    if (errorMsg && !prefersReducedMotion()) {
      const shakeTl = gsap.timeline();
      shakeTl
        .to(cardRef.current, { x: -8, duration: 0.05, repeat: 5, yoyo: true })
        .to(cardRef.current, { x: 0, duration: 0.05 });
    }
  }, [errorMsg]);

  return (
    <div
      ref={containerRef}
      className="page-container"
      style={{
        position: 'relative',
        minHeight: '100vh',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div className="hero-gradient" style={{ opacity: 0.5 }}></div>

      <div style={{ position: 'absolute', top: 'var(--space-md)', left: 'var(--space-lg)' }}>
        <button
          onClick={onBack}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: '14px',
            color: 'var(--color-body)',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          ← Back
        </button>
      </div>

      <div
        ref={cardRef}
        style={{
          background: 'var(--color-canvas)',
          padding: 'var(--space-xl)',
          borderRadius: 'var(--rounded-lg)',
          boxShadow: 'var(--shadow-level4)',
          width: '100%',
          maxWidth: '400px',
          margin: 'var(--space-lg)',
        }}
      >
        <div
          ref={elementsRef}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}
        >
          <div style={{ textAlign: 'center', marginBottom: 'var(--space-sm)' }}>
            <h1
              className="text-display-md"
              style={{ color: 'var(--color-ink)', marginBottom: 'var(--space-xs)' }}
            >
              Welcome Back
            </h1>
            <p className="text-body-sm" style={{ color: 'var(--color-body)' }}>
              Sign in to access your execution engine.
            </p>
          </div>

          {errorMsg && (
            <div
              role="alert"
              style={{
                color: 'var(--color-error)',
                background: 'rgba(255, 95, 86, 0.1)',
                padding: '8px',
                borderRadius: '4px',
                fontSize: '12px',
                textAlign: 'center',
              }}
            >
              {errorMsg}
            </div>
          )}

          <button
            {...magnetic}
            onClick={async () => {
              setErrorMsg(null);
              try {
                await signInWithGoogle();
              } catch (error: unknown) {
                console.error('Google Sign In Error:', error);
                const message =
                  error instanceof Error ? error.message : 'Failed to sign in with Google';
                setErrorMsg(message);
              }
            }}
            className="btn-secondary"
            style={{ width: '100%', gap: '12px', justifyContent: 'center' }}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
            Sign in with Google
          </button>
        </div>
      </div>
    </div>
  );
}
