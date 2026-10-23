import { isTransientOperationError, isRateLimitError } from '#core/utils.js';
import { Context, TokenMetadata } from '#types/index.js';
import {
  WorkItem,
  MAX_INDEXING_LAG_RETRIES,
  scheduleIndexingLagRetry,
  scheduleRpcErrorBackoff,
} from '../scan-scheduler.js';

export interface StageDurations {
  priceFetchMs: number[];
  lightAuditMs: number[];
  heavyAuditMs: number[];
  buyMs: number[];
}

export interface ScanMetrics {
  discovery: number;
  rechecks: number;
  buys: number;
  rejected: number;
  requeued: number;
  errors: number;
  lagRetries: number;
  reservedBuys: number;
  skipped: number;
}

export function isTokenTooOld(token: TokenMetadata, maxAgeMinutes: number): boolean {
  if (!token.firstPool?.createdAt) return false;
  const ageMs = Date.now() - new Date(token.firstPool.createdAt).getTime();
  return ageMs > maxAgeMinutes * 60 * 1000;
}

export function handleProcessError(
  ctx: Context,
  item: WorkItem,
  err: unknown,
  metrics: ScanMetrics
): void {
  const { store } = ctx;
  const token = item.token;

  if (err instanceof Error && err.message.includes('RPC Indexing Lag')) {
    const retries = item.recheckEntry?.indexingLagRetries || 0;
    if (retries < MAX_INDEXING_LAG_RETRIES) {
      metrics.lagRetries++;
      scheduleIndexingLagRetry(ctx, item, retries + 1);
      return;
    }
  }

  if (
    isRateLimitError(err) ||
    (err instanceof Error && (err.message.includes('429') || err.message.includes('rate limit')))
  ) {
    metrics.errors++;
    ctx.recordScanBackpressureEvent?.(err);
    scheduleRpcErrorBackoff(ctx, item, err instanceof Error ? err.message : String(err));
    return;
  }

  if (isTransientOperationError(err)) {
    metrics.errors++;
    ctx.recordScanBackpressureEvent?.(err);
    return;
  }

  const msg = err instanceof Error ? err.message : String(err);
  ctx.logger(`[ScanError] ${token.symbol}: ${msg}`, 'warn');
  metrics.errors++;
  store.trackMint(token.id);
}

export function logScanSummary(
  ctx: Context,
  _stageDurations: StageDurations,
  metrics: ScanMetrics,
  workItems: WorkItem[],
  _dueCount: number,
  _discoveryCount: number,
  scanStart: number,
  _lightC: number,
  _heavyC: number
): void {
  ctx.logger(
    `[SCAN] ${workItems.length} items. ` +
      `pos: ${ctx.state.positions.size}, buys: ${metrics.buys}, skip: ${metrics.skipped}, rchk: ${metrics.requeued}, rej: ${metrics.rejected}, err: ${metrics.errors}${metrics.lagRetries > 0 ? ` (lag:${metrics.lagRetries})` : ''}. ` +
      `(Total: ${Date.now() - scanStart}ms)`,
    'info'
  );
}
