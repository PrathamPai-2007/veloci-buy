import gsap from 'gsap';
import { prefersReducedMotion } from './motion';

/**
 * Returns onMouseMove / onMouseLeave handlers that make a button drift toward
 * the cursor (a "magnetic" hover). Disabled when the user prefers reduced motion.
 *
 * @param strength how far the button follows the cursor (0–1). Default 0.35.
 */
export function useMagneticButton(strength = 0.35) {
  const onMouseMove = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (prefersReducedMotion()) return;
    const btn = e.currentTarget;
    const rect = btn.getBoundingClientRect();
    const x = e.clientX - rect.left - rect.width / 2;
    const y = e.clientY - rect.top - rect.height / 2;

    gsap.to(btn, {
      x: x * strength,
      y: y * strength,
      scale: 1.04,
      duration: 0.3,
      ease: 'power2.out',
      boxShadow: '0 8px 24px rgba(121, 40, 202, 0.2)',
    });
  };

  const onMouseLeave = (e: React.MouseEvent<HTMLButtonElement>) => {
    const btn = e.currentTarget;
    gsap.to(btn, {
      x: 0,
      y: 0,
      scale: 1,
      duration: 0.4,
      ease: 'elastic.out(1, 0.3)',
      boxShadow: 'none',
    });
  };

  return { onMouseMove, onMouseLeave };
}
