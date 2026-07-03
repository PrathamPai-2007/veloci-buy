/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
import { address } from '@solana/addresses';
import {
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
  signTransaction,
  compileTransaction,
} from '@solana/transactions';
import { AccountRole } from '@solana/instructions';
import {
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
} from '@solana/transaction-messages';
import { createJupiterApiClient } from '@jup-ag/api';
import bs58 from 'bs58';
import { Context, SwapOrder, TipContext } from '#types/index.js';
import {
  fetchJson,
  rpcCall,
  PRIORITY,
  safeJsonStringify,
  sleep,
  atomicToDecimalString,
} from '#core/utils.js';
import { getWalletAddress } from './wallet-manager.js';
import { getDynamicJitoTip, fetchDynamicPriorityFee } from './fee-manager.js';
import { buildLocalSwapTransaction } from './local-router.js';

// Rolling blockhash cache: refreshed every 300ms by startBlockhashPrewarmer.
// A cached value younger than 350ms (< one slot) is safe to use, saving one
// RPC round-trip on the critical panic-sell path.
let _bh: { blockhash: string; lastValidBlockHeight: bigint; ts: number } | null = null;
const BLOCKHASH_CACHE_TTL_MS = 350;

export function startBlockhashPrewarmer(ctx: Context): ReturnType<typeof setInterval> {
  return setInterval(() => {
    void rpcCall(ctx, 'getLatestBlockhash', [{ commitment: 'confirmed' }], {
      priority: PRIORITY.HIGH,
    })
      .then((r) => {
        const v = (r as { value: { blockhash: string; lastValidBlockHeight: bigint | number } })
          .value;
        _bh = {
          blockhash: v.blockhash,
          lastValidBlockHeight: BigInt(v.lastValidBlockHeight),
          ts: Date.now(),
        };
      })
      .catch(() => {});
  }, 300);
}

export async function getBlockhash(
  ctx: Context
): Promise<{ blockhash: string; lastValidBlockHeight: bigint }> {
  if (_bh && Date.now() - _bh.ts < BLOCKHASH_CACHE_TTL_MS) {
    return { blockhash: _bh.blockhash, lastValidBlockHeight: _bh.lastValidBlockHeight };
  }
  const r = (await rpcCall(ctx, 'getLatestBlockhash', [{ commitment: 'confirmed' }], {
    priority: PRIORITY.HIGH,
  })) as unknown as { value: { blockhash: string; lastValidBlockHeight: bigint } };
  return {
    blockhash: r.value.blockhash,
    lastValidBlockHeight: BigInt(r.value.lastValidBlockHeight),
  };
}

const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZu5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyMvGrnC7APhSbxu3nm8Dq9H77Y2pEEat9Bshq7m',
  'DfXygSm4jCyv6LsdiCBsyzpMvMPnPvps9R9fW9GZun9X',
  'ADa65qRGDTCee3A2Z58A67t3qn6GwoPua676uJ4vcmjX',
  'AD2vtZ1chzw5LVEHdb4sRkrSdf2A8fTirnCnG54pTeqN',
  'DttWaMuZQApr4m9pc4sfb5hc51w75F1McB4AES5xK4yH',
  '3AVa972m1y41zZ1zB1xJw54sCgCg1eRk2e4xLdE8aP7y',
];

function getRandomJitoTipAccount() {
  const addrStr = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]!;
  try {
    return address(addrStr);
  } catch (err) {
    throw new Error(
      `Failed to decode Jito tip address "${addrStr}": ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
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

  const jupiterQuoteApi = createJupiterApiClient({
    basePath,
    apiKey: ctx.config.jupiterApiKey,
  });

  try {
    const dynamicFeeMicroLamports = await fetchDynamicPriorityFee(
      ctx,
      [inputMint, outputMint],
      isPanic
    );
    const estimatedLamports = BigInt(Math.round((dynamicFeeMicroLamports * 250_000) / 1_000_000));

    const quote = await jupiterQuoteApi.quoteGet({
      inputMint,
      outputMint,
      amount: Number(amountLamports),
      slippageBps: slippageBps ?? ctx.config.slippageBps,
      onlyDirectRoutes: false,
      asLegacyTransaction: false,
    });

    if (!quote) throw new Error('No quote found for SDK swap.');

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
      headers: { 'x-api-key': ctx.config.jupiterApiKey },
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
      'x-api-key': ctx.config.jupiterApiKey,
    },
    body,
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
      if (
        errStr.includes('SlippageExceeded') ||
        errStr.includes('0x1771') ||
        errStr.includes('6001')
      ) {
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

  const subscribePromise = (async () => {
    const notifications = await ctx.rpcSubscriptions
      .signatureNotifications(
        sig as unknown as Parameters<typeof ctx.rpcSubscriptions.signatureNotifications>[0],
        { commitment: 'confirmed' }
      )
      .subscribe({ abortSignal: abortController.signal });
    for await (const notification of notifications) {
      abortController.abort();
      if (notification.value.err) {
        throw new Error(`Swap failed: ${safeJsonStringify(notification.value.err)}`);
      }
      ctx.logger(`Transaction ${sig} confirmed via WebSocket.`, 'debug');
      return sig;
    }
    return sig;
  })();

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

export async function confirmJitoBundle(
  ctx: Context,
  bundleId: string,
  timeoutMs = 30000
): Promise<boolean> {
  // Bundle status must always go to the block engine, not the tip-floor stats URL.
  const url = `${ctx.config.jitoBlockEngineUrl}/api/v1/bundles`;
  const startTime = Date.now();
  const pollInterval = 1500;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = (await fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'getBundleStatuses',
          params: [[bundleId]],
        },
        timeoutMs: 3000,
        retries: 0,
      })) as {
        result?: {
          value?: Array<{
            bundle_id: string;
            confirmationStatus?: string;
            err?: unknown;
          }>;
        };
      };

      const bundleInfo = response?.result?.value?.[0];
      if (bundleInfo && bundleInfo.bundle_id === bundleId) {
        if (bundleInfo.err) {
          throw new Error(`Jito bundle failed execution: ${safeJsonStringify(bundleInfo.err)}`);
        }
        const status = bundleInfo.confirmationStatus;
        if (status === 'confirmed' || status === 'finalized' || status === 'processed') {
          ctx.logger(`Jito bundle ${bundleId} confirmed (${status}).`, 'debug');
          return true;
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('Jito bundle failed execution')) {
        throw err;
      }
    }
    await sleep(pollInterval);
  }
  return false;
}

async function executeSwapOrderViaJito(
  ctx: Context,
  order: SwapOrder,
  isPanic = false,
  tipContext?: TipContext
): Promise<string> {
  const walletAddress = await getWalletAddress(ctx);

  const keypairObj = ctx.wallet.keypair;
  if (!keypairObj) throw new Error('Wallet keypair is missing.');
  const signer = keypairObj.keyPair as Parameters<typeof signTransaction>[0][number];

  const maxAttempts = ctx.config.jitoBundleRetryAttempts || 3;
  const timeoutMs = ctx.config.jitoConfirmTimeoutMs || 30000;
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts++;

    const { blockhash, lastValidBlockHeight } = await getBlockhash(ctx);

    const tipAmount = await getDynamicJitoTip(ctx, isPanic, tipContext);
    const tipAccount = getRandomJitoTipAccount();

    ctx.logger(
      `[Jito] Preparing bundle attempt ${attempts}/${maxAttempts}. Tip: ${atomicToDecimalString(tipAmount, 9, 6)} SOL to ${tipAccount}`,
      'debug'
    );

    const signedJupiterTxBase64 = await signSwapTransaction(ctx, order, false);

    const data = new Uint8Array(12);
    const view = new DataView(data.buffer);
    view.setUint32(0, 2, true);
    view.setBigUint64(4, tipAmount, true);

    const tipInstruction = {
      programAddress: address('11111111111111111111111111111111'),
      accounts: [
        { address: address(walletAddress), role: AccountRole.WRITABLE_SIGNER },
        { address: tipAccount, role: AccountRole.WRITABLE },
      ],
      data,
    };

    let tipMessage = createTransactionMessage({ version: 0 });
    tipMessage = setTransactionMessageFeePayer(address(walletAddress), tipMessage);
    tipMessage = setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: blockhash as unknown as Parameters<
          typeof setTransactionMessageLifetimeUsingBlockhash
        >[0]['blockhash'],
        lastValidBlockHeight,
      },
      tipMessage
    );
    tipMessage = appendTransactionMessageInstruction(tipInstruction, tipMessage as any) as any;

    const compiledTipTransaction = compileTransaction(tipMessage as any);
    const signedTipTransaction = await signTransaction([signer], compiledTipTransaction);
    const signedTipTxBase64 = getBase64EncodedWireTransaction(signedTipTransaction);

    if (ctx.config.inlineSwapSimulation && attempts === 1) {
      const simulation = (await rpcCall(
        ctx,
        'simulateTransaction',
        [
          signedJupiterTxBase64 as any,
          {
            encoding: 'base64',
            commitment: 'confirmed',
          },
        ],
        { priority: PRIORITY.HIGH }
      )) as unknown as { value: { err: unknown } };

      if (simulation.value.err) {
        const errStr = safeJsonStringify(simulation.value.err);
        if (
          errStr.includes('SlippageExceeded') ||
          errStr.includes('0x1771') ||
          errStr.includes('6001')
        ) {
          throw new Error('SlippageExceeded');
        }
        throw new Error(`Simulation failed: ${errStr}`);
      }
    }

    // Bundle submission always targets the block engine endpoint, not the tip-floor stats URL.
    const jitoUrl = `${ctx.config.jitoBlockEngineUrl}/api/v1/bundles`;
    let response: Record<string, unknown>;
    try {
      response = (await fetchJson(jitoUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'sendBundle',
          params: [[signedJupiterTxBase64, signedTipTxBase64]],
        },
      })) as Record<string, unknown>;
    } catch (err: unknown) {
      ctx.logger(
        `Jito sendBundle attempt ${attempts} failed to fetch: ${err instanceof Error ? err.message : String(err)}`,
        'warn'
      );
      continue;
    }

    if (response.error) {
      ctx.logger(
        `Jito sendBundle attempt ${attempts} failed: ${safeJsonStringify(response.error)}`,
        'warn'
      );
      continue;
    }

    const bundleId = response.result as string;
    ctx.logger(
      `Jito bundle submitted. Bundle ID: ${bundleId}. Waiting for confirmation...`,
      'info'
    );

    try {
      const confirmed = await confirmJitoBundle(ctx, bundleId, timeoutMs);
      if (confirmed) {
        const decodedJupiter = getTransactionDecoder().decode(
          Buffer.from(signedJupiterTxBase64, 'base64')
        );
        const signature = (decodedJupiter as unknown as { signatures: Uint8Array[] }).signatures[0];
        if (!signature) throw new Error('No signature found in Jupiter transaction.');
        return bs58.encode(signature);
      }
      ctx.logger(`Jito bundle ${bundleId} timed out without landing.`, 'warn');
    } catch (err: unknown) {
      ctx.logger(
        `Jito bundle ${bundleId} execution failed: ${err instanceof Error ? err.message : String(err)}.`,
        'warn'
      );
    }
  }

  throw new Error(`Jito bundle failed to land after ${maxAttempts} attempts.`);
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
      const msg = err instanceof Error ? err.message : String(err);
      const isSlippageError =
        msg.includes('SlippageExceeded') || msg.includes('6001') || msg.includes('0x1771');
      if (isSlippageError && attempts < ctx.config.maxAutoSlippageRetry) {
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
