'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyHolderTrade,
  getLedgerHolders,
  PUMP_INITIAL_REAL_TOKENS,
  _resetHolderLedgerForTest,
} from '../src/services/market-state/holder-ledger.js';
import {
  getLiquidityPeak,
  ingestPumpTrade,
  watchMint,
  _resetPumpTradeIngestForTest,
} from '../src/services/market-state/pump-trade-ingest.js';
import { runDeepAudit } from '../src/services/engine/deep-audit.js';
import { auditService } from '../src/services/audit/audit.service.js';
import { _setSolPriceCacheForTest } from '../src/services/trading/paper-broker.js';
import { createCtx, withPatchedMembers } from './_test_helpers.js';
import type { MintSignals, TokenMetadata } from '../src/types/index.js';

const M = 'LedgerMintpump';

test('holder ledger is trusted only when balances match the curve', () => {
  _resetHolderLedgerForTest();
  applyHolderTrade(M, 'alice', true, 100n, PUMP_INITIAL_REAL_TOKENS - 100n);
  applyHolderTrade(M, 'bob', true, 300n, PUMP_INITIAL_REAL_TOKENS - 400n);
  applyHolderTrade(M, 'alice', false, 40n, PUMP_INITIAL_REAL_TOKENS - 360n);
  const top = getLedgerHolders(M, 5);
  assert.deepEqual(top, [
    { owner: 'bob', rawAmount: 300n },
    { owner: 'alice', rawAmount: 60n },
  ]);
});

test('holder ledger rejects a mint whose early trades were missed', () => {
  _resetHolderLedgerForTest();
  // Curve already sold 1000 tokens before we started watching.
  applyHolderTrade(M, 'late', true, 50n, PUMP_INITIAL_REAL_TOKENS - 1050n);
  assert.equal(getLedgerHolders(M, 5), null);
  // A wallet selling tokens we never saw it buy taints the ledger for good.
  _resetHolderLedgerForTest();
  applyHolderTrade(M, 'x', false, 10n, PUMP_INITIAL_REAL_TOKENS + 10n);
  assert.equal(getLedgerHolders(M, 5), null);
});

test('liquidity peak tracks the curve high-water mark since a point in time', () => {
  _resetPumpTradeIngestForTest();
  _setSolPriceCacheForTest(100);
  const ctx = createCtx();
  watchMint(M, 1000);
  const trade = (realSol: bigint, now: number): void => {
    ingestPumpTrade(
      ctx,
      {
        mint: M,
        solAmount: 1n,
        tokenAmount: 1n,
        isBuy: true,
        user: 'u',
        timestamp: 0,
        virtualSolReserves: 30_000_000_000n + realSol,
        virtualTokenReserves: 1_000_000_000_000n,
        realSolReserves: realSol,
        realTokenReserves: PUMP_INITIAL_REAL_TOKENS,
      },
      now
    );
  };
  trade(5_000_000_000n, 2000); // 5 SOL real => $1000 liquidity
  trade(100_000_000n, 3000); // pulled down to 0.1 SOL => $20
  assert.equal(getLiquidityPeak(M, 0), 1000);
  assert.equal(getLiquidityPeak(M, 2500), 20);
  assert.equal(getLiquidityPeak('other', 0), undefined);
});

test('deep audit refuses to approve when holder data is unavailable', async () => {
  const ctx = createCtx();
  const blind: MintSignals = {
    decimals: 6,
    supplyRaw: 1_000_000_000_000_000n,
    mintAuthority: null,
    freezeAuthority: null,
    top1Share: 0,
    top3Share: 0,
    top5Share: 0,
    holdersKnown: false,
    topAccounts: [],
  };
  const blockers: { message: string; code?: string; recheck?: boolean }[] = [];
  await withPatchedMembers(
    auditService,
    { fetchRugCheckWalletSignals: async () => [] },
    async () => {
      await runDeepAudit({
        ctx,
        token: { id: 'BlindMintpump', symbol: 'B', launchpad: 'pump.fun' } as TokenMetadata,
        preFetchedSignals: blind,
        isTrending: false,
        maxTop1Pct: 30,
        maxTop5Pct: 80,
        usdPrice: 1,
        entryScore: 80,
        notes: [],
        addBlocker: (message, code, recheck) => blockers.push({ message, code, recheck }),
      });
    }
  );
  const b = blockers.find((x) => x.code === 'holders-unknown');
  assert.ok(b, 'blind audit must add a holders-unknown blocker');
  assert.equal(b.recheck, true, 'and it must be retryable, not a permanent blacklist');
});
