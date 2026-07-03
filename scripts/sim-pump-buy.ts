/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
/**
 * Live simulation harness for the local pump.fun buy/sell instruction (F2).
 *
 * Builds the REAL transaction via `buildPumpFunSwap` and runs it through RPC `simulateTransaction`
 * against live chain state — no transaction is broadcast and no SOL is spent. A wrong account list,
 * order, role, or instruction-data byte makes the program fail in simulation exactly as it would on a
 * real send, so this verifies the rebuilt instruction without funds.
 *
 * Usage:
 *   npx tsx scripts/sim-pump-buy.ts [mint] [feePayerPubkey]
 * With no args it auto-picks a recent non-completed pump mint and a funded recent buyer as fee payer.
 * Requires RPC_URL in .env (or the RPC_URL env var).
 */
import { readFileSync } from 'node:fs';
import { createSolanaRpc, type Rpc, type SolanaRpcApi } from '@solana/rpc';
import { buildPumpFunSwap } from '../src/services/trading/adapters/pumpfun.js';
import { decodePumpCurve, derivePumpCurvePda } from '../src/core/utils/solana.js';
import type { Context } from '../src/types/index.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const RPC =
  process.env.RPC_URL ||
  readFileSync('.env', 'utf8')
    .match(/^RPC_URL=(.+)$/m)?.[1]
    ?.trim();
if (!RPC) throw new Error('RPC_URL not found (env or .env)');

let rpcId = 1;
async function raw(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(RPC!, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });
  const j = (await res.json()) as { error?: unknown; result?: unknown };
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

// Walk recent program txs to auto-pick: a fresh non-completed mint and a funded recent buyer.
async function autoPick(): Promise<{ mint: string; payer: string }> {
  const sigs = await raw('getSignaturesForAddress', [PUMP_PROGRAM, { limit: 80 }]);
  let mint = '';
  let payer = '';
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await raw('getTransaction', [
      s.signature,
      { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);
    const lm: string[] = tx?.meta?.logMessages ?? [];
    if (!lm.some((l) => /Instruction:\s+Buy/i.test(l))) continue;
    const all = [
      ...(tx.transaction.message.instructions || []),
      ...(tx.meta?.innerInstructions || []).flatMap((x: any) => x.instructions),
    ];
    const buy = all.find((ix: any) => ix.programId === PUMP_PROGRAM && typeof ix.data === 'string');
    if (!buy || buy.accounts.length < 18) continue; // skip graduated PumpSwap buys
    const m = buy.accounts[2] as string; // mint per IDL
    if (m === SOL_MINT) continue;
    // confirm bonding curve exists and is not completed
    const bc = await derivePumpCurvePda(m);
    const ai = await raw('getAccountInfo', [bc, { encoding: 'base64', commitment: 'confirmed' }]);
    if (!ai?.value?.data?.[0]) continue;
    const curve = decodePumpCurve(Buffer.from(ai.value.data[0], 'base64'));
    if (!curve || curve.isCompleted) continue;
    mint = m;
    payer = tx.transaction.message.accountKeys.find((k: any) => k.signer)?.pubkey ?? '';
    if (mint && payer) break;
  }
  if (!mint || !payer) throw new Error('could not auto-pick a fresh mint + funded payer');
  return { mint, payer };
}

async function main() {
  let mint = process.argv[2];
  let payer = process.argv[3];
  if (!mint || !payer) {
    const picked = await autoPick();
    mint = mint || picked.mint;
    payer = payer || picked.payer;
  }
  console.log('fee payer :', payer);
  console.log('mint      :', mint);

  const rpc = createSolanaRpc(RPC!) as Rpc<SolanaRpcApi>;
  const ctx = {
    rpc,
    rpcs: [rpc],
    wallet: { address: payer },
    config: {},
    logger: () => {},
  } as unknown as Context;

  // 0.001 SOL test buy with 5% slippage
  const order = await buildPumpFunSwap(ctx, SOL_MINT, mint, 1_000_000n, 500);
  if (!order) throw new Error('buildPumpFunSwap returned null');

  const sim = await raw('simulateTransaction', [
    order.transaction,
    { encoding: 'base64', commitment: 'confirmed', sigVerify: false, replaceRecentBlockhash: true },
  ]);

  console.log('\n--- simulation result ---');
  console.log('err          :', JSON.stringify(sim.value.err));
  console.log('unitsConsumed:', sim.value.unitsConsumed);
  console.log('logs:');
  for (const l of sim.value.logs ?? []) console.log('  ', l);

  if (sim.value.err === null) {
    console.log('\n✅ BUY INSTRUCTION VALID — program accepted the rebuilt accounts + data.');
  } else {
    console.log('\n❌ SIMULATION FAILED — see err + logs above.');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
