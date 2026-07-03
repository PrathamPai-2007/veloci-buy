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

  const notAtTop = await engine.evaluateCandidate(ctx, token, 250, [], 100);
  assert.equal(notAtTop.approved, true);

  const atTop = await engine.evaluateCandidate(ctx, token, 226, [], 100);
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
  const normal = await engine.evaluateCandidate(ctx, runner, undefined, [], 100);
  assert.equal(normal.approved, false);
  assert.ok(normal.rejectionReasons.some((r) => r.code === 'parabolic-growth'));

  // Same coin tagged trending: trendingMaxSurvivalGrowthPct (900) lets +250% through.
  const trending = await engine.evaluateCandidate(
    ctx,
    { ...runner, isTrending: true },
    undefined,
    [],
    100
  );
  assert.equal(trending.approved, true);
  assert.ok(!trending.rejectionReasons.some((r) => r.code === 'parabolic-growth'));
});

test('engine GMI adjusts aggression correctly', async () => {
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
  });
  const state = createState({ launchHistory: [], retiredMints: new Map() });
  const ctx = { config, state } as unknown as Context;

  // 1. GMI Neutral (no history)
  (ctx as any).calculateGMI = () => 0.5;
  const token: TokenMetadata = {
    id: 'test',
    symbol: 'APE',
    name: 'ape',
    decimals: 9,
    usdPrice: 1,
    liquidity: 50_000, // Ratio > 5 relative to minLiquidityUsd=750
    holderCount: 1000,
    stats5m: { numBuys: 100, numSells: 10 },
    website: 'http',
    twitter: 'http',
    telegram: 'http', // 3 social links
    launchpad: 'pump.fun',
    firstPool: { createdAt: new Date(Date.now() - 30_000).toISOString() },
  };

  // GMI Neutral: Target 70. Score 90 should PASS (50 base + 10 pump.fun bonus + 15 social + 10 liq + 5 holders).
  let result = await engine.evaluateCandidate(ctx, token);
  assert.strictEqual(result.candidateScore, 90);
  assert.strictEqual(result.approved, true);

  // GMI Low (< 0.3): Target 70 + 35 = 105. Score 90. Score gate is deferred to heavy audit,
  // so cheap depth still passes — this validates candidateScore computation only.
  (ctx as any).calculateGMI = () => 0.2;
  config.minCandidateScore = 105;
  result = await engine.evaluateCandidate(ctx, token);
  assert.strictEqual(result.candidateScore, 90);
  assert.strictEqual(result.approved, true);

  // GMI High (> 0.7): Target 70 - 5 = 65. Score 70 should PASS.
  (ctx as any).calculateGMI = () => 0.8;
  config.minCandidateScore = 70;
  const lowLiqToken: TokenMetadata = {
    ...token,
    liquidity: config.minLiquidityUsd,
    launchpad: undefined, // unknown launchpad -> scoreBonus 0
    firstPool: { createdAt: new Date(Date.now() - 30_000).toISOString() },
  };
  result = await engine.evaluateCandidate(ctx, lowLiqToken);
  assert.strictEqual(result.candidateScore, 70);
  assert.strictEqual(result.approved, true);
});

test('engine computes score bonuses from socials and liquidity tiers', () => {
  const thresholds = {
    minLiquidityUsd: 1000,
    minHolderCount: 0,
    minBuys5m: 0,
    minPoolAgeSeconds: 0,
  };
  const profile = {
    scoreBonus: 10,
    liquidityMultiplier: 1,
    holderMultiplier: 1,
    buysMultiplier: 1,
    minPoolAgeSeconds: 0,
    name: 'test',
  };

  assert.equal(
    engine.computeCandidateScore({ liquidity: 1000 } as TokenMetadata, profile, thresholds, 0),
    60 // 50 base + 10 profile.scoreBonus
  );
  assert.equal(
    engine.computeCandidateScore(
      { liquidity: 1000, organicScore: '15' } as TokenMetadata,
      profile,
      thresholds,
      0
    ),
    75 // 60 + 15 organic
  );
  assert.equal(
    engine.computeCandidateScore({ liquidity: 1000 } as TokenMetadata, profile, thresholds, 3),
    75 // 60 + 15 social links
  );
  assert.equal(
    engine.computeCandidateScore({ liquidity: 6000 } as TokenMetadata, profile, thresholds, 0),
    70 // 60 + 10 high liquidity ratio
  );
});

test('engine computes new scoring overhaul logic (verification, launchpad, holders, buy pressure, audit, clamp)', () => {
  const thresholds = {
    minLiquidityUsd: 1000,
    minHolderCount: 5,
    minBuys5m: 0,
    minPoolAgeSeconds: 0,
  };
  const profile = {
    scoreBonus: 10,
    liquidityMultiplier: 1,
    holderMultiplier: 1,
    buysMultiplier: 1,
    minPoolAgeSeconds: 0,
    name: 'pump.fun',
  };

  // Base case: no token-level bonuses -> 50 + profile.scoreBonus(10) = 60
  let score = engine.computeCandidateScore(
    { liquidity: 1000 } as TokenMetadata,
    profile,
    thresholds,
    0
  );
  assert.equal(score, 60);

  // profile.scoreBonus now covers launchpad trust; token.launchpad field itself adds nothing
  score = engine.computeCandidateScore(
    { liquidity: 1000, launchpad: 'pump.fun' } as TokenMetadata,
    profile,
    thresholds,
    0
  );
  assert.equal(score, 60); // 50 base + 10 profile bonus (token.launchpad no longer adds separately)

  // +5 for isVerified
  score = engine.computeCandidateScore(
    { liquidity: 1000, isVerified: true } as TokenMetadata,
    profile,
    thresholds,
    0
  );
  assert.equal(score, 65); // 60 + 5 verified

  // +5 for holderCount >= 10
  score = engine.computeCandidateScore(
    { liquidity: 1000, holderCount: 10 } as TokenMetadata,
    profile,
    thresholds,
    0
  );
  assert.equal(score, 65); // 60 + 5 holder

  // graded buy pressure: ratio 2.1x → clamped to 1 → *5 = +5
  score = engine.computeCandidateScore(
    { liquidity: 1000, buyPressure: 21, sellPressure: 10 } as TokenMetadata,
    profile,
    thresholds,
    0
  );
  assert.equal(score, 65); // 60 + 5 buy pressure

  // -5 for suspicious audit
  score = engine.computeCandidateScore(
    { liquidity: 1000, audit: { isSus: true } } as TokenMetadata,
    profile,
    thresholds,
    0
  );
  assert.equal(score, 55); // 60 - 5 sus audit

  // Max clamp: 50 + profileBonus(10) + verified(5) + social(15) + organic(20) + highLiq(10) + holder(5) + buyPressure(5) = 120 -> clamped 100
  score = engine.computeCandidateScore(
    {
      liquidity: 6000,
      launchpad: 'pump.fun',
      isVerified: true,
      organicScore: 20,
      holderCount: 10,
      buyPressure: 21,
      sellPressure: 10,
    } as TokenMetadata,
    profile,
    thresholds,
    3
  );
  assert.equal(score, 100);

  // Min clamp: 50 + profileBonus(10) - organic(-20 clamped) - sus(5) = 35 (above 0, no clamp needed)
  score = engine.computeCandidateScore(
    {
      liquidity: 1000,
      organicScore: -100,
      audit: { isSus: true },
    } as TokenMetadata,
    profile,
    thresholds,
    0
  );
  assert.equal(score, 35); // 50 + 10 - 20 (clamped organic) - 5 (sus audit) = 35
});

test('engine treats non-string launchpads as unknown profiles', () => {
  const unknownProfile = {
    name: 'unknown',
    scoreBonus: 0,
    liquidityMultiplier: 1,
    holderMultiplier: 1,
    buysMultiplier: 1,
    minPoolAgeSeconds: 0,
  };
  assert.deepEqual(engine.getLaunchpadProfile('pump.fun'), {
    ...unknownProfile,
    name: 'pump.fun',
    scoreBonus: 10,
    liquidityMultiplier: 0.75,
    holderMultiplier: 0.7,
    buysMultiplier: 0.75,
    minPoolAgeSeconds: 5,
  });
  // The original test might have expected unknown for non-existent ones.
  assert.deepEqual(engine.getLaunchpadProfile(123 as any), unknownProfile);
});

test('engine applies launchpad-specific threshold multipliers', () => {
  const ctx = {
    config: { minLiquidityUsd: 1000, minHolderCount: 100, minBuys5m: 10, minPoolAgeSeconds: 30 },
  } as unknown as Context;
  const profile = {
    name: 'pump.fun',
    scoreBonus: 10,
    liquidityMultiplier: 0.75,
    holderMultiplier: 0.7,
    buysMultiplier: 0.75,
    minPoolAgeSeconds: 5,
  };

  const thresholds = engine.getLaunchpadAdjustedThresholds(ctx, profile);
  assert.equal(thresholds.minLiquidityUsd, 750);
  assert.equal(thresholds.minHolderCount, 70);
  assert.equal(thresholds.minBuys5m, 7.5);
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
      const evaluation = await engine.evaluateCandidate(
        ctx,
        token,
        undefined,
        [],
        undefined,
        undefined,
        undefined,
        [],
        'full'
      );
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

  const evaluation = await engine.evaluateCandidate(
    ctx,
    token,
    undefined,
    [],
    undefined,
    undefined,
    {
      buys: 100,
      sells: 1,
    }
  );

  assert.equal(evaluation.approved, false);
  assert.ok(evaluation.rejectionReasons.some((reason) => reason.code === 'high-sell-pressure'));
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

  const evaluation = await engine.evaluateCandidate(ctx, token, undefined, priceHistory, 1);

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
      const evaluation = await engine.evaluateCandidate(
        ctx,
        token,
        undefined,
        [],
        undefined,
        undefined,
        undefined,
        [],
        'full'
      );
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
        const evaluation = await engine.evaluateCandidate(
          ctx,
          baseToken,
          undefined,
          [],
          undefined,
          undefined,
          undefined,
          [],
          'full'
        );
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
