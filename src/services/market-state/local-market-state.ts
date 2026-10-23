import { EventEmitter } from 'node:events';
import {
  LocalMarketSnapshot,
  MarketStateStatus,
  MarketPriceDetails,
} from './market-state.types.js';

export class LocalMarketStateStore extends EventEmitter {
  private readonly snapshots = new Map<string, LocalMarketSnapshot>();

  /**
   * Updates or registers a token snapshot in local market state.
   * Enforces slot monotonicity: rejects older slots, updates deterministically on equal slots.
   * Prevents zero-value updates from overwriting valid non-zero prices/liquidities.
   * Returns true if snapshot was accepted, false if rejected due to stale slot/timestamp.
   */
  updateSnapshot(snapshot: LocalMarketSnapshot): boolean {
    const existing = this.snapshots.get(snapshot.mint);

    if (existing) {
      // Slot monotonicity check: if both slots are non-zero, reject older slots
      if (existing.sourceSlot > 0 && snapshot.sourceSlot > 0) {
        if (snapshot.sourceSlot < existing.sourceSlot) {
          return false; // Stale slot update rejected
        }
        if (
          snapshot.sourceSlot === existing.sourceSlot &&
          snapshot.updatedAt < existing.updatedAt
        ) {
          return false; // Equal slot with older timestamp rejected
        }
      } else if (snapshot.updatedAt < existing.updatedAt && existing.status === 'authoritative') {
        return false; // Stale timestamp update rejected for authoritative snapshot
      }

      // Zero-value overwrite protection: do not overwrite existing non-zero values with 0 or NaN
      const effectivePriceUsd =
        snapshot.priceUsd > 0 && !Number.isNaN(snapshot.priceUsd)
          ? snapshot.priceUsd
          : existing.priceUsd;
      const effectiveLiquidityUsd =
        snapshot.liquidityUsd > 0 && !Number.isNaN(snapshot.liquidityUsd)
          ? snapshot.liquidityUsd
          : existing.liquidityUsd;
      const effectiveFdvUsd =
        snapshot.fdvUsd > 0 && !Number.isNaN(snapshot.fdvUsd) ? snapshot.fdvUsd : existing.fdvUsd;

      // Status transition: upgrade from provisional to authoritative when valid non-seed data arrives
      const isProvisionalInput =
        snapshot.status === 'provisional' || snapshot.source === 'initial-discovery-seed';
      const hasAuthoritativePrice = snapshot.priceUsd > 0 && !Number.isNaN(snapshot.priceUsd);
      const nextStatus: 'provisional' | 'authoritative' = isProvisionalInput
        ? 'provisional'
        : hasAuthoritativePrice
          ? 'authoritative'
          : (existing.status ?? 'provisional');

      const updatedSnapshot: LocalMarketSnapshot = {
        ...existing,
        ...snapshot,
        priceUsd: effectivePriceUsd,
        liquidityUsd: effectiveLiquidityUsd,
        fdvUsd: effectiveFdvUsd,
        status: nextStatus,
      };

      if (Math.abs(existing.liquidityUsd - updatedSnapshot.liquidityUsd) > 0.01) {
        this.emit(
          'liquidityChanged',
          updatedSnapshot.mint,
          existing.liquidityUsd,
          updatedSnapshot.liquidityUsd
        );
      }
      if (Math.abs(existing.top5ConcentrationPct - updatedSnapshot.top5ConcentrationPct) > 0.1) {
        this.emit('holderDrift', updatedSnapshot.mint, updatedSnapshot.top5ConcentrationPct);
      }

      this.snapshots.set(updatedSnapshot.mint, updatedSnapshot);
      this.emit('priceUpdated', updatedSnapshot);
      return true;
    }

    const newSnapshot: LocalMarketSnapshot = {
      ...snapshot,
      status:
        snapshot.status === 'provisional' || snapshot.source === 'initial-discovery-seed'
          ? 'provisional'
          : snapshot.priceUsd > 0 && !Number.isNaN(snapshot.priceUsd)
            ? 'authoritative'
            : 'provisional',
    };
    this.snapshots.set(newSnapshot.mint, newSnapshot);
    this.emit('priceUpdated', newSnapshot);
    return true;
  }

  getSnapshot(mint: string): LocalMarketSnapshot | null {
    return this.snapshots.get(mint) ?? null;
  }

  isAuthoritative(mint: string): boolean {
    const snap = this.snapshots.get(mint);
    return snap ? snap.status === 'authoritative' : false;
  }

  isProvisional(mint: string): boolean {
    const snap = this.snapshots.get(mint);
    return snap ? snap.status === 'provisional' : false;
  }

  getStateStatus(mint: string): MarketStateStatus {
    const snap = this.snapshots.get(mint);
    if (!snap) return 'MISSING';
    if (snap.status === 'provisional') return 'PROVISIONAL';
    if (snap.status === 'authoritative') return 'AUTHORITATIVE';
    return 'AVAILABLE';
  }

  getMarketPriceDetails(mint: string, maxAgeMs = 10_000): MarketPriceDetails {
    const snap = this.snapshots.get(mint);
    if (!snap) {
      return {
        priceUsd: null,
        status: 'MISSING',
        source: undefined,
        observedAt: 0,
        ageMs: Infinity,
        sourceSlot: 0,
        isFresh: false,
      };
    }

    const now = Date.now();
    const observedAt = snap.updatedAt || 0;
    const ageMs = observedAt > 0 ? Math.max(0, now - observedAt) : Infinity;
    const status: MarketStateStatus =
      snap.status === 'provisional'
        ? 'PROVISIONAL'
        : snap.status === 'authoritative'
          ? 'AUTHORITATIVE'
          : 'AVAILABLE';

    const isAuthoritative = status === 'AUTHORITATIVE';
    const isFresh = isAuthoritative && snap.priceUsd > 0 && ageMs <= maxAgeMs;

    return {
      priceUsd: snap.priceUsd > 0 ? snap.priceUsd : null,
      status,
      source: snap.source,
      observedAt,
      ageMs,
      sourceSlot: snap.sourceSlot,
      isFresh,
    };
  }

  /**
   * Immediately registers default initial Pump.fun bonding curve market snapshot upon discovery
   * so cheap candidate evaluation never fails on missing price/liquidity.
   * Marked status = 'provisional' so trading execution decisions require authoritative on-chain state.
   */
  seedInitialPumpFunSnapshot(mint: string, solUsdPrice = 200): void {
    if (this.snapshots.has(mint)) return;

    const initialPriceUsd = (30 / 1_073_000_000) * solUsdPrice;
    const initialLiquidityUsd = 30 * solUsdPrice;
    const initialFdvUsd = initialPriceUsd * 1_000_000_000;

    this.updateSnapshot({
      mint,
      venue: 'pumpfun',
      priceUsd: initialPriceUsd,
      liquidityUsd: initialLiquidityUsd,
      fdvUsd: initialFdvUsd,
      totalSupply: 1_000_000_000_000_000n,
      updatedAt: Date.now(),
      sourceSlot: 0,
      source: 'initial-discovery-seed',
      status: 'provisional',
      buyVolume1m: 0,
      sellVolume1m: 0,
      tradeCount1m: 0,
      top5ConcentrationPct: 0,
      top10ConcentrationPct: 0,
      holderCount: 1,
    });
  }

  getPrice(mint: string): number | null {
    const snap = this.snapshots.get(mint);
    return snap && snap.priceUsd > 0 ? snap.priceUsd : null;
  }

  getLiquidity(mint: string): number | null {
    const snap = this.snapshots.get(mint);
    return snap ? snap.liquidityUsd : null;
  }

  getFDV(mint: string): number | null {
    const snap = this.snapshots.get(mint);
    return snap ? snap.fdvUsd : null;
  }

  getAllSnapshots(): LocalMarketSnapshot[] {
    return Array.from(this.snapshots.values());
  }

  clear(): void {
    this.snapshots.clear();
  }
}

export const localMarketState = new LocalMarketStateStore();
