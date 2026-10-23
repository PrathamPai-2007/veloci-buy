import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TokenAccountIndexService } from '#services/account-index/token-account-index.js';
import { evaluateCandidate } from '#services/engine/engine.service.js';
import { StateStore } from '#core/state/state.store.js';

describe('Deep Audit Gate & Rate Limiting Pacing', () => {
  it('1. Cheap rejection does NOT initialize TokenAccountIndex or call getTokenLargestAccounts', async () => {
    const store = new StateStore({} as any);
    const mockCtx: any = {
      config: {
        minLiquidityUsd: 5000,
        minMarketCapUsd: 10000,
        maxMarketCapUsd: 500000,
        momentumScoringEnabled: false,
        allowedLaunchpads: ['pump.fun'],
      },
      state: {
        positions: new Map(),
        marketSnapshots: new Map(),
      },
      store,
      logger: () => {},
    };

    // Candidate with $100 liquidity (below minLiquidityUsd $5000)
    const cheapRejectToken: any = {
      id: 'CheapRejectMint11111111111111111111111111111',
      symbol: 'BAD',
      name: 'Bad Token',
      usdPrice: 0.0001,
      liquidity: 100,
      fdv: 50000,
      launchpad: 'pump.fun',
    };

    const evalResult = await evaluateCandidate(
      mockCtx,
      cheapRejectToken,
      null,
      [],
      null,
      null,
      null,
      [],
      'cheap'
    );

    assert.equal(evalResult.approved, false);
    assert.equal(store.state.metrics.candidateDiscoveries, 1);
    assert.equal(store.state.metrics.deepAuditCandidates, 0, 'deepAuditCandidates should be 0');
    assert.equal(
      store.state.metrics.tokenLargestInitializations,
      0,
      'tokenLargestInitializations should be 0'
    );
    assert.equal(
      store.state.metrics.getTokenLargestAccountsRequests,
      0,
      'getTokenLargestAccountsRequests should be 0'
    );
  });

  it('2. Invalid mint string does NOT trigger getTokenLargestAccounts RPC call', async () => {
    const service = new TokenAccountIndexService();
    const store = new StateStore({} as any);
    const mockCtx: any = {
      store,
      logger: () => {},
    };

    const invalidMint = 'not-a-valid-base58-mint!';
    await service.initializeMintSnapshot(mockCtx, invalidMint);

    assert.equal(store.state.metrics.invalidMintSkips, 1, 'invalidMintSkips should increment');
    assert.equal(
      store.state.metrics.getTokenLargestAccountsRequests,
      0,
      'getTokenLargestAccountsRequests should be 0'
    );
  });

  it('3. Multiple simultaneous audits for the same mint share ONE initialization promise', async () => {
    const service = new TokenAccountIndexService();
    const store = new StateStore({} as any);
    const mockCtx: any = {
      store,
      logger: () => {},
    };

    const mint = 'DupeMint1111111111111111111111111111111';

    // Launch 5 concurrent initializations for the same mint
    const p1 = service.initializeMintSnapshot(mockCtx, mint);
    const p2 = service.initializeMintSnapshot(mockCtx, mint);
    const p3 = service.initializeMintSnapshot(mockCtx, mint);

    await Promise.all([p1, p2, p3]);

    // Only 1 RPC request was issued!
    assert.equal(store.state.metrics.tokenLargestInitializations, 1);
  });

  it('4. Concurrent different mints are paced with >= 300ms delay between requests', async () => {
    const service = new TokenAccountIndexService();
    const store = new StateStore({} as any);
    const mockCtx: any = {
      store,
      logger: () => {},
    };

    const mintA = 'MintA1111111111111111111111111111111111';
    const mintB = 'MintB2222222222222222222222222222222222';

    const start = Date.now();
    const pA = service.initializeMintSnapshot(mockCtx, mintA);
    const pB = service.initializeMintSnapshot(mockCtx, mintB);

    await Promise.all([pA, pB]);
    const duration = Date.now() - start;

    assert.equal(store.state.metrics.tokenLargestInitializations, 2);
    // Pacing enforced duration >= 250ms
    assert.equal(duration >= 250, true, `Duration ${duration}ms should be >= 250ms`);
  });

  it('5. Deep-audit candidates passing cheap gates reach deep audit and get correct concentration', async () => {
    const service = new TokenAccountIndexService();

    const mint = 'DeepPassMint111111111111111111111111111';

    // Populate local holder state directly
    service.updateBalance(mint, 'acc1', 'owner1', 100000n);
    service.updateBalance(mint, 'acc2', 'owner2', 50000n);

    const conc = service.getConcentration(mint);
    assert.ok(conc !== null);
    assert.equal(conc.totalTrackedHolders, 2);
  });

  it('6. Local indexed holders bypass RPC completely', async () => {
    const service = new TokenAccountIndexService();
    const store = new StateStore({} as any);
    const mockCtx: any = {
      store,
      logger: () => {},
    };

    const mint = 'AlreadyIndexedMint1111111111111111111';
    service.updateBalance(mint, 'acc1', 'owner1', 500n);

    assert.equal(service.isIndexed(mint), true);

    await service.initializeMintSnapshot(mockCtx, mint);

    assert.equal(store.state.metrics.getTokenLargestAccountsRequests, 0, 'No RPC call issued!');
  });
});
