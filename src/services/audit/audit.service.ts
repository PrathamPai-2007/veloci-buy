import { getMintSignals, batchGetMintSignals } from './providers/onchain-auditor.js';
import { fetchRugCheckSignals, fetchRugCheckWalletSignals } from './providers/rugcheck-provider.js';
import { fetchBubbleMapsSignals } from './providers/bubblemaps-provider.js';

export { getMintSignals, batchGetMintSignals } from './providers/onchain-auditor.js';

export { fetchRugCheckSignals, fetchRugCheckWalletSignals } from './providers/rugcheck-provider.js';

export { fetchBubbleMapsSignals } from './providers/bubblemaps-provider.js';

export function isTruthyFlag(value: unknown): boolean {
  if (value === undefined || value === null || value === '' || value === false || value === 0)
    return false;
  const normalized = String(value).trim().toLowerCase();
  return !['0', 'false', 'null', 'none', 'no'].includes(normalized);
}

export const auditService = {
  getMintSignals,
  batchGetMintSignals,
  fetchRugCheckSignals,
  fetchRugCheckWalletSignals,
  fetchBubbleMapsSignals,
};
