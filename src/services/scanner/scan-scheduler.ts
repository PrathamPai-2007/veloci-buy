import { Context, RecheckItem, TokenMetadata } from '#types/index.js';
export interface WorkItem {
  token: TokenMetadata;
  recheckEntry?: RecheckItem;
}

export const MAX_INDEXING_LAG_RETRIES = 3;

export function schedulePullbackRecheck(ctx: Context, item: WorkItem, reason: string): void {
  const { store } = ctx;
  const delayMs = 15000;
  store.upsertRecheckEntry({
    mint: item.token.id,
    tokenSnapshot: item.token,
    reason: `pullback:${reason}`,
    scheduledTime: Date.now() + delayMs,
    basePriceUsd: item.recheckEntry?.basePriceUsd || item.token.usdPrice,
    auditAttempts: (item.recheckEntry?.auditAttempts || 0) + 1,
  });
}

export function scheduleRecheckEligibleWaitlist(
  ctx: Context,
  item: WorkItem,
  code: string,
  options?: { lowHolderWaitlist?: boolean }
): void {
  const { config, store } = ctx;
  let delayMs = config.borderlineRecheckMinDelayMs || 8000;
  if (code === 'low-holders' || options?.lowHolderWaitlist) {
    delayMs = (config.holderCountWaitlistSeconds || 33) * 1000;
  }
  const isTooNew = code === 'too-new';
  store.upsertRecheckEntry({
    mint: item.token.id,
    tokenSnapshot: item.token,
    reason: `waitlist:${code || 'low-holders'}`,
    scheduledTime: Date.now() + delayMs,
    auditAttempts: isTooNew
      ? item.recheckEntry?.auditAttempts || 0
      : (item.recheckEntry?.auditAttempts || 0) + 1,
    isWaitlist: true,
  });
}

export function scheduleSurvivalDelay(ctx: Context, item: WorkItem, score: number): void {
  const { config, store } = ctx;
  const baseSeconds = config.survivalDelaySeconds || 5;
  let delayMs = baseSeconds * 1000;
  if (score >= (config.survivalDelayThresholdVeryHigh || 90)) {
    delayMs = baseSeconds * 100;
  } else if (score >= (config.survivalDelayThresholdHigh || 75)) {
    delayMs = baseSeconds * 500;
  }
  store.upsertRecheckEntry({
    mint: item.token.id,
    tokenSnapshot: item.token,
    reason: 'survival',
    scheduledTime: Date.now() + delayMs,
    candidateScore: score,
    basePriceUsd: item.token.usdPrice,
    isSurvivalWait: true,
    auditAttempts: item.recheckEntry?.auditAttempts || 0,
  });
}

export function scheduleFinalAudit(ctx: Context, item: WorkItem): void {
  const { config, store } = ctx;
  const delayMs = (config.finalAuditSeconds ?? 2) * 1000;
  store.incrementMetric('finalAuditQueued');
  store.upsertRecheckEntry({
    mint: item.token.id,
    tokenSnapshot: item.token,
    reason: 'final-audit',
    scheduledTime: Date.now() + delayMs,
    isFinalAudit: true,
    auditAttempts: item.recheckEntry?.auditAttempts || 0,
    basePriceUsd: item.recheckEntry?.basePriceUsd,
    candidateScore: item.recheckEntry?.candidateScore,
  });
}

export function scheduleIndexingLagRetry(ctx: Context, item: WorkItem, retryCount: number): void {
  const { store } = ctx;
  if (retryCount > MAX_INDEXING_LAG_RETRIES) {
    store.trackMint(item.token.id);
    return;
  }
  store.incrementMetric('finalAuditDeferredIndexing', 1);
  const delayMs = 5000;
  store.upsertRecheckEntry({
    ...item.recheckEntry!,
    mint: item.token.id,
    tokenSnapshot: item.token,
    scheduledTime: Date.now() + delayMs,
    indexingLagRetries: retryCount,
  });
}

export function scheduleRpcErrorBackoff(ctx: Context, item: WorkItem, reason: string): void {
  const { store } = ctx;
  const attempts = (item.recheckEntry?.auditAttempts || 0) + 1;
  const baseDelay = 15000 * Math.pow(2, Math.min(attempts - 1, 3));
  const jitter = Math.floor(Math.random() * 5000);
  const delayMs = baseDelay + jitter;

  store.upsertRecheckEntry({
    mint: item.token.id,
    tokenSnapshot: item.token,
    reason: `rpc-backoff:${reason}`,
    scheduledTime: Date.now() + delayMs,
    auditAttempts: attempts,
    isWaitlist: true,
  });
}

export function getDueCandidateRechecks(ctx: Context): RecheckItem[] {
  const { state } = ctx;
  const now = Date.now();
  const getDueTime = (r: RecheckItem): number => {
    if (Number.isFinite(r.scheduledTime)) return Number(r.scheduledTime);
    const parsed = r.nextEligibleAt ? new Date(r.nextEligibleAt).getTime() : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return Array.from(state.pendingCandidateRechecks.values())
    .filter((r) => getDueTime(r) <= now)
    .sort((a, b) => getDueTime(a) - getDueTime(b));
}
