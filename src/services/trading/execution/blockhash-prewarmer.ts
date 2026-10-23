import { Context } from '#types/index.js';
import { rpcCall, PRIORITY } from '#core/utils.js';

let _bh: { blockhash: string; lastValidBlockHeight: bigint; ts: number } | null = null;
const BLOCKHASH_CACHE_TTL_MS = 350;

export function startBlockhashPrewarmer(ctx: Context): ReturnType<typeof setInterval> {
  return setInterval(() => {
    void rpcCall(ctx, 'getLatestBlockhash', [{ commitment: 'confirmed' }], {
      priority: PRIORITY.HIGH,
    })
      .then((r) => {
        const v = (r as { value: { blockhash: string; lastValidBlockHeight: bigint | number } })
          .value;
        _bh = {
          blockhash: v.blockhash,
          lastValidBlockHeight: BigInt(v.lastValidBlockHeight),
          ts: Date.now(),
        };
      })
      .catch(() => {});
  }, 300);
}

export async function getBlockhash(
  ctx: Context
): Promise<{ blockhash: string; lastValidBlockHeight: bigint }> {
  if (_bh && Date.now() - _bh.ts < BLOCKHASH_CACHE_TTL_MS) {
    return { blockhash: _bh.blockhash, lastValidBlockHeight: _bh.lastValidBlockHeight };
  }
  const r = (await rpcCall(ctx, 'getLatestBlockhash', [{ commitment: 'confirmed' }], {
    priority: PRIORITY.HIGH,
  })) as unknown as { value: { blockhash: string; lastValidBlockHeight: bigint } };
  return {
    blockhash: r.value.blockhash,
    lastValidBlockHeight: BigInt(r.value.lastValidBlockHeight),
  };
}
