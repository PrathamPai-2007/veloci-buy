import { Context, TokenMetadata } from '#types/index.js';
import { scanForCandidates } from './scan-executor.js';
import { registerPumpMintPda } from '../../core/bot-internals/geyser-coordinator.js';

export class ScanCoordinatorService {
  private isScanning = false;
  private pendingScanScheduled = false;
  private readonly pendingDiscoveryItems = new Map<string, TokenMetadata>();

  public scanStarted = 0;
  public scanCompleted = 0;
  public scanSkippedBusy = 0;
  public scanCoalesced = 0;

  public get scanQueueDepth(): number {
    return this.pendingDiscoveryItems.size;
  }

  public get isScanActive(): boolean {
    return this.isScanning;
  }

  public resetMetrics(): void {
    this.scanStarted = 0;
    this.scanCompleted = 0;
    this.scanSkippedBusy = 0;
    this.scanCoalesced = 0;
    this.pendingDiscoveryItems.clear();
    this.isScanning = false;
    this.pendingScanScheduled = false;
  }

  /**
   * Coalescing entry point for scan triggers.
   * If a scan is currently running, merges mints into pending scan queue without launching concurrent scan execution.
   */
  public async requestScan(
    ctx: Context,
    discoveryItems?: TokenMetadata[],
    reason = 'scheduled'
  ): Promise<void> {
    const pdaRegistrations: Promise<unknown>[] = [];
    if (discoveryItems && discoveryItems.length > 0) {
      for (const item of discoveryItems) {
        if (item.id && !ctx.state.processedMints.has(item.id)) {
          this.pendingDiscoveryItems.set(item.id, item);
          if (item.launchpad === 'pump.fun' || item.id.toLowerCase().endsWith('pump')) {
            pdaRegistrations.push(registerPumpMintPda(ctx, item.id));
          }
        }
      }
    }

    // Register curve mappings before evaluation starts so a Geyser update that raced discovery
    // is flushed before a candidate can reach the buy boundary.
    await Promise.all(pdaRegistrations);

    if (this.isScanning) {
      this.scanCoalesced++;
      this.scanSkippedBusy++;
      this.pendingScanScheduled = true;
      ctx.logger(
        `[ScanCoordinator] Coalesced scan trigger (reason: ${reason}, queueDepth: ${this.pendingDiscoveryItems.size})`,
        'debug'
      );
      return;
    }

    await this.executeScan(ctx, reason);
  }

  private async executeScan(ctx: Context, reason: string): Promise<void> {
    this.isScanning = true;
    this.scanStarted++;
    ctx.store?.incrementMetric('scanStarted', 1);
    ctx.logger(`[ScanCoordinator] Executing candidate scan wave (reason: ${reason})`, 'debug');

    const itemsToScan = Array.from(this.pendingDiscoveryItems.values());
    this.pendingDiscoveryItems.clear();

    try {
      await scanForCandidates(ctx, itemsToScan.length > 0 ? itemsToScan : undefined);
    } finally {
      this.scanCompleted++;
      ctx.store?.incrementMetric('scanCompleted', 1);
      this.isScanning = false;

      if (this.pendingScanScheduled || this.pendingDiscoveryItems.size > 0) {
        this.pendingScanScheduled = false;
        void this.executeScan(ctx, 'coalesced-pending');
      }
    }
  }
}

export const scanCoordinator = new ScanCoordinatorService();
