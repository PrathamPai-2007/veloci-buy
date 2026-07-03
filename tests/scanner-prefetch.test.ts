'use strict';
import { createCtx, withPatchedMembers } from './_test_helpers.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { appService } from '../src/services/services.js';
import { scanForCandidates } from '../src/services/scanner/scanner.service.js';
import { EvaluationResult, TokenMetadata } from '../src/types/index.js';

// A fresh pump.fun mint arrives from Jupiter `recent` with usdPrice/liquidity 0.
// The scanner used to write that zero-price snapshot and then skip the on-chain
// bonding-curve fallback, surfacing as "No price" / "$0.00 liquidity" rejects.
// It should now re-fetch such mints so the curve fills in real values.
test('scanner re-fetches zero-price pump.fun mints through the curve fallback', async () => {
  const ctx = createCtx({ paperTrading: true });
  const mint = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApump';

  const token: TokenMetadata = {
    id: mint,
    symbol: 'FRESH',
    name: 'Fresh',
    launchpad: 'pump.fun',
    usdPrice: 0,
    liquidity: 0,
  } as TokenMetadata;

  let fetchedMints: string[] = [];

  await withPatchedMembers(
    appService as unknown as Record<string, unknown>,
    {
      // Capture which mints get the best-effort (curve fallback) fetch; return real values.
      fetchPricesBestEffort: async (_ctx: unknown, mints: string[]) => {
        fetchedMints = mints;
        return { [mint]: { usdPrice: 0.0000042, liquidity: 5000 } };
      },
      // Short-circuit evaluation so the test focuses on the pre-fetch behaviour.
      evaluateCandidate: async (): Promise<EvaluationResult> =>
        ({
          approved: false,
          blockers: ['stub'],
          rejectionReasons: [{ code: 'stub', recheckEligible: false }],
          notes: [],
          candidateScore: 0,
          token,
        }) as unknown as EvaluationResult,
    },
    async () => {
      await scanForCandidates(ctx, [token], []);
    }
  );

  assert.ok(fetchedMints.includes(mint), 'zero-price pump mint should be re-fetched');

  const snap = ctx.state.marketSnapshots.get(mint);
  assert.ok(snap, 'snapshot should exist');
  assert.ok(
    Number(snap!.usdPrice) > 0,
    `usdPrice should be filled from curve, got ${snap!.usdPrice}`
  );
  assert.ok(Number(snap!.liquidity) > 0, `liquidity should be filled, got ${snap!.liquidity}`);
  assert.equal(snap!.launchpad, 'pump.fun', 'known launchpad must be preserved, not clobbered');
});
