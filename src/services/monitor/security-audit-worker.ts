import { PRIORITY, isRateLimitError } from '#core/utils.js';
import { auditService } from '../audit/audit.service.js';
import { Context, MintSignals, Position } from '#types/index.js';

export interface SecuritySignalCacheEntry {
  signals: MintSignals;
  fetchedAt: number;
}

export class SecurityAuditWorker {
  private readonly auditsInFlight = new Set<string>();
  private readonly securitySignalCache = new Map<string, SecuritySignalCacheEntry>();

  public getCachedSecuritySignal(mint: string, pos?: Position): MintSignals | undefined {
    const cached = this.securitySignalCache.get(mint);
    if (cached) {
      return cached.signals;
    }
    return pos?.mintSignals;
  }

  public isAuditInFlight(mint: string): boolean {
    return this.auditsInFlight.has(mint);
  }

  public isAuditDue(pos: Position, now = Date.now(), cooldownMs = 30_000): boolean {
    return !pos.lastSecurityAuditAt || now - pos.lastSecurityAuditAt > cooldownMs;
  }

  /**
   * Triggers non-blocking background security re-audits for due active positions.
   * Deduplicates in-flight mints and uses bounded pool concurrency.
   * NEVER blocks position monitoring or throws errors back to the caller.
   */
  public triggerSecurityReaudit(ctx: Context, dueMints: string[]): void {
    const mintsToAudit: string[] = [];

    for (const mint of dueMints) {
      if (this.auditsInFlight.has(mint)) {
        ctx.store.incrementMetric('securityAuditsSkippedInFlight', 1);
        continue;
      }
      this.auditsInFlight.add(mint);
      mintsToAudit.push(mint);
    }

    if (mintsToAudit.length === 0) return;

    ctx.store.incrementMetric('securityAuditsQueued', mintsToAudit.length);
    const now = Date.now();

    // Stamp audit timestamps immediately to prevent duplicate queuing
    for (const mint of mintsToAudit) {
      const pos = ctx.state.positions.get(mint);
      if (pos) {
        pos.lastSecurityAuditAt = now;
      }
    }

    // Execute background batch audit asynchronously (non-blocking)
    void (async () => {
      try {
        const AUDIT_TIMEOUT_MS = 8000;
        const fetchPromise = auditService.batchGetMintSignals(ctx, mintsToAudit, {
          priority: PRIORITY.LOW,
        });

        let timeoutId: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`batchGetMintSignals timed out after ${AUDIT_TIMEOUT_MS}ms`));
          }, AUDIT_TIMEOUT_MS);
        });

        let batchResult: Map<string, MintSignals>;
        try {
          batchResult = await Promise.race([fetchPromise, timeoutPromise]);
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
        }

        for (const [mint, signals] of batchResult.entries()) {
          this.securitySignalCache.set(mint, { signals, fetchedAt: Date.now() });
          const pos = ctx.state.positions.get(mint);
          if (pos) {
            pos.mintSignals = signals;
          }
        }
        ctx.store.incrementMetric('securityAuditsCompleted', batchResult.size);
      } catch (err) {
        ctx.store.incrementMetric('securityAuditsFailed', mintsToAudit.length);
        const errMsg = err instanceof Error ? err.message : String(err);
        ctx.logger(`Background security audit re-fetch failed: ${errMsg}`, 'warn');

        // Clear timestamps on non-rate-limit errors so mints retry next interval
        if (!isRateLimitError(err) && !errMsg.includes('timed out')) {
          for (const mint of mintsToAudit) {
            const pos = ctx.state.positions.get(mint);
            if (pos) pos.lastSecurityAuditAt = undefined;
          }
        }
      } finally {
        for (const mint of mintsToAudit) {
          this.auditsInFlight.delete(mint);
        }
      }
    })();
  }

  public clear(mint?: string): void {
    if (mint) {
      this.auditsInFlight.delete(mint);
      this.securitySignalCache.delete(mint);
    } else {
      this.auditsInFlight.clear();
      this.securitySignalCache.clear();
    }
  }
}

export const securityAuditWorker = new SecurityAuditWorker();
