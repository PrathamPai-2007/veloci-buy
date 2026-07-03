// Smoke test for the native LSTM addon: liveness, learning, determinism, persistence.
import { ping, LstmNetwork } from './index.js';
import assert from 'node:assert/strict';

console.log('ping ->', ping());
assert.equal(ping(), 'pong');

const INPUT = 2; // per-step features
const HIDDEN = 8;
const STATIC = 3;
const SEED = 42;

// Build a separable toy task: rising sequences (positive slope) => label 1,
// falling sequences => label 0. Static features carry a weak correlated signal.
function makeData(n) {
  const sequences = [];
  const statics = [];
  const labels = [];
  for (let k = 0; k < n; k++) {
    const up = k % 2 === 0;
    const seq = [];
    for (let t = 0; t < 6; t++) {
      const base = up ? t * 0.2 : 1.2 - t * 0.2;
      seq.push([base, base * 0.5]);
    }
    sequences.push(seq);
    statics.push(up ? [1, 0.5, 0.2] : [-1, -0.5, -0.2]);
    labels.push(up ? 1 : 0);
  }
  return { sequences, statics, labels };
}

const { sequences, statics, labels } = makeData(40);

const net = new LstmNetwork(INPUT, HIDDEN, STATIC, SEED);
console.log('dims ->', net.inputSize, net.hiddenSize, net.staticSize);

// Loss should fall as it learns the slope->label mapping.
const first = net.train(sequences, statics, labels, 1, 0.05, 8, 1.0, SEED);
const later = net.train(sequences, statics, labels, 60, 0.05, 8, 1.0, SEED);
console.log('loss first epoch ->', first.finalLoss.toFixed(4), '| after training ->', later.finalLoss.toFixed(4));
assert.ok(later.finalLoss < first.finalLoss, 'loss should decrease with training');

// After training, an up-sequence should score higher than a down-sequence.
const upSeq = [[0, 0], [0.2, 0.1], [0.4, 0.2], [0.6, 0.3], [0.8, 0.4], [1.0, 0.5]];
const downSeq = [[1.0, 0.5], [0.8, 0.4], [0.6, 0.3], [0.4, 0.2], [0.2, 0.1], [0, 0]];
const pUp = net.predict(upSeq, [1, 0.5, 0.2]);
const pDown = net.predict(downSeq, [-1, -0.5, -0.2]);
console.log('predict up ->', pUp.toFixed(4), '| down ->', pDown.toFixed(4));
assert.ok(pUp > pDown, 'rising sequence should score higher');

// Determinism: same seed + same data => identical weights.
const a = new LstmNetwork(INPUT, HIDDEN, STATIC, SEED);
const b = new LstmNetwork(INPUT, HIDDEN, STATIC, SEED);
a.train(sequences, statics, labels, 10, 0.05, 8, 1.0, SEED);
b.train(sequences, statics, labels, 10, 0.05, 8, 1.0, SEED);
assert.deepEqual(a.serialize(), b.serialize(), 'identical seed+data must produce identical weights');
console.log('determinism -> OK');

// Serialize / deserialize round-trip preserves predictions exactly.
const weights = net.serialize();
const restored = new LstmNetwork(INPUT, HIDDEN, STATIC, 999);
assert.ok(restored.deserialize(weights), 'deserialize should accept matching shape');
assert.equal(restored.predict(upSeq, [1, 0.5, 0.2]), pUp, 'restored model must match');
console.log('serialize round-trip -> OK');

// Empty sequence falls back to the dense head (no crash).
const pEmpty = net.predict([], [1, 0.5, 0.2]);
console.log('empty-sequence predict ->', pEmpty.toFixed(4));
assert.ok(pEmpty >= 0 && pEmpty <= 1);

console.log('\nAll native LSTM tests passed.');
