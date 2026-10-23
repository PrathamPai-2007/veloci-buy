import { ExitRule } from '../types.js';

export const spreadVelocityGuard: ExitRule = async ({ pos }) => {
  if (Array.isArray(pos.spreadHistory) && pos.spreadHistory.length >= 2) {
    const last = pos.spreadHistory[pos.spreadHistory.length - 1]!;
    const prev = pos.spreadHistory[pos.spreadHistory.length - 2]!;
    const timeDiff = (last.timestamp - prev.timestamp) / 1000;
    if (timeDiff <= 15 && prev.spread > 0) {
      const spreadIncrease = last.spread / prev.spread - 1;
      if (spreadIncrease > 0.5) {
        return {
          reason: 'spread-velocity-exit',
          message: `SPREAD VELOCITY: Widened ${(spreadIncrease * 100).toFixed(1)}% for ${pos.symbol}. Rug risk.`,
          level: 'warn',
        };
      }
    }
  }
  return null;
};
