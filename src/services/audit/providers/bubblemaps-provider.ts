import { fetchJson, ratioToPercentString, PRIORITY } from '#core/utils.js';
import { Context, BubbleMapsSignals } from '#types/index.js';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export async function fetchBubbleMapsSignals(
  ctx: Context,
  mint: string,
  opts?: { isTrending?: boolean }
): Promise<BubbleMapsSignals | null> {
  if (!ctx.config.bubbleMapsApiKey) return null;
  const minScore = opts?.isTrending
    ? ctx.config.trendingMinBubbleMapsScore
    : ctx.config.minBubbleMapsScore;
  // Optional signal: fail fast and fall back to on-chain concentration rather than stall the audit.
  const timeoutMs = 2000;
  try {
    const params = new URLSearchParams({
      return_clusters: 'true',
      return_decentralization_score: 'true',
      return_nodes: 'false',
      use_magic_nodes: 'true',
    });
    const url = `${ctx.config.bubbleMapsBaseUrl}/maps/solana/${mint}?${params.toString()}`;
    const payload = (await fetchJson(url, {
      headers: { 'X-ApiKey': ctx.config.bubbleMapsApiKey },
      timeoutMs,
      retries: 0,
      rateLimit: {
        key: 'bubblemaps',
        rps: (ctx.config.bubbleMapsRpm || 6) / 60,
        priority: PRIORITY.LOW,
      },
    })) as { clusters?: Array<{ share?: number }>; decentralization_score?: number };
    const largestClusterShare =
      Array.isArray(payload?.clusters) && payload.clusters.length > 0
        ? Number(payload.clusters[0]!.share || 0)
        : null;
    const blockers: string[] = [];
    if (
      payload?.decentralization_score != null &&
      Number(payload.decentralization_score) < minScore
    ) {
      blockers.push(
        `BubbleMaps decentralization score ${payload.decentralization_score} is below ${minScore}`
      );
    }
    if (
      largestClusterShare != null &&
      largestClusterShare > ctx.config.maxBubbleMapsLargestClusterShare
    ) {
      blockers.push(
        `BubbleMaps largest cluster share ${ratioToPercentString(largestClusterShare)} is above ${ratioToPercentString(ctx.config.maxBubbleMapsLargestClusterShare)}`
      );
    }
    return {
      status: 'ok',
      blockers,
      score: payload?.decentralization_score ?? null,
      largestClusterShare,
      raw: payload,
    };
  } catch (e: unknown) {
    const message = getErrorMessage(e);
    const status = message.includes('timed out') ? 'timeout' : 'error';
    ctx.logger(`BubbleMaps skipped for ${mint} (${status}): ${message}`, 'warn');
    return { status, blockers: [], score: null, largestClusterShare: null, error: message };
  }
}
