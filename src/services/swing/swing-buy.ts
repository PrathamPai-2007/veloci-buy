import {
  sleep,
  atomicToDecimalString,
  formatUsd,
  sendNotification,
  PRIORITY,
} from '#core/utils.js';
import { SOL_MINT } from '#core/config.js';
import { tradingService } from '../trading/trading.service.js';
import { Context, Position, SwingEvaluationResult } from '#types/index.js';

/**
 * Executes a buy order for an approved swing candidate.
 *
 * Creates a Position tagged entryProfile:'swing' with the swing-specific TP ladder,
 * trailing stop, and hold ceiling. Uses the swing Jupiter API key for swap execution
 * by injecting it into a shallow copy of the context config.
 *
 * After a successful buy the mint is removed from the swing watchlist.
 */
export async function buySwingCandidate(
  ctx: Context,
  evaluation: SwingEvaluationResult
): Promise<Position | null> {
  const { item } = evaluation;
  const { config } = ctx;

  ctx.store.incrementMetric('buyAttempts');

  // Inject the swing-specific Jupiter API key so the swap executor uses it.
  // swingCtx is a shallow copy — store, state, wallet, etc. are all the same references.
  const swingCtx: Context = {
    ...ctx,
    config: { ...config, jupiterApiKey: config.swingJupiterApiKey },
  };

  const buyLamports = config.swingBuyAmountLamports;
  const buySolText = atomicToDecimalString(buyLamports, 9, 6);

  try {
    if (config.dryRun && !config.paperTrading) {
      ctx.logger(
        `SWING DRY_RUN would buy ${item.symbol} for ${buySolText} SOL (score=${evaluation.score}).`,
        'trade'
      );
      return null;
    }

    const position = config.paperTrading
      ? await executeSwingPaperBuy(ctx, evaluation, buyLamports, buySolText)
      : await executeSwingLiveBuy(swingCtx, evaluation, buyLamports, buySolText);

    if (position) {
      ctx.store.markBuyExecuted();
      ctx.state.swingWatchlist.delete(item.mint);
    }

    return position;
  } catch (e: unknown) {
    ctx.store.incrementMetric('buyFailures');
    ctx.logger(
      `Swing buy failed for ${item.symbol}: ${e instanceof Error ? e.message : String(e)}`,
      'error'
    );
    return null;
  }
}

async function executeSwingPaperBuy(
  ctx: Context,
  evaluation: SwingEvaluationResult,
  buyLamports: bigint,
  buySolText: string
): Promise<Position | null> {
  const { item, score } = evaluation;

  if (BigInt(ctx.state.paperSolBalanceLamports) < buyLamports) {
    ctx.logger('Swing: paper wallet insufficient SOL.', 'warn');
    return null;
  }

  const fakeToken = {
    id: item.mint,
    symbol: item.symbol,
    name: item.name,
    decimals: item.decimals,
    usdPrice: item.lastKnownPrice,
    liquidity: item.lastKnownLiquidity,
  };

  const quote = await tradingService.buildPaperBuyQuote(ctx, fakeToken, item.decimals, buyLamports);
  ctx.store.updatePaperSolBalance(BigInt(ctx.state.paperSolBalanceLamports) - buyLamports);

  const pos = buildSwingPosition(ctx, evaluation, quote.outAmount, buySolText, buyLamports, {
    mode: 'paper',
    entryPriceUsd: quote.entryPriceUsd,
    entryUsdValue: quote.entryUsdValue,
    entryPriceSol: quote.entryPriceUsd / quote.solPrice,
    entrySolValue: Number(atomicToDecimalString(buyLamports, 9, 9)),
  });

  ctx.store.upsertPosition(pos);
  ctx.logger(
    `SWING PAPER buy ${item.symbol} (score=${score}) for ${buySolText} SOL @ ${formatUsd(quote.entryPriceUsd)}.`,
    'trade',
    { console: true }
  );
  return pos;
}

async function executeSwingLiveBuy(
  swingCtx: Context,
  evaluation: SwingEvaluationResult,
  buyLamports: bigint,
  buySolText: string
): Promise<Position | null> {
  const { item, score } = evaluation;

  const solPricePromise = tradingService.estimateSolUsdPrice(swingCtx);
  const beforeBalance = await tradingService.getWalletTokenBalance(
    swingCtx,
    item.mint,
    PRIORITY.HIGH
  );

  const { signature: sig, order } = await tradingService.executeSwapOrderWithSmartRetry(
    swingCtx,
    SOL_MINT,
    item.mint,
    buyLamports.toString(),
    false,
    null,
    undefined
  );

  // Poll for token arrival
  let afterBalance = beforeBalance;
  for (let i = 0; i < 6; i++) {
    await sleep(1000 + i * 500);
    afterBalance = await tradingService.getWalletTokenBalance(swingCtx, item.mint, PRIORITY.HIGH);
    if (afterBalance.rawAmount > beforeBalance.rawAmount) break;
  }

  const solPrice = await solPricePromise;
  const entryUsdValue =
    Number(order.inUsdValue || 0) > 0
      ? Number(order.inUsdValue)
      : Number(atomicToDecimalString(buyLamports, 9, 9)) * solPrice;
  const entrySolValue =
    entryUsdValue > 0 ? entryUsdValue / solPrice : Number(atomicToDecimalString(buyLamports, 9, 9));

  const received =
    afterBalance.rawAmount - beforeBalance.rawAmount > 0n
      ? afterBalance.rawAmount - beforeBalance.rawAmount
      : BigInt(order.outAmount || '0');

  if (received <= 0n) throw new Error(`Swing buy confirmation failed (zero delta) for ${sig}`);

  const actualDecimals = afterBalance.decimals || item.decimals;
  const units = Number(atomicToDecimalString(received, actualDecimals, 9));
  const entryPriceUsd = units > 0 ? entryUsdValue / units : item.lastKnownPrice;

  const pos = buildSwingPosition(swingCtx, evaluation, received, buySolText, buyLamports, {
    mode: 'live',
    entryPriceUsd,
    entryUsdValue,
    entryPriceSol: entryPriceUsd / solPrice,
    entrySolValue,
    buySignature: sig,
    decimals: actualDecimals,
  });

  // swingCtx is a shallow copy of ctx; store reference is shared
  swingCtx.store.upsertPosition(pos);

  const msg = `SWING BUY: ${item.symbol}\nScore: ${score}\nAmount: ${buySolText} SOL\nPrice: ${formatUsd(entryPriceUsd)}`;
  void sendNotification(swingCtx, msg).catch(() => undefined);

  swingCtx.logger(
    `SWING BUY ${item.symbol} (score=${score}) ${buySolText} SOL @ ${formatUsd(entryPriceUsd)} tx=${sig}.`,
    'trade',
    { console: true }
  );
  return pos;
}

function buildSwingPosition(
  ctx: Context,
  evaluation: SwingEvaluationResult,
  rawAmount: bigint,
  buySolText: string,
  buyLamports: bigint,
  opts: {
    mode: 'paper' | 'live';
    entryPriceUsd: number;
    entryUsdValue: number;
    entryPriceSol: number;
    entrySolValue: number;
    buySignature?: string;
    decimals?: number;
  }
): Position {
  const { item } = evaluation;
  const { config } = ctx;

  return {
    mint: item.mint,
    symbol: item.symbol,
    name: item.name,
    decimals: opts.decimals ?? item.decimals,
    openedAt: new Date().toISOString(),
    mode: opts.mode,
    entryPriceUsd: opts.entryPriceUsd,
    entryPriceSol: opts.entryPriceSol,
    entryUsdValue: opts.entryUsdValue,
    initialBuyAmountSol: buySolText,
    initialBuyAmountLamports: buyLamports.toString(),
    initialTokenAmountRaw: rawAmount.toString(),
    moonBagRaw: undefined,
    targetsHit: 0,
    tpProfile: 'swing',
    takeProfitMultiples: config.swingTakeProfitMultiples,
    takeProfitFractions: config.swingTakeProfitFractions,
    highGrowthConfidence: false,
    trailingStopDrawdownPctResolved: config.swingTrailingStopPct,
    maxHoldMinutesResolved: config.swingMaxHoldHours * 60,
    lastKnownBalanceRaw: rawAmount.toString(),
    lastKnownPriceUsd: opts.entryPriceUsd,
    highestPriceUsd: opts.entryPriceUsd,
    partiallyClosed: false,
    remainingCostUsd: opts.entryUsdValue,
    remainingCostSol: opts.entrySolValue,
    realizedPnlUsd: 0,
    realizedPnlSol: 0,
    realizedProceedsUsd: 0,
    realizedProceedsSol: 0,
    entryLiquidityUsd: item.lastKnownLiquidity,
    volatilityScaler: 0,
    launchpad: item.launchpad ?? null,
    entryScore: evaluation.score,
    buySignature: opts.buySignature,
    minTpReached: false,
    minTpArmed: false,
    trailingArmed: false,
    entryProfile: 'swing',
  };
}
