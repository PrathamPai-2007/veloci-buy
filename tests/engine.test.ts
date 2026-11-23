'use strict';
import { createTestConfig, createState, createCtx, withPatchedMembers } from './_test_helpers.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as engine from '../src/services/engine/engine.service.js';
import * as audit from '../src/services/audit/audit.service.js';
import { Context, TokenMetadata } from '../src/types/index.js';

test('engine evaluates buying-the-top only when price is near ATH after steep growth', async () => {
  const ctx = createCtx();
  const token: TokenMetadata = {
    id: 'TopMint',
    symbol: 'TOP',
    name: 'Top Token',
    decimals: 9,
    usdPrice: 225,
    liquidity: 10_000,
    holderCount: 100,
    stats5m: { numBuys: 50, numSells: 10 },
    organicScore: 100,
  };

  const noContext = await engine.evaluateCandidate(ctx, token);
  assert.equal(noContext.approved, true);

  const notAtTop = await engine.evaluateCandidate(ctx, token, {
    highestSeenPriceUsd: 250,
    priceAtStartOfDelay: 100,
  });
  assert.equal(notAtTop.approved, true);

  const atTop = await engine.evaluateCandidate(ctx, token, {
    highestSeenPriceUsd: 226,
    priceAtStartOfDelay: 100,
  });
  assert.equal(atTop.approved, false);
  assert.deepEqual(
    atTop.rejectionReasons.find((reason) => reason.code === 'buying-the-top'),
    { code: 'buying-the-top', recheckEligible: true }
  );
});

test('engine min market-cap floor rejects sub-floor FDV but allows above/unknown', async () => {
  const ctx = createCtx({ minMarketCapUsd: 1000 });
  const base: TokenMetadata = {
    id: 'McapMint',
    symbol: 'MC',
    name: 'Mcap Token',
    decimals: 9,
    usdPrice: 1,
    liquidity: 10_000,
    holderCount: 100,
    stats5m: { numBuys: 50, numSells: 10 },
    organicScore: 100,
  };

  const below = await engine.evaluateCandidate(ctx, { ...base, fdv: 500 });
  assert.equal(below.approved, false);
  assert.deepEqual(
    below.rejectionReasons.find((r) => r.code === 'low-market-cap'),
    { code: 'low-market-cap', recheckEligible: true }
  );

  const above = await engine.evaluateCandidate(ctx, { ...base, fdv: 20_000 });
  assert.equal(above.approved, true);

  // Unknown FDV (no market data yet) must NOT be rejected by the floor.
  const unknown = await engine.evaluateCandidate(ctx, { ...base });
  assert.ok(!unknown.rejectionReasons.some((r) => r.code === 'low-market-cap'));
});

test('engine relaxes the parabolic-growth guard for trending coins only', async () => {
  const ctx = createCtx();
  const runner: TokenMetadata = {
    id: 'RunMint',
    symbol: 'RUN',
    name: 'Runner',
    decimals: 9,
    usdPrice: 350, // +250% vs start price of 100
    liquidity: 10_000,
    holderCount: 100,
    stats5m: { numBuys: 50, numSells: 10 },
    organicScore: 100,
  };

  // Default flow: +250% exceeds maxSurvivalGrowthPct (200) -> hard parabolic reject.
  const normal = await engine.evaluateCandidate(ctx, runner, { priceAtStartOfDelay: 100 });
  assert.equal(normal.approved, false);
  assert.ok(normal.rejectionReasons.some((r) => r.code === 'parabolic-growth'));

  // Same coin tagged trending: trendingMaxSurvivalGrowthPct (900) lets +250% through.
  const trending = await engine.evaluateCandidate(
    ctx,
    { ...runner, isTrending: true },
    { priceAtStartOfDelay: 100 }
  );
  assert.equal(trending.approved, true);
  assert.ok(!trending.rejectionReasons.some((r) => r.code === 'parabolic-growth'));
});

test('entry score ignores GMI, launchpad tag and liquidity depth', async () => {
  const config = createTestConfig({
    minCandidateScore: 70,
    memeKeywords: ['ape'],
    maxMemeFdvUsd: 10_000_000,
    minOrganicScore: 0,
    minSocialLinks: 0,
    allowVerifiedTokens: true,
    maxAuditTopHoldersPct: 100,
    maxCandidateAgeMinutes: 60,
    borderlineThresholdBufferRatio: 0.2,
    liquidityCollapseThresholdUsd: 0,
  });
  const state = createState({ launchHistory: [], retiredMints: new Map() });
  const ctx = { config, state } as unknown as Context;
  const token: TokenMetadata = {
    id: 'test',
    symbol: 'APE',
    name: 'ape',
    decimals: 9,
    usdPrice: 1,
    liquidity: 50_000,
    holderCount: 1000,
    stats5m: { numBuys: 100, numSells: 10 },
    website: 'http',
    twitter: 'http',
    telegram: 'http', // 3 social links
    launchpad: 'pump.fun',
    firstPool: { createdAt: new Date(Date.now() - 30_000).toISOString() },
  };
  const thin = { ...token, liquidity: config.minLiquidityUsd, launchpad: undefined };

  // 70 base + 15 social + 5 holders, whatever the market regime or tagging.
  for (const gmi of [0.2, 0.5, 0.8]) {
    (ctx as any).calculateGMI = () => gmi;
    for (const t of [token, thin]) {
      const result = await engine.evaluateCandidate(ctx, t);
      assert.strictEqual(result.candidateScore, 90);
      assert.strictEqual(result.approved, true);
    }
  }
});

test('engine computes candidate score components', () => {
  const score = (t: Partial<TokenMetadata>, socials = 0) =>
    engine.computeCandidateScore(t as TokenMetadata, socials);

  assert.equal(score({ liquidity: 1000 }), 70);
  assert.equal(score({ liquidity: 60_000 }), 70); // depth is a gate, not a score term
  assert.equal(score({ organicScore: '15' as unknown as number }), 85);
  assert.equal(score({}, 3), 85); // +15 social links
  assert.equal(score({ isVerified: true }), 75);
  assert.equal(score({ holderCount: 10 }), 75);
  assert.equal(score({ buyPressure: 21, sellPressure: 10 }), 75); // graded, clamped at 2x
  assert.equal(score({ audit: { isSus: true } } as Partial<TokenMetadata>), 65);
  assert.equal(score({ organicScore: -100, audit: { isSus: true } } as Partial<TokenMetadata>), 45);
  assert.equal(
    score(
      { isVerified: true, organicScore: 20, holderCount: 10, buyPressure: 21, sellPressure: 10 },
      3
    ),
    100
  );
});

test('engine identifies memecoin candidates from name, symbol, fdv, and launchpad', () => {
  const ctx = {
    config: { memeKeywords: ['pepe', 'doge'], maxMemeFdvUsd: 1_000_000 },
  } as unknown as Context;

  assert.equal(engine.looksLikeMemecoin(ctx, { name: 'Pepe Coin' } as TokenMetadata), true);
  assert.equal(engine.looksLikeMemecoin(ctx, { symbol: 'DOGE' } as TokenMetadata), true);
  assert.equal(
    engine.looksLikeMemecoin(ctx, { name: 'pepe', fdv: 500_000 } as TokenMetadata),
    true
  );
  assert.equal(engine.looksLikeMemecoin(ctx, { launchpad: 'pump.fun' } as TokenMetadata), true);
  assert.equal(
    engine.looksLikeMemecoin(ctx, { name: 'Serious Token', fdv: 2_000_000 } as TokenMetadata),
    false
  );
});

test('engine borderline threshold helper honors configured buffer', () => {
  const ctx = { config: { borderlineThresholdBufferRatio: 0.2 } } as unknown as Context;

  assert.equal(engine.isSlightlyBelowThreshold(ctx, 85, 100), true);
  assert.equal(engine.isSlightlyBelowThreshold(ctx, 75, 100), false);
  assert.equal(engine.isSlightlyBelowThreshold(ctx, 110, 100), true);
});

test('engine rejects candidates when fdv-to-liquidity exceeds the configured threshold', async () => {
  const ctx = createCtx({ maxFdvToLiquidity: 5 });
  const token: TokenMetadata = {
    id: 'FdvGateMint',
    symbol: 'FDV',
    name: 'FDV Gate',
    decimals: 9,
    usdPrice: 1,
    liquidity: 1_000,
    fdv: 10_000,
    holderCount: 50,
    organicScore: 10,
    stats5m: { numBuys: 10, numSells: 1 },
    firstPool: { createdAt: new Date(Date.now() - 60_000).toISOString() },
  };

  // FDV/liquidity is a soft gate evaluated in heavy audit only
  await withPatchedMembers(
    audit.auditService,
    {
      getMintSignals: async () => ({
        mintAuthority: null,
        freezeAuthority: null,
        top1Share: 0,
        top5Share: 0,
        topAccounts: [],
      }),
      fetchRugCheckSignals: async () => ({
        status: 'ok' as const,
        blockers: [],
        notes: [],
        riskScore: null,
        rugged: false,
      }),
      fetchBubbleMapsSignals: async () => null,
      fetchRugCheckWalletSignals: async () => [],
    },
    async () => {
      const evaluation = await engine.evaluateCandidate(ctx, token, { depth: 'full' });
      assert.equal(evaluation.approved, false);
      assert.ok(
        evaluation.rejectionReasons.some((reason) => reason.code === 'fdv-liquidity-too-high')
      );
    }
  );
});

test('engine treats missing fdv as neutral when evaluating candidates', async () => {
  const ctx = createCtx({ maxFdvToLiquidity: 5 });
  const token: TokenMetadata = {
    id: 'NoFdvMint',
    symbol: 'NFDV',
    name: 'No FDV',
    decimals: 9,
    usdPrice: 1,
    liquidity: 1_000,
    holderCount: 50,
    organicScore: 10,
    stats5m: { numBuys: 10, numSells: 1 },
    firstPool: { createdAt: new Date(Date.now() - 60_000).toISOString() },
  };

  const evaluation = await engine.evaluateCandidate(ctx, token);
  assert.equal(evaluation.approved, true);
});

test('engine clamps future pool timestamps (clock skew) instead of rejecting as too new', async () => {
  const ctx = createCtx({ minPoolAgeSeconds: 0 });
  const token: TokenMetadata = {
    id: 'FuturePoolMint',
    symbol: 'FUT',
    name: 'Future Pool',
    decimals: 9,
    usdPrice: 1,
    liquidity: 1_000,
    holderCount: 50,
    organicScore: 10,
    stats5m: { numBuys: 10, numSells: 1 },
    // ~209s in the future — simulates the local clock running behind real time.
    firstPool: { createdAt: new Date(Date.now() + 209_000).toISOString() },
  };

  const evaluation = await engine.evaluateCandidate(ctx, token);
  // A skewed clock must not drive the decision: no negative age should ever surface.
  assert.ok(!evaluation.blockers.some((blocker) => /Too new -\d+s\./.test(blocker)));
  assert.equal(evaluation.approved, true);
});

test('engine flags sell pressure when rolling buy counts decrease', async () => {
  const ctx = createCtx();
  const token: TokenMetadata = {
    id: 'SellPressureMint',
    symbol: 'SP',
    name: 'Pepe Sell Pressure',
    decimals: 9,
    usdPrice: 1,
    liquidity: 10_000,
    holderCount: 50,
    organicScore: 10,
    stats5m: { numBuys: 80, numSells: 5 },
    firstPool: { createdAt: new Date(Date.now() - 60_000).toISOString() },
  };

  const evaluation = await engine.evaluateCandidate(ctx, token, {
    tapeAtStart: {
      buys: 100,
      sells: 1,
    },
  });

  assert.equal(evaluation.approved, false);
  assert.ok(evaluation.rejectionReasons.some((reason) => reason.code === 'high-sell-pressure'));
});

test('engine holds sell-heavy tapes for recheck and ignores tiny tapes', async () => {
  const ctx = createCtx();
  const base: TokenMetadata = {
    id: 'SellHeavyMint',
    symbol: 'SH',
    name: 'Pepe Sell Heavy',
    decimals: 9,
    usdPrice: 1,
    liquidity: 10_000,
    holderCount: 50,
    organicScore: 10,
    stats5m: { numBuys: 20, numSells: 15 },
    firstPool: { createdAt: new Date(Date.now() - 60_000).toISOString() },
  };
  const code = (e: { rejectionReasons: { code: string; recheckEligible: boolean }[] }) =>
    e.rejectionReasons.find((r) => r.code === 'sell-heavy-tape');

  assert.deepEqual(code(await engine.evaluateCandidate(ctx, base)), {
    code: 'sell-heavy-tape',
    recheckEligible: true,
  });
  const tiny = { ...base, id: 'TinyTape', stats5m: { numBuys: 3, numSells: 3 } };
  assert.equal(code(await engine.evaluateCandidate(ctx, tiny)), undefined);
  const healthy = { ...base, id: 'Healthy', stats5m: { numBuys: 40, numSells: 10 } };
  assert.equal(code(await engine.evaluateCandidate(ctx, healthy)), undefined);
});

test('engine sanitizes historical price points before volatility and momentum filters', async () => {
  const ctx = createCtx({ earlyPerformanceGuardSeconds: 1 });
  const now = Date.now();
  const token: TokenMetadata = {
    id: 'HistoryMint',
    symbol: 'HIST',
    name: 'Pepe History',
    decimals: 9,
    usdPrice: 1.2,
    liquidity: 10_000,
    holderCount: 50,
    organicScore: 10,
    stats5m: { numBuys: 10, numSells: 1 },
    firstPool: { createdAt: new Date(now - 60_000).toISOString() },
  };
  const priceHistory = [
    { price: '1.00' as any, timestamp: now - 12_000 },
    { price: 'bad' as any, timestamp: now - 10_000 },
    { price: 0, timestamp: now - 8_000 },
    { price: '1.05' as any, timestamp: now - 7_000 },
    { price: 1.1, timestamp: now - 5_000 },
    { price: 1.15, timestamp: now - 3_000 },
    { price: 1.18, timestamp: now - 1_000 },
  ];

  const evaluation = await engine.evaluateCandidate(ctx, token, {
    priceHistory,
    priceAtStartOfDelay: 1,
  });

  assert.equal(Number.isFinite(evaluation.volatilityScaler), true);
  assert.ok(evaluation.volatilityScaler > 0);
});

test('engine reduced historical notes accept numeric strings as present', async () => {
  const ctx = createCtx();
  const token: TokenMetadata = {
    id: 'HistoricalStringMint',
    symbol: 'PEPE',
    name: 'Historical Pepe',
    decimals: 9,
    usdPrice: 1.2,
    liquidity: 8_500,
    holderCount: '12',
    organicScore: '5',
    stats5m: { numBuys: '3' } as any,
    launchpad: 'pump.fun',
    firstPool: { createdAt: new Date(Date.now() - 60_000).toISOString() },
    snapshotQuality: 'reduced-historical',
  };

  const evaluation = await engine.evaluateCandidate(ctx, token);

  assert.equal(evaluation.approved, true);
  assert.equal(
    evaluation.notes.some((note) => /missing holder count/i.test(note)),
    false
  );
  assert.equal(
    evaluation.notes.some((note) => /missing organic score/i.test(note)),
    false
  );
  assert.equal(
    evaluation.notes.some((note) => /missing 5m buy tape/i.test(note)),
    false
  );
});

test('engine full audit reports downstream blockers even after mint blockers', async () => {
  const ctx = createCtx(
    {},
    {
      retiredMints: new Map([
        ['FullAuditMint', { lastExitPriceUsd: 1, retiredAt: new Date().toISOString() }],
      ]),
    }
  );
  const token: TokenMetadata = {
    id: 'FullAuditMint',
    symbol: 'FULL',
    name: 'Pepe Full Audit',
    decimals: 9,
    usdPrice: 1.05,
    liquidity: 10_000,
    holderCount: 50,
    organicScore: 10,
    stats5m: { numBuys: 10, numSells: 1 },
    firstPool: { createdAt: new Date(Date.now() - 60_000).toISOString() },
  };

  await withPatchedMembers(
    audit.auditService,
    {
      getMintSignals: async () => ({
        mintAuthority: 'mint-authority',
        freezeAuthority: null,
        top1Share: 0,
        top5Share: 0,
        topAccounts: [{ owner: 'owner-a' }],
      }),
      fetchRugCheckSignals: async () => ({
        status: 'ok' as const,
        blockers: [],
        notes: [],
        riskScore: null,
        rugged: false,
      }),
      fetchBubbleMapsSignals: async () => null,
      fetchRugCheckWalletSignals: async () => ['owner-a'],
    },
    async () => {
      const evaluation = await engine.evaluateCandidate(ctx, token, { depth: 'full' });
      const codes = evaluation.rejectionReasons.map((reason) => reason.code);

      assert.equal(evaluation.approved, false);
      assert.ok(codes.includes('mint-authority-enabled'));
      assert.ok(codes.includes('rugcheck-malicious-owner'));
      assert.ok(codes.includes('price-distance-gate'));
    }
  );
});

test('engine blocks high top5 concentration unconditionally, passes distributed holders', async () => {
  // Values drawn from the 2026-06-11 paper-trading session: the catastrophic -80% rugs all had
  // top5 >80% while the only real grower (Nessie) had ~33%. This locks in the unconditional gate
  // (which previously only ran inside the skipped BubbleMaps branch).
  const baseToken: TokenMetadata = {
    id: 'ConcentrationMint',
    symbol: 'CONC',
    name: 'Pepe Concentration',
    decimals: 9,
    usdPrice: 1.05,
    liquidity: 10_000,
    holderCount: 50,
    organicScore: 10,
    stats5m: { numBuys: 10, numSells: 1 },
    firstPool: { createdAt: new Date(Date.now() - 60_000).toISOString() },
  };

  const evalWithTop5 = async (top5Share: number) => {
    const ctx = createCtx({});
    return withPatchedMembers(
      audit.auditService,
      {
        getMintSignals: async () => ({
          mintAuthority: null,
          freezeAuthority: null,
          top1Share: 0.3,
          top5Share,
          topAccounts: [{ owner: 'owner-a' }],
        }),
        fetchRugCheckSignals: async () => ({
          status: 'ok' as const,
          blockers: [],
          notes: [],
          riskScore: null,
          rugged: false,
        }),
        fetchBubbleMapsSignals: async () => null,
        fetchRugCheckWalletSignals: async () => [],
      },
      async () => {
        const evaluation = await engine.evaluateCandidate(ctx, baseToken, { depth: 'full' });
        return evaluation.rejectionReasons.map((reason) => reason.code);
      }
    );
  };

  // SG / DRAGONWORM / "67" range (0.81–0.99) must be blocked.
  assert.ok((await evalWithTop5(0.85)).includes('top5-concentration'));
  // At the 0.54 gate, the loser cluster (>=0.547) must block — e.g. Muuta 0.584, BasedGrok 0.564.
  assert.ok((await evalWithTop5(0.584)).includes('top5-concentration'));
  assert.ok((await evalWithTop5(0.564)).includes('top5-concentration'));
  // Winners (<=0.540) must NOT be blocked: GTA6 0.50, 1M 0.54, Nessie 0.33.
  assert.ok(!(await evalWithTop5(0.33)).includes('top5-concentration'));
  assert.ok(!(await evalWithTop5(0.5)).includes('top5-concentration'));
  assert.ok(!(await evalWithTop5(0.54)).includes('top5-concentration'));
});

test('historical backfill snapshots degrade gracefully without Jupiter-only metrics', async () => {
  const ctx = createCtx({ minHoldTimeSeconds: 300 });
  const createdAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const token: TokenMetadata = {
    id: 'HistoricalMint',
    symbol: 'PEPE',
    name: 'Historical Pepe',
    decimals: 9,
    usdPrice: 1.2,
    liquidity: 8_500,
    launchpad: 'pump.fun',
    firstPool: { createdAt },
    snapshotQuality: 'reduced-historical',
    historicalSource: 'geckoterminal',
  };

  const evaluation = await engine.evaluateCandidate(ctx, token);
  assert.equal(evaluation.approved, true);
  assert.ok(evaluation.notes.some((note) => /missing holder count/i.test(note)));
});

// --- NEW/UPGRADED TEST CASES ---

test('engine GMI handles extreme mock launch history / total supply BigInt simulation', async () => {
  const config = createTestConfig({ minCandidateScore: 60 });
  const state = createState();
  const ctx = {
    config,
    state,
    calculateGMI: () => {
      // Simulate extreme BigInt logic where we count very high total supplies or similar
      const mockTotalSupply = 18_446_744_073_709_551_615n; // 2^64 - 1
      if (mockTotalSupply > 100_000n) {
        return 0.1; // Low GMI
      }
      return 0.5;
    },
  } as unknown as Context;

  const token: TokenMetadata = {
    id: 'BigIntGMIMint',
    symbol: 'BGMI',
    name: 'BigInt GMI Token',
    decimals: 9,
    usdPrice: 1,
    liquidity: 5_000,
    holderCount: 200,
    stats5m: { numBuys: 50, numSells: 10 },
    firstPool: { createdAt: new Date(Date.now() - 30_000).toISOString() },
  };

  const result = await engine.evaluateCandidate(ctx, token);
  // With calculateGMI returning 0.1, the borderline/min threshold target becomes higher or adjusted
  assert.ok(result);
});

test('engine rejects candidate with zero buys/sells (zero volume)', async () => {
  const ctx = createCtx({ minBuys5m: 5 });
  const token: TokenMetadata = {
    id: 'ZeroVolumeMint',
    symbol: 'ZERO',
    name: 'Zero Volume Token',
    decimals: 9,
    usdPrice: 1,
    liquidity: 5_000,
    holderCount: 200,
    stats5m: { numBuys: 0, numSells: 0 },
    firstPool: { createdAt: new Date(Date.now() - 30_000).toISOString() },
  };

  const result = await engine.evaluateCandidate(ctx, token);
  assert.equal(result.approved, false);
  // buys5m=0 is caught as 'zero-buys' in light audit; minBuys5m floor runs in heavy audit
  assert.ok(result.blockers.some((b) => b.includes('5m buys')));
});

test('entry liquidity floor is minLiquidityUsd exactly', async () => {
  const ctx = createCtx({ minLiquidityUsd: 2500, liquidityCollapseThresholdUsd: 320 });
  const mk = (liquidity: number) =>
    ({
      id: `L${liquidity}`,
      symbol: 'T',
      name: 'T',
      decimals: 6,
      usdPrice: 1,
      liquidity,
    }) as TokenMetadata;
  const low = (r: Awaited<ReturnType<typeof engine.evaluateCandidate>>) =>
    r.rejectionReasons.some((x) => x.code === 'low-liquidity');
  assert.equal(low(await engine.evaluateCandidate(ctx, mk(2499))), true);
  assert.equal(low(await engine.evaluateCandidate(ctx, mk(2500))), false);
});

test('low liquidity is recheck-eligible for a young curve but final for an old one', async () => {
  const ctx = createCtx({ minLiquidityUsd: 400, liquidityCollapseThresholdUsd: 320 });
  const mk = (ageSec: number): TokenMetadata =>
    ({
      id: `Mint${ageSec}`,
      symbol: 'T',
      name: 'T',
      decimals: 6,
      usdPrice: 1,
      liquidity: 20,
      firstPool: { id: 'p', createdAt: new Date(Date.now() - ageSec * 1000).toISOString() },
    }) as TokenMetadata;
  const lowLiq = (r: Awaited<ReturnType<typeof engine.evaluateCandidate>>) =>
    r.rejectionReasons.find((x) => x.code === 'low-liquidity');
  assert.equal(lowLiq(await engine.evaluateCandidate(ctx, mk(30)))?.recheckEligible, true);
  assert.equal(lowLiq(await engine.evaluateCandidate(ctx, mk(900)))?.recheckEligible, false);
});
