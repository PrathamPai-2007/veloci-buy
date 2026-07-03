/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
import { address, getProgramDerivedAddress, getAddressEncoder } from '@solana/addresses';
import {
  getBase64EncodedWireTransaction,
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
import { Context } from '#types/index.js';
import { rpcCall, atomicToDecimalString, PRIORITY } from '#core/utils.js';

export interface WalletBalance {
  mint: string;
  rawAmount: bigint;
  decimals: number;
  uiAmount: number;
}

interface TokenAccountInfo {
  value: Array<{
    account: {
      data: {
        parsed: {
          info: {
            tokenAmount: {
              amount: string;
              decimals: number;
            };
          };
        };
      };
    };
  }>;
}

interface TokenAccountWithMint {
  value: Array<{
    account: {
      data: {
        parsed: {
          info: {
            mint: string;
            tokenAmount: {
              amount: string;
              decimals: number;
            };
          };
        };
      };
    };
  }>;
}

export async function getWalletAddress(ctx: Context): Promise<string> {
  const walletAddress = ctx.wallet?.address;
  if (!walletAddress) throw new Error('Wallet address is unavailable.');
  return walletAddress;
}

export async function getWalletTokenBalance(
  ctx: Context,
  mint: string,
  priority: PRIORITY = PRIORITY.MEDIUM
): Promise<WalletBalance> {
  if (ctx.config.paperTrading) {
    const pos = ctx.state.positions.get(mint);
    // Report the *remaining* paper balance, not the original purchase amount.
    // lastKnownBalanceRaw is the running balance decremented after each partial
    // sell; falling back to initialTokenAmountRaw covers a fresh position that
    // has not sold yet. Returning the full initial amount here let the exit
    // guards re-sell the same tranche every monitor tick, inflating proceeds and
    // turning losing trades into phantom profits.
    const raw = BigInt(pos?.lastKnownBalanceRaw ?? pos?.initialTokenAmountRaw ?? '0');
    const dec = Number(pos?.decimals || 0);
    return {
      mint,
      rawAmount: raw,
      decimals: dec,
      uiAmount: Number(atomicToDecimalString(raw, dec, 9)),
    };
  }
  const res = (await rpcCall(
    ctx,
    'getTokenAccountsByOwner',
    [
      address(await getWalletAddress(ctx)),
      { mint: address(mint) },
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ],
    { priority }
  )) as unknown as TokenAccountInfo;

  let raw = 0n;
  let dec = 0;
  for (const acc of res.value || []) {
    const info = acc.account.data?.parsed?.info?.tokenAmount;
    if (info?.amount) {
      raw += BigInt(info.amount);
      dec = Number(info.decimals);
    }
  }
  return {
    mint,
    rawAmount: raw,
    decimals: dec,
    uiAmount: Number(atomicToDecimalString(raw, dec, 9)),
  };
}

export async function getAllWalletTokenBalances(
  ctx: Context,
  priority: PRIORITY = PRIORITY.MEDIUM
): Promise<Map<string, WalletBalance>> {
  const map = new Map<string, WalletBalance>();

  if (ctx.config.paperTrading) {
    for (const [mint, pos] of ctx.state.positions) {
      const raw = BigInt(pos.lastKnownBalanceRaw ?? pos.initialTokenAmountRaw ?? '0');
      const dec = Number(pos.decimals || 0);
      map.set(mint, {
        mint,
        rawAmount: raw,
        decimals: dec,
        uiAmount: Number(atomicToDecimalString(raw, dec, 9)),
      });
    }
    return map;
  }

  const { SPL_TOKEN_PROGRAM_IDS } = await import('../../core/constants.js');
  const walletAddr = address(await getWalletAddress(ctx));

  const results = await Promise.all(
    SPL_TOKEN_PROGRAM_IDS.map(
      (programId) =>
        rpcCall(
          ctx,
          'getTokenAccountsByOwner',
          [
            walletAddr,
            { programId: address(programId) },
            { encoding: 'jsonParsed', commitment: 'confirmed' },
          ],
          { priority }
        ) as unknown as Promise<TokenAccountWithMint>
    )
  );

  for (const res of results) {
    for (const entry of res.value || []) {
      const info = entry.account.data?.parsed?.info;
      if (!info?.mint) continue;
      const amount = info.tokenAmount?.amount;
      const decimals = Number(info.tokenAmount?.decimals ?? 0);
      if (!amount) continue;
      const raw = BigInt(amount);
      const existing = map.get(info.mint);
      const combined = (existing?.rawAmount ?? 0n) + raw;
      map.set(info.mint, {
        mint: info.mint,
        rawAmount: combined,
        decimals,
        uiAmount: Number(atomicToDecimalString(combined, decimals, 9)),
      });
    }
  }

  return map;
}

export async function getSolBalance(
  ctx: Context,
  priority: PRIORITY = PRIORITY.HIGH
): Promise<bigint> {
  const walletAddr = await getWalletAddress(ctx);
  const res = (await rpcCall(
    ctx,
    'getBalance',
    [address(walletAddr), { commitment: 'confirmed' }],
    { priority }
  )) as unknown as { value: bigint };
  return BigInt(res.value);
}

export async function closeAssociatedTokenAccount(
  ctx: Context,
  mint: string,
  priority: PRIORITY = PRIORITY.HIGH
): Promise<string | null> {
  try {
    const walletAddr = await getWalletAddress(ctx);
    let ownerAddress, mintAddress;
    try {
      ownerAddress = address(walletAddr);
      mintAddress = address(mint);
    } catch {
      ctx.logger(`Invalid address provided to close ATA: ${walletAddr} or ${mint}`, 'debug');
      return null;
    }
    let tokenProgramId = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') as any;
    try {
      const mintInfo = (await rpcCall(
        ctx,
        'getAccountInfo',
        [mintAddress, { encoding: 'base64', commitment: 'confirmed' } as any],
        { priority }
      )) as unknown as { value: { owner: string } | null };
      if (mintInfo?.value?.owner) {
        tokenProgramId = address(mintInfo.value.owner);
      }
    } catch (err: unknown) {
      ctx.logger(
        `Failed to fetch owner program for mint ${mint}: ${err instanceof Error ? err.message : String(err)}. Defaulting to standard token program.`,
        'debug'
      );
    }
    const ataProgramId = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

    const [ataAddress] = await getProgramDerivedAddress({
      programAddress: ataProgramId,
      seeds: [
        getAddressEncoder().encode(ownerAddress),
        getAddressEncoder().encode(tokenProgramId),
        getAddressEncoder().encode(mintAddress),
      ],
    });

    const blockhashRes = (await rpcCall(ctx, 'getLatestBlockhash', [{ commitment: 'confirmed' }], {
      priority,
    })) as unknown as { value: { blockhash: string; lastValidBlockHeight: bigint } };
    const blockhash = blockhashRes.value.blockhash;
    const lastValidBlockHeight = BigInt(blockhashRes.value.lastValidBlockHeight);

    const closeInstruction = {
      programAddress: tokenProgramId,
      accounts: [
        { address: ataAddress, role: AccountRole.WRITABLE },
        { address: ownerAddress, role: AccountRole.WRITABLE },
        { address: ownerAddress, role: AccountRole.WRITABLE_SIGNER },
      ],
      data: new Uint8Array([9]),
    };

    let message = createTransactionMessage({ version: 0 });
    message = setTransactionMessageFeePayer(ownerAddress, message);
    message = setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: blockhash as unknown as Parameters<
          typeof setTransactionMessageLifetimeUsingBlockhash
        >[0]['blockhash'],
        lastValidBlockHeight,
      },
      message
    );
    message = appendTransactionMessageInstruction(closeInstruction, message as any) as any;

    const compiledTransaction = compileTransaction(message as any);
    const keypairObj = ctx.wallet.keypair;
    if (!keypairObj) {
      throw new Error('Wallet keypair is not configured/available.');
    }

    let cryptoKeyPair: unknown;
    if (typeof keypairObj === 'object' && keypairObj !== null && 'keyPair' in keypairObj) {
      cryptoKeyPair = (keypairObj as { keyPair: unknown }).keyPair;
    } else {
      cryptoKeyPair = keypairObj;
    }

    const signedTransaction = await signTransaction(
      [cryptoKeyPair as Parameters<typeof signTransaction>[0][number]],
      compiledTransaction as Parameters<typeof signTransaction>[1]
    );

    const wireTransactionBase64 = getBase64EncodedWireTransaction(signedTransaction);

    const sig = (await rpcCall(
      ctx,
      'sendTransaction',
      [
        wireTransactionBase64 as any,
        {
          encoding: 'base64',
          maxRetries: 3n,
          preflightCommitment: 'confirmed',
          skipPreflight: false,
        },
      ],
      { priority }
    )) as string;

    ctx.logger(`Reclaimed ATA rent for ${mint}. Closed ATA ${ataAddress} in tx ${sig}.`, 'info');
    return sig;
  } catch (err: unknown) {
    ctx.logger(
      `Failed to close ATA for ${mint}: ${err instanceof Error ? err.message : String(err)}`,
      'error'
    );
    return null;
  }
}
