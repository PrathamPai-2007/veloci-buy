import {
  sleep,
  utilService,
  atomicToDecimalString,
  decimalToAtomic,
  formatUsd,
  safeJsonStringify,
  sendNotification,
  journalPaperTrade,
  PRIORITY,
  rpcCall,
} from '../core/utils.js';
import fs from 'node:fs';
import path from 'node:path';
import { SOL_MINT } from '../core/config.js';
import * as trading from './trading/trading.service.js';
import * as monitor from './monitor/monitor.service.js';
import { getBurstTakeProfitPlan } from './burst/index.js';
import { portfolioService } from './trading/portfolio.service.js';
import {
  Context,
  Config,
  Position,
  SwapOrder,
  EvaluationResult,
  TransactionData,
} from '../types/index.js';

/**
 * Resolves the configured buy amount in lamports.
 * Supports both direct lamport value and SOL decimal text.
 * @param config - The application configuration.
 * @returns Atomic lamport amount as string.
 */
function resolveBuyAmountLamports(config: Config): string {
  if (config.buyAmountLamports !== undefined && config.buyAmountLamports !== null) {
    return String(config.buyAmountLamports);
  }
  if (config.buyAmountSolText !== undefined && config.buyAmountSolText !== null) {
    return decimalToAtomic(String(config.buyAmountSolText), 9);
  }
  throw new Error('Missing buy amount configuration.');
}

/**
 * Computes the reserved moon-bag tranche (raw token units) from the initial token amount.
 * Returns undefined when the moon bag is disabled (fraction <= 0) or for burst entries, so no
 * runner is reserved. Burst scalps exit on their own tight trailing; a wide-trailing runner
 * would conflict with that strategy.
 */
function computeMoonBagRaw(
  ctx: Context,
  initialTokenAmountRaw: bigint,
  entryProfile?: string
): string | undefined {
  if (entryProfile === 'burst') return undefined;
  const fraction = ctx.config.moonBagFraction;
  if (!(fraction > 0)) return undefined;
  return monitor.computeTakeProfitSellAmount(initialTokenAmountRaw, fraction).toString();
}
/**
 * Evaluates a candidate and executes a buy order if approved.
 * Supports Paper, Dry-Run, and Live trading modes.
 * @param ctx - The application context.
 * @param evaluation - The audit evaluation result.
 * @param prefetchedQuotePromise - Optional promise of a pre-fetched quote to minimize latency.
 */
export async function buyCandidate(
  ctx: Context,
  evaluation: EvaluationResult,
  prefetchedQuotePromise: Promise<SwapOrder | null> | null = null
): Promise<Position | null> {
  ctx.store.incrementMetric('buyAttempts');
  const { token, candidateScore } = evaluation;
  const decimals = Number(token.decimals || 6);

  const tpPlan =
    evaluation.entryProfile === 'burst'
      ? getBurstTakeProfitPlan(ctx)
      : evaluation.tpProfileOverride
        ? monitor.getTakeProfitPlanByProfile(ctx, evaluation.tpProfileOverride)
        : monitor.getTakeProfitPlan(ctx, candidateScore);
  const mood = monitor.getMoodAdjustments(ctx);

  if (mood.isPaused) {
    ctx.logger(`Buy skipped for ${token.symbol}: Mood Paused.`, 'warn');
    return null;
  }

  try {
    const baseBuyLamports = BigInt(resolveBuyAmountLamports(ctx.config));
    const adjustedBuySize = portfolioService.getAdjustedBuySize(ctx, baseBuyLamports);

    // Kelly-fraction sizing: scale stake by ML confidence when KELLY_ENABLED=true,
    // model is trained (not shadow mode), and enough real trades have accumulated.
    const mlScore = evaluation.mlScore;
    const kellyStats =
      ctx.config.kellyEnabled && mlScore != null && !mlScore.shadowMode
        ? portfolioService.getWinLossStats(ctx, 50)
        : { count: 0, avgWinUsd: 1, avgLossUsd: 1 };
    const { count: kellyTradeCount, avgWinUsd, avgLossUsd } = kellyStats;
    const useKelly =
      ctx.config.kellyEnabled &&
      mlScore != null &&
      !mlScore.shadowMode &&
      kellyTradeCount >= ctx.config.kellyMinTrades;

    const kellyMult = useKelly
      ? portfolioService.kellyMultiplier(
          mlScore!.confidence,
          avgWinUsd,
          avgLossUsd,
          ctx.config.maxKellyFraction
        )
      : 1.0;

    if (useKelly) {
      ctx.logger(
        `[Kelly] ${token.symbol}: conf=${mlScore!.confidence.toFixed(3)} b=${(avgWinUsd / Math.max(avgLossUsd, 1e-6)).toFixed(2)} mult=${kellyMult.toFixed(3)}×`,
        'debug'
      );
    }

    const buyLamports =
      (adjustedBuySize * BigInt(Math.round(mood.sizeMultiplier * kellyMult * 1000))) / 1000n;
    const buySolText = atomicToDecimalString(buyLamports, 9, 6);

    // Buy/liquidity fraction guard. Runs at execution time (past the latency-critical snipe
    // decision) and reads the cached SOL price (10s TTL) -- no new network round-trip on the hot
    // path. Buying a large fraction of a thin pool means terrible fills and an inability to exit;
    // the only paper-trading grower had ~$7k liquidity vs $2-4k on the losers.
    const entryLiquidityUsd = Number(token.liquidity || 0);
    if (entryLiquidityUsd > 0 && ctx.config.maxBuyLiquidityFraction > 0) {
      const solPrice = await trading.tradingService.estimateSolUsdPrice(ctx);
      const buySol = Number(atomicToDecimalString(buyLamports, 9, 9));
      const buyUsd = buySol * solPrice;
      const liquidityFraction = buyUsd / entryLiquidityUsd;
      if (liquidityFraction > ctx.config.maxBuyLiquidityFraction) {
        ctx.store.incrementMetric('buyRejectedThinLiquidity');
        ctx.logger(
          `Buy skipped for ${token.symbol}: size ${formatUsd(buyUsd)} is ${(liquidityFraction * 100).toFixed(1)}% of liquidity ${formatUsd(entryLiquidityUsd)} (max ${(ctx.config.maxBuyLiquidityFraction * 100).toFixed(0)}%).`,
          'warn',
          { console: true }
        );
        return null;
      }
    }

    if (ctx.config.dryRun && !ctx.config.paperTrading) {
      await trading.tradingService.getWalletTokenBalance(ctx, token.id, PRIORITY.HIGH);
      ctx.logger(`DRY_RUN would buy ${token.symbol} for ${buySolText} SOL.`, 'trade');
      return null;
    }

    const position = ctx.config.paperTrading
      ? await executePaperBuy(ctx, evaluation, buyLamports, buySolText, decimals, tpPlan)
      : await executeLiveBuy(
          ctx,
          evaluation,
          buyLamports,
          buySolText,
          decimals,
          tpPlan,
          prefetchedQuotePromise
        );

    // Reset the trade-starvation clock so the adaptive entry floor tightens back up.
    if (position) ctx.store.markBuyExecuted();

    return position;
  } catch (e: unknown) {
    ctx.store.incrementMetric('buyFailures');
    const errMsg = e instanceof Error ? e.message : String(e);
    ctx.logger(`Buy failed for ${token.symbol || token.id}: ${errMsg}`, 'error');
    // Cooldown on zero-delta or missing bonding curve: token is broken/graduated.
    // Prevents re-attempting the same mint for 2 minutes instead of hitting it every scan cycle.
    if (errMsg.includes('zero delta') || errMsg.includes('Bonding curve account not found')) {
      ctx.store.startCoolDown(token.id, 0, Date.now() + 2 * 60_000);
    }
    return null;
  }
}

/**
 * Executes a simulated buy in Paper Trading mode.
 */
async function executePaperBuy(
  ctx: Context,
  evaluation: EvaluationResult,
  buyLamports: bigint,
  buySolText: string,
  decimals: number,
  tpPlan: monitor.TakeProfitPlan
): Promise<Position | null> {
  const { token, candidateScore } = evaluation;
  if (BigInt(ctx.state.paperSolBalanceLamports) < buyLamports) {
    ctx.logger(`Paper wallet insufficient SOL.`, 'warn');
    return null;
  }

  const quote = await trading.buildPaperBuyQuote(ctx, token, decimals, buyLamports);
  // Balance deducted before position construction: the object literal below is synchronous
  // with no throw paths, so this ordering is safe and ensures the debit is visible to
  // concurrent callers even if the position write is delayed.
  ctx.store.updatePaperSolBalance(BigInt(ctx.state.paperSolBalanceLamports) - buyLamports);

  const pos: Position = {
    mint: token.id,
    symbol: token.symbol,
    name: token.name,
    decimals,
    openedAt: new Date().toISOString(),
    mode: 'paper',
    entryPriceUsd: quote.entryPriceUsd,
    entryPriceSol: quote.entryPriceUsd / quote.solPrice,
    entryUsdValue: quote.entryUsdValue,
    initialBuyAmountSol: buySolText,
    initialBuyAmountLamports: buyLamports.toString(),
    initialTokenAmountRaw: quote.outAmount.toString(),
    moonBagRaw: computeMoonBagRaw(ctx, quote.outAmount, evaluation.entryProfile),
    targetsHit: 0,
    tpProfile: tpPlan.profileId,
    takeProfitMultiples: tpPlan.takeProfitMultiples,
    takeProfitFractions: tpPlan.takeProfitFractions,
    highGrowthConfidence: tpPlan.isHighGrowthConfidence,
    trailingStopDrawdownPctResolved: tpPlan.trailingStopDrawdownPct,
    maxHoldMinutesResolved: tpPlan.maxHoldMinutesResolved,
    lastKnownBalanceRaw: quote.outAmount.toString(),
    lastKnownPriceUsd: Number(token.usdPrice || 0),
    highestPriceUsd: quote.entryPriceUsd,
    partiallyClosed: false,
    remainingCostUsd: quote.entryUsdValue,
    remainingCostSol: Number(atomicToDecimalString(buyLamports, 9, 9)),
    realizedPnlUsd: 0,
    realizedPnlSol: 0,
    realizedProceedsUsd: 0,
    realizedProceedsSol: 0,
    entryLiquidityUsd: Number(token.liquidity || 0),
    entryMarketCapUsd: token.fdvUsd ?? token.marketCapUsd,
    volatilityScaler: evaluation.volatilityScaler || 0,
    launchpad: token.launchpad || null,
    entryScore: candidateScore,
    paperEntryQuoteOutAmount: quote.outAmount.toString(),
    minTpReached: false,
    minTpArmed: false,
    trailingArmed: false,
    mintSignals: evaluation.mintSignals,
    securitySignals: {
      rugCheck: evaluation.rugCheckSignals || null,
      bubbleMaps: evaluation.bubbleMapsSignals || null,
    },
    marketData: {
      price: token.usdPrice,
      liquidity: token.liquidity,
      volume24h: token.volume24h,
      buyPressure: token.buyPressure,
      sellPressure: token.sellPressure,
    },
    mlFeaturesJson: evaluation.mlFeaturesJson,
    entryProfile: evaluation.entryProfile || 'standard',
    burstEntryMomentum: evaluation.burstEntryMomentum,
    burstBuySellRatio: evaluation.burstBuySellRatio,
    burstTrailingDrawdownPct: evaluation.burstTrailingDrawdownPct,
    entryConfidence: evaluation.mlScore?.confidence ?? 0.5,
  };

  ctx.store.upsertPosition(pos);
  if (
    ctx.subscribeToVaultBalances &&
    (token.launchpad === 'raydium' || token.launchpad === 'meteora')
  ) {
    const poolAddress = ctx.state.mintToPool.get(token.id);
    if (poolAddress) {
      ctx
        .subscribeToVaultBalances(token.id, poolAddress, token.launchpad as 'raydium' | 'meteora')
        .catch(() => {});
    }
  }
  void logTradeToFile(ctx, 'trades.jsonl', pos);
  journalPaperTrade(ctx, {
    event: 'buy',
    mint: token.id,
    symbol: token.symbol,
    priceUsd: quote.entryPriceUsd,
    solAmount: buySolText,
    tokenAmount: quote.outAmount.toString(),
    mode: 'paper',
  });

  ctx.logger(
    `PAPER buy ${token.symbol} (score ${candidateScore}). [PAPER SOL: ${atomicToDecimalString(ctx.state.paperSolBalanceLamports, 9, 4)}]`,
    'trade'
  );
  return pos;
}

/**
 * Executes a real buy on the Solana mainnet.
 */
async function executeLiveBuy(
  ctx: Context,
  evaluation: EvaluationResult,
  buyLamports: bigint,
  buySolText: string,
  decimals: number,
  tpPlan: monitor.TakeProfitPlan,
  prefetchedQuotePromise: Promise<SwapOrder | null> | null
): Promise<Position | null> {
  const { token, candidateScore } = evaluation;
  const solPricePromise = trading.tradingService.estimateSolUsdPrice(ctx);
  const beforeBalancePromise = trading.tradingService.getWalletTokenBalance(
    ctx,
    token.id,
    PRIORITY.HIGH
  );

  const prefetchedResult = prefetchedQuotePromise ? await prefetchedQuotePromise : null;
  const initialOrder = prefetchedResult?.transaction ? prefetchedResult : null;
  const beforeBalance = await beforeBalancePromise;
  const solPrice = await solPricePromise;

  let sig: string;
  let received: bigint;
  let entryUsdValue: number;
  let entrySolValue: number;
  let afterBalance = beforeBalance;

  if (beforeBalance.rawAmount > 0n) {
    ctx.logger(
      `[Reconciliation] Wallet already holds ${beforeBalance.rawAmount} tokens of ${token.symbol}. Skipping buy swap and recovering existing position.`,
      'info'
    );
    sig = 'reconciled';
    received = beforeBalance.rawAmount;

    entryUsdValue = Number(atomicToDecimalString(buyLamports, 9, 9)) * solPrice;
    entrySolValue =
      entryUsdValue > 0
        ? entryUsdValue / solPrice
        : Number(atomicToDecimalString(buyLamports, 9, 9));
  } else {
    // Probabilistic MEV tip inputs: scale by ML conviction and cap by expected
    // profit (EV = pWin·firstTPgain − pLoss·stopLoss, on the SOL notional).
    const confidence = evaluation.mlScore?.confidence ?? 0.5;
    const tp0 = ctx.config.takeProfitMultiples[0] ?? 1.3;
    const evFraction = confidence * (tp0 - 1) - (1 - confidence) * ctx.config.stopLossPct;
    const expectedValueLamports =
      evFraction > 0 ? BigInt(Math.round(Number(buyLamports) * evFraction)) : 0n;

    const swapResult = await trading.tradingService.executeSwapOrderWithSmartRetry(
      ctx,
      SOL_MINT,
      token.id,
      buyLamports.toString(),
      false,
      initialOrder,
      { confidence, expectedValueLamports }
    );
    sig = swapResult.signature;
    const order = swapResult.order;

    // Poll for balance update to confirm transaction finality and get exact received amount
    for (let i = 0; i < 6; i++) {
      await sleep(1000 + i * 500);
      afterBalance = await trading.tradingService.getWalletTokenBalance(
        ctx,
        token.id,
        PRIORITY.HIGH
      );
      if (afterBalance.rawAmount > beforeBalance.rawAmount) break;
    }

    // Balance poll missed it — read postTokenBalances directly from confirmed tx.
    if (afterBalance.rawAmount <= beforeBalance.rawAmount) {
      const walletAddr = await trading.tradingService.getWalletAddress(ctx);
      const txData = (await rpcCall(
        ctx,
        'getTransaction',
        [
          sig as any, // eslint-disable-line @typescript-eslint/no-explicit-any
          {
            commitment: 'confirmed',
            encoding: 'jsonParsed' as any, // eslint-disable-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
            maxSupportedTransactionVersion: 0,
          },
        ],
        { priority: PRIORITY.HIGH }
      ).catch((e: unknown) => {
        ctx.logger(
          `getTransaction fallback failed for ${sig}: ${e instanceof Error ? e.message : String(e)}`,
          'warn'
        );
        return null;
      })) as unknown as TransactionData | null;
      if (txData?.meta) {
        const post = txData.meta.postTokenBalances?.find(
          (b) => b.mint === token.id && b.owner === walletAddr
        );
        const pre = txData.meta.preTokenBalances?.find(
          (b) => b.mint === token.id && b.owner === walletAddr
        );
        const postAmt = BigInt(post?.uiTokenAmount?.amount ?? '0');
        const preAmt = BigInt(pre?.uiTokenAmount?.amount ?? '0');
        if (postAmt > preAmt) {
          // Use beforeBalance as the anchor so received = postAmt - preAmt regardless
          // of any concurrent transfer between the pre-balance poll and swap execution.
          afterBalance = {
            ...afterBalance,
            rawAmount: beforeBalance.rawAmount + (postAmt - preAmt),
            decimals: Number(post?.uiTokenAmount?.decimals ?? afterBalance.decimals),
          };
        }
      }
    }

    // Both polling and getTransaction failed; fall back to outAmount to prevent orphaned position
    if (afterBalance.rawAmount <= beforeBalance.rawAmount) {
      const outAmountRaw = BigInt(order.outAmount || '0');
      if (outAmountRaw > 0n) {
        afterBalance = { ...afterBalance, rawAmount: beforeBalance.rawAmount + outAmountRaw };
      }
    }

    entryUsdValue =
      Number(order.inUsdValue || 0) > 0
        ? Number(order.inUsdValue)
        : Number(atomicToDecimalString(buyLamports, 9, 9)) * solPrice;
    entrySolValue =
      entryUsdValue > 0
        ? entryUsdValue / solPrice
        : Number(atomicToDecimalString(buyLamports, 9, 9));

    received =
      afterBalance.rawAmount - beforeBalance.rawAmount > 0n
        ? afterBalance.rawAmount - beforeBalance.rawAmount
        : BigInt(order.outAmount || '0');
    if (received <= 0n) throw new Error(`Buy confirmation failed (zero delta) for ${sig}`);
  }

  const actualDecimals = afterBalance.decimals || decimals;
  const units = Number(atomicToDecimalString(received, actualDecimals, 9));
  const entryPriceUsd = units > 0 ? entryUsdValue / units : Number(token.usdPrice || 0);

  const pos: Position = {
    mint: token.id,
    symbol: token.symbol,
    name: token.name,
    decimals: actualDecimals,
    openedAt: new Date().toISOString(),
    mode: 'live',
    entryPriceUsd,
    entryPriceSol: entryPriceUsd / solPrice,
    entryUsdValue,
    initialBuyAmountSol: buySolText,
    initialBuyAmountLamports: buyLamports.toString(),
    initialTokenAmountRaw: received.toString(),
    moonBagRaw: computeMoonBagRaw(ctx, received, evaluation.entryProfile),
    targetsHit: 0,
    tpProfile: tpPlan.profileId,
    takeProfitMultiples: tpPlan.takeProfitMultiples,
    takeProfitFractions: tpPlan.takeProfitFractions,
    highGrowthConfidence: tpPlan.isHighGrowthConfidence,
    trailingStopDrawdownPctResolved: tpPlan.trailingStopDrawdownPct,
    maxHoldMinutesResolved: tpPlan.maxHoldMinutesResolved,
    lastKnownBalanceRaw: afterBalance.rawAmount.toString(),
    lastKnownPriceUsd: entryPriceUsd,
    highestPriceUsd: entryPriceUsd,
    partiallyClosed: false,
    remainingCostUsd: entryUsdValue,
    remainingCostSol: entrySolValue,
    realizedPnlUsd: 0,
    realizedPnlSol: 0,
    realizedProceedsUsd: 0,
    realizedProceedsSol: 0,
    entryLiquidityUsd: Number(token.liquidity || 0),
    entryMarketCapUsd: token.fdvUsd ?? token.marketCapUsd,
    volatilityScaler: evaluation.volatilityScaler || 0,
    launchpad: token.launchpad || null,
    entryScore: candidateScore,
    buySignature: sig,
    minTpReached: false,
    minTpArmed: false,
    trailingArmed: false,
    mintSignals: evaluation.mintSignals,
    securitySignals: {
      rugCheck: evaluation.rugCheckSignals || null,
      bubbleMaps: evaluation.bubbleMapsSignals || null,
    },
    marketData: {
      price: token.usdPrice,
      liquidity: token.liquidity,
      volume24h: token.volume24h,
      buyPressure: token.buyPressure,
      sellPressure: token.sellPressure,
    },
    mlFeaturesJson: evaluation.mlFeaturesJson,
    entryProfile: evaluation.entryProfile || 'standard',
    burstEntryMomentum: evaluation.burstEntryMomentum,
    burstBuySellRatio: evaluation.burstBuySellRatio,
    burstTrailingDrawdownPct: evaluation.burstTrailingDrawdownPct,
    entryConfidence: evaluation.mlScore?.confidence ?? 0.5,
  };

  ctx.store.upsertPosition(pos);
  if (
    ctx.subscribeToVaultBalances &&
    (token.launchpad === 'raydium' || token.launchpad === 'meteora')
  ) {
    const poolAddress = ctx.state.mintToPool.get(token.id);
    if (poolAddress) {
      ctx
        .subscribeToVaultBalances(token.id, poolAddress, token.launchpad as 'raydium' | 'meteora')
        .catch(() => {});
    }
  }
  void logTradeToFile(ctx, 'stats.json', pos, true);

  const msg = `BUY: ${token.symbol}\nScore: ${candidateScore}\nAmount: ${buySolText} SOL\nPrice: ${formatUsd(entryPriceUsd)}`;
  void sendNotification(ctx, msg).catch((err: unknown) => {
    ctx.logger(
      `Buy notification failed for ${token.symbol}: ${err instanceof Error ? err.message : String(err)}`,
      'debug'
    );
  });

  ctx.logger(
    `Bought ${token.symbol} for ${buySolText} SOL. Entry ${formatUsd(entryPriceUsd)} in tx ${sig}.`,
    'trade'
  );
  return pos;
}

/**
 * Logs trade data to a file.
 */
async function logTradeToFile(
  ctx: Context,
  fileName: string,
  data: unknown,
  atomic = false
): Promise<void> {
  const logDir = path.dirname(ctx.config.logFile);
  const filePath = path.join(logDir, fileName);
  try {
    if (atomic) {
      await utilService.atomicWriteFile(filePath, safeJsonStringify(data, 2));
    } else {
      await fs.promises.appendFile(filePath, safeJsonStringify(data) + '\n');
    }
  } catch (err: unknown) {
    ctx.logger(
      `Failed to log to ${fileName}: ${err instanceof Error ? err.message : String(err)}`,
      'error'
    );
  }
}
