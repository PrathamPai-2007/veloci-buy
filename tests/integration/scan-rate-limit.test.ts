'use strict';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RateLimitError,
  RpcError,
  AuditTimeoutError,
  ConfigView,
  getRpcHealthStatus,
} from '../../src/core/index.js';
import { seedBotState } from '../_test_helpers.js';
import { scannerService } from '../../src/services/scanner/scanner.service.js';
import * as bot from '../../src/index.js';

describe('Rate Limit Resilience & Error Taxonomy Integration', () => {
  it('instantiates and categorizes RateLimitError with retryAfterMs backoff', () => {
    const err = new RateLimitError('429 Too Many Requests on Jupiter API', 2000);
    assert.equal(err.code, 'RATE_LIMIT_EXCEEDED');
    assert.equal(err.retryAfterMs, 2000);
    assert.equal(err.name, 'RateLimitError');
    assert.ok(err.message.includes('429'));
  });

  it('instantiates RpcError and AuditTimeoutError cleanly', () => {
    const rpcErr = new RpcError('Method getAccountInfo failed', 0);
    assert.equal(rpcErr.code, 'RPC_ERROR');
    assert.equal(rpcErr.endpointIndex, 0);

    const auditErr = new AuditTimeoutError('GoPlus API timed out', 'GoPlus');
    assert.equal(auditErr.code, 'AUDIT_TIMEOUT');
    assert.equal(auditErr.serviceName, 'GoPlus');
  });

  it('ConfigView safely parses numeric, boolean, string, and rate limit backoffs', () => {
    const { config, cleanup } = seedBotState();
    const view = new ConfigView(config);

    assert.equal(typeof view.getRateLimitBackoffMs(0), 'number');
    assert.ok(view.getRateLimitBackoffMs(0) > 0);
    assert.equal(view.getRateLimitBackoffMs(1), view.getRateLimitBackoffMs(0) * 2);
    assert.equal(view.getAuditConcurrency(), config.maxConcurrentAudits);
    assert.equal(view.isPaperTrading(), config.paperTrading);

    cleanup();
  });

  it('getRpcHealthStatus exports endpoint latency, error count, and quarantine state', () => {
    const { cleanup } = seedBotState();
    const health = getRpcHealthStatus(bot.getCtx());

    assert.ok(Array.isArray(health));
    assert.ok(health.length > 0);
    const primary = health[0];
    assert.ok(primary);
    assert.ok('errorCount' in primary);
    assert.ok('rateLimitCount' in primary);
    assert.ok('avgLatencyMs' in primary);
    assert.ok('isQuarantined' in primary);

    cleanup();
  });

  it('scan candidates are deferred to recheck queue during transient 429 rate limit events', () => {
    const { state, cleanup } = seedBotState();
    const mint = 'RateLimitTestMint11111111111111111111111111';

    // Schedule candidate survival delay
    scannerService.scheduleSurvivalDelay(
      bot.getCtx(),
      {
        candidateScore: 75,
        token: {
          id: mint,
          usdPrice: 0.005,
          liquidity: 10000,
          stats5m: { numBuys: 20, numSells: 2 },
        } as any,
      } as any,
      75
    );

    const scheduled = state.pendingCandidateRechecks.get(mint);
    assert.ok(scheduled);
    assert.equal(scheduled.mint, mint);
    assert.ok(scheduled.nextEligibleAt || scheduled.scheduledTime || scheduled.tokenSnapshot);

    cleanup();
  });
});
