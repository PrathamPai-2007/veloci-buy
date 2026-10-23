import { AccountBalanceEntry } from './token-account.types.js';

export class TopHolderTracker {
  private holders = new Map<string, AccountBalanceEntry>();

  update(tokenAccount: string, owner: string, amount: bigint): void {
    if (amount <= 0n) {
      this.holders.delete(tokenAccount);
    } else {
      this.holders.set(tokenAccount, { tokenAccount, owner, amount });
    }
  }

  getTopHolders(n = 5): AccountBalanceEntry[] {
    const list = Array.from(this.holders.values());
    list.sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
    return list.slice(0, n);
  }

  getConcentrationPct(totalSupply: bigint, topN = 5): number {
    if (totalSupply <= 0n) return 0;
    const topHolders = this.getTopHolders(topN);
    const sum = topHolders.reduce((acc, h) => acc + h.amount, 0n);
    return Number((sum * 10000n) / totalSupply) / 100;
  }

  get holderCount(): number {
    return this.holders.size;
  }

  clear(): void {
    this.holders.clear();
  }
}
