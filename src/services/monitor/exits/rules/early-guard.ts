import { ExitRule } from '../types.js';
import { isMigrationCoolingDown } from '../../../trading/local-router.js';
import { computeTakeProfitSellAmount } from '../../exit-calculator.js';

export const unifiedEarlyGuard: ExitRule = async ({
  ctx,
  mint,
  pos,
  balance,
  pUsd,
  ageSec,
  readOnly,
}) => {
  if (
    pos.targetsHit === 0 &&
    (pos.earlyGuardExits ?? 0) === 0 &&
    ageSec <= ctx.config.earlyPerformanceGuardSeconds
  ) {
    const drop = (pos.entryPriceUsd - pUsd) / pos.entryPriceUsd;
    const buyCollapse =
      Array.isArray(pos.tapeHistory) &&
      pos.tapeHistory.length >= 2 &&
      (pos.tapeHistory[pos.tapeHistory.length - 1]?.buys ?? 0) -
        (pos.tapeHistory[pos.tapeHistory.length - 2]?.buys ?? 0) <=
        0;

    // Rug Exit
    if (ctx.config.rugExitGuardEnabled && ageSec < ctx.config.rugExitWindowSec) {
      let dynamicDropPct = ctx.config.rugExitDropPct;
      if (ctx.config.rugExitDynamicScalingEnabled && pos.entryMarketCapUsd) {
        if (pos.entryMarketCapUsd < ctx.config.rugExitMicroCapThresholdUsd) {
          dynamicDropPct *= ctx.config.rugExitMicroCapMultiplier;
        } else if (pos.entryMarketCapUsd > ctx.config.rugExitHighCapThresholdUsd) {
          dynamicDropPct *= ctx.config.rugExitHighCapMultiplier;
        }
      }
      if (ctx.config.rugExitVolatilityScalingEnabled && pos.volatilityScaler) {
        dynamicDropPct *= 1 + pos.volatilityScaler;
      }

      let spreadReason: string | null = null;
      if (
        ctx.config.rugExitSpreadGuardEnabled &&
        Array.isArray(pos.spreadHistory) &&
        pos.spreadHistory.length > 0
      ) {
        const currentSpread = pos.spreadHistory[pos.spreadHistory.length - 1]?.spread;
        const initialSpread = pos.spreadHistory[0]?.spread;
        if (currentSpread !== undefined && initialSpread !== undefined) {
          if (currentSpread > ctx.config.rugExitMaxSpreadPct) {
            spreadReason = `spread too wide (${(currentSpread * 100).toFixed(1)}% > ${(ctx.config.rugExitMaxSpreadPct * 100).toFixed(1)}%)`;
          } else if (
            initialSpread > 0 &&
            currentSpread > initialSpread * ctx.config.rugExitSpreadExpansionMultiplier
          ) {
            spreadReason = `spread expanded (${(currentSpread * 100).toFixed(1)}% vs initial ${(initialSpread * 100).toFixed(1)}%)`;
          }
        }
      }

      let volumeReason: string | null = null;
      if (ctx.config.rugExitVolumeGuardEnabled) {
        if (Array.isArray(pos.tapeHistory) && pos.tapeHistory.length >= 2) {
          const latest = pos.tapeHistory[pos.tapeHistory.length - 1];
          const previous = pos.tapeHistory[pos.tapeHistory.length - 2];
          if (latest && previous) {
            const recentBuys = (latest.buys ?? 0) - (previous.buys ?? 0);
            const recentSells = (latest.sells ?? 0) - (previous.sells ?? 0);
            if (
              recentSells > recentBuys * ctx.config.rugExitSellDominanceMultiplier &&
              recentSells > 0
            ) {
              volumeReason = `sell dominance (${recentSells} sells vs ${recentBuys} buys)`;
            } else if (buyCollapse) {
              volumeReason = `buy collapse (stalled tape)`;
            }
          }
        }
      }

      const dropTriggered = drop > dynamicDropPct;
      const spreadTriggered = spreadReason !== null;
      const volumeTriggered = volumeReason !== null;

      if (isMigrationCoolingDown(mint)) {
        ctx.logger(`Migration cooldown active for ${pos.symbol}; suppressing rug-exit.`, 'debug');
      } else if (
        dropTriggered ||
        spreadTriggered ||
        (volumeTriggered && drop > dynamicDropPct * 0.5)
      ) {
        let logMsg = `Rug exit for ${pos.symbol}: age ${ageSec.toFixed(1)}s.`;
        if (dropTriggered) {
          logMsg += ` Price down ${(drop * 100).toFixed(1)}% (threshold ${(dynamicDropPct * 100).toFixed(1)}%).`;
        }
        if (spreadReason) logMsg += ` Spread: ${spreadReason}.`;
        if (volumeReason) logMsg += ` Volume: ${volumeReason}.`;

        pos.earlyGuardExits = (pos.earlyGuardExits ?? 0) + 1;
        if (!readOnly) ctx.store.upsertPosition(pos);
        return { reason: 'rug-exit', sellRaw: balance.rawAmount, message: logMsg, level: 'trade' };
      }
    }

    // EPG Exit
    if (
      ageSec >= ctx.config.rugExitWindowSec &&
      ageSec <= ctx.config.earlyPerformanceGuardSeconds
    ) {
      if (drop > ctx.config.earlyPerformanceDropPct / 100 || buyCollapse) {
        const partialAmount = computeTakeProfitSellAmount(
          balance.rawAmount,
          ctx.config.earlyPerformanceSellPct / 100
        );
        const sellAmount = partialAmount > 0n ? partialAmount : balance.rawAmount;
        const isFullExit = sellAmount === balance.rawAmount;

        pos.earlyGuardExits = (pos.earlyGuardExits ?? 0) + 1;
        if (!readOnly) ctx.store.upsertPosition(pos);

        return {
          reason: 'early-performance-guard',
          sellRaw: sellAmount,
          message: `Early Guard for ${pos.symbol}: drop ${(drop * 100).toFixed(1)}% or buy collapse. ${isFullExit ? 'Full' : 'Partial'} exit.`,
          level: 'warn',
        };
      }
    }
  }
  return null;
};
