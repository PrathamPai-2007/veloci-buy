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
import { rpcCall, PRIORITY, decodeMeteoraPool } from '#core/utils/solana.js';
import { METEORA_DLMM_PROGRAM_ID, MEMO_PROGRAM_ID } from '#core/constants.js';
import { getBlockhash } from '../swap-executor.js';
import { poolConfigsCache, MeteoraPool } from '../local-router.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM_ID = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const METEORA_PROGRAM = address(METEORA_DLMM_PROGRAM_ID);
const MEMO = address(MEMO_PROGRAM_ID);

// Meteora Swap2 Anchor discriminator
const SWAP2_DISCRIMINATOR = new Uint8Array([65, 75, 63, 76, 235, 91, 91, 136]);

// Bins per bin_array in Meteora DLMM
const BINS_PER_ARRAY = 70;

// Cached event authority (PDA of Meteora program, seeds = ["__event_authority"])
let _cachedEventAuthority: string | null = null;

async function getEventAuthority(): Promise<string> {
  if (_cachedEventAuthority) return _cachedEventAuthority;
  const [pda] = await getProgramDerivedAddress({
    programAddress: METEORA_PROGRAM,
    seeds: [new TextEncoder().encode('__event_authority')],
  });
  _cachedEventAuthority = pda;
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

function binArrayIndex(binId: number): number {
  // Integer division, handling negative bin IDs
  return Math.floor(binId / BINS_PER_ARRAY);
}

async function getBinArrayPda(poolAddress: string, index: number): Promise<string> {
  // Encode index as i64 LE (8 bytes)
  const indexBuf = Buffer.alloc(8);
  // i64 LE — handle negative index
  indexBuf.writeBigInt64LE(BigInt(index));
  const poolAddressBytes = getAddressEncoder().encode(address(poolAddress));
  const [pda] = await getProgramDerivedAddress({
    programAddress: METEORA_PROGRAM,
    seeds: [new TextEncoder().encode('bin_array'), poolAddressBytes, indexBuf],
  });
  return pda;
}

async function getOraclePda(poolAddress: string): Promise<string> {
  const poolAddressBytes = getAddressEncoder().encode(address(poolAddress));
  const [pda] = await getProgramDerivedAddress({
    programAddress: METEORA_PROGRAM,
    seeds: [new TextEncoder().encode('oracle'), poolAddressBytes],
  });
  return pda;
}

// Active-bin quote: price = (1 + binStep/10_000)^activeId
// fee = baseFactor * binStep * 10 / 1_000_000_000 (as fraction)
function meteoraQuote(
  amountIn: bigint,
  activeId: number,
  binStep: number,
  baseFactor: number,
  xToY: boolean // true = tokenX → tokenY (up in bin IDs for DLMM), false = Y → X
): bigint {
  const price = Math.pow(1 + binStep / 10_000, activeId);
  const feeRate = (baseFactor * binStep * 10) / 1_000_000_000;
  const feeMultiplier = 1 - feeRate;

  const amountInNum = Number(amountIn);
  let rawOut: number;
  if (xToY) {
    // X (SOL if solIsX) → Y, price = X per Y, so Y out = X / price
    rawOut = (amountInNum * feeMultiplier) / price;
  } else {
    // Y → X, X out = Y * price
    rawOut = amountInNum * feeMultiplier * price;
  }

  return BigInt(Math.floor(rawOut));
}

export async function buildMeteoraSwap(
  ctx: Context,
  poolAddress: string,
  inputMint: string,
  outputMint: string,
  amount: bigint | string,
  slippageBps: number
): Promise<SwapOrder | null> {
  const amountIn = BigInt(amount);
  const walletAddress = await getWalletAddress(ctx);

  let poolData = poolConfigsCache.get(poolAddress) as MeteoraPool | undefined;
  if (!poolData) {
    const poolAccountParams = [
      address(poolAddress),
      { encoding: 'base64' },
    ] as unknown as Parameters<SolanaRpcApi['getAccountInfo']>;
    const poolInfo = (await rpcCall(ctx, 'getAccountInfo', poolAccountParams, {
      priority: PRIORITY.HIGH,
    })) as { value: { data: [string, string] } | null };

    if (!poolInfo.value?.data[0]) {
      throw new Error(`Meteora pool account not found: ${poolAddress}`);
    }

    const poolBuf = Buffer.from(poolInfo.value.data[0], 'base64');
    const decoded = decodeMeteoraPool(poolBuf);
    if (!decoded) {
      throw new Error(`Failed to decode Meteora pool: ${poolAddress}`);
    }
    poolData = decoded;
    poolConfigsCache.set(poolAddress, poolData);
  }

  const { tokenXMint, tokenYMint, reserveX, reserveY, activeId, binStep, baseFactor } = poolData;

  const solIsX = tokenXMint === SOL_MINT;
  const tokenMint = solIsX ? tokenYMint : tokenXMint;

  // Verify this pool matches the requested mints
  const isBuy = inputMint === SOL_MINT;
  if (isBuy && tokenMint !== outputMint) return null;
  if (!isBuy && tokenMint !== inputMint) return null;

  // Determine swap direction:
  // solIsX=true + buy (SOL→token): SOL is X, token is Y → X→Y direction (xToY = true)
  // solIsX=true + sell (token→SOL): Y→X direction (xToY = false)
  const xToY = (solIsX && isBuy) || (!solIsX && !isBuy);

  // 2. Compute active-bin quote
  const amountOut = meteoraQuote(amountIn, activeId, binStep, baseFactor, xToY);
  if (amountOut === 0n) return null;

  const minAmountOut = amountOut - (amountOut * BigInt(slippageBps)) / 10000n;

  // 3. Derive bin array PDAs (active bin + one in swap direction for safety)
  const activeIdx = binArrayIndex(activeId);
  const nextIdx = xToY ? activeIdx + 1 : activeIdx - 1;

  const [activeBinArrayPda, nextBinArrayPda, oraclePda, eventAuthority] = await Promise.all([
    getBinArrayPda(poolAddress, activeIdx),
    getBinArrayPda(poolAddress, nextIdx),
    getOraclePda(poolAddress),
    getEventAuthority(),
  ]);

  // 4. Build user ATAs
  const userTokenIn = address(await getAta(walletAddress, inputMint));
  const userTokenOut = address(await getAta(walletAddress, outputMint));

  // 5. Build Swap2 instruction data
  // Layout: discriminator(8) + amount_in(u64) + min_amount_out(u64) + remaining_accounts_info
  // remaining_accounts_info: vec<{accounts_type:u8, length:u8}> → [count:u32][type:u8][len:u8]
  // We pass 2 bin arrays (active + next), so: [1,0,0,0, 0, 2]
  const data = new Uint8Array(30);
  data.set(SWAP2_DISCRIMINATOR, 0);
  const view = new DataView(data.buffer);
  view.setBigUint64(8, amountIn, true);
  view.setBigUint64(16, minAmountOut, true);
  // remaining_accounts_info: 1 slice, type=BinArrays(0), length=2
  view.setUint32(24, 1, true); // vec length
  data[28] = 0; // AccountsType::BinArrays
  data[29] = 2; // 2 bin arrays

  // 6. Build account list (Swap2 layout)
  const keys = [
    { address: address(poolAddress), role: AccountRole.WRITABLE },
    // bin_array_bitmap_extension is optional — omit for standard pools
    { address: address(reserveX), role: AccountRole.WRITABLE },
    { address: address(reserveY), role: AccountRole.WRITABLE },
    { address: userTokenIn, role: AccountRole.WRITABLE },
    { address: userTokenOut, role: AccountRole.WRITABLE },
    { address: address(tokenXMint), role: AccountRole.READONLY },
    { address: address(tokenYMint), role: AccountRole.READONLY },
    { address: address(oraclePda), role: AccountRole.WRITABLE },
    // host_fee_in is optional — omit
    { address: address(walletAddress), role: AccountRole.WRITABLE_SIGNER },
    { address: TOKEN_PROGRAM_ID, role: AccountRole.READONLY },
    { address: TOKEN_PROGRAM_ID, role: AccountRole.READONLY }, // token_y_program (same SPL program)
    { address: MEMO, role: AccountRole.READONLY },
    { address: address(eventAuthority), role: AccountRole.READONLY },
    { address: METEORA_PROGRAM, role: AccountRole.READONLY },
    // remaining: bin arrays
    { address: address(activeBinArrayPda), role: AccountRole.WRITABLE },
    { address: address(nextBinArrayPda), role: AccountRole.WRITABLE },
  ];

  const instruction = {
    programAddress: METEORA_PROGRAM,
    data,
    accounts: keys,
  };

  const blockhashRes = await getBlockhash(ctx);

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
    `[local-meteora] pool=${poolAddress} amtIn=${amountIn} minOut=${minAmountOut} activeId=${activeId} (${isBuy ? 'buy' : 'sell'})`,
    'debug'
  );

  return {
    transaction: wireBytes as string,
    lastValidBlockHeight: Number(blockhashRes.lastValidBlockHeight),
    outAmount: amountOut.toString(),
  };
}
