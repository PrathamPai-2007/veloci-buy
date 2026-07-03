'use strict';
import assert from 'node:assert/strict';
import test from 'node:test';

import { TrainingSample } from '../src/types/index.js';
import {
  computeAuc,
  computeBaseline,
  metricsAtThreshold,
  splitWalkForward,
  runEntryBacktest,
} from '../src/ml/backtest.js';
import { ScoredSample } from '../src/ml/backtest.types.js';

function scored(confidence: number, label: 0 | 1, pnlUsd = label === 1 ? 10 : -10): ScoredSample {
  return { confidence, label, pnlUsd, launchpad: null };
}

// ── computeAuc ────────────────────────────────────────────────────────────────

test('computeAuc — perfect separation scores 1.0', () => {
  const s = [scored(0.1, 0), scored(0.2, 0), scored(0.8, 1), scored(0.9, 1)];
  assert.equal(computeAuc(s), 1.0);
});

test('computeAuc — perfectly reversed scores 0.0', () => {
  const s = [scored(0.9, 0), scored(0.8, 0), scored(0.2, 1), scored(0.1, 1)];
  assert.equal(computeAuc(s), 0.0);
});

test('computeAuc — all-equal confidence (ties) scores 0.5', () => {
  const s = [scored(0.5, 0), scored(0.5, 1), scored(0.5, 0), scored(0.5, 1)];
  assert.equal(computeAuc(s), 0.5);
});

test('computeAuc — single class is undefined → 0.5', () => {
  assert.equal(computeAuc([scored(0.3, 1), scored(0.7, 1)]), 0.5);
  assert.equal(computeAuc([scored(0.3, 0), scored(0.7, 0)]), 0.5);
});

test('computeAuc — partial overlap is between 0.5 and 1.0', () => {
  // one positive ranked below a negative ⇒ not perfect, but better than chance
  const s = [scored(0.2, 0), scored(0.4, 1), scored(0.5, 0), scored(0.9, 1)];
  const auc = computeAuc(s);
  assert.ok(auc > 0.5 && auc < 1.0, `expected (0.5,1.0), got ${auc}`);
});

// ── splitWalkForward ──────────────────────────────────────────────────────────

function sample(closedAt: string, label: 0 | 1): TrainingSample {
  return {
    mint: `m${closedAt}`,
    symbol: 'T',
    label,
    featuresJson: JSON.stringify(new Array(18).fill(0)),
    realizedPnlUsd: label === 1 ? 5 : -5,
    entryScore: 50,
    tpProfile: null,
    launchpad: 'pump.fun',
    closedAt,
  };
}

test('splitWalkForward — chronological, no overlap, correct sizes', () => {
  const samples = [
    sample('2026-01-05', 1),
    sample('2026-01-01', 0),
    sample('2026-01-04', 1),
    sample('2026-01-02', 0),
    sample('2026-01-03', 1),
  ];
  const { train, evaluation } = splitWalkForward(samples, 0.6);
  assert.equal(train.length, 3);
  assert.equal(evaluation.length, 2);
  // Train closed strictly before eval (no lookahead).
  const lastTrain = train[train.length - 1]!.closedAt;
  const firstEval = evaluation[0]!.closedAt;
  assert.ok(lastTrain <= firstEval, `train must precede eval: ${lastTrain} vs ${firstEval}`);
  // No mint appears in both halves.
  const trainMints = new Set(train.map((t) => t.mint));
  assert.ok(evaluation.every((e) => !trainMints.has(e.mint)));
});

// ── metricsAtThreshold ────────────────────────────────────────────────────────

test('metricsAtThreshold — taken count is monotonically non-increasing in threshold', () => {
  const s = [scored(0.1, 0), scored(0.3, 1), scored(0.5, 0), scored(0.7, 1), scored(0.9, 1)];
  const base = computeBaseline(s);
  let prevTaken = Infinity;
  for (const t of [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]) {
    const m = metricsAtThreshold(s, t, base.avgPnlUsd);
    assert.ok(m.taken <= prevTaken, `taken should not increase as threshold rises`);
    assert.equal(m.taken + m.blocked, s.length);
    prevTaken = m.taken;
  }
});

test('metricsAtThreshold — precision/recall on a hand example', () => {
  // confidence ≥ 0.5 admitted: (0.6,1)=TP, (0.8,0)=FP ; below: (0.4,1)=FN, (0.2,0)=TN
  const s = [scored(0.6, 1), scored(0.8, 0), scored(0.4, 1), scored(0.2, 0)];
  const base = computeBaseline(s);
  const m = metricsAtThreshold(s, 0.5, base.avgPnlUsd);
  assert.equal(m.taken, 2);
  assert.equal(m.precision, 0.5); // 1 TP / (1 TP + 1 FP)
  assert.equal(m.recall, 0.5); // 1 TP / (1 TP + 1 FN)
  assert.equal(m.takenWinRate, 0.5);
});

test('metricsAtThreshold — uplift is positive when the gate admits the winners', () => {
  // winners carry +20, losers −20; a 0.5 gate keeps only winners.
  const s = [scored(0.9, 1, 20), scored(0.8, 1, 20), scored(0.2, 0, -20), scored(0.1, 0, -20)];
  const base = computeBaseline(s);
  assert.equal(base.avgPnlUsd, 0); // (20+20-20-20)/4
  const m = metricsAtThreshold(s, 0.5, base.avgPnlUsd);
  assert.equal(m.taken, 2);
  assert.equal(m.takenAvgPnlUsd, 20);
  assert.equal(m.avgPnlUpliftUsd, 20);
});

// ── computeBaseline ───────────────────────────────────────────────────────────

test('computeBaseline — totals and rates over all samples', () => {
  const s = [scored(0.1, 1, 30), scored(0.2, 0, -10), scored(0.3, 0, -20)];
  const base = computeBaseline(s);
  assert.equal(base.samples, 3);
  assert.equal(base.winRate, 1 / 3);
  assert.equal(base.totalPnlUsd, 0);
  assert.equal(base.avgPnlUsd, 0);
});

// ── runEntryBacktest (plumbing; native-agnostic) ──────────────────────────────

test('runEntryBacktest — returns null below the minimum training size', async () => {
  const few = [sample('2026-01-01', 1), sample('2026-01-02', 0)];
  assert.equal(await runEntryBacktest(few, { minSamples: 10 }), null);
});

test('runEntryBacktest — produces a well-formed report and sweep', async () => {
  const samples: TrainingSample[] = [];
  for (let i = 0; i < 40; i++) {
    const day = String(i + 1).padStart(2, '0');
    samples.push(sample(`2026-02-${day}`, (i % 2) as 0 | 1));
  }
  const thresholds = [0.3, 0.5, 0.7];
  const report = await runEntryBacktest(samples, { minSamples: 5, trainFraction: 0.7, thresholds });
  assert.ok(report, 'expected a report');
  assert.equal(report!.trainSamples + report!.evalSamples, 40);
  assert.ok(report!.evalSamples > 0);
  assert.equal(report!.sweep.length, thresholds.length);
  assert.ok(report!.auc >= 0 && report!.auc <= 1);
  // Every sweep row partitions the eval set.
  for (const m of report!.sweep) {
    assert.equal(m.taken + m.blocked, report!.evalSamples);
  }
});

test('runEntryBacktest — shuffleLabels keeps AUC near chance', async () => {
  // Build separable data: high confidence won't exist (shadow mode may apply),
  // but shuffling must not produce strong separation regardless.
  const samples: TrainingSample[] = [];
  for (let i = 0; i < 60; i++) {
    const day = String((i % 28) + 1).padStart(2, '0');
    const month = i < 30 ? '03' : '04';
    samples.push(sample(`2026-${month}-${day}`, (i % 2) as 0 | 1));
  }
  const report = await runEntryBacktest(samples, { minSamples: 5, shuffleLabels: true });
  assert.ok(report, 'expected a report');
  // Scrambled labels ⇒ no real signal. Allow a wide band for small-sample noise.
  assert.ok(
    report!.auc > 0.25 && report!.auc < 0.75,
    `shuffled AUC should be near chance, got ${report!.auc}`
  );
});
