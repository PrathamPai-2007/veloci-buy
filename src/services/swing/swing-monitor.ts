import { Context, Position, WalletBalance } from '#types/index.js';
import { computeTakeProfitSellAmount } from '../monitor/exit-calculator.js';

export interface SwingExitDecision {
  shouldExit: boolean;
  sellRaw: bigint;
  reason: string;
}

/**
 * Returns a human-readable log line for a swing exit event.
 */
export function describeSwingExit(pos: Position, pUsd: number, reason: string): string {
  const multiple = pos.entryPriceUsd > 0 ? pUsd / pos.entryPriceUsd : 1;
  return `SWING EXIT [${reason}] ${pos.symbol} @ $${pUsd.toFixed(6)} (${multiple.toFixed(3)}x entry)`;
}

/**
 * Evaluates exit conditions for a swing position.
 * Called from the main monitor loop when pos.entryProfile === 'swing'.
 *
 * Exit priority:
 *  1. Max hold time exceeded
 *  2. Flat stop loss (before trailing arms)
 *  3. Arm trailing once price rises 5% above entry
 *  4. Trailing stop (armed only)
 *  5. Take-profit ladder (partial sells)
 *
 * Intentionally omits: rug-exit guard, EPG, breakeven ratchet, moon-bag,
 * insider-drift, spread-velocity, midpoint-guard. Swing positions are held for
 * hours and use a wide flat+trailing stop model instead.
 */
export function getSwingExitDecision(
  ctx: Context,
  pos: Position,
  balance: WalletBalance,
  pUsd: number,
  now = Date.now()
): SwingExitDecision | null {
  if (pos.entryProfile !== 'swing') return null;
  if (!(pUsd > 0) || balance.rawAmount <= 0n) return null;

  const ageMs = now - new Date(pos.openedAt).getTime();
  const ageHours = ageMs / 3_600_000;
  const trailingPct = Number(
    pos.trailingStopDrawdownPctResolved ?? ctx.config.swingTrailingStopPct
  );
  const maxHoldHours = (pos.maxHoldMinutesResolved ?? ctx.config.swingMaxHoldHours * 60) / 60;

  // 1. Max hold time
  if (ageHours >= maxHoldHours) {
    return { shouldExit: true, sellRaw: balance.rawAmount, reason: 'swing-time-exit' };
  }

  // 2. Flat stop (before trailing arms)
  const slPrice = pos.entryPriceUsd * (1 - trailingPct);
  if (!pos.trailingArmed && pUsd <= slPrice) {
    return { shouldExit: true, sellRaw: balance.rawAmount, reason: 'swing-stop-loss' };
  }

  // 3. Arm trailing once price moves 5% above entry
  if (!pos.trailingArmed && pUsd >= pos.entryPriceUsd * 1.05) {
    pos.trailingArmed = true;
    // Caller persists the mutation via ctx.store.upsertPosition(pos)
  }

  // 4. Trailing stop (armed)
  if (pos.trailingArmed) {
    const trailPrice = (pos.highestPriceUsd || pUsd) * (1 - trailingPct);
    if (pUsd <= trailPrice) {
      return { shouldExit: true, sellRaw: balance.rawAmount, reason: 'swing-trailing-exit' };
    }
  }

  // 5. Take-profit ladder
  const multiples = pos.takeProfitMultiples ?? ctx.config.swingTakeProfitMultiples;
  const fractions = pos.takeProfitFractions ?? ctx.config.swingTakeProfitFractions;
  const targetsHit = pos.targetsHit ?? 0;

  if (targetsHit < multiples.length) {
    const nextM = multiples[targetsHit]!;
    const targetPrice = pos.entryPriceUsd * nextM;

    if (pUsd >= targetPrice) {
      const isLastTarget = targetsHit === multiples.length - 1;
      const fraction = fractions[targetsHit] ?? 0.33;
      const sellRaw = isLastTarget
        ? balance.rawAmount
        : computeTakeProfitSellAmount(balance.rawAmount, fraction);
      if (sellRaw > 0n) {
        return { shouldExit: true, sellRaw, reason: `swing-take-profit-${targetsHit + 1}` };
      }
    }
  }

  return null;
}
