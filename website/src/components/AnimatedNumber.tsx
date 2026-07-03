import { useEffect, useRef, useState } from 'react';
import gsap from 'gsap';

/**
 * Tween-based counting animation with a directional arrow indicator.
 * Uses the React "setState during render" pattern for derived state
 * (officially supported as the functional equivalent of getDerivedStateFromProps).
 */
export function AnimatedNumber({
  value,
  format = (val: number) => val.toString(),
}: {
  value: number;
  format?: (val: number) => string;
}) {
  const [currentVal, setCurrentVal] = useState(value);
  const [prevVal, setPrevVal] = useState<number | null>(null);
  const [direction, setDirection] = useState<'up' | 'down' | null>(null);

  if (value !== currentVal) {
    setPrevVal(currentVal);
    setCurrentVal(value);
    setDirection(value > currentVal ? 'up' : 'down');
  }

  const prevTextRef = useRef<HTMLDivElement>(null);
  const currentTextRef = useRef<HTMLDivElement>(null);
  const animIdRef = useRef(0);

  useEffect(() => {
    if (prevVal !== null && direction) {
      const yOffset = direction === 'up' ? 20 : -20;
      const currentAnimId = ++animIdRef.current;

      if (currentTextRef.current) {
        gsap.fromTo(
          currentTextRef.current,
          { y: yOffset, opacity: 0 },
          { y: 0, opacity: 1, duration: 0.4, ease: 'power2.out' }
        );
      }

      if (prevTextRef.current) {
        gsap.fromTo(
          prevTextRef.current,
          { y: 0, opacity: 1 },
          {
            y: -yOffset,
            opacity: 0,
            duration: 0.4,
            ease: 'power2.out',
            onComplete: () => {
              if (animIdRef.current === currentAnimId) {
                setPrevVal(null);
                setDirection(null);
              }
            },
          }
        );
      }
    }
  }, [currentVal, prevVal, direction]);

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
      <div style={{ display: 'grid', overflow: 'hidden' }}>
        <div ref={currentTextRef} style={{ gridArea: '1 / 1' }}>
          {format(currentVal)}
        </div>
        {prevVal !== null && (
          <div ref={prevTextRef} style={{ gridArea: '1 / 1' }}>
            {format(prevVal)}
          </div>
        )}
      </div>
      <div style={{ width: '1em', display: 'flex', justifyContent: 'center' }}>
        {direction === 'up' && (
          <span style={{ color: 'var(--color-cyan-deep)', fontSize: '0.6em' }}>▲</span>
        )}
        {direction === 'down' && (
          <span style={{ color: 'var(--color-error)', fontSize: '0.6em' }}>▼</span>
        )}
      </div>
    </div>
  );
}
