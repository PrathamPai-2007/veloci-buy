/**
 * Remembers the name+symbol of launches seen this session (from pump.fun CreateEvents, which
 * arrive in launch order) so a later launch reusing the same name+symbol can be flagged as a
 * copycat. Originals graduate far more often than copycats (arXiv 2609.10246: 9.20% vs 0.86%).
 */
const MAX_LAUNCHES = 20_000;
const firstMintByKey = new Map<string, string>();
const keyByMint = new Map<string, string>();

function launchKey(name: string, symbol: string): string | null {
  const n = name?.trim().toLowerCase();
  const s = symbol?.trim().toLowerCase();
  if (!n || !s || n === '?' || s === '?') return null;
  return `${n}|${s}`;
}

export function registerLaunch(mint: string, name: string, symbol: string): void {
  const key = launchKey(name, symbol);
  if (!key || keyByMint.has(mint)) return;
  if (keyByMint.size >= MAX_LAUNCHES) {
    const oldest = keyByMint.keys().next().value;
    if (oldest !== undefined) {
      const oldKey = keyByMint.get(oldest)!;
      keyByMint.delete(oldest);
      if (firstMintByKey.get(oldKey) === oldest) firstMintByKey.delete(oldKey);
    }
  }
  keyByMint.set(mint, key);
  if (!firstMintByKey.has(key)) firstMintByKey.set(key, mint);
}

/** True when an earlier launch this session used the same name and symbol. */
export function isCopycat(mint: string): boolean {
  const key = keyByMint.get(mint);
  if (!key) return false;
  const first = firstMintByKey.get(key);
  return first !== undefined && first !== mint;
}

/** @testOnly */
export function _resetLaunchRegistryForTest(): void {
  firstMintByKey.clear();
  keyByMint.clear();
}
