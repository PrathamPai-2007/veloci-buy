import { ExitRule } from '../types.js';

export const breakevenStopGuard: ExitRule = async ({
  ctx,
  pos,
  pUsd,
  multiples,
  isRunnerOnly,
  readOnly,
}) => {
  if (ctx.config.breakEvenStopEnabled && !isRunnerOnly) {
    const beFloor = pos.entryPriceUsd * (1 + ctx.config.breakEvenStopFloorPct);
    const activeTpMidpointM =
      pos.targetsHit! < multiples.length ? 1 + 0.5 * (multiples[pos.targetsHit!]! - 1) : Infinity;
    const beTrigger =
      pos.entryPriceUsd * Math.min(ctx.config.breakEvenStopTriggerMultiple, activeTpMidpointM);

    if (!pos.breakEvenStopArmed && (pos.highestPriceUsd || 0) >= beTrigger) {
      pos.breakEvenStopArmed = true;
      if (!readOnly) {
        ctx.store.upsertPosition(pos);
        ctx.logger(
          `[BreakevenStop] ARMED ${pos.symbol} — peak ${pos.highestPriceUsd.toExponential(4)}, floor ${beFloor.toExponential(4)}`,
          'info'
        );
      }
    }
    if (pos.breakEvenStopArmed && pUsd <= beFloor) {
      return {
        reason: 'breakeven-stop',
        message: `[BreakevenStop] EXIT ${pos.symbol} — price ${pUsd.toExponential(4)} at or below floor ${beFloor.toExponential(4)}`,
        level: 'trade',
      };
    }
  }
  return null;
};
