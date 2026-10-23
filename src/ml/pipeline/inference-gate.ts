import { log } from '#core/utils.js';
import { StateStore } from '#core/store.js';

export function checkGating(
  store: StateStore | null,
  gateMinRealTrades: number,
  logFile: string,
  gatingActive: boolean
): boolean {
  if (gatingActive || !store) return gatingActive;
  const realTrades = store
    .getRecentClosedTrades(gateMinRealTrades * 10)
    .filter((t) => !t.isGhost).length;
  if (realTrades >= gateMinRealTrades) {
    log(
      logFile,
      `[ML] Gate activated after ${realTrades} real closed trades — now enforcing confidence threshold.`,
      'info'
    );
    return true;
  }
  return false;
}
