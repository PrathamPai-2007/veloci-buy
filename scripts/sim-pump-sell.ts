/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
/**
 * Live simulation harness for the local pump.fun SELL instruction (F2, sell side).
 *
 * Builds the REAL sell transaction via `buildPumpFunSwap` and runs it through RPC
 * `simulateTransaction` against live chain state — nothing is broadcast, no SOL/token is spent. A
 * sell needs the signer to actually hold the token (simulation checks the token balance), so with no
 * args this auto-picks a recent buyer who still holds a non-completed pump token and sells a fraction
 * of their real balance. A wrong account list/order/role/data makes the program fail exactly as on a
 * real send.
 *
 * Usage:
 *   npx tsx scripts/sim-pump-sell.ts [mint] [holderPubkey]
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

// Returns the raw token balance a holder owns of a mint (0 if none).
async function tokenBalance(holder: string, mint: string): Promise<bigint> {
  const res = await raw('getTokenAccountsByOwner', [
    holder,
    { mint },
    { encoding: 'jsonParsed', commitment: 'confirmed' },
  ]);
  const amt = res?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.amount;
  return amt ? BigInt(amt) : 0n;
}

// Walk recent buys; pick a (mint, buyer) where the curve isn't completed and the buyer still holds a
// non-zero balance — the signer must own the token for a sell to simulate.
async function autoPick(): Promise<{ mint: string; holder: string; balance: bigint }> {
  const sigs = await raw('getSignaturesForAddress', [PUMP_PROGRAM, { limit: 120 }]);
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
    if (!buy || buy.accounts.length < 18) continue;
    const mint = buy.accounts[2] as string;
    if (mint === SOL_MINT) continue;
    const bc = await derivePumpCurvePda(mint);
    const ai = await raw('getAccountInfo', [bc, { encoding: 'base64', commitment: 'confirmed' }]);
    if (!ai?.value?.data?.[0]) continue;
    const curve = decodePumpCurve(Buffer.from(ai.value.data[0], 'base64'));
    if (!curve || curve.isCompleted) continue;
    const holder = tx.transaction.message.accountKeys.find((k: any) => k.signer)?.pubkey ?? '';
    if (!holder) continue;
    const balance = await tokenBalance(holder, mint);
    if (balance > 0n) return { mint, holder, balance };
  }
  throw new Error('could not auto-pick a holder with a non-zero balance of a non-completed mint');
}

async function main() {
  let mint = process.argv[2];
  let holder = process.argv[3];
  let balance: bigint;
  if (!mint || !holder) {
    const p = await autoPick();
    mint = mint || p.mint;
    holder = holder || p.holder;
    balance = p.balance;
  } else {
    balance = await tokenBalance(holder, mint);
  }
  if (balance <= 0n) throw new Error(`${holder} holds 0 of ${mint} — cannot simulate a sell`);
  // sell half the balance (any non-zero amount the holder owns exercises the sell instruction)
  const sellAmount = balance / 2n > 0n ? balance / 2n : balance;
  console.log('holder    :', holder);
  console.log('mint      :', mint);
  console.log('balance   :', balance.toString(), '→ selling', sellAmount.toString());

  const rpc = createSolanaRpc(RPC!) as Rpc<SolanaRpcApi>;
  const ctx = {
    rpc,
    rpcs: [rpc],
    wallet: { address: holder },
    config: {},
    logger: () => {},
  } as unknown as Context;

  // inputMint = token, outputMint = SOL → sell path; 5% slippage
  const order = await buildPumpFunSwap(ctx, mint, SOL_MINT, sellAmount, 500);
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
    console.log('\n✅ SELL INSTRUCTION VALID — program accepted the rebuilt accounts + data.');
  } else {
    console.log('\n❌ SIMULATION FAILED — see err + logs above.');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
