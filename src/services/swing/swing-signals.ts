import { SwingSignals, SwingSwapTick, SwingWatchlistItem } from '#types/index.js';

export interface DoubleDipResult {
  dip1Idx: number;
  dip1Price: number;
  bounceIdx: number;
  bouncePrice: number;
  dip2Idx: number;
  dip2Price: number;
  recoveryPct: number;
  higherLow: boolean;
}

export interface VolumeAccumResult {
  detected: boolean;
  buySellRatioTrend: number;
  buyCountDip1: number;
  buyCountDip2: number;
  sellCountDip1: number;
  sellCountDip2: number;
}

/**
 * Finds indices of local minima in a price series.
 * A candidate at index i is a minimum when both neighbours are strictly higher,
 * and no other minimum candidate is within minGap positions.
 */
export function findLocalMinima(prices: number[], minGap = 3): number[] {
  const result: number[] = [];
  for (let i = 1; i < prices.length - 1; i++) {
    if (
      (prices[i] ?? 0) < (prices[i - 1] ?? Infinity) &&
      (prices[i] ?? 0) < (prices[i + 1] ?? Infinity)
    ) {
      if (result.length === 0 || i - result[result.length - 1]! >= minGap) {
        result.push(i);
      }
    }
  }
  return result;
}

/**
 * Finds indices of local maxima in a price series.
 */
export function findLocalMaxima(prices: number[], minGap = 3): number[] {
  const result: number[] = [];
  for (let i = 1; i < prices.length - 1; i++) {
    if ((prices[i] ?? 0) > (prices[i - 1] ?? 0) && (prices[i] ?? 0) > (prices[i + 1] ?? 0)) {
      if (result.length === 0 || i - result[result.length - 1]! >= minGap) {
        result.push(i);
      }
    }
  }
  return result;
}

/**
 * Detects a double-dip (W-pattern) in a price history array.
 *
 * Requirements:
 *  - At least 2 local minima and 1 local maximum
 *  - Bounce between the two dips
 *  - At least 5% recovery from the second dip
 */
export function detectDoubleDip(
  priceHistory: { price: number; timestamp: number }[]
): DoubleDipResult | null {
  if (priceHistory.length < 30) return null;

  const prices = priceHistory.map((p) => p.price);
  const minima = findLocalMinima(prices);
  const maxima = findLocalMaxima(prices);

  if (minima.length < 2 || maxima.length < 1) return null;

  const currentPrice = prices[prices.length - 1]!;

  // Scan combinations of (dip2, bounce, dip1) starting from the most recent dip2
  for (let d2 = minima.length - 1; d2 >= 1; d2--) {
    const dip2Idx = minima[d2]!;

    // Find the most recent bounce that occurred before dip2
    let bounceIdx: number | undefined;
    for (let m = maxima.length - 1; m >= 0; m--) {
      if (maxima[m]! < dip2Idx) {
        bounceIdx = maxima[m];
        break;
      }
    }
    if (bounceIdx === undefined) continue;

    // Find the most recent dip1 that occurred before bounce
    let dip1Idx: number | undefined;
    for (let d1 = d2 - 1; d1 >= 0; d1--) {
      if (minima[d1]! < bounceIdx) {
        dip1Idx = minima[d1];
        break;
      }
    }
    if (dip1Idx === undefined) continue;

    const dip1Price = prices[dip1Idx]!;
    const bouncePrice = prices[bounceIdx]!;
    const dip2Price = prices[dip2Idx]!;

    if (bouncePrice <= 0 || dip2Price <= 0) continue;

    const dip1Depth = (bouncePrice - dip1Price) / bouncePrice;
    const dip2Depth = (bouncePrice - dip2Price) / bouncePrice;
    const higherLow = dip2Depth < dip1Depth;

    const recoveryPct = ((currentPrice - dip2Price) / dip2Price) * 100;
    if (recoveryPct >= 5) {
      return {
        dip1Idx,
        dip1Price,
        bounceIdx,
        bouncePrice,
        dip2Idx,
        dip2Price,
        recoveryPct,
        higherLow,
      };
    }
  }

  return null;
}

/**
 * Detects volume accumulation across two dip windows.
 * Compares buy/sell activity in a ±windowMs time window around each dip.
 * Accumulation = more buys at dip2 than dip1, and an improving buy/sell ratio.
 *
 * @param dip1Timestamp - epoch ms of the first dip (from priceHistory)
 * @param dip2Timestamp - epoch ms of the second dip (from priceHistory)
 * @param windowMs - half-width of the time window around each dip (default ±5 min)
 */
export function detectVolumeAccumulation(
  tapeHistory: { buys: number; sells: number; timestamp: number }[],
  dip1Timestamp: number,
  dip2Timestamp: number,
  windowMs = 5 * 60_000
): VolumeAccumResult {
  const empty = {
    detected: false,
    buySellRatioTrend: 0,
    buyCountDip1: 0,
    buyCountDip2: 0,
    sellCountDip1: 0,
    sellCountDip2: 0,
  };

  if (tapeHistory.length < 4) return empty;

  const slice = (centerTs: number): typeof tapeHistory =>
    tapeHistory.filter((t) => Math.abs(t.timestamp - centerTs) <= windowMs);

  const sum = (points: typeof tapeHistory, key: 'buys' | 'sells'): number =>
    points.reduce((acc, p) => acc + (p[key] ?? 0), 0);

  const dip1Points = slice(dip1Timestamp);
  const dip2Points = slice(dip2Timestamp);

  const buyCountDip1 = sum(dip1Points, 'buys');
  const sellCountDip1 = sum(dip1Points, 'sells');
  const buyCountDip2 = sum(dip2Points, 'buys');
  const sellCountDip2 = sum(dip2Points, 'sells');

  const ratioDip1 = buyCountDip1 / Math.max(1, sellCountDip1);
  const ratioDip2 = buyCountDip2 / Math.max(1, sellCountDip2);
  const buySellRatioTrend = ratioDip2 - ratioDip1;

  const detected = buyCountDip2 > buyCountDip1 && buySellRatioTrend > 0;

  return { detected, buySellRatioTrend, buyCountDip1, buyCountDip2, sellCountDip1, sellCountDip2 };
}

/**
 * Returns true when a partial W-pattern has formed (dip1 + bounce present, dip2 not yet confirmed).
 * Used to trigger fast-poll mode so price resolution increases during dip2 formation.
 *
 * Requires the bounce to have occurred in the second half of recorded history — if it's too
 * old the pattern has either already completed (handled by detectDoubleDip) or failed.
 */
export function detectPartialW(priceHistory: { price: number; timestamp: number }[]): boolean {
  if (priceHistory.length < 10) return false;
  const prices = priceHistory.map((p) => p.price);
  const minima = findLocalMinima(prices);
  const maxima = findLocalMaxima(prices);
  if (minima.length < 1 || maxima.length < 1) return false;

  // Scan maxima starting from the most recent one
  for (let m = maxima.length - 1; m >= 0; m--) {
    const bounceIdx = maxima[m]!;

    // Bounce must be recent (in the latter 50% of recorded history)
    if (bounceIdx < priceHistory.length * 0.5) continue;

    // There must be no dip2 yet after the bounce
    const dip2Idx = minima.find((i) => i > bounceIdx);
    if (dip2Idx !== undefined) continue;

    // There must be a dip1 before the bounce
    const dip1Idx = minima.find((i) => i < bounceIdx);
    if (dip1Idx !== undefined) {
      return true; // partial: bounce formed but dip2 not yet observed
    }
  }

  return false;
}

/**
 * Detects volume accumulation using tick-level swap data (Phase 3A).
 * Compares total SOL buy volume vs sell volume in ±windowMs windows around each dip.
 * Preferred over detectVolumeAccumulation when item.swapTape is available.
 *
 * Returns a VolumeAccumResult-compatible shape so both paths use the same scoring.
 * `buyCountDip1/2` and `sellCountDip1/2` are milli-SOL units (×1000) for display.
 */
export function detectSwapTapeAccumulation(
  swapTape: SwingSwapTick[],
  dip1Ts: number,
  dip2Ts: number,
  windowMs = 5 * 60_000
): VolumeAccumResult {
  const empty = {
    detected: false,
    buySellRatioTrend: 0,
    buyCountDip1: 0,
    buyCountDip2: 0,
    sellCountDip1: 0,
    sellCountDip2: 0,
  };

  if (swapTape.length < 4) return empty;

  const slice = (centerTs: number): SwingSwapTick[] =>
    swapTape.filter((t) => Math.abs(t.timestamp - centerTs) <= windowMs);

  const buyVol = (ticks: SwingSwapTick[]) =>
    ticks.filter((t) => t.side === 'buy').reduce((s, t) => s + t.amountSol, 0);
  const sellVol = (ticks: SwingSwapTick[]) =>
    ticks.filter((t) => t.side === 'sell').reduce((s, t) => s + t.amountSol, 0);

  const dip1Ticks = slice(dip1Ts);
  const dip2Ticks = slice(dip2Ts);

  const buyDip1 = buyVol(dip1Ticks);
  const sellDip1 = sellVol(dip1Ticks);
  const buyDip2 = buyVol(dip2Ticks);
  const sellDip2 = sellVol(dip2Ticks);

  const ratio1 = buyDip1 / Math.max(0.001, sellDip1);
  const ratio2 = buyDip2 / Math.max(0.001, sellDip2);
  const buySellRatioTrend = ratio2 - ratio1;
  const detected = buyDip2 > buyDip1 && buySellRatioTrend > 0;

  return {
    detected,
    buySellRatioTrend,
    buyCountDip1: Math.round(buyDip1 * 1000),
    buyCountDip2: Math.round(buyDip2 * 1000),
    sellCountDip1: Math.round(sellDip1 * 1000),
    sellCountDip2: Math.round(sellDip2 * 1000),
  };
}

/**
 * Combines double-dip and volume accumulation signals for a watchlist item
 * into a single SwingSignals object with a composite score.
 */
export function computeSwingSignals(
  item: SwingWatchlistItem,
  doubleDipEnabled: boolean,
  volumeAccumEnabled: boolean
): SwingSignals {
  const blockers: string[] = [];

  let doubleDipResult: DoubleDipResult | null = null;
  let doubleDipScore = 0;

  if (doubleDipEnabled) {
    doubleDipResult = detectDoubleDip(item.priceHistory);
    if (!doubleDipResult) {
      blockers.push('no-double-dip-pattern');
    } else {
      doubleDipScore = 40;
      if (doubleDipResult.higherLow) doubleDipScore += 15;
      doubleDipScore += Math.min(10, doubleDipResult.recoveryPct);
    }
  }

  let volResult: VolumeAccumResult = {
    detected: false,
    buySellRatioTrend: 0,
    buyCountDip1: 0,
    buyCountDip2: 0,
    sellCountDip1: 0,
    sellCountDip2: 0,
  };
  let volumeScore = 0;

  if (doubleDipResult) {
    // Phase 1B: liquidity trend blocker — smart money leaving invalidates the pattern
    const liqAtDip1 = item.priceHistory[doubleDipResult.dip1Idx]?.liquidity;
    const liqAtDip2 = item.priceHistory[doubleDipResult.dip2Idx]?.liquidity;
    if (liqAtDip1 && liqAtDip2 && liqAtDip2 < liqAtDip1 * 0.85) {
      blockers.push('liquidity-declining');
    }
  }

  if (volumeAccumEnabled && doubleDipResult) {
    const dip1Ts = item.priceHistory[doubleDipResult.dip1Idx]!.timestamp;
    const dip2Ts = item.priceHistory[doubleDipResult.dip2Idx]!.timestamp;

    // Phase 3A: prefer tick-level swap tape (real SOL volumes) over 5m aggregates
    if (item.swapTape && item.swapTape.length >= 4) {
      volResult = detectSwapTapeAccumulation(item.swapTape, dip1Ts, dip2Ts);
    } else {
      volResult = detectVolumeAccumulation(item.tapeHistory, dip1Ts, dip2Ts);
    }

    if (!volResult.detected) {
      blockers.push('no-volume-accumulation');
    } else {
      volumeScore = 25 + Math.min(10, volResult.buySellRatioTrend * 5);
    }
  } else if (volumeAccumEnabled && !doubleDipResult) {
    blockers.push('no-volume-accumulation');
  }

  const totalScore = Math.min(100, doubleDipScore + volumeScore);
  const approved = blockers.length === 0 && totalScore > 0;

  return {
    doubleDipDetected: doubleDipResult !== null,
    dip1LowPrice: doubleDipResult?.dip1Price ?? 0,
    dip1LowIdx: doubleDipResult?.dip1Idx ?? 0,
    bounceHighPrice: doubleDipResult?.bouncePrice ?? 0,
    bounceHighIdx: doubleDipResult?.bounceIdx ?? 0,
    dip2LowPrice: doubleDipResult?.dip2Price ?? 0,
    dip2LowIdx: doubleDipResult?.dip2Idx ?? 0,
    recoveryPct: doubleDipResult?.recoveryPct ?? 0,
    higherLow: doubleDipResult?.higherLow ?? false,
    volumeAccumDetected: volResult.detected,
    buySellRatioTrend: volResult.buySellRatioTrend,
    buyCountDip1: volResult.buyCountDip1,
    buyCountDip2: volResult.buyCountDip2,
    sellCountDip1: volResult.sellCountDip1,
    sellCountDip2: volResult.sellCountDip2,
    totalScore,
    approved,
    blockers,
  };
}
