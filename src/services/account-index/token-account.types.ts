export interface AccountBalanceEntry {
  tokenAccount: string;
  owner: string;
  amount: bigint;
}

export interface ConcentrationMetrics {
  mint: string;
  top1ConcentrationPct: number;
  top5ConcentrationPct: number;
  top10ConcentrationPct: number;
  totalTrackedHolders: number;
  totalSupply: bigint;
  updatedAt: number;
}

export interface HolderDriftEvent {
  mint: string;
  owner: string;
  previousAmount: bigint;
  currentAmount: bigint;
  deltaAmount: bigint;
  deltaPercentage: number;
  action: 'accumulating' | 'dumping' | 'exited';
  timestamp: number;
}
