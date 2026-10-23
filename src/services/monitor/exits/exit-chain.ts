import { ExitContext, ExitDecision, ExitRule } from './types.js';
import { securityRugGuard } from './rules/security-rug.js';
import { insiderRugGuard } from './rules/insider-rug.js';
import { spreadVelocityGuard } from './rules/spread-velocity.js';
import { adaptiveTpMidpointGuard } from './rules/adaptive-tp.js';
import { breakevenStopGuard } from './rules/breakeven-stop.js';
import { unifiedEarlyGuard } from './rules/early-guard.js';
import { stopLossGuard } from './rules/stop-loss.js';
import { noEarlyPerformanceGuard } from './rules/performance-momentum.js';
import { trailingStopGuard } from './rules/trailing-stop.js';
import { moonBagTrailingGuard } from './rules/moon-bag-trailing.js';
import { timeExitGuard } from './rules/time-exit.js';
import { takeProfitLadderGuard } from './rules/take-profit-ladder.js';

export const defaultExitChain: ExitRule[] = [
  securityRugGuard,
  insiderRugGuard,
  spreadVelocityGuard,
  adaptiveTpMidpointGuard,
  breakevenStopGuard,
  unifiedEarlyGuard,
  stopLossGuard,
  noEarlyPerformanceGuard,
  trailingStopGuard,
  moonBagTrailingGuard,
  timeExitGuard,
  takeProfitLadderGuard,
];

export async function evaluateExitChain(
  exitCtx: ExitContext,
  chain = defaultExitChain
): Promise<ExitDecision | null> {
  for (const rule of chain) {
    const decision = await rule(exitCtx);
    if (decision) {
      if (decision.handled) {
        return null;
      }
      decision.sellRaw ??= exitCtx.balance.rawAmount;
      return decision;
    }
  }
  return null;
}
