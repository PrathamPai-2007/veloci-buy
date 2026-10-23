import { ExitRule } from '../types.js';
import { formatUsd, ratioToPercentString } from '#core/utils.js';

export const trailingStopGuard: ExitRule = async ({ ctx, pos, pUsd, isRunnerOnly }) => {
  let trailingDrawdownPct = Number(
    pos.trailingStopDrawdownPctResolved || ctx.config.trailingStopDrawdownPct || 0.2
  );
  const currentMultiple = pUsd / pos.entryPriceUsd;

  if (currentMultiple > 1.8) {
    const acceleration = Math.min(0.12, (currentMultiple - 1.8) * 0.04);
    trailingDrawdownPct = Math.max(0.04, trailingDrawdownPct - acceleration);
  }

  const trailP = (pos.highestPriceUsd || pUsd) * (1 - trailingDrawdownPct);
  if (!isRunnerOnly && pUsd < trailP) {
    return {
      reason: 'tp-trailing-max-exit',
      message: `Trailing Stop hit for ${pos.symbol}: price ${formatUsd(pUsd)} < ${ratioToPercentString(1 - trailingDrawdownPct)} of peak (${formatUsd(pos.highestPriceUsd)}).`,
      level: 'trade',
    };
  }
  return null;
};
