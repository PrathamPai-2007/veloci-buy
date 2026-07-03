import { clamp } from '#core/utils.js';
import { Context, EvaluationResult, TokenMetadata } from '#types/index.js';
import { PricePoint, getValidPriceHistory } from '../engine/scoring.js';

interface TapePoint {
  buys: number;
  sells: number;
  timestamp?: number;
}

export interface BurstSignals {
  approved: boolean;
  blockers: string[];
  entryMomentum: number;
  buySellRatio: number;
  drawdownPct: number;
  consistency: number;
}

function normalizeTapeHistory(history: unknown[]): TapePoint[] {
  if (!Array.isArray(history)) return [];
  return history
    .map((p) => {
      const item = p as Record<string, unknown>;
      return {
        buys: Number(item.buys || 0),
        sells: Number(item.sells || 0),
        timestamp: Number(item.timestamp || 0),
      };
    })
    .filter((p) => Number.isFinite(p.buys) && Number.isFinite(p.sells));
}

function getConsistency(points: PricePoint[]): number {
  if (points.length < 2) return 1;
  let green = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i]!.price > points[i - 1]!.price) green++;
  }
  return green / (points.length - 1);
}

export function analyzeBurstCandidate(
  ctx: Context,
  token: TokenMetadata,
  priceHistory: unknown[] = [],
  priceAtStartOfDelay: number | null = null,
  liquidityAtStartOfDelay: number | null = null,
  tapeAtStart: { buys: number; sells: number } | null = null,
  tapeHistory: unknown[] = []
): BurstSignals {
  const blockers: string[] = [];
  const currentPrice = Number(token.usdPrice || 0);
  const startPrice = Number(priceAtStartOfDelay || 0);
  const prices = getValidPriceHistory(priceHistory).concat(
    currentPrice > 0 ? [{ price: currentPrice, timestamp: Date.now() }] : []
  );
  const tape = normalizeTapeHistory(tapeHistory);
  const highest = prices.length > 0 ? Math.max(...prices.map((p) => p.price)) : currentPrice;
  const drawdownPct = highest > 0 ? (1 - currentPrice / highest) * 100 : 0;
  const entryMomentum = startPrice > 0 && currentPrice > 0 ? currentPrice / startPrice : 0;

  const startBuys = Number(tapeAtStart?.buys ?? tape[0]?.buys ?? 0);
  const startSells = Number(tapeAtStart?.sells ?? tape[0]?.sells ?? 0);
  const endBuys = Number(token.stats5m?.numBuys ?? tape[tape.length - 1]?.buys ?? startBuys);
  const endSells = Number(token.stats5m?.numSells ?? tape[tape.length - 1]?.sells ?? startSells);
  const buyDelta = Math.max(0, endBuys - startBuys);
  const sellDelta = Math.max(0, endSells - startSells);
  const buySellRatio = buyDelta / Math.max(1, sellDelta);
  const consistency = getConsistency(prices);

  if (startPrice > 0 && !(entryMomentum >= ctx.config.burstMinMomentum)) {
    blockers.push(
      `Burst momentum ${entryMomentum.toFixed(3)}x below ${ctx.config.burstMinMomentum}x.`
    );
  }
  if (drawdownPct > ctx.config.burstMaxEntryDrawdownPct) {
    blockers.push(
      `Burst entry drawdown ${drawdownPct.toFixed(1)}% exceeds ${ctx.config.burstMaxEntryDrawdownPct}%.`
    );
  }
  if (buySellRatio < ctx.config.burstMinBuySellRatio) {
    blockers.push(
      `Burst buy/sell ratio ${buySellRatio.toFixed(2)} below ${ctx.config.burstMinBuySellRatio}.`
    );
  }
  if (prices.length >= 4 && consistency < 0.55) {
    blockers.push(`Burst momentum choppy: ${(consistency * 100).toFixed(1)}% green.`);
  }

  if (liquidityAtStartOfDelay != null && liquidityAtStartOfDelay > 0) {
    const liquidity = Number(token.liquidity || 0);
    const dropPct = (1 - liquidity / liquidityAtStartOfDelay) * 100;
    if (dropPct > ctx.config.maxLiquidityDrawdownPct) {
      blockers.push(`Burst liquidity drawdown ${dropPct.toFixed(1)}%.`);
    }
  }

  // SOL outflow check: detect SOL leaving the bonding curve during the survival window (Option D)
  const firstLiq = (prices[0] as { liquidity?: number } | undefined)?.liquidity;
  const lastLiq = (prices[prices.length - 1] as { liquidity?: number } | undefined)?.liquidity;
  // Use != null (not truthiness) so a lastLiq of 0 (complete rug-pull) still triggers the check.
  if (firstLiq != null && lastLiq != null && firstLiq > 0) {
    const liquidityChangePct = (lastLiq - firstLiq) / firstLiq;
    if (liquidityChangePct < -(ctx.config.burstMaxSolOutflowPct ?? 0.05)) {
      blockers.push(
        `SOL outflow during survival: ${(liquidityChangePct * 100).toFixed(1)}% liquidity drop.`
      );
    }
  }

  if (tape.length >= 3) {
    const mid = tape[Math.floor(tape.length / 2)]!;
    const last = tape[tape.length - 1]!;
    const firstHalfBuys = Math.max(0, mid.buys - tape[0]!.buys);
    const secondHalfBuys = Math.max(0, last.buys - mid.buys);
    if (firstHalfBuys >= 2 && secondHalfBuys < firstHalfBuys * 0.35) {
      blockers.push('Burst buy velocity decayed.');
    }
  }

  return {
    approved: blockers.length === 0,
    blockers,
    entryMomentum: clamp(entryMomentum, 0, 1000),
    buySellRatio: clamp(buySellRatio, 0, 1000),
    drawdownPct: clamp(drawdownPct, 0, 100),
    consistency: clamp(consistency, 0, 1),
  };
}

export function applyBurstOverlay(
  ctx: Context,
  result: EvaluationResult,
  inputs: {
    priceHistory?: unknown[];
    priceAtStartOfDelay?: number | null;
    liquidityAtStartOfDelay?: number | null;
    tapeAtStart?: { buys: number; sells: number } | null;
    tapeHistory?: unknown[];
  }
): EvaluationResult {
  if (!ctx.config.burstModeEnabled || !result.approved) return result;

  // Skip burst validation overlay on the initial cheap audit (before survival delay has run)
  if (inputs.priceAtStartOfDelay === null || inputs.priceAtStartOfDelay === undefined) {
    return result;
  }

  const signals = analyzeBurstCandidate(
    ctx,
    result.token,
    inputs.priceHistory || [],
    inputs.priceAtStartOfDelay ?? null,
    inputs.liquidityAtStartOfDelay ?? null,
    inputs.tapeAtStart ?? null,
    inputs.tapeHistory || []
  );

  if (!signals.approved) {
    return {
      ...result,
      approved: false,
      blockers: [...result.blockers, ...signals.blockers],
      rejectionReasons: [
        ...result.rejectionReasons,
        // burst-filter failures are final — the token already survived the full delay window.
        ...signals.blockers.map(() => ({ code: 'burst-filter', recheckEligible: false })),
      ],
    };
  }

  return {
    ...result,
    entryProfile: 'burst',
    burstEntryMomentum: signals.entryMomentum,
    burstBuySellRatio: signals.buySellRatio,
    burstTrailingDrawdownPct: ctx.config.burstTrailingDrawdownPct,
  };
}
