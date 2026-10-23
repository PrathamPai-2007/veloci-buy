import { ExitRule } from '../types.js';
import { localMarketState } from '../../../market-state/index.js';

export const noEarlyPerformanceGuard: ExitRule = async ({ ctx, pos, pUsd, ageSec }) => {
  if (ageSec < ctx.config.minHoldTimeSeconds)
    return { reason: 'min-hold', sellRaw: 0n, handled: true }; // Short circuit

  if (
    ageSec > ctx.config.performanceCheckSeconds &&
    pos.targetsHit === 0 &&
    pUsd < pos.entryPriceUsd * ctx.config.performanceMinMomentum
  ) {
    const returnPct = ((pUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;
    const snap = localMarketState.getSnapshot(pos.mint);
    ctx.logger(
      `[ExitDiagnostic:noEarlyPerformance] mint=${pos.mint} entryPrice=$${pos.entryPriceUsd} currentPrice=$${pUsd} returnPct=${returnPct.toFixed(2)}% highestPrice=$${pos.highestPriceUsd || 0} ageSec=${ageSec}s targetsHit=${pos.targetsHit} requiredMomentum=${ctx.config.performanceMinMomentum} priceSource=${snap?.source || 'monitor'} snapshotUpdatedAt=${snap?.updatedAt || 0} snapshotSlot=${snap?.sourceSlot || 0}`,
      'info',
      { console: true }
    );
    return {
      reason: 'no-early-performance',
      message: `No early performance for ${pos.symbol} (return ${returnPct.toFixed(2)}%); exiting.`,
      level: 'trade',
    };
  }
  return null;
};
