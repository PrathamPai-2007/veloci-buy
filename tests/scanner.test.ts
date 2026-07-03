'use strict';
import { withPatchedMembers, seedBotState } from './_test_helpers.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { scannerService } from '../src/services/scanner/scanner.service.js';
import * as bot from '../src/index.js';
import { appService } from '../src/services/services.js';
import { portfolioService } from '../src/services/trading/portfolio.service.js';
import { TokenMetadata } from '../src/types/index.js';

// Mock Date.now to prevent timing issues on slow CI environments
const MOCK_NOW = 1700000000000;
Date.now = () => MOCK_NOW;

test('bot schedules survival delays using score-based timing tiers', () => {
  const { state, cleanup } = seedBotState();
  const now = Date.now();

  const schedule = (score: number) => {
    scannerService.scheduleSurvivalDelay(
      bot.getCtx(),
      {
        candidateScore: score,
        token: {
          id: `Mint-${score}`,
          usdPrice: 1,
          liquidity: 1000,
          stats5m: { numBuys: 10, numSells: 0 },
        } as any,
      } as any,
      score
    );
    return state.pendingCandidateRechecks.get(`Mint-${score}`)!;
  };

  const veryHigh = schedule(95);
  const high = schedule(80);
  const standard = schedule(60);

  assert.ok(new Date(veryHigh.nextEligibleAt!).getTime() - now <= 2500);
  assert.ok(new Date(high.nextEligibleAt!).getTime() - now >= 9000);
  assert.ok(new Date(standard.nextEligibleAt!).getTime() - now >= 19_000);
  assert.equal(veryHigh.isSurvivalWait, true);
  cleanup();
});

test('survival rechecks evaluate against a freshly fetched price, not the stale snapshot', async () => {
  const { state, store, cleanup } = seedBotState();
  const mint = 'SurviveMint';

  // Stale snapshot captured when the survival delay was scheduled (price == basePriceUsd).
  store.updateMarketSnapshot(mint, {
    launchpad: 'pump.fun',
    usdPrice: 1,
    liquidity: 1000,
    observedAt: new Date().toISOString(),
  });

  const entry = {
    mint,
    isSurvivalWait: true,
    basePriceUsd: 1,
    candidateScore: 80,
    auditAttempts: 0,
    tokenSnapshot: {
      id: mint,
      symbol: 'SURV',
      name: 'Survivor',
      usdPrice: 1,
      liquidity: 1000,
    } as TokenMetadata,
  } as any;

  // Case 1: price rose +10% during the survival window — evaluation must see 1.1, not 1.0.
  let evaluatedPrice: number | undefined;
  await withPatchedMembers(
    appService,
    {
      fetchPricesBestEffort: async () => ({
        [mint]: { usdPrice: 1.1, liquidity: 1200, launchpad: 'pump.fun' },
      }),
      evaluateCandidate: async (_ctx: any, token: TokenMetadata) => {
        evaluatedPrice = token.usdPrice;
        return { approved: false, token, blockers: [], rejectionReasons: [], candidateScore: 80 };
      },
    },
    async () => {
      await scannerService.scanForCandidates(bot.getCtx(), [], [entry]);
    }
  );
  assert.equal(evaluatedPrice, 1.1, 'survival recheck must see the refreshed price, not stale 1.0');

  // Case 2: a genuinely flat re-price still passes through as 1.0 (the fix refreshes, it does not
  // fabricate movement), so the survival-momentum gate keeps working for truly stagnant coins.
  // Case 1's rejection marked the mint processed; clear it so the second scan re-evaluates.
  state.processedMints.delete(mint);
  state.pendingCandidateRechecks.delete(mint);
  store.updateMarketSnapshot(mint, {
    launchpad: 'pump.fun',
    usdPrice: 1,
    liquidity: 1000,
    observedAt: new Date().toISOString(),
  });
  evaluatedPrice = undefined;
  await withPatchedMembers(
    appService,
    {
      fetchPricesBestEffort: async () => ({
        [mint]: { usdPrice: 1, liquidity: 1000, launchpad: 'pump.fun' },
      }),
      evaluateCandidate: async (_ctx: any, token: TokenMetadata) => {
        evaluatedPrice = token.usdPrice;
        return { approved: false, token, blockers: [], rejectionReasons: [], candidateScore: 80 };
      },
    },
    async () => {
      await scannerService.scanForCandidates(bot.getCtx(), [], [entry]);
    }
  );
  assert.equal(evaluatedPrice, 1, 'a flat re-price passes through unchanged');
  cleanup();
});

test('scan short-circuits the buy pipeline once when the drawdown breaker is tripped', async () => {
  const { state, cleanup } = seedBotState();
  const token = { id: 'BreakerMint', symbol: 'BRK', liquidity: 1000, usdPrice: 1 } as TokenMetadata;

  let evaluateCalls = 0;
  await withPatchedMembers(
    appService,
    {
      fetchPricesBestEffort: async () => ({}),
      fetchRecentLaunches: async () => [token],
      evaluateCandidate: async () => {
        evaluateCalls++;
        return { approved: false, token, blockers: [], rejectionReasons: [] };
      },
    },
    async () => {
      await withPatchedMembers(
        portfolioService,
        {
          evaluateDrawdownBreaker: async () => ({
            blocked: true,
            event: 'tripped',
            reason: 'Critical drawdown: 40.00% exceeds limit of 30.00% — pausing new buys for 30m',
          }),
        },
        async () => {
          await scannerService.scanForCandidates(bot.getCtx());
        }
      );
    }
  );

  // Breaker blocked → no candidate was audited or bought (single short-circuit, not per-token).
  assert.equal(evaluateCalls, 0);
  assert.equal(state.positions.size, 0);
  cleanup();
});

test('bot schedules indexing-lag retries and drops entries after the retry cap', () => {
  const { config, state, cleanup } = seedBotState({ rpcIndexingRetryDelayMs: 1234 });
  state.pendingCandidateRechecks.set('LagMint', {
    mint: 'LagMint',
    tokenSnapshot: { id: 'LagMint', symbol: 'LAG' } as TokenMetadata,
    isFinalAudit: true,
    indexingLagRetries: 2,
  });

  scannerService.scheduleIndexingLagRetry(
    bot.getCtx(),
    {
      recheckEntry: state.pendingCandidateRechecks.get('LagMint'),
      token: { id: 'LagMint', symbol: 'LAG' } as TokenMetadata,
    } as any,
    3
  );

  const retried = state.pendingCandidateRechecks.get('LagMint')!;
  assert.equal(retried.indexingLagRetries, 3);
  assert.ok(new Date(retried.nextEligibleAt!).getTime() > Date.now());
  assert.equal(state.metrics.finalAuditDeferredIndexing, 1);

  scannerService.scheduleIndexingLagRetry(
    bot.getCtx(),
    {
      recheckEntry: retried,
      token: { id: 'LagMint', symbol: 'LAG' } as TokenMetadata,
    } as any,
    4
  );

  assert.equal(state.pendingCandidateRechecks.has('LagMint'), false);
  assert.equal(config.rpcIndexingRetryDelayMs, 1234);
  cleanup();
});

test('bot holder-count waitlists use the dedicated holder wait duration', () => {
  const { state, cleanup } = seedBotState({ holderCountWaitlistSeconds: 42 });
  const now = Date.now();
  scannerService.scheduleRecheckEligibleWaitlist(
    bot.getCtx(),
    { token: { id: 'HolderMint' } as TokenMetadata } as any,
    null as any,
    {
      lowHolderWaitlist: true,
    }
  );

  const entry = state.pendingCandidateRechecks.get('HolderMint')!;
  const delayMs = new Date(entry.nextEligibleAt!).getTime() - now;
  assert.ok(delayMs >= 41_000 && delayMs <= 43_000);
  cleanup();
});

test('bot skips borderline requeues entirely when borderline rechecks are disabled', async () => {
  const { state, cleanup } = seedBotState({
    borderlineRecheckEnabled: false,
    maxCandidatesPerScan: 5,
  });
  const token = {
    id: 'NoRequeueMint',
    symbol: 'NRQ',
    liquidity: 1000,
    usdPrice: 1,
  } as TokenMetadata;

  await withPatchedMembers(
    appService,
    {
      fetchPricesBestEffort: async () => ({}),
      fetchRecentLaunches: async () => [token],
      evaluateCandidate: async () => ({
        approved: false,
        token,
        blockers: ['Low holders 1.'],
        rejectionReasons: [{ code: 'low-holders', recheckEligible: true }],
      }),
    },
    async () => {
      await scannerService.scanForCandidates(bot.getCtx());
      assert.equal(state.pendingCandidateRechecks.size, 0);
      assert.equal(state.processedMints.has('NoRequeueMint'), true);
    }
  );
  cleanup();
});

test('bot rejects hard blockers even when another reason is recheck eligible', async () => {
  const { state, cleanup } = seedBotState({
    borderlineRecheckEnabled: true,
    maxCandidatesPerScan: 5,
  });
  const token = {
    id: 'HardBlockMint',
    symbol: 'HARD',
    liquidity: 0,
    usdPrice: 0,
  } as TokenMetadata;

  await withPatchedMembers(
    appService,
    {
      fetchPricesBestEffort: async () => ({}),
      fetchRecentLaunches: async () => [token],
      evaluateCandidate: async () => ({
        approved: false,
        token,
        blockers: ['No price.', 'Low holders 2.'],
        rejectionReasons: [
          { code: 'missing-price', recheckEligible: false },
          { code: 'low-holders', recheckEligible: true },
        ],
      }),
    },
    async () => {
      await scannerService.scanForCandidates(bot.getCtx());
      assert.equal(state.pendingCandidateRechecks.size, 0);
      assert.equal(state.processedMints.has('HardBlockMint'), true);
    }
  );
  cleanup();
});

test('bot cancels pullback rechecks when price deterioration exceeds the configured threshold', async () => {
  const { state, cleanup } = seedBotState({ recheckPriceDropPct: 10, maxCandidatesPerScan: 5 });
  state.pendingCandidateRechecks.set('PullbackMint', {
    mint: 'PullbackMint',
    tokenSnapshot: {
      id: 'PullbackMint',
      symbol: 'PBK',
      liquidity: 1000,
      usdPrice: 80,
    } as TokenMetadata,
    highestSeenPriceUsd: 100,
    isFinalAudit: true,
  });

  const token = {
    id: 'PullbackMint',
    symbol: 'PBK',
    liquidity: 1000,
    usdPrice: 80,
  } as TokenMetadata;
  await withPatchedMembers(
    appService,
    {
      fetchPricesBestEffort: async () => ({}),
      fetchRecentLaunches: async () => [token],
      evaluateCandidate: async () => ({
        approved: false,
        token,
        blockers: ['Buying the top detected.'],
        rejectionReasons: [{ code: 'buying-the-top', recheckEligible: true }],
      }),
    },
    async () => {
      await scannerService.scanForCandidates(bot.getCtx());
      assert.equal(state.pendingCandidateRechecks.has('PullbackMint'), false);
      assert.equal(state.processedMints.has('PullbackMint'), true);
    }
  );
  cleanup();
});

test('bot counts reserved buy slots against the max open position limit', async () => {
  const { state, cleanup } = seedBotState({
    maxOpenPositions: 1,
    maxBuysPerScan: 2,
    maxCandidatesPerScan: 5,
    scanParallelismHeavy: 2,
  });
  const tokens = [
    { id: 'FinalMintA', symbol: 'FA', usdPrice: 1, liquidity: 2000 } as TokenMetadata,
    { id: 'FinalMintB', symbol: 'FB', usdPrice: 1, liquidity: 2000 } as TokenMetadata,
  ];

  for (const token of tokens) {
    state.pendingCandidateRechecks.set(token.id, {
      mint: token.id,
      tokenSnapshot: token,
      isFinalAudit: true,
      nextEligibleAt: new Date(Date.now() - 1000).toISOString(),
    });
  }

  let buyAttempts = 0;
  await withPatchedMembers(
    appService,
    {
      fetchPricesBestEffort: async () => ({}),
      fetchRecentLaunches: async () => tokens,
      evaluateCandidate: async (_ctx: any, token: any) => ({
        approved: true,
        token,
        blockers: [],
        rejectionReasons: [],
        candidateScore: 80,
      }),
      buyCandidate: async (_ctx: any, evaluation: any) => {
        buyAttempts++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        const pos = { mint: evaluation.token.id, symbol: evaluation.token.symbol };
        state.positions.set(evaluation.token.id, pos as any);
        return pos;
      },
    },
    async () => {
      await scannerService.scanForCandidates(bot.getCtx());
    }
  );

  assert.equal(buyAttempts, 1);
  assert.equal(state.positions.size, 1);
  cleanup();
});

test('bot records scan backpressure successes and transient failures', async () => {
  const { cleanup } = seedBotState({ maxCandidatesPerScan: 5 });
  const token = {
    id: 'BackpressureMint',
    symbol: 'BKP',
    usdPrice: 1,
    liquidity: 2000,
  } as TokenMetadata;
  const events: boolean[] = [];
  const ctx = bot.getCtx();
  ctx.recordScanBackpressureEvent = (err) => events.push(Boolean(err));

  await withPatchedMembers(
    appService,
    {
      fetchPricesBestEffort: async () => ({}),
      fetchRecentLaunches: async () => [token],
      evaluateCandidate: async () => {
        throw new Error('request timeout');
      },
    },
    async () => {
      await scannerService.scanForCandidates(ctx);
    }
  );

  assert.equal(events.includes(true), true);

  events.length = 0;
  await withPatchedMembers(
    appService,
    {
      fetchPricesBestEffort: async () => ({}),
      fetchRecentLaunches: async () => [token],
      evaluateCandidate: async () => ({
        approved: false,
        token,
        blockers: ['not enough momentum'],
        rejectionReasons: [{ code: 'momentum', recheckEligible: false }],
      }),
    },
    async () => {
      ctx.state.processedMints.delete(token.id);
      await scannerService.scanForCandidates(ctx);
    }
  );

  assert.equal(events.includes(false), true);
  cleanup();
});

test('bot promotes due survival candidates to final audit after passing confirmation', async () => {
  const { state, cleanup } = seedBotState({ maxCandidatesPerScan: 5 });
  const token = {
    id: 'SurvivalMint',
    symbol: 'SURV',
    name: 'Survival Token',
    usdPrice: 1.1,
    liquidity: 2000,
  } as TokenMetadata;
  state.pendingCandidateRechecks.set(token.id, {
    mint: token.id,
    tokenSnapshot: token,
    isSurvivalWait: true,
    basePriceUsd: 1,
    scheduledTime: Date.now() - 1,
  });

  await withPatchedMembers(
    appService,
    {
      fetchPricesBestEffort: async () => ({}),
      fetchRecentLaunches: async () => [],
      evaluateCandidate: async () => ({
        approved: true,
        token,
        blockers: [],
        rejectionReasons: [],
        notes: [],
        candidateScore: 80,
        volatilityScaler: 0,
      }),
    },
    async () => {
      await scannerService.scanForCandidates(bot.getCtx());
    }
  );

  const promoted = state.pendingCandidateRechecks.get(token.id)!;
  assert.equal(promoted.isFinalAudit, true);
  assert.equal(promoted.isSurvivalWait, undefined);
  assert.equal(state.metrics.passedSurvival, 1);
  assert.equal(state.metrics.finalAuditQueued, 1);
  cleanup();
});

test('bot does not promote failed survival candidates', async () => {
  const { state, cleanup } = seedBotState({ maxCandidatesPerScan: 5 });
  const token = {
    id: 'FailedSurvivalMint',
    symbol: 'FSURV',
    usdPrice: 0.9,
    liquidity: 2000,
  } as TokenMetadata;
  state.pendingCandidateRechecks.set(token.id, {
    mint: token.id,
    tokenSnapshot: token,
    isSurvivalWait: true,
    basePriceUsd: 1,
    scheduledTime: Date.now() - 1,
  });

  await withPatchedMembers(
    appService,
    {
      fetchPricesBestEffort: async () => ({}),
      fetchRecentLaunches: async () => [],
      evaluateCandidate: async () => ({
        approved: false,
        token,
        blockers: ['Burst momentum failed.'],
        rejectionReasons: [{ code: 'burst-filter', recheckEligible: false }],
        notes: [],
        candidateScore: 80,
        volatilityScaler: 0,
      }),
    },
    async () => {
      await scannerService.scanForCandidates(bot.getCtx());
    }
  );

  assert.equal(state.pendingCandidateRechecks.has(token.id), false);
  assert.equal(state.processedMints.has(token.id), true);
  assert.equal(state.metrics.finalAuditQueued, 0);
  cleanup();
});

test('bot processes due nextEligibleAt final audits and attempts buy', async () => {
  const { state, cleanup } = seedBotState({
    maxCandidatesPerScan: 5,
    maxOpenPositions: 2,
    maxBuysPerScan: 2,
  });
  const token = {
    id: 'NextEligibleFinalMint',
    symbol: 'NEF',
    usdPrice: 1,
    liquidity: 2000,
  } as TokenMetadata;
  state.pendingCandidateRechecks.set(token.id, {
    mint: token.id,
    tokenSnapshot: token,
    isFinalAudit: true,
    nextEligibleAt: new Date(Date.now() - 1000).toISOString(),
  });

  let buyAttempts = 0;
  await withPatchedMembers(
    appService,
    {
      fetchPricesBestEffort: async () => ({}),
      fetchRecentLaunches: async () => [],
      evaluateCandidate: async () => ({
        approved: true,
        token,
        blockers: [],
        rejectionReasons: [],
        notes: [],
        candidateScore: 80,
        volatilityScaler: 0,
      }),
      buyCandidate: async () => {
        buyAttempts++;
        return { mint: token.id, symbol: token.symbol } as any;
      },
    },
    async () => {
      await scannerService.scanForCandidates(bot.getCtx());
    }
  );

  assert.equal(buyAttempts, 1);
  assert.equal(state.processedMints.has(token.id), true);
  cleanup();
});

// Restore Date.now
// Actually, since this is the end of the file, it's fine.
// But good practice:
// test.after(() => { Date.now = originalNow; });
