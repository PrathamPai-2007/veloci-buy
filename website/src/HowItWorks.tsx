import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { HiwIcon } from './components/HiwIcons';
import { useMagneticButton } from './lib/useMagneticButton';
import { prefersReducedMotion } from './lib/motion';
import { hero, gatesIntro, gates, features, risk, disclaimer, closing } from './howItWorksContent';

gsap.registerPlugin(ScrollTrigger);

interface HowItWorksProps {
  onBack: () => void;
  onStartTrading: () => void;
}

export default function HowItWorks({ onBack, onStartTrading }: HowItWorksProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const cometRef = useRef<SVGCircleElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const gateRefs = useRef<(HTMLDivElement | null)[]>([]);
  const magnetic = useMagneticButton();

  // Pointer-driven 3D tilt for cards (decorative, hover-only, reduced-motion safe).
  const onTiltMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (prefersReducedMotion()) return;
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    gsap.to(el, {
      rotateY: px * 7,
      rotateX: -py * 7,
      transformPerspective: 900,
      duration: 0.4,
      ease: 'power2.out',
    });
  };
  const onTiltLeave = (e: React.MouseEvent<HTMLDivElement>) => {
    gsap.to(e.currentTarget, {
      rotateX: 0,
      rotateY: 0,
      duration: 0.7,
      ease: 'elastic.out(1, 0.4)',
    });
  };

  // The SVG connector path is computed from the actual gate positions so it
  // stays accurate across breakpoints. Recomputed on mount + resize.
  const [pathD, setPathD] = useState('');

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    const buildPath = () => {
      const nodes = gateRefs.current.filter(Boolean) as HTMLDivElement[];
      if (nodes.length === 0) return;
      const trackRect = track.getBoundingClientRect();
      const pts = nodes.map((node) => {
        const glyph = node.querySelector('.hiw-gate-glyph') as HTMLElement | null;
        const el = glyph ?? node;
        const r = el.getBoundingClientRect();
        return {
          x: r.left - trackRect.left + r.width / 2,
          y: r.top - trackRect.top + r.height / 2,
        };
      });

      // Smooth-ish vertical zig-zag: straight segments with rounded corners.
      let d = `M ${pts[0].x} ${pts[0].y}`;
      for (let i = 1; i < pts.length; i++) {
        const prev = pts[i - 1];
        const cur = pts[i];
        const midY = (prev.y + cur.y) / 2;
        d += ` C ${prev.x} ${midY}, ${cur.x} ${midY}, ${cur.x} ${cur.y}`;
      }
      setPathD(d);
    };

    buildPath();
    const ro = new ResizeObserver(buildPath);
    ro.observe(track);
    window.addEventListener('resize', buildPath);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', buildPath);
    };
  }, []);

  // Draw-on-scroll for the connector + a glowing comet that rides the line.
  useEffect(() => {
    const path = pathRef.current;
    if (!path || !pathD) return;

    const len = path.getTotalLength();
    path.style.strokeDasharray = String(len);

    const comet = cometRef.current;

    if (prefersReducedMotion()) {
      path.style.strokeDashoffset = '0';
      if (comet) comet.style.opacity = '0';
      return;
    }

    path.style.strokeDashoffset = String(len);

    const st = ScrollTrigger.create({
      trigger: trackRef.current,
      start: 'top 72%',
      end: 'bottom 62%',
      scrub: 0.6,
      onUpdate: (self) => {
        const p = self.progress;
        path.style.strokeDashoffset = String(len * (1 - p));
        if (comet) {
          const pt = path.getPointAtLength(len * p);
          comet.setAttribute('cx', String(pt.x));
          comet.setAttribute('cy', String(pt.y));
          comet.style.opacity = p > 0.02 && p < 0.98 ? '1' : '0';
        }
      },
    });
    return () => st.kill();
  }, [pathD]);

  // Top scroll-progress bar tracking whole-page scroll.
  useEffect(() => {
    const fill = progressRef.current;
    if (!fill || prefersReducedMotion()) return;
    const st = ScrollTrigger.create({
      trigger: rootRef.current,
      start: 'top top',
      end: 'bottom bottom',
      scrub: 0.3,
      onUpdate: (self) => {
        fill.style.transform = `scaleX(${self.progress})`;
      },
    });
    return () => st.kill();
  }, []);

  // All entrance + reveal + parallax animation, scoped for clean teardown
  // (the page is lazy-mounted/unmounted by App).
  useEffect(() => {
    window.scrollTo(0, 0);

    const reduced = prefersReducedMotion();

    const ctx = gsap.context(() => {
      if (reduced) {
        gsap.set('.hiw-anim', { opacity: 1, y: 0 });
        return;
      }

      // Hero entrance
      const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
      tl.fromTo(
        '.hiw-hero-el',
        { opacity: 0, y: 28 },
        { opacity: 1, y: 0, duration: 0.7, stagger: 0.12 }
      );

      // Slow drifting mesh gradient (matches landing)
      gsap.to('.hiw-hero .hero-gradient', {
        backgroundPosition: '100% 100%',
        duration: 12,
        repeat: -1,
        yoyo: true,
        ease: 'sine.inOut',
      });

      // Scroll reveals: any element tagged .hiw-reveal
      gsap.utils.toArray<HTMLElement>('.hiw-reveal').forEach((el) => {
        gsap.fromTo(
          el,
          { opacity: 0, y: 32 },
          {
            opacity: 1,
            y: 0,
            duration: 0.7,
            ease: 'power3.out',
            scrollTrigger: { trigger: el, start: 'top 82%' },
          }
        );
      });

      // Parallax drift on feature glyphs
      gsap.utils.toArray<HTMLElement>('.hiw-parallax').forEach((el) => {
        gsap.fromTo(
          el,
          { yPercent: -12 },
          {
            yPercent: 12,
            ease: 'none',
            scrollTrigger: { trigger: el, start: 'top bottom', end: 'bottom top', scrub: true },
          }
        );
      });
    }, rootRef);

    return () => ctx.revert();
  }, []);

  return (
    <div ref={rootRef} className="page-container hiw-root">
      {/* Scroll progress bar */}
      <div className="hiw-progress" aria-hidden="true">
        <div ref={progressRef} className="hiw-progress-fill" />
      </div>

      {/* Sticky glass nav */}
      <nav className="hiw-nav">
        <button className="hiw-back" onClick={onBack}>
          ← Back
        </button>
        <div className="hiw-brand">Veloci-Buy</div>
      </nav>

      {/* Hero */}
      <header className="hiw-hero">
        <div className="hero-gradient" />
        <div className="hiw-hero-inner">
          <div className="hiw-hero-el text-caption-mono hiw-eyebrow">{hero.eyebrow}</div>
          <h1 className="hiw-hero-el text-display-xl hiw-gradient-text">{hero.headline}</h1>
          <p className="hiw-hero-el text-body-lg">{hero.subhead}</p>
          <div className="hiw-hero-el">
            <button className="hiw-cta" {...magnetic} onClick={onStartTrading}>
              {hero.cta}
            </button>
          </div>
          <div className="hiw-hero-el hiw-scroll-cue" aria-hidden="true">
            <span>{hero.scrollCue}</span>
            <svg
              className="hiw-chevron"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </div>
        </div>
      </header>

      {/* Pipeline — the centerpiece */}
      <section className="hiw-section hiw-pipeline">
        <div className="hiw-reveal text-caption-mono hiw-eyebrow">{gatesIntro.eyebrow}</div>
        <h2 className="hiw-reveal text-display-lg" style={{ marginBottom: 'var(--space-md)' }}>
          {gatesIntro.title}
        </h2>
        <p
          className="hiw-reveal text-body-md"
          style={{ color: 'var(--color-body)', maxWidth: 620 }}
        >
          {gatesIntro.subhead}
        </p>

        <div ref={trackRef} className="hiw-pipeline-track">
          <svg className="hiw-pipeline-svg" preserveAspectRatio="none">
            <path
              ref={pathRef}
              d={pathD}
              fill="none"
              stroke="var(--color-violet)"
              strokeWidth={2}
              strokeLinecap="round"
              opacity={0.6}
            />
            <circle ref={cometRef} className="hiw-comet" r={5} cx={0} cy={0} />
          </svg>

          <div className="hiw-gates">
            {gates.map((gate, i) => (
              <div
                key={gate.num}
                ref={(el) => {
                  gateRefs.current[i] = el;
                }}
                className="hiw-gate hiw-reveal hiw-tilt"
                onMouseMove={onTiltMove}
                onMouseLeave={onTiltLeave}
              >
                <div className="hiw-gate-glyph">
                  <HiwIcon name={gate.icon} size={26} />
                </div>
                <div>
                  <span className="hiw-gate-num">GATE {gate.num}</span>
                  <h3 className="hiw-gate-name text-display-sm">{gate.name}</h3>
                  <p className="hiw-gate-blurb text-body-md">{gate.blurb}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Feature sections — alternating */}
      <section className="hiw-section">
        {features.map((f, i) => (
          <div
            key={f.title}
            className={`hiw-feature hiw-reveal hiw-tilt${i % 2 === 1 ? ' reverse' : ''}`}
            onMouseMove={onTiltMove}
            onMouseLeave={onTiltLeave}
          >
            <div className="hiw-feature-glyph hiw-parallax" style={{ color: f.accent }}>
              <HiwIcon name={f.icon} size={34} />
            </div>
            <div className="hiw-feature-body">
              <h3 className="text-display-md">{f.title}</h3>
              <p className="text-body-md">{f.blurb}</p>
              {f.bullets && (
                <ul className="hiw-feature-bullets text-body-md">
                  {f.bullets.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ))}
      </section>

      {/* Risk disclosure */}
      <section className="hiw-section" style={{ paddingTop: 0 }}>
        <div className="hiw-risk hiw-reveal">
          <div className="hiw-risk-label text-caption-mono">RISK DISCLOSURE</div>
          <p className="text-body-md">{risk}</p>
        </div>
      </section>

      {/* Closing CTA band */}
      <section className="hiw-closing">
        <div className="hiw-closing-card hiw-reveal">
          <div className="text-caption-mono hiw-eyebrow">{closing.eyebrow}</div>
          <h2 className="text-display-lg">{closing.title}</h2>
          <p className="text-body-md">{closing.subhead}</p>
          <button className="hiw-cta" {...magnetic} onClick={onStartTrading}>
            {closing.cta}
          </button>
        </div>
        <p className="hiw-disclaimer text-body-sm">{disclaimer}</p>
      </section>
    </div>
  );
}
