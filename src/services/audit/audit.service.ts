import { address } from '@solana/addresses';
import {
  sleep,
  rpcCall,
  fetchJson,
  ratioToPercentString,
  bigintRatioToNumber,
  runBoundedPool,
} from '#core/utils.js';
import { Context, MintSignals, RugCheckSignals, BubbleMapsSignals } from '#types/index.js';

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

/**
 * Checks if a value represents a truthy flag in the context of security API responses.
 * Handles strings like '0', 'false', 'none', and 'no' as falsy.
 * @param value - The value to check.
 * @returns True if the value is considered truthy.
 */
export function isTruthyFlag(value: unknown): boolean {
  if (value === undefined || value === null || value === '' || value === false || value === 0)
    return false;
  const normalized = String(value).trim().toLowerCase();
  return !['0', 'false', 'null', 'none', 'no'].includes(normalized);
}

/**
 * Extracts a human-readable error message from various error types.
 * @param error - The error object or message.
 * @returns A string representation of the error.
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Fetches mint-level signals from the Solana RPC.
 * Includes total supply, mint/freeze authorities, and top holder concentration.
 * Incorporates retry logic to account for RPC indexing lag on newly created tokens.
 *
 * @param ctx - The application context.
 * @param mint - The token mint address.
 * @param options - Options including RPC priority.
 * @returns A promise resolving to MintSignals.
 */
export async function getMintSignals(
  ctx: Context,
  mint: string,
  options: { priority?: number } = {}
): Promise<MintSignals> {
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
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        ],
        { priority }
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
    throw new Error(
      `RPC Indexing Lag: Mint ${mint} did not return parsed data after ${maxAttempts} attempts.`
    );
  }

  const mintInfo = parsedAccountInfo.info;
  if (!mintInfo) {
    throw new Error(
      `RPC parsed mint info missing for ${mint}; refusing to audit incomplete mint data.`
    );
  }
  let largestAccounts: {
    value: Array<{
      address: string;
      amount: string;
    }>;
  };
  attempts = 0;
  while (attempts < maxAttempts) {
    try {
      largestAccounts = (await rpcCall(
        ctx,
        'getTokenLargestAccounts',
        [
          mintAddress,
          {
            commitment: 'confirmed',
          },
        ],
        { priority }
      )) as unknown as { value: Array<{ address: string; amount: string }> };
      if (largestAccounts?.value) break;
    } catch (e) {
      const message = getErrorMessage(e);
      if (message.includes('not a Token mint') || message.includes('AccountNotFound')) {
        if (attempts === maxAttempts - 1) {
          throw new Error(`RPC Indexing Lag: ${mint} is not yet recognized as a token mint.`, {
            cause: e,
          });
        }
      } else if (attempts === maxAttempts - 1) {
        throw e;
      }
    }
    attempts++;
    if (attempts < maxAttempts) {
      await sleep(retryDelayMs * attempts);
    }
  }

  const supplyRaw = BigInt(mintInfo.supply || '0');
  const topAccountsRaw = largestAccounts!.value || [];
  const topAccounts = topAccountsRaw.slice(0, 5).map((account) => {
    const rawAmount = BigInt(account.amount || '0');
    return {
      address: account.address,
      rawAmount,
      share: bigintRatioToNumber(rawAmount, supplyRaw),
    };
  });

  const top1Share = topAccounts[0]?.share || 0;
  const top3Share = topAccounts.slice(0, 3).reduce((sum: number, a) => sum + a.share, 0);
  const top5Share = topAccounts
    .slice(0, 5)
    .reduce((sum: number, account) => sum + account.share, 0);

  const accountAddresses = topAccounts.map((a) => address(a.address));
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
        { priority, cacheTtlMs: 10000 }
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

  const ownerDetails = topAccounts.map((account, index: number) => {
    const info = ownersInfo?.value?.[index];
    if (info && info.data && typeof info.data === 'object' && 'parsed' in info.data) {
      const parsedData = info.data as { parsed?: { info?: { owner?: string } } };
      const owner = parsedData.parsed?.info?.owner || null;
      return { ...account, owner };
    }
    return { ...account, owner: null, ownerLookupError: 'Account info not found (possible lag)' };
  });

  return {
    decimals: Number(mintInfo.decimals || 0),
    supplyRaw,
    mintAuthority: mintInfo.mintAuthority || null,
    freezeAuthority: mintInfo.freezeAuthority || null,
    top1Share,
    top3Share,
    top5Share,
    topAccounts: ownerDetails,
  };
}

interface RugCheckRisk {
  name: string;
  level: 'danger' | 'warn' | string;
}

interface RugCheckReport {
  score_normalised?: number;
  risks?: RugCheckRisk[];
  rugged?: boolean;
}

/**
 * Fetches token security signals from RugCheck.xyz.
 * Covers mint/freeze authority, honeypot detection, behavioral flags, and risk scoring.
 * Requires RUGCHECK_API_KEY (free tier: 60 req/min with key, 10 req/min without).
 */
export async function fetchRugCheckSignals(ctx: Context, mint: string): Promise<RugCheckSignals> {
  const timeoutMs = 6000;
  const headers: Record<string, string> = ctx.config.rugcheckApiKey
    ? { Authorization: `Bearer ${ctx.config.rugcheckApiKey}` }
    : {};
  try {
    const url = `${ctx.config.rugcheckBaseUrl}/tokens/${mint}/report`;
    const payload = (await fetchJson(url, { headers, timeoutMs })) as RugCheckReport;

    const blockers: string[] = [];
    const notes: string[] = [];

    if (payload.rugged) {
      blockers.push('RugCheck: token previously rugged.');
    }

    for (const risk of payload.risks ?? []) {
      if (risk.level === 'danger') {
        blockers.push(`RugCheck: ${risk.name}`);
      } else if (risk.level === 'warn') {
        notes.push(`RugCheck warn: ${risk.name}`);
      }
    }

    const riskScore = payload.score_normalised ?? null;
    if (riskScore != null) notes.push(`RugCheck score: ${riskScore}`);

    return { status: 'ok', blockers, notes, riskScore, rugged: payload.rugged ?? false };
  } catch (e: unknown) {
    const message = getErrorMessage(e);
    ctx.logger(`RugCheck fetch failed for ${mint}: ${message}`, 'warn');
    return {
      status: 'error',
      blockers: [],
      notes: [],
      riskScore: null,
      rugged: false,
      error: message,
    };
  }
}

/**
 * Checks a batch of wallet addresses against RugCheck's wallet risk endpoint.
 * Returns the subset flagged as high-risk.
 */
export async function fetchRugCheckWalletSignals(
  ctx: Context,
  addresses: string[]
): Promise<string[]> {
  if (addresses.length === 0) return [];
  const headers: Record<string, string> = ctx.config.rugcheckApiKey
    ? { Authorization: `Bearer ${ctx.config.rugcheckApiKey}` }
    : {};
  const results = await runBoundedPool(
    addresses,
    async (addr) => {
      try {
        const url = `${ctx.config.rugcheckBaseUrl}/wallet/${addr}/risk`;
        const payload = (await fetchJson(url, { headers, timeoutMs: 3000 })) as {
          riskLevel?: string;
        };
        return payload.riskLevel === 'high' ? addr : null;
      } catch {
        return null;
      }
    },
    { concurrency: ctx.config.ownerAuditParallelism || 2 }
  );
  return results
    .filter((r) => r.status === 'fulfilled' && r.value !== null)
    .map((r) => r.value as string);
}

/**
 * Fetches decentralization and cluster signals from BubbleMaps.
 * Identifies large holder clusters and decentralization scores.
 *
 * @param ctx - The application context.
 * @param mint - The token mint address.
 * @returns A promise resolving to BubbleMapsSignals or null if API key is missing.
 */
export async function fetchBubbleMapsSignals(
  ctx: Context,
  mint: string,
  opts?: { isTrending?: boolean }
): Promise<BubbleMapsSignals | null> {
  if (!ctx.config.bubbleMapsApiKey) return null;
  // Trending coins get a moderately lower decentralization-score floor (cluster share is
  // left at the standard threshold, since heavy clustering is a hard rug signal).
  const minScore = opts?.isTrending
    ? ctx.config.trendingMinBubbleMapsScore
    : ctx.config.minBubbleMapsScore;
  const timeoutMs = 12000;
  try {
    const params = new URLSearchParams({
      return_clusters: 'true',
      return_decentralization_score: 'true',
      return_nodes: 'false',
      use_magic_nodes: 'true',
    });
    const url = `${ctx.config.bubbleMapsBaseUrl}/maps/solana/${mint}?${params.toString()}`;
    const payload = (await fetchJson(url, {
      headers: { 'X-ApiKey': ctx.config.bubbleMapsApiKey },
      timeoutMs,
    })) as { clusters?: Array<{ share?: number }>; decentralization_score?: number };
    const largestClusterShare =
      Array.isArray(payload?.clusters) && payload.clusters.length > 0
        ? Number(payload.clusters[0]!.share || 0)
        : null;
    const blockers: string[] = [];
    if (
      payload?.decentralization_score != null &&
      Number(payload.decentralization_score) < minScore
    ) {
      blockers.push(
        `BubbleMaps decentralization score ${payload.decentralization_score} is below ${minScore}`
      );
    }
    if (
      largestClusterShare != null &&
      largestClusterShare > ctx.config.maxBubbleMapsLargestClusterShare
    ) {
      blockers.push(
        `BubbleMaps largest cluster share ${ratioToPercentString(largestClusterShare)} is above ${ratioToPercentString(ctx.config.maxBubbleMapsLargestClusterShare)}`
      );
    }
    return {
      status: 'ok',
      blockers,
      score: payload?.decentralization_score ?? null,
      largestClusterShare,
      raw: payload,
    };
  } catch (e: unknown) {
    const message = getErrorMessage(e);
    const status = message.includes('timed out') ? 'timeout' : 'error';
    ctx.logger(`BubbleMaps skipped for ${mint} (${status}): ${message}`, 'warn');
    return { status, blockers: [], score: null, largestClusterShare: null, error: message };
  }
}

/**
 * Service object to allow for easier mocking in ESM environments.
 */
export const auditService = {
  getMintSignals,
  batchGetMintSignals,
  fetchRugCheckSignals,
  fetchRugCheckWalletSignals,
  fetchBubbleMapsSignals,
};

/**
 * Fetches mint-level signals for a batch of token mints.
 * Optimizes RPC usage by batching mint metadata and owner lookups using getMultipleAccounts.
 *
 * @param ctx - The application context.
 * @param mints - Array of token mint addresses.
 * @param options - Options including RPC priority.
 * @returns A promise resolving to a Map of mint address to MintSignals.
 */
export async function batchGetMintSignals(
  ctx: Context,
  mints: string[],
  options: { priority?: number } = {}
): Promise<Map<string, MintSignals>> {
  if (mints.length === 0) return new Map();

  const priority = options.priority;
  const uniqueMints = Array.from(new Set(mints));
  const mintAddresses = uniqueMints.map((m) => address(m));
  const maxAttempts = Math.max(1, Math.floor(Number(ctx.config.mintSignalMaxAttempts || 3)));
  const retryDelayMs = Math.max(1, Math.floor(Number(ctx.config.mintSignalRetryDelayMs || 750)));

  // Step 1: Batch fetch mint metadata
  let mintsData: { value: Array<{ data: unknown } | null> } | null = null;
  let attempts = 0;
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
        { priority }
      )) as { value: Array<{ data: unknown } | null> };
      if (mintsData?.value) break;
    } catch (e) {
      if (attempts === maxAttempts - 1) throw e;
    }
    attempts++;
    if (attempts < maxAttempts) await sleep(retryDelayMs * attempts);
  }

  const results = new Map<string, MintSignals>();
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

  // Step 2: Fetch largest accounts for all valid mints in parallel
  const largestAccountsMap = new Map<string, { address: string; amount: string }[]>();
  await runBoundedPool(
    validMints,
    async ({ mint }) => {
      let lAttempts = 0;
      while (lAttempts < maxAttempts) {
        try {
          const resp = (await rpcCall(
            ctx,
            'getTokenLargestAccounts',
            [address(mint), { commitment: 'confirmed' }],
            { priority }
          )) as unknown as { value: Array<{ address: string; amount: string }> };
          if (resp?.value) {
            largestAccountsMap.set(mint, resp.value);
            break;
          }
        } catch (e) {
          if (lAttempts === maxAttempts - 1) {
            ctx.logger(`Failed to get largest accounts for ${mint}: ${getErrorMessage(e)}`, 'warn');
          }
        }
        lAttempts++;
        if (lAttempts < maxAttempts) await sleep(retryDelayMs * lAttempts);
      }
    },
    { concurrency: ctx.config.ownerAuditParallelism || 5 }
  );

  // Step 3: Collect all unique holder addresses for owner lookups
  const allHolders = new Set<string>();
  const mintToHolders = new Map<string, { address: string; rawAmount: bigint; share: number }[]>();

  for (const { mint, info } of validMints) {
    const holdersRaw = largestAccountsMap.get(mint) || [];
    const supplyRaw = BigInt(info.supply || '0');
    const holders = holdersRaw.slice(0, 5).map((h) => {
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

  // Step 4: Batch fetch owner info for all identified holders
  const holderAddresses = Array.from(allHolders).map((h) => address(h));
  const ownerMap = new Map<string, string | null>();

  // Split into chunks of 100 if necessary
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
          { priority, cacheTtlMs: 10000 }
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

  // Step 5: Finalize results
  for (const { mint, info } of validMints) {
    const holders = mintToHolders.get(mint) || [];
    const topAccounts = holders.map((h) => ({
      ...h,
      owner: ownerMap.get(h.address) || null,
    }));

    results.set(mint, {
      decimals: Number(info.decimals || 0),
      supplyRaw: BigInt(info.supply || '0'),
      mintAuthority: info.mintAuthority || null,
      freezeAuthority: info.freezeAuthority || null,
      top1Share: topAccounts[0]?.share || 0,
      top3Share: topAccounts.slice(0, 3).reduce((sum, h) => sum + h.share, 0),
      top5Share: topAccounts.reduce((sum, h) => sum + h.share, 0),
      topAccounts,
    });
  }

  return results;
}
