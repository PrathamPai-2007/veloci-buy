import { decodeRaydiumPool } from '#core/utils.js';
import { LocalMarketSnapshot } from '../market-state.types.js';

/**
 * Decodes raw Raydium AMM V4 pool account data with base/quote vault balance updates.
 */
export function decodeRaydiumPoolState(
  mint: string,
  buffer: Buffer,
  baseVaultSolBalance: bigint,
  quoteVaultTokenBalance: bigint,
  solPriceUsd: number,
  slot = 0,
  existingSnapshot?: Partial<LocalMarketSnapshot>
): LocalMarketSnapshot | null {
  const pool = decodeRaydiumPool(buffer);
  if (!pool) return null;

  if (solPriceUsd <= 0) return null;

  const solAmount = Number(baseVaultSolBalance) / 1e9;
  const tokenAmount = Number(quoteVaultTokenBalance) / Math.pow(10, pool.quoteDecimals || 6);

  if (solAmount <= 0 || tokenAmount <= 0) return null;

  const priceUsd = (solAmount / tokenAmount) * solPriceUsd;
  const liquidityUsd = solAmount * 2 * solPriceUsd;
  const totalSupply = 1_000_000_000_000_000n; // Standard 1B token supply
  const fdvUsd = priceUsd * (Number(totalSupply) / Math.pow(10, pool.quoteDecimals || 6));

  return {
    mint,
    symbol: existingSnapshot?.symbol,
    venue: 'raydium',
    priceUsd,
    liquidityUsd,
    fdvUsd,
    totalSupply,
    updatedAt: Date.now(),
    sourceSlot: slot,
    source: existingSnapshot?.source ?? 'raydium-pool-decoder',
    rawState: pool,

    buyVolume1m: existingSnapshot?.buyVolume1m ?? 0,
    sellVolume1m: existingSnapshot?.sellVolume1m ?? 0,
    tradeCount1m: existingSnapshot?.tradeCount1m ?? 0,

    top5ConcentrationPct: existingSnapshot?.top5ConcentrationPct ?? 0,
    top10ConcentrationPct: existingSnapshot?.top10ConcentrationPct ?? 0,
    holderCount: existingSnapshot?.holderCount ?? 0,
  };
}
