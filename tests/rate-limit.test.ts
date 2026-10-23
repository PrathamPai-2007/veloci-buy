'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { withMockedFetch } from './_test_helpers.js';
import {
  PRIORITY,
  makePriorityTokenBucket,
  redactUrl,
  _resetBucketsForTest,
} from '../src/core/utils/rate-limit.js';
import { fetchJson } from '../src/core/utils/fetch.js';
import { withHeavySlot } from '../src/core/utils/solana.js';

test('priority bucket serves a late ULTRA_HIGH request before queued LOW requests', async () => {
  const bucket = makePriorityTokenBucket(2); // 2 tokens up front, then 1 every 500ms
  const order: string[] = [];
  const lows = Array.from({ length: 5 }, (_, i) =>
    bucket.acquire(PRIORITY.LOW).then(() => order.push(`low${i}`))
  );
  const exit = bucket.acquire(PRIORITY.ULTRA_HIGH).then(() => order.push('exit'));
  await Promise.all([...lows, exit]);
  // The two burst tokens went to low0/low1 immediately; the exit gets the very next token.
  assert.deepEqual(order.slice(0, 3), ['low0', 'low1', 'exit']);
});

test('fetchJson takes a rate-limit token on every retry attempt', async () => {
  _resetBucketsForTest();
  let calls = 0;
  const startedAt = Date.now();
  await withMockedFetch(
    async () => {
      calls++;
      return new Response('{"error":"slow down"}', { status: 429 });
    },
    async () => {
      await assert.rejects(
        fetchJson('http://rate.test/x', {
          retries: 2,
          retryDelayMs: 1,
          rateLimit: { key: 'test:retry', rps: 2, priority: PRIORITY.LOW },
        }),
        /429/
      );
    }
  );
  assert.equal(calls, 3);
  // Bucket holds 2 tokens; the 3rd attempt must wait for a refill (slowed further by the
  // 429 penalty). Retries that bypassed the bucket would finish in a few milliseconds.
  assert.ok(Date.now() - startedAt >= 800, `elapsed ${Date.now() - startedAt}ms`);
});

test('redactUrl strips Telegram, Discord and api-key secrets', () => {
  const tg = redactUrl(
    'Request failed for https://api.telegram.org/bot123456:AAbbCC_dd-ee/sendMessage'
  );
  assert.ok(!tg.includes('AAbbCC'), tg);
  const discord = redactUrl('https://discord.com/api/webhooks/987654321/secretTokenValue_x');
  assert.ok(!discord.includes('secretTokenValue'), discord);
  const helius = redactUrl('HTTP 429 for https://mainnet.helius-rpc.com/?api-key=abcd-1234 body');
  assert.ok(!helius.includes('abcd-1234'), helius);
  const bare = redactUrl('error api-key=zzz9 happened');
  assert.ok(!bare.includes('zzz9'), bare);
});

test('withHeavySlot keeps the second heavy call queued until the first settles', async () => {
  const events: string[] = [];
  let releaseFirst: () => void = () => {};
  const first = withHeavySlot(async () => {
    events.push('first:start');
    await new Promise<void>((r) => (releaseFirst = r));
    events.push('first:end');
  });
  const second = withHeavySlot(async () => {
    events.push('second:start');
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(events, ['first:start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);
});
