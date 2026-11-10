'use strict';
import test from 'node:test';
import { createCtx, serializeForSnapshot, withPatchedMembers } from './_test_helpers.js';
import * as engine from '../src/services/engine/engine.service.js';
import * as audit from '../src/services/audit/audit.service.js';
import { TokenMetadata, MintSignals } from '../src/types/index.js';

const MOCK_NOW = 1700000000000;
Date.now = () => MOCK_NOW;

function makeCleanMintSignals(): MintSignals {
  return {
    decimals: 6,
    supplyRaw: 1_000_000_000_000n,
    mintAuthority: null,
    freezeAuthority: null,
    top1Share: 0.3,
    top3Share: 0.45,
    top5Share: 0.55,
    topAccounts: [],
  };
}

test('snapshot evaluateCandidate: standard approval (pump.fun)', async (t) => {
  const ctx = createCtx();

  const token: TokenMetadata = {
    id: 'StandardMintPump',
    symbol: 'STD',
    name: 'Standard Pump Token',
    decimals: 6,
    usdPrice: 0.001,
    liquidity: 10_000,
    holderCount: 200,
    organicScore: 100,
    fdv: 1_000_000,
    firstPool: { createdAt: new Date(MOCK_NOW - 120_000).toISOString() },
    launchpad: 'pump.fun',
    stats5m: { numBuys: 50, numSells: 10 },
    isTrending: false,
  };

  await withPatchedMembers(
    audit.auditService,
    {
      getMintSignals: async () => makeCleanMintSignals(),
      fetchRugCheckSignals: async () => ({ status: 'ok', blockers: [], notes: [], riskScore: 20 }),
      fetchBubbleMapsSignals: async () => ({ status: 'ok', blockers: [], notes: [], score: 90 }),
      fetchRugCheckWalletSignals: async () => [],
    },
    async () => {
      const result = await engine.evaluateCandidate(ctx, token);
      t.assert.snapshot(serializeForSnapshot(result));
    }
  );
});

test('snapshot evaluateCandidate: low entry score rejection', async (t) => {
  const ctx = createCtx({ minCandidateScore: 70 });

  const token: TokenMetadata = {
    id: 'LowScoreMintPump',
    symbol: 'LOW',
    name: 'Low Score Token',
    decimals: 6,
    usdPrice: 0.001,
    liquidity: 8_000,
    holderCount: 50,
    organicScore: 30,
    fdv: 500_000,
    firstPool: { createdAt: new Date(MOCK_NOW - 60_000).toISOString() },
    launchpad: 'pump.fun',
    stats5m: { numBuys: 5, numSells: 2 },
    isTrending: false,
  };

  await withPatchedMembers(
    audit.auditService,
    {
      getMintSignals: async () => makeCleanMintSignals(),
      fetchRugCheckSignals: async () => ({ status: 'ok', blockers: [], notes: [], riskScore: 50 }),
      fetchBubbleMapsSignals: async () => null,
      fetchRugCheckWalletSignals: async () => [],
    },
    async () => {
      const result = await engine.evaluateCandidate(ctx, token);
      t.assert.snapshot(serializeForSnapshot(result));
    }
  );
});

test('snapshot evaluateCandidate: buying-the-top rejection', async (t) => {
  const ctx = createCtx();

  const token: TokenMetadata = {
    id: 'TopMintPump',
    symbol: 'TOP',
    name: 'Top Token',
    decimals: 6,
    usdPrice: 225,
    liquidity: 10_000,
    holderCount: 200,
    organicScore: 100,
    fdv: 10_000_000,
    firstPool: { createdAt: new Date(MOCK_NOW - 300_000).toISOString() },
    launchpad: 'pump.fun',
    stats5m: { numBuys: 50, numSells: 10 },
    isTrending: false,
  };

  await withPatchedMembers(
    audit.auditService,
    {
      getMintSignals: async () => makeCleanMintSignals(),
      fetchRugCheckSignals: async () => ({ status: 'ok', blockers: [], notes: [], riskScore: 20 }),
      fetchBubbleMapsSignals: async () => null,
      fetchRugCheckWalletSignals: async () => [],
    },
    async () => {
      const result = await engine.evaluateCandidate(ctx, token, {
        highestSeenPriceUsd: 226,
        priceAtStartOfDelay: 100,
        liquidityAtStartOfDelay: 10000,
        tapeAtStart: { buys: 50, sells: 10 },
      });
      t.assert.snapshot(serializeForSnapshot(result));
    }
  );
});

test('snapshot evaluateCandidate: trending approval with relaxed thresholds', async (t) => {
  const ctx = createCtx({
    minCandidateScore: 60,
    maxBuyTopGrowthPct: 70,
    trendingMaxBuyTopGrowthPct: 250,
  });

  const token: TokenMetadata = {
    id: 'TrendingMintXYZ',
    symbol: 'TND',
    name: 'Trending Token',
    decimals: 6,
    usdPrice: 0.5,
    liquidity: 100_000,
    holderCount: 1_000,
    organicScore: 100,
    fdv: 10_000_000,
    firstPool: { createdAt: new Date(MOCK_NOW - 300_000).toISOString() },
    launchpad: 'raydium',
    stats5m: { numBuys: 500, numSells: 100 },
    isTrending: true,
  };

  await withPatchedMembers(
    audit.auditService,
    {
      getMintSignals: async () => makeCleanMintSignals(),
      fetchRugCheckSignals: async () => ({ status: 'ok', blockers: [], notes: [], riskScore: 0 }),
      fetchBubbleMapsSignals: async () => null,
      fetchRugCheckWalletSignals: async () => [],
    },
    async () => {
      const result = await engine.evaluateCandidate(ctx, token, {
        highestSeenPriceUsd: 0.5,
        priceAtStartOfDelay: 0.35,
        liquidityAtStartOfDelay: 100000,
        depth: 'full',
      });
      t.assert.snapshot(serializeForSnapshot(result));
    }
  );
});
