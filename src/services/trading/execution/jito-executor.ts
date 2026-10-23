/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
import { address } from '@solana/addresses';
import {
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
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
import bs58 from 'bs58';
import { Context, SwapOrder, TipContext } from '#types/index.js';
import {
  fetchJson,
  rpcCall,
  PRIORITY,
  safeJsonStringify,
  atomicToDecimalString,
  jitoRateLimit,
} from '#core/utils.js';
import { getWalletAddress } from '../wallet-manager.js';
import { getDynamicJitoTip } from '../fee-manager.js';
import { getBlockhash } from './blockhash-prewarmer.js';

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

export function getRandomJitoTipAccount(): ReturnType<typeof address> {
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

export async function confirmJitoBundle(
  ctx: Context,
  bundleId: string,
  timeoutMs = 30000
): Promise<boolean> {
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
        rateLimit: jitoRateLimit(ctx, PRIORITY.MEDIUM),
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
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
  return false;
}

export async function executeSwapOrderViaJito(
  ctx: Context,
  order: SwapOrder,
  isPanic = false,
  tipContext?: TipContext,
  signSwapTransactionFn?: (
    ctx: Context,
    order: SwapOrder,
    allowPartial?: boolean
  ) => Promise<string>,
  isSlippageErrorFn?: (err: unknown) => boolean
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

    const signedJupiterTxBase64 = signSwapTransactionFn
      ? await signSwapTransactionFn(ctx, order, false)
      : order.transaction;

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
        if (isSlippageErrorFn && isSlippageErrorFn(simulation.value.err)) {
          throw new Error('SlippageExceeded');
        }
        throw new Error(`Simulation failed: ${errStr}`);
      }
    }

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
        // The outer attempt loop rebuilds and resends; no blind inner retries.
        retries: 0,
        rateLimit: jitoRateLimit(ctx, PRIORITY.ULTRA_HIGH),
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
