import { Context, RecheckItem, TokenMetadata } from '#types/index.js';
export interface WorkItem {
  token: TokenMetadata;
  recheckEntry?: RecheckItem;
}

export const MAX_INDEXING_LAG_RETRIES = 3;

/** A token that never shows a buy this long after first sight is dropped instead of re-queued. */
export const ZERO_BUYS_GIVE_UP_MS = 180_000;
/** Minimum wait before re-checking a token that has no buys yet (the tape fills in the meantime). */
const ZERO_BUYS_RECHECK_MS = 8_000;

/** Fields every re-queue must carry forward, or the survival-window baseline is lost. */
function carried(item: WorkItem, now = Date.now()): Partial<RecheckItem> {
  const e = item.recheckEntry;
  const price = Number(item.token.usdPrice) || 0;
  const high = Math.max(e?.highestSeenPriceUsd ?? 0, price);
  return {
    firstSeenAt: e?.firstSeenAt ?? now,
    survivalStartedAt: e?.survivalStartedAt,
    highestSeenPriceUsd: high > 0 ? high : undefined,
  };
}

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
    ...carried(item),
  });
}

export function scheduleRecheckEligibleWaitlist(
  ctx: Context,
  item: WorkItem,
  code: string,
  options?: { lowHolderWaitlist?: boolean }
): void {
  const { config, store } = ctx;
  const now = Date.now();
  const keep = carried(item, now);
  const isZeroBuys = code === 'zero-buys';
  // Zero buys is "the tape hasn't caught up yet" for a fresh mint: wait for it, but not forever.
  if (isZeroBuys && now - (keep.firstSeenAt ?? now) > ZERO_BUYS_GIVE_UP_MS) {
    store.trackMint(item.token.id);
    return;
  }
  let delayMs = config.borderlineRecheckMinDelayMs || 8000;
  if (code === 'low-holders' || options?.lowHolderWaitlist) {
    delayMs = (config.holderCountWaitlistSeconds || 33) * 1000;
  } else if (isZeroBuys) {
    delayMs = Math.max(delayMs, ZERO_BUYS_RECHECK_MS);
  }
  // Waiting on data (too new / no buys yet) must not burn the recheck budget.
  const isWaitingOnData = code === 'too-new' || isZeroBuys;
  store.upsertRecheckEntry({
    mint: item.token.id,
    tokenSnapshot: item.token,
    reason: `waitlist:${code || 'low-holders'}`,
    scheduledTime: now + delayMs,
    auditAttempts: isWaitingOnData
      ? item.recheckEntry?.auditAttempts || 0
      : (item.recheckEntry?.auditAttempts || 0) + 1,
    isWaitlist: true,
    ...keep,
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
  const now = Date.now();
  store.upsertRecheckEntry({
    mint: item.token.id,
    tokenSnapshot: item.token,
    reason: 'survival',
    scheduledTime: now + delayMs,
    candidateScore: score,
    basePriceUsd: item.token.usdPrice,
    isSurvivalWait: true,
    auditAttempts: item.recheckEntry?.auditAttempts || 0,
    ...carried(item, now),
    // The survival window starts now: price/tape history is measured from here.
    survivalStartedAt: now,
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
    ...carried(item),
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
    ...carried(item),
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
