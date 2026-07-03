import type { SolanaRpcApi } from '@solana/rpc';
import { address, getProgramDerivedAddress, getAddressEncoder } from '@solana/addresses';
import { AccountRole } from '@solana/instructions';
import {
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
} from '@solana/transaction-messages';
import { compileTransaction, getBase64EncodedWireTransaction } from '@solana/transactions';
import { Context, SwapOrder } from '#types/index.js';
import { getWalletAddress } from '../wallet-manager.js';
import { rpcCall, PRIORITY, decodeRaydiumPool } from '#core/utils/solana.js';
import { RAYDIUM_AMM_V4_PROGRAM_ID } from '#core/constants.js';
import { getBlockhash } from '../swap-executor.js';
import { poolConfigsCache, RaydiumPool } from '../local-router.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM_ID = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

// Raydium AMM V4 authority — global PDA for all pools (cached on first use)
let _cachedAmmAuthority: string | null = null;

async function getAmmAuthority(): Promise<string> {
  if (_cachedAmmAuthority) return _cachedAmmAuthority;
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(RAYDIUM_AMM_V4_PROGRAM_ID),
    seeds: [new TextEncoder().encode('amm authority')],
  });
  _cachedAmmAuthority = pda;
  return pda;
}

async function getAta(owner: string, mint: string): Promise<string> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ID,
    seeds: [
      getAddressEncoder().encode(address(owner)),
      getAddressEncoder().encode(TOKEN_PROGRAM_ID),
      getAddressEncoder().encode(address(mint)),
    ],
  });
  return pda;
}

// Constant-product quote (exact input). All arithmetic in BigInt to avoid precision loss.
function raydiumQuote(reserveIn: bigint, reserveOut: bigint, amountIn: bigint): bigint {
  if (reserveIn === 0n || reserveOut === 0n) return 0n;
  // Apply 0.25% fee (25 / 10_000) before computing output
  const amountInAfterFee = (amountIn * 9975n) / 10000n;
  return (reserveOut * amountInAfterFee) / (reserveIn + amountInAfterFee);
}

export async function buildRaydiumSwap(
  ctx: Context,
  poolAddress: string,
  inputMint: string,
  outputMint: string,
  amount: bigint | string,
  slippageBps: number
): Promise<SwapOrder | null> {
  const amountIn = BigInt(amount);
  const isBuy = inputMint === SOL_MINT;
  const walletAddress = await getWalletAddress(ctx);

  let poolData = poolConfigsCache.get(poolAddress) as RaydiumPool | undefined;
  if (!poolData) {
    const poolAccountParams = [
      address(poolAddress),
      { encoding: 'base64' },
    ] as unknown as Parameters<SolanaRpcApi['getAccountInfo']>;
    const poolInfo = (await rpcCall(ctx, 'getAccountInfo', poolAccountParams, {
      priority: PRIORITY.HIGH,
    })) as { value: { data: [string, string] } | null };

    if (!poolInfo.value?.data[0]) {
      throw new Error(`Raydium pool account not found: ${poolAddress}`);
    }

    const poolBuf = Buffer.from(poolInfo.value.data[0], 'base64');
    const decoded = decodeRaydiumPool(poolBuf);
    if (!decoded) {
      throw new Error(`Failed to decode Raydium pool: ${poolAddress}`);
    }
    poolData = decoded;
    poolConfigsCache.set(poolAddress, poolData);
  }

  const { baseVault, quoteVault, baseMint, quoteMint, needTakePnlCoin, needTakePnlPc } = poolData;

  // Determine direction: baseMint (coin) vs quoteMint (pc, usually SOL/USDC)
  const coinIsInput = inputMint === baseMint;
  const solIsQuote = quoteMint === SOL_MINT;
  if (!solIsQuote && baseMint !== SOL_MINT) {
    // Non-SOL pool — can't route locally
    return null;
  }

  // 2. Fetch vault balances and blockhash in parallel
  const blockhashResPromise = getBlockhash(ctx);

  let rawBaseAmount = ctx.state.vaultBalanceCache?.get(baseVault);
  let rawQuoteAmount = ctx.state.vaultBalanceCache?.get(quoteVault);

  if (rawBaseAmount === undefined || rawQuoteAmount === undefined) {
    const vaultInfo = (await rpcCall(
      ctx,
      'getMultipleAccounts',
      [[address(baseVault), address(quoteVault)], { encoding: 'base64', commitment: 'confirmed' }],
      { priority: PRIORITY.HIGH }
    )) as { value: Array<{ data: [string, string] } | null> };

    const baseVaultData = vaultInfo.value?.[0]?.data?.[0];
    const quoteVaultData = vaultInfo.value?.[1]?.data?.[0];
    if (!baseVaultData || !quoteVaultData) {
      throw new Error(`Vault accounts not found for pool ${poolAddress}`);
    }

    const baseBuf = Buffer.from(baseVaultData, 'base64');
    const quoteBuf = Buffer.from(quoteVaultData, 'base64');
    if (baseBuf.length < 72 || quoteBuf.length < 72) {
      throw new Error(`Vault account data too short for pool ${poolAddress}`);
    }

    rawBaseAmount = baseBuf.readBigUInt64LE(64);
    rawQuoteAmount = quoteBuf.readBigUInt64LE(64);

    // Update cache opportunistically
    if (ctx.state.vaultBalanceCache) {
      ctx.state.vaultBalanceCache.set(baseVault, rawBaseAmount);
      ctx.state.vaultBalanceCache.set(quoteVault, rawQuoteAmount);
    }
  }

  const blockhashRes = await blockhashResPromise;

  // Effective reserves (subtract accrued PnL that hasn't been swept yet)
  const effectiveCoin =
    rawBaseAmount > needTakePnlCoin ? rawBaseAmount - needTakePnlCoin : rawBaseAmount;
  const effectivePc =
    rawQuoteAmount > needTakePnlPc ? rawQuoteAmount - needTakePnlPc : rawQuoteAmount;

  if (effectiveCoin === 0n || effectivePc === 0n) {
    return null; // Pool drained / not initialized
  }

  // 3. Compute quote
  let amountOut: bigint;
  if (coinIsInput) {
    amountOut = raydiumQuote(effectiveCoin, effectivePc, amountIn);
  } else {
    amountOut = raydiumQuote(effectivePc, effectiveCoin, amountIn);
  }

  if (amountOut === 0n) return null;

  const minAmountOut = amountOut - (amountOut * BigInt(slippageBps)) / 10000n;

  // 4. Derive AMM authority and user ATAs
  const ammAuthority = address(await getAmmAuthority());
  const userSourceAta = address(await getAta(walletAddress, inputMint));
  const userDestAta = address(await getAta(walletAddress, outputMint));

  // 5. Build SwapBaseInV2 instruction (tag=16, 8 accounts — no OpenBook dependency)
  const data = new Uint8Array(17);
  data[0] = 16; // SwapBaseInV2 discriminator
  const view = new DataView(data.buffer);
  view.setBigUint64(1, amountIn, true);
  view.setBigUint64(9, minAmountOut, true);

  const keys = [
    { address: TOKEN_PROGRAM_ID, role: AccountRole.READONLY },
    { address: address(poolAddress), role: AccountRole.WRITABLE },
    { address: ammAuthority, role: AccountRole.READONLY },
    { address: address(baseVault), role: AccountRole.WRITABLE },
    { address: address(quoteVault), role: AccountRole.WRITABLE },
    { address: userSourceAta, role: AccountRole.WRITABLE },
    { address: userDestAta, role: AccountRole.WRITABLE },
    { address: address(walletAddress), role: AccountRole.WRITABLE_SIGNER },
  ];

  const instruction = {
    programAddress: address(RAYDIUM_AMM_V4_PROGRAM_ID),
    data,
    accounts: keys,
  };

  const lifetimeConstraint = {
    blockhash: blockhashRes.blockhash,
    lastValidBlockHeight: blockhashRes.lastValidBlockHeight,
  } as unknown as Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0];

  const message = appendTransactionMessageInstruction(
    instruction as unknown as Parameters<typeof appendTransactionMessageInstruction>[0],
    setTransactionMessageLifetimeUsingBlockhash(
      lifetimeConstraint,
      setTransactionMessageFeePayer(
        address(walletAddress),
        createTransactionMessage({ version: 0 })
      )
    )
  );

  const compiledTx = compileTransaction(message);
  const wireBytes = getBase64EncodedWireTransaction(compiledTx);

  ctx.logger(
    `[local-raydium] pool=${poolAddress} amtIn=${amountIn} minOut=${minAmountOut} (${isBuy ? 'buy' : 'sell'})`,
    'debug'
  );

  return {
    transaction: wireBytes as string,
    lastValidBlockHeight: Number(blockhashRes.lastValidBlockHeight),
    outAmount: amountOut.toString(),
  };
}
