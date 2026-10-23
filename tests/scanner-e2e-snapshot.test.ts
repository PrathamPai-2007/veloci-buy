'use strict';
import test from 'node:test';
import {
  createCtx,
  serializeForSnapshot,
  createCannedToken,
  withPatchedMembers,
} from './_test_helpers.js';
import { scannerService } from '../src/services/scanner/scanner.service.js';
import { appService } from '../src/services/services.js';
import { portfolioService } from '../src/services/trading/portfolio.service.js';
import { auditService } from '../src/services/audit/audit.service.js';
import { Context, TokenMetadata, Position, EvaluationResult } from '../src/types/index.js';

const MOCK_NOW = 1700000000000;
Date.now = () => MOCK_NOW;

test('snapshot scanForCandidates: full pipeline with approved + rejected + recheck tokens', async (t) => {
  const { ctx, state, cleanup } = createCannedScanContext();

  const approvedToken = createCannedToken({
    id: 'ApprovedMint1',
    symbol: 'APP',
    name: 'Approved Token',
    launchpad: 'pump.fun',
  });

  const rejectedToken = createCannedToken({
    id: 'RejectedMint1',
    symbol: 'REJ',
    name: 'Rejected Token',
    launchpad: 'pump.fun',
    liquidity: 100,
  });

  const recheckToken = createCannedToken({
    id: 'RecheckMint1',
    symbol: 'RCH',
    name: 'Recheck Token',
    launchpad: 'pump.fun',
    liquidity: 300,
  });

  const approvedResult: EvaluationResult = {
    approved: true,
    blockers: [],
    rejectionReasons: [],
    notes: ['standard evaluation passed'],
    candidateScore: 85,
    volatilityScaler: 1,
    launchpadProfile: {
      scoreBonus: 10,
      liquidityMultiplier: 0.75,
      holderMultiplier: 0.7,
      buysMultiplier: 0.75,
      minPoolAgeSeconds: 5,
      name: 'pump.fun',
    },
    adjustedThresholds: {} as any,
    token: approvedToken,
  };

  const rejectedResult: EvaluationResult = {
    approved: false,
    blockers: ['Low liquidity 100.'],
    rejectionReasons: [{ code: 'low-liquidity', recheckEligible: true }],
    notes: [],
    candidateScore: 30,
    volatilityScaler: 1,
    launchpadProfile: {
      scoreBonus: 10,
      liquidityMultiplier: 0.75,
      holderMultiplier: 0.7,
      buysMultiplier: 0.75,
      minPoolAgeSeconds: 5,
      name: 'pump.fun',
    },
    adjustedThresholds: {} as any,
    token: rejectedToken,
  };

  const recheckResult: EvaluationResult = {
    approved: false,
    blockers: [],
    rejectionReasons: [{ code: 'low-holders', recheckEligible: true }],
    notes: [],
    candidateScore: 65,
    volatilityScaler: 1,
    launchpadProfile: {
      scoreBonus: 10,
      liquidityMultiplier: 0.75,
      holderMultiplier: 0.7,
      buysMultiplier: 0.75,
      minPoolAgeSeconds: 5,
      name: 'pump.fun',
    },
    adjustedThresholds: {} as any,
    token: recheckToken,
  };

  const fakePosition: Position = {
    mint: 'ApprovedMint1',
    symbol: 'APP',
    name: 'Approved Token',
    decimals: 6,
    openedAt: '2024-01-01T00:00:00.000Z',
    mode: 'paper',
    entryPriceUsd: 0.001,
    entryUsdValue: 100,
    entryScore: 85,
    initialTokenAmountRaw: '100000000',
    highestPriceUsd: 0.001,
    partiallyClosed: false,
    takeProfitMultiples: [1.15, 1.75],
    takeProfitFractions: [0.75, 0.6],
    trailingStopDrawdownPctResolved: 0.16,
    maxHoldMinutesResolved: 20,
    volatilityScaler: 1,
    entryLiquidityUsd: 10000,
    launchpad: 'pump.fun',
  } as Position;

  const evaluatedTokens: string[] = [];

  await withPatchedMembers(
    appService,
    {
      fetchRecentLaunches: async () => [approvedToken, rejectedToken, recheckToken],
      fetchPricesBestEffort: async () => ({}),
      evaluateCandidate: async (_ctx: Context, token: TokenMetadata) => {
        evaluatedTokens.push(token.id);
        if (token.id === 'ApprovedMint1') return approvedResult;
        if (token.id === 'RejectedMint1') return rejectedResult;
        return recheckResult;
      },
      buyCandidate: async () => fakePosition,
    },
    async () => {
      await withPatchedMembers(
        portfolioService,
        {
          evaluateDrawdownBreaker: async () => ({ blocked: false, event: 'resumed', reason: '' }),
          canBuy: async () => ({ approved: true, reason: '' }),
        },
        async () => {
          await withPatchedMembers(
            auditService,
            {
              getMintSignals: async () => ({
                decimals: 6,
                supplyRaw: 0n,
                mintAuthority: null,
                freezeAuthority: null,
                top1Share: 0,
                top3Share: 0,
                top5Share: 0,
                topAccounts: [],
              }),
              fetchRugCheckSignals: async () => null,
              fetchBubbleMapsSignals: async () => null,
              fetchRugCheckWalletSignals: async () => [],
              batchGetMintSignals: async () => new Map(),
            },
            async () => {
              await scannerService.scanForCandidates(
                ctx,
                [approvedToken, rejectedToken, recheckToken],
                []
              );
            }
          );
        }
      );
    }
  );

  const snapshotState = serializeForSnapshot({
    metrics: state.metrics,
    processedMints: Array.from(state.processedMints).sort(),
    positions: Array.from(state.positions.entries()),
    pendingCandidateRechecks: Array.from(state.pendingCandidateRechecks.entries()),
    marketSnapshots: Array.from(state.marketSnapshots.entries()).map(([k, v]) => [
      k,
      { ...v, observedAt: 'MOCKED' },
    ]),
    evaluatedTokens,
  });

  t.assert.snapshot(snapshotState);

  cleanup();
});

test('snapshot scanForCandidates: empty discovery produces zero side effects', async (t) => {
  const { ctx, state, cleanup } = createCannedScanContext();

  await withPatchedMembers(
    appService,
    {
      fetchRecentLaunches: async () => [],
      evaluateCandidate: async () => {
        throw new Error('should not be called');
      },
      buyCandidate: async () => {
        throw new Error('should not be called');
      },
    },
    async () => {
      await scannerService.scanForCandidates(ctx);
    }
  );

  const snapshotState = serializeForSnapshot({
    metrics: state.metrics,
    processedMints: Array.from(state.processedMints).sort(),
    positions: Array.from(state.positions.entries()),
    pendingCandidateRechecks: Array.from(state.pendingCandidateRechecks.entries()),
    marketSnapshots: Array.from(state.marketSnapshots.entries()).map(([k, v]) => [
      k,
      { ...v, observedAt: 'MOCKED' },
    ]),
  });

  t.assert.snapshot(snapshotState);

  cleanup();
});

test('snapshot scanForCandidates: all hard-rejected tokens are tracked', async (t) => {
  const { ctx, state, cleanup } = createCannedScanContext();

  const hardRejectedToken = createCannedToken({
    id: 'HardRejectMint1',
    symbol: 'HJR',
    name: 'Hard Reject Token',
    launchpad: 'pump.fun',
    liquidity: 0,
    usdPrice: 0,
    stats5m: { numBuys: 0, numSells: 0 },
  });

  const hardRejectResult: EvaluationResult = {
    approved: false,
    blockers: ['No price.', 'Zero 5m buys.'],
    rejectionReasons: [{ code: 'missing-price', recheckEligible: false }],
    notes: [],
    candidateScore: 0,
    volatilityScaler: 1,
    launchpadProfile: {
      scoreBonus: 10,
      liquidityMultiplier: 0.75,
      holderMultiplier: 0.7,
      buysMultiplier: 0.75,
      minPoolAgeSeconds: 5,
      name: 'pump.fun',
    },
    adjustedThresholds: {} as any,
    token: hardRejectedToken,
  };

  await withPatchedMembers(
    appService,
    {
      fetchRecentLaunches: async () => [hardRejectedToken],
      evaluateCandidate: async () => hardRejectResult,
      buyCandidate: async () => null,
    },
    async () => {
      await withPatchedMembers(
        portfolioService,
        {
          evaluateDrawdownBreaker: async () => ({ blocked: false, event: 'resumed', reason: '' }),
          canBuy: async () => ({ approved: true, reason: '' }),
        },
        async () => {
          await withPatchedMembers(
            auditService,
            {
              getMintSignals: async () => ({
                decimals: 6,
                supplyRaw: 0n,
                mintAuthority: null,
                freezeAuthority: null,
                top1Share: 0,
                top3Share: 0,
                top5Share: 0,
                topAccounts: [],
              }),
              fetchRugCheckSignals: async () => null,
              fetchBubbleMapsSignals: async () => null,
              fetchRugCheckWalletSignals: async () => [],
              batchGetMintSignals: async () => new Map(),
            },
            async () => {
              await scannerService.scanForCandidates(ctx, [hardRejectedToken], []);
            }
          );
        }
      );
    }
  );

  const snapshotState = serializeForSnapshot({
    metrics: state.metrics,
    processedMints: Array.from(state.processedMints).sort(),
    rejectionReasons: state.metrics.rejectionReasons,
  });

  t.assert.snapshot(snapshotState);

  cleanup();
});

function createCannedScanContext() {
  const ctx = createCtx({
    paperTrading: true,
    maxOpenPositions: 10,
    maxBuysPerScan: 2,
    maxCandidatesPerScan: 15,
    borderlineRecheckEnabled: true,
    borderlineRecheckMinDelayMs: 10_000,
    borderlineRecheckMaxDelayMs: 20_000,
    minCandidateScore: 60,
  });
  return {
    ctx,
    state: ctx.state,
    store: ctx.store,
    cleanup: () => {},
  };
}
