'use strict';
import assert from 'node:assert/strict';
import test from 'node:test';

import { createTestConfig } from './_test_helpers.js';
import { VelociBuyBot } from '../src/core/bot.js';
import { StateStore } from '../src/core/store.js';

test('WebSocket RPC returns to the primary after time on a fallback', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const config = createTestConfig({
    rpcUrls: ['http://localhost:8899'],
    wsRpcUrls: ['ws://localhost:8900', 'ws://localhost:8901'],
  });
  const bot = new VelociBuyBot(config, { address: 'x' } as any, new StateStore(config));
  const pool = (bot as any).rpcSubscriptionPool;
  assert.equal(pool.length, 2);

  bot.rotateRpcSubscriptions();
  assert.equal(bot.rpcSubscriptions, pool[1]);

  t.mock.timers.tick(10 * 60_000);
  assert.equal(bot.rpcSubscriptions, pool[0]);
  assert.equal(bot.getCtx().getCurrentRpcSubscriptions(), pool[0]);
});
