import { formatUsd } from '#core/utils.js';
import { Context, Position, WalletBalance } from '#types/index.js';

export interface BurstExitDecision {
  reason: string;
  sellRaw: bigint;
}

export function getBurstExitDecision(
  ctx: Context,
  pos: Position,
  balance: WalletBalance,
  pUsd: number,
  now = Date.now()
): BurstExitDecision | null {
  if (pos.entryProfile !== 'burst' || !(pUsd > 0) || balance.rawAmount <= 0n) return null;

  const ageSec = (now - new Date(pos.openedAt).getTime()) / 1000;
  const highest = Math.max(Number(pos.highestPriceUsd || pos.entryPriceUsd || 0), pUsd);
  const trailing = Number(pos.burstTrailingDrawdownPct ?? ctx.config.burstTrailingDrawdownPct);
  const drawdownFromHigh = highest > 0 ? 1 - pUsd / highest : 0;

  if (ageSec <= ctx.config.earlyPerformanceGuardSeconds) {
    const failed = pUsd < pos.entryPriceUsd * ctx.config.burstMinMomentum;
    if (failed) {
      return { reason: 'burst-early-failure', sellRaw: balance.rawAmount };
    }
  }

  if (drawdownFromHigh >= trailing && highest > pos.entryPriceUsd * 1.05) {
    return { reason: 'burst-trailing-exit', sellRaw: balance.rawAmount };
  }

  if (pos.targetsHit && pos.targetsHit > 0 && drawdownFromHigh >= trailing * 0.75) {
    return { reason: 'burst-distribution-exit', sellRaw: balance.rawAmount };
  }

  const maxHoldMs = Math.max(1, ctx.config.burstMaxHoldMinutes) * 60_000;
  if (now - new Date(pos.openedAt).getTime() >= maxHoldMs && pUsd < pos.entryPriceUsd * 1.8) {
    return { reason: 'burst-time-exit', sellRaw: balance.rawAmount };
  }

  return null;
}

export function describeBurstExit(pos: Position, pUsd: number, reason: string): string {
  const multiple = pos.entryPriceUsd > 0 ? pUsd / pos.entryPriceUsd : 0;
  return `Burst exit ${reason} for ${pos.symbol}: ${formatUsd(pUsd)} (${multiple.toFixed(2)}x).`;
}
