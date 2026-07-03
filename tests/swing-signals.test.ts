'use strict';
import assert from 'node:assert/strict';
import test from 'node:test';
import { detectDoubleDip, detectPartialW } from '../src/services/swing/swing-signals.js';

test('detectDoubleDip prefers the most recent pattern (fixes oldest match bias)', () => {
  const prices = new Array(100);

  // 0 to 4: decreasing
  for (let i = 0; i <= 4; i++) {
    prices[i] = 20 - i;
  }
  // 5: local min 1
  prices[5] = 10;
  // 6 to 14: increasing
  for (let i = 6; i <= 14; i++) {
    prices[i] = 10 + (i - 5);
  }
  // 15: local max 1
  prices[15] = 20;
  // 16 to 24: decreasing
  for (let i = 16; i <= 24; i++) {
    prices[i] = 20 - (i - 15);
  }
  // 25: local min 2
  prices[25] = 10;
  // 26 to 54: increasing
  for (let i = 26; i <= 54; i++) {
    prices[i] = 10 + (i - 25) * 5;
  }
  // 55: local min 3
  prices[55] = 100;
  // 56 to 64: increasing
  for (let i = 56; i <= 64; i++) {
    prices[i] = 100 + (i - 55) * 10;
  }
  // 65: local max 2
  prices[65] = 200;
  // 66 to 74: decreasing
  for (let i = 66; i <= 74; i++) {
    prices[i] = 200 - (i - 65) * 10;
  }
  // 75: local min 4
  prices[75] = 100;
  // 76 to 99: increasing
  for (let i = 76; i <= 99; i++) {
    prices[i] = 100 + (i - 75) * 4;
  }

  const priceHistory = prices.map((price, idx) => ({
    price,
    timestamp: 1000 + idx * 1000,
  }));

  const result = detectDoubleDip(priceHistory);

  assert.ok(result !== null);
  // It must prefer the newer pattern (indices 55, 65, 75) instead of (5, 15, 25)
  assert.equal(result.dip1Idx, 55);
  assert.equal(result.bounceIdx, 65);
  assert.equal(result.dip2Idx, 75);
  assert.equal(result.dip1Price, 100);
  assert.equal(result.bouncePrice, 200);
  assert.equal(result.dip2Price, 100);
});

test('detectPartialW detects recent partial W pattern', () => {
  const prices = new Array(76);

  // 0 to 54: same as above
  for (let i = 0; i <= 4; i++) {
    prices[i] = 20 - i;
  }
  prices[5] = 10;
  for (let i = 6; i <= 14; i++) {
    prices[i] = 10 + (i - 5);
  }
  prices[15] = 20;
  for (let i = 16; i <= 24; i++) {
    prices[i] = 20 - (i - 15);
  }
  prices[25] = 10;
  for (let i = 26; i <= 54; i++) {
    prices[i] = 10 + (i - 25) * 5;
  }
  // 55: local min 3
  prices[55] = 100;
  // 56 to 64: increasing
  for (let i = 56; i <= 64; i++) {
    prices[i] = 100 + (i - 55) * 10;
  }
  // 65: local max 2
  prices[65] = 200;
  // 66 to 75: decreasing
  for (let i = 66; i <= 75; i++) {
    prices[i] = 200 - (i - 65) * 10;
  }

  const priceHistory = prices.map((price, idx) => ({
    price,
    timestamp: 1000 + idx * 1000,
  }));

  const result = detectPartialW(priceHistory);
  assert.equal(result, true);
});
