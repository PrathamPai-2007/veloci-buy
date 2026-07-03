import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import gsap from 'gsap';
import { getAuth, signOut } from 'firebase/auth';
import type { RecentTrade } from './types';
import { prefersReducedMotion } from './lib/motion';
import { AnimatedNumber } from './components/AnimatedNumber';
import { LiveModeModal } from './components/LiveModeModal';
import { TradeDetailsPanel } from './components/TradeDetailsPanel';
import { BentoMetricCard } from './components/BentoMetricCard';
import { ActivityLog } from './components/ActivityLog';
import { SolPriceWidget } from './components/SolPriceWidget';
import { MlStatusWidget } from './components/MlStatusWidget';
import { useEngineWs } from './hooks/useEngineWs';
import { toast } from 'sonner';
import { IconMoon, IconSun, IconMenu } from './components/icons';

interface DashboardProps {
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onNavigateHowItWorks: () => void;
  onNavigateHome: () => void;
}

function SkeletonCard() {
  return (
    <div
      style={{
        background: 'var(--color-canvas)',
        padding: 'var(--space-lg)',
        borderRadius: 'var(--rounded-md)',
        border: '1px solid var(--color-hairline)',
        boxShadow: 'var(--shadow-level1)',
      }}
    >
      <div
        className="skeleton-loader"
        style={{
          height: '16px',
          width: '120px',
          marginBottom: 'var(--space-md)',
        }}
      />
      <div
        className="skeleton-loader"
        style={{
          height: '32px',
          width: '80px',
        }}
      />
    </div>
  );
}

function SkeletonRow({ index }: { index: number }) {
  return (
    <div
      style={{
        padding: 'var(--space-sm) var(--space-lg)',
        borderBottom: index !== 4 ? '1px solid var(--color-hairline)' : 'none',
        display: 'grid',
        gridTemplateColumns: '1fr 2fr 1fr 1fr',
        alignItems: 'center',
      }}
      className="trade-row text-body-sm"
    >
      <div data-label="STATUS" className="trade-cell status-cell">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div
            className="skeleton-loader"
            style={{ width: '8px', height: '8px', borderRadius: '50%' }}
          />
          <div className="skeleton-loader" style={{ height: '14px', width: '60px' }} />
        </div>
      </div>
      <div
        data-label="TOKEN"
        className="trade-cell token-cell"
        style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}
      >
        <div className="skeleton-loader" style={{ height: '14px', width: '80px' }} />
        <div className="skeleton-loader" style={{ height: '11px', width: '120px' }} />
      </div>
      <div data-label="PLATFORM" className="trade-cell platform-cell">
        <div className="skeleton-loader" style={{ height: '14px', width: '70px' }} />
      </div>
      <div data-label="DETAILS" className="trade-cell details-cell">
        <div
          className="skeleton-loader"
          style={{ height: '22px', width: '50px', borderRadius: 'var(--rounded-xs)' }}
        />
      </div>
    </div>
  );
}

export default function Dashboard({
  theme,
  onToggleTheme,
  onNavigateHowItWorks,
  onNavigateHome,
}: DashboardProps) {
  const auth = getAuth();
  const user = auth.currentUser;

  const [activeTab, setActiveTab] = useState<'overview' | 'trades' | 'settings'>('overview');
  const [tradeFilter, setTradeFilter] = useState<'all' | 'active' | 'profit' | 'loss' | 'ghost'>(
    'all'
  );
  const [showLiveModal, setShowLiveModal] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const {
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
  } = useEngineWs();

  // Connection pill state. Auth failure (bad/missing token) is shown distinctly
  // from a plain disconnect so a token mismatch is obvious rather than looking
  // like the engine is simply down.
  const connStatus = wsConnected
    ? {
        label: 'ENGINE CONNECTED',
        color: 'var(--color-cyan-deep)',
        dotShadow: '0 0 8px var(--color-cyan-deep)',
        bg: 'rgba(39, 201, 63, 0.1)',
        border: 'rgba(39, 201, 63, 0.2)',
      }
    : authFailed
      ? {
          label: 'AUTH FAILED',
          color: '#f5a623',
          dotShadow: '0 0 8px #f5a623',
          bg: 'rgba(245, 166, 35, 0.1)',
          border: 'rgba(245, 166, 35, 0.2)',
        }
      : {
          label: 'ENGINE DISCONNECTED',
          color: 'var(--color-error)',
          dotShadow: 'none',
          bg: 'rgba(255, 95, 86, 0.1)',
          border: 'rgba(255, 95, 86, 0.2)',
        };

  const dashboardRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const toggleCircleRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const prevTradesCount = useRef(0);
  const prevTradeStatuses = useRef<Record<string, string>>({});

  const handleSignOut = () => {
    signOut(auth).catch((err: unknown) => {
      const errMsg = err instanceof Error ? err.message : 'Sign out failed';
      setSignOutError(errMsg);
      toast.error(errMsg);
    });
  };

  // Mount entrance animation
  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.fromTo(
        dashboardRef.current,
        { opacity: 0, y: 10 },
        { opacity: 1, y: 0, duration: 0.5, ease: 'power2.out' }
      );
    });
    return () => ctx.revert();
  }, []);

  // Tab change slide-and-fade animation
  useLayoutEffect(() => {
    const ctx = gsap.context(() => {
      gsap.fromTo(
        mainRef.current,
        { opacity: 0, x: -12 },
        { opacity: 1, x: 0, duration: 0.35, ease: 'power2.out' }
      );
    });
    return () => ctx.revert();
  }, [activeTab]);

  // Elastic toggle animation for paper/live switch
  useEffect(() => {
    if (!toggleCircleRef.current) return;
    const ctx = gsap.context(() => {
      if (prefersReducedMotion()) {
        gsap.set(toggleCircleRef.current, { x: liveData.isPaperTrading ? 0 : 20, scaleX: 1 });
      } else {
        gsap.to(toggleCircleRef.current, {
          x: liveData.isPaperTrading ? 0 : 20,
          scaleX: 1.35,
          duration: 0.18,
          ease: 'power2.out',
          onComplete: () => {
            gsap.to(toggleCircleRef.current, {
              scaleX: 1.0,
              duration: 0.22,
              ease: 'elastic.out(1.2, 0.4)',
            });
          },
        });
      }
    });
    return () => ctx.revert();
  }, [liveData.isPaperTrading]);

  // New trade highlight animation
  useEffect(() => {
    const currentCount = liveData.recentTrades.length;
    let frameId: number | undefined;
    let ctx: gsap.Context | undefined;

    if (currentCount > prevTradesCount.current) {
      frameId = requestAnimationFrame(() => {
        const firstRow = listRef.current?.querySelector('.trade-row');
        if (firstRow) {
          ctx = gsap.context(() => {
            gsap.fromTo(
              firstRow,
              { backgroundColor: 'rgba(121, 40, 202, 0.15)', y: -10, opacity: 0 },
              {
                backgroundColor: 'transparent',
                y: 0,
                opacity: 1,
                duration: 0.8,
                ease: 'power2.out',
              }
            );
          });
        }
      });
    }
    prevTradesCount.current = currentCount;

    return () => {
      if (frameId !== undefined) {
        cancelAnimationFrame(frameId);
      }
      if (ctx) {
        ctx.revert();
      }
    };
  }, [liveData.recentTrades]);

  // Profit/loss pulse animation on trade close
  useEffect(() => {
    let pulseType: 'PROFIT' | 'LOSS' | null = null;
    const newStatuses: Record<string, string> = {};

    liveData.recentTrades.forEach((trade) => {
      newStatuses[trade.mint] = trade.status;
      const prevStatus = prevTradeStatuses.current[trade.mint];
      if (trade.status === 'PROFIT' && prevStatus !== 'PROFIT' && prevStatus !== undefined) {
        pulseType = 'PROFIT';
      } else if (trade.status === 'LOSS' && prevStatus !== 'LOSS' && prevStatus !== undefined) {
        pulseType = 'LOSS';
      }
    });

    let pulseDiv: HTMLDivElement | null = null;
    let ctx: gsap.Context | null = null;

    if (pulseType && activeTab === 'overview') {
      const color = pulseType === 'PROFIT' ? 'rgba(39, 201, 63, 0.5)' : 'rgba(255, 95, 86, 0.5)';
      pulseDiv = document.createElement('div');
      Object.assign(pulseDiv.style, {
        position: 'fixed',
        top: '50%',
        left: '50%',
        width: '100px',
        height: '100px',
        borderRadius: '50%',
        background: `radial-gradient(circle, ${color} 0%, rgba(0,0,0,0) 80%)`,
        transform: 'translate(-50%, -50%) scale(0)',
        pointerEvents: 'none',
        zIndex: '9999',
      });
      document.body.appendChild(pulseDiv);

      ctx = gsap.context(() => {
        gsap.to(pulseDiv, {
          scale: 40,
          opacity: 0,
          duration: 1.5,
          ease: 'power3.out',
          onComplete: () => {
            if (pulseDiv && document.body.contains(pulseDiv)) {
              document.body.removeChild(pulseDiv);
            }
          },
        });
      });
    }

    prevTradeStatuses.current = newStatuses;

    return () => {
      if (ctx) {
        ctx.revert();
      }
      if (pulseDiv && document.body.contains(pulseDiv)) {
        document.body.removeChild(pulseDiv);
      }
    };
  }, [liveData.recentTrades, activeTab]);

  // Toast notification for Engine Connection status changes
  const prevWsConnected = useRef<boolean | null>(null);
  useEffect(() => {
    if (prevWsConnected.current !== null && prevWsConnected.current !== wsConnected) {
      if (wsConnected) {
        toast.success('Engine Connected');
      } else {
        toast.error('Engine Disconnected');
      }
    }
    prevWsConnected.current = wsConnected;
  }, [wsConnected]);

  // Toast notification for Trading Mode changes (Live vs Paper)
  const prevPaperTrading = useRef<boolean | null>(null);
  useEffect(() => {
    if (prevPaperTrading.current !== null && prevPaperTrading.current !== liveData.isPaperTrading) {
      if (liveData.isPaperTrading) {
        toast.info('Switched to Paper Trading');
      } else {
        toast.success('Switched to Live Trading');
      }
    }
    prevPaperTrading.current = liveData.isPaperTrading;
  }, [liveData.isPaperTrading]);

  // Fetch strategies when switching to settings tab (only once — ws.onopen already fetches on connect)
  useEffect(() => {
    if (activeTab === 'settings' && wsConnected && strategies.length === 0) {
      send({ type: 'GET_STRATEGIES' });
    }
  }, [activeTab, wsConnected, strategies.length, send]);

  // Escape key closes whichever overlay is open
  useEffect(() => {
    if (!showLiveModal && !showTradePanel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showTradePanel) {
        setShowTradePanel(false);
        setSelectedTrade(null);
      }
      if (showLiveModal) setShowLiveModal(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showLiveModal, showTradePanel]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleToggleMode = () => {
    if (liveData.isPaperTrading) {
      setShowLiveModal(true);
    } else {
      send({ type: 'SET_TRADING_MODE', mode: 'paper' });
    }
  };

  const handleToggleBurstMode = () => {
    if (!wsConnected) return;
    const next = !burstModeEnabled;
    send({ type: 'SET_BURST_MODE', enabled: next });
    setBurstModeEnabled(next);
  };

  const renderTradeRow = useCallback(
    (row: RecentTrade, i: number, total: number) => (
      <div
        key={row.mint}
        style={{
          padding: 'var(--space-sm) var(--space-lg)',
          borderBottom: i !== total - 1 ? '1px solid var(--color-hairline)' : 'none',
          display: 'grid',
          gridTemplateColumns: '1fr 2fr 1fr 1fr',
          alignItems: 'center',
        }}
        className="trade-row text-body-sm"
      >
        <div data-label="STATUS" className="trade-cell status-cell">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                backgroundColor: row.color,
              }}
            />
            {row.status}
          </div>
        </div>
        <div
          data-label="TOKEN"
          className="trade-cell token-cell"
          style={{ display: 'flex', flexDirection: 'column' }}
        >
          <span style={{ fontWeight: 500, color: 'var(--color-ink)' }}>{row.symbol}</span>
          <span
            className="text-caption-mono"
            style={{ color: 'var(--color-body)', fontSize: '11px' }}
          >
            {row.mint.slice(0, 4) + '...' + row.mint.slice(-4)}
          </span>
        </div>
        <div
          data-label="PLATFORM"
          className="trade-cell platform-cell"
          style={{ textTransform: 'uppercase' }}
        >
          {row.platform}
        </div>
        <div
          data-label="DETAILS"
          className="trade-cell details-cell"
          style={{ textAlign: 'right' }}
        >
          <button
            className="btn-secondary"
            onClick={() => send({ type: 'GET_TRADE_DETAILS', mint: row.mint })}
            disabled={row.status.startsWith('ACTIVE')}
            style={{
              padding: '2px 8px',
              fontSize: '12px',
              opacity: row.status.startsWith('ACTIVE') ? 0.5 : 1,
              cursor: row.status.startsWith('ACTIVE') ? 'not-allowed' : 'pointer',
            }}
            title={
              row.status.startsWith('ACTIVE')
                ? 'Position must be closed to view details'
                : 'View trade details'
            }
          >
            View
          </button>
        </div>
      </div>
    ),
    [send]
  );

  const filteredTrades = useMemo(
    () =>
      liveData.recentTrades.filter((t) => {
        switch (tradeFilter) {
          case 'active':
            return t.status.startsWith('ACTIVE');
          case 'profit':
            return t.status === 'PROFIT';
          case 'loss':
            return t.status === 'LOSS';
          case 'ghost':
            return t.status.includes('GHOST');
          default:
            return true;
        }
      }),
    [liveData.recentTrades, tradeFilter]
  );

  return (
    <div
      ref={dashboardRef}
      style={{
        height: activeTab === 'overview' ? '100dvh' : undefined,
        minHeight: activeTab !== 'overview' ? '100vh' : undefined,
        overflow: activeTab === 'overview' ? 'hidden' : undefined,
        backgroundColor: 'var(--color-canvas-soft)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Navigation */}
      <nav
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          padding: 'var(--space-sm) var(--space-lg)',
          alignItems: 'center',
          gap: 'var(--space-sm)',
          flexWrap: 'wrap',
          backgroundColor: 'var(--color-canvas)',
          borderBottom: '1px solid var(--color-hairline)',
          position: 'relative',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-lg)',
            flexWrap: 'wrap',
          }}
        >
          <div
            style={{
              fontWeight: 600,
              fontSize: '18px',
              display: 'flex',
              alignItems: 'center',
              gap: '16px',
              cursor: 'pointer',
            }}
            onClick={onNavigateHome}
          >
            veloci-buy
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '4px 10px',
                borderRadius: 'var(--rounded-pill)',
                backgroundColor: connStatus.bg,
                border: `1px solid ${connStatus.border}`,
              }}
            >
              <div
                className="connection-status-dot"
                style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  backgroundColor: connStatus.color,
                  boxShadow: connStatus.dotShadow,
                }}
              />
              <span
                className="text-caption-mono text-body"
                style={{
                  color: connStatus.color,
                  fontSize: '11px',
                  letterSpacing: '0.5px',
                }}
              >
                {connStatus.label}
              </span>
            </div>
          </div>
        </div>

        {/* Desktop Navigation - Hidden on Mobile */}
        <div className="desktop-nav" style={{ gap: 'var(--space-md)', alignItems: 'center' }}>
          <div
            role="tablist"
            aria-label="Dashboard sections"
            style={{ display: 'flex', gap: 'var(--space-sm)' }}
          >
            {(['overview', 'trades', 'settings'] as const).map((tab) => (
              <button
                key={tab}
                className="nav-btn"
                role="tab"
                aria-selected={activeTab === tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  background: activeTab === tab ? 'var(--color-canvas-soft-2)' : 'transparent',
                  padding: '6px 12px',
                  borderRadius: 'var(--rounded-pill-sm)',
                  fontSize: '14px',
                  fontWeight: 500,
                  color: activeTab === tab ? 'var(--color-ink)' : 'var(--color-body)',
                  border: 'none',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  textTransform: 'capitalize',
                }}
              >
                {tab}
              </button>
            ))}
            <button
              className="nav-btn"
              onClick={onNavigateHowItWorks}
              style={{
                background: 'transparent',
                padding: '6px 12px',
                borderRadius: 'var(--rounded-pill-sm)',
                fontSize: '14px',
                fontWeight: 500,
                color: 'var(--color-body)',
                border: 'none',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
              }}
            >
              How it works
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
            <span className="text-body-sm" style={{ color: 'var(--color-body)' }}>
              {user?.displayName || user?.email || 'Trader'}
            </span>
            <button
              onClick={onToggleTheme}
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
              onClick={handleSignOut}
              className="btn-secondary"
              style={{ padding: '4px 12px', fontSize: '12px' }}
            >
              Sign Out
            </button>
            {signOutError && (
              <span role="alert" className="text-body-sm" style={{ color: 'var(--color-error)' }}>
                {signOutError}
              </span>
            )}
          </div>
        </div>

        {/* Mobile Navigation Toggle - Hidden on Desktop */}
        <div className="mobile-nav-toggle" style={{ gap: '8px', alignItems: 'center' }}>
          <button
            onClick={onToggleTheme}
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
          {(['overview', 'trades', 'settings'] as const).map((tab) => (
            <button
              key={tab}
              className="nav-btn"
              onClick={() => {
                setActiveTab(tab);
                setMobileMenuOpen(false);
              }}
              style={{
                background: activeTab === tab ? 'var(--color-canvas-soft-2)' : 'transparent',
                padding: '8px 12px',
                borderRadius: 'var(--rounded-pill-sm)',
                fontSize: '14px',
                fontWeight: 500,
                color: activeTab === tab ? 'var(--color-ink)' : 'var(--color-body)',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
                textTransform: 'capitalize',
              }}
            >
              {tab}
            </button>
          ))}
          <button
            className="nav-btn"
            onClick={() => {
              onNavigateHowItWorks();
              setMobileMenuOpen(false);
            }}
            style={{
              background: 'transparent',
              padding: '8px 12px',
              borderRadius: 'var(--rounded-pill-sm)',
              fontSize: '14px',
              fontWeight: 500,
              color: 'var(--color-body)',
              border: 'none',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            How it works
          </button>
          <div
            style={{
              padding: '8px 12px',
              borderTop: '1px solid var(--color-hairline)',
              marginTop: '8px',
            }}
          >
            <div
              className="text-body-sm"
              style={{ color: 'var(--color-body)', marginBottom: '8px' }}
            >
              {user?.displayName || user?.email || 'Trader'}
            </div>
            <button
              onClick={() => {
                setMobileMenuOpen(false);
                handleSignOut();
              }}
              className="btn-secondary"
              style={{ padding: '6px 12px', fontSize: '13px', width: '100%' }}
            >
              Sign Out
            </button>
            {signOutError && (
              <span
                role="alert"
                className="text-body-sm"
                style={{ color: 'var(--color-error)', display: 'block', marginTop: '8px' }}
              >
                {signOutError}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Tab Content */}
      <main
        style={{
          flex: 1,
          padding:
            activeTab === 'overview'
              ? 'var(--space-md) var(--space-lg)'
              : 'var(--space-2xl) var(--space-lg)',
          overflow: activeTab === 'overview' ? 'hidden' : undefined,
          display: activeTab === 'overview' ? 'flex' : undefined,
          flexDirection: activeTab === 'overview' ? 'column' : undefined,
        }}
      >
        <div
          ref={mainRef}
          style={{
            maxWidth: activeTab === 'overview' ? '1600px' : '1100px',
            margin: '0 auto',
            height: activeTab === 'overview' ? '100%' : undefined,
            width: '100%',
          }}
        >
          {/* ── Overview (Bento Grid) ── */}
          {activeTab === 'overview' && (
            <div className="bento-ambient">
              <div className="bento-overview-grid">
                {/* LEFT: Activity Log — spans full height */}
                <ActivityLog
                  logs={liveData.logs ?? []}
                  trades={liveData.recentTrades}
                  wsConnected={wsConnected}
                />

                {/* RIGHT: stacked rows */}
                <div className="bento-right-col">
                  {/* Rows 1–3: unified 2×3 bento grid (metrics + widgets) */}
                  <div className="bento-6-grid">
                    {!wsConnected ? (
                      <>
                        <SkeletonCard />
                        <SkeletonCard />
                        <SkeletonCard />
                        <SkeletonCard />
                      </>
                    ) : (
                      <>
                        <BentoMetricCard
                          label="Tracked Signals"
                          topBorderColor="#2563eb"
                          boxShadow="0 0 28px rgba(37,99,235,0.10)"
                          value={
                            <AnimatedNumber
                              value={liveData.activeSignals}
                              format={(v) => Math.round(v).toString()}
                            />
                          }
                        />
                        <BentoMetricCard
                          label="Tokens Traded"
                          topBorderColor="#7928ca"
                          boxShadow="0 0 28px rgba(121,40,202,0.08)"
                          value={
                            <AnimatedNumber
                              value={liveData.tokensTraded}
                              format={(v) => Math.round(v).toString()}
                            />
                          }
                        />
                        <BentoMetricCard
                          label="Win Rate"
                          topBorderColor="#f9cb28"
                          boxShadow="0 0 28px rgba(249,203,40,0.08)"
                          value={
                            <AnimatedNumber
                              value={liveData.sessionWinRate}
                              format={(v) => Math.round(v).toString() + '%'}
                            />
                          }
                        />
                        {(() => {
                          const pnlNum = parseFloat(liveData.pnl as string) || 0;
                          const isProfit = pnlNum >= 0;
                          return (
                            <BentoMetricCard
                              label="P&L (SOL)"
                              topBorderColor={isProfit ? '#14a37f' : '#ff5f56'}
                              boxShadow={
                                isProfit
                                  ? '0 0 28px rgba(20,163,127,0.10)'
                                  : '0 0 28px rgba(255,95,86,0.10)'
                              }
                              valueColor={isProfit ? '#14a37f' : '#ff5f56'}
                              value={
                                <AnimatedNumber
                                  value={pnlNum}
                                  format={(v) => (v >= 0 ? `+${v.toFixed(4)}` : v.toFixed(4))}
                                />
                              }
                            />
                          );
                        })()}
                      </>
                    )}
                    <SolPriceWidget
                      topBorderColor="#f97316"
                      boxShadow="0 0 28px rgba(249,115,22,0.08)"
                    />
                    <MlStatusWidget
                      mlMetrics={liveData.mlMetrics}
                      topBorderColor="#e879f9"
                      boxShadow="0 0 28px rgba(232,121,249,0.08)"
                    />
                  </div>

                  {/* Trades table — fills remaining height, scrolls internally */}
                  <div ref={listRef} className="glass-card bento-trades-area">
                    <div
                      style={{
                        padding: 'var(--space-sm) var(--space-lg)',
                        borderBottom: '1px solid var(--glass-border)',
                        display: 'grid',
                        gridTemplateColumns: '1fr 2fr 1fr 1fr',
                        flexShrink: 0,
                        minWidth: '520px',
                      }}
                      className="trade-table-header text-caption-mono text-body"
                    >
                      <div>STATUS</div>
                      <div>TOKEN</div>
                      <div>PLATFORM</div>
                      <div style={{ textAlign: 'right' }}>DETAILS</div>
                    </div>
                    <div className="trade-table-inner">
                      {!wsConnected ? (
                        <>
                          {[0, 1, 2, 3, 4].map((i) => (
                            <SkeletonRow key={i} index={i} />
                          ))}
                        </>
                      ) : liveData.recentTrades.length === 0 ? (
                        <div
                          style={{
                            padding: 'var(--space-xl)',
                            textAlign: 'center',
                            color: 'var(--color-body)',
                          }}
                        >
                          No recent executions found in state.
                        </div>
                      ) : (
                        liveData.recentTrades.map((row, i) =>
                          renderTradeRow(row, i, liveData.recentTrades.length)
                        )
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── Trades ── */}
          {activeTab === 'trades' && (
            <div>
              <div>
                <h1 className="text-display-md" style={{ marginBottom: 'var(--space-md)' }}>
                  Trade History
                </h1>
                <p
                  className="text-body-md"
                  style={{ color: 'var(--color-body)', marginBottom: 'var(--space-lg)' }}
                >
                  Live and closed executions streamed from the engine — paper, live, and ghost
                  trades.
                </p>

                <div
                  role="group"
                  aria-label="Filter trades by status"
                  style={{
                    display: 'flex',
                    gap: 'var(--space-sm)',
                    marginBottom: 'var(--space-lg)',
                    flexWrap: 'wrap',
                  }}
                >
                  {(
                    [
                      ['all', 'All'],
                      ['active', 'Active'],
                      ['profit', 'Profit'],
                      ['loss', 'Loss'],
                      ['ghost', 'Ghost'],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      className="nav-btn"
                      aria-pressed={tradeFilter === key}
                      onClick={() => setTradeFilter(key)}
                      style={{
                        background:
                          tradeFilter === key ? 'var(--glass-bg-hover)' : 'var(--glass-bg)',
                        backdropFilter: 'var(--glass-blur)',
                        WebkitBackdropFilter: 'var(--glass-blur)',
                        padding: '6px 14px',
                        borderRadius: 'var(--rounded-pill-sm)',
                        fontSize: '13px',
                        fontWeight: 500,
                        color: tradeFilter === key ? 'var(--color-ink)' : 'var(--color-body)',
                        border: `1px solid ${tradeFilter === key ? 'rgba(37,99,235,0.35)' : 'var(--glass-border)'}`,
                        cursor: 'pointer',
                        transition: 'all 0.2s ease',
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div className="glass-card" style={{ overflowX: 'auto' }}>
                  <div className="trade-table-inner">
                    <div
                      style={{
                        background: 'var(--glass-bg)',
                        padding: 'var(--space-sm) var(--space-lg)',
                        borderBottom: '1px solid var(--glass-border)',
                        display: 'grid',
                        gridTemplateColumns: '1fr 2fr 1fr 1fr',
                      }}
                      className="trade-table-header text-caption-mono text-body"
                    >
                      <div>STATUS</div>
                      <div>TOKEN</div>
                      <div>PLATFORM</div>
                      <div style={{ textAlign: 'right' }}>DETAILS</div>
                    </div>
                    {!wsConnected ? (
                      <>
                        {[0, 1, 2, 3, 4].map((i) => (
                          <SkeletonRow key={i} index={i} />
                        ))}
                      </>
                    ) : filteredTrades.length === 0 ? (
                      <div
                        style={{
                          padding: 'var(--space-xl)',
                          textAlign: 'center',
                          color: 'var(--color-body)',
                        }}
                      >
                        No trades match this filter.
                      </div>
                    ) : (
                      filteredTrades.map((row, i) => renderTradeRow(row, i, filteredTrades.length))
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── Settings ── */}
          {activeTab === 'settings' && (
            <div>
              <div>
                <h1 className="text-display-md" style={{ marginBottom: 'var(--space-md)' }}>
                  Engine Settings
                </h1>
                <p
                  className="text-body-md"
                  style={{ color: 'var(--color-body)', marginBottom: 'var(--space-xl)' }}
                >
                  Control the engine's trading mode. Risk parameters, RPC endpoints, and ML gates
                  are configured via the bot's strategy YAML and{' '}
                  <code className="text-caption-mono">.env</code>.
                </p>

                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--space-lg)',
                    maxWidth: '600px',
                  }}
                >
                  {/* Trading Mode */}
                  <div
                    className="glass-card"
                    style={{
                      padding: 'var(--space-lg)',
                      borderTop: '2px solid #2563eb',
                      boxShadow: '0 0 28px rgba(37,99,235,0.08)',
                    }}
                  >
                    <h3 className="text-body-lg" style={{ marginBottom: 'var(--space-xs)' }}>
                      Trading Mode
                    </h3>
                    <p
                      className="text-body-sm"
                      style={{ color: 'var(--color-body)', marginBottom: 'var(--space-md)' }}
                    >
                      Paper mode simulates fills against a virtual balance. Live mode executes real
                      on-chain swaps with actual funds.
                    </p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <span
                        className="text-caption-mono text-body"
                        style={{
                          color: liveData.isPaperTrading ? 'var(--color-ink)' : 'var(--color-body)',
                          transition: 'color 0.3s ease',
                        }}
                      >
                        PAPER
                      </span>
                      <button
                        role="switch"
                        aria-checked={!liveData.isPaperTrading}
                        aria-label="Toggle live trading mode"
                        onClick={handleToggleMode}
                        disabled={!wsConnected}
                        title={
                          wsConnected ? undefined : 'Connect to the engine to change trading mode'
                        }
                        style={{
                          width: '44px',
                          height: '24px',
                          padding: 0,
                          backgroundColor: liveData.isPaperTrading
                            ? 'var(--color-violet)'
                            : 'var(--color-error)',
                          borderRadius: '12px',
                          border: 'none',
                          position: 'relative',
                          cursor: wsConnected ? 'pointer' : 'not-allowed',
                          opacity: wsConnected ? 1 : 0.5,
                          transition: 'background-color 0.3s ease',
                        }}
                      >
                        <div
                          ref={toggleCircleRef}
                          style={{
                            width: '18px',
                            height: '18px',
                            backgroundColor: 'white',
                            borderRadius: '50%',
                            position: 'absolute',
                            top: '3px',
                            left: '3px',
                            boxShadow: 'var(--shadow-level1)',
                          }}
                        />
                      </button>
                      <span
                        className="text-caption-mono text-body"
                        style={{
                          color: !liveData.isPaperTrading
                            ? 'var(--color-error)'
                            : 'var(--color-body)',
                          transition: 'color 0.3s ease',
                        }}
                      >
                        LIVE
                      </span>
                    </div>
                    {!wsConnected && (
                      <p
                        className="text-body-sm"
                        style={{ color: 'var(--color-error)', marginTop: 'var(--space-sm)' }}
                      >
                        Engine disconnected — reconnect to change the trading mode.
                      </p>
                    )}
                  </div>

                  {/* Burst Mode */}
                  <div
                    className="glass-card"
                    style={{
                      padding: 'var(--space-lg)',
                      borderTop: `2px solid ${burstModeEnabled ? '#14a37f' : 'rgba(37,99,235,0.30)'}`,
                      boxShadow: burstModeEnabled
                        ? '0 0 28px rgba(20,163,127,0.12)'
                        : '0 0 28px rgba(37,99,235,0.06)',
                      transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
                    }}
                  >
                    <h3 className="text-body-lg" style={{ marginBottom: 'var(--space-xs)' }}>
                      Burst Mode
                    </h3>
                    <p
                      className="text-body-sm"
                      style={{ color: 'var(--color-body)', marginBottom: 'var(--space-md)' }}
                    >
                      When enabled, the engine switches to the burst preset and burst exit logic
                      automatically. Changing this will restart the bot.
                    </p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <span
                        className="text-caption-mono"
                        style={{
                          color: !burstModeEnabled ? 'var(--color-ink)' : 'var(--color-body)',
                          transition: 'color 0.3s ease',
                        }}
                      >
                        OFF
                      </span>
                      <button
                        role="switch"
                        aria-checked={burstModeEnabled}
                        aria-label="Toggle burst mode"
                        onClick={handleToggleBurstMode}
                        disabled={!wsConnected}
                        title={
                          wsConnected ? undefined : 'Connect to the engine to change burst mode'
                        }
                        style={{
                          width: '44px',
                          height: '24px',
                          padding: 0,
                          backgroundColor: burstModeEnabled
                            ? 'var(--color-cyan-deep)'
                            : 'var(--color-canvas-soft-2)',
                          borderRadius: '12px',
                          border: 'none',
                          position: 'relative',
                          cursor: wsConnected ? 'pointer' : 'not-allowed',
                          opacity: wsConnected ? 1 : 0.5,
                          transition: 'background-color 0.3s ease',
                        }}
                      >
                        <div
                          style={{
                            width: '18px',
                            height: '18px',
                            backgroundColor: 'white',
                            borderRadius: '50%',
                            position: 'absolute',
                            top: '3px',
                            left: burstModeEnabled ? '23px' : '3px',
                            boxShadow: 'var(--shadow-level1)',
                            transition: 'left 0.3s ease',
                          }}
                        />
                      </button>
                      <span
                        className="text-caption-mono"
                        style={{
                          color: burstModeEnabled ? 'var(--color-cyan-deep)' : 'var(--color-body)',
                          transition: 'color 0.3s ease',
                        }}
                      >
                        ON
                      </span>
                    </div>
                    {!wsConnected && (
                      <p
                        className="text-body-sm"
                        style={{ color: 'var(--color-error)', marginTop: 'var(--space-sm)' }}
                      >
                        Engine disconnected — reconnect to change burst mode.
                      </p>
                    )}
                  </div>

                  {/* Strategy Selection */}
                  <div
                    className="glass-card"
                    style={{
                      padding: 'var(--space-lg)',
                      borderTop: '2px solid #7928ca',
                      boxShadow: '0 0 28px rgba(121,40,202,0.08)',
                      opacity: burstModeEnabled ? 0.6 : 1,
                      transition: 'opacity 0.3s ease',
                    }}
                  >
                    <h3 className="text-body-lg" style={{ marginBottom: 'var(--space-xs)' }}>
                      Strategy Selection
                    </h3>
                    <p
                      className="text-body-sm"
                      style={{ color: 'var(--color-body)', marginBottom: 'var(--space-md)' }}
                    >
                      Select the trading strategy for the engine. Changing the strategy will
                      automatically restart the bot.
                    </p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <select
                        value={currentStrategy}
                        onChange={(e) => {
                          send({ type: 'SET_STRATEGY', strategy: e.target.value });
                          setCurrentStrategy(e.target.value);
                        }}
                        disabled={!wsConnected || burstModeEnabled}
                        style={{
                          padding: '8px 12px',
                          borderRadius: 'var(--rounded-md)',
                          background: 'var(--glass-bg)',
                          backdropFilter: 'var(--glass-blur)',
                          WebkitBackdropFilter: 'var(--glass-blur)',
                          color: 'var(--color-ink)',
                          border: '1px solid var(--glass-border)',
                          cursor: wsConnected && !burstModeEnabled ? 'pointer' : 'not-allowed',
                          opacity: wsConnected && !burstModeEnabled ? 1 : 0.5,
                          width: '100%',
                          maxWidth: '300px',
                        }}
                      >
                        <option value="" disabled>
                          Select a strategy
                        </option>
                        {strategies.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </div>
                    {burstModeEnabled && (
                      <p
                        className="text-body-sm"
                        style={{ color: 'var(--color-cyan-deep)', marginTop: 'var(--space-sm)' }}
                      >
                        Burst mode is active — strategy preset is overridden.
                      </p>
                    )}
                    {!wsConnected && !burstModeEnabled && (
                      <p
                        className="text-body-sm"
                        style={{ color: 'var(--color-error)', marginTop: 'var(--space-sm)' }}
                      >
                        Engine disconnected — reconnect to change the strategy.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Overlays */}
      {showLiveModal && (
        <LiveModeModal
          onConfirm={() => {
            setShowLiveModal(false);
            send({ type: 'SET_TRADING_MODE', mode: 'live' });
          }}
          onCancel={() => setShowLiveModal(false)}
        />
      )}

      {showTradePanel && selectedTrade && (
        <TradeDetailsPanel
          trade={selectedTrade}
          onClose={() => {
            setShowTradePanel(false);
            setSelectedTrade(null);
          }}
        />
      )}
    </div>
  );
}
