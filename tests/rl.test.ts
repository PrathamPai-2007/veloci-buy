'use strict';
import assert from 'node:assert/strict';
import test from 'node:test';

import { RlExitOptimizer } from '../src/ml/rl-exit-optimizer.js';
import { createRlPolicy, isNativeAvailable } from '../src/ml/native.js';
import { FEATURE_DIM } from '../src/ml/features.js';
import { Config, TrainingSample } from '../src/types/index.js';

const NATIVE = isNativeAvailable();

function makeConfig(): Config {
  return {
    stopLossPct: 0.18,
    trailingStopDrawdownPct: 0.12,
    takeProfitMultiples: [1.3, 2.1],
  } as unknown as Config;
}

// Sample with a usable peak price and a volatility regime encoded at raw[10].
function makeSample(i: number, peakMult: number, vol: number): TrainingSample {
  const arr = new Array(FEATURE_DIM).fill(0);
  arr[10] = vol; // features.ts: clamp(volatilityScaler, 0, 2)
  return {
    mint: `m${i}`,
    symbol: 'S',
    label: peakMult > 1.3 ? 1 : 0,
    featuresJson: JSON.stringify(arr),
    realizedPnlUsd: 0,
    entryScore: 60,
    tpProfile: null,
    launchpad: null,
    closedAt: new Date(Date.now() + i * 1000).toISOString(),
    entryPriceUsd: 1,
    highestPriceUsd: peakMult,
  } as TrainingSample;
}

function dataset(n: number): TrainingSample[] {
  // A mix of big winners and losers across regimes.
  return Array.from({ length: n }, (_, i) =>
    makeSample(i, i % 2 === 0 ? 3.0 : 1.05, (i % 3) * 0.5)
  );
}

test('RlExitOptimizer returns null below the minimum sample count', () => {
  const opt = new RlExitOptimizer();
  assert.equal(opt.optimize(makeConfig(), dataset(5)), null);
});

test('RlExitOptimizer trains and writes in-bounds, ordered exit params', { skip: !NATIVE }, () => {
  const opt = new RlExitOptimizer();
  const config = makeConfig();
  const result = opt.optimize(config, dataset(60));
  assert.ok(result, 'should optimize with enough data');
  assert.ok(opt.getIsTrained());

  assert.ok(config.stopLossPct >= 0.05 && config.stopLossPct <= 0.35, 'stopLoss in bounds');
  assert.ok(
    config.trailingStopDrawdownPct >= 0.05 && config.trailingStopDrawdownPct <= 0.4,
    'trailing in bounds'
  );
  const [tp0, tp1] = config.takeProfitMultiples;
  assert.ok(tp0! >= 1.1 && tp0! <= 2.5, 'tp0 in bounds');
  assert.ok(tp1! >= 1.5 && tp1! <= 4.0, 'tp1 in bounds');
  assert.ok(tp1! > tp0!, 'tp1 > tp0');
});

test('RlExitOptimizer is deterministic for identical data', { skip: !NATIVE }, () => {
  const a = new RlExitOptimizer();
  const b = new RlExitOptimizer();
  const ca = makeConfig();
  const cb = makeConfig();
  a.optimize(ca, dataset(60));
  b.optimize(cb, dataset(60));
  assert.equal(ca.stopLossPct, cb.stopLossPct);
  assert.deepEqual(ca.takeProfitMultiples, cb.takeProfitMultiples);
});

test('RlExitOptimizer weights round-trip through save/load', { skip: !NATIVE }, () => {
  const opt = new RlExitOptimizer();
  opt.optimize(makeConfig(), dataset(60));

  const kv: Record<string, string> = {};
  opt.saveWeights((k, v) => {
    kv[k] = v;
  });
  const restored = new RlExitOptimizer();
  assert.equal(
    restored.loadWeights((k) => kv[k] ?? null),
    true
  );

  const c1 = makeConfig();
  const c2 = makeConfig();
  opt.apply(c1, 0.5);
  restored.apply(c2, 0.5);
  assert.equal(c1.stopLossPct, c2.stopLossPct);
  assert.deepEqual(c1.takeProfitMultiples, c2.takeProfitMultiples);
});

// Replica of the Rust reward sim (ppo.rs::sim_trade_pnl) for greedy evaluation.
function simPnl(peak: number, stake: number, sl: number, trail: number, tp0: number, tp1: number) {
  if (peak <= 1) return -sl * stake;
  let pnl = 0;
  let remaining = 1.0;
  if (peak >= tp0) {
    pnl += stake * remaining * 0.5 * (tp0 - 1);
    remaining -= 0.5;
  }
  if (peak >= tp1) {
    pnl += stake * remaining * (tp1 - 1);
    remaining = 0;
  }
  if (remaining > 0) {
    const exitMult = Math.max(1 - sl, peak * (1 - trail));
    pnl += stake * remaining * (exitMult - 1);
  }
  return pnl;
}

test('native PPO policy improves the greedy reward over training', { skip: !NATIVE }, () => {
  // Every trade reaches 3x → higher take-profit is rewarded. The trained greedy
  // policy should beat a fresh, untrained one on the same replay reward.
  const states = Array.from({ length: 50 }, () => [0.5]);
  const peakMults = Array.from({ length: 50 }, () => 3.0);
  const stakes = Array.from({ length: 50 }, () => 100);
  const min = [0.05, 0.05, 1.1, 1.5];
  const max = [0.35, 0.4, 2.5, 4.0];

  const greedyReward = (params: number[]): number => {
    const [sl, trail, tp0, tp1raw] = params as [number, number, number, number];
    const tp1 = tp1raw > tp0 ? tp1raw : tp0 + 0.1;
    return simPnl(3.0, 100, sl, trail, tp0, tp1);
  };

  const fresh = createRlPolicy(1, min, max, 7919)!;
  const before = greedyReward(fresh.predict([0.5]));

  const trained = createRlPolicy(1, min, max, 7919)!;
  trained.train(states, peakMults, stakes, 100, 4, 0.03, 0.2, 0.001, 7919);
  const after = greedyReward(trained.predict([0.5]));

  assert.ok(after > before, `trained greedy reward should beat fresh (${before} → ${after})`);
});
