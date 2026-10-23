import { ExitRule } from '../types.js';
import { monitorService } from '../../monitor.service.js';
import { tradingService } from '../../../trading/trading.service.js';
import { PRIORITY } from '#core/utils.js';

export const takeProfitLadderGuard: ExitRule = async ({
  ctx,
  pos,
  pUsd,
  multiples,
  isRunnerOnly,
  readOnly,
}) => {
  if (!isRunnerOnly) {
    while (pos.targetsHit! < multiples.length) {
      const nextM = multiples[pos.targetsHit!]!;
      const targetP = pos.entryPriceUsd * nextM;
      const minTpM = 1 + 0.5 * (nextM - 1);
      const minTpP = pos.entryPriceUsd * minTpM;

      if (pUsd >= minTpP && !pos.minTpArmed) {
        pos.minTpReached = true;
        pos.minTpArmed = true;
        if (!readOnly) {
          ctx.logger(
            `Midpoint Profit Guard ARMED for ${pos.symbol} (Target ${pos.targetsHit! + 1}).`,
            'info'
          );
          ctx.store.upsertPosition(pos);
        }
      }

      if (pUsd < targetP) break;

      const freshBalance = await tradingService.getWalletTokenBalance(ctx, pos.mint, PRIORITY.HIGH);
      if (readOnly) break; // ghost chain is readOnly — never execute real TP ladder
      if (await monitorService.sellTakeProfit(ctx, pos, freshBalance, pUsd, nextM)) {
        pos.minTpReached = false;
        pos.minTpArmed = false;
        ctx.store.upsertPosition(pos);
      } else {
        break;
      }
    }
  }
  return null;
};
