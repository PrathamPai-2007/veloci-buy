'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCtx, withMockedFetch } from './_test_helpers.js';
import {
  jupiterDiscoveryBreaker,
  JupiterCircuitBreaker,
} from '../src/services/jupiter-circuit-breaker.js';
import {
  fetchRecentLaunches,
  fetchTrendingLaunches,
  fetchPrices,
} from '../src/services/market-data.js';

test('JupiterCircuitBreaker: 3 consecutive failures open circuit', () => {
  const cb = new JupiterCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });
  const logs: string[] = [];
  const ctx = createCtx();
  ctx.logger = (msg: string) => logs.push(msg);

  assert.equal(cb.getState(), 'CLOSED');

  cb.recordFailure(ctx, new Error('Timeout 1'));
  assert.equal(cb.getState(), 'CLOSED');
  assert.equal(ctx.state.metrics.consecutiveJupiterFailures, 1);

  cb.recordFailure(ctx, new Error('Timeout 2'));
  assert.equal(cb.getState(), 'CLOSED');
  assert.equal(ctx.state.metrics.consecutiveJupiterFailures, 2);

  cb.recordFailure(ctx, new Error('Timeout 3'));
  assert.equal(cb.getState(), 'OPEN');
  assert.equal(ctx.state.metrics.consecutiveJupiterFailures, 3);
  assert.equal(ctx.state.metrics.jupiterCircuitOpens, 1);
  assert.ok(
    logs.some((l) => l.includes('Jupiter discovery circuit OPEN; suppressing requests for 60s'))
  );
});

test('JupiterCircuitBreaker: requests are suppressed while OPEN', () => {
  const cb = new JupiterCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });
  const ctx = createCtx();

  for (let i = 0; i < 3; i++) {
    cb.recordFailure(ctx, new Error('Timeout'));
  }
  assert.equal(cb.getState(), 'OPEN');

  const check1 = cb.canExecute(ctx);
  assert.equal(check1.allowed, false);

  const check2 = cb.canExecute(ctx);
  assert.equal(check2.allowed, false);

  assert.equal(ctx.state.metrics.jupiterSuppressedRequests, 2);
});

test('JupiterCircuitBreaker: one HALF_OPEN probe occurs after cooldown', () => {
  let currentTime = 1_000_000;
  const cb = new JupiterCircuitBreaker({
    failureThreshold: 3,
    cooldownMs: 60_000,
    nowFn: () => currentTime,
  });
  const ctx = createCtx();

  for (let i = 0; i < 3; i++) {
    cb.recordFailure(ctx, new Error('Timeout'));
  }
  assert.equal(cb.getState(), 'OPEN');

  // Before cooldown expires
  currentTime += 30_000;
  assert.equal(cb.getState(), 'OPEN');
  assert.equal(cb.canExecute(ctx).allowed, false);

  // After cooldown expires
  currentTime += 35_000; // Total 65s passed
  assert.equal(cb.getState(), 'HALF_OPEN');

  // First call gets probe execution
  const probe = cb.canExecute(ctx);
  assert.equal(probe.allowed, true);
  assert.equal(probe.isProbe, true);
  assert.equal(ctx.state.metrics.jupiterCircuitProbes, 1);

  // Concurrent second call while probe in-flight is suppressed
  const concurrent = cb.canExecute(ctx);
  assert.equal(concurrent.allowed, false);
  assert.equal(ctx.state.metrics.jupiterSuppressedRequests, 2);
});

test('JupiterCircuitBreaker: successful probe closes circuit and resets consecutive failures', () => {
  let currentTime = 1_000_000;
  const cb = new JupiterCircuitBreaker({
    failureThreshold: 3,
    cooldownMs: 60_000,
    nowFn: () => currentTime,
  });
  const ctx = createCtx();

  for (let i = 0; i < 3; i++) {
    cb.recordFailure(ctx, new Error('Timeout'));
  }
  assert.equal(cb.getState(), 'OPEN');

  currentTime += 65_000;
  assert.equal(cb.getState(), 'HALF_OPEN');

  const probe = cb.canExecute(ctx);
  assert.equal(probe.allowed, true);

  cb.recordSuccess(ctx);
  assert.equal(cb.getState(), 'CLOSED');
  assert.equal(ctx.state.metrics.consecutiveJupiterFailures, 0);
  assert.equal(ctx.state.metrics.jupiterCircuitCloses, 1);

  // Subsequent requests are allowed normally
  assert.equal(cb.canExecute(ctx).allowed, true);
});

test('JupiterCircuitBreaker: failed probe reopens circuit with backoff', () => {
  let currentTime = 1_000_000;
  const cb = new JupiterCircuitBreaker({
    failureThreshold: 3,
    cooldownMs: 60_000,
    nowFn: () => currentTime,
  });
  const ctx = createCtx();

  for (let i = 0; i < 3; i++) {
    cb.recordFailure(ctx, new Error('Timeout'));
  }
  assert.equal(cb.getState(), 'OPEN');
  assert.equal(ctx.state.metrics.jupiterCircuitOpens, 1);

  currentTime += 65_000;
  assert.equal(cb.getState(), 'HALF_OPEN');

  cb.canExecute(ctx); // probe in flight
  cb.recordFailure(ctx, new Error('Probe failed'));

  assert.equal(cb.getState(), 'OPEN');
  assert.equal(ctx.state.metrics.jupiterCircuitOpens, 2);
  // Cooldown backed off to approx 120s (2x with jitter)
  assert.ok(cb.getCurrentCooldownMs() >= 100_000);
});

test('JupiterCircuitBreaker: multiple services share the same circuit state', async () => {
  jupiterDiscoveryBreaker.reset();
  const ctx = createCtx();
  let fetchCount = 0;

  await withMockedFetch(
    async () => {
      fetchCount++;
      throw new Error('Jupiter network timeout');
    },
    async () => {
      // 3 calls to fetchRecentLaunches fail
      await fetchRecentLaunches(ctx);
      await fetchRecentLaunches(ctx);
      await fetchRecentLaunches(ctx);

      assert.equal(jupiterDiscoveryBreaker.getState(), 'OPEN');
      assert.equal(fetchCount, 3);

      // Now fetchRecentLaunches, fetchTrendingLaunches, fetchPrices
      // all check the shared circuit state and suppress calls without executing fetch!
      const recent = await fetchRecentLaunches(ctx);
      assert.deepEqual(recent, []);

      const trending = await fetchTrendingLaunches(ctx);
      assert.deepEqual(trending, []);

      const prices = await fetchPrices(ctx, ['SomeMint1111111111111111111111111111111111']);
      assert.deepEqual(prices, {});

      // fetchCount should STILL be 3 because all subsequent calls were suppressed!
      assert.equal(fetchCount, 3);
      assert.ok((ctx.state.metrics.jupiterSuppressedRequests || 0) >= 3);
    }
  );
  jupiterDiscoveryBreaker.reset();
});

test('JupiterCircuitBreaker: WebSocket discovery remains unaffected when Jupiter circuit is open', () => {
  jupiterDiscoveryBreaker.reset();
  const ctx = createCtx();

  // Fail circuit 3 times
  for (let i = 0; i < 3; i++) {
    jupiterDiscoveryBreaker.recordFailure(ctx, new Error('Jupiter down'));
  }
  assert.equal(jupiterDiscoveryBreaker.getState(), 'OPEN');

  // Simulate WebSocket mint discovery signal arriving
  const wsMint = 'WsDiscoveredMint1111111111111111111111111';
  ctx.store.trackMint(wsMint);

  assert.ok(ctx.state.processedMints.has(wsMint));
  assert.equal(ctx.state.metrics.jupiterSuppressedRequests, 0); // WS trackMint didn't touch Jupiter
  jupiterDiscoveryBreaker.reset();
});

test('JupiterCircuitBreaker: no duplicate timers or background retry loops created', () => {
  // Verify state transitions are purely passive/now-based and do not leak node timers
  const cb = new JupiterCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });
  const initialTimerCount = (
    process as unknown as { _getActiveHandles: () => unknown[] }
  )._getActiveHandles().length;

  for (let i = 0; i < 3; i++) {
    cb.recordFailure();
  }
  assert.equal(cb.getState(), 'OPEN');

  const afterTimerCount = (
    process as unknown as { _getActiveHandles: () => unknown[] }
  )._getActiveHandles().length;
  // No new active timers or intervals spawned by circuit breaker state changes
  assert.equal(afterTimerCount, initialTimerCount);
});
