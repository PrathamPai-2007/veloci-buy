'use strict';
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeMomentumScore } from '../src/services/engine/engine.service.js';
import { MOMENTUM_SCORING } from '../src/core/constants.js';
import { TokenMetadata } from '../src/types/index.js';

interface PP {
  price: number;
  timestamp: number;
}

function history(prices: number[]): PP[] {
  return prices.map((price, i) => ({ price, timestamp: 1000 + i * 1000 }));
}

// A rising, all-green survival window (>= 6 points so the cold-start guard does not fire).
const RISING = history([1.0, 1.05, 1.1, 1.2, 1.3, 1.4]);
const FLAT = history([1.0, 1.0, 1.0, 1.0, 1.0, 1.0]);
const FALLING = history([1.0, 0.92, 0.85, 0.78, 0.7, 0.62]);

test('momentum: strong buys + rising price + accelerating tape clamps near the +max', () => {
  const token = {
    stats5m: { numBuys: 90, numSells: 10 },
    tapeAtStart: { buys: 0, sells: 0 },
    tapeHistory: [
      { buys: 0, sells: 0, timestamp: 1000 },
      { buys: 10, sells: 1, timestamp: 2000 },
      { buys: 20, sells: 2, timestamp: 3000 },
      { buys: 30, sells: 3, timestamp: 4000 },
    ],
  } as unknown as TokenMetadata;

  const score = computeMomentumScore(token, RISING, 1.0, 1.45);
  assert.ok(score > 8, `expected strongly positive, got ${score}`);
  assert.ok(score <= MOMENTUM_SCORING.max, `must not exceed max, got ${score}`);
});

test('momentum: heavy sells + falling price clamps near the -min', () => {
  const token = {
    stats5m: { numBuys: 10, numSells: 90 },
    tapeAtStart: { buys: 0, sells: 0 },
    tapeHistory: [
      { buys: 0, sells: 0, timestamp: 1000 },
      { buys: 30, sells: 20, timestamp: 2000 },
      { buys: 50, sells: 60, timestamp: 3000 },
    ],
  } as unknown as TokenMetadata;

  const score = computeMomentumScore(token, FALLING, 1.0, 0.6);
  assert.ok(score < -6, `expected strongly negative, got ${score}`);
  assert.ok(score >= MOMENTUM_SCORING.min, `must not exceed min, got ${score}`);
});

test('momentum: flat price + balanced flow is roughly neutral', () => {
  const token = {
    stats5m: { numBuys: 50, numSells: 50 },
    tapeAtStart: { buys: 0, sells: 0 },
    tapeHistory: [
      { buys: 0, sells: 0, timestamp: 1000 },
      { buys: 25, sells: 25, timestamp: 2000 },
      { buys: 50, sells: 50, timestamp: 3000 },
    ],
  } as unknown as TokenMetadata;

  const score = computeMomentumScore(token, FLAT, 1.0, 1.0);
  assert.ok(Math.abs(score) < 1.5, `expected near-zero, got ${score}`);
});

test('momentum: cold start (<6 price points) returns 0 regardless of bullish flow', () => {
  const token = {
    stats5m: { numBuys: 100, numSells: 0 },
    tapeAtStart: { buys: 0, sells: 0 },
    tapeHistory: [
      { buys: 0, sells: 0, timestamp: 1000 },
      { buys: 80, sells: 0, timestamp: 2000 },
    ],
  } as unknown as TokenMetadata;

  const score = computeMomentumScore(token, history([1.0, 1.2, 1.5]), 1.0, 1.5);
  assert.strictEqual(score, 0);
});

test('momentum: output always stays within the configured band', () => {
  const bull = {
    stats5m: { numBuys: 1000, numSells: 0 },
    tapeAtStart: { buys: 0, sells: 0 },
    tapeHistory: [
      { buys: 0, sells: 0, timestamp: 1000 },
      { buys: 1, sells: 0, timestamp: 2000 },
      { buys: 999, sells: 0, timestamp: 3000 },
    ],
  } as unknown as TokenMetadata;
  const hi = computeMomentumScore(bull, RISING, 1.0, 100.0);
  assert.ok(hi <= MOMENTUM_SCORING.max && hi >= MOMENTUM_SCORING.min);

  const bear = {
    stats5m: { numBuys: 0, numSells: 1000 },
  } as unknown as TokenMetadata;
  const lo = computeMomentumScore(bear, FALLING, 1.0, 0.001);
  assert.ok(lo <= MOMENTUM_SCORING.max && lo >= MOMENTUM_SCORING.min);
});
