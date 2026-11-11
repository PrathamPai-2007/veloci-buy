import type { RecheckItem, TokenMetadata } from '#types/index.js';
import { marketDataProvider } from '../../market-state/market-data-provider.js';
import { marketTapeManager } from '../../market-state/market-tape-manager.js';
import { getLiquidityPeak } from '../../market-state/pump-trade-ingest.js';

/** Local snapshots older than this are ignored in favour of whatever the token already carried. */
const LOCAL_FRESH_MS = 15_000;
const TAPE_WINDOW_MS = 300_000;
const MAX_TAPE_POINTS = 24;

export interface LocalEvalInputs {
  token: TokenMetadata;
  /**
   * Baseline for the liquidity-drain guard in the SAME units as the current reading: the local
   * curve-liquidity peak since the survival window began when the current reading is local, else
   * the entry's own snapshot. Undefined when no like-for-like baseline exists.
   */
  liquidityAtStartUsd: number | undefined;
  highestSeenPriceUsd: number | null;
  priceHistory: { price: number; timestamp: number }[];
  tapeAtStart: { buys: number; sells: number } | null;
  tapeHistory: { buys: number; sells: number; timestamp: number }[];
}

/**
 * Builds the evaluation inputs the scanner used to leave empty (price history, trade tape,
 * highest price) from local market state, which pump-trade ingestion fills for free. Falls back
 * to whatever the token/entry already carried when no local data exists, so Jupiter-only
 * candidates behave exactly as before.
 */
export function buildLocalEvalInputs(
  token: TokenMetadata,
  entry?: RecheckItem,
  now = Date.now()
): LocalEvalInputs {
  const mint = token.id;
  const startedAt = entry?.survivalStartedAt ?? entry?.firstSeenAt ?? now;

  // Fresh authoritative local price/liquidity beats a stale Jupiter or snapshot value.
  const details = marketDataProvider.getMarketPriceDetails(mint, LOCAL_FRESH_MS);
  const snap = marketDataProvider.getSnapshot(mint);
  const enriched: TokenMetadata = { ...token };
  let liquidityAtStartUsd = entry?.tokenSnapshot?.liquidity;
  if (details.isFresh && snap && details.priceUsd != null) {
    enriched.usdPrice = details.priceUsd;
    if (snap.liquidityUsd > 0) {
      enriched.liquidity = snap.liquidityUsd;
      liquidityAtStartUsd = getLiquidityPeak(mint, startedAt);
    }
    if (!(Number(enriched.fdv) > 0) && snap.fdvUsd > 0) enriched.fdv = snap.fdvUsd;
  }

  const priceHistory = marketDataProvider
    .getPriceHistory(mint)
    .filter((p) => p.timestamp >= startedAt)
    .map((p) => ({ price: p.price, timestamp: p.timestamp }));
  const fallbackHistory = entry?.tokenSnapshot?.priceHistory ?? [];
  const history = priceHistory.length > 0 ? priceHistory : fallbackHistory;

  let high = Math.max(entry?.highestSeenPriceUsd ?? 0, Number(enriched.usdPrice) || 0);
  for (const p of history) if (p.price > high) high = p.price;

  let tapeAtStart = entry?.tokenSnapshot?.tapeAtStart ?? null;
  let tapeHistory = entry?.tokenSnapshot?.tapeHistory ?? [];
  if (marketTapeManager.hasTape(mint)) {
    const ticks = marketTapeManager.getTicks(mint, now - TAPE_WINDOW_MS);
    let buys = 0;
    let sells = 0;
    const series: { buys: number; sells: number; timestamp: number }[] = [];
    let startCounts = { buys: 0, sells: 0 };
    let startRecorded = false;
    for (const t of ticks) {
      if (!startRecorded && t.timestamp >= startedAt) {
        startCounts = { buys, sells };
        startRecorded = true;
      }
      if (t.side === 'buy') buys++;
      else sells++;
      if (startRecorded) series.push({ buys, sells, timestamp: t.timestamp });
    }
    if (!startRecorded) startCounts = { buys, sells };
    // Cumulative counts, downsampled; first point is the survival-window start.
    const step = Math.max(1, Math.ceil(series.length / MAX_TAPE_POINTS));
    const sampled = series.filter((_, i) => i % step === step - 1 || i === series.length - 1);
    tapeAtStart = startCounts;
    tapeHistory = [{ ...startCounts, timestamp: startedAt }, ...sampled];
    // stats5m counts come from the same tape so the cumulative series and the total agree.
    enriched.stats5m = { numBuys: buys, numSells: sells };
  }
  enriched.tapeAtStart = tapeAtStart ?? undefined;
  enriched.tapeHistory = tapeHistory.length > 0 ? tapeHistory : undefined;

  return {
    token: enriched,
    liquidityAtStartUsd,
    highestSeenPriceUsd: high > 0 ? high : null,
    priceHistory: history,
    tapeAtStart,
    tapeHistory,
  };
}
