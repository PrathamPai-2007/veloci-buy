'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkFailureFetch, createFlakyFetch } from '../mocks/fault-injection.js';
import { createMockJupiterQuote, createMockRugCheckReport } from '../mocks/external-apis.js';
import { withMockedFetch } from '../_test_helpers.js';

test('external API mocks generate valid schema objects', () => {
  const quote = createMockJupiterQuote({ outAmount: '2000000000' });
  assert.equal(quote.outAmount, '2000000000');
  assert.equal(quote.slippageBps, 500);

  const report = createMockRugCheckReport({ score: 95 });
  assert.equal(report.score, 95);
  assert.equal(report.freezeAuthority, null);
});

test('fault injection simulates network failures and HTTP status codes cleanly', async () => {
  const failureFetch = createNetworkFailureFetch(500, 'Internal Server Error');

  await withMockedFetch(failureFetch, async () => {
    const res = await fetch('http://mock-api.com/test');
    assert.equal(res.status, 500);
    const body = (await res.json()) as any;
    assert.equal(body.error, 'Internal Server Error');
  });
});

test('fault injection simulates retry resilience with flaky fetch', async () => {
  const flakyFetch = createFlakyFetch(2, { status: 'success' });

  await withMockedFetch(flakyFetch, async () => {
    const res1 = await fetch('http://mock-api.com/test');
    assert.equal(res1.status, 429); // First call fails

    const res2 = await fetch('http://mock-api.com/test');
    assert.equal(res2.status, 429); // Second call fails

    const res3 = await fetch('http://mock-api.com/test');
    assert.equal(res3.status, 200); // Third call succeeds
    const body = (await res3.json()) as any;
    assert.equal(body.status, 'success');
  });
});
