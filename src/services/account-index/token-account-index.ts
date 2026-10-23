import { EventEmitter } from 'node:events';
import { TopHolderTracker } from './top-holder-heap.js';
import {
  AccountBalanceEntry,
  ConcentrationMetrics,
  HolderDriftEvent,
} from './token-account.types.js';
import { Context } from '#types/index.js';
import { rpcCall, PRIORITY, isRateLimitError } from '#core/utils.js';

export type MintInitState = 'UNINITIALIZED' | 'INITIALIZING' | 'AVAILABLE' | 'FAILED_COOLDOWN';

export interface MintStateRecord {
  state: MintInitState;
  failedAt?: number;
  cooldownUntil?: number;
}

export class TokenAccountIndexService extends EventEmitter {
  private readonly mintTrackers = new Map<string, TopHolderTracker>();
  private readonly mintSupplies = new Map<string, bigint>();
  private readonly initPromises = new Map<string, Promise<void>>();
  private readonly mintStates = new Map<string, MintStateRecord>();

  // Pacing & Rate Limiting Queue (Max 1 in-flight, spaced >= 300ms apart)
  private readonly requestQueue: Array<() => Promise<void>> = [];
  private isProcessingQueue = false;
  private lastRequestStartTs = 0;
  private activeInFlightCount = 0;
  private static readonly MIN_REQUEST_SPACING_MS = 300;
  private totalQueueWaitMs = 0;
  private last429LogTime = new Map<string, number>();

  getTotalQueueWaitMs(): number {
    return this.totalQueueWaitMs;
  }

  getInFlightCount(): number {
    return this.activeInFlightCount;
  }

  getMintState(mint: string): MintStateRecord {
    return this.mintStates.get(mint) ?? { state: 'UNINITIALIZED' };
  }

  resetMetrics(): void {
    this.totalQueueWaitMs = 0;
    this.activeInFlightCount = 0;
    this.last429LogTime.clear();
  }

  isIndexed(mint: string): boolean {
    return this.mintTrackers.has(mint) && (this.mintTrackers.get(mint)?.holderCount ?? 0) > 0;
  }

  /**
   * Validates if a string is a plausible Solana base58 address.
   */
  public isValidBase58Mint(mint: string): boolean {
    if (!mint || typeof mint !== 'string') return false;
    const trimmed = mint.trim();
    if (trimmed.length < 32 || trimmed.length > 44) return false;
    // Base58 characters check
    return /^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmed);
  }

  /**
   * Initializes local token account snapshot for a mint using a single initial RPC query.
   * Deduplicates concurrent initialization attempts for the same mint via initPromises.
   * Enforces global pacing (max 1 in-flight, >=300ms spacing) and per-mint cooldown on 429.
   */
  async initializeMintSnapshot(
    ctx: Context,
    mint: string,
    totalSupply = 1_000_000_000_000_000n,
    caller = 'unknown'
  ): Promise<void> {
    if (this.mintTrackers.has(mint) && (this.mintTrackers.get(mint)?.holderCount ?? 0) > 0) return;

    // Validate mint string before touching queue or RPC
    if (!this.isValidBase58Mint(mint)) {
      ctx.store?.incrementMetric('invalidMintSkips', 1);
      ctx.logger(`Skipping getTokenLargestAccounts for invalid mint parameter: "${mint}"`, 'debug');
      return;
    }

    // Per-mint failed cooldown check
    const currentState = this.mintStates.get(mint);
    if (currentState?.state === 'FAILED_COOLDOWN') {
      if (currentState.cooldownUntil && Date.now() < currentState.cooldownUntil) {
        ctx.logger(
          `[TokenAccountIndex] Skipping ${mint} (caller: ${caller}) - in failed cooldown until ${new Date(currentState.cooldownUntil).toISOString()}`,
          'debug'
        );
        return;
      }
    }

    const existingPromise = this.initPromises.get(mint);
    if (existingPromise) return existingPromise;

    ctx.store?.incrementMetric('tokenLargestRequestQueued', 1);
    ctx.store?.incrementMetric('tokenLargestRequestCaller', 1);
    ctx.store?.incrementMetric('tokenLargestRequestMint', 1);

    const queueStartTs = Date.now();
    const initPromise = new Promise<void>((resolve) => {
      const task = async () => {
        const queueWait = Date.now() - queueStartTs;
        this.totalQueueWaitMs += queueWait;

        this.activeInFlightCount++;
        ctx.store?.incrementMetric('tokenLargestRequestStarted', 1);

        const tracker = this.mintTrackers.get(mint) ?? new TopHolderTracker();
        this.mintTrackers.set(mint, tracker);
        this.mintSupplies.set(mint, totalSupply);
        this.mintStates.set(mint, { state: 'INITIALIZING' });

        try {
          ctx.store?.incrementMetric('tokenLargestInitializations', 1);
          ctx.store?.incrementMetric('getTokenLargestAccountsRequests', 1);
          ctx.store?.incrementMetric('holderInitRequests', 1);

          // Pacing check: enforce minimum 300ms spacing since last request started
          const targetStartTs = Math.max(
            Date.now(),
            this.lastRequestStartTs + TokenAccountIndexService.MIN_REQUEST_SPACING_MS
          );
          const waitMs = targetStartTs - Date.now();
          if (waitMs > 0) {
            await new Promise((r) => setTimeout(r, waitMs + 5)); // 5ms buffer against OS timer drift
          }
          this.lastRequestStartTs = Date.now();

          // Single attempt (maxAttempts: 1) to eliminate nested retries on 429
          const resp = (await rpcCall(
            ctx,
            'getTokenLargestAccounts',
            [
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              mint as any,
              { commitment: 'confirmed' },
            ],
            { priority: PRIORITY.LOW, timeoutMs: 5000, maxAttempts: 1 }
          )) as unknown as { value: Array<{ address: string; amount: string }> };

          if (resp?.value && Array.isArray(resp.value)) {
            for (const entry of resp.value) {
              const amount = BigInt(entry.amount || '0');
              tracker.update(entry.address, entry.address, amount);
            }
            this.mintStates.set(mint, { state: 'AVAILABLE' });
          } else {
            const cooldownMs = Math.floor(30000 + Math.random() * 30000);
            this.mintStates.set(mint, {
              state: 'FAILED_COOLDOWN',
              failedAt: Date.now(),
              cooldownUntil: Date.now() + cooldownMs,
            });
          }
        } catch (err) {
          const cooldownMs = Math.floor(30000 + Math.random() * 30000);
          this.mintStates.set(mint, {
            state: 'FAILED_COOLDOWN',
            failedAt: Date.now(),
            cooldownUntil: Date.now() + cooldownMs,
          });

          const msg = err instanceof Error ? err.message : String(err);
          if (isRateLimitError(err) || msg.includes('429')) {
            ctx.store?.incrementMetric('tokenLargest429s', 1);
            ctx.store?.incrementMetric('holderInit429s', 1);
            const lastLog = this.last429LogTime.get(mint) || 0;
            if (Date.now() - lastLog > 60000) {
              this.last429LogTime.set(mint, Date.now());
              ctx.logger(
                `getTokenLargestAccounts rate limited (429) for ${mint} (cooldown: ${Math.round(cooldownMs / 1000)}s)`,
                'warn'
              );
            }
          } else if (
            msg.includes('not a Token mint') ||
            msg.includes('AccountNotFound') ||
            msg.includes('Invalid param')
          ) {
            ctx.store?.incrementMetric('invalidMintSkips', 1);
            ctx.logger(
              `getTokenLargestAccounts skipped: ${mint} is not a valid Token mint`,
              'debug'
            );
          } else {
            ctx.logger(`Initial holder snapshot fetch failed for ${mint}: ${msg}`, 'debug');
          }
        } finally {
          this.activeInFlightCount--;
          ctx.store?.incrementMetric('tokenLargestRequestFinished', 1);
          this.initPromises.delete(mint);
          resolve();
        }
      };

      this.requestQueue.push(task);
      void this.processQueue();
    });

    this.initPromises.set(mint, initPromise);
    return initPromise;
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    while (this.requestQueue.length > 0) {
      const task = this.requestQueue.shift();
      if (task) {
        await task();
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * Updates balance for a token account incrementally from a streaming account notification.
   */
  updateBalance(
    mint: string,
    tokenAccount: string,
    owner: string,
    newAmount: bigint
  ): HolderDriftEvent | null {
    let tracker = this.mintTrackers.get(mint);
    if (!tracker) {
      tracker = new TopHolderTracker();
      this.mintTrackers.set(mint, tracker);
    }

    const previousTop = tracker.getTopHolders(10);
    const existingEntry = previousTop.find((h) => h.tokenAccount === tokenAccount);

    tracker.update(tokenAccount, owner, newAmount);

    if (existingEntry) {
      const prev = existingEntry.amount;
      if (prev > 0n && prev !== newAmount) {
        const delta = newAmount - prev;
        const pct = Number((delta * 10000n) / prev) / 100;
        let action: 'accumulating' | 'dumping' | 'exited' = 'accumulating';

        if (newAmount === 0n) {
          action = 'exited';
        } else if (delta < 0n) {
          action = 'dumping';
        }

        const event: HolderDriftEvent = {
          mint,
          owner,
          previousAmount: prev,
          currentAmount: newAmount,
          deltaAmount: delta,
          deltaPercentage: pct,
          action,
          timestamp: Date.now(),
        };

        this.emit('holderDrift', event);
        return event;
      }
    }

    return null;
  }

  getConcentration(mint: string): ConcentrationMetrics | null {
    const tracker = this.mintTrackers.get(mint);
    const supply = this.mintSupplies.get(mint) ?? 1_000_000_000_000_000n;
    if (!tracker) return null;

    return {
      mint,
      top1ConcentrationPct: tracker.getConcentrationPct(supply, 1),
      top5ConcentrationPct: tracker.getConcentrationPct(supply, 5),
      top10ConcentrationPct: tracker.getConcentrationPct(supply, 10),
      totalTrackedHolders: tracker.holderCount,
      totalSupply: supply,
      updatedAt: Date.now(),
    };
  }

  getTopHolders(mint: string, n = 5): AccountBalanceEntry[] {
    const tracker = this.mintTrackers.get(mint);
    return tracker ? tracker.getTopHolders(n) : [];
  }

  removeMint(mint: string): void {
    this.mintTrackers.delete(mint);
    this.mintSupplies.delete(mint);
  }

  clear(): void {
    this.mintTrackers.clear();
    this.mintSupplies.clear();
  }
}

export const tokenAccountIndex = new TokenAccountIndexService();
