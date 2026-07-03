'use strict';
import assert from 'node:assert/strict';
import test from 'node:test';

import { ScoringModel } from '../src/ml/scoring-model.js';
import { MlService } from '../src/ml/ml-service.js';
import { StateStore } from '../src/core/store.js';
import {
  FEATURE_DIM,
  extractFeatures,
  computeNormStats,
  normalizeFeatures,
} from '../src/ml/features.js';
import { SEQ_FEATURE_DIM, buildSequence } from '../src/ml/sequence-features.js';

// The LSTM scorer requires the native addon (`npm run build:rust`). Where it is
// unavailable the model stays in shadow mode by design, so native-dependent
// assertions are skipped rather than failed.
const NATIVE = new ScoringModel(1).nativeAvailable();
import {
  ENTRY_PARAM_SPECS,
  PARAM_SPECS,
  extractCurrentParams,
  extractCurrentEntryParams,
  estimateGradients,
  estimateEntryGradients,
  applyGradientStep,
  replayNetPnl,
  replayNetPnlFromSamples,
  replayEntryNetPnl,
  decodeEntryFeatures,
  scoreExitParams,
  restoreParams,
} from '../src/ml/param-optimizer.js';
import { ClosedTrade, Config, EvaluationResult, TrainingSample } from '../src/types/index.js';

// ── Features ─────────────────────────────────────────────────────────────────

function makeEvalResult(overrides: Partial<EvaluationResult> = {}): EvaluationResult {
  const base = {
    approved: true,
    blockers: [],
    rejectionReasons: [],
    notes: [],
    candidateScore: 70,
    volatilityScaler: 1.0,
    launchpadProfile: { name: 'pumpfun' },
    adjustedThresholds: { minLiquidityUsd: 500 },
    token: {
      id: 'MintXyz',
      symbol: 'TST',
      liquidity: 1000,
      fdv: 50000,
      holderCount: 40,
      organicScore: 5,
      usdPrice: 0.00001,
      isVerified: true,
      website: 'x',
      twitter: 'y',
      stats5m: { numBuys: 30, numSells: 10 },
      firstPool: { createdAt: new Date(Date.now() - 300_000).toISOString() },
      priceHistory: [{ price: 1 }, { price: 1.1 }, { price: 1.2 }, { price: 1.3 }],
    },
  };
  return { ...base, ...overrides } as unknown as EvaluationResult;
}

test('extractFeatures returns a finite FEATURE_DIM vector', () => {
  const f = extractFeatures(makeEvalResult());
  assert.equal(f.length, FEATURE_DIM);
  for (let i = 0; i < f.length; i++) {
    assert.ok(Number.isFinite(f[i]), `feature ${i} must be finite, got ${f[i]}`);
  }
});

test('extractFeatures is deterministic for identical input', () => {
  const originalNow = Date.now;
  Date.now = () => 1000000000;
  try {
    const a = Array.from(extractFeatures(makeEvalResult()));
    const b = Array.from(extractFeatures(makeEvalResult()));
    assert.deepEqual(a, b);
  } finally {
    Date.now = originalNow;
  }
});

test('extractFeatures tolerates missing/zero token fields without NaN', () => {
  const f = extractFeatures(
    makeEvalResult({
      token: { id: 'm', symbol: 'M' },
      candidateScore: 0,
      volatilityScaler: 0,
    } as unknown as Partial<EvaluationResult>)
  );
  assert.equal(f.length, FEATURE_DIM);
  for (let i = 0; i < f.length; i++) assert.ok(Number.isFinite(f[i]));
});

test('normalizeFeatures handles zero-variance features without dividing by zero', () => {
  const samples = [new Float32Array(FEATURE_DIM).fill(2), new Float32Array(FEATURE_DIM).fill(2)];
  const stats = computeNormStats(samples);
  const out = normalizeFeatures(new Float32Array(FEATURE_DIM).fill(2), stats);
  for (let i = 0; i < out.length; i++) assert.ok(Number.isFinite(out[i]));
});

// ── ScoringModel ───────────────────────────────────────────────────────────────

// Raw price history correlated with the label: rising for winners, falling for
// losers. Exercises the LSTM's sequence path in addition to the static head.
function historyFor(label: 0 | 1): { price: number; timestamp: number }[] {
  const pts: { price: number; timestamp: number }[] = [];
  for (let t = 0; t < 6; t++) {
    const price = label === 1 ? 1 + t * 0.15 : 1.9 - t * 0.15;
    pts.push({ price, timestamp: t * 1000 });
  }
  return pts;
}

function makeSamples(n: number): TrainingSample[] {
  const samples: TrainingSample[] = [];
  for (let i = 0; i < n; i++) {
    const label: 0 | 1 = i % 2 === 0 ? 1 : 0;
    // Construct features that are linearly separable by label
    const arr = new Array(FEATURE_DIM).fill(0);
    arr[9] = label === 1 ? 0.9 : 0.1;
    arr[0] = label === 1 ? 5 : 1;
    samples.push({
      mint: `m${i}`,
      symbol: 'S',
      label,
      featuresJson: JSON.stringify(arr),
      realizedPnlUsd: label === 1 ? 1 : -1,
      entryScore: 60,
      tpProfile: null,
      launchpad: null,
      closedAt: new Date(Date.now() + i * 1000).toISOString(),
      sequenceJson: JSON.stringify(historyFor(label)),
    });
  }
  return samples;
}

test('ScoringModel stays in shadow mode before training', () => {
  const model = new ScoringModel(10);
  const r = model.predict(new Float32Array(FEATURE_DIM), [], 0.5);
  assert.equal(r.shadowMode, true);
  assert.equal(r.blocked, false);
  assert.equal(model.getIsTrained(), false);
});

test('ScoringModel refuses to train below minSamples threshold', async () => {
  const model = new ScoringModel(50);
  await model.train(makeSamples(10));
  assert.equal(model.getIsTrained(), false);
});

test(
  'ScoringModel trains, exits shadow mode, and separates classes',
  { skip: !NATIVE },
  async () => {
    const model = new ScoringModel(20);
    await model.train(makeSamples(60));
    assert.equal(model.getIsTrained(), true);

    const pos = new Array(FEATURE_DIM).fill(0);
    pos[9] = 0.9;
    pos[0] = 5;
    const neg = new Array(FEATURE_DIM).fill(0);
    neg[9] = 0.1;
    neg[0] = 1;

    const pConf = model.predict(
      new Float32Array(pos),
      buildSequence(historyFor(1)),
      0.5
    ).confidence;
    const nConf = model.predict(
      new Float32Array(neg),
      buildSequence(historyFor(0)),
      0.5
    ).confidence;
    assert.ok(pConf > nConf, `positive class should score higher (${pConf} vs ${nConf})`);
  }
);

test('ScoringModel weights round-trip through save/load', { skip: !NATIVE }, async () => {
  const model = new ScoringModel(20);
  await model.train(makeSamples(60));

  const kv: Record<string, string> = {};
  model.saveWeights((k, v) => {
    kv[k] = v;
  });

  const restored = new ScoringModel(20);
  const ok = restored.loadWeights((k) => kv[k] ?? null);
  assert.equal(ok, true);
  assert.equal(restored.getIsTrained(), true);

  const feat = new Float32Array(FEATURE_DIM);
  feat[9] = 0.9;
  feat[0] = 5;
  const seq = buildSequence(historyFor(1));
  assert.equal(
    model.predict(feat, seq, 0.5).confidence,
    restored.predict(feat, seq, 0.5).confidence
  );
});

test('ScoringModel.loadWeights returns false on missing keys', () => {
  const model = new ScoringModel(20);
  assert.equal(
    model.loadWeights(() => null),
    false
  );
});

test(
  'ScoringModel maps confidence to tp profiles around the threshold',
  { skip: !NATIVE },
  async () => {
    const model = new ScoringModel(20);
    await model.train(makeSamples(60));
    // Just assert the profile is one of the valid values for a strong positive sample
    const feat = new Float32Array(FEATURE_DIM);
    feat[9] = 0.9;
    feat[0] = 5;
    const r = model.predict(feat, buildSequence(historyFor(1)), 0.5);
    assert.ok(['high', 'standard', 'low'].includes(r.tpProfile));
  }
);

// ── Sequence features ──────────────────────────────────────────────────────────

test('buildSequence returns a [steps, SEQ_FEATURE_DIM] matrix of finite values', () => {
  const seq = buildSequence(historyFor(1));
  assert.equal(seq.length, 6);
  for (const step of seq) {
    assert.equal(step.length, SEQ_FEATURE_DIM);
    for (const v of step) assert.ok(Number.isFinite(v));
  }
});

test('buildSequence returns [] for empty/degenerate input', () => {
  assert.deepEqual(buildSequence([]), []);
  assert.deepEqual(buildSequence(undefined), []);
  assert.deepEqual(buildSequence([{ price: 0, timestamp: 0 }]), []);
});

test('buildSequence caps length to the most recent MAX_SEQ_STEPS', () => {
  const long = Array.from({ length: 100 }, (_, t) => ({ price: 1 + t * 0.01, timestamp: t }));
  const seq = buildSequence(long);
  assert.ok(seq.length <= 32, `expected <= 32 steps, got ${seq.length}`);
});

// ── Param optimizer ─────────────────────────────────────────────────────────────

function makeConfig(): Config {
  return {
    stopLossPct: 0.18,
    trailingStopDrawdownPct: 0.12,
    minCandidateScore: 64,
    minLiquidityUsd: 500,
    minSurvivalMomentum: 1.1,
    minBreakoutMultiplier: 1.05,
    takeProfitMultiples: [1.3, 2.1],
    earlyPerformanceGuardSeconds: 15,
    earlyPerformanceDropPct: 0.1,
    liquidityCollapseThresholdUsd: 100,
    liquidityCollapseThresholdRatio: 0.3,
  } as unknown as Config;
}

function makeTrade(overrides: Partial<ClosedTrade> = {}): ClosedTrade {
  return {
    mint: 'm',
    symbol: 'S',
    exitReason: 'tp',
    realizedPnlUsd: 0,
    realizedProceedsUsd: 0,
    entryUsdValue: 100,
    entryPriceUsd: 1,
    highestPriceUsd: 2,
    holdSeconds: 60,
    closedAt: new Date().toISOString(),
    entryScore: 70,
    trailingStopDrawdownPctResolved: 0.12,
    maxHoldMinutesResolved: 10,
    volatilityScaler: 1,
    entryLiquidityUsd: 1000,
    targetsHit: 1,
    ...overrides,
  } as ClosedTrade;
}

test('PARAM_SPECS contains only exit-shape params (no biased entry filters)', () => {
  const keys = PARAM_SPECS.map((s) => s.key).sort();
  assert.deepEqual(keys, [
    'earlyPerformanceDropPct',
    'earlyPerformanceGuardSeconds',
    'liquidityCollapseThresholdRatio',
    'liquidityCollapseThresholdUsd',
    'stopLossPct',
    'takeProfitMultiples_0',
    'takeProfitMultiples_1',
    'trailingStopDrawdownPct',
  ]);
  // Entry filters must NOT be optimized — they only ratchet up.
  assert.ok(!keys.includes('minCandidateScore'));
  assert.ok(!keys.includes('minLiquidityUsd'));
});

test('extractCurrentParams reads every optimizer param from config', () => {
  const p = extractCurrentParams(makeConfig());
  for (const spec of PARAM_SPECS) {
    assert.ok(spec.key in p, `${spec.key} missing`);
    assert.ok(Number.isFinite(p[spec.key]));
  }
});

test('replayNetPnl filters trades below entry-quality thresholds', () => {
  const trades = [makeTrade({ entryScore: 50 }), makeTrade({ entryScore: 80 })];
  const lenient = replayNetPnl(trades, {
    ...extractCurrentParams(makeConfig()),
    minCandidateScore: 0,
  });
  const strict = replayNetPnl(trades, {
    ...extractCurrentParams(makeConfig()),
    minCandidateScore: 75,
  });
  assert.ok(strict <= lenient, 'stricter score filter should not increase total PnL');
});

test('estimateGradients returns a finite gradient per spec', () => {
  const trades = Array.from({ length: 30 }, (_, i) =>
    makeTrade({ highestPriceUsd: 1 + (i % 5) * 0.5, entryScore: 60 + (i % 20) })
  );
  const grads = estimateGradients(trades, extractCurrentParams(makeConfig()), PARAM_SPECS);
  for (const spec of PARAM_SPECS) {
    assert.ok(Number.isFinite(grads[spec.key]!), `${spec.key} gradient not finite`);
  }
});

test('applyGradientStep clamps params to spec bounds and keeps tp[0] < tp[1]', () => {
  const config = makeConfig();
  // Force huge gradients to drive params toward bounds
  const gradients: Record<string, number> = {};
  for (const spec of PARAM_SPECS) gradients[spec.key] = 1e9;
  applyGradientStep(config, gradients, PARAM_SPECS);

  for (const spec of PARAM_SPECS) {
    if (spec.key.startsWith('takeProfitMultiples')) continue;
    const v = (config as unknown as Record<string, number>)[spec.key] ?? Number.NaN;
    assert.ok(v >= spec.min && v <= spec.max, `${spec.key}=${v} out of [${spec.min},${spec.max}]`);
  }
  assert.ok(
    config.takeProfitMultiples[0]! < config.takeProfitMultiples[1]!,
    'tp[0] must stay below tp[1]'
  );
});

test('applyGradientStep ignores non-finite gradients', () => {
  const config = makeConfig();
  const before = config.stopLossPct;
  applyGradientStep(config, { stopLossPct: Number.NaN }, PARAM_SPECS);
  assert.equal(config.stopLossPct, before);
});

// ── Drift-guard building blocks (1b) ──────────────────────────────────────────

test('scoreExitParams equals replayNetPnl + replayNetPnlFromSamples', () => {
  const trades = Array.from({ length: 10 }, (_, i) =>
    makeTrade({ highestPriceUsd: 1 + (i % 4) * 0.4, entryScore: 65 })
  );
  const samples = Array.from({ length: 8 }, () => makeGhostSample(8, 1000, 70, 5));
  const params = extractCurrentParams(makeConfig());
  const combined = scoreExitParams(trades, samples, params);
  assert.equal(combined, replayNetPnl(trades, params) + replayNetPnlFromSamples(samples, params));
});

test('restoreParams round-trips an exit-param snapshot', () => {
  const config = makeConfig();
  const snapshot = extractCurrentParams(config);

  // Mutate every exit param away from the snapshot.
  config.stopLossPct = 0.33;
  config.trailingStopDrawdownPct = 0.31;
  config.takeProfitMultiples = [1.9, 3.3];
  config.earlyPerformanceGuardSeconds = 55;
  config.earlyPerformanceDropPct = 0.45;
  config.liquidityCollapseThresholdUsd = 480;
  config.liquidityCollapseThresholdRatio = 0.7;
  assert.notDeepEqual(extractCurrentParams(config), snapshot);

  restoreParams(config, snapshot);
  assert.deepEqual(extractCurrentParams(config), snapshot, 'restore must invert the mutation');
});

// ── Entry-gate tuner ─────────────────────────────────────────────────────────────

// Builds a ghost-style TrainingSample whose feature vector encodes holders/liquidity
// exactly as features.ts does (raw[0] = log1p(liquidity), raw[2] = log1p(holderCount)).
function makeGhostSample(
  holders: number,
  liquidityUsd: number,
  score: number,
  pnlUsd: number
): TrainingSample {
  const arr = new Array(FEATURE_DIM).fill(0);
  arr[0] = Math.log1p(liquidityUsd);
  arr[2] = Math.log1p(holders);
  return {
    mint: `g${Math.random()}`,
    symbol: 'G',
    label: pnlUsd > 0 ? 1 : 0,
    featuresJson: JSON.stringify(arr),
    realizedPnlUsd: pnlUsd,
    entryScore: score,
    tpProfile: null,
    launchpad: null,
    closedAt: new Date().toISOString(),
  };
}

function makeEntryConfig(overrides: Partial<Config> = {}): Config {
  return {
    logFile: '',
    minHolderCount: 5,
    minCandidateScore: 64,
    minLiquidityUsd: 500,
    mlGateMinRealTrades: 5,
    entryTunerEnabled: true,
    entryTunerLiveEnabled: false,
    entryTunerMinSamples: 15,
    paperTrading: true,
    ...overrides,
  } as unknown as Config;
}

test('extractCurrentEntryParams reads the three tuned gates from config', () => {
  const p = extractCurrentEntryParams(makeEntryConfig());
  assert.equal(p['minHolderCount'], 5);
  assert.equal(p['minCandidateScore'], 64);
  assert.equal(p['minLiquidityUsd'], 500);
});

test('decodeEntryFeatures inverts the feature encoding for holders and liquidity', () => {
  const s = makeGhostSample(7, 1234, 70, 5);
  const decoded = decodeEntryFeatures(s.featuresJson);
  assert.ok(decoded);
  assert.equal(decoded!.holderCount, 7);
  assert.ok(Math.abs(decoded!.liquidityUsd - 1234) < 1, 'liquidity round-trips');
});

test('decodeEntryFeatures returns null on malformed json', () => {
  assert.equal(decodeEntryFeatures('not json'), null);
});

test('replayEntryNetPnl rises when lowering a gate admits net-positive trades', () => {
  // 5 high-holder winners (always counted) + 5 low-holder winners (only at lower gate)
  const samples = [
    ...Array.from({ length: 5 }, () => makeGhostSample(10, 1000, 70, 8)),
    ...Array.from({ length: 5 }, () => makeGhostSample(4, 1000, 70, 6)),
  ];
  const base = { minHolderCount: 5, minCandidateScore: 60, minLiquidityUsd: 500 };
  const strict = replayEntryNetPnl(samples, base);
  const loose = replayEntryNetPnl(samples, { ...base, minHolderCount: 3 });
  assert.equal(strict, 40, 'only the 5 high-holder winners clear minHolderCount=5');
  assert.equal(loose, 70, 'lowering to 3 admits the low-holder winners too');
  assert.ok(loose > strict, 'admitting net-positive trades increases replay PnL');
});

test('replayEntryNetPnl falls when lowering a gate admits net-negative trades', () => {
  const samples = [
    ...Array.from({ length: 5 }, () => makeGhostSample(10, 1000, 70, 8)),
    ...Array.from({ length: 5 }, () => makeGhostSample(4, 1000, 70, -6)),
  ];
  const base = { minHolderCount: 5, minCandidateScore: 60, minLiquidityUsd: 500 };
  const strict = replayEntryNetPnl(samples, base);
  const loose = replayEntryNetPnl(samples, { ...base, minHolderCount: 3 });
  assert.ok(loose < strict, 'admitting net-negative trades decreases replay PnL');
});

test('estimateEntryGradients points minHolderCount downward when loosening helps', () => {
  const samples = [
    ...Array.from({ length: 20 }, () => makeGhostSample(4, 1000, 70, 10)),
    ...Array.from({ length: 5 }, () => makeGhostSample(10, 1000, 70, 8)),
  ];
  const current = { minHolderCount: 5, minCandidateScore: 60, minLiquidityUsd: 500 };
  const grads = estimateEntryGradients(samples, current, ENTRY_PARAM_SPECS);
  assert.ok(Number.isFinite(grads['minHolderCount']!));
  assert.ok(grads['minHolderCount']! < 0, 'gradient should push the holder gate down');
});

test('applyGradientStep caps each param at its maxStep and keeps minHolderCount integer', () => {
  const config = makeEntryConfig();
  const before = config.minHolderCount;
  const holderSpec = ENTRY_PARAM_SPECS.find((s) => s.key === 'minHolderCount')!;
  const cap = holderSpec.maxStep ?? holderSpec.delta;

  const gradients: Record<string, number> = {};
  for (const spec of ENTRY_PARAM_SPECS) gradients[spec.key] = 1e9;
  applyGradientStep(config, gradients, ENTRY_PARAM_SPECS);

  for (const spec of ENTRY_PARAM_SPECS) {
    const v = (config as unknown as Record<string, number>)[spec.key]!;
    assert.ok(v >= spec.min && v <= spec.max, `${spec.key}=${v} out of [${spec.min},${spec.max}]`);
  }
  assert.ok(Number.isInteger(config.minHolderCount), 'minHolderCount must stay integer');
  // A single huge-gradient step is capped at the param's maxStep, so it nudges by one
  // increment rather than snapping straight to the max bound in one retrain cycle.
  assert.equal(config.minHolderCount, before + cap, 'step capped at maxStep, not snapped to max');
});

test('runEntryTunerNow lowers the holder gate from loosening-beneficial ghost data', async () => {
  const samples = [
    ...Array.from({ length: 20 }, () => makeGhostSample(4, 1000, 70, 10)),
    ...Array.from({ length: 5 }, () => makeGhostSample(10, 1000, 70, 8)),
  ];
  const svc = new MlService();
  const config = makeEntryConfig();
  svc.init(makeFakeStore(0, samples), config);
  const before = config.minHolderCount;
  await svc.runEntryTunerNow();
  assert.ok(
    config.minHolderCount < before,
    `holder gate should drop (${before} → ${config.minHolderCount})`
  );
});

test('runEntryTunerNow is a no-op when entryTunerEnabled is false', async () => {
  const samples = Array.from({ length: 25 }, () => makeGhostSample(4, 1000, 70, 10));
  const svc = new MlService();
  const config = makeEntryConfig({ entryTunerEnabled: false });
  svc.init(makeFakeStore(0, samples), config);
  await svc.runEntryTunerNow();
  assert.equal(config.minHolderCount, 5, 'gate unchanged when tuner disabled');
});

test('runEntryTunerNow is a no-op in live mode unless entryTunerLiveEnabled', async () => {
  const samples = Array.from({ length: 25 }, () => makeGhostSample(4, 1000, 70, 10));
  const svc = new MlService();
  const config = makeEntryConfig({ paperTrading: false, entryTunerLiveEnabled: false });
  svc.init(makeFakeStore(0, samples), config);
  await svc.runEntryTunerNow();
  assert.equal(config.minHolderCount, 5, 'gate unchanged in live mode without opt-in');
});

test('runEntryTunerNow is a no-op below entryTunerMinSamples', async () => {
  const samples = Array.from({ length: 5 }, () => makeGhostSample(4, 1000, 70, 10));
  const svc = new MlService();
  const config = makeEntryConfig({ entryTunerMinSamples: 15 });
  svc.init(makeFakeStore(0, samples), config);
  await svc.runEntryTunerNow();
  assert.equal(config.minHolderCount, 5, 'gate unchanged below min-sample guard');
});

// ── MlService cold-start gating ─────────────────────────────────────────────────

function makeFakeStore(closedTradeCount: number, samples: TrainingSample[]): StateStore {
  const closed = Array.from({ length: closedTradeCount }, () => ({}) as ClosedTrade);
  return {
    getRecentClosedTrades: (n: number) => closed.slice(0, n),
    getTrainingSamples: (n: number) => samples.slice(0, n),
    getKV: () => null,
    upsertKV: () => {},
  } as unknown as StateStore;
}

function makeTrainedService(closedTradeCount: number): MlService {
  const prev = process.env.ML_ENABLED;
  process.env.ML_ENABLED = 'true';
  const svc = new MlService();
  // Threshold 1.1 guarantees confidence < threshold, so a trained model always
  // wants to block — isolating the cold-start gate from the model's output.
  const config = {
    ...makeConfig(),
    logFile: '',
    mlScoreGateThreshold: 1.1,
    mlGateMinRealTrades: 5,
  } as unknown as Config;
  svc.init(makeFakeStore(closedTradeCount, makeSamples(60)), config);
  if (prev === undefined) delete process.env.ML_ENABLED;
  else process.env.ML_ENABLED = prev;
  return svc;
}

test(
  'getScore stays advisory (never blocks) below mlGateMinRealTrades',
  { skip: !NATIVE },
  async () => {
    const svc = makeTrainedService(0);
    await svc.retrainNeuralNetworkOnly();
    assert.equal(svc.isModelTrained(), true);

    const r = svc.getScore(makeEvalResult());
    assert.ok(r);
    assert.equal(r!.blocked, false, 'must not block before enough real trades');
  }
);

test(
  'getScore enforces the gate once mlGateMinRealTrades is reached',
  { skip: !NATIVE },
  async () => {
    const svc = makeTrainedService(5);
    await svc.retrainNeuralNetworkOnly();
    assert.equal(svc.isModelTrained(), true);

    const r = svc.getScore(makeEvalResult());
    assert.ok(r);
    assert.equal(r!.blocked, true, 'must enforce the gate after enough real trades');
  }
);

test('getScore returns null when ML is disabled', () => {
  const svc = new MlService();
  svc.init(makeFakeStore(0, []), { ...makeConfig(), logFile: '' } as unknown as Config);
  assert.equal(svc.getScore(makeEvalResult()), null);
});
