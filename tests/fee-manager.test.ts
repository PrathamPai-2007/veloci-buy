'use strict';
import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import {
  computeProbabilisticTip,
  fetchDynamicPriorityFee,
  _resetFeeCacheForTest,
} from '../src/services/trading/fee-manager.js';
import { createCtx } from './_test_helpers.js';

beforeEach(() => _resetFeeCacheForTest());

const BASE = 1_000_000n; // 0.001 SOL baseline tip floor
const bigEv = 1_000_000_000n; // large EV so the cap never binds unless intended

function tip(over: Partial<Parameters<typeof computeProbabilisticTip>[1]> = {}): bigint {
  return computeProbabilisticTip(BASE, {
    confidence: 0.5,
    congestion: 0,
    expectedValueLamports: bigEv,
    isPanic: false,
    panicMultiplier: 2,
    maxFractionOfEv: 0.25,
    ...over,
  });
}

test('neutral confidence + no congestion leaves the base tip unchanged', () => {
  // factor = (0.5 + 0.5) * (1 + 0) = 1.0
  assert.equal(tip(), BASE);
});

test('higher confidence raises the tip', () => {
  assert.ok(tip({ confidence: 1 }) > tip({ confidence: 0.5 }));
  // confidence 1 → factor 1.5
  assert.equal(tip({ confidence: 1 }), 1_500_000n);
});

test('higher congestion raises the tip', () => {
  // congestion 1 → factor (1.0)*(2.0) = 2.0
  assert.equal(tip({ congestion: 1 }), 2_000_000n);
  assert.ok(tip({ congestion: 1 }) > tip({ congestion: 0 }));
});

test('panic applies the panic multiplier', () => {
  assert.equal(tip({ isPanic: true, panicMultiplier: 2 }), 2_000_000n);
});

test('tip is capped at maxFractionOfEv of expected value', () => {
  // High confidence + congestion would push tip to 1.5*2 = 3,000,000, but
  // EV cap = 0.25 * 4,000,000 = 1,000,000 binds.
  const capped = computeProbabilisticTip(BASE, {
    confidence: 1,
    congestion: 1,
    expectedValueLamports: 4_000_000n,
    isPanic: false,
    panicMultiplier: 2,
    maxFractionOfEv: 0.25,
  });
  assert.equal(capped, 1_000_000n);
});

test('tip respects the min/max clamps', () => {
  // Tiny EV cap would drive tip below the floor → clamped up to minTip.
  const tiny = computeProbabilisticTip(BASE, {
    confidence: 0.5,
    congestion: 0,
    expectedValueLamports: 1n,
    isPanic: false,
    panicMultiplier: 2,
    maxFractionOfEv: 0.25,
    minTip: 100_000n,
  });
  assert.equal(tiny, 100_000n);

  // Enormous base clamped down to maxTip.
  const huge = computeProbabilisticTip(10_000_000_000n, {
    confidence: 1,
    congestion: 1,
    expectedValueLamports: 0n, // no EV cap
    isPanic: false,
    panicMultiplier: 2,
    maxFractionOfEv: 0.25,
    maxTip: 200_000_000n,
  });
  assert.equal(huge, 200_000_000n);
});

test('non-finite confidence is treated as zero (defensive)', () => {
  assert.equal(tip({ confidence: Number.NaN }), 500_000n); // factor (0.5)*(1) = 0.5
});

test('zero expected value disables the EV cap', () => {
  // With EV cap disabled, full multiplier applies.
  assert.equal(tip({ confidence: 1, congestion: 1, expectedValueLamports: 0n }), 3_000_000n);
});

// ── fetchDynamicPriorityFee ────────────────────────────────────────────────────

// Helper: build an rpcProxy that counts getRecentPrioritizationFees calls and returns a
// simple two-entry fee array.
function makeCountingFeeRpc(fees: number[] = [30_000, 50_000, 75_000]): {
  rpc: any;
  calls: { count: number };
} {
  const calls = { count: 0 };
  const rpc = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'getRecentPrioritizationFees') {
          return (..._args: unknown[]) => ({
            send: async () => {
              calls.count++;
              return fees.map((f) => ({ prioritizationFee: f }));
            },
          });
        }
        return () => ({ send: async () => ({ value: null }) });
      },
    }
  );
  return { rpc, calls };
}

test('fetchDynamicPriorityFee: returns base fee when RPC returns empty array', async () => {
  const ctx = createCtx({ priorityFeeBaseMicroLamports: 25_000, priorityFeeAccountLocal: true });
  // Default rpcProxy returns non-array → falls through to base fee
  const fee = await fetchDynamicPriorityFee(ctx, [], false);
  assert.equal(fee, 25_000);
});

test('fetchDynamicPriorityFee: account-local path returns percentile-based fee', async () => {
  const { rpc, calls } = makeCountingFeeRpc([10_000, 50_000, 100_000]);
  const ctx = createCtx({
    priorityFeeAccountLocal: true,
    priorityFeeBaseMicroLamports: 5_000,
    priorityFeePercentile: 50,
    priorityFeeVolatilityMultiplier: 1.0,
    priorityFeeMaxMicroLamports: 5_000_000,
  });
  ctx.rpc = rpc;
  ctx.rpcs = [rpc];
  // Use a valid Solana base58 address (SOL mint)
  const fee = await fetchDynamicPriorityFee(
    ctx,
    ['So11111111111111111111111111111111111111112'],
    false
  );
  assert.equal(calls.count, 1);
  // sorted [10000, 50000, 100000], 50th percentile index = floor(0.5 * 2) = 1 → 50000
  assert.equal(fee, 50_000);
});

test('fetchDynamicPriorityFee: non-account-local caches result and skips RPC on second call', async () => {
  const { rpc, calls } = makeCountingFeeRpc([40_000, 60_000]);
  const ctx = createCtx({
    priorityFeeAccountLocal: false,
    priorityFeeBaseMicroLamports: 5_000,
    priorityFeePercentile: 75,
    priorityFeeVolatilityMultiplier: 1.0,
    priorityFeeMaxMicroLamports: 5_000_000,
  });
  ctx.rpc = rpc;
  ctx.rpcs = [rpc];

  const first = await fetchDynamicPriorityFee(ctx, [], false);
  const second = await fetchDynamicPriorityFee(ctx, [], false);

  assert.equal(calls.count, 1, 'second call should hit cache, not RPC');
  assert.equal(first, second);
});

test('fetchDynamicPriorityFee: panic=true bypasses cache and applies panicMultiplier', async () => {
  const { rpc, calls } = makeCountingFeeRpc([50_000]);
  const ctx = createCtx({
    priorityFeeAccountLocal: false,
    priorityFeeBaseMicroLamports: 5_000,
    priorityFeePercentile: 50,
    priorityFeeVolatilityMultiplier: 1.0,
    priorityFeePanicMultiplier: 3,
    priorityFeeMaxMicroLamports: 5_000_000,
  });
  ctx.rpc = rpc;
  ctx.rpcs = [rpc];

  // Populate cache first
  await fetchDynamicPriorityFee(ctx, [], false);
  assert.equal(calls.count, 1);

  // Panic call must bypass cache and apply multiplier
  const panicFee = await fetchDynamicPriorityFee(ctx, [], true);
  assert.equal(calls.count, 2, 'panic should bypass cache and call RPC again');
  // sorted [50000], index=0, baseFee = max(5000, 50000) = 50000, * panicMultiplier 3 = 150000
  assert.equal(panicFee, 150_000);
});

test('fetchDynamicPriorityFee: GMI > 0.8 applies 1.5× volatility multiplier', async () => {
  const { rpc } = makeCountingFeeRpc([40_000]);
  const ctx = createCtx({
    priorityFeeAccountLocal: true,
    priorityFeeBaseMicroLamports: 5_000,
    priorityFeePercentile: 50,
    priorityFeeVolatilityMultiplier: 1.0,
    priorityFeeMaxMicroLamports: 5_000_000,
  });
  ctx.rpc = rpc;
  ctx.rpcs = [rpc];
  ctx.calculateGMI = () => 0.9; // GMI > 0.8 → 1.5× multiplier

  const fee = await fetchDynamicPriorityFee(
    ctx,
    ['So11111111111111111111111111111111111111112'],
    false
  );
  // baseFee = max(5000, 40000) = 40000; * 1.0 (config) * 1.5 (GMI) = 60000
  assert.equal(fee, 60_000);
});

test('fetchDynamicPriorityFee: GMI 0.6–0.8 applies 1.2× volatility multiplier', async () => {
  const { rpc } = makeCountingFeeRpc([40_000]);
  const ctx = createCtx({
    priorityFeeAccountLocal: true,
    priorityFeeBaseMicroLamports: 5_000,
    priorityFeePercentile: 50,
    priorityFeeVolatilityMultiplier: 1.0,
    priorityFeeMaxMicroLamports: 5_000_000,
  });
  ctx.rpc = rpc;
  ctx.rpcs = [rpc];
  ctx.calculateGMI = () => 0.7; // 0.6 < GMI <= 0.8 → 1.2× multiplier

  const fee = await fetchDynamicPriorityFee(
    ctx,
    ['So11111111111111111111111111111111111111112'],
    false
  );
  // 40000 * 1.0 * 1.2 = 48000
  assert.equal(fee, 48_000);
});

test('fetchDynamicPriorityFee: concurrent non-panic calls share a single in-flight request', async () => {
  let rpcCallCount = 0;
  const rpc = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'getRecentPrioritizationFees') {
          return () => ({
            send: () =>
              new Promise<Array<{ prioritizationFee: number }>>((resolve) => {
                rpcCallCount++;
                // Slight delay to allow both concurrent calls to race
                setTimeout(() => resolve([{ prioritizationFee: 55_000 }]), 10);
              }),
          });
        }
        return () => ({ send: async () => ({ value: null }) });
      },
    }
  );
  const ctx = createCtx({
    priorityFeeAccountLocal: false,
    priorityFeeBaseMicroLamports: 5_000,
    priorityFeePercentile: 50,
    priorityFeeVolatilityMultiplier: 1.0,
    priorityFeeMaxMicroLamports: 5_000_000,
  });
  ctx.rpc = rpc as any;
  ctx.rpcs = [rpc as any];

  // Fire two concurrent calls — only one RPC call should hit the network
  const [fee1, fee2] = await Promise.all([
    fetchDynamicPriorityFee(ctx, [], false),
    fetchDynamicPriorityFee(ctx, [], false),
  ]);
  assert.equal(rpcCallCount, 1, 'concurrent calls must share single in-flight promise');
  assert.equal(fee1, fee2);
});
