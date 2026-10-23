import { ExitRule } from '../types.js';

export const securityRugGuard: ExitRule = async ({ pos, preSignals }) => {
  if (preSignals) {
    if (preSignals.mintAuthority || preSignals.freezeAuthority) {
      return {
        reason: 'security-rug-exit',
        message: `SECURITY ALERT: ${pos.symbol} authorities enabled after buy! Emergency Exit.`,
        level: 'warn',
      };
    }
  }
  return null;
};
