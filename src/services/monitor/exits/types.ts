import { Context, Position, MintSignals } from '#types/index.js';
import { PriceRecord } from '../monitor.service.js';

export interface ExitDecision {
  reason: string;
  sellRaw?: bigint;
  isPartial?: boolean;
  message?: string;
  level?: 'info' | 'warn' | 'trade' | 'error';
  handled?: boolean; // If true, the rule already executed the trade (e.g. TP ladder)
}

export interface ExitContext {
  ctx: Context;
  mint: string;
  pos: Position;
  balance: { mint: string; rawAmount: bigint; decimals: number; uiAmount: number };
  pRecord: PriceRecord | undefined;
  preSignals: MintSignals | undefined;
  pUsd: number;
  ageSec: number;
  multiples: number[];
  moonBag: bigint;
  remainingRaw: bigint;
  isRunnerOnly: boolean;
  readOnly?: boolean;
}

export type ExitRule = (exitCtx: ExitContext) => Promise<ExitDecision | null> | ExitDecision | null;
