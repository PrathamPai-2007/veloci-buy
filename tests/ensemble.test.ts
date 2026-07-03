'use strict';
import assert from 'node:assert/strict';
import test from 'node:test';

import { EnsembleModel, bucketFor } from '../src/ml/ensemble-model.js';
import { FEATURE_DIM } from '../src/ml/features.js';
import { buildSequence } from '../src/ml/sequence-features.js';
import { TrainingSample } from '../src/types/index.js';

const NATIVE = new EnsembleModel(1).nativeAvailable();

test('bucketFor maps launchpads to DEX buckets', () => {
  assert.equal(bucketFor('pump.fun'), 'pumpfun');
  assert.equal(bucketFor('PumpFun'), 'pumpfun');
  assert.equal(bucketFor('raydium'), 'raydium');
  assert.equal(bucketFor('Raydium AMM'), 'raydium');
  assert.equal(bucketFor('meteora'), 'default');
  assert.equal(bucketFor(null), 'default');
  assert.equal(bucketFor(undefined), 'default');
});

function historyFor(label: 0 | 1): { price: number; timestamp: number }[] {
  return Array.from({ length: 6 }, (_, t) => ({
    price: label === 1 ? 1 + t * 0.15 : 1.9 - t * 0.15,
    timestamp: t * 1000,
  }));
}

function makeSamples(n: number, launchpad: string): TrainingSample[] {
  return Array.from({ length: n }, (_, i) => {
    const label: 0 | 1 = i % 2 === 0 ? 1 : 0;
    const arr = new Array(FEATURE_DIM).fill(0);
    arr[9] = label === 1 ? 0.9 : 0.1;
    arr[0] = label === 1 ? 5 : 1;
    return {
      mint: `${launchpad}-${i}`,
      symbol: 'S',
      label,
      featuresJson: JSON.stringify(arr),
      realizedPnlUsd: label === 1 ? 1 : -1,
      entryScore: 60,
      tpProfile: null,
      launchpad,
      closedAt: new Date(Date.now() + i * 1000).toISOString(),
      sequenceJson: JSON.stringify(historyFor(label)),
    } as TrainingSample;
  });
}

test('EnsembleModel stays in shadow mode before training', () => {
  const m = new EnsembleModel(10);
  const r = m.predict(new Float32Array(FEATURE_DIM), [], 0.5, 'pump.fun');
  assert.equal(r.shadowMode, true);
  assert.equal(r.blocked, false);
  assert.equal(m.getIsTrained(), false);
});

test(
  'EnsembleModel trains across DEX buckets and separates classes',
  { skip: !NATIVE },
  async () => {
    const m = new EnsembleModel(20);
    const samples = [...makeSamples(40, 'pump.fun'), ...makeSamples(40, 'raydium')];
    await m.train(samples);
    assert.equal(m.getIsTrained(), true);

    const pos = new Float32Array(FEATURE_DIM);
    pos[9] = 0.9;
    pos[0] = 5;
    const neg = new Float32Array(FEATURE_DIM);
    neg[9] = 0.1;
    neg[0] = 1;

    for (const dex of ['pump.fun', 'raydium', 'meteora']) {
      const p = m.predict(pos, buildSequence(historyFor(1)), 0.5, dex).confidence;
      const n = m.predict(neg, buildSequence(historyFor(0)), 0.5, dex).confidence;
      assert.ok(p > n, `${dex}: positive class should score higher (${p} vs ${n})`);
    }
  }
);

test('EnsembleModel weights round-trip through save/load', { skip: !NATIVE }, async () => {
  const m = new EnsembleModel(20);
  await m.train([...makeSamples(40, 'pump.fun'), ...makeSamples(40, 'raydium')]);

  const kv: Record<string, string> = {};
  m.saveWeights((k, v) => {
    kv[k] = v;
  });
  const restored = new EnsembleModel(20);
  assert.equal(
    restored.loadWeights((k) => kv[k] ?? null),
    true
  );
  assert.equal(restored.getIsTrained(), true);

  const feat = new Float32Array(FEATURE_DIM);
  feat[9] = 0.9;
  feat[0] = 5;
  const seq = buildSequence(historyFor(1));
  assert.equal(
    m.predict(feat, seq, 0.5, 'pump.fun').confidence,
    restored.predict(feat, seq, 0.5, 'pump.fun').confidence
  );
});

test(
  'EnsembleModel falls back to the general model for an unseen DEX',
  { skip: !NATIVE },
  async () => {
    const m = new EnsembleModel(20);
    // Only pump.fun data: raydium bucket never trains, but the general model does.
    await m.train(makeSamples(40, 'pump.fun'));
    assert.equal(m.getIsTrained(), true);

    const pos = new Float32Array(FEATURE_DIM);
    pos[9] = 0.9;
    pos[0] = 5;
    // A raydium candidate still gets scored via the general fallback (not shadow).
    const r = m.predict(pos, buildSequence(historyFor(1)), 0.5, 'raydium');
    assert.equal(r.shadowMode, false);
  }
);
