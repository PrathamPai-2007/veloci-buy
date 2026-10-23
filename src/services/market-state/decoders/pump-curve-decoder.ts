import { decodePumpCurve } from '#core/utils.js';
import { LocalMarketSnapshot } from '../market-state.types.js';

/**
 * Decodes raw Pump.fun bonding curve account data and computes price/liquidity.
 *
 * Price formula: (virtualSolReserves / 1e9) / (virtualTokenReserves / 1e6) * solPriceUsd
 * Liquidity formula: (realSolReserves / 1e9) * 2 * solPriceUsd
 */
export function decodePumpCurveState(
  mint: string,
  buffer: Buffer,
  solPriceUsd: number,
  slot = 0,
  existingSnapshot?: Partial<LocalMarketSnapshot>
): LocalMarketSnapshot | null {
  const curve = decodePumpCurve(buffer);
  if (!curve) return null;

  const vToken = Number(curve.virtualTokenReserves) / 1e6;
  const vSol = Number(curve.virtualSolReserves) / 1e9;
  if (vToken === 0 || vSol === 0 || solPriceUsd <= 0) return null;

  const priceUsd = (vSol / vToken) * solPriceUsd;
  const rSol = Number(curve.realSolReserves) / 1e9;
  const liquidityUsd = rSol * 2 * solPriceUsd;
  const totalSupply = curve.totalSupply > 0n ? curve.totalSupply : 1_000_000_000_000_000n; // 1B tokens default
  const fdvUsd = priceUsd * (Number(totalSupply) / 1e6);

  return {
    mint,
    symbol: existingSnapshot?.symbol,
    venue: 'pumpfun',
    priceUsd,
    liquidityUsd,
    fdvUsd,
    totalSupply,
    updatedAt: Date.now(),
    sourceSlot: slot,
    source: existingSnapshot?.source ?? 'pump-curve-decoder',
    status: existingSnapshot?.status ?? 'authoritative',
    rawState: curve,

    buyVolume1m: existingSnapshot?.buyVolume1m ?? 0,
    sellVolume1m: existingSnapshot?.sellVolume1m ?? 0,
    tradeCount1m: existingSnapshot?.tradeCount1m ?? 0,

    top5ConcentrationPct: existingSnapshot?.top5ConcentrationPct ?? 0,
    top10ConcentrationPct: existingSnapshot?.top10ConcentrationPct ?? 0,
    holderCount: existingSnapshot?.holderCount ?? 0,
  };
}
