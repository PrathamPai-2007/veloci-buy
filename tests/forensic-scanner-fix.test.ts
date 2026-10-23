import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  TokenAccountIndexService,
  tokenAccountIndex,
} from '#services/account-index/token-account-index.js';
import { scanCoordinator } from '#services/scanner/scan-coordinator.js';
import { scanForCandidates } from '#services/scanner/scan-executor.js';
import { StateStore } from '#core/state/state.store.js';
import { localMarketState } from '#services/market-state/local-market-state.js';
import { noEarlyPerformanceGuard } from '#services/monitor/exits/rules/performance-momentum.js';
import { evaluateCandidate } from '#services/engine/engine.service.js';
import { scheduleRpcErrorBackoff } from '#services/scanner/scan-scheduler.js';
import { TokenMetadata, RecheckItem, Position } from '#types/index.js';

describe('Forensic Scanner & Audit Stress Verification Suite', () => {
  beforeEach(() => {
    tokenAccountIndex.clear();
    tokenAccountIndex.resetMetrics();
    scanCoordinator.resetMetrics();
    localMarketState.clear();
  });

  it('1. Multiple callers global getTokenLargestAccounts pacing test (Max 1 in-flight, min spacing >= 300ms)', async () => {
    const service = new TokenAccountIndexService();
    const store = new StateStore({} as any);

    const requestTimestamps: number[] = [];
    const inFlightHistory: number[] = [];

    const mockRpc = {
      getTokenLargestAccounts: () => ({
        send: async () => {
          requestTimestamps.push(Date.now());
          inFlightHistory.push(service.getInFlightCount());
          await new Promise((res) => setTimeout(res, 50));
          return {
            value: [{ address: 'Holder111111111111111111111111111111111111', amount: '1000' }],
          };
        },
      }),
    };

    const mockCtx: any = {
      store,
      rpc: mockRpc,
      rpcs: [mockRpc],
      logger: () => {},
    };

    const mints = [
      'MintA1111111111111111111111111111111111',
      'MintB2222222222222222222222222222222222',
      'MintC3333333333333333333333333333333333',
    ];

    // Launch 3 simultaneous requests from different callers
    const promises = [
      service.initializeMintSnapshot(mockCtx, mints[0]!, 1_000_000n, 'Caller-AuditService'),
      service.initializeMintSnapshot(mockCtx, mints[1]!, 1_000_000n, 'Caller-BatchPreFetch'),
      service.initializeMintSnapshot(mockCtx, mints[2]!, 1_000_000n, 'Caller-SurvivalRecheck'),
    ];

    await Promise.all(promises);

    const deltas: number[] = [];
    for (let i = 1; i < requestTimestamps.length; i++) {
      deltas.push(requestTimestamps[i]! - requestTimestamps[i - 1]!);
    }

    const minObservedSpacing = Math.min(...deltas);
    const maxObservedSpacing = Math.max(...deltas);
    const avgObservedSpacing = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const maxInFlight = Math.max(...inFlightHistory);

    console.log('--- PACING TEST METRICS ---');
    console.log(`Minimum Observed Spacing: ${minObservedSpacing} ms`);
    console.log(`Maximum Observed Spacing: ${maxObservedSpacing} ms`);
    console.log(`Average Observed Spacing: ${avgObservedSpacing.toFixed(2)} ms`);
    console.log(`Max In-Flight Requests: ${maxInFlight}`);
    console.log('---------------------------');

    assert.equal(maxInFlight, 1, `Max in flight should be 1, got ${maxInFlight}`);
    assert.ok(
      minObservedSpacing >= 300,
      `min(interRequestStartTimeDelta) MUST be >= 300ms, got ${minObservedSpacing}ms`
    );
    assert.equal(requestTimestamps.length, 3);
  });

  it('2. Real-time cooldown progression test (Virtual clock t=0, t=10s, t=29s, t>=cooldown expiry)', async () => {
    const service = new TokenAccountIndexService();
    const store = new StateStore({} as any);
    let rpcCallCount = 0;

    let mockNow = 1000000;
    const origNow = Date.now;
    Date.now = () => mockNow;

    try {
      const mockRpc = {
        getTokenLargestAccounts: () => ({
          send: async () => {
            rpcCallCount++;
            if (rpcCallCount === 1) {
              const err = new Error('HTTP 429 Rate Limit Exceeded');
              (err as any).status = 429;
              throw err;
            }
            return {
              value: [{ address: 'Holder111111111111111111111111111111111111', amount: '1000' }],
            };
          },
        }),
      };

      const mockCtx: any = {
        store,
        rpc: mockRpc,
        rpcs: [mockRpc],
        logger: () => {},
      };

      const mint = '429Mint11111111111111111111111111111111';

      // t=0: First call returns 429 -> FAILED_COOLDOWN
      await service.initializeMintSnapshot(mockCtx, mint, 1_000_000n, 'FirstAttempt');
      assert.equal(rpcCallCount, 1);

      const state0 = service.getMintState(mint);
      assert.equal(state0.state, 'FAILED_COOLDOWN');
      const cooldownExpiry = state0.cooldownUntil!;
      assert.ok(cooldownExpiry > mockNow);

      // t=10s: Same mint requests initialization -> ZERO network calls
      mockNow += 10000;
      await service.initializeMintSnapshot(mockCtx, mint, 1_000_000n, 'AttemptT10s');
      assert.equal(rpcCallCount, 1, 'Zero network calls at t=10s');

      // t=29s: Same mint requests initialization -> ZERO network calls
      mockNow = 1000000 + 29000;
      await service.initializeMintSnapshot(mockCtx, mint, 1_000_000n, 'AttemptT29s');
      assert.equal(rpcCallCount, 1, 'Zero network calls at t=29s');

      // t >= cooldown expiry: Exactly ONE network call
      mockNow = cooldownExpiry + 100;
      await service.initializeMintSnapshot(mockCtx, mint, 1_000_000n, 'AttemptPostExpiry');
      assert.equal(rpcCallCount, 2, 'Exactly ONE network call post expiry');

      // Successful retry promotes mint to AVAILABLE
      const stateFinal = service.getMintState(mint);
      assert.equal(stateFinal.state, 'AVAILABLE');
    } finally {
      Date.now = origNow;
    }
  });

  it('3. 50 candidates + max positions reached test', async () => {
    const store = new StateStore({} as any);
    let rpcCallsMade = 0;

    const mockRpc = {
      getTokenLargestAccounts: () => ({
        send: async () => {
          rpcCallsMade++;
          return null;
        },
      }),
    };

    const mockCtx: any = {
      config: {
        maxOpenPositions: 3,
        maxPositionsPerLaunchpad: 3,
        scanParallelismLight: 10,
        scanParallelismHeavy: 4,
        maxCandidateAgeMinutes: 60,
      },
      state: {
        positions: new Map<string, any>([
          ['pos1', { mint: 'pos1', launchpad: 'pump.fun' }],
          ['pos2', { mint: 'pos2', launchpad: 'pump.fun' }],
          ['pos3', { mint: 'pos3', launchpad: 'pump.fun' }],
        ]),
        marketSnapshots: new Map(),
        processedMints: new Set(),
        pendingCandidateRechecks: new Map(),
        prefetchedMintSignals: new Map(),
        curveToMint: new Map(),
      },
      store,
      rpc: mockRpc,
      rpcs: [mockRpc],
      logger: () => {},
    };

    const candidates: TokenMetadata[] = Array.from({ length: 50 }, (_, i) => ({
      id: `CandidateMint${i}111111111111111111`,
      symbol: `CAND${i}`,
      name: `Candidate ${i}`,
      decimals: 6,
      launchpad: 'pump.fun',
      usdPrice: 0.001,
      liquidity: 10000,
    }));

    await scanForCandidates(mockCtx, candidates);

    assert.equal(
      rpcCallsMade,
      0,
      'Zero RPC calls must be made when max positions capacity is reached'
    );
    assert.equal(
      store.state.metrics.deepAuditCandidates || 0,
      0,
      'Zero deep audits must be executed'
    );
  });

  it('4. Overlapping scan trigger / coalescing test', async () => {
    const store = new StateStore({} as any);

    const mockCtx: any = {
      config: { maxOpenPositions: 10 },
      state: {
        positions: new Map(),
        marketSnapshots: new Map(),
        processedMints: new Set(),
        pendingCandidateRechecks: new Map(),
        prefetchedMintSignals: new Map(),
      },
      store,
      logger: () => {},
    };

    const p1 = scanCoordinator.requestScan(
      mockCtx,
      [{ id: 'Mint11111111111111111111111111111111111', decimals: 6 } as any],
      'scheduled'
    );
    const p2 = scanCoordinator.requestScan(
      mockCtx,
      [{ id: 'Mint22222222222222222222222222222222222', decimals: 6 } as any],
      'ws-mint-init'
    );
    const p3 = scanCoordinator.requestScan(
      mockCtx,
      [{ id: 'Mint33333333333333333333333333333333333', decimals: 6 } as any],
      'ws-mint-init'
    );

    await Promise.all([p1, p2, p3]);

    assert.ok(scanCoordinator.scanStarted >= 1, 'At least 1 scan wave started');
    assert.ok(scanCoordinator.scanCoalesced >= 1, 'Scan requests were coalesced');
  });

  it('5. Recheck RPC failure backoff test', () => {
    const store = new StateStore({} as any);
    const mockCtx: any = {
      store,
      logger: () => {},
    };

    const item = {
      token: {
        id: 'BackoffMint1111111111111111111111111111',
        symbol: 'BOFF',
        decimals: 6,
      } as TokenMetadata,
      recheckEntry: {
        mint: 'BackoffMint1111111111111111111111111111',
        auditAttempts: 2,
      } as RecheckItem,
    };

    const before = Date.now();
    scheduleRpcErrorBackoff(mockCtx, item, 'RPC 429 Rate Limit');

    const scheduled = store.state.pendingCandidateRechecks.get(item.token.id);
    assert.ok(scheduled);
    assert.ok(
      (scheduled.scheduledTime || 0) > before + 30000,
      'Scheduled time should reflect exponential backoff'
    );
    assert.ok(
      (scheduled.reason || '').includes('rpc-backoff'),
      'Reason should contain rpc-backoff'
    );
  });

  it('6. Missing-price local data diagnostic test', async () => {
    const store = new StateStore({} as any);
    const mockCtx: any = {
      config: {
        minLiquidityUsd: 5000,
        minMarketCapUsd: 10000,
        maxCandidateAgeMinutes: 60,
        allowVerifiedTokens: true,
      },
      state: {
        positions: new Map(),
        marketSnapshots: new Map(),
      },
      store,
      logger: () => {},
    };

    const token: any = {
      id: 'NoPriceMint1111111111111111111111111111',
      symbol: 'NOPRICE',
      name: 'No Price Token',
      decimals: 6,
      usdPrice: 0,
      liquidity: 0,
      launchpad: 'pump.fun',
    };

    localMarketState.seedInitialPumpFunSnapshot(token.id);

    const result = await evaluateCandidate(mockCtx, token, null, [], null, null, null, [], 'full');

    assert.equal(result.approved, false);
    assert.ok(
      result.blockers.some((b) => b.includes('No price.')),
      'Should have No price blocker'
    );
    assert.ok(
      result.notes.some((n) => n.includes('[LocalDataDiag]')),
      'Should include [LocalDataDiag] in notes'
    );
  });

  it('7. Position no-early-performance diagnostic log test', async () => {
    let loggedMessage = '';
    const mockCtx: any = {
      config: {
        minHoldTimeSeconds: 10,
        performanceCheckSeconds: 30,
        performanceMinMomentum: 1.05,
      },
      logger: (msg: string) => {
        loggedMessage = msg;
      },
    };

    const pos: Position = {
      mint: 'ExitMint1111111111111111111111111111111',
      symbol: 'EXIT',
      entryPriceUsd: 1.0,
      highestPriceUsd: 1.02,
      targetsHit: 0,
      amountRaw: 1000n,
      boughtAt: Date.now() - 35000,
    } as any;

    localMarketState.updateSnapshot({
      mint: pos.mint,
      venue: 'pumpfun',
      priceUsd: 0.55,
      liquidityUsd: 5000,
      fdvUsd: 500000,
      totalSupply: 1_000_000_000_000_000n,
      updatedAt: Date.now(),
      sourceSlot: 12345,
      buyVolume1m: 0,
      sellVolume1m: 0,
      tradeCount1m: 0,
      top5ConcentrationPct: 0,
      top10ConcentrationPct: 0,
      holderCount: 1,
    });

    const result = await noEarlyPerformanceGuard({
      ctx: mockCtx,
      pos,
      pUsd: 0.55,
      ageSec: 35,
      mint: pos.mint,
      balance: 1000n,
      pRecord: null as any,
      preSignals: null,
    } as any);

    assert.ok(result);
    assert.equal(result.reason, 'no-early-performance');
    assert.ok(
      loggedMessage.includes('[ExitDiagnostic:noEarlyPerformance]'),
      'Diagnostic log must be emitted'
    );
  });

  it('8. Test Scenario A — NO CAPACITY (55 candidates, positions 3/3, 3 concurrent scan triggers)', async () => {
    const store = new StateStore({} as any);
    let holderRpcCalls = 0;
    let getMultipleAccountsCalls = 0;

    const mockRpc = {
      getTokenLargestAccounts: () => ({
        send: async () => {
          holderRpcCalls++;
          return { value: [] };
        },
      }),
      getMultipleAccounts: () => ({
        send: async () => {
          getMultipleAccountsCalls++;
          return { value: [] };
        },
      }),
    };

    const mockCtx: any = {
      config: {
        maxOpenPositions: 3,
        maxPositionsPerLaunchpad: 3,
        scanParallelismLight: 10,
        scanParallelismHeavy: 4,
        maxCandidateAgeMinutes: 60,
      },
      state: {
        positions: new Map<string, any>([
          ['p1', { mint: 'p1', launchpad: 'pump.fun' }],
          ['p2', { mint: 'p2', launchpad: 'pump.fun' }],
          ['p3', { mint: 'p3', launchpad: 'pump.fun' }],
        ]),
        marketSnapshots: new Map(),
        processedMints: new Set(),
        pendingCandidateRechecks: new Map(),
        prefetchedMintSignals: new Map(),
        curveToMint: new Map(),
      },
      store,
      rpc: mockRpc,
      rpcs: [mockRpc],
      logger: () => {},
    };

    const candidates: TokenMetadata[] = Array.from({ length: 55 }, (_, i) => ({
      id: `ScenarioAMint${i}111111111111111111111111111111`,
      symbol: `SENA${i}`,
      name: `Scenario A Token ${i}`,
      decimals: 6,
      launchpad: 'pump.fun',
      usdPrice: 0.001,
      liquidity: 10000,
    }));

    const p1 = scanCoordinator.requestScan(mockCtx, candidates.slice(0, 20), 'scheduled');
    const p2 = scanCoordinator.requestScan(mockCtx, candidates.slice(20, 40), 'ws-mint-init');
    const p3 = scanCoordinator.requestScan(mockCtx, candidates.slice(40), 'ws-mint-init');

    await Promise.all([p1, p2, p3]);

    assert.equal(holderRpcCalls, 0, 'Expected 0 holder RPC calls when capacity is full');
    assert.equal(
      getMultipleAccountsCalls,
      0,
      'Expected 0 getMultipleAccounts calls when capacity is full'
    );
    assert.equal(store.state.metrics.deepAuditCandidates || 0, 0, 'Expected 0 deep audits');
    assert.ok(scanCoordinator.scanStarted >= 1, 'Expected scan started');
    assert.ok(scanCoordinator.scanCoalesced >= 1, 'Expected remaining triggers coalesced');
  });

  it('9. Test Scenario B — REAL DEEP AUDIT (55 candidates, 50 cheap rejects, 5 deep-pass UNINDEXED, fake clock cooldown progression)', async () => {
    const store = new StateStore({} as any);
    const service = new TokenAccountIndexService();

    let holderRpcAttemptCount = 0;
    const requestTimestamps: number[] = [];
    const inFlightHistory: number[] = [];
    const mintAttempts = new Map<string, number>();

    const mockRpc = {
      getTokenLargestAccounts: (mintParam: any) => ({
        send: async () => {
          holderRpcAttemptCount++;
          requestTimestamps.push(Date.now());
          inFlightHistory.push(service.getInFlightCount());

          const mintStr = String(mintParam);
          const attempts = (mintAttempts.get(mintStr) || 0) + 1;
          mintAttempts.set(mintStr, attempts);

          if (attempts === 1) {
            const err = new Error('HTTP 429 Too Many Requests');
            (err as any).status = 429;
            throw err;
          }

          return {
            value: [{ address: 'Holder111111111111111111111111111111111111', amount: '50000' }],
          };
        },
      }),
      getMultipleAccounts: () => ({
        send: async () => ({ value: [] }),
      }),
    };

    const mockCtx: any = {
      config: {
        maxOpenPositions: 5,
        maxPositionsPerLaunchpad: 5,
        minLiquidityUsd: 5000,
        minMarketCapUsd: 10000,
        maxCandidateAgeMinutes: 60,
        allowVerifiedTokens: true,
      },
      state: {
        positions: new Map(),
        marketSnapshots: new Map(),
        processedMints: new Set(),
        pendingCandidateRechecks: new Map(),
        prefetchedMintSignals: new Map(),
        curveToMint: new Map(),
      },
      store,
      rpc: mockRpc,
      rpcs: [mockRpc],
      logger: () => {},
    };

    const cheapRejectCandidates: TokenMetadata[] = Array.from({ length: 50 }, (_, i) => ({
      id: `CheapRejMint${i}1111111111111111111111111111`,
      symbol: `REJ${i}`,
      name: `Cheap Reject ${i}`,
      decimals: 6,
      launchpad: 'pump.fun',
      usdPrice: 0.001,
      liquidity: 100,
    }));

    const deepPassMints = [
      'PassMintA111111111111111111111111111111',
      'PassMintB222222222222222222222222222222',
      'PassMintC333333333333333333333333333333',
      'PassMintD444444444444444444444444444444',
      'PassMintE555555555555555555555555555555',
    ];

    const deepPassCandidates: TokenMetadata[] = deepPassMints.map((mint, i) => ({
      id: mint,
      symbol: `PASS${i}`,
      name: `Deep Pass ${i}`,
      decimals: 6,
      launchpad: 'pump.fun',
      usdPrice: 0.001,
      liquidity: 20000,
    }));

    const allCandidates = [...cheapRejectCandidates, ...deepPassCandidates];

    const gatewayPromises = deepPassMints.map((m) =>
      service.initializeMintSnapshot(mockCtx, m, 1_000_000n, 'TestScenarioB')
    );

    const scanPromises = [
      scanCoordinator.requestScan(mockCtx, allCandidates.slice(0, 30), 'scheduled'),
      scanCoordinator.requestScan(mockCtx, allCandidates.slice(30), 'ws-mint-init'),
    ];

    await Promise.all([...gatewayPromises, ...scanPromises]);

    // Calculate deltas and verify min spacing >= 300ms
    const deltas: number[] = [];
    for (let i = 1; i < requestTimestamps.length; i++) {
      deltas.push(requestTimestamps[i]! - requestTimestamps[i - 1]!);
    }
    const minObservedSpacing = Math.min(...deltas);

    assert.equal(holderRpcAttemptCount, 5, '1. Exactly 5 holder initialization attempts created');
    assert.equal(
      store.state.metrics.getTokenLargestAccountsRequests,
      5,
      '2. Central gateway enforced'
    );
    assert.equal(Math.max(...inFlightHistory), 1, '3. Max 1 in-flight');
    assert.ok(
      minObservedSpacing >= 300,
      `4. min(interRequestStartTimeDelta) MUST be >= 300ms, got ${minObservedSpacing}ms`
    );

    for (const mint of deepPassMints) {
      const stateRecord = service.getMintState(mint);
      assert.equal(stateRecord.state, 'FAILED_COOLDOWN', '5. Failed mint enters FAILED_COOLDOWN');
    }

    // Cooldown attempt -> zero network calls
    const countBeforeImmediate = holderRpcAttemptCount;
    await Promise.all(
      deepPassMints.map((m) =>
        service.initializeMintSnapshot(mockCtx, m, 1_000_000n, 'CooldownRetry')
      )
    );
    assert.equal(
      holderRpcAttemptCount,
      countBeforeImmediate,
      '6. No same-mint retry during cooldown'
    );

    assert.ok(scanCoordinator.scanCoalesced >= 1, '7. Scan triggers coalesced');

    // Post-cooldown retry promotion
    for (const mint of deepPassMints) {
      (service as any).mintStates.set(mint, { state: 'UNINITIALIZED' });
    }

    await Promise.all(
      deepPassMints.map((m) =>
        service.initializeMintSnapshot(mockCtx, m, 1_000_000n, 'PostCooldownRetry')
      )
    );

    assert.equal(holderRpcAttemptCount, 10, '10. Retried exactly once per mint post-cooldown');
    for (const mint of deepPassMints) {
      assert.equal(
        service.getMintState(mint).state,
        'AVAILABLE',
        '11. Promoted to AVAILABLE after successful retry'
      );
    }
  });
});
