import { Context, Position, PositionLifecycle, ExitResult } from '#types/index.js';

/**
 * Valid lifecycle transitions map.
 * Terminal states (like CLOSED) cannot transition back unless explicitly recovered.
 */
const VALID_TRANSITIONS: Record<PositionLifecycle, PositionLifecycle[]> = {
  OPEN: ['EXIT_PENDING', 'EXITING', 'CLOSED'],
  EXIT_PENDING: ['EXITING', 'CLOSED', 'EXIT_FAILED'],
  EXITING: ['PARTIALLY_EXITED', 'CLOSED', 'EXIT_FAILED'],
  PARTIALLY_EXITED: ['OPEN', 'EXIT_PENDING', 'EXITING', 'CLOSED'],
  CLOSED: [], // Terminal
  EXIT_FAILED: ['OPEN', 'EXITING', 'CLOSED'],
};

export function transitionPositionLifecycle(
  pos: Position,
  targetState: PositionLifecycle
): boolean {
  const current = pos.lifecycleState ?? 'OPEN';
  if (current === targetState) return true;

  const validNext = VALID_TRANSITIONS[current] ?? [];
  if (!validNext.includes(targetState)) {
    return false;
  }

  pos.lifecycleState = targetState;
  return true;
}

class PositionLockManager {
  private mintLocks = new Map<string, Promise<unknown>>();
  private inFlightExits = new Map<string, Promise<ExitResult>>();

  /**
   * Executes an exit task for a mint under an exclusive per-mint lock.
   * Immediately registers the in-flight exit promise synchronously so concurrent callers
   * in the same tick receive the existing in-flight promise.
   */
  runExitExclusive(mint: string, task: () => Promise<ExitResult>): Promise<ExitResult> {
    const existingInFlight = this.inFlightExits.get(mint);
    if (existingInFlight) {
      return existingInFlight;
    }

    const existingLock = this.mintLocks.get(mint) ?? Promise.resolve();
    let resolveLock!: () => void;
    const nextLock = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });

    const exitPromise = existingLock.then(async () => {
      try {
        return await task();
      } finally {
        resolveLock();
        if (this.mintLocks.get(mint) === nextLock) {
          this.mintLocks.delete(mint);
        }
        if (this.inFlightExits.get(mint) === exitPromise) {
          this.inFlightExits.delete(mint);
        }
      }
    });

    this.mintLocks.set(
      mint,
      exitPromise.then(
        () => nextLock,
        () => nextLock
      )
    );
    this.inFlightExits.set(mint, exitPromise);

    return exitPromise;
  }

  async runExclusive<T>(mint: string, task: () => Promise<T>): Promise<T> {
    const existingLock = this.mintLocks.get(mint) ?? Promise.resolve();
    let resolveLock!: () => void;
    const nextLock = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });

    this.mintLocks.set(
      mint,
      existingLock.then(
        () => nextLock,
        () => nextLock
      )
    );

    try {
      await existingLock;
      return await task();
    } finally {
      resolveLock();
      if (this.mintLocks.get(mint) === nextLock) {
        this.mintLocks.delete(mint);
      }
    }
  }

  registerExitPromise(mint: string, promise: Promise<ExitResult>): void {
    this.inFlightExits.set(mint, promise);
    promise.finally(() => {
      if (this.inFlightExits.get(mint) === promise) {
        this.inFlightExits.delete(mint);
      }
    });
  }

  getExitPromise(mint: string): Promise<ExitResult> | undefined {
    return this.inFlightExits.get(mint);
  }

  isExitInFlight(mint: string): boolean {
    return this.inFlightExits.has(mint);
  }
}

export const positionLockManager = new PositionLockManager();

export function isOrphanPosition(pos: Position): boolean {
  const hasLamports =
    pos.initialBuyAmountLamports != null && String(pos.initialBuyAmountLamports).length > 0;
  const hasSol = Number(pos.remainingCostSol ?? 0) > 0;
  const hasEntrySol = Number(pos.entryPriceSol ?? 0) > 0;
  // ponytail: also checks initialBuyAmountSol — covers ghost synthetic edge where lamports dropped but Sol string remains
  const hasInitialSol = pos.initialBuyAmountSol != null && Number(pos.initialBuyAmountSol) > 0;
  return !hasLamports && !hasSol && !hasEntrySol && !hasInitialSol;
}

export function markOrphanIfNeeded(pos: Position): boolean {
  const orphan = isOrphanPosition(pos);
  if (orphan) pos.orphan = true;
  return orphan;
}

export async function ensureFlushed(ctx: Context): Promise<void> {
  try {
    await Promise.race([
      ctx.store.flush({ force: true }),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
  } catch {}
}

export function isFullExit(sellRaw: bigint, balRaw: bigint): boolean {
  return balRaw <= 0n || sellRaw >= balRaw;
}

/**
 * Structured forensic logger for position lifecycle events.
 */
export function logPositionEvent(
  ctx: Context,
  eventName: string,
  pos: Partial<Position> & { mint: string },
  details: Record<string, unknown> = {}
): void {
  const now = Date.now();
  const openedAt = pos.openedAt ? new Date(pos.openedAt).getTime() : now;
  const ageMs = now - openedAt;

  const payload = {
    event: eventName,
    mint: pos.mint,
    symbol: pos.symbol ?? 'UNKNOWN',
    lifecycleState: pos.lifecycleState ?? 'OPEN',
    timestamp: now,
    entryPriceUsd: pos.entryPriceUsd ?? 0,
    currentPriceUsd: pos.lastKnownPriceUsd ?? pos.entryPriceUsd ?? 0,
    priceSource: pos.lastKnownPriceSource ?? 'unknown',
    priceAgeMs: pos.lastKnownPriceTimestamp ? now - pos.lastKnownPriceTimestamp : null,
    lastKnownBalanceRaw: pos.lastKnownBalanceRaw ?? pos.initialTokenAmountRaw ?? '0',
    remainingCostUsd: pos.remainingCostUsd ?? pos.entryUsdValue ?? 0,
    remainingCostSol: pos.remainingCostSol ?? 0,
    realizedPnlUsd: pos.realizedPnlUsd ?? 0,
    ageMs,
    ...details,
  };

  ctx.logger(`[${eventName}] ${JSON.stringify(payload)}`, 'debug');
}
