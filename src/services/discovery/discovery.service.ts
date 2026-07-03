import { address, Address } from '@solana/addresses';
import { sleep, rpcCall, PRIORITY, runBoundedPool } from '#core/utils.js';
import {
  PUMP_FUN_PROGRAM_ID,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  METEORA_DLMM_PROGRAM_ID,
  INITIALIZE_MINT_LOG_PATTERN,
  PUMP_FUN_CREATE_LOG_PATTERN,
  PUMP_FUN_MINT_LOG_PATTERN,
  PUMP_FUN_MINT_JSON_PATTERN,
  PUMP_FUN_CREATE_EVENT_DISCRIMINATOR,
  RAYDIUM_INIT_LOG_PATTERN,
  METEORA_INIT_LOG_PATTERN,
  DISCOVERY_SIGNAL_RETENTION_MS,
} from '#core/config.js';
import { Context, TransactionData, ParsedInstruction } from '#types/index.js';
import { WebSocket } from 'ws';
import bs58 from 'bs58';

/**
 * Extracts the new mint from a pump.fun `CreateEvent` carried on a `Program data:` log line. The
 * redeployed program no longer prints a human-readable `mint:` line, so this decodes the borsh event
 * inline to keep the WS fast-path (avoids the extra getTransaction the signature fallback needs).
 * Layout after the 8-byte discriminator: borsh string name, symbol, uri (each u32-LE length + bytes),
 * then the 32-byte mint pubkey. Returns null if the line isn't a CreateEvent or is malformed.
 */
function decodePumpCreateEventMint(line: string): string | null {
  if (!line.startsWith('Program data:')) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(line.slice('Program data:'.length).trim(), 'base64');
  } catch {
    return null;
  }
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PUMP_FUN_CREATE_EVENT_DISCRIMINATOR))
    return null;
  let pos = 8;
  for (let i = 0; i < 3; i++) {
    if (pos + 4 > buf.length) return null;
    const len = buf.readUInt32LE(pos);
    pos += 4 + len;
  }
  if (pos + 32 > buf.length) return null;
  return bs58.encode(buf.subarray(pos, pos + 32));
}

/**
 * DiscoveryService manages WebSocket subscriptions to program logs
 * to identify new token mints across multiple Solana programs.
 */
export class DiscoveryService {
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingSignatures: Map<
    string,
    { programId: string; slot: number; timestamp: number; attempts?: number }
  > = new Map();
  private pendingMints: Map<string, string> = new Map(); // mint -> programId
  private recentSignalMints: Map<string, number> = new Map();
  private subscriptionControllers: Map<string, AbortController> = new Map();
  private globalSubscriptionController: AbortController | null = null;
  private lastEventAt: Map<string, number> = new Map();
  private lastGlobalEventAt: number = Date.now();
  private watchdogTimer: NodeJS.Timeout | null = null;
  private restartingPrograms: Set<string> = new Set();
  private heliusWs: WebSocket | null = null;
  private heliusReconnectTimer: NodeJS.Timeout | null = null;
  private heliusBackoff = 1000;
  private isFlushing = false;
  private wsConsecutiveFailures = 0;

  public websocketReady = false;

  /**
   * Initializes the discovery service and starts log subscriptions.
   * @param ctx - The application context.
   * @param scheduleDiscoverySignalFlush - Callback to trigger signal processing.
   */
  public async start(ctx: Context, scheduleDiscoverySignalFlush: () => void): Promise<void> {
    const programs = [];
    if (ctx.config.discoveryPumpEnabled) programs.push(PUMP_FUN_PROGRAM_ID);
    if (ctx.config.discoveryRaydiumEnabled) programs.push(RAYDIUM_AMM_V4_PROGRAM_ID);
    if (ctx.config.discoveryMeteoraEnabled) programs.push(METEORA_DLMM_PROGRAM_ID);

    void this.subscribeGlobalHeartbeat(ctx);

    for (const pid of programs) {
      void this.subscribe(ctx, pid, scheduleDiscoverySignalFlush);
    }

    if (ctx.config.heliusApiKey) {
      void this.startHeliusSubscription(ctx, scheduleDiscoverySignalFlush);
    }

    this.startWatchdog(ctx, scheduleDiscoverySignalFlush);
  }

  /**
   * Stops all active subscriptions and timers.
   */
  public stop(): void {
    for (const controller of this.subscriptionControllers.values()) {
      controller.abort();
    }
    this.subscriptionControllers.clear();
    this.globalSubscriptionController?.abort();
    this.globalSubscriptionController = null;
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);

    if (this.heliusWs) {
      try {
        this.heliusWs.close();
      } catch {}
      this.heliusWs = null;
    }
    if (this.heliusReconnectTimer) {
      clearTimeout(this.heliusReconnectTimer);
      this.heliusReconnectTimer = null;
    }
  }

  /**
   * Schedules a flush of discovery signals with debouncing.
   */
  public scheduleFlush(
    ctx: Context,
    runLoop: (req: Record<string, unknown>) => Promise<void>
  ): void {
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flush(ctx, runLoop);
    }, ctx.config.discoveryWsDebounceMs || 100);
  }

  /**
   * Starts a watchdog timer to monitor subscription health.
   */
  private startWatchdog(ctx: Context, scheduleDiscoverySignalFlush: () => void): void {
    const interval = ctx.config.websocketWatchdogIntervalMs || 10000;

    this.watchdogTimer = setInterval(() => {
      const now = Date.now();
      // Read thresholds inside the callback so a config reload takes effect and
      // so we never capture a NaN if the value was absent at construction time.
      const programStaleThreshold = ctx.config.websocketStaleThresholdMs || 30_000;
      // Global heartbeat uses 2× the per-program threshold: individual programs
      // should get a chance to reconnect before we rotate the full RPC pool.
      const globalStaleThreshold = programStaleThreshold * 2;

      // 1. Check global heartbeat
      if (now - this.lastGlobalEventAt > globalStaleThreshold) {
        ctx.logger(
          `Global WebSocket heartbeat stale (${((now - this.lastGlobalEventAt) / 1000).toFixed(1)}s). Rotating RPC...`,
          'warn',
          { console: true }
        );
        ctx.rotateRpcSubscriptions();
        void this.restartAllSubscriptions(ctx, scheduleDiscoverySignalFlush);
        return;
      }

      // 2. Check individual programs
      for (const [pid, lastSeen] of this.lastEventAt.entries()) {
        if (now - lastSeen > programStaleThreshold && !this.restartingPrograms.has(pid)) {
          ctx.logger(
            `WebSocket subscription for ${pid} stale (${((now - lastSeen) / 1000).toFixed(1)}s). Restarting...`,
            'warn',
            { console: true }
          );
          this.restartingPrograms.add(pid);
          void this.subscribe(ctx, pid, scheduleDiscoverySignalFlush).finally(() => {
            this.restartingPrograms.delete(pid);
          });
        }
      }
    }, interval);
  }

  /**
   * Subscribes to global slot notifications to serve as a connection heartbeat.
   */
  private async subscribeGlobalHeartbeat(ctx: Context): Promise<void> {
    this.globalSubscriptionController?.abort();
    const controller = new AbortController();
    this.globalSubscriptionController = controller;
    this.lastGlobalEventAt = Date.now();

    try {
      const rpcSub = ctx.getCurrentRpcSubscriptions();
      const subscribePromise = rpcSub
        .slotNotifications()
        .subscribe({ abortSignal: controller.signal });

      let timeoutId: NodeJS.Timeout | null = null;
      const notifications = await Promise.race([
        subscribePromise,
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            controller.abort();
            reject(new Error('Global heartbeat handshake timeout'));
          }, ctx.config.websocketHandshakeTimeoutMs || 15000);
          controller.signal.addEventListener('abort', () => {
            if (timeoutId) clearTimeout(timeoutId);
          });
        }),
      ]);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      for await (const _notification of notifications) {
        if (controller.signal.aborted) break;
        this.lastGlobalEventAt = Date.now();
      }
      if (!controller.signal.aborted) {
        throw new Error('Global heartbeat subscription ended unexpectedly');
      }
    } catch (error: unknown) {
      if (this.globalSubscriptionController === controller) {
        ctx.logger(
          `Global WebSocket heartbeat failed: ${error instanceof Error ? error.message : String(error)}. Retrying in 5s...`,
          'warn'
        );
        await sleep(5000);
        if (this.globalSubscriptionController === controller) {
          return this.subscribeGlobalHeartbeat(ctx);
        }
      }
    }
  }

  /**
   * Restarts all active program subscriptions and the global heartbeat.
   */
  private async restartAllSubscriptions(
    ctx: Context,
    scheduleDiscoverySignalFlush: () => void
  ): Promise<void> {
    const programs = [];
    if (ctx.config.discoveryPumpEnabled) programs.push(PUMP_FUN_PROGRAM_ID);
    if (ctx.config.discoveryRaydiumEnabled) programs.push(RAYDIUM_AMM_V4_PROGRAM_ID);
    if (ctx.config.discoveryMeteoraEnabled) programs.push(METEORA_DLMM_PROGRAM_ID);

    void this.subscribeGlobalHeartbeat(ctx);
    for (const pid of programs) {
      void this.subscribe(ctx, pid, scheduleDiscoverySignalFlush);
    }
  }

  /**
   * Subscribes to program logs for a specific program ID.
   */
  public async subscribe(
    ctx: Context,
    programId: string,
    scheduleDiscoverySignalFlush: () => void
  ): Promise<void> {
    // Abort existing subscription if any
    this.subscriptionControllers.get(programId)?.abort();

    const controller = new AbortController();
    this.subscriptionControllers.set(programId, controller);
    this.lastEventAt.set(programId, Date.now());

    try {
      const rpcSub = ctx.getCurrentRpcSubscriptions();
      const subscribePromise = rpcSub
        .logsNotifications(
          { mentions: [address(programId)] as [Address] },
          { commitment: 'processed' }
        )
        .subscribe({ abortSignal: controller.signal });

      let timeoutId: NodeJS.Timeout | null = null;
      const notifications = await Promise.race([
        subscribePromise,
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            controller.abort();
            reject(new Error('Subscription handshake timeout'));
          }, ctx.config.websocketHandshakeTimeoutMs || 15000);
          controller.signal.addEventListener('abort', () => {
            if (timeoutId) clearTimeout(timeoutId);
          });
        }),
      ]);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      this.websocketReady = true;
      this.wsConsecutiveFailures = 0;
      ctx.logger(`WebSocket logs subscription active for ${programId}`, 'info', {
        console: true,
      });

      for await (const notification of notifications) {
        if (controller.signal.aborted) break;
        const val = notification?.value || notification;
        const slot = Number(notification?.context?.slot || 0);
        this.handleLog(ctx, val, programId, slot, scheduleDiscoverySignalFlush);
      }
      if (!controller.signal.aborted) {
        throw new Error('Program logs subscription ended unexpectedly');
      }
    } catch (error: unknown) {
      this.websocketReady = false;
      if (this.subscriptionControllers.get(programId) === controller) {
        this.wsConsecutiveFailures++;
        if (this.wsConsecutiveFailures >= 3) {
          ctx.logger(`WebSocket failures exceeded threshold. Rotating RPC...`, 'warn', {
            console: true,
          });
          this.wsConsecutiveFailures = 0;
          ctx.rotateRpcSubscriptions();
          return this.restartAllSubscriptions(ctx, scheduleDiscoverySignalFlush);
        }
        ctx.logger(
          `WebSocket logs subscription failed for ${programId}: ${error instanceof Error ? error.message : String(error)}. Retrying in 5s...`,
          'warn',
          { console: true }
        );
        await sleep(5000);
        if (this.subscriptionControllers.get(programId) === controller) {
          return this.subscribe(ctx, programId, scheduleDiscoverySignalFlush);
        }
      }
    }
  }

  /**
   * Processes a single log notification.
   */
  public handleLog(
    ctx: Context,
    logInfo: unknown,
    programId: string,
    slot: number,
    scheduleDiscoverySignalFlush: () => void
  ): void {
    this.lastEventAt.set(programId, Date.now());
    if (!ctx.config.discoveryWsEnabled) return;

    const info = logInfo as { signature: string; logs: string[] };
    if (!info?.signature || !Array.isArray(info.logs)) return;

    let match = false;
    let extractedMint: string | null = null;

    if (programId === PUMP_FUN_PROGRAM_ID) {
      for (const line of info.logs) {
        if (PUMP_FUN_CREATE_LOG_PATTERN.test(line)) match = true;
        // Redeployed program: mint rides in the borsh CreateEvent on a `Program data:` line.
        const eventMint = decodePumpCreateEventMint(line);
        if (eventMint) {
          extractedMint = eventMint;
          break;
        }
        // Legacy formats (older program / other launchers): human-readable or JSON mint line.
        const mintMatch = line.match(PUMP_FUN_MINT_LOG_PATTERN);
        if (mintMatch && mintMatch[1]) {
          extractedMint = mintMatch[1];
          break;
        }
        if (!extractedMint) {
          const jsonMatch = line.match(PUMP_FUN_MINT_JSON_PATTERN);
          if (jsonMatch?.[1]) {
            extractedMint = jsonMatch[1];
            break;
          }
        }
      }
    } else if (programId === RAYDIUM_AMM_V4_PROGRAM_ID) {
      match = info.logs.some((line: string) => RAYDIUM_INIT_LOG_PATTERN.test(line));
    } else if (programId === METEORA_DLMM_PROGRAM_ID) {
      match = info.logs.some((line: string) => METEORA_INIT_LOG_PATTERN.test(line));
    } else {
      match = info.logs.some((line: string) => INITIALIZE_MINT_LOG_PATTERN.test(line));
    }

    if (extractedMint) {
      this.pendingMints.set(extractedMint, programId);
      scheduleDiscoverySignalFlush();
    } else if (match) {
      this.pendingSignatures.set(info.signature, { programId, slot, timestamp: Date.now() });
      scheduleDiscoverySignalFlush();
    }
  }

  /**
   * Flushes pending signals, fetches transaction details if needed, and triggers the run loop.
   */
  public async flush(
    ctx: Context,
    runLoop: (req: Record<string, unknown>) => Promise<void>
  ): Promise<void> {
    if (this.isFlushing) return;
    this.isFlushing = true;

    try {
      const allSignatureEntries = Array.from(this.pendingSignatures.entries());
      this.pendingSignatures.clear();

      const now = Date.now();
      // Geyser only tracks account state, not mint creation events — process all signatures.
      const signatureEntries: Array<[string, string]> = allSignatureEntries.map(([sig, info]) => [
        sig,
        info.programId,
      ]);

      const mintEntries = Array.from(this.pendingMints.entries());
      this.pendingMints.clear();

      if (signatureEntries.length === 0 && mintEntries.length === 0) return;

      this.cleanupRecentSignals(now);

      const pendingMints: string[] = [];
      const mintLaunchpads = new Map<string, string>();

      const addPendingMint = (mint: string, programId: string): boolean => {
        if (ctx.state.processedMints.has(mint)) return false;
        const lastSeen = this.recentSignalMints.get(mint) || 0;
        if (now - lastSeen < DISCOVERY_SIGNAL_RETENTION_MS) return false;

        this.recentSignalMints.set(mint, now);
        pendingMints.push(mint);

        const launchpad = this.getLaunchpadName(programId);
        if (launchpad) mintLaunchpads.set(mint, launchpad);
        return true;
      };

      // 1. Process direct mints
      for (const [mint, programId] of mintEntries) {
        addPendingMint(mint, programId);
      }

      // 2. Process signatures (fallback)
      if (signatureEntries.length > 0) {
        const results = await runBoundedPool(
          signatureEntries,
          async ([sig, programId]) => {
            try {
              const tx = await rpcCall(
                ctx,
                'getTransaction',
                [
                  sig as any,
                  {
                    commitment: 'processed',
                    encoding: 'jsonParsed' as any,
                    maxSupportedTransactionVersion: 0,
                  },
                ],
                { priority: PRIORITY.HIGH }
              );
              return { tx: tx as unknown as TransactionData, programId, sig, success: true };
            } catch {
              return { tx: null, programId, sig, success: false };
            }
          },
          { concurrency: 5 }
        );

        for (const res of results) {
          if (res.status === 'fulfilled') {
            const item = res.value as {
              tx: TransactionData | null;
              programId: string;
              sig: string;
              success: boolean;
            };
            if (!item.success) {
              const oldInfo = allSignatureEntries.find((e) => e[0] === item.sig)?.[1];
              const attempts = oldInfo?.attempts || 0;
              if (attempts < 2) {
                this.pendingSignatures.set(item.sig, {
                  programId: item.programId,
                  slot: oldInfo?.slot || 0,
                  timestamp: oldInfo?.timestamp || Date.now(),
                  attempts: attempts + 1,
                });
              }
              continue;
            }
            if (!item.tx) continue;
            const mints = this.extractInitializedMints(item.tx);
            for (const mint of mints) {
              addPendingMint(mint, item.programId);
            }
          }
        }
      }

      if (pendingMints.length > 0) {
        await runLoop({
          reason: 'ws-mint-init',
          forceDiscovery: true,
          skipMonitor: true,
          websocketSignalCount: pendingMints.length,
          mints: pendingMints,
          mintLaunchpads: Object.fromEntries(mintLaunchpads),
        });
      }
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Cleans up the recent signals map to prevent memory growth.
   */
  private cleanupRecentSignals(now: number): void {
    if (this.recentSignalMints.size > 2000) {
      for (const [mint, lastSeen] of this.recentSignalMints.entries()) {
        if (now - lastSeen > DISCOVERY_SIGNAL_RETENTION_MS * 2) {
          this.recentSignalMints.delete(mint);
        }
      }
    }
  }

  /**
   * Maps a program ID to a friendly launchpad name.
   */
  private getLaunchpadName(programId: string): string | null {
    switch (programId) {
      case PUMP_FUN_PROGRAM_ID:
        return 'pump.fun';
      case RAYDIUM_AMM_V4_PROGRAM_ID:
        return 'raydium';
      case METEORA_DLMM_PROGRAM_ID:
        return 'meteora';
      default:
        return null;
    }
  }

  /**
   * Extracts initialized mint addresses from a parsed transaction.
   */
  private extractInitializedMints(tx: TransactionData): string[] {
    const mints = new Set<string>();
    const collect = (ixs: ParsedInstruction[] | undefined) => {
      if (!Array.isArray(ixs)) return;
      for (const ix of ixs) {
        const parsed = ix?.parsed;
        const type = String(parsed?.type || '').toLowerCase();
        const info = parsed?.info;
        const mint = info?.mint;
        if ((type === 'initializemint' || type === 'initializemint2') && typeof mint === 'string')
          mints.add(mint);
      }
    };
    collect(tx?.transaction?.message?.instructions);
    const meta = tx?.meta;
    (meta?.innerInstructions || []).forEach((g) => collect(g?.instructions));
    return Array.from(mints);
  }

  private startHeliusSubscription(ctx: Context, scheduleDiscoverySignalFlush: () => void): void {
    if (this.heliusReconnectTimer) clearTimeout(this.heliusReconnectTimer);
    if (this.heliusWs) {
      try {
        this.heliusWs.close();
      } catch {}
      this.heliusWs = null;
    }

    const key = ctx.config.heliusApiKey;
    if (!key) return;

    const url = `wss://atlas.helius-rpc.com?api-key=${key}`;
    ctx.logger(`Connecting to Helius Transaction Subscription...`, 'info', { console: true });

    try {
      const ws = new WebSocket(url);
      this.heliusWs = ws;

      const connectTimeout = setTimeout(() => {
        if (ws.readyState !== ws.OPEN) {
          ctx.logger(`Helius WebSocket connection timed out. Reconnecting...`, 'warn');
          ws.close();
        }
      }, ctx.config.websocketHandshakeTimeoutMs || 15_000);

      ws.on('open', () => {
        clearTimeout(connectTimeout);
        this.heliusBackoff = 1000;
        ctx.logger(`Helius Transaction Subscription WebSocket connected.`, 'info', {
          console: true,
        });

        const subRequest = {
          jsonrpc: '2.0',
          id: 1,
          method: 'transactionSubscribe',
          params: [
            {
              failed: false,
              accountInclude: [
                PUMP_FUN_PROGRAM_ID,
                RAYDIUM_AMM_V4_PROGRAM_ID,
                METEORA_DLMM_PROGRAM_ID,
              ],
            },
            {
              commitment: 'processed',
              encoding: 'jsonParsed',
              transactionDetails: 'full',
              maxSupportedTransactionVersion: 0,
            },
          ],
        };
        ws.send(JSON.stringify(subRequest));
      });

      ws.on('message', (data: any) => {
        try {
          const payload = JSON.parse(data.toString());
          if (payload?.method === 'transactionNotification') {
            const txData = payload.params?.result?.transaction;
            const signature = payload.params?.result?.signature;
            const programId = signature ? this.getMatchingProgramId(payload.params.result) : null;
            if (txData && programId) {
              const mints = this.extractInitializedMints(txData);
              for (const mint of mints) {
                this.pendingMints.set(mint, programId);
              }
              if (mints.length > 0) {
                scheduleDiscoverySignalFlush();
              }
            }
          }
        } catch (err) {
          ctx.logger(`Error parsing Helius transaction message: ${err}`, 'debug');
        }
      });

      ws.on('close', () => {
        ctx.logger(`Helius subscription closed. Reconnecting...`, 'warn');
        this.scheduleHeliusReconnect(ctx, scheduleDiscoverySignalFlush);
      });

      ws.on('error', (err: any) => {
        ctx.logger(`Helius subscription error: ${err.message || err}`, 'warn');
      });
    } catch (err) {
      ctx.logger(`Helius connection initiation failed: ${err}`, 'warn');
      this.scheduleHeliusReconnect(ctx, scheduleDiscoverySignalFlush);
    }
  }

  private scheduleHeliusReconnect(ctx: Context, scheduleDiscoverySignalFlush: () => void): void {
    if (this.heliusReconnectTimer) clearTimeout(this.heliusReconnectTimer);
    this.heliusReconnectTimer = setTimeout(() => {
      this.startHeliusSubscription(ctx, scheduleDiscoverySignalFlush);
    }, this.heliusBackoff);
    this.heliusBackoff = Math.min(this.heliusBackoff * 2, 30000);
  }

  private getMatchingProgramId(result: any): string | null {
    const accountKeys = result.transaction?.transaction?.message?.accountKeys || [];
    const keys = accountKeys.map(
      (k: any) => (typeof k === 'string' ? k : String(k?.pubkey || '')) as string
    );
    if (keys.includes(PUMP_FUN_PROGRAM_ID)) return PUMP_FUN_PROGRAM_ID;
    if (keys.includes(RAYDIUM_AMM_V4_PROGRAM_ID)) return RAYDIUM_AMM_V4_PROGRAM_ID;
    if (keys.includes(METEORA_DLMM_PROGRAM_ID)) return METEORA_DLMM_PROGRAM_ID;
    return null;
  }
}

// Export a singleton instance for backward compatibility or shared state
export const discoveryService = new DiscoveryService();

// Re-export functional wrappers to maintain original API if needed
export function handleDiscoveryProgramLog(
  ctx: Context,
  logInfo: unknown,
  programId: string,
  scheduleDiscoverySignalFlush: () => void
): void {
  discoveryService.handleLog(ctx, logInfo, programId, 0, scheduleDiscoverySignalFlush);
}

export async function flushDiscoverySignals(
  ctx: Context,
  runLoop: (req: Record<string, unknown>) => Promise<void>
): Promise<void> {
  return discoveryService.flush(ctx, runLoop);
}

/** @deprecated Use discoveryService.start() / discoveryService.stop() instead.
 *  The returned AbortController is a stub — call discoveryService.stop() to
 *  tear down all subscriptions. */
export async function subscribeToProgramLogs(
  ctx: Context,
  programId: string,
  scheduleDiscoverySignalFlush: () => void
): Promise<AbortController> {
  void discoveryService.subscribe(ctx, programId, scheduleDiscoverySignalFlush);
  return new AbortController();
}
