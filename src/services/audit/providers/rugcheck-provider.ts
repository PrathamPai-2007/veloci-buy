import { fetchJson, getErrorMessage, runBoundedPool, PRIORITY } from '#core/utils.js';
import { Context, RugCheckSignals } from '#types/index.js';

function rugcheckRateLimit(ctx: Context): { key: string; rps: number; priority: PRIORITY } {
  return { key: 'rugcheck', rps: ctx.config.rugcheckRps || 1, priority: PRIORITY.LOW };
}

const WALLET_RISK_TTL_MS = 10 * 60_000;
const WALLET_RISK_CACHE_MAX = 5000;
const walletRiskCache = new Map<string, { high: boolean; expiresAt: number }>();

/** @testOnly */
export function _clearWalletRiskCacheForTest(): void {
  walletRiskCache.clear();
}

interface RugCheckRisk {
  name: string;
  level: 'danger' | 'warn' | string;
}

interface RugCheckReport {
  score_normalised?: number;
  risks?: RugCheckRisk[];
  rugged?: boolean;
}

export async function fetchRugCheckSignals(ctx: Context, mint: string): Promise<RugCheckSignals> {
  const timeoutMs = 6000;
  const headers: Record<string, string> = ctx.config.rugcheckApiKey
    ? { Authorization: `Bearer ${ctx.config.rugcheckApiKey}` }
    : {};
  try {
    const url = `${ctx.config.rugcheckBaseUrl}/tokens/${mint}/report`;
    const payload = (await fetchJson(url, {
      headers,
      timeoutMs,
      retries: 0,
      rateLimit: rugcheckRateLimit(ctx),
    })) as RugCheckReport;

    const blockers: string[] = [];
    const notes: string[] = [];

    if (payload.rugged) {
      blockers.push('RugCheck: token previously rugged.');
    }

    for (const risk of payload.risks ?? []) {
      if (risk.level === 'danger') {
        blockers.push(`RugCheck: ${risk.name}`);
      } else if (risk.level === 'warn') {
        notes.push(`RugCheck warn: ${risk.name}`);
      }
    }

    const riskScore = payload.score_normalised ?? null;
    if (riskScore != null) notes.push(`RugCheck score: ${riskScore}`);

    return { status: 'ok', blockers, notes, riskScore, rugged: payload.rugged ?? false };
  } catch (e: unknown) {
    const message = getErrorMessage(e);
    ctx.logger(`RugCheck fetch failed for ${mint}: ${message}`, 'warn');
    return {
      status: 'error',
      blockers: [],
      notes: [],
      riskScore: null,
      rugged: false,
      error: message,
    };
  }
}

export async function fetchRugCheckWalletSignals(
  ctx: Context,
  addresses: string[]
): Promise<string[]> {
  if (addresses.length === 0) return [];
  const headers: Record<string, string> = ctx.config.rugcheckApiKey
    ? { Authorization: `Bearer ${ctx.config.rugcheckApiKey}` }
    : {};
  const results = await runBoundedPool(
    addresses,
    async (addr) => {
      // Insiders and creators recur across candidates; a wallet's risk level doesn't change in
      // minutes, so don't spend 1 req/s budget re-asking. Failures are never cached.
      const cached = walletRiskCache.get(addr);
      if (cached && cached.expiresAt > Date.now()) return cached.high ? addr : null;
      try {
        const url = `${ctx.config.rugcheckBaseUrl}/wallet/${addr}/risk`;
        const payload = (await fetchJson(url, {
          headers,
          timeoutMs: 3000,
          retries: 0,
          rateLimit: rugcheckRateLimit(ctx),
        })) as {
          riskLevel?: string;
        };
        const high = payload.riskLevel === 'high';
        if (walletRiskCache.size >= WALLET_RISK_CACHE_MAX) {
          const oldest = walletRiskCache.keys().next().value;
          if (oldest !== undefined) walletRiskCache.delete(oldest);
        }
        walletRiskCache.set(addr, { high, expiresAt: Date.now() + WALLET_RISK_TTL_MS });
        return high ? addr : null;
      } catch {
        return null;
      }
    },
    { concurrency: ctx.config.ownerAuditParallelism || 2 }
  );
  return results
    .filter((r) => r.status === 'fulfilled' && r.value !== null)
    .map((r) => r.value as string);
}
