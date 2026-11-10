/* eslint-disable @typescript-eslint/no-explicit-any */
import { address } from '@solana/addresses';
import { sleep, rpcCall, bigintRatioToNumber, derivePumpCurvePda } from '#core/utils.js';
import { Context, MintSignals } from '#types/index.js';
import { tokenAccountIndex } from '#services/account-index/index.js';

interface ParsedMintInfo {
  decimals: number;
  supply: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  type?: string;
}

interface ParsedAccountInfo {
  info: ParsedMintInfo;
  type: string;
}

interface ParsedData {
  parsed: ParsedAccountInfo;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Holders reported in MintSignals. One extra is fetched so dropping the bonding curve leaves 5. */
const TOP_HOLDER_COUNT = 5;
const TOP_HOLDER_FETCH = TOP_HOLDER_COUNT + 1;

/** Drops token accounts owned by the pump.fun bonding-curve PDA (`''` = unknown, keep all). */
export function dropCurveAccounts<T extends { owner?: string | null }>(
  accounts: T[],
  curvePda: string
): T[] {
  return curvePda ? accounts.filter((a) => a.owner !== curvePda) : accounts;
}

function concentrationShares(accounts: { share: number }[]): {
  top1Share: number;
  top3Share: number;
  top5Share: number;
} {
  const sum = (n: number): number => accounts.slice(0, n).reduce((s, a) => s + a.share, 0);
  return { top1Share: accounts[0]?.share || 0, top3Share: sum(3), top5Share: sum(5) };
}

// In-memory TTL cache for MintSignals (avoids re-querying same mint across survival→final audit)
const MINT_SIGNALS_TTL_MS = 180_000;
const mintSignalsCache = new Map<string, { signals: MintSignals; expiresAt: number }>();

function getCachedMintSignals(mint: string): MintSignals | null {
  const e = mintSignalsCache.get(mint);
  if (!e) return null;
  if (Date.now() > e.expiresAt) {
    mintSignalsCache.delete(mint);
    return null;
  }
  return e.signals;
}

function setCachedMintSignals(mint: string, signals: MintSignals): void {
  mintSignalsCache.set(mint, { signals, expiresAt: Date.now() + MINT_SIGNALS_TTL_MS });
}

export async function getMintSignals(
  ctx: Context,
  mint: string,
  options: { priority?: number; skipCache?: boolean } = {}
): Promise<MintSignals> {
  const normalizedMint = mint.trim();
  if (!options.skipCache) {
    const cached = getCachedMintSignals(normalizedMint);
    if (cached) return cached;
  }
  // Validate base58 mint pubkey string before issuing any RPC calls
  if (!tokenAccountIndex.isValidBase58Mint(normalizedMint)) {
    ctx.store?.incrementMetric('invalidMintSkips', 1);
    throw new Error(`Invalid Mint Parameter: "${mint}" is not a valid Solana base58 address.`);
  }

  mint = normalizedMint;
  const priority = options.priority;
  const mintAddress = address(mint);
  let parsedAccountInfo: ParsedAccountInfo | null = null;
  let attempts = 0;
  const maxAttempts = Math.max(1, Math.floor(Number(ctx.config.mintSignalMaxAttempts || 3)));
  const retryDelayMs = Math.max(1, Math.floor(Number(ctx.config.mintSignalRetryDelayMs || 750)));

  while (attempts < maxAttempts) {
    try {
      const response = await rpcCall(
        ctx,
        'getAccountInfo',
        [
          mintAddress,
          {
            encoding: 'jsonParsed',
            commitment: 'confirmed',
          } as any,
        ],
        // Single attempt: the surrounding mintSignalMaxAttempts loop is the only retry budget.
        { priority, maxAttempts: 1 }
      );
      const value = response?.value;
      if (
        value &&
        typeof value.data === 'object' &&
        value.data !== null &&
        'parsed' in value.data
      ) {
        const data = value.data as ParsedData;
        if (data.parsed?.info?.type === 'mint' || data.parsed?.type === 'mint') {
          parsedAccountInfo = data.parsed;
          break;
        }
      }
    } catch (e) {
      if (attempts === maxAttempts - 1) throw e;
    }
    attempts++;
    if (attempts < maxAttempts) {
      await sleep(retryDelayMs * attempts);
    }
  }

  if (!parsedAccountInfo) {
    ctx.store?.incrementMetric('invalidMintSkips', 1);
    throw new Error(
      `RPC Indexing Lag / Non-Mint Account: Mint ${mint} did not return parsed mint data after ${maxAttempts} attempts.`
    );
  }

  const mintInfo = parsedAccountInfo.info;
  if (!mintInfo) {
    throw new Error(
      `RPC parsed mint info missing for ${mint}; refusing to audit incomplete mint data.`
    );
  }
  const supplyRaw = BigInt(mintInfo.supply || '0');

  // Local-First: Initialize holder snapshot if not indexed, then read from tokenAccountIndex
  if (!tokenAccountIndex.isIndexed(mint)) {
    await tokenAccountIndex.initializeMintSnapshot(ctx, mint, supplyRaw, 'getMintSignals');
  }

  const indexedHolders = tokenAccountIndex.getTopHolders(mint, TOP_HOLDER_FETCH);
  const topAccountsRaw: Array<{ address: string; amount: string }> = indexedHolders.map((h) => ({
    address: h.tokenAccount,
    amount: h.amount.toString(),
  }));

  const topAccounts = topAccountsRaw.slice(0, TOP_HOLDER_FETCH).map((account) => {
    const rawAmount = BigInt(account.amount || '0');
    return {
      address: account.address,
      rawAmount,
      share: bigintRatioToNumber(rawAmount, supplyRaw),
    };
  });

  const accountAddresses = topAccounts.flatMap((a) => {
    try {
      return [address(a.address)];
    } catch {
      return [];
    }
  });
  let ownersInfo: {
    value: Array<{
      data: unknown;
    } | null>;
  } | null = null;

  attempts = 0;
  while (attempts < maxAttempts) {
    try {
      ownersInfo = (await rpcCall(
        ctx,
        'getMultipleAccounts',
        [
          accountAddresses,
          {
            encoding: 'jsonParsed',
            commitment: 'confirmed',
          },
        ],
        { priority, cacheTtlMs: 60000, maxAttempts: 1 }
      )) as { value: Array<{ data: unknown } | null> };
      if (ownersInfo?.value) break;
    } catch (e) {
      if (attempts === maxAttempts - 1) {
        ctx.logger(`getMultipleAccounts failed for ${mint}: ${getErrorMessage(e)}`, 'warn');
      }
    }
    attempts++;
    if (attempts < maxAttempts) {
      await sleep(retryDelayMs * attempts);
    }
  }

  const allOwnerDetails = topAccounts.map((account, index: number) => {
    const info = ownersInfo?.value?.[index];
    if (info && info.data && typeof info.data === 'object' && 'parsed' in info.data) {
      const parsedData = info.data as { parsed?: { info?: { owner?: string } } };
      const owner = parsedData.parsed?.info?.owner || null;
      return { ...account, owner };
    }
    return { ...account, owner: null, ownerLookupError: 'Account info not found (possible lag)' };
  });

  // The bonding curve's own token account is the largest "holder" of every fresh pump.fun mint;
  // it is liquidity, not a wallet, so concentration is measured over real holders only.
  const ownerDetails = dropCurveAccounts(allOwnerDetails, await derivePumpCurvePda(mint)).slice(
    0,
    TOP_HOLDER_COUNT
  );
  const signals: MintSignals = {
    decimals: Number(mintInfo.decimals || 0),
    supplyRaw,
    mintAuthority: mintInfo.mintAuthority || null,
    freezeAuthority: mintInfo.freezeAuthority || null,
    ...concentrationShares(ownerDetails),
    topAccounts: ownerDetails,
  };
  setCachedMintSignals(mint, signals);
  return signals;
}

export async function batchGetMintSignals(
  ctx: Context,
  mints: string[],
  options: { priority?: number; skipCache?: boolean } = {}
): Promise<Map<string, MintSignals>> {
  if (mints.length === 0) return new Map();
  const startTs = Date.now();

  const priority = options.priority;
  // Normalize and handle cache for batch path
  const normalizedInput = mints.map((m) => m.trim());
  const results = new Map<string, MintSignals>();
  let uniqueMints: string[];
  if (!options.skipCache) {
    uniqueMints = [];
    for (const m of new Set(normalizedInput)) {
      const cached = getCachedMintSignals(m);
      if (cached) results.set(m, cached);
      else uniqueMints.push(m);
    }
    if (uniqueMints.length === 0) return results;
  } else {
    uniqueMints = Array.from(new Set(normalizedInput));
  }
  const mintAddresses = uniqueMints.map((m) => address(m));
  const maxAttempts = Math.max(1, Math.floor(Number(ctx.config.mintSignalMaxAttempts || 3)));
  const retryDelayMs = Math.max(1, Math.floor(Number(ctx.config.mintSignalRetryDelayMs || 750)));

  let mintsData: { value: Array<{ data: unknown } | null> } | null = null;
  let attempts = 0;
  ctx.store?.incrementMetric('batchOwnerLookupRequests', 1);

  while (attempts < maxAttempts) {
    try {
      mintsData = (await rpcCall(
        ctx,
        'getMultipleAccounts',
        [
          mintAddresses,
          {
            encoding: 'jsonParsed',
            commitment: 'confirmed',
          },
        ],
        { priority, maxAttempts: 1 }
      )) as { value: Array<{ data: unknown } | null> };
      if (mintsData?.value) break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('429')) {
        ctx.store?.incrementMetric('batchOwnerLookup429s', 1);
      }
      if (attempts === maxAttempts - 1) throw e;
    }
    attempts++;
    if (attempts < maxAttempts) await sleep(retryDelayMs * attempts);
  }

  const validMints: { mint: string; info: ParsedMintInfo }[] = [];

  mintsData?.value.forEach((val, idx) => {
    const mint = uniqueMints[idx]!;
    if (val && typeof val.data === 'object' && val.data !== null && 'parsed' in val.data) {
      const data = val.data as ParsedData;
      const info = data.parsed?.info || (data.parsed as unknown as ParsedAccountInfo).info;
      if (info && (data.parsed?.type === 'mint' || data.parsed?.info?.type === 'mint')) {
        validMints.push({ mint, info });
      }
    }
  });

  if (validMints.length === 0) return results;

  const largestAccountsMap = new Map<string, { address: string; amount: string }[]>();
  for (const { mint, info } of validMints) {
    const supplyRaw = BigInt(info.supply || '0');
    if (!tokenAccountIndex.isIndexed(mint)) {
      await tokenAccountIndex.initializeMintSnapshot(ctx, mint, supplyRaw, 'batchGetMintSignals');
    }
    const holders = tokenAccountIndex.getTopHolders(mint, TOP_HOLDER_FETCH).map((h) => ({
      address: h.tokenAccount,
      amount: h.amount.toString(),
    }));
    if (holders.length > 0) {
      largestAccountsMap.set(mint, holders);
    }
  }

  const allHolders = new Set<string>();
  const mintToHolders = new Map<string, { address: string; rawAmount: bigint; share: number }[]>();

  for (const { mint, info } of validMints) {
    const holdersRaw = largestAccountsMap.get(mint) || [];
    const supplyRaw = BigInt(info.supply || '0');
    const holders = holdersRaw.slice(0, TOP_HOLDER_FETCH).map((h) => {
      const rawAmount = BigInt(h.amount || '0');
      allHolders.add(h.address);
      return {
        address: h.address,
        rawAmount,
        share: bigintRatioToNumber(rawAmount, supplyRaw),
      };
    });
    mintToHolders.set(mint, holders);
  }

  const holderAddresses = Array.from(allHolders).map((h) => address(h));
  const ownerMap = new Map<string, string | null>();

  const CHUNK_SIZE = 100;
  for (let i = 0; i < holderAddresses.length; i += CHUNK_SIZE) {
    const chunk = holderAddresses.slice(i, i + CHUNK_SIZE);
    let oAttempts = 0;
    while (oAttempts < maxAttempts) {
      try {
        const ownersInfo = (await rpcCall(
          ctx,
          'getMultipleAccounts',
          [chunk, { encoding: 'jsonParsed', commitment: 'confirmed' }],
          { priority, cacheTtlMs: 60000, maxAttempts: 1 }
        )) as { value: Array<{ data: unknown } | null> };

        ownersInfo?.value.forEach((val, idx) => {
          const holderAddr = chunk[idx]!;
          if (val && val.data && typeof val.data === 'object' && 'parsed' in val.data) {
            const parsedData = val.data as { parsed?: { info?: { owner?: string } } };
            ownerMap.set(holderAddr, parsedData.parsed?.info?.owner || null);
          } else {
            ownerMap.set(holderAddr, null);
          }
        });
        break;
      } catch (e) {
        if (oAttempts === maxAttempts - 1) {
          ctx.logger(`Batch owner lookup failed: ${getErrorMessage(e)}`, 'warn');
        }
      }
      oAttempts++;
      if (oAttempts < maxAttempts) await sleep(retryDelayMs * oAttempts);
    }
  }

  for (const { mint, info } of validMints) {
    const holders = mintToHolders.get(mint) || [];
    const topAccounts = dropCurveAccounts(
      holders.map((h) => ({
        ...h,
        owner: ownerMap.get(h.address) || null,
      })),
      await derivePumpCurvePda(mint)
    ).slice(0, TOP_HOLDER_COUNT);

    const signals: MintSignals = {
      decimals: Number(info.decimals || 0),
      supplyRaw: BigInt(info.supply || '0'),
      mintAuthority: info.mintAuthority || null,
      freezeAuthority: info.freezeAuthority || null,
      ...concentrationShares(topAccounts),
      topAccounts,
    };
    setCachedMintSignals(mint, signals);
    results.set(mint, signals);
  }

  ctx.store?.incrementMetric('batchAuditDurationMs', Date.now() - startTs);
  return results;
}
