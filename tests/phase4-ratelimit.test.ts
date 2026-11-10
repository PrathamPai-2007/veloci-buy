'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import { createCtx, createTestConfig, withMockedFetch } from './_test_helpers.js';
import { fetchJson, parseRetryAfterMs } from '../src/core/utils/fetch.js';
import {
  PRIORITY,
  makePriorityTokenBucket,
  _resetBucketsForTest,
} from '../src/core/utils/rate-limit.js';
import { getRpcBucket, pickLeastLoaded, setRpcRateLimits } from '../src/core/utils/solana.js';
import { RateLimitError } from '../src/core/errors.js';
import { JupiterCircuitBreaker } from '../src/services/jupiter-circuit-breaker.js';
import { TokenAccountIndexService } from '../src/services/account-index/token-account-index.js';
import {
  fetchRugCheckWalletSignals,
  _clearWalletRiskCacheForTest,
} from '../src/services/audit/providers/rugcheck-provider.js';
import type { Context } from '../src/types/index.js';

test('parseRetryAfterMs reads seconds and dates, rejects junk, caps absurd values', () => {
  assert.equal(parseRetryAfterMs('5'), 5000);
  assert.equal(parseRetryAfterMs('1.5'), 1500);
  assert.equal(parseRetryAfterMs('0'), null);
  assert.equal(parseRetryAfterMs(''), null);
  assert.equal(parseRetryAfterMs(null), null);
  assert.equal(parseRetryAfterMs('soon'), null);
  assert.equal(parseRetryAfterMs('999999'), 120_000);
  const now = Date.parse('2026-11-10T00:00:00Z');
  assert.equal(parseRetryAfterMs('Tue, 10 Nov 2026 00:00:07 GMT', now), 7000);
  assert.equal(parseRetryAfterMs('Tue, 10 Nov 2026 00:00:00 GMT', now + 5000), null, 'past date');
});

test('fetchJson 429 carries the server Retry-After into the error', async () => {
  _resetBucketsForTest();
  await withMockedFetch(
    async () => new Response('{}', { status: 429, headers: { 'retry-after': '2' } }),
    async () => {
      await assert.rejects(
        fetchJson('http://ra.test/x', { retries: 0 }),
        (e: unknown) =>
          e instanceof RateLimitError && e.fromServer === true && e.retryAfterMs === 2000
      );
    }
  );
  await withMockedFetch(
    async () => new Response('{}', { status: 429 }),
    async () => {
      await assert.rejects(
        fetchJson('http://ra.test/y', { retries: 0, retryDelayMs: 10 }),
        (e: unknown) => e instanceof RateLimitError && e.fromServer === false
      );
    }
  );
});

test('Jupiter breaker cooldown follows a server Retry-After, else the 30s default', () => {
  const b1 = new JupiterCircuitBreaker();
  b1.recordFailure(undefined, new RateLimitError('429 Too Many Requests', 7000, undefined, true));
  assert.equal(b1.getCurrentCooldownMs(), 7000);

  const b2 = new JupiterCircuitBreaker();
  b2.recordFailure(undefined, new RateLimitError('429 Too Many Requests', 750, undefined, false));
  assert.equal(b2.getCurrentCooldownMs(), 30_000);
});

test('estimateWaitMs is 0 with free tokens and counts only waiters at equal or higher priority', async () => {
  const bucket = makePriorityTokenBucket(2);
  assert.equal(bucket.estimateWaitMs(PRIORITY.LOW), 0);
  await bucket.acquire();
  await bucket.acquire(); // burst drained
  const queuedLows = [1, 2, 3].map(() => bucket.acquire(PRIORITY.LOW));
  const low = bucket.estimateWaitMs(PRIORITY.LOW);
  const urgent = bucket.estimateWaitMs(PRIORITY.ULTRA_HIGH);
  assert.ok(low > urgent, `low ${low}ms should wait longer than urgent ${urgent}ms`);
  assert.ok(urgent > 0 && urgent <= 500, `urgent ${urgent}ms`);
  await Promise.all(queuedLows);
});

test('pickLeastLoaded avoids the drained endpoint and rotates across idle ones', async () => {
  setRpcRateLimits([1, 100, 100], [1, 1, 1]);
  await getRpcBucket(0).acquire(); // endpoint 0 has a 1-token burst; now it must wait
  const cands = [{ index: 0 }, { index: 1 }, { index: 2 }];
  assert.ok(getRpcBucket(0).estimateWaitMs(PRIORITY.MEDIUM) > 100);
  const picks = [0, 1, 2, 3].map((r) => pickLeastLoaded(cands, PRIORITY.MEDIUM, r)!.index);
  assert.ok(!picks.includes(0), `picked the drained endpoint: ${picks}`);
  assert.deepEqual(new Set(picks), new Set([1, 2]));
  assert.equal(pickLeastLoaded([{ index: 0 }], PRIORITY.LOW, 5)!.index, 0);
  setRpcRateLimits([], []);
});

test('holder snapshot queue serves a higher-priority mint before queued lower-priority ones', async () => {
  const MINTS = [
    'Gdpe65jYLRPWZqmFXLoS66HU4r1J8B6GXjAhWXqtfork',
    'H9kuqGKNYgPFYCA17uUTkaqXGum7MK8y1GwbS7cxsjDg',
    'CZzEeJpTsTNWnSWaB5gY6r7fFEAyFpQVDP1aAzXdwQ4P',
  ];
  const order: string[] = [];
  const mockRpc = {
    getTokenLargestAccounts: (mint: string) => ({
      send: async () => {
        order.push(String(mint));
        await new Promise((r) => setTimeout(r, 15));
        return { value: [] };
      },
    }),
  } as any;
  const ctx = {
    config: createTestConfig(),
    rpc: mockRpc,
    rpcs: [mockRpc],
    logger: () => {},
  } as unknown as Context;
  const index = new TokenAccountIndexService();

  const a = index.initializeMintSnapshot(ctx, MINTS[0]!, 1000n, 't', PRIORITY.LOW); // starts now
  const b = index.initializeMintSnapshot(ctx, MINTS[1]!, 1000n, 't', PRIORITY.LOW);
  const c = index.initializeMintSnapshot(ctx, MINTS[2]!, 1000n, 't', PRIORITY.HIGH);
  await Promise.all([a, b, c]);
  assert.deepEqual(order, [MINTS[0], MINTS[2], MINTS[1]]);
});

test('RugCheck wallet risk is cached per address and failures are not cached', async () => {
  _clearWalletRiskCacheForTest();
  _resetBucketsForTest();
  const ctx = createCtx({
    rugcheckApiKey: 'k',
    rugcheckBaseUrl: 'https://mock-rugcheck',
    rugcheckRps: 1000,
  });
  let calls = 0;
  let fail = true;
  await withMockedFetch(
    async (url) => {
      calls++;
      if (fail) return new Response('boom', { status: 500 });
      return new Response(
        JSON.stringify({ riskLevel: String(url).includes('bad') ? 'high' : 'low' }),
        { status: 200 }
      );
    },
    async () => {
      assert.deepEqual(await fetchRugCheckWalletSignals(ctx, ['bad-wallet']), []);
      assert.equal(calls, 1);
      fail = false; // the earlier failure must not have been cached
      assert.deepEqual(await fetchRugCheckWalletSignals(ctx, ['bad-wallet', 'ok-wallet']), [
        'bad-wallet',
      ]);
      assert.equal(calls, 3);
      assert.deepEqual(await fetchRugCheckWalletSignals(ctx, ['bad-wallet', 'ok-wallet']), [
        'bad-wallet',
      ]);
      assert.equal(calls, 3, 'second pass served from cache');
    }
  );
});
