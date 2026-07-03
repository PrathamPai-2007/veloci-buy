import fs from 'node:fs';

if (!fs.existsSync('src/services/monitor')) {
  fs.mkdirSync('src/services/monitor', { recursive: true });
}

const exitCalculatorTs = `
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
import { clamp } from '../../core/utils.js';
import { TAKE_PROFIT_FRACTION, TAKE_PROFIT_MULTIPLES, MOOD_THRESHOLDS } from '../../core/config.js';
import { Context, Position } from '../../types/index.js';

export const TP_PROFILE_DEFAULTS = {
  high: {
    id: 'high-confidence',
    takeProfitMultiples: [1.5, 2.5],
    takeProfitFractions: [0.35, 0.35],
    trailingStopDrawdownPct: 0.2,
  },
  standard: {
    id: 'standard-confidence',
    takeProfitMultiples: [1.3, 2.1],
    takeProfitFractions: [0.5, 0.3],
    trailingStopDrawdownPct: 0.16,
  },
  low: {
    id: 'fast-de-risk',
    takeProfitMultiples: [1.2, 1.8],
    takeProfitFractions: [0.6, 0.25],
    trailingStopDrawdownPct: 0.12,
  },
};

export interface TakeProfitPlan {
  profileId: string;
  isHighGrowthConfidence: boolean;
  takeProfitMultiples: number[];
  takeProfitFractions: number[];
  trailingStopDrawdownPct: number;
  maxHoldMinutesResolved: number;
}

export function getTakeProfitPlanByProfile(
  ctx: Context,
  profile: 'high' | 'standard' | 'low'
): TakeProfitPlan {
  const selected = TP_PROFILE_DEFAULTS[profile];
  const isHigh = profile === 'high';
  const maxHoldMinutes = isHigh
    ? Number(ctx.config.holdDurationHighConfidenceMinutes || 10)
    : profile === 'standard'
      ? Number(ctx.config.maxHoldMinutes || 20)
      : Number(ctx.config.holdDurationLowConfidenceMinutes || 5);

  const baseMultiples =
    Array.isArray(ctx.config.takeProfitMultiples) && ctx.config.takeProfitMultiples.length >= 2
      ? ctx.config.takeProfitMultiples
      : [1.3, 2.1];
  const baseTrailing =
    typeof ctx.config.trailingStopDrawdownPct === 'number'
      ? ctx.config.trailingStopDrawdownPct
      : 0.16;

  let multiples: number[];
  let trailing: number;

  if (profile === 'high') {
    multiples = [(baseMultiples[0] ?? 1.3) + 0.2, (baseMultiples[1] ?? 2.1) + 0.4];
    trailing = baseTrailing + 0.04;
  } else if (profile === 'low') {
    multiples = [
      Math.max(1.05, (baseMultiples[0] ?? 1.3) - 0.1),
      Math.max(1.1, (baseMultiples[1] ?? 2.1) - 0.3),
    ];
    trailing = Math.max(0.01, baseTrailing - 0.04);
  } else {
    multiples = [...baseMultiples];
    trailing = baseTrailing;
  }

  return {
    profileId: selected.id,
    isHighGrowthConfidence: isHigh,
    takeProfitMultiples: multiples,
    takeProfitFractions: selected.takeProfitFractions.map((v) => clamp(v, 0, 1)),
    trailingStopDrawdownPct: clamp(trailing, 0.01, 0.95),
    maxHoldMinutesResolved: Math.max(1, Math.floor(maxHoldMinutes)),
  };
}

export function getTakeProfitPlan(ctx: Context, score: number): TakeProfitPlan {
  const numericScore = Number(score || 0);
  const highThreshold = Number(ctx.config.highGrowthConfidenceScore || 70);
  const baselineThreshold = Number(ctx.config.minCandidateScore || 60);
  const standardThreshold =
    baselineThreshold + Math.max(2, (highThreshold - baselineThreshold) / 2);

  let profile: 'high' | 'standard' | 'low' = 'low';

  if (numericScore >= highThreshold) {
    profile = 'high';
  } else if (numericScore >= standardThreshold) {
    profile = 'standard';
  }

  return getTakeProfitPlanByProfile(ctx, profile);
}

export function getTakeProfitFraction(pos: Position, targetIndex: number): number {
  return Array.isArray(pos.takeProfitFractions) &&
    Number.isFinite(pos.takeProfitFractions[targetIndex])
    ? clamp(pos.takeProfitFractions[targetIndex]!, 0, 1)
    : TAKE_PROFIT_FRACTION;
}

export function computeTakeProfitSellAmount(balRaw: bigint, frac: number): bigint {
  return (balRaw * BigInt(Math.max(1, Math.round(frac * 10000)))) / 10000n;
}

export interface MoodAdjustments {
  sizeMultiplier: number;
  isPaused: boolean;
}

export function getMoodAdjustments(ctx: Context): MoodAdjustments {
  let sizeMultiplier = 1.0;
  let isPaused = false;

  if (ctx.state.moodPauseUntil && Date.now() < ctx.state.moodPauseUntil) {
    isPaused = true;
  } else {
    const history = ctx.state.tradeHistory || [];
    const last10 = history.slice(-MOOD_THRESHOLDS.windowLarge);
    const last5 = history.slice(-MOOD_THRESHOLDS.windowSmall);

    const winRate10 =
      last10.length >= MOOD_THRESHOLDS.windowLarge
        ? last10.filter((w) => w).length / MOOD_THRESHOLDS.windowLarge
        : 1;

    const winRate5 =
      last5.length >= MOOD_THRESHOLDS.windowSmall
        ? last5.filter((w) => w).length / MOOD_THRESHOLDS.windowSmall
        : 1;

    if (winRate10 < MOOD_THRESHOLDS.winRateCritical) {
      isPaused = true;
      ctx.store.pauseMood(ctx.config.moodPauseDurationMinutes * 60000);
      ctx.logger(
        \`Daily Mood: CRITICAL (\${(winRate10 * 100).toFixed(0)}% WR). Pausing for \${ctx.config.moodPauseDurationMinutes}m.\`,
        'warn',
        { console: true }
      );
    } else if (winRate5 < MOOD_THRESHOLDS.winRateCautious) {
      sizeMultiplier = MOOD_THRESHOLDS.sizeMultiplierCautious;
      ctx.logger(
        \`Daily Mood: CAUTIOUS (\${(winRate5 * 100).toFixed(0)}% WR). Reducing size 50%.\`,
        'warn',
        { console: true }
      );
    }
  }

  return { sizeMultiplier, isPaused };
}

export function getTrailingActivationMultiple(pos: Position): number {
  const multiples =
    Array.isArray(pos.takeProfitMultiples) && pos.takeProfitMultiples.length > 0
      ? pos.takeProfitMultiples
      : TAKE_PROFIT_MULTIPLES;
  const firstTarget = Number(multiples[0] || 1.5);
  const midpoint = 1 + 0.5 * (firstTarget - 1);
  return Math.min(midpoint, 1.12);
}
`;

const exitExecutorTs = `
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
import { sleep, atomicToDecimalString, formatUsd, sendNotification, journalPaperTrade, PRIORITY } from '../../core/utils.js';
import { SOL_MINT } from '../../core/config.js';
import { tradingService } from '../trading/trading.service.js';
import { Context, Position, WalletBalance } from '../../types/index.js';
import { monitorService } from './monitor.service.js';
import { getTakeProfitFraction, computeTakeProfitSellAmount } from './exit-calculator.js';

export const processingMints = new Set<string>();

export async function executePositionExit(
  ctx: Context,
  pos: Position,
  balance: WalletBalance,
  pUsd: number,
  sellRaw: bigint,
  reason: string,
  targetM: number | null = null
): Promise<boolean> {
  if (sellRaw <= 0n) {
    ctx.logger(\`Skipping \${reason} for \${pos.symbol}; zero amount.\`, 'warn');
    return false;
  }

  if (processingMints.has(pos.mint)) {
    ctx.logger(
      \`Already processing exit for \${pos.symbol}; skipping concurrent \${reason}.\`,
      'debug'
    );
    return false;
  }
  processingMints.add(pos.mint);

  try {
    if (pos.targetsHit === undefined) pos.targetsHit = 0;

    if (ctx.config.paperTrading) {
      const quote = await tradingService.buildPaperSellQuote(
        ctx,
        sellRaw,
        pUsd,
        pos.decimals,
        ctx.config.jupiterPositionApiKey
      );
      const remain = balance.rawAmount - sellRaw;
      const proceedsSol = Number(atomicToDecimalString(quote.outAmount, 9, 9));
      const accounting = monitorService.buildExitAccounting(
        pos,
        sellRaw,
        balance.rawAmount,
        quote.grossUsdValue,
        proceedsSol
      );

      ctx.store.updatePaperSolBalance(BigInt(ctx.state.paperSolBalanceLamports) + quote.outAmount);

      if (reason.startsWith('take-profit')) pos.targetsHit++;
      pos.lastTakeProfitAt = new Date().toISOString();
      pos.lastTakeProfitMultiple = targetM;
      pos.lastKnownBalanceRaw = remain.toString();
      pos.lastKnownPriceUsd = pUsd;
      pos.remainingCostUsd = accounting.remainingCostUsd;
      pos.remainingCostSol = accounting.remainingCostSol;
      pos.realizedPnlUsd = (pos.realizedPnlUsd || 0) + accounting.realizedPnlUsd;
      pos.realizedPnlSol = (pos.realizedPnlSol || 0) + accounting.realizedPnlSol;
      pos.realizedProceedsUsd = (pos.realizedProceedsUsd || 0) + quote.grossUsdValue;
      pos.realizedProceedsSol = (pos.realizedProceedsSol || 0) + proceedsSol;
      pos.lastExitReason = reason;

      if (remain > 0n) {
        ctx.store.upsertPosition(pos);
      } else {
        ctx.store.removePosition(pos.mint);
        const win = (pos.realizedPnlUsd || 0) > 0;
        monitorService.recordTradeResult(ctx, win);
        monitorService.recordClosedTrade(ctx, pos, reason);
        if (win) ctx.store.incrementMetric('profitableTrades');
        if (reason === 'stop-loss') ctx.store.incrementMetric('stopLosses');
        if (reason === 'tp-trailing-max-exit') ctx.store.incrementMetric('trailingExits');
      }

      monitorService.incrementExitReasonMetric(ctx, reason);
      journalPaperTrade(ctx, {
        event: remain > 0n ? 'sell' : 'close',
        mint: pos.mint,
        symbol: pos.symbol,
        priceUsd: pUsd,
        tokenAmount: sellRaw.toString(),
        proceedsUsd: quote.grossUsdValue,
        proceedsSol: proceedsSol,
        realizedPnlUsd: accounting.realizedPnlUsd,
        realizedPnlSol: accounting.realizedPnlSol,
        reason,
        mode: 'paper',
      });
      ctx.logger(
        \`PAPER \${reason} on \${pos.symbol}. SOL out \${atomicToDecimalString(quote.outAmount, 9, 6)}. PnL: \${formatUsd(accounting.realizedPnlUsd)}\`,
        'trade'
      );
      return true;
    }

    const isPanic = [
      'liquidity-exit',
      'stop-loss',
      'early-performance-guard',
      'security-rug-exit',
    ].includes(reason);
    if (ctx.config.dryRun) {
      ctx.logger(\`DRY_RUN would sell \${pos.symbol} for \${reason}.\`, 'trade');
      return false;
    }

    const upBalBefore = await tradingService.getWalletTokenBalance(ctx, pos.mint, PRIORITY.HIGH);
    const actualSellRaw = sellRaw > upBalBefore.rawAmount ? upBalBefore.rawAmount : sellRaw;

    if (actualSellRaw <= 0n) {
      ctx.logger(\`Live exit skipped for \${pos.symbol}: no tokens found.\`, 'warn');
      ctx.store.removePosition(pos.mint);
      return false;
    }

    const solBalanceBefore = await tradingService.getSolBalance(ctx).catch(() => 0n);
    const { signature: sig, order } = await tradingService.executeSwapOrderWithSmartRetry(
      ctx,
      pos.mint,
      SOL_MINT,
      actualSellRaw.toString(),
      isPanic
    );

    await sleep(2000);
    const upBalAfter = await tradingService.getWalletTokenBalance(ctx, pos.mint, PRIORITY.HIGH);

    const solBalanceAfter = await tradingService.getSolBalance(ctx).catch(() => 0n);
    const solPrice = await tradingService.estimateSolUsdPrice(ctx);

    let proceedsSol = Number(atomicToDecimalString(order.outAmount || '0', 9, 9));
    if (solBalanceBefore > 0n && solBalanceAfter > 0n && solBalanceAfter > solBalanceBefore) {
      proceedsSol = Number(atomicToDecimalString(solBalanceAfter - solBalanceBefore, 9, 9));
    }
    const proceedsUsd = proceedsSol * solPrice;
    const acc = monitorService.buildExitAccounting(
      pos,
      actualSellRaw,
      upBalBefore.rawAmount,
      proceedsUsd,
      proceedsSol
    );

    if (reason.startsWith('take-profit')) pos.targetsHit++;
    pos.lastTakeProfitAt = new Date().toISOString();
    pos.lastTakeProfitMultiple = targetM;
    pos.lastKnownBalanceRaw = upBalAfter.rawAmount.toString();
    pos.lastKnownPriceUsd = pUsd;
    pos.remainingCostUsd = acc.remainingCostUsd;
    pos.remainingCostSol = acc.remainingCostSol;
    pos.realizedPnlUsd = (pos.realizedPnlUsd || 0) + acc.realizedPnlUsd;
    pos.realizedPnlSol = (pos.realizedPnlSol || 0) + acc.realizedPnlSol;
    pos.realizedProceedsUsd = (pos.realizedProceedsUsd || 0) + proceedsUsd;
    pos.realizedProceedsSol = (pos.realizedProceedsSol || 0) + proceedsSol;
    pos.lastExitReason = reason;
    pos.lastSellSignature = sig;

    const totalT = Array.isArray(pos.takeProfitMultiples)
      ? pos.takeProfitMultiples.length
      : TAKE_PROFIT_MULTIPLES.length;

    if (pos.targetsHit >= totalT || upBalAfter.rawAmount <= 0n) {
      ctx.store.removePosition(pos.mint);
      const win = (pos.realizedPnlUsd || 0) > 0;
      monitorService.recordTradeResult(ctx, win);
      monitorService.recordClosedTrade(ctx, pos, reason);
      if (win) ctx.store.incrementMetric('profitableTrades');
      if (reason === 'stop-loss') ctx.store.incrementMetric('stopLosses');
      if (reason === 'tp-trailing-max-exit') ctx.store.incrementMetric('trailingExits');
      monitorService.startCoolDown(ctx, pos.mint, pUsd);

      const closeAta = () =>
        tradingService.closeAssociatedTokenAccount(ctx, pos.mint).catch((err: unknown) => {
          ctx.logger(
            \`ATA close failure for \${pos.symbol}: \${err instanceof Error ? err.message : String(err)}\`,
            'debug'
          );
        });
      if (ctx.config.backgroundAtaClose) void closeAta();
      else await closeAta();
    } else {
      ctx.store.upsertPosition(pos);
    }

    monitorService.incrementExitReasonMetric(ctx, reason);
    const pnlUsd = acc.realizedPnlUsd;
    const roi = (pnlUsd / Number(pos.entryUsdValue)) * 100;
    const msg = \`EXIT: \${pos.symbol}\\nReason: \${reason}\\nPrice: \${formatUsd(pUsd)}\\nPnL: \${formatUsd(pnlUsd)} (\${roi.toFixed(2)}%)\`;
    void sendNotification(ctx, msg).catch((err: unknown) => {
      ctx.logger(
        \`Exit notification failed for \${pos.symbol}: \${err instanceof Error ? err.message : String(err)}\`,
        'debug'
      );
    });
    ctx.logger(
      \`Sold \${pos.symbol} for \${reason} at \${formatUsd(pUsd)}. PnL: \${formatUsd(pnlUsd)} (\${roi.toFixed(2)}%). sig: \${sig}\`,
      'trade'
    );

    return true;
  } catch (err: unknown) {
    ctx.logger(
      \`Failed to exit \${pos.symbol} for \${reason}: \${err instanceof Error ? err.message : String(err)}\`,
      'error'
    );
    return false;
  } finally {
    processingMints.delete(pos.mint);
  }
}

export async function sellTakeProfit(
  ctx: Context,
  pos: Position,
  balance: WalletBalance,
  pUsd: number,
  targetM: number
): Promise<boolean> {
  const frac = getTakeProfitFraction(pos, pos.targetsHit || 0);
  const amt = computeTakeProfitSellAmount(balance.rawAmount, frac);
  return monitorService.executePositionExit(
    ctx,
    pos,
    balance,
    pUsd,
    amt,
    \`take-profit-\${targetM}x\`,
    targetM
  );
}

export function startCoolDown(ctx: Context, mint: string, pUsd: number): void {
  const expires = Date.now() + ctx.config.coolDownMinutes * 60000;
  ctx.store.startCoolDown(mint, pUsd, expires);
}
`;

const tradeLoggerTs = `
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
import { journalClosedTrade, bigintRatioToNumber } from '../../core/utils.js';
import { Context, Position, ClosedTrade } from '../../types/index.js';
import { mlService } from '../../ml/ml-service.js';

export function incrementExitReasonMetric(ctx: Context, reason: string): void {
  ctx.store.incrementExitReason(reason);
}

export function buildExitAccounting(
  pos: Position,
  sellRaw: bigint,
  balRaw: bigint,
  proceedsUsd: number,
  proceedsSol: number
): {
  realizedPnlUsd: number;
  realizedPnlSol: number;
  remainingCostUsd: number;
  remainingCostSol: number;
} {
  const ratio = bigintRatioToNumber(sellRaw, balRaw);
  const costSoldUsd = Number(pos.remainingCostUsd || 0) * ratio;
  const costSoldSol = Number(pos.remainingCostSol || 0) * ratio;
  return {
    realizedPnlUsd: proceedsUsd - costSoldUsd,
    realizedPnlSol: proceedsSol - costSoldSol,
    remainingCostUsd: Math.max(0, Number(pos.remainingCostUsd || 0) - costSoldUsd),
    remainingCostSol: Math.max(0, Number(pos.remainingCostSol || 0) - costSoldSol),
  };
}

export function recordTradeResult(ctx: Context, isWin: boolean): void {
  ctx.store.addTradeResult(isWin);
}

export function recordClosedTrade(ctx: Context, pos: Position, reason: string): void {
  const openedAtMs = new Date(pos.openedAt || Date.now()).getTime();
  const trade: ClosedTrade = {
    mint: pos.mint,
    symbol: pos.symbol,
    exitReason: reason,
    realizedPnlUsd: Number(pos.realizedPnlUsd || 0),
    realizedPnlSol: Number(pos.realizedPnlSol || 0),
    realizedProceedsUsd: Number(pos.realizedProceedsUsd || 0),
    realizedProceedsSol: Number(pos.realizedProceedsSol || 0),
    entryUsdValue: Number(pos.entryUsdValue || 0),
    entryPriceUsd: Number(pos.entryPriceUsd || 0),
    entryPriceSol: Number(pos.entryPriceSol || 0),
    highestPriceUsd: Number(pos.highestPriceUsd || pos.entryPriceUsd || 0),
    holdSeconds: Math.max(0, (Date.now() - openedAtMs) / 1000),
    closedAt: new Date().toISOString(),
    entryScore: Number(pos.entryScore || 0),
    tpProfile: pos.tpProfile || null,
    takeProfitMultiples: pos.takeProfitMultiples || null,
    takeProfitFractions: pos.takeProfitFractions || null,
    trailingStopDrawdownPctResolved: Number(pos.trailingStopDrawdownPctResolved || 0),
    maxHoldMinutesResolved: Number(pos.maxHoldMinutesResolved || 0),
    volatilityScaler: Number(pos.volatilityScaler || 0),
    entryLiquidityUsd: Number(pos.entryLiquidityUsd || 0),
    launchpad: pos.launchpad || null,
    targetsHit: Number(pos.targetsHit || 0),
    initialBuyAmountSol: pos.initialBuyAmountSol || null,
  };
  ctx.store.addClosedTrade(trade);
  journalClosedTrade(ctx, trade as unknown as Record<string, unknown>);

  if (process.env.ML_ENABLED === 'true' && pos.mlFeaturesJson) {
    ctx.store.addTrainingSample({
      mint: pos.mint,
      symbol: pos.symbol,
      label: trade.realizedPnlUsd > 0 ? 1 : 0,
      featuresJson: pos.mlFeaturesJson,
      realizedPnlUsd: trade.realizedPnlUsd,
      entryScore: pos.entryScore,
      tpProfile: pos.tpProfile ?? null,
      launchpad: pos.launchpad ?? null,
      closedAt: trade.closedAt,
    });

    if (trade.targetsHit > 0) {
      mlService.runParamOptimizerNow().catch((err: unknown) => {
        ctx.logger(
          \`[ML] TP param optimizer error: \${err instanceof Error ? err.message : String(err)}\`,
          'debug'
        );
      });
    }

    mlService.runEntryTunerNow().catch((err: unknown) => {
      ctx.logger(
        \`[ML] Entry tuner error: \${err instanceof Error ? err.message : String(err)}\`,
        'debug'
      );
    });
  }
}
`;

const rootMonitorTs = `
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
import { formatUsd, ratioToPercentString, runBoundedPool, PRIORITY, computeSpread } from '../../core/utils.js';
import { BURN_OWNERS, TAKE_PROFIT_MULTIPLES, MOMENTUM_FILTERS } from '../../core/config.js';
import { tradingService } from '../trading/trading.service.js';
import { auditService } from '../audit/audit.service.js';
import { Context, Position } from '../../types/index.js';

export * from './exit-calculator.js';
export * from './exit-executor.js';
export * from './trade-logger.js';

import { getTakeProfitPlan, getTakeProfitFraction, computeTakeProfitSellAmount, getMoodAdjustments, getTrailingActivationMultiple } from './exit-calculator.js';
import { executePositionExit, sellTakeProfit, startCoolDown } from './exit-executor.js';
import { incrementExitReasonMetric, buildExitAccounting, recordTradeResult, recordClosedTrade } from './trade-logger.js';

export interface PriceRecord {
  usdPrice?: number;
  liquidity?: number;
  bidPrice?: number;
  askPrice?: number;
}

export async function monitorPositions(
  ctx: Context,
  fetchPricesBestEffort: (
    ctx: Context,
    mints: string[],
    label: string,
    apiKey?: string
  ) => Promise<Record<string, PriceRecord>>
): Promise<void> {
  if (ctx.state.positions.size === 0) return;

  const mints = Array.from(ctx.state.positions.keys());
  const prices = await fetchPricesBestEffort(
    ctx,
    mints,
    'position refresh',
    ctx.config.jupiterPositionApiKey
  );

  await runBoundedPool(
    mints,
    async (mint) => {
      const pos = ctx.state.positions.get(mint);
      if (!pos) return;

      const { processingMints } = await import('./exit-executor.js');
      if (processingMints.has(mint)) return;

      const balance = await tradingService.getWalletTokenBalance(ctx, mint);
      if (balance.rawAmount <= 0n) {
        ctx.logger(\`Position \${pos.symbol} zero balance; removing.\`, 'warn');
        ctx.store.removePosition(mint);
        return;
      }

      const snap = ctx.state.marketSnapshots.get(mint);
      const pRecord = prices[mint];
      const pUsd = Number(pRecord?.usdPrice || snap?.usdPrice || 0);

      if (pRecord?.liquidity != null) {
        pos.lastKnownLiquidityUsd = pRecord.liquidity;
        if (snap) {
          snap.liquidity = pRecord.liquidity;
          snap.usdPrice = pUsd;
          snap.observedAt = new Date().toISOString();
          ctx.store.updateMarketSnapshot(mint, snap);
        }
      } else if (snap?.liquidity != null || snap?.liquidityUsd != null) {
        pos.lastKnownLiquidityUsd = snap.liquidity || snap.liquidityUsd;
      }

      const liquidityExitFloor =
        pos.lastKnownLiquidityUsd != null
          ? Math.max(
              ctx.config.liquidityCollapseThresholdUsd,
              Number(pos.entryLiquidityUsd || 0) * ctx.config.liquidityCollapseThresholdRatio
            )
          : null;

      if (
        liquidityExitFloor != null &&
        pos.lastKnownLiquidityUsd != null &&
        pos.lastKnownLiquidityUsd <= liquidityExitFloor
      ) {
        ctx.logger(
          \`Liquidity collapse detected for \${pos.symbol} ($\${pos.lastKnownLiquidityUsd.toFixed(0)} <= $\${liquidityExitFloor.toFixed(0)}).\`,
          'warn',
          { console: true }
        );
        await monitorService.executePositionExit(
          ctx,
          pos,
          balance,
          pUsd || pos.lastKnownPriceUsd || pos.entryPriceUsd,
          balance.rawAmount,
          'liquidity-exit'
        );
        return;
      }

      if (!(pUsd > 0)) {
        ctx.logger(\`Price unavailable for \${pos.symbol}; skipping price checks.\`, 'debug');
        return;
      }

      pos.highestPriceUsd = Math.max(Number(pos.highestPriceUsd || pos.entryPriceUsd || 0), pUsd);
      pos.lastKnownBalanceRaw = balance.rawAmount.toString();
      pos.lastKnownPriceUsd = pUsd;

      pos.priceHistory = pos.priceHistory || [];
      pos.priceHistory.push({ price: pUsd, timestamp: Date.now() });
      if (
        pRecord &&
        pRecord.bidPrice !== undefined &&
        pRecord.askPrice !== undefined &&
        pRecord.bidPrice > 0 &&
        pRecord.askPrice > 0
      ) {
        pos.spreadHistory = pos.spreadHistory || [];
        pos.spreadHistory.push({
          spread: computeSpread(pRecord.bidPrice, pRecord.askPrice),
          timestamp: Date.now(),
        });
      }

      const cutoff = Date.now() - 60000;
      pos.priceHistory = pos.priceHistory.filter((h) => h.timestamp > cutoff);
      if (pos.spreadHistory) {
        pos.spreadHistory = pos.spreadHistory.filter((h) => h.timestamp > cutoff);
      }

      ctx.store.upsertPosition(pos);

      if (!pos.lastSecurityAuditAt || Date.now() - pos.lastSecurityAuditAt > 30000) {
        pos.lastSecurityAuditAt = Date.now();
        try {
          const signals = await auditService.getMintSignals(ctx, mint, { priority: PRIORITY.LOW });

          if (signals.mintAuthority || signals.freezeAuthority) {
            ctx.logger(
              \`SECURITY ALERT: \${pos.symbol} authorities enabled after buy! Emergency Exit.\`,
              'warn',
              { console: true }
            );
            await monitorService.executePositionExit(
              ctx,
              pos,
              balance,
              pUsd,
              balance.rawAmount,
              'security-rug-exit'
            );
            return;
          }

          const initialHolders = pos.mintSignals?.topAccounts || [];
          if (initialHolders.length > 0) {
            for (const initial of initialHolders) {
              if (!initial.owner || BURN_OWNERS.has(initial.owner)) continue;
              const current = signals.topAccounts.find((a) => a.owner === initial.owner);
              const initialAmt = Number(initial.rawAmount);

              if (current) {
                const currentAmt = Number(current.rawAmount);
                const dropRatio = 1 - currentAmt / initialAmt;
                if (dropRatio > 0.25) {
                  ctx.logger(
                    \`INSIDER ALERT: Top holder \${initial.owner.slice(0, 8)} sold \${(dropRatio * 100).toFixed(1)}%. De-risking 40%.\`,
                    'warn',
                    { console: true }
                  );
                  if (
                    await monitorService.executePositionExit(
                      ctx,
                      pos,
                      balance,
                      pUsd,
                      computeTakeProfitSellAmount(balance.rawAmount, 0.4),
                      'insider-drift-exit'
                    )
                  ) {
                    return; 
                  }
                }
              } else {
                ctx.logger(
                  \`INSIDER ALERT: Top holder \${initial.owner.slice(0, 8)} exited top 5. De-risking 40%.\`,
                  'warn',
                  { console: true }
                );
                if (
                  await monitorService.executePositionExit(
                    ctx,
                    pos,
                    balance,
                    pUsd,
                    computeTakeProfitSellAmount(balance.rawAmount, 0.4),
                    'insider-drift-exit'
                  )
                ) {
                  return;
                }
              }
            }
          }
        } catch (err: unknown) {
          ctx.logger(
            \`Re-audit failed for \${pos.symbol}: \${err instanceof Error ? err.message : String(err)}\`,
            'debug'
          );
        }
      }

      const ageSec = (Date.now() - new Date(pos.openedAt).getTime()) / 1000;
      const multiples =
        Array.isArray(pos.takeProfitMultiples) && pos.takeProfitMultiples.length > 0
          ? pos.takeProfitMultiples
          : TAKE_PROFIT_MULTIPLES;

      if (pos.minTpArmed && pos.targetsHit! < multiples.length) {
        const nextM = multiples[pos.targetsHit!]!;
        const minTpM = 1 + 0.5 * (nextM - 1);
        const minTpP = pos.entryPriceUsd * minTpM;
        if (pUsd < minTpP) {
          ctx.logger(
            \`Price fell back to midpoint \${formatUsd(minTpP)} for \${pos.symbol} (Target \${pos.targetsHit! + 1}). Midpoint exit.\`,
            'trade'
          );
          await monitorService.executePositionExit(
            ctx,
            pos,
            balance,
            pUsd,
            balance.rawAmount,
            'adaptive-tp-exit'
          );
          return;
        }
      }

      if (ageSec <= ctx.config.earlyPerformanceGuardSeconds && pos.targetsHit === 0) {
        const drop = (pos.entryPriceUsd - pUsd) / pos.entryPriceUsd;
        const buyCollapse =
          Array.isArray(pos.tapeHistory) &&
          pos.tapeHistory.length >= 2 &&
          (pos.tapeHistory[pos.tapeHistory.length - 1]?.buys ?? 0) -
            (pos.tapeHistory[pos.tapeHistory.length - 2]?.buys ?? 0) ===
            0;

        if (drop > ctx.config.earlyPerformanceDropPct / 100 || buyCollapse) {
          ctx.logger(
            \`Early Guard for \${pos.symbol}: drop \${(drop * 100).toFixed(1)}% or buy collapse. Partial exit.\`,
            'warn',
            { console: true }
          );
          await monitorService.executePositionExit(
            ctx,
            pos,
            balance,
            pUsd,
            computeTakeProfitSellAmount(
              balance.rawAmount,
              ctx.config.earlyPerformanceSellPct / 100
            ),
            'early-performance-guard'
          );
          return;
        }
      }

      const baseSlPct = ctx.config.stopLossPct;
      const adjustedSlPct = baseSlPct * (1 + (pos.volatilityScaler || 0));
      const slP = pos.entryPriceUsd * (1 - adjustedSlPct);
      const slWP = pos.entryPriceUsd * (1 - adjustedSlPct / 2);

      if (pUsd <= slWP && !pos.stopLossWarningSent) {
        pos.stopLossWarningSent = true;
        ctx.logger(
          \`WARNING: \${pos.symbol} half-SL touched. Drawdown: \${((1 - pUsd / pos.entryPriceUsd) * 100).toFixed(2)}%.\`,
          'warn',
          { console: true }
        );
        ctx.store.upsertPosition(pos);
      }

      if (pUsd <= slP) {
        ctx.logger(\`STOP LOSS hit for \${pos.symbol} at \${formatUsd(pUsd)}.\`, 'trade');
        await monitorService.executePositionExit(
          ctx,
          pos,
          balance,
          pUsd,
          balance.rawAmount,
          'stop-loss'
        );
        return;
      }

      if (!pos.trailingArmed) {
        pos.trailingArmed = true;
        ctx.store.upsertPosition(pos);
      }

      if (ageSec < ctx.config.minHoldTimeSeconds) return;

      if (
        ageSec > ctx.config.performanceCheckSeconds &&
        pos.targetsHit === 0 &&
        pUsd < pos.entryPriceUsd * ctx.config.performanceMinMomentum
      ) {
        ctx.logger(\`No early performance for \${pos.symbol}; exiting.\`, 'trade');
        await monitorService.executePositionExit(
          ctx,
          pos,
          balance,
          pUsd,
          balance.rawAmount,
          'no-early-performance'
        );
        return;
      }

      let trailingDrawdownPct = Number(
        pos.trailingStopDrawdownPctResolved || ctx.config.trailingStopDrawdownPct || 0.2
      );
      const currentMultiple = pUsd / pos.entryPriceUsd;

      if (currentMultiple > 1.8) {
        const acceleration = Math.min(0.12, (currentMultiple - 1.8) * 0.04);
        trailingDrawdownPct = Math.max(0.04, trailingDrawdownPct - acceleration);
      }

      const trailP = (pos.highestPriceUsd || pUsd) * (1 - trailingDrawdownPct);
      if (pUsd < trailP) {
        ctx.logger(
          \`Trailing Stop hit for \${pos.symbol}: price \${formatUsd(pUsd)} < \${ratioToPercentString(1 - trailingDrawdownPct)} of peak (\${formatUsd(pos.highestPriceUsd)}).\`,
          'trade'
        );
        await monitorService.executePositionExit(
          ctx,
          pos,
          balance,
          pUsd,
          balance.rawAmount,
          'tp-trailing-max-exit'
        );
        return;
      }

      if (Array.isArray(pos.spreadHistory) && pos.spreadHistory.length >= 2) {
        const last = pos.spreadHistory[pos.spreadHistory.length - 1]!;
        const prev = pos.spreadHistory[pos.spreadHistory.length - 2]!;
        const timeDiff = (last.timestamp - prev.timestamp) / 1000;
        if (timeDiff <= 15 && prev.spread > 0) {
          const spreadIncrease = last.spread / prev.spread - 1;
          if (spreadIncrease > 0.5) {
            ctx.logger(
              \`SPREAD VELOCITY: Widened \${(spreadIncrease * 100).toFixed(1)}% for \${pos.symbol}. Rug risk.\`,
              'warn',
              { console: true }
            );
            await monitorService.executePositionExit(
              ctx,
              pos,
              balance,
              pUsd,
              balance.rawAmount,
              'spread-velocity-exit'
            );
            return;
          }
        }
      }

      const ageMin = ageSec / 60;
      const maxHoldMinutesResolved = Number(
        pos.maxHoldMinutesResolved || ctx.config.maxHoldMinutes || 20
      );
      if (
        ageMin >= maxHoldMinutesResolved &&
        pUsd < pos.entryPriceUsd * ctx.config.timeExitMinMultiple
      ) {
        ctx.logger(
          \`Max hold time reached for \${pos.symbol} (\${ageMin.toFixed(1)}m); exiting.\`,
          'trade'
        );
        await monitorService.executePositionExit(
          ctx,
          pos,
          balance,
          pUsd,
          balance.rawAmount,
          'time-exit'
        );
        return;
      }

      while (pos.targetsHit! < multiples.length) {
        const nextM = multiples[pos.targetsHit!]!;
        const targetP = pos.entryPriceUsd * nextM;
        const minTpM = 1 + 0.5 * (nextM - 1);
        const minTpP = pos.entryPriceUsd * minTpM;

        if (pUsd >= minTpP && !pos.minTpArmed) {
          pos.minTpReached = true;
          pos.minTpArmed = true;
          ctx.logger(
            \`Midpoint Profit Guard ARMED for \${pos.symbol} (Target \${pos.targetsHit! + 1}).\`,
            'info'
          );
          ctx.store.upsertPosition(pos);
        }

        if (pUsd < targetP) break;

        const freshBalance = await tradingService.getWalletTokenBalance(
          ctx,
          pos.mint,
          PRIORITY.HIGH
        );
        if (await monitorService.sellTakeProfit(ctx, pos, freshBalance, pUsd, nextM)) {
          pos.minTpReached = false;
          pos.minTpArmed = false;
          ctx.store.upsertPosition(pos);
        } else {
          break;
        }
      }
    },
    { concurrency: ctx.config.scanParallelismLight || 5 }
  );
}

export async function closeAllOpenPositions(
  ctx: Context,
  fetchPricesBestEffort: (
    ctx: Context,
    mints: string[],
    label: string,
    apiKey?: string
  ) => Promise<Record<string, PriceRecord>>,
  reason = 'shutdown-exit'
): Promise<void> {
  const mints = Array.from(ctx.state.positions.keys());
  if (mints.length === 0) {
    ctx.logger('No positions to close.');
    return;
  }

  ctx.logger(\`Closing \${mints.length} positions for shutdown...\`, 'warn', { console: true });
  const prices = await fetchPricesBestEffort(
    ctx,
    mints,
    'shutdown exit',
    ctx.config.jupiterPositionApiKey
  );

  for (const mint of mints) {
    const pos = ctx.state.positions.get(mint);
    if (!pos) continue;
    try {
      const bal = await tradingService.getWalletTokenBalance(ctx, mint, PRIORITY.HIGH);
      if (bal.rawAmount <= 0n) {
        ctx.store.removePosition(mint);
        continue;
      }
      const p = Number(prices[mint]?.usdPrice || pos.lastKnownPriceUsd || pos.entryPriceUsd || 0);
      await monitorService.executePositionExit(ctx, pos, bal, p, bal.rawAmount, reason);
    } catch (e: unknown) {
      ctx.logger(
        \`Failed to close \${pos.symbol || mint}: \${e instanceof Error ? e.message : String(e)}\`,
        'error',
        { console: true }
      );
    }
  }
}

export const monitorService = {
  incrementExitReasonMetric,
  executePositionExit,
  sellTakeProfit,
  buildExitAccounting,
  getTakeProfitPlan,
  getTakeProfitFraction,
  computeTakeProfitSellAmount,
  getMoodAdjustments,
  recordTradeResult,
  recordClosedTrade,
  startCoolDown,
  monitorPositions,
  closeAllOpenPositions,
};
`;

fs.writeFileSync('src/services/monitor/exit-calculator.ts', exitCalculatorTs, 'utf8');
fs.writeFileSync('src/services/monitor/exit-executor.ts', exitExecutorTs, 'utf8');
fs.writeFileSync('src/services/monitor/trade-logger.ts', tradeLoggerTs, 'utf8');
fs.writeFileSync('src/services/monitor/monitor.service.ts', rootMonitorTs, 'utf8');

console.log('Successfully split monitor.service.ts');
