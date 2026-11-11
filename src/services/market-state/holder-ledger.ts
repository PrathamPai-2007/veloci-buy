/**
 * Per-wallet token balances rebuilt from pump.fun TradeEvents (free: they ride the log stream).
 *
 * A ledger is only trusted when it provably saw every trade: the sum of wallet balances must equal
 * the tokens the curve has sold (INITIAL_REAL_TOKENS - realTokenReserves of the latest trade).
 * A mint we started watching late, or a wallet that sold tokens it got by transfer, fails that
 * check and the caller falls back to RPC. Wallets that move tokens off-curve are the one blind
 * spot; the RPC audit of survivors still covers them.
 */

/** realTokenReserves of a fresh pump.fun curve (793.1M tokens, 6 decimals). */
export const PUMP_INITIAL_REAL_TOKENS = 793_100_000_000_000n;

const MAX_LEDGERS = 2000;
const IDLE_MS = 10 * 60 * 1000;

interface Ledger {
  balances: Map<string, bigint>;
  lastRealTokens: bigint;
  tainted: boolean;
  touchedAt: number;
}

const ledgers = new Map<string, Ledger>();

export function applyHolderTrade(
  mint: string,
  user: string,
  isBuy: boolean,
  tokenAmount: bigint,
  realTokenReserves: bigint,
  now = Date.now()
): void {
  let l = ledgers.get(mint);
  if (!l) {
    if (ledgers.size >= MAX_LEDGERS) {
      for (const [m, x] of ledgers) if (now - x.touchedAt > IDLE_MS) ledgers.delete(m);
      if (ledgers.size >= MAX_LEDGERS) ledgers.delete(ledgers.keys().next().value as string);
    }
    l = {
      balances: new Map(),
      lastRealTokens: PUMP_INITIAL_REAL_TOKENS,
      tainted: false,
      touchedAt: now,
    };
    ledgers.set(mint, l);
  }
  const next = (l.balances.get(user) ?? 0n) + (isBuy ? tokenAmount : -tokenAmount);
  if (next < 0n) l.tainted = true; // sold tokens we never saw them buy
  l.balances.set(user, next < 0n ? 0n : next);
  l.lastRealTokens = realTokenReserves;
  l.touchedAt = now;
}

export interface LedgerHolder {
  owner: string;
  rawAmount: bigint;
}

/** Top wallets by balance, or null when the ledger is missing or cannot be proven complete. */
export function getLedgerHolders(mint: string, limit: number): LedgerHolder[] | null {
  const l = ledgers.get(mint);
  if (!l || l.tainted) return null;
  let sum = 0n;
  for (const v of l.balances.values()) sum += v;
  if (sum !== PUMP_INITIAL_REAL_TOKENS - l.lastRealTokens) return null;
  return [...l.balances]
    .filter(([, v]) => v > 0n)
    .sort((a, b) => (a[1] === b[1] ? 0 : a[1] > b[1] ? -1 : 1))
    .slice(0, limit)
    .map(([owner, rawAmount]) => ({ owner, rawAmount }));
}

/** @testOnly */
export function _resetHolderLedgerForTest(): void {
  ledgers.clear();
}
