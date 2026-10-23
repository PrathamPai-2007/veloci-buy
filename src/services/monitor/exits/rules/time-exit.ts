import { ExitRule } from '../types.js';

export const timeExitGuard: ExitRule = async ({ ctx, pos, pUsd, ageSec }) => {
  const ageMin = ageSec / 60;
  const maxHoldMinutesResolved = Number(
    pos.maxHoldMinutesResolved || ctx.config.maxHoldMinutes || 20
  );
  if (
    ageMin >= maxHoldMinutesResolved &&
    pUsd < pos.entryPriceUsd * ctx.config.timeExitMinMultiple
  ) {
    return {
      reason: 'time-exit',
      message: `Max hold time reached for ${pos.symbol} (${ageMin.toFixed(1)}m); exiting.`,
      level: 'trade',
    };
  }
  return null;
};
