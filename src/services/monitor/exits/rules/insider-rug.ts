import { ExitRule } from '../types.js';
import { BURN_OWNERS } from '#core/config.js';
import { ratioToPercentString } from '#core/utils.js';

/**
 * Compares the holders captured at entry (`pos.entryMintSignals`) with the latest background
 * re-audit (`preSignals`). Without both, or when they are the same object, there is nothing to
 * compare and the rule stays quiet.
 */
export const insiderRugGuard: ExitRule = async ({ ctx, pos, preSignals }) => {
  const baseline = pos.entryMintSignals;
  if (!baseline || !preSignals || preSignals === baseline) return null;
  const initialHolders = baseline.topAccounts || [];
  const entryTop5 = Number(baseline.top5Share ?? 0);
  const isConcentrated = entryTop5 >= ctx.config.insiderDriftConcentrationTop5;

  for (const initial of initialHolders) {
    if (!initial.owner || BURN_OWNERS.has(initial.owner)) continue;
    const current = preSignals.topAccounts.find((a) => a.owner === initial.owner);
    const initialAmt = Number(initial.rawAmount);
    const dropRatio = current ? 1 - Number(current.rawAmount) / initialAmt : 1;
    const drifted = current ? dropRatio > 0.25 : true;
    if (!drifted) continue;

    pos.insiderDrifts = pos.insiderDrifts || {};
    if (pos.insiderDrifts[initial.owner]) continue;
    pos.insiderDrifts[initial.owner] = true;

    const action = current ? `sold ${(dropRatio * 100).toFixed(1)}%` : 'exited top 5';

    if (!isConcentrated) {
      ctx.logger(
        `Insider drift on distributed ${pos.symbol} (top5 ${ratioToPercentString(entryTop5)}): ${initial.owner.slice(0, 8)} ${action}. Holding — churn is normal.`,
        'info'
      );
      continue;
    }

    return {
      reason: 'insider-rug-exit',
      message: `INSIDER RUG: concentrated ${pos.symbol} (top5 ${ratioToPercentString(entryTop5)}) holder ${initial.owner.slice(0, 8)} ${action}. Full exit.`,
      level: 'warn',
    };
  }
  return null;
};
