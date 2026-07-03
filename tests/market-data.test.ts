'use strict';
import { createCtx } from './_test_helpers.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { selectScanJupiterMints } from '../src/services/market-data.js';
import { MarketSnapshot } from '../src/types/index.js';

// selectScanJupiterMints governs how many Jupiter calls the scan path makes — the dominant source
// of scan-side 429s. The rule: a mint warrants Jupiter only if the on-chain curve left it unpriced
// AND it is not a pump.fun token (Jupiter can't price fresh pump mints, so asking just burns the
// rate limit). Pump mints are priced from the curve or skipped until the curve fills.
const PUMP_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApump';
const PUMP_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBpump';
const GRADUATED = 'DwrPd1BFdHPkPzVudJQXoZusNGDoHVU43ShA6rT5yyTD'; // non-pump suffix (e.g. Raydium)

test('scan partition never sends pump mints to Jupiter, even when the curve has not priced them', () => {
  const ctx = createCtx();
  const mints = [PUMP_A, PUMP_B];
  // No prices yet (curve account not found this cycle).
  assert.deepEqual(selectScanJupiterMints(ctx, mints, {}), []);
});

test('scan partition sends only the unpriced non-pump residual to Jupiter', () => {
  const ctx = createCtx();
  const mints = [PUMP_A, GRADUATED];
  // Curve priced the pump mint; the graduated token is still unpriced.
  const prices = { [PUMP_A]: { usdPrice: 0.0000042, liquidity: 5000 } };
  assert.deepEqual(selectScanJupiterMints(ctx, mints, prices), [GRADUATED]);
});

test('scan partition skips a non-pump mint that already has a price (no redundant Jupiter call)', () => {
  const ctx = createCtx();
  const prices = { [GRADUATED]: { usdPrice: 0.5, liquidity: 100000 } };
  assert.deepEqual(selectScanJupiterMints(ctx, [GRADUATED], prices), []);
});

test('scan partition treats a snapshot-tagged pump.fun mint as pump (not via suffix)', () => {
  const ctx = createCtx();
  // A mint whose address does not end in "pump" but is known to be pump.fun from its snapshot.
  const oddMint = 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ1234';
  ctx.state.marketSnapshots.set(oddMint, {
    launchpad: 'pump.fun',
    usdPrice: 0,
    liquidity: 0,
    observedAt: new Date().toISOString(),
  } as unknown as MarketSnapshot);
  assert.deepEqual(selectScanJupiterMints(ctx, [oddMint], {}), []);
});
