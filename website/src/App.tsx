import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import './index.css';
import SignIn from './SignIn';
import Dashboard from './Dashboard';
import { auth } from './lib/firebase';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { useMagneticButton } from './lib/useMagneticButton';
import { prefersReducedMotion } from './lib/motion';
import { Toaster } from 'sonner';
import { IconMoon, IconSun, IconMenu } from './components/icons';

const HowItWorks = lazy(() => import('./HowItWorks'));

type Page = 'home' | 'signin' | 'how-it-works' | 'dashboard';

function App() {
  const heroRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const subtitleRef = useRef<HTMLParagraphElement>(null);
  const ctaRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const [currentPage, setCurrentPage] = useState<Page>('home');
  const [user, setUser] = useState<User | null>(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const hasAutoRedirected = useRef(false);

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const saved = localStorage.getItem('theme');
      return saved === 'dark' || saved === 'light' ? saved : 'light';
    } catch {
      return 'light';
    }
  });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const toggleTheme = () => {
    setTheme((prev) => {
      const next = prev === 'light' ? 'dark' : 'light';
      try {
        localStorage.setItem('theme', next);
      } catch {
        // Fallback if third-party storage access is disabled or blocked
      }
      return next;
    });
  };

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  // Typewriter effect state
  const [typedLine, setTypedLine] = useState('');
  const [showLogs, setShowLogs] = useState(false);

  const magnetic = useMagneticButton();

  // Page Transition Navigation Handler
  const handleNavigate = (targetPage: Page) => {
    if (prefersReducedMotion()) {
      setCurrentPage(targetPage);
      return;
    }
    gsap.to('.page-container', {
      opacity: 0,
      y: -15,
      duration: 0.35,
      ease: 'power2.in',
      onComplete: () => {
        setCurrentPage(targetPage);
      },
    });
  };

  // Run landing page animation on mount/page reset
  useEffect(() => {
    if (currentPage === 'home') {
      // Reset terminal state when (re)entering the home page so the typewriter
      // replays. This synchronous reset is intentional — disabling the rule here.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTypedLine('');
      setShowLogs(false);

      // Reduced motion: show everything immediately, no entrance/typewriter.
      if (prefersReducedMotion()) {
        gsap.set('.page-container', { opacity: 1, y: 0 });
        setTypedLine('$ npm run dev:all');
        setShowLogs(true);
        return;
      }

      // Reset styles for entrance
      gsap.set('.page-container', { opacity: 0, y: 0 });
      gsap.to('.page-container', { opacity: 1, duration: 0.4 });

      const tl = gsap.timeline();

      tl.fromTo(
        titleRef.current,
        { opacity: 0, y: 30 },
        { opacity: 1, y: 0, duration: 0.8, ease: 'power3.out' }
      )
        .fromTo(
          subtitleRef.current,
          { opacity: 0, y: 20 },
          { opacity: 1, y: 0, duration: 0.6, ease: 'power3.out' },
          '-=0.4'
        )
        .fromTo(
          ctaRef.current,
          { opacity: 0, y: 20 },
          { opacity: 1, y: 0, duration: 0.6, ease: 'power3.out' },
          '-=0.4'
        )
        .fromTo(
          cardRef.current,
          { opacity: 0, scale: 0.95 },
          { opacity: 1, scale: 1, duration: 0.8, ease: 'back.out(1.2)' },
          '-=0.2'
        );

      // Start typewriter loop
      const text = '$ npm run dev:all';
      let i = 0;
      const interval = setInterval(() => {
        setTypedLine(text.slice(0, i + 1));
        i++;
        if (i >= text.length) {
          clearInterval(interval);
          setShowLogs(true);
        }
      }, 60);

      return () => clearInterval(interval);
    }
  }, [currentPage]);

  // Handle staggered entry of terminal lines once typewriter completes
  useEffect(() => {
    if (showLogs) {
      gsap.fromTo(
        '.terminal-log-line',
        { opacity: 0, y: 10 },
        { opacity: 1, y: 0, duration: 0.4, stagger: 0.15, ease: 'power2.out' }
      );
    }
  }, [showLogs]);

  useEffect(() => {
    if (prefersReducedMotion()) return;
    // Background mesh movement
    const tween = gsap.to('.hero-gradient', {
      backgroundPosition: '100% 100%',
      duration: 10,
      repeat: -1,
      yoyo: true,
      ease: 'sine.inOut',
    });
    return () => {
      tween.kill();
    };
  }, []);

  // Single auth subscription on mount. On first sign-in, redirect to the
  // dashboard exactly once (so navigating away afterwards isn't overridden).
  // On sign-out, reset the flag so the next sign-in redirects again.
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (currentUser && !hasAutoRedirected.current) {
        hasAutoRedirected.current = true;
        setCurrentPage('dashboard');
      }
      if (!currentUser) {
        hasAutoRedirected.current = false;
        setCurrentPage('home');
      }
      setLoadingAuth(false);
    });
    return () => unsubscribe();
  }, []);

  if (loadingAuth) {
    return (
      <div
        style={{
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'var(--color-canvas)',
        }}
      >
        <div className="spinner" />
      </div>
    );
  }

  const renderContent = () => {
    if (currentPage === 'dashboard' && user) {
      return (
        <Dashboard
          theme={theme}
          onToggleTheme={toggleTheme}
          onNavigateHowItWorks={() => handleNavigate('how-it-works')}
          onNavigateHome={() => handleNavigate('home')}
        />
      );
    }

    if (currentPage === 'signin') {
      return <SignIn onBack={() => handleNavigate('home')} />;
    }

    if (currentPage === 'how-it-works') {
      return (
        <Suspense
          fallback={
            <div
              style={{
                height: '100vh',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: 'var(--color-canvas)',
              }}
            >
              <div className="spinner" />
            </div>
          }
        >
          <HowItWorks
            onBack={() => handleNavigate('home')}
            onStartTrading={() => (user ? handleNavigate('dashboard') : handleNavigate('signin'))}
          />
        </Suspense>
      );
    }

    return (
      <div
        className="page-container"
        style={{ position: 'relative', minHeight: '100vh', overflow: 'hidden' }}
      >
        {/* Background Mesh Gradient */}
        <div className="hero-gradient"></div>

        {/* Navigation */}
        <nav
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            padding: 'var(--space-md) var(--space-lg)',
            alignItems: 'center',
            gap: 'var(--space-sm)',
            flexWrap: 'wrap',
            borderBottom: '1px solid var(--color-hairline)',
            position: 'relative',
          }}
        >
          <div style={{ fontWeight: 600, fontSize: '18px' }}>veloci-buy</div>
          <div className="desktop-nav" style={{ gap: 'var(--space-sm)', alignItems: 'center' }}>
            <button
              onClick={toggleTheme}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '6px 12px',
                borderRadius: '6px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--color-ink)',
              }}
              aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
            >
              {theme === 'light' ? <IconMoon /> : <IconSun />}
            </button>
            <button
              className="nav-btn"
              onClick={() =>
                window.open('https://github.com/PrathamPai-2007/veloci-buy#readme', '_blank')
              }
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: '14px',
                color: 'var(--color-body)',
                borderRadius: '6px',
                padding: '6px 12px',
              }}
            >
              Documentation
            </button>
            <button
              className="nav-btn"
              onClick={() => (user ? handleNavigate('dashboard') : handleNavigate('signin'))}
              style={{
                background: 'var(--color-primary)',
                color: 'var(--color-on-primary)',
                border: 'none',
                borderRadius: '6px',
                padding: '6px 12px',
                fontSize: '14px',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              {user ? 'Go to Dashboard' : 'Get Started'}
            </button>
          </div>
          <div className="mobile-nav-toggle" style={{ gap: '8px', alignItems: 'center' }}>
            <button
              onClick={toggleTheme}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '6px 12px',
                borderRadius: '6px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--color-ink)',
              }}
              aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
            >
              {theme === 'light' ? <IconMoon /> : <IconSun />}
            </button>
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--color-ink)',
                padding: '4px 8px',
                display: 'flex',
                alignItems: 'center',
              }}
              aria-label="Toggle Menu"
              aria-expanded={mobileMenuOpen}
            >
              <IconMenu />
            </button>
          </div>
        </nav>

        {/* Mobile Menu Dropdown */}
        {mobileMenuOpen && (
          <div
            className="mobile-menu"
            style={{
              flexDirection: 'column',
              gap: 'var(--space-md)',
              padding: 'var(--space-md) var(--space-lg)',
              borderBottom: '1px solid var(--color-hairline)',
              backgroundColor: 'var(--color-canvas)',
            }}
          >
            <button
              className="nav-btn"
              onClick={() => {
                setMobileMenuOpen(false);
                window.open('https://github.com/PrathamPai-2007/veloci-buy#readme', '_blank');
              }}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: '14px',
                color: 'var(--color-body)',
                borderRadius: '6px',
                padding: '8px 12px',
                textAlign: 'left',
              }}
            >
              Documentation
            </button>
            <button
              className="nav-btn"
              onClick={() => {
                setMobileMenuOpen(false);
                if (user) {
                  handleNavigate('dashboard');
                } else {
                  handleNavigate('signin');
                }
              }}
              style={{
                background: 'var(--color-primary)',
                color: 'var(--color-on-primary)',
                border: 'none',
                borderRadius: '6px',
                padding: '8px 12px',
                fontSize: '14px',
                fontWeight: 500,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              {user ? 'Go to Dashboard' : 'Get Started'}
            </button>
          </div>
        )}

        {/* Hero Section */}
        <main
          style={{
            padding: 'var(--space-5xl) var(--space-lg)',
            maxWidth: '1200px',
            margin: '0 auto',
          }}
        >
          <div ref={heroRef} style={{ textAlign: 'center', marginBottom: 'var(--space-4xl)' }}>
            <div
              className="text-caption-mono"
              style={{ color: 'var(--color-violet)', marginBottom: 'var(--space-md)' }}
            >
              V3 IS NOW LIVE!
            </div>
            <h1
              ref={titleRef}
              className="text-display-xl"
              style={{ marginBottom: 'var(--space-lg)', color: 'var(--color-ink)' }}
            >
              High-performance Solana execution.
            </h1>
            <p
              ref={subtitleRef}
              className="text-body-lg"
              style={{
                color: 'var(--color-body)',
                maxWidth: '600px',
                margin: '0 auto',
                marginBottom: 'var(--space-xl)',
              }}
            >
              A premier discovery and execution engine for Solana tokens. Designed for speed,
              safety, and precision.
            </p>
            <div
              ref={ctaRef}
              style={{
                display: 'flex',
                gap: 'var(--space-sm)',
                justifyContent: 'center',
                flexWrap: 'wrap',
              }}
            >
              <button
                className="btn-primary"
                {...magnetic}
                onClick={() => (user ? handleNavigate('dashboard') : handleNavigate('signin'))}
              >
                Start Trading
              </button>
              <button
                className="btn-secondary"
                {...magnetic}
                onClick={() => handleNavigate('how-it-works')}
              >
                How it works
              </button>
            </div>
          </div>

          {/* Feature / Terminal Mockup */}
          <div
            ref={cardRef}
            style={{
              background: 'var(--color-primary)',
              borderRadius: 'var(--rounded-md)',
              padding: 'var(--space-lg)',
              color: 'var(--color-on-primary)',
              boxShadow: 'var(--shadow-level4)',
              maxWidth: '800px',
              margin: '0 auto',
              position: 'relative',
            }}
          >
            <div style={{ display: 'flex', gap: '8px', marginBottom: 'var(--space-md)' }}>
              <div
                style={{
                  width: '12px',
                  height: '12px',
                  borderRadius: '50%',
                  backgroundColor: '#ff5f56',
                }}
              ></div>
              <div
                style={{
                  width: '12px',
                  height: '12px',
                  borderRadius: '50%',
                  backgroundColor: '#ffbd2e',
                }}
              ></div>
              <div
                style={{
                  width: '12px',
                  height: '12px',
                  borderRadius: '50%',
                  backgroundColor: '#27c93f',
                }}
              ></div>
            </div>
            <pre
              className="text-caption-mono"
              style={{ color: 'var(--color-cyan)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}
            >
              <span>{typedLine}</span>
              <span className="terminal-cursor">|</span>
              <br />
              {showLogs && (
                <span style={{ display: 'flex', flexDirection: 'column', marginTop: '8px' }}>
                  <span className="terminal-log-line" style={{ color: 'var(--color-mute)' }}>
                    [INFO] Initializing Geyser plugin...
                  </span>
                  <span className="terminal-log-line" style={{ color: 'var(--color-mute)' }}>
                    [INFO] Connecting to RPC...
                  </span>
                  <span
                    className="terminal-log-line"
                    style={{ color: 'var(--color-cyan)', fontWeight: 500 }}
                  >
                    [SUCCESS] Engine ready. Waiting for signals...
                  </span>
                  <span
                    className="terminal-log-line"
                    style={{ color: 'var(--color-violet)', fontWeight: 500 }}
                  >
                    [EXEC] Opportunity found. Route calculated.
                  </span>
                </span>
              )}
            </pre>
          </div>
        </main>
      </div>
    );
  };

  return (
    <>
      <Toaster richColors position="top-right" />
      {renderContent()}
    </>
  );
}

export default App;
