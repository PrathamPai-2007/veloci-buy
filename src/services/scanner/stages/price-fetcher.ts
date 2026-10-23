import { registerPumpMintPda } from '../../../core/bot-internals/geyser-coordinator.js';
import { SOL_MINT } from '#core/config.js';
import { Context, TokenMetadata, SwapOrder } from '#types/index.js';
import { fetchSdkSwapOrder } from '../../trading/swap-executor.js';

export async function prefetchBuyQuote(ctx: Context, mint: string): Promise<SwapOrder | null> {
  try {
    return await fetchSdkSwapOrder(ctx, SOL_MINT, mint, ctx.config.buyAmountLamports);
  } catch (err) {
    ctx.logger(
      `[QuotePrefetch] Failed for ${mint}: ${err instanceof Error ? err.message : String(err)}`,
      'debug'
    );
    return null;
  }
}

export function refreshMarketSnapshots(ctx: Context, discoveryItems?: TokenMetadata[]): void {
  const { state, store } = ctx;
  const now = Date.now();
  const MARKET_SNAPSHOT_RETENTION_MS = 10 * 60 * 1000;

  if (discoveryItems) {
    for (const t of discoveryItems) {
      if (!t.id) continue;
      store.updateMarketSnapshot(t.id, {
        launchpad: t.launchpad || 'unknown',
        liquidity: Number(t.liquidity || 0),
        usdPrice: Number(t.usdPrice || 0),
        observedAt: new Date().toISOString(),
      });
      if (t.launchpad === 'pump.fun' || t.id.toLowerCase().endsWith('pump')) {
        registerPumpMintPda(ctx, t.id);
      }
    }
  }
  for (const [m, s] of state.marketSnapshots.entries()) {
    if (state.positions.has(m) || state.pendingCandidateRechecks.has(m)) continue;
    if (now - new Date(s.observedAt || 0).getTime() > MARKET_SNAPSHOT_RETENTION_MS) {
      store.removeMarketSnapshot(m);
    }
  }
}
