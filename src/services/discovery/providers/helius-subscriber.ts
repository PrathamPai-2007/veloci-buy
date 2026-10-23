/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/explicit-module-boundary-types */
import { ParsedInstruction, TransactionData } from '#types/index.js';
import {
  PUMP_FUN_PROGRAM_ID,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  METEORA_DLMM_PROGRAM_ID,
} from '#core/config.js';

export function extractInitializedMints(tx: TransactionData): string[] {
  const mints = new Set<string>();
  const collect = (ixs: ParsedInstruction[] | undefined) => {
    if (!Array.isArray(ixs)) return;
    for (const ix of ixs) {
      const parsed = ix?.parsed;
      const type = String(parsed?.type || '').toLowerCase();
      const info = parsed?.info;
      const mint = info?.mint;
      if ((type === 'initializemint' || type === 'initializemint2') && typeof mint === 'string')
        mints.add(mint);
    }
  };
  collect(tx?.transaction?.message?.instructions);
  const meta = tx?.meta;
  (meta?.innerInstructions || []).forEach((g) => collect(g?.instructions));
  return Array.from(mints);
}

export function getMatchingProgramId(result: any): string | null {
  const accountKeys = result.transaction?.transaction?.message?.accountKeys || [];
  const keys = accountKeys.map(
    (k: any) => (typeof k === 'string' ? k : String(k?.pubkey || '')) as string
  );
  if (keys.includes(PUMP_FUN_PROGRAM_ID)) return PUMP_FUN_PROGRAM_ID;
  if (keys.includes(RAYDIUM_AMM_V4_PROGRAM_ID)) return RAYDIUM_AMM_V4_PROGRAM_ID;
  if (keys.includes(METEORA_DLMM_PROGRAM_ID)) return METEORA_DLMM_PROGRAM_ID;
  return null;
}
