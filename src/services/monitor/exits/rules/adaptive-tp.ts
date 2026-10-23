import { ExitRule } from '../types.js';
import { formatUsd } from '#core/utils.js';

export const adaptiveTpMidpointGuard: ExitRule = async ({ pos, pUsd, multiples, isRunnerOnly }) => {
  if (!isRunnerOnly && pos.minTpArmed && pos.targetsHit! < multiples.length) {
    const nextM = multiples[pos.targetsHit!]!;
    const minTpM = 1 + 0.5 * (nextM - 1);
    const minTpP = pos.entryPriceUsd * minTpM;
    if (pUsd < minTpP) {
      return {
        reason: 'adaptive-tp-exit',
        message: `Price fell back to midpoint ${formatUsd(minTpP)} for ${pos.symbol} (Target ${pos.targetsHit! + 1}). Midpoint exit.`,
        level: 'trade',
      };
    }
  }
  return null;
};
