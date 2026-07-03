import { Context, SwapOrder } from '#types/index.js';
import { buildPumpFunSwap } from './adapters/pumpfun.js';
import { buildRaydiumSwap } from './adapters/raydium.js';
import { buildMeteoraSwap } from './adapters/meteora.js';

export interface RaydiumPool {
  baseVault: string;
  quoteVault: string;
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  nonce: number;
  needTakePnlCoin: bigint;
  needTakePnlPc: bigint;
}

export interface MeteoraPool {
  tokenXMint: string;
  tokenYMint: string;
  reserveX: string;
  reserveY: string;
  activeId: number;
  binStep: number;
  baseFactor: number;
}

export type CachedPoolConfig = RaydiumPool | MeteoraPool;

export const poolConfigsCache = new Map<string, CachedPoolConfig>();

// Mint → timestamp when migration was detected (bonding curve gone, token graduated to Raydium).
// Used by the monitor to suppress rug-exit / stop-loss retries during the Raydium pool settle window.
export const migrationCooldowns = new Map<string, number>();

export async function buildLocalSwapTransaction(
  ctx: Context,
  inputMint: string,
  outputMint: string,
  amount: bigint | string,
  slippageBps: number
): Promise<SwapOrder | null> {
  const isBuy = inputMint === 'So11111111111111111111111111111111111111112';
  const targetMint = isBuy ? outputMint : inputMint;

  const cachedData =
    ctx.state.marketSnapshots.get(targetMint) || ctx.state.positions.get(targetMint);
  const launchpad = cachedData?.launchpad;
  const isPumpFun = launchpad === 'pump.fun' || targetMint.endsWith('pump');

  if (isPumpFun) {
    try {
      ctx.logger(`Attempting local routing for Pump.fun token ${targetMint}`, 'debug');
      return await buildPumpFunSwap(ctx, inputMint, outputMint, amount, slippageBps);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger(`Local routing failed for ${targetMint}, falling back: ${msg}`, 'warn');
      if (msg.includes('Bonding curve account not found')) {
        migrationCooldowns.set(targetMint, Date.now());
      }
      return null;
    }
  }

  const poolAddress = ctx.state.mintToPool.get(targetMint);

  if (launchpad === 'raydium' && poolAddress) {
    try {
      ctx.logger(`Attempting local routing for Raydium token ${targetMint}`, 'debug');
      return await buildRaydiumSwap(ctx, poolAddress, inputMint, outputMint, amount, slippageBps);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger(`Local Raydium routing failed for ${targetMint}, falling back: ${msg}`, 'warn');
      return null;
    }
  }

  if (launchpad === 'meteora' && poolAddress) {
    try {
      ctx.logger(`Attempting local routing for Meteora token ${targetMint}`, 'debug');
      return await buildMeteoraSwap(ctx, poolAddress, inputMint, outputMint, amount, slippageBps);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger(`Local Meteora routing failed for ${targetMint}, falling back: ${msg}`, 'warn');
      return null;
    }
  }

  return null;
}
