import { ExitRule } from '../types.js';
import { formatUsd } from '#core/utils.js';
import { isMigrationCoolingDown } from '../../../trading/local-router.js';

export const stopLossGuard: ExitRule = async ({ ctx, mint, pos, pUsd, ageSec, readOnly }) => {
  const baseSlPct = ctx.config.stopLossPct;
  const adjustedSlPct = baseSlPct * (1 + (pos.volatilityScaler || 0));
  const effectiveSlPct =
    ageSec < ctx.config.earlyStopLossWindowSec
      ? ctx.config.earlyStopLossPct
      : ageSec < ctx.config.midStopLossWindowSec
        ? ctx.config.midStopLossPct
        : adjustedSlPct;

  let slP = pos.entryPriceUsd * (1 - effectiveSlPct);

  if (ctx.config.breakevenRatchetEnabled && (pos.targetsHit ?? 0) >= 1) {
    slP = Math.max(slP, pos.entryPriceUsd * (1 + ctx.config.breakevenRatchetBufferPct));
  }
  if (
    ctx.config.slBreakevenEnabled &&
    (pos.highestPriceUsd || 0) >= pos.entryPriceUsd * (1 + ctx.config.slBreakevenThresholdPct)
  ) {
    slP = Math.max(slP, pos.entryPriceUsd * (1 + ctx.config.slBreakevenBufferPct));
  }

  const slWP = (pos.entryPriceUsd + slP) / 2;

  if (pUsd <= slWP && !pos.stopLossWarningSent) {
    pos.stopLossWarningSent = true;
    if (!readOnly) {
      ctx.logger(
        `WARNING: ${pos.symbol} half-SL touched. Drawdown: ${((1 - pUsd / pos.entryPriceUsd) * 100).toFixed(2)}%.`,
        'warn',
        { console: true }
      );
      ctx.store.upsertPosition(pos);
    }
  }

  if (isMigrationCoolingDown(mint) && pUsd <= slP) {
    ctx.logger(`Migration cooldown active for ${pos.symbol}; suppressing stop-loss.`, 'debug');
  } else if (pUsd <= slP) {
    return {
      reason: 'stop-loss',
      message: `STOP LOSS hit for ${pos.symbol} at ${formatUsd(pUsd)}.`,
      level: 'trade',
    };
  }

  if (!pos.trailingArmed) {
    pos.trailingArmed = true;
    if (!readOnly) ctx.store.upsertPosition(pos);
  }

  return null;
};
