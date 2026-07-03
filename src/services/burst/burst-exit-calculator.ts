import { clamp } from '#core/utils.js';
import { Context } from '#types/index.js';
import { TakeProfitPlan } from '../monitor/exit-calculator.js';

export function getBurstTakeProfitPlan(ctx: Context): TakeProfitPlan {
  return {
    profileId: 'burst-fast-de-risk',
    isHighGrowthConfidence: true,
    takeProfitMultiples: ctx.config.burstTakeProfitMultiples ?? [1.06, 1.12],
    takeProfitFractions: ctx.config.burstTakeProfitFractions ?? [0.75, 0.25],
    trailingStopDrawdownPct: clamp(ctx.config.burstTrailingDrawdownPct, 0.01, 0.5),
    maxHoldMinutesResolved: Math.max(1, Math.floor(ctx.config.burstMaxHoldMinutes)),
  };
}
