import * as monitor from './monitor/monitor.service.js';
import { fetchPricesBestEffort } from './market-data.js';
import { Context } from '../types/index.js';

/**
 * Periodically monitors open positions for exit conditions.
 */
export async function monitorPositions(ctx: Context): Promise<void> {
  return monitor.monitorPositions(ctx, (c, m, label, key) =>
    fetchPricesBestEffort(c, m, label, key || undefined)
  );
}

/**
 * Closes all currently open positions.
 */
export async function closeAllOpenPositions(ctx: Context): Promise<void> {
  return monitor.closeAllOpenPositions(
    ctx,
    (c: Context, m: string[], label: string, key?: string) =>
      fetchPricesBestEffort(c, m, label, key)
  );
}
/**
 * Merges two loop requests, combining reasons and signal counts.
 */
export function mergeLoopRequest(
  current: Record<string, unknown> | null,
  next: Record<string, unknown>
): Record<string, unknown> {
  if (!current) return { ...next };
  return {
    ...current,
    ...next,
    forceDiscovery: Boolean(current.forceDiscovery || next.forceDiscovery),
    skipMonitor: Boolean(current.skipMonitor || next.skipMonitor),
    websocketSignalCount:
      Number(current.websocketSignalCount || 0) + Number(next.websocketSignalCount || 0),
    reason:
      [current.reason as string, next.reason as string].filter(Boolean).join('+') ||
      (next.reason as string) ||
      (current.reason as string),
  };
}
