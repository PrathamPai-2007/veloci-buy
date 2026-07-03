import { Context, TokenMetadata } from '#types/index.js';
import { atomicToDecimalString } from '#core/utils.js';
import { getSolBalance } from './wallet-manager.js';

/**
 * Result of the once-per-scan drawdown circuit-breaker evaluation.
 * `event` is set only on a state transition so the caller can log trip/resume exactly once.
 */
export interface DrawdownBreakerResult {
  blocked: boolean;
  event?: 'tripped' | 'resumed';
  reason?: string;
}

/**
 * Calculates the current session drawdown based on SOL balance.
 * Uses the peak balance tracked in state. For live mode the current balance must be supplied
 * via `currentLamportsOverride` (the wallet balance); paper mode reads it from state.
 */
export function calculateDrawdown(
  ctx: Context,
  currentLamportsOverride?: bigint
): {
  drawdownPct: number;
  isCritical: boolean;
  currentSol: number;
} {
  const currentSol =
    currentLamportsOverride != null
      ? Number(atomicToDecimalString(currentLamportsOverride.toString(), 9, 9))
      : ctx.config.paperTrading
        ? Number(atomicToDecimalString(ctx.state.paperSolBalanceLamports, 9, 9))
        : 0;
  const peakSol = Number(
    atomicToDecimalString(ctx.state.peakSessionSolBalanceLamports || '0', 9, 9)
  );

  if (peakSol <= 0) return { drawdownPct: 0, isCritical: false, currentSol };

  const drawdownPct = (peakSol - currentSol) / peakSol;
  const isCritical = drawdownPct >= ctx.config.maxDailyDrawdownPct;

  return { drawdownPct, isCritical, currentSol };
}

/**
 * Resolves the current SOL balance in lamports. Paper mode reads it from state; live mode reads
 * the real wallet balance (fixing the old hard-coded 0 that made any live peak look like a 100%
 * drawdown). Returns null on a transient live RPC failure so the breaker can skip that cycle.
 */
export async function getCurrentBalanceLamports(ctx: Context): Promise<bigint | null> {
  if (ctx.config.paperTrading) return BigInt(ctx.state.paperSolBalanceLamports || '0');
  try {
    return await getSolBalance(ctx);
  } catch {
    return null;
  }
}

/**
 * Account-wide drawdown circuit breaker, evaluated ONCE per scan (not per token). Pauses new
 * buys when the session drawdown breaches the limit, then auto-resumes after a cooldown by
 * re-baselining the peak high-water mark. Returns `event: 'tripped' | 'resumed'` only on a
 * transition so the caller logs a single line instead of one per candidate.
 */
export async function evaluateDrawdownBreaker(ctx: Context): Promise<DrawdownBreakerResult> {
  const now = Date.now();

  // Honor an active pause regardless of whether the drawdown breaker itself is enabled — the
  // loss-streak breaker (trade-logger.ts) also sets drawdownPauseUntil and must be respected.
  if (ctx.state.drawdownPauseUntil != null && now < ctx.state.drawdownPauseUntil) {
    return { blocked: true };
  }

  if (!ctx.config.circuitBreakerEnabled) {
    // Drawdown breaker off: still clear an elapsed pause (e.g. one set by the loss-streak breaker)
    // so trading resumes, but skip all balance/drawdown bookkeeping below.
    if (ctx.state.drawdownPauseUntil != null) {
      ctx.state.drawdownPauseUntil = null;
      ctx.state.lossStreakPauseActive = false;
      return { blocked: false, event: 'resumed' };
    }
    return { blocked: false };
  }

  const currentLamports = await portfolioService.getCurrentBalanceLamports(ctx);
  if (currentLamports == null) return { blocked: false }; // transient live RPC failure: skip

  // Keep the high-water mark current (works for both paper and live).
  ctx.store.updateSessionPeakBalance(currentLamports);

  const cooldownMs = Math.max(0, ctx.config.drawdownCooldownMinutes) * 60_000;

  // Cooldown just elapsed. Re-baseline the peak to the current balance so we resume from a fresh
  // high-water mark instead of immediately re-tripping against the old peak — but ONLY for a real
  // drawdown trip. A loss-streak pause is usually only a few percent down, so resetting the peak
  // there would silently weaken the catastrophic-drawdown breaker afterward.
  if (ctx.state.drawdownPauseUntil != null && now >= ctx.state.drawdownPauseUntil) {
    if (!ctx.state.lossStreakPauseActive) {
      ctx.store.setSessionPeakBalance(currentLamports);
    }
    ctx.state.drawdownPauseUntil = null;
    ctx.state.lossStreakPauseActive = false;
    return { blocked: false, event: 'resumed' };
  }

  const { drawdownPct, isCritical } = calculateDrawdown(ctx, currentLamports);
  if (isCritical) {
    ctx.state.drawdownPauseUntil = now + cooldownMs;
    ctx.state.lossStreakPauseActive = false; // drawdown-origin pause: resume should re-baseline
    return {
      blocked: true,
      event: 'tripped',
      reason: `Critical drawdown: ${(drawdownPct * 100).toFixed(2)}% exceeds limit of ${(
        ctx.config.maxDailyDrawdownPct * 100
      ).toFixed(2)}% — pausing new buys for ${ctx.config.drawdownCooldownMinutes}m`,
    };
  }

  return { blocked: false };
}

/**
 * Checks if a new buy is permitted based on per-token portfolio risk rules.
 * (The account-wide drawdown breaker is handled once per scan by evaluateDrawdownBreaker.)
 */
export function canBuy(ctx: Context, token: TokenMetadata): { approved: boolean; reason?: string } {
  // Sector Concentration Check (disabled when maxPositionsPerLaunchpad <= 0;
  // the overall maxOpenPositions cap still applies).
  if (token.launchpad && ctx.config.maxPositionsPerLaunchpad > 0) {
    const launchpad = token.launchpad.toLowerCase();
    const concurrentInSector = Array.from(ctx.state.positions.values()).filter(
      (pos) => pos.launchpad?.toLowerCase() === launchpad
    ).length;

    if (concurrentInSector >= ctx.config.maxPositionsPerLaunchpad) {
      return {
        approved: false,
        reason: `Max concurrent positions for ${token.launchpad} reached (${concurrentInSector})`,
      };
    }
  }

  return { approved: true };
}

/**
 * Win/loss stats from last N real (non-ghost) closed trades.
 * Used by kellyMultiplier to estimate the payoff ratio b = avgWin / avgLoss.
 */
export function getWinLossStats(
  ctx: Context,
  n: number
): { avgWinUsd: number; avgLossUsd: number; count: number } {
  const trades = ctx.store.getRecentClosedTrades(n).filter((t) => !t.isGhost);
  if (trades.length === 0) return { avgWinUsd: 1, avgLossUsd: 1, count: 0 };
  const wins = trades.filter((t) => t.realizedPnlUsd > 0);
  const losses = trades.filter((t) => t.realizedPnlUsd < 0);
  const avgWinUsd =
    wins.length > 0 ? wins.reduce((s, t) => s + t.realizedPnlUsd, 0) / wins.length : 0;
  const avgLossUsd =
    losses.length > 0
      ? Math.abs(losses.reduce((s, t) => s + t.realizedPnlUsd, 0) / losses.length)
      : 0;
  // Count only decisive trades (win or loss); zero-PnL exits don't inform the Kelly ratio.
  return { avgWinUsd, avgLossUsd: avgLossUsd || 1, count: wins.length + losses.length };
}

/**
 * Half-Kelly size multiplier based on ML confidence and historical payoff ratio.
 *
 * Full Kelly: f* = (b·p − q) / b  where b = avgWin/avgLoss, p = confidence, q = 1−p.
 * Returns half-Kelly clamped to [1 − maxFraction, 1 + maxFraction] so base stake
 * can grow up to (1 + maxFraction)× on high confidence or shrink on low confidence.
 * At confidence = 0.5 returns 1.0 (no change).
 */
export function kellyMultiplier(
  confidence: number,
  avgWinUsd: number,
  avgLossUsd: number,
  maxFraction: number
): number {
  const b = avgWinUsd / Math.max(avgLossUsd, 1e-6);
  const p = confidence;
  const q = 1 - p;
  const fullKelly = (b * p - q) / b;
  const halfKelly = fullKelly * 0.5;
  const clamped = Math.max(-maxFraction, Math.min(maxFraction, halfKelly));
  return 1 + clamped;
}

/**
 * Returns a dynamically adjusted buy size based on recent performance.
 * Implementation: Reduces size by 50% if the last 3 trades were losses.
 */
export function getAdjustedBuySize(ctx: Context, baseSizeLamports: bigint): bigint {
  if (!ctx.config.dynamicSizingEnabled) return baseSizeLamports;

  const recentTrades = ctx.state.closedTrades.slice(-3);
  if (recentTrades.length === 3 && recentTrades.every((t) => t.realizedPnlUsd < 0)) {
    return baseSizeLamports / 2n;
  }

  return baseSizeLamports;
}

/**
 * Service object for Portfolio Management.
 */
export const portfolioService = {
  calculateDrawdown,
  getCurrentBalanceLamports,
  evaluateDrawdownBreaker,
  canBuy,
  getAdjustedBuySize,
  getWinLossStats,
  kellyMultiplier,
};
