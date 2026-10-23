/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
  signTransaction,
} from '@solana/transactions';
import { createJupiterApiClient } from '@jup-ag/api';
import { Context, SwapOrder, TipContext } from '#types/index.js';
import {
  fetchJson,
  rpcCall,
  PRIORITY,
  safeJsonStringify,
  getBucket,
  jupiterRateLimit,
} from '#core/utils.js';
import { getWalletAddress } from './wallet-manager.js';
import { fetchDynamicPriorityFee } from './fee-manager.js';
import { buildLocalSwapTransaction } from './local-router.js';
export { startBlockhashPrewarmer, getBlockhash } from './execution/blockhash-prewarmer.js';
export { confirmJitoBundle } from './execution/jito-executor.js';
import { executeSwapOrderViaJito as executeSwapOrderViaJitoImpl } from './execution/jito-executor.js';

/** Swaps are latency-critical (exits): position key, top priority in that key's bucket. */
function swapApiKey(ctx: Context): string {
  return ctx.config.jupiterPositionApiKey || ctx.config.jupiterApiKey;
}

/**
 * `/swap/v2/execute` has its own Jupiter bucket (50 RPS on Free) separate from the main one,
 * so it gets a separate local bucket too.
 */
function executeRateLimit(ctx: Context): { key: string; rps: number; priority: PRIORITY } {
  return { key: `jup-execute:${swapApiKey(ctx)}`, rps: 50, priority: PRIORITY.ULTRA_HIGH };
}

export async function fetchSdkSwapOrder(
  ctx: Context,
  inputMint: string,
  outputMint: string,
  amountLamports: bigint | string,
  isPanic = false,
  slippageBps: number | null = null
): Promise<SwapOrder> {
  const basePath =
    ctx.config.jupiterBaseUrl.includes('api.jup.ag') && !ctx.config.jupiterBaseUrl.includes('v6')
      ? 'https://quote-api.jup.ag/v6'
      : ctx.config.jupiterBaseUrl;

  const apiKey = swapApiKey(ctx);
  const jupiterQuoteApi = createJupiterApiClient({ basePath, apiKey });
  const { key, rps } = jupiterRateLimit(ctx, apiKey, PRIORITY.ULTRA_HIGH);
  const acquire = (): Promise<void> => getBucket(key, rps).acquire(PRIORITY.ULTRA_HIGH);

  try {
    const dynamicFeeMicroLamports = await fetchDynamicPriorityFee(
      ctx,
      [inputMint, outputMint],
      isPanic
    );
    const estimatedLamports = BigInt(Math.round((dynamicFeeMicroLamports * 250_000) / 1_000_000));

    await acquire();
    const quote = await jupiterQuoteApi.quoteGet({
      inputMint,
      outputMint,
      amount: Number(amountLamports),
      slippageBps: slippageBps ?? ctx.config.slippageBps,
      onlyDirectRoutes: false,
      asLegacyTransaction: false,
    });

    if (!quote) throw new Error('No quote found for SDK swap.');

    await acquire();
    const swapResult = await jupiterQuoteApi.swapPost({
      swapRequest: {
        quoteResponse: quote,
        userPublicKey: await getWalletAddress(ctx),
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            priorityLevel: isPanic ? 'veryHigh' : 'high',
            maxLamports: Number(estimatedLamports > 5000n ? estimatedLamports : 5000n),
          },
        },
      },
    });

    if (!swapResult || !swapResult.swapTransaction) {
      throw new Error('No swap transaction received from SDK.');
    }

    return {
      transaction: swapResult.swapTransaction,
      lastValidBlockHeight: swapResult.lastValidBlockHeight,
      requestId: (swapResult as unknown as Record<string, unknown>).requestId as string | undefined,
      outAmount: quote.outAmount,
    };
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      (error as unknown as Record<string, unknown>).name === 'ResponseError' &&
      (error as unknown as Record<string, unknown>).response
    ) {
      const response = (error as unknown as Record<string, unknown>).response as {
        status: number;
        json: () => Promise<unknown>;
      };
      const status = response.status;
      let body = 'unable to parse body';
      try {
        body = safeJsonStringify(await response.json());
      } catch {}
      throw new Error(`Jupiter SDK error ${status}: ${body}`, { cause: error });
    }
    throw error;
  }
}

export async function fetchSwapOrder(
  ctx: Context,
  inputMint: string,
  outputMint: string,
  amount: bigint | string,
  isPanic = false,
  slippageBps: number | null = null
): Promise<SwapOrder> {
  if (ctx.config.enableLocalRouting) {
    const localOrder = await buildLocalSwapTransaction(
      ctx,
      inputMint,
      outputMint,
      amount,
      slippageBps ?? ctx.config.slippageBps
    );
    if (localOrder) {
      return localOrder;
    }
  }

  if (ctx.config.useJupiterSdk) {
    ctx.logger(`Using Jupiter SDK path for ${outputMint}.`, 'debug');
    return await fetchSdkSwapOrder(ctx, inputMint, outputMint, amount, isPanic, slippageBps);
  }

  const dynamicFeeMicroLamports = await fetchDynamicPriorityFee(
    ctx,
    [inputMint, outputMint],
    isPanic
  );
  const estimatedLamports = BigInt(Math.round((dynamicFeeMicroLamports * 250_000) / 1_000_000));
  const finalFeeLamports = estimatedLamports > 5000n ? estimatedLamports : 5000n;

  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amount),
    taker: await getWalletAddress(ctx),
    slippageBps: String(slippageBps ?? ctx.config.slippageBps),
    autoWrapSol: 'true',
    prioritizationFeeLamports: String(finalFeeLamports),
  });

  const url = `${ctx.config.jupiterBaseUrl}/swap/v2/order?${params.toString()}`;
  try {
    const order = (await fetchJson(url, {
      headers: { 'x-api-key': swapApiKey(ctx) },
      retries: 1,
      rateLimit: jupiterRateLimit(ctx, swapApiKey(ctx), PRIORITY.ULTRA_HIGH),
    })) as Record<string, unknown>;

    if (!order || !order.transaction) {
      throw new Error(
        String(order?.errorMessage || order?.error || 'No transaction from Jupiter.')
      );
    }

    return order as unknown as SwapOrder;
  } catch (error: unknown) {
    throw new Error(
      `Jupiter V2 order failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

function getSignedTransactionBase64(transaction: unknown): string {
  return getBase64EncodedWireTransaction(
    transaction as Parameters<typeof getBase64EncodedWireTransaction>[0]
  ) as string;
}

async function signSwapTransaction(
  ctx: Context,
  order: SwapOrder,
  allowPartialSignatures = false
): Promise<string> {
  const transactionBytes = Buffer.from(order.transaction, 'base64');
  const transaction = getTransactionDecoder().decode(transactionBytes);
  const signer = allowPartialSignatures ? partiallySignTransaction : signTransaction;
  const keypairObj = ctx.wallet.keypair;
  if (!keypairObj) {
    throw new Error('Wallet keypair is not configured/available.');
  }

  const signedTransaction = await signer(
    [keypairObj.keyPair as Parameters<typeof signer>[0][number]],
    transaction as Parameters<typeof signer>[1]
  );
  return getSignedTransactionBase64(signedTransaction);
}

async function executeJupiterManagedOrder(ctx: Context, order: SwapOrder): Promise<string> {
  const signedTransaction = await signSwapTransaction(ctx, order, true);
  const body: Record<string, unknown> = {
    signedTransaction,
    requestId: order.requestId,
  };

  if (order.lastValidBlockHeight) {
    body.lastValidBlockHeight = order.lastValidBlockHeight;
  }

  const result = (await fetchJson(`${ctx.config.jupiterBaseUrl}/swap/v2/execute`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': swapApiKey(ctx),
    },
    body,
    // Never auto-retry a signed submission: a timeout may still land, and a resend could
    // double-execute. Callers own retry decisions with a fresh order.
    retries: 0,
    rateLimit: executeRateLimit(ctx),
  })) as Record<string, unknown>;

  if (!result || result.status !== 'Success' || !result.signature) {
    const details = result ? safeJsonStringify(result) : 'empty response';
    throw new Error(`Jupiter execute failed: ${details}`);
  }

  return result.signature as string;
}

async function executeSwapOrderViaRpc(ctx: Context, order: SwapOrder): Promise<string> {
  const wireTransactionBase64 = await signSwapTransaction(ctx, order, false);

  if (ctx.config.inlineSwapSimulation) {
    const simulation = (await rpcCall(
      ctx,
      'simulateTransaction',
      [
        wireTransactionBase64 as any,
        {
          encoding: 'base64',
          commitment: 'confirmed',
        },
      ],
      { priority: PRIORITY.HIGH }
    )) as unknown as { value: { err: unknown } };

    if (simulation.value.err) {
      const errStr = safeJsonStringify(simulation.value.err);
      if (isSlippageError(simulation.value.err)) {
        throw new Error('SlippageExceeded');
      }
      throw new Error(`Simulation failed: ${errStr}`);
    }
  }

  const sig = (await rpcCall(
    ctx,
    'sendTransaction',
    [
      wireTransactionBase64 as any,
      {
        encoding: 'base64',
        maxRetries: 3n,
        preflightCommitment: 'confirmed',
        skipPreflight: ctx.config.inlineSwapSimulation,
      },
    ],
    { priority: PRIORITY.HIGH }
  )) as string;

  const abortController = new AbortController();

  // Handshake must not hang forever — wrap subscribe in Promise.race like discovery.service.ts
  const handshakeTimeoutMs = ctx.config.websocketHandshakeTimeoutMs || 15000;
  const subscribePromise = (async () => {
    let handshakeTimer: NodeJS.Timeout | undefined;
    const handshakeTimeout = new Promise<never>((_, reject) => {
      handshakeTimer = setTimeout(
        () => reject(new Error('signatureNotifications handshake timed out')),
        handshakeTimeoutMs
      );
    });
    try {
      const notifications = await Promise.race([
        ctx.rpcSubscriptions
          .signatureNotifications(
            sig as unknown as Parameters<typeof ctx.rpcSubscriptions.signatureNotifications>[0],
            { commitment: 'confirmed' }
          )
          .subscribe({ abortSignal: abortController.signal }),
        handshakeTimeout,
      ]);
      clearTimeout(handshakeTimer);
      for await (const notification of notifications) {
        abortController.abort();
        if (notification.value.err) {
          throw new Error(`Swap failed: ${safeJsonStringify(notification.value.err)}`);
        }
        ctx.logger(`Transaction ${sig} confirmed via WebSocket.`, 'debug');
        return sig;
      }
      return sig;
    } finally {
      clearTimeout(handshakeTimer);
    }
  })();
  // Prevent UnhandledPromiseRejection if subscribe rejects after timeout wins
  subscribePromise.catch(() => {});

  // Promise.race guarantees timeout resolves even if .subscribe() ignores the AbortSignal
  let timeoutHandle: NodeJS.Timeout;
  const timeoutPromise = new Promise<string>((resolve) => {
    timeoutHandle = setTimeout(() => {
      abortController.abort();
      ctx.logger(`Transaction ${sig} not confirmed by WebSocket after 30s.`, 'warn');
      resolve(sig);
    }, 30000);
  });

  try {
    const result = await Promise.race([subscribePromise, timeoutPromise]);
    clearTimeout(timeoutHandle!);
    return result;
  } catch (err: unknown) {
    clearTimeout(timeoutHandle!);
    throw err;
  }
}

async function executeSwapOrderViaJito(
  ctx: Context,
  order: SwapOrder,
  isPanic = false,
  tipContext?: TipContext
): Promise<string> {
  return executeSwapOrderViaJitoImpl(
    ctx,
    order,
    isPanic,
    tipContext,
    signSwapTransaction,
    isSlippageError
  );
}

export function isSlippageError(errOrMsg: unknown): boolean {
  const msg =
    errOrMsg instanceof Error
      ? errOrMsg.message
      : typeof errOrMsg === 'string'
        ? errOrMsg
        : safeJsonStringify(errOrMsg);
  return msg.includes('SlippageExceeded') || msg.includes('0x1771') || msg.includes('6001');
}

export async function executeSwapOrder(
  ctx: Context,
  order: SwapOrder,
  isPanic = false,
  tipContext?: TipContext
): Promise<string> {
  if (ctx.config.useJito && !ctx.config.paperTrading && !ctx.config.dryRun) {
    return executeSwapOrderViaJito(ctx, order, isPanic, tipContext);
  }
  if (order.requestId) {
    return executeJupiterManagedOrder(ctx, order);
  }
  return executeSwapOrderViaRpc(ctx, order);
}

// Allows test stubs to intercept the two self-calls inside executeSwapOrderWithSmartRetry.
export const _swapRetryDispatch = {
  fetchSwapOrder,
  executeSwapOrder,
};

export async function executeSwapOrderWithSmartRetry(
  ctx: Context,
  inputMint: string,
  outputMint: string,
  amount: bigint | string,
  isPanic = false,
  initialOrder: SwapOrder | null = null,
  tipContext?: TipContext
): Promise<{ signature: string; order: SwapOrder }> {
  let currentSlippage = ctx.config.slippageBps;
  let attempts = 0;

  while (attempts <= ctx.config.maxAutoSlippageRetry) {
    const order =
      attempts === 0 && initialOrder
        ? initialOrder
        : await _swapRetryDispatch.fetchSwapOrder(
            ctx,
            inputMint,
            outputMint,
            amount,
            isPanic,
            currentSlippage
          );
    try {
      const signature = await _swapRetryDispatch.executeSwapOrder(ctx, order, isPanic, tipContext);
      return { signature, order };
    } catch (err: unknown) {
      if (isSlippageError(err) && attempts < ctx.config.maxAutoSlippageRetry) {
        attempts++;
        currentSlippage += ctx.config.autoSlippageIncrementBps;
        ctx.logger(
          `Slippage exceeded for ${outputMint}. Retrying with ${currentSlippage} bps (attempt ${attempts}).`,
          'warn'
        );
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `Max slippage retries (${ctx.config.maxAutoSlippageRetry}) exceeded for ${outputMint}.`
  );
}
