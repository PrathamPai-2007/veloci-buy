import { decodeMeteoraPool } from '#core/utils.js';
import { LocalMarketSnapshot } from '../market-state.types.js';

/**
 * Decodes raw Meteora DLMM pool account data with active bin price conversion.
 *
 * Active ID bin price conversion formula:
 * Price = (1 + binStep / 10000) ^ activeId
 */
export function decodeMeteoraPoolState(
  mint: string,
  buffer: Buffer,
  solPriceUsd: number,
  solIsTokenX = true,
  slot = 0,
  existingSnapshot?: Partial<LocalMarketSnapshot>
): LocalMarketSnapshot | null {
  const pool = decodeMeteoraPool(buffer);
  if (!pool || solPriceUsd <= 0) return null;

  // Compute bin price relative to quote asset
  const factor = 1 + pool.binStep / 10000;
  const rawBinPrice = Math.pow(factor, pool.activeId);

  // If SOL is tokenX, price in SOL per token Y = rawBinPrice. Price USD = rawBinPrice * solPriceUsd
  // If SOL is tokenY, price in SOL per token X = 1 / rawBinPrice.
  const priceInSol = solIsTokenX ? rawBinPrice : 1 / rawBinPrice;
  const priceUsd = priceInSol * solPriceUsd;

  const liquidityUsd = existingSnapshot?.liquidityUsd ?? 5000; // Default estimate if reserves pending
  const totalSupply = 1_000_000_000_000_000n;
  const fdvUsd = priceUsd * 1_000_000_000;

  return {
    mint,
    symbol: existingSnapshot?.symbol,
    venue: 'meteora',
    priceUsd,
    liquidityUsd,
    fdvUsd,
    totalSupply,
    updatedAt: Date.now(),
    sourceSlot: slot,
    source: existingSnapshot?.source ?? 'meteora-pool-decoder',
    rawState: pool,

    buyVolume1m: existingSnapshot?.buyVolume1m ?? 0,
    sellVolume1m: existingSnapshot?.sellVolume1m ?? 0,
    tradeCount1m: existingSnapshot?.tradeCount1m ?? 0,

    top5ConcentrationPct: existingSnapshot?.top5ConcentrationPct ?? 0,
    top10ConcentrationPct: existingSnapshot?.top10ConcentrationPct ?? 0,
    holderCount: existingSnapshot?.holderCount ?? 0,
  };
}
