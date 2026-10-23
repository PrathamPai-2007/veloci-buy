import { Context, MintSignals } from '#types/index.js';
import { auditService } from '../audit/audit.service.js';
import { PRIORITY } from '#core/utils.js';
import { WorkItem } from './scan-scheduler.js';

export async function batchPreFetchAudits(
  ctx: Context,
  heavyAudits: WorkItem[]
): Promise<Map<string, MintSignals>> {
  const batchedSignalsMap = new Map<string, MintSignals>();
  if (heavyAudits.length === 0) return batchedSignalsMap;

  for (const item of heavyAudits) {
    const cached = ctx.state.prefetchedMintSignals.get(item.token.id);
    if (cached) {
      batchedSignalsMap.set(item.token.id, cached);
      ctx.state.prefetchedMintSignals.delete(item.token.id);
    }
  }

  const uncachedHeavy = heavyAudits.filter((i) => !batchedSignalsMap.has(i.token.id));
  if (uncachedHeavy.length > 0) {
    const prefetchStart = Date.now();
    try {
      const signals = await auditService.batchGetMintSignals(
        ctx,
        uncachedHeavy.map((i) => i.token.id),
        { priority: PRIORITY.HIGH }
      );
      for (const [m, s] of signals) {
        batchedSignalsMap.set(m, s);
      }
      ctx.logger(
        `[BatchAudit] Pre-fetched signals for ${uncachedHeavy.length} candidates in ${Date.now() - prefetchStart}ms (${heavyAudits.length - uncachedHeavy.length} from survival cache)`,
        'debug'
      );
    } catch (err) {
      ctx.logger(
        `Batch signal pre-fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        'warn'
      );
    }
  } else {
    ctx.logger(
      `[BatchAudit] All ${heavyAudits.length} candidates served from survival prefetch cache`,
      'debug'
    );
  }

  return batchedSignalsMap;
}
