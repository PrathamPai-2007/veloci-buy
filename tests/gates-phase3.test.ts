'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import { createCtx, createTestConfig } from './_test_helpers.js';
import * as audit from '../src/services/audit/audit.service.js';
import { dropCurveAccounts } from '../src/services/audit/providers/onchain-auditor.js';
import { derivePumpCurvePda } from '../src/core/utils.js';
import { selectScanJupiterMints } from '../src/services/market-data.js';
import { insiderRugGuard } from '../src/services/monitor/exits/rules/insider-rug.js';
import type { Context, MintSignals } from '../src/types/index.js';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CURVE_ATA = 'Gdpe65jYLRPWZqmFXLoS66HU4r1J8B6GXjAhWXqtfork';
const WALLET_ATA_1 = 'H9kuqGKNYgPFYCA17uUTkaqXGum7MK8y1GwbS7cxsjDg';
const WALLET_ATA_2 = 'CZzEeJpTsTNWnSWaB5gY6r7fFEAyFpQVDP1aAzXdwQ4P';

test('dropCurveAccounts removes only curve-owned accounts and keeps all when the PDA is unknown', () => {
  const accounts = [{ owner: 'curve' }, { owner: 'w1' }, { owner: null }];
  assert.deepEqual(dropCurveAccounts(accounts, 'curve'), [{ owner: 'w1' }, { owner: null }]);
  assert.equal(dropCurveAccounts(accounts, '').length, 3);
});

test('getMintSignals measures concentration over real holders, not the bonding curve', async () => {
  const curvePda = await derivePumpCurvePda(MINT);
  assert.ok(curvePda, 'curve PDA derives');
  const owners: Record<string, string> = {
    [CURVE_ATA]: curvePda,
    [WALLET_ATA_1]: 'WalletOne',
    [WALLET_ATA_2]: 'WalletTwo',
  };
  const mockRpc = {
    getAccountInfo: () => ({
      send: async () => ({
        value: {
          data: {
            parsed: {
              type: 'mint',
              info: { decimals: 6, supply: '1000', mintAuthority: null, freezeAuthority: null },
            },
          },
        },
      }),
    }),
    getTokenLargestAccounts: () => ({
      send: async () => ({
        value: [
          { address: CURVE_ATA, amount: '790' },
          { address: WALLET_ATA_1, amount: '100' },
          { address: WALLET_ATA_2, amount: '50' },
        ],
      }),
    }),
    getMultipleAccounts: (addresses: string[]) => ({
      send: async () => ({
        value: addresses.map((a) => ({ data: { parsed: { info: { owner: owners[String(a)] } } } })),
      }),
    }),
  } as any;
  const ctx = {
    config: createTestConfig({ mintSignalRetryDelayMs: 1 }),
    rpc: mockRpc,
    rpcs: [mockRpc],
    logger: () => {},
  } as unknown as Context;

  const signals = await audit.getMintSignals(ctx, MINT, { skipCache: true });
  assert.deepEqual(
    signals.topAccounts.map((a) => a.owner),
    ['WalletOne', 'WalletTwo']
  );
  assert.equal(signals.top1Share, 0.1);
  assert.ok(Math.abs(signals.top3Share - 0.15) < 1e-9);
  assert.ok(Math.abs(signals.top5Share - 0.15) < 1e-9);
});

test('graduated pump mints go to Jupiter; ungraduated pump mints still never do', () => {
  const ctx = createCtx();
  const PUMP = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApump';
  const GRAD = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBpump';
  assert.deepEqual(selectScanJupiterMints(ctx, [PUMP, GRAD], {}), []);
  assert.deepEqual(selectScanJupiterMints(ctx, [PUMP, GRAD], {}, new Set([GRAD])), [GRAD]);
});

function signalsWith(top5Share: number, holders: Record<string, bigint>): MintSignals {
  return {
    decimals: 6,
    supplyRaw: 1000n,
    mintAuthority: null,
    freezeAuthority: null,
    top1Share: 0,
    top3Share: 0,
    top5Share,
    topAccounts: Object.entries(holders).map(([owner, rawAmount]) => ({
      address: `ata-${owner}`,
      rawAmount,
      share: Number(rawAmount) / 1000,
      owner,
    })),
  } as MintSignals;
}

test('insider-rug compares entry holders with the latest re-audit', async () => {
  const ctx = createCtx();
  const exitCtx = (pos: any, preSignals?: MintSignals) =>
    ({ ctx, mint: 'M', pos, preSignals }) as any;
  const entry = signalsWith(0.7, { whale: 400n, other: 300n });

  // Concentrated entry, whale sold half => full exit.
  const sold = signalsWith(0.5, { whale: 200n, other: 300n });
  const pos1: any = { symbol: 'T', entryMintSignals: entry, mintSignals: sold };
  const decision = await insiderRugGuard(exitCtx(pos1, sold));
  assert.equal(decision?.reason, 'insider-rug-exit');

  // Same object (no re-audit yet) or no entry snapshot => nothing to compare.
  const pos2: any = { symbol: 'T', entryMintSignals: entry, mintSignals: entry };
  assert.equal(await insiderRugGuard(exitCtx(pos2, entry)), null);
  const pos3: any = { symbol: 'T', mintSignals: sold };
  assert.equal(await insiderRugGuard(exitCtx(pos3, sold)), null);

  // Distributed entry (top5 below threshold): drift is logged, not exited.
  const spread = signalsWith(0.3, { a: 150n, b: 150n });
  const pos4: any = { symbol: 'T', entryMintSignals: spread };
  assert.equal(await insiderRugGuard(exitCtx(pos4, signalsWith(0.2, { a: 20n, b: 150n }))), null);
});
