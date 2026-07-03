import type { SolanaRpcApi } from '@solana/rpc';
import { Context, SwapOrder } from '#types/index.js';
import { getWalletAddress } from '../wallet-manager.js';
import {
  address,
  getProgramDerivedAddress,
  getAddressEncoder,
  type Address,
} from '@solana/addresses';
import { AccountRole } from '@solana/instructions';
import {
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
} from '@solana/transaction-messages';
import { compileTransaction, getBase64EncodedWireTransaction } from '@solana/transactions';
import { rpcCall, PRIORITY, decodePumpCurve, derivePumpCurvePda } from '#core/utils/solana.js';
import { PUMP_FUN_PROGRAM_ID as PUMP_FUN_PROGRAM_ID_STR } from '#core/constants.js';
import { getBlockhash } from '../swap-executor.js';

// Redeployed pump.fun program (Token-2022 mints). Account layout + PDAs reverse-engineered from the
// on-chain anchor IDL (program `6EF8…F6P`, IDL v0.1.0). Static program PDAs are hardcoded; per-mint
// and per-user accounts are derived. See `buildPumpFunSwap` for the buy/sell account orders.
const PUMP_FUN_PROGRAM_ID = address(PUMP_FUN_PROGRAM_ID_STR);
const GLOBAL = address('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
const EVENT_AUTHORITY = address('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
const GLOBAL_VOLUME_ACCUMULATOR = address('Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y');
const FEE_CONFIG = address('8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt');
const FEE_PROGRAM = address('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
const SYSTEM_PROGRAM_ID = address('11111111111111111111111111111111');
const TOKEN_PROGRAM_ID = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOCIATED_TOKEN_PROGRAM_ID = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

const BUY_DISCRIMINATOR = new Uint8Array([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISCRIMINATOR = new Uint8Array([51, 230, 133, 164, 1, 127, 131, 173]);

// Cashback upgrade: every buy/sell must append two `remaining_accounts` after fee_program or the
// program fails with `BuybackFeeRecipientMissing` (0x17ae):
//   1. bonding_curve_v2  — PDA(["bonding-curve-v2", mint]) under the pump program (derived per mint).
//   2. the fee_recipient's paired pump_fees account — a 208-byte account in the fee program that is
//      matched 1:1 with the chosen buyback fee recipient. It isn't derivable from the public fee IDL,
//      so the recipient and its paired account are pinned together here as protocol infra. Overridable.
// The fee recipient must be one of Global.fee_recipients[7] (array @162), NOT Global.fee_recipient @41.
// We pin fee_recipients[0] and its paired account; the sim harness (scripts/sim-pump-buy.ts) re-verifies.
// ponytail: pinned pair, not derived — if pump rotates fee infra the sim fails loudly and we re-pin.
const BUYBACK_FEE_RECIPIENT = address('7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ');
const BUYBACK_FEE_ACCOUNT = address('5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD');

async function getAta(owner: string, mint: string, tokenProgram: Address): Promise<string> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ID,
    seeds: [
      getAddressEncoder().encode(address(owner)),
      getAddressEncoder().encode(tokenProgram),
      getAddressEncoder().encode(address(mint)),
    ],
  });
  return pda;
}

// Associated Token Account program `CreateIdempotent` instruction (discriminator byte 1): creates the
// owner's ATA for the mint if it doesn't already exist, no-op otherwise. Required before a first buy
// because the new pump buy ix doesn't init the ATA itself.
function createAtaIdempotentIx(owner: string, mint: string, ata: Address, tokenProgram: Address) {
  return {
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ID,
    data: new Uint8Array([1]),
    accounts: [
      { address: address(owner), role: AccountRole.WRITABLE_SIGNER }, // payer
      { address: ata, role: AccountRole.WRITABLE }, // ata
      { address: address(owner), role: AccountRole.READONLY }, // owner
      { address: address(mint), role: AccountRole.READONLY }, // mint
      { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
      { address: tokenProgram, role: AccountRole.READONLY },
    ],
  };
}

// Derive a program PDA from a string seed + a single pubkey seed (creator-vault, user_volume_accumulator).
async function derivePumpPda(seed: string, key: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: PUMP_FUN_PROGRAM_ID,
    seeds: [new TextEncoder().encode(seed), getAddressEncoder().encode(key)],
  });
  return address(pda);
}

// New pump mints are Token-2022; older ones are classic SPL. The ATA seeds and the ix `token_program`
// account must match the mint's actual owner program.
async function getMintTokenProgram(ctx: Context, mint: string): Promise<Address> {
  const params = [address(mint), { encoding: 'base64' }] as unknown as Parameters<
    SolanaRpcApi['getAccountInfo']
  >;
  const ai = (await rpcCall(ctx, 'getAccountInfo', params, { priority: PRIORITY.HIGH })) as {
    value: { owner: string } | null;
  };
  return ai.value?.owner === TOKEN_2022_PROGRAM_ID ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

export async function buildPumpFunSwap(
  ctx: Context,
  inputMint: string,
  outputMint: string,
  amount: bigint | string,
  slippageBps: number
): Promise<SwapOrder | null> {
  const isBuy = inputMint === 'So11111111111111111111111111111111111111112';
  const targetMint = isBuy ? outputMint : inputMint;
  const walletAddress = await getWalletAddress(ctx);

  const bondingCurveStr = await derivePumpCurvePda(targetMint);
  if (!bondingCurveStr) {
    throw new Error(`Failed to derive bonding curve for ${targetMint}`);
  }
  const bondingCurve = address(bondingCurveStr);

  // Fetch curve state to calculate amounts and read the on-chain creator (needed for creator_vault).
  // getAccountInfo is overloaded by `encoding`; Parameters<> collapses the
  // overloads so the config is cast to the method's own parameter type.
  const accountInfoParams = [bondingCurve, { encoding: 'base64' }] as unknown as Parameters<
    SolanaRpcApi['getAccountInfo']
  >;
  const accountInfo = (await rpcCall(ctx, 'getAccountInfo', accountInfoParams, {
    priority: PRIORITY.HIGH,
  })) as { value: { data: [string, string] } | null };

  if (!accountInfo.value || !accountInfo.value.data[0]) {
    throw new Error(`Bonding curve account not found for ${targetMint}`);
  }

  const curveBuffer = Buffer.from(accountInfo.value.data[0], 'base64');
  const curve = decodePumpCurve(curveBuffer);
  if (!curve) {
    throw new Error(`Failed to decode curve for ${targetMint}`);
  }

  if (curve.isCompleted) {
    throw new Error(`Bonding curve is already completed for ${targetMint}. Trade on Raydium.`);
  }

  if (!curve.creator) {
    throw new Error(`Curve for ${targetMint} has no creator (unexpected legacy layout).`);
  }

  const tokenProgram = await getMintTokenProgram(ctx, targetMint);
  const associatedBondingCurve = address(await getAta(bondingCurve, targetMint, tokenProgram));
  const userAta = address(await getAta(walletAddress, targetMint, tokenProgram));
  const creatorVault = await derivePumpPda('creator-vault', address(curve.creator));
  const userVolumeAccumulator = await derivePumpPda(
    'user_volume_accumulator',
    address(walletAddress)
  );
  const bondingCurveV2 = await derivePumpPda('bonding-curve-v2', address(targetMint));
  // Pinned buyback fee recipient + its paired pump_fees account (override the recipient via env;
  // keep them paired). See the BUYBACK_* constants for why these aren't derived.
  const feeRecipient = process.env.PUMP_FEE_RECIPIENT
    ? address(process.env.PUMP_FEE_RECIPIENT)
    : BUYBACK_FEE_RECIPIENT;
  const feeRecipientAccount = BUYBACK_FEE_ACCOUNT;

  const inputAmount = BigInt(amount);
  let tokenAmount: bigint;
  let maxSolCost: bigint = 0n;
  let minSolOutput: bigint = 0n;

  if (isBuy) {
    // Buy token with SOL
    const fee = inputAmount / 100n; // 1% fee
    const solToTrade = inputAmount - fee;
    const k = curve.virtualSolReserves * curve.virtualTokenReserves;
    const newSolReserves = curve.virtualSolReserves + solToTrade;
    const newTokenReserves = k / newSolReserves + 1n; // Add 1 to overestimate reserves, underestimate out
    tokenAmount = curve.virtualTokenReserves - newTokenReserves;

    // maxSolCost
    maxSolCost = inputAmount + (inputAmount * BigInt(slippageBps)) / 10000n;
  } else {
    // Sell token for SOL
    tokenAmount = inputAmount;
    const k = curve.virtualSolReserves * curve.virtualTokenReserves;
    const newTokenReserves = curve.virtualTokenReserves + tokenAmount;
    const newSolReserves = k / newTokenReserves + 1n;
    const solOut = curve.virtualSolReserves - newSolReserves;
    const fee = solOut / 100n; // 1% fee
    const solOutAfterFee = solOut - fee;

    // minSolOutput
    minSolOutput = solOutAfterFee - (solOutAfterFee * BigInt(slippageBps)) / 10000n;
  }

  const data = new Uint8Array(24);
  data.set(isBuy ? BUY_DISCRIMINATOR : SELL_DISCRIMINATOR, 0);
  const view = new DataView(data.buffer);

  if (isBuy) {
    view.setBigUint64(8, tokenAmount, true); // token_amount
    view.setBigUint64(16, maxSolCost, true); // max_sol_cost
  } else {
    view.setBigUint64(8, tokenAmount, true); // token_amount
    view.setBigUint64(16, minSolOutput, true); // min_sol_output
  }

  // Account order is fixed by the program's anchor IDL and differs between buy and sell (buy carries
  // the two volume-accumulator accounts and orders token_program before creator_vault; sell omits the
  // accumulators and swaps that pair). Writable flags taken from the IDL `mut` markers.
  const keys = isBuy
    ? [
        { address: GLOBAL, role: AccountRole.READONLY },
        { address: feeRecipient, role: AccountRole.WRITABLE },
        { address: address(targetMint), role: AccountRole.READONLY },
        { address: bondingCurve, role: AccountRole.WRITABLE },
        { address: associatedBondingCurve, role: AccountRole.WRITABLE },
        { address: userAta, role: AccountRole.WRITABLE },
        { address: address(walletAddress), role: AccountRole.WRITABLE_SIGNER },
        { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
        { address: tokenProgram, role: AccountRole.READONLY },
        { address: creatorVault, role: AccountRole.WRITABLE },
        { address: EVENT_AUTHORITY, role: AccountRole.READONLY },
        { address: PUMP_FUN_PROGRAM_ID, role: AccountRole.READONLY },
        { address: GLOBAL_VOLUME_ACCUMULATOR, role: AccountRole.READONLY },
        { address: userVolumeAccumulator, role: AccountRole.WRITABLE },
        { address: FEE_CONFIG, role: AccountRole.READONLY },
        { address: FEE_PROGRAM, role: AccountRole.READONLY },
        // cashback remaining_accounts (required since the cashback upgrade)
        { address: bondingCurveV2, role: AccountRole.WRITABLE },
        { address: feeRecipientAccount, role: AccountRole.WRITABLE },
      ]
    : [
        { address: GLOBAL, role: AccountRole.READONLY },
        { address: feeRecipient, role: AccountRole.WRITABLE },
        { address: address(targetMint), role: AccountRole.READONLY },
        { address: bondingCurve, role: AccountRole.WRITABLE },
        { address: associatedBondingCurve, role: AccountRole.WRITABLE },
        { address: userAta, role: AccountRole.WRITABLE },
        { address: address(walletAddress), role: AccountRole.WRITABLE_SIGNER },
        { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
        { address: creatorVault, role: AccountRole.WRITABLE },
        { address: tokenProgram, role: AccountRole.READONLY },
        { address: EVENT_AUTHORITY, role: AccountRole.READONLY },
        { address: PUMP_FUN_PROGRAM_ID, role: AccountRole.READONLY },
        { address: FEE_CONFIG, role: AccountRole.READONLY },
        { address: FEE_PROGRAM, role: AccountRole.READONLY },
        // cashback remaining_accounts (required since the cashback upgrade)
        { address: bondingCurveV2, role: AccountRole.WRITABLE },
        { address: feeRecipientAccount, role: AccountRole.WRITABLE },
      ];

  const swapInstruction = {
    programAddress: PUMP_FUN_PROGRAM_ID,
    data,
    accounts: keys,
  };

  // The new program's buy ix does not init the user ATA (it isn't in the IDL account list), so a
  // first buy of a fresh mint must create it. Prepend an idempotent ATA create (no-op if it exists);
  // sells never need it because we already hold the token.
  const instructions = isBuy
    ? [createAtaIdempotentIx(walletAddress, targetMint, userAta, tokenProgram), swapInstruction]
    : [swapInstruction];

  const blockhashRes = await getBlockhash(ctx);

  // @solana/transaction-messages chains progressively-typed messages; the
  // manually-assembled instructions and the string blockhash are cast to each
  // function's own parameter type (no `any`, identical runtime behavior).
  const lifetimeConstraint = {
    blockhash: blockhashRes.blockhash,
    lastValidBlockHeight: blockhashRes.lastValidBlockHeight,
  } as unknown as Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0];

  const message = appendTransactionMessageInstructions(
    instructions as unknown as Parameters<typeof appendTransactionMessageInstructions>[0],
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

  return {
    transaction: wireBytes as string,
    lastValidBlockHeight: Number(blockhashRes.lastValidBlockHeight),
    outAmount: isBuy ? tokenAmount.toString() : minSolOutput.toString(),
  };
}
