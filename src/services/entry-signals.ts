import type { EvaluationResult, EntrySignals, TokenMetadata } from '#types/index.js';
import { TAPE_SIGNALS } from '#core/config.js';
import { analyzeTape } from './engine/tape-signals.js';
import { marketTapeManager } from './market-state/market-tape-manager.js';
import { getLiquidityPeak } from './market-state/pump-trade-ingest.js';

/**
 * Snapshot of what the bot could see at the moment it bought, stored on the position and copied
 * to the closed trade so rugs and winners can be compared on the same signals afterwards.
 */
export function buildEntrySignals(
  token: TokenMetadata,
  evaluation: EvaluationResult,
  now = Date.now()
): EntrySignals {
  const created = token.firstPool?.createdAt ? new Date(token.firstPool.createdAt).getTime() : NaN;
  const tape = analyzeTape(marketTapeManager.getTicks(token.id), {
    creator: token.creator,
    now,
    windowSeconds: TAPE_SIGNALS.windowSeconds,
    washWindowSeconds: TAPE_SIGNALS.washWindowSeconds,
  });
  const ms = evaluation.mintSignals;
  return {
    ageSeconds: Number.isFinite(created) ? Math.max(0, Math.round((now - created) / 1000)) : null,
    liquidityUsd: Number(token.liquidity || 0),
    liquidityPeak60sUsd: getLiquidityPeak(token.id, now - 60_000) ?? null,
    holdersKnown: ms?.holdersKnown ?? null,
    top1Share: ms?.top1Share ?? null,
    top3Share: ms?.top3Share ?? null,
    top5Share: ms?.top5Share ?? null,
    tapeTrades: tape.trades,
    tapeBuys: tape.buys,
    tapeSells: tape.sells,
    tapeUniqueBuyers: tape.uniqueBuyers,
    tapeNetInflowSol: Number(tape.netInflowSol.toFixed(3)),
    tapeRoundTripWallets: tape.roundTripWallets,
    creatorSold: tape.creatorSold,
  };
}
