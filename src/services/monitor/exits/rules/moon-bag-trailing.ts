import { ExitRule } from '../types.js';
import { formatUsd, ratioToPercentString } from '#core/utils.js';

export const moonBagTrailingGuard: ExitRule = async ({ ctx, pos, pUsd, isRunnerOnly }) => {
  if (isRunnerOnly && pos.trailingArmed) {
    const moonTrailP = (pos.highestPriceUsd || pUsd) * (1 - ctx.config.moonBagTrailingDrawdownPct);
    if (pUsd < moonTrailP) {
      return {
        reason: 'moon-bag-trailing-exit',
        message: `Moon-bag trailing hit for ${pos.symbol}: price ${formatUsd(pUsd)} < ${ratioToPercentString(1 - ctx.config.moonBagTrailingDrawdownPct)} of peak (${formatUsd(pos.highestPriceUsd)}). Closing runner.`,
        level: 'trade',
      };
    }
  }
  return null;
};
