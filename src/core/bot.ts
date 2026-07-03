import { Rpc, SolanaRpcApi, createSolanaRpc } from '@solana/rpc';
import {
  RpcSubscriptions,
  SolanaRpcSubscriptionsApi,
  createSolanaRpcSubscriptions,
} from '@solana/rpc-subscriptions';
import { KeyPairSigner } from '@solana/signers';
import { address, getProgramDerivedAddress, getAddressEncoder } from '@solana/addresses';

import {
  sleep,
  log,
  atomicToDecimalString,
  setConsoleSuppressed,
  decodePumpCurve,
  decodeRaydiumPool,
  decodeMeteoraPool,
  rpcCall,
  PRIORITY,
} from './utils.js';
import {
  PUMP_FUN_PROGRAM_ID,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  METEORA_DLMM_PROGRAM_ID,
  SOL_MINT,
} from './constants.js';

import { StateStore } from './store.js';

import * as services from '#services/services.js';
import * as discovery from '#services/discovery/discovery.service.js';
import * as scanner from '#services/scanner/scanner.service.js';
import { tradingService } from '#services/trading/trading.service.js';
import { startBlockhashPrewarmer } from '#services/trading/swap-executor.js';
import {
  poolConfigsCache,
  CachedPoolConfig,
  RaydiumPool,
  MeteoraPool,
} from '#services/trading/local-router.js';
import { TuiService } from '#services/tui.service.js';
import { Config, State, Context, TokenMetadata, LogLevel, Position } from '#types/index.js';
import { mlService } from '#ml/ml-service.js';
import { ghostTrader } from '#ml/ghost-trader.js';
import { GeyserClient, geyserOptionsFromEnv } from '#services/ingestion/geyser-client.js';
import {
  refreshSwingWatchlist,
  pollWatchlistPrices,
  evictStaleWatchlistItems,
  evaluateSwingCandidate,
  buySwingCandidate,
  swingTapeManager,
} from '#services/swing/index.js';

export class VelociBuyBot {
  public config: Config;
  public wallet: KeyPairSigner;
  public rpc: Rpc<SolanaRpcApi>;
  public rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  public state: State;
  public store: StateStore;

  public rpcs: Rpc<SolanaRpcApi>[] = [];
  public rpcSubscriptionPool: RpcSubscriptions<SolanaRpcSubscriptionsApi>[] = [];
  public tui: TuiService | null = null;
  private coolDownTimers: Map<string, NodeJS.Timeout> = new Map();

  private shouldStop = false;
  private isShuttingDown = false;
  private monitorTimer: NodeJS.Timeout | null = null;
  private blockhashPrewarmerTimer: ReturnType<typeof setInterval> | null = null;
  private discoveryTimer: NodeJS.Timeout | null = null;
  private trendingTimer: NodeJS.Timeout | null = null;
  private trendingLoopBusy = false;
  private swingTimer: NodeJS.Timeout | null = null;
  private swingLoopBusy = false;
  private fastSwingTimer: NodeJS.Timeout | null = null;
  private fastSwingLoopBusy = false;
  private geyserClient: GeyserClient | null = null;

  private scanBackpressure = {
    events: [] as { error: boolean; at: number }[],
    factor: 1,
  };

  private monitorLoopBusy = false;
  private discoveryLoopBusy = false;
  // Serializes every scanForCandidates call (discovery + trending) so they never overlap.
  private scanChain: Promise<void> = Promise.resolve();
  private readonly raydiumVaultFetchTs = new Map<string, number>();
  private static readonly RAYDIUM_FETCH_DEBOUNCE_MS = 250;
  private readonly raydiumVaultFetchInFlight = new Map<string, Promise<void>>();
  private readonly meteoraVaultFetchTs = new Map<string, number>();
  private static readonly METEORA_FETCH_DEBOUNCE_MS = 250;
  private readonly meteoraVaultFetchInFlight = new Map<string, Promise<void>>();
  // pump.fun curve PDA updates that arrived before curveToMint was populated for that mint.
  // Retried once after 2s so the first Geyser update for a new launch isn't silently dropped.
  private readonly pendingCurvePdas = new Map<string, { data: Buffer; at: number }>();
  // New pool pubkeys seen via Geyser — prevents re-firing discovery for the same pool.
  private readonly geyserSeenPools = new Set<string>();
  // Mints recently pushed to discovery via Geyser — 60s TTL dedup.
  private readonly geyserRecentMints = new Map<string, number>();
  private currentRpcSubIndex = 0;

  /**
   * Initializes the bot instance with required dependencies.
   * @param config - The application configuration.
   * @param wallet - The trading wallet signer.
   * @param store - The state persistence engine.
   * @param tui - Optional terminal UI service.
   */
  constructor(
    config: Config,
    wallet: KeyPairSigner,
    store: StateStore,
    tui: TuiService | null = null
  ) {
    this.config = config;
    this.wallet = wallet;
    this.store = store;
    this.state = store.state;
    this.tui = tui;

    if (!config.rpcUrls?.length) throw new Error('No RPC URLs provided in configuration.');
    if (!config.wsRpcUrls?.length)
      throw new Error('No WebSocket RPC URLs provided in configuration.');

    this.rpcs = config.rpcUrls.map((url) => createSolanaRpc(url) as Rpc<SolanaRpcApi>);
    this.rpcSubscriptionPool = config.wsRpcUrls.map(
      (url) => createSolanaRpcSubscriptions(url) as RpcSubscriptions<SolanaRpcSubscriptionsApi>
    );

    // Default to first healthy-looking endpoint
    this.rpc = this.rpcs[0]!;
    this.rpcSubscriptions = this.rpcSubscriptionPool[0]!;

    this.coolDownTimers = new Map();

    // Listen to coolDownStarted
    this.store.on('coolDownStarted', ({ mint, expiresAt }: { mint: string; expiresAt: number }) => {
      this.scheduleCoolDownExpiry(mint, expiresAt);
    });

    // Listen to coolDownRemoved
    this.store.on('coolDownRemoved', (mint: string) => {
      const timer = this.coolDownTimers.get(mint);
      if (timer) {
        clearTimeout(timer);
        this.coolDownTimers.delete(mint);
      }
    });

    this.state.vaultSubscriptions = new Map();
    this.state.vaultBalanceCache = new Map();
    this.state.ataSubscriptions = new Map();
    this.state.ataBalanceCache = new Map();

    // Listen to positionRemoved to clean up vault push-streams
    this.store.on('positionRemoved', (position: Position) => {
      if (this.state.vaultSubscriptions?.has(position.mint)) {
        this.unsubscribeFromVaultBalances(position.mint);
      }
      if (this.state.ataSubscriptions?.has(position.mint)) {
        const ataCtrl = this.state.ataSubscriptions.get(position.mint);
        if (ataCtrl) ataCtrl.abort();
        this.state.ataSubscriptions.delete(position.mint);
      }
      if (this.state.ataBalanceCache?.has(position.mint)) {
        this.state.ataBalanceCache.delete(position.mint);
      }
    });

    // Schedule timers for existing cooldowns loaded from store
    for (const [mint, entry] of this.state.coolDownMints.entries()) {
      this.scheduleCoolDownExpiry(mint, entry.expiresAt);
    }
  }

  /**
   * Rotates to the next WebSocket RPC in the pool.
   */
  public rotateRpcSubscriptions(): void {
    if (this.rpcSubscriptionPool.length <= 1) return;
    this.currentRpcSubIndex = (this.currentRpcSubIndex + 1) % this.rpcSubscriptionPool.length;
    this.rpcSubscriptions = this.rpcSubscriptionPool[this.currentRpcSubIndex]!;
    this.getCtx().logger(`Rotated WebSocket RPC to index ${this.currentRpcSubIndex}`, 'warn', {
      console: true,
    });
  }

  /**
   * Tracks an RPC error to adjust backpressure factor.
   * Reduces parallelism if error rates exceed thresholds.
   * @param error - The error object or message.
   */
  public recordScanBackpressureEvent(error: unknown): void {
    const windowSize = Math.max(1, Math.floor(this.config.errorRateWindow || 20));
    this.scanBackpressure.events.push({ error: Boolean(error), at: Date.now() });

    while (this.scanBackpressure.events.length > windowSize) {
      this.scanBackpressure.events.shift();
    }

    const errorCount = this.scanBackpressure.events.filter((event) => event.error).length;
    const errorRate = errorCount / this.scanBackpressure.events.length;
    const minFactor = Math.min(1, Math.max(0.1, Number(this.config.parallelismMinFactor || 0.5)));

    this.scanBackpressure.factor =
      errorRate >= Number(this.config.backpressureErrorRateThreshold || 0.3) ? minFactor : 1;
  }

  /**
   * Returns adjusted parallelism count based on current RPC health.
   * @param base - The target parallelism count.
   * @returns The health-adjusted parallelism count.
   */
  public getEffectiveParallelism(base: number): number {
    const numericBase = Math.max(1, Math.floor(Number(base) || 1));
    return Math.max(1, Math.floor(numericBase * this.scanBackpressure.factor));
  }

  /**
   * Generates a unified execution context for all services.
   * @returns The current application context.
   */
  public getCtx(): Context {
    return {
      config: this.config,
      wallet: { address: this.wallet.address, keypair: this.wallet },
      rpc: this.rpc,
      rpcs: this.rpcs,
      rpcSubscriptions: this.rpcSubscriptions,
      rpcSubscriptionPool: this.rpcSubscriptionPool,
      state: this.state,
      store: this.store,
      tui: this.tui || undefined,
      getBackpressureFactor: () => this.scanBackpressure.factor,
      calculateGMI: () => this.store.calculateGMI(),
      rotateRpcSubscriptions: () => this.rotateRpcSubscriptions(),
      getCurrentRpcSubscriptions: () => this.rpcSubscriptions,
      logger: (msg: string, lvl?: LogLevel, opts?: { console?: boolean; sync?: boolean }) => {
        let finalMsg = msg;
        if (lvl === 'trade' && this.config.paperTrading && this.state?.paperSolBalanceLamports) {
          const balText = atomicToDecimalString(this.state.paperSolBalanceLamports, 9, 4);
          if (!msg.includes('[PAPER SOL:')) {
            finalMsg = `${msg} [PAPER SOL: ${balText}]`;
          }
        }
        if (this.tui) {
          this.tui.log(finalMsg, lvl);
          return log(this.config.logFile, finalMsg, lvl, { ...opts, console: false });
        }
        return log(this.config.logFile, finalMsg, lvl, opts);
      },
      persistState: (opts?: { sync?: boolean; force?: boolean }) => this.store.persist(opts),
      recordScanBackpressureEvent: (err) => this.recordScanBackpressureEvent(err),
      getEffectiveParallelism: (base) => this.getEffectiveParallelism(base),
      scanBackpressureFactor: this.scanBackpressure.factor,
      subscribeToVaultBalances: (m, p, t) => this.subscribeToVaultBalances(m, p, t),
      unsubscribeFromVaultBalances: (m) => this.unsubscribeFromVaultBalances(m),
    };
  }

  /**
   * Schedules a precise timer to expire a cooldown.
   */
  private scheduleCoolDownExpiry(mint: string, expiresAt: number): void {
    const existing = this.coolDownTimers.get(mint);
    if (existing) {
      clearTimeout(existing);
      this.coolDownTimers.delete(mint);
    }

    const now = Date.now();
    const delay = Math.max(0, expiresAt - now);

    const timer = setTimeout(() => {
      this.coolDownTimers.delete(mint);
      this.expireCoolDown(mint);
    }, delay);

    this.coolDownTimers.set(mint, timer);
  }

  /**
   * Expires a cooldown for a mint, removing it and retiring it.
   */
  private expireCoolDown(mint: string): void {
    const entry = this.state.coolDownMints.get(mint);
    const lastExitPriceUsd = entry ? entry.lastExitPriceUsd : 0;

    this.store.removeCoolDown(mint);
    this.store.retireMint(mint, {
      lastExitPriceUsd,
      retiredAt: new Date().toISOString(),
    });
    this.store.untrackMint(mint);
    this.getCtx().logger(`Cool-down expired for ${mint}.`, 'info');
  }

  /**
   * Cleans up expired token cool-downs from memory and store.
   */
  private processCoolDowns(): void {
    const now = Date.now();
    for (const [mint, entry] of this.state.coolDownMints.entries()) {
      if (now >= entry.expiresAt) {
        this.expireCoolDown(mint);
      }
    }
  }

  /**
   * Internal callback for debounced discovery signal processing.
   */
  private scheduleDiscoverySignalFlush(): void {
    discovery.discoveryService.scheduleFlush(this.getCtx(), (meta) => this.runDiscoveryLoop(meta));
  }

  /**
   * Main monitoring loop. Scans open positions for exit signals.
   */
  public async runMonitorLoop(): Promise<void> {
    if (this.monitorLoopBusy || this.shouldStop) return;
    this.monitorLoopBusy = true;
    try {
      await services.monitorPositions(this.getCtx());
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.getCtx().logger(`Monitor loop error: ${msg}`, 'error');
    } finally {
      this.monitorLoopBusy = false;
    }
  }

  /**
   * Runs a scan under a shared lock so the discovery and trending loops never scan concurrently.
   * Overlapping scans each read the same un-claimed due-recheck queue (entries aren't removed
   * until `trackMint` runs after a buy), so the same mint could clear final audit and be bought
   * twice. Chaining the scans guarantees the first records its positions before the next reads.
   */
  private runScanExclusive(fn: () => Promise<void>): Promise<void> {
    // Watchdog: a single scan that never settles (unguarded await in the audit/price path) would
    // leave `scanChain` and the loop-busy flags wedged forever, silencing discovery + trending.
    // Race the body against a timeout so a hung scan rejects, the caller's `finally` clears its busy
    // flag, and the chain advances. A prior session saw a legitimate 53s scan recover, so 60s clears
    // a true wedge without false-tripping healthy-slow scans.
    // ponytail: one guard at the chokepoint instead of timing out every await; the orphaned request
    // still hangs until its own RPC timeout, but the loop is no longer blocked by it.
    const guarded = (): Promise<void> => {
      let timer: NodeJS.Timeout;
      const task = Promise.resolve().then(fn);
      // Prevent UnhandledPromiseRejection if fn rejects after the watchdog timeout
      task.catch(() => {});
      return Promise.race([
        task.finally(() => clearTimeout(timer)),
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new Error('scan watchdog: exceeded 60s')), 60_000);
        }),
      ]);
    };
    const result = this.scanChain.then(guarded, guarded);
    // Keep the chain alive (and swallow rejections here so they aren't "unhandled"); the original
    // `result` is returned so the calling loop still sees and logs any error.
    this.scanChain = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  /**
   * Main discovery loop. Scans for new candidates based on signals or polling.
   * @param trigger - The event triggering the discovery run.
   */
  public async runDiscoveryLoop(
    trigger:
      | boolean
      | {
          forceDiscovery?: boolean;
          reason?: string;
          mints?: string[];
          mintLaunchpads?: Record<string, string>;
        } = false
  ): Promise<void> {
    if (this.discoveryLoopBusy || this.shouldStop) return;
    this.discoveryLoopBusy = true;
    try {
      const mood = services.getMoodAdjustments(this.getCtx());
      this.processCoolDowns();

      const isForced = trigger === true || (typeof trigger === 'object' && trigger.forceDiscovery);
      const reason =
        typeof trigger === 'object' ? trigger.reason : trigger === true ? 'manual-force' : 'poll';

      if (!mood.isPaused || isForced) {
        if (isForced) {
          this.getCtx().logger(`Triggering forced discovery scan (reason: ${reason}).`, 'debug');
        }
        const wsMints = typeof trigger === 'object' ? trigger.mints : null;
        const wsLaunchpads = typeof trigger === 'object' ? trigger.mintLaunchpads : null;
        let discoveryItems: TokenMetadata[] | undefined = undefined;
        if (wsMints) {
          const launchpads = wsLaunchpads || {};
          discoveryItems = wsMints.map(
            (mint) =>
              ({
                id: mint,
                symbol: '?',
                name: '?',
                launchpad: launchpads[mint] || 'unknown',
              }) as TokenMetadata
          );
        }
        await this.runScanExclusive(() => scanner.scanForCandidates(this.getCtx(), discoveryItems));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.getCtx().logger(`Discovery loop error: ${msg}`, 'error');
    } finally {
      this.discoveryLoopBusy = false;
    }
  }

  /**
   * Polls Jupiter's top-traded ("trending") feed (pump.fun-filtered) and feeds those coins
   * into the same audit pipeline as discovery. Trending candidates are tagged `isTrending`,
   * so the scanner prioritises them and the engine applies relaxed anti-top guards.
   */
  public async runTrendingLoop(): Promise<void> {
    if (this.trendingLoopBusy || this.shouldStop) return;
    if (!this.config.trendingDiscoveryEnabled) return;
    this.trendingLoopBusy = true;
    try {
      const ctx = this.getCtx();
      const mood = services.getMoodAdjustments(ctx);
      if (mood.isPaused) return;
      const trending = await services.appService.fetchTrendingLaunches(ctx);
      if (trending.length > 0) {
        await this.runScanExclusive(() => scanner.scanForCandidates(ctx, trending));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.getCtx().logger(`Trending loop error: ${msg}`, 'warn');
    } finally {
      this.trendingLoopBusy = false;
    }
  }

  /**
   * Swing bot loop: refreshes watchlist, polls prices, evaluates candidates, and buys.
   * Runs on its own interval (SWING_WATCHLIST_POLL_INTERVAL_MS, default 60s).
   */
  public async runSwingLoop(): Promise<void> {
    if (this.swingLoopBusy || this.shouldStop) return;
    if (!this.config.swingBotEnabled) return;
    this.swingLoopBusy = true;
    try {
      const ctx = this.getCtx();
      const mood = services.getMoodAdjustments(ctx);
      if (mood.isPaused) return;

      await refreshSwingWatchlist(ctx);
      await pollWatchlistPrices(ctx);
      evictStaleWatchlistItems(ctx);

      let openSwing = this.countOpenSwingPositions(ctx);
      if (openSwing >= ctx.config.swingMaxOpenPositions) return;

      // Evaluate watchlist items and buy first approved candidate
      for (const item of ctx.state.swingWatchlist.values()) {
        if (openSwing >= ctx.config.swingMaxOpenPositions) break;
        const evaluation = await evaluateSwingCandidate(ctx, item);
        if (evaluation.approved) {
          const pos = await buySwingCandidate(ctx, evaluation);
          if (pos) openSwing++;
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.getCtx().logger(`Swing loop error: ${msg}`, 'warn');
    } finally {
      this.swingLoopBusy = false;
    }
  }

  /**
   * Fast-poll loop for swing watchlist items in partial-W formation.
   * Runs every 15s when swingBotEnabled; only fetches mints with fastPollUntil set.
   * Evaluates and buys immediately on confirmed signals without waiting for the 60s cycle.
   */
  public async runFastSwingPoll(): Promise<void> {
    if (this.fastSwingLoopBusy || this.swingLoopBusy || this.shouldStop) return;
    if (!this.config.swingBotEnabled) return;
    this.fastSwingLoopBusy = true;
    try {
      const ctx = this.getCtx();
      const mood = services.getMoodAdjustments(ctx);
      if (mood.isPaused) return;

      // Only poll items currently in fast-poll mode
      await pollWatchlistPrices(ctx, true);

      let openSwing = this.countOpenSwingPositions(ctx);
      if (openSwing >= ctx.config.swingMaxOpenPositions) return;

      // Evaluate only fast-poll items
      const now = Date.now();
      for (const item of ctx.state.swingWatchlist.values()) {
        if (!(item.fastPollUntil && now < item.fastPollUntil)) continue;
        if (openSwing >= ctx.config.swingMaxOpenPositions) break;
        const evaluation = await evaluateSwingCandidate(ctx, item);
        if (evaluation.approved) {
          const pos = await buySwingCandidate(ctx, evaluation);
          if (pos) openSwing++;
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.getCtx().logger(`Fast swing poll error: ${msg}`, 'warn');
    } finally {
      this.fastSwingLoopBusy = false;
    }
  }

  /**
   * Subscribes to the token vault accounts for a given active position.
   * On update, decodes the balance and updates the market snapshot instantly.
   */
  public async subscribeToVaultBalances(
    mint: string,
    poolAddress: string,
    type: 'raydium' | 'meteora'
  ): Promise<void> {
    const ctx = this.getCtx();
    this.unsubscribeFromVaultBalances(mint);

    const poolData = poolConfigsCache.get(poolAddress);
    if (!poolData) {
      ctx.logger(`Cannot subscribe to vaults for ${mint}: pool data not in cache.`, 'debug');
      return;
    }

    const vaults: string[] = [];
    if (type === 'raydium') {
      const r = poolData as RaydiumPool;
      vaults.push(r.baseVault, r.quoteVault);
    } else if (type === 'meteora') {
      const m = poolData as MeteoraPool;
      vaults.push(m.reserveX, m.reserveY);
    }

    const abortController = new AbortController();
    if (!ctx.state.vaultSubscriptions) {
      ctx.state.vaultSubscriptions = new Map();
    }
    ctx.state.vaultSubscriptions.set(mint, abortController);

    for (const addr of vaults) {
      if (!addr) continue;
      this.startAccountSubscription(mint, addr, type, poolData, abortController.signal).catch(
        (err) => {
          if (!abortController.signal.aborted) {
            ctx.logger(`Failed vault subscription for ${mint} (${addr}): ${err}`, 'warn');
          }
        }
      );
    }
    ctx.logger(`Subscribed to vault push-stream for ${mint}`, 'debug');

    // Subscribe to User's ATA
    try {
      const tokenProgramId = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
      const ataProgramId = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
      const [ataAddress] = await getProgramDerivedAddress({
        programAddress: ataProgramId,
        seeds: [
          getAddressEncoder().encode(address(this.wallet.address)),
          getAddressEncoder().encode(tokenProgramId),
          getAddressEncoder().encode(address(mint)),
        ],
      });
      const ataAbort = new AbortController();
      ctx.state.ataSubscriptions?.set(mint, ataAbort);
      this.startAtaSubscription(mint, ataAddress, ataAbort.signal).catch((err) => {
        if (!ataAbort.signal.aborted) {
          ctx.logger(`Failed ATA subscription for ${mint}: ${err}`, 'warn');
        }
      });
    } catch (e: unknown) {
      ctx.logger(`Failed to derive ATA for ${mint}: ${e}`, 'warn');
    }
  }

  public unsubscribeFromVaultBalances(mint: string): void {
    const ctx = this.getCtx();
    if (ctx.state.vaultSubscriptions) {
      const controller = ctx.state.vaultSubscriptions.get(mint);
      if (controller) {
        controller.abort();
        ctx.state.vaultSubscriptions.delete(mint);
        ctx.logger(`Unsubscribed from vault push-stream for ${mint}`, 'debug');
      }
    }
  }

  private async startAccountSubscription(
    mint: string,
    addr: string,
    type: 'raydium' | 'meteora',
    poolData: CachedPoolConfig,
    signal: AbortSignal
  ) {
    const ctx = this.getCtx();
    const handshakeMs = ctx.config.websocketHandshakeTimeoutMs || 15_000;
    while (!signal.aborted) {
      let timeoutId: NodeJS.Timeout | undefined;
      try {
        const subscription = await Promise.race([
          ctx.rpcSubscriptions
            .accountNotifications(address(addr), { encoding: 'base64', commitment: 'confirmed' })
            .subscribe({ abortSignal: signal }),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error('Account subscription handshake timeout')),
              handshakeMs
            );
          }),
        ]);
        clearTimeout(timeoutId);

        for await (const notification of subscription) {
          if (signal.aborted) break;
          const dataStr = notification.value.data[0];
          if (!dataStr) continue;
          const buf = Buffer.from(dataStr, 'base64');

          // Offset 64 in SPL Token accounts stores the 64-bit unsigned amount.
          if (buf.length >= 72) {
            const balanceBigInt = buf.readBigUInt64LE(64);
            this.getCtx().state.vaultBalanceCache!.set(addr, balanceBigInt);

            if (type === 'raydium') {
              this.recalculateRaydiumPrice(mint, poolData as RaydiumPool);
            } else {
              this.recalculateMeteoraPrice(mint, poolData as MeteoraPool);
            }
          }
        }
        if (!signal.aborted) {
          throw new Error('Vault subscription ended unexpectedly');
        }
      } catch (err) {
        clearTimeout(timeoutId);
        if (signal.aborted) return;
        ctx.logger(
          `Vault subscription failed/ended for ${mint} (${addr}): ${err instanceof Error ? err.message : String(err)}. Retrying in ~5s...`,
          'warn'
        );
        // Jitter so all vault subs don't retry in lockstep and stampede the RPC WS on a drop.
        await sleep(5000 + Math.floor(Math.random() * 2000));
      }
    }
  }

  private async startAtaSubscription(mint: string, ataAddress: string, signal: AbortSignal) {
    const ctx = this.getCtx();
    const handshakeMs = ctx.config.websocketHandshakeTimeoutMs || 15_000;
    while (!signal.aborted) {
      let timeoutId: NodeJS.Timeout | undefined;
      try {
        const subscription = await Promise.race([
          ctx.rpcSubscriptions
            .accountNotifications(address(ataAddress), {
              encoding: 'base64',
              commitment: 'confirmed',
            })
            .subscribe({ abortSignal: signal }),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error('ATA subscription handshake timeout')),
              handshakeMs
            );
          }),
        ]);
        clearTimeout(timeoutId);

        for await (const notification of subscription) {
          if (signal.aborted) break;
          const dataStr = notification.value?.data?.[0];
          if (!dataStr) continue;
          const buf = Buffer.from(dataStr, 'base64');

          // SPL Token account balance is a u64 at offset 64
          if (buf.length < 72) continue;
          const balanceBigInt = buf.readBigUInt64LE(64);
          const pos = ctx.state.positions.get(mint);
          const decimals = pos?.mintSignals?.decimals || 6;
          const uiAmount = Number(balanceBigInt) / 10 ** decimals;

          ctx.state.ataBalanceCache?.set(mint, {
            mint,
            rawAmount: balanceBigInt,
            decimals,
            uiAmount,
          });
          ctx.logger(`[ATA Push] Balance updated for ${mint}: ${uiAmount} tokens`, 'debug');
        }
        if (!signal.aborted) {
          throw new Error('ATA subscription ended unexpectedly');
        }
      } catch (err) {
        clearTimeout(timeoutId);
        if (signal.aborted) return;
        ctx.logger(
          `ATA subscription failed/ended for ${mint}: ${err instanceof Error ? err.message : String(err)}. Retrying in ~5s...`,
          'warn'
        );
        // Jitter so all ATA subs don't retry in lockstep and stampede the RPC WS on a drop.
        await sleep(5000 + Math.floor(Math.random() * 2000));
      }
    }
  }

  private async recalculateRaydiumPrice(mint: string, poolData: RaydiumPool) {
    const baseBalance = this.getCtx().state.vaultBalanceCache!.get(poolData.baseVault);
    const quoteBalance = this.getCtx().state.vaultBalanceCache!.get(poolData.quoteVault);
    if (baseBalance === undefined || quoteBalance === undefined) return;

    const baseBalanceDecimal = Number(baseBalance) / Math.pow(10, poolData.baseDecimals);
    const quoteBalanceDecimal = Number(quoteBalance) / Math.pow(10, poolData.quoteDecimals);
    if (baseBalanceDecimal === 0 || quoteBalanceDecimal === 0) return;

    let priceInSol: number;
    let solReserves: number;
    if (poolData.quoteMint === SOL_MINT) {
      priceInSol = quoteBalanceDecimal / baseBalanceDecimal;
      solReserves = quoteBalanceDecimal;
    } else if (poolData.baseMint === SOL_MINT) {
      priceInSol = baseBalanceDecimal / quoteBalanceDecimal;
      solReserves = baseBalanceDecimal;
    } else {
      return;
    }

    const solUsdPrice = await tradingService.estimateSolUsdPrice(this.getCtx());
    const usdPrice = priceInSol * solUsdPrice;
    const liquidity = solReserves * 2 * solUsdPrice;

    this.getCtx().store.updateMarketSnapshot(mint, {
      launchpad: 'raydium',
      liquidity: liquidity,
      usdPrice: usdPrice,
      observedAt: new Date().toISOString(),
    });

    // Trigger instant monitor check using the Event-Driven Engine
    const pos = this.getCtx().state.positions.get(mint);
    if (pos) {
      const balance = this.getCtx().state.ataBalanceCache?.get(mint) ?? {
        mint,
        rawAmount: 0n,
        decimals: pos.mintSignals?.decimals || 6,
        uiAmount: 0,
      };
      const { evaluateSinglePosition } = await import('#services/monitor/monitor.service.js');
      await evaluateSinglePosition(
        this.getCtx(),
        mint,
        pos,
        balance,
        { usdPrice, liquidity },
        undefined
      );
    }
  }

  private async recalculateMeteoraPrice(mint: string, poolData: MeteoraPool) {
    const xBalance = this.getCtx().state.vaultBalanceCache!.get(poolData.reserveX);
    const yBalance = this.getCtx().state.vaultBalanceCache!.get(poolData.reserveY);
    if (xBalance === undefined || yBalance === undefined) return;

    const solIsX = poolData.tokenXMint === SOL_MINT;
    const solBalance = Number(solIsX ? xBalance : yBalance);
    if (solBalance <= 0) return;

    const solReserves = solBalance / 1e9;

    // Price depends on activeId. We fallback to cached marketSnapshot if Geyser hasn't updated activeId.
    // Geyser updates the activeId, we update the liquidity here.
    const snap = this.getCtx().state.marketSnapshots.get(mint);
    if (!snap?.usdPrice) return;

    const usdPrice = snap.usdPrice;
    const liquidity = solReserves * 2 * (await tradingService.estimateSolUsdPrice(this.getCtx()));

    this.getCtx().store.updateMarketSnapshot(mint, {
      ...snap,
      liquidity: liquidity,
      observedAt: new Date().toISOString(),
    });

    // Trigger instant monitor check using the Event-Driven Engine
    const pos = this.getCtx().state.positions.get(mint);
    if (pos) {
      const balance = this.getCtx().state.ataBalanceCache?.get(mint) ?? {
        mint,
        rawAmount: 0n,
        decimals: pos.mintSignals?.decimals || 6,
        uiAmount: 0,
      };
      const { evaluateSinglePosition } = await import('#services/monitor/monitor.service.js');
      await evaluateSinglePosition(
        this.getCtx(),
        mint,
        pos,
        balance,
        { usdPrice, liquidity },
        undefined
      );
    }
  }

  private countOpenSwingPositions(ctx: Context): number {
    let count = 0;
    for (const pos of ctx.state.positions.values()) {
      if (pos.entryProfile === 'swing') count++;
    }
    return count;
  }

  /**
   * Starts all bot services and begins execution.
   */
  public async start(): Promise<void> {
    this.getCtx().logger('VelociBuyBot starting...', 'info', { console: true });

    if (process.env.ML_ENABLED === 'true') {
      mlService.init(this.store, this.config);
      await mlService.initialize();

      ghostTrader.start(this.getCtx(), mlService);

      mlService.start();
      this.getCtx().logger('ML adaptive learning service active.', 'info', { console: true });
    }

    if (this.config.discoveryWsEnabled) {
      await discovery.discoveryService.start(this.getCtx(), () =>
        this.scheduleDiscoverySignalFlush()
      );
      this.getCtx().logger('WebSocket log discovery active.', 'info', { console: true });
    }

    // Optional low-latency account stream from a validator running the Geyser
    // plugin. Enabled by default; failures fall back to RPC polling.
    this.startGeyserIfEnabled();

    // Perform initial discovery run to populate state
    await this.runDiscoveryLoop(true);

    if (this.config.useJito) {
      this.blockhashPrewarmerTimer = startBlockhashPrewarmer(this.getCtx());
      this.getCtx().logger('Blockhash pre-warmer active (Jito mode).', 'info', { console: true });
    }

    this.monitorTimer = setInterval(() => this.runMonitorLoop(), 4000);
    this.discoveryTimer = setInterval(
      () => this.runDiscoveryLoop(),
      this.config.discoveryPollIntervalMs
    );
    if (this.config.trendingDiscoveryEnabled) {
      this.trendingTimer = setInterval(
        () => this.runTrendingLoop(),
        this.config.trendingPollIntervalMs
      );
    }
    if (this.config.swingBotEnabled) {
      this.swingTimer = setInterval(
        () => this.runSwingLoop(),
        this.config.swingWatchlistPollIntervalMs
      );
      this.fastSwingTimer = setInterval(() => this.runFastSwingPoll(), 15_000);
      this.getCtx().logger(
        `Swing bot active (poll=${this.config.swingWatchlistPollIntervalMs}ms, mcap=$${this.config.swingMinMarketCapUsd.toLocaleString()}–$${this.config.swingMaxMarketCapUsd.toLocaleString()}).`,
        'info',
        { console: true }
      );
    }

    this.getCtx().logger('Core service loops initialized.', 'info', { console: true });

    while (!this.shouldStop) {
      await sleep(100);
    }

    await this.performShutdown();
  }

  /**
   * Shared handler for a decoded pump.fun bonding curve Geyser update.
   * Called immediately when curveToMint is populated, or after a 2s retry for new launches.
   */
  private processPumpCurveGeyserUpdate(mint: string, data: Buffer): void {
    const curveData = decodePumpCurve(data);
    if (!curveData) return;
    const vSol = Number(curveData.virtualSolReserves);
    const vToken = Number(curveData.virtualTokenReserves);
    if (vToken === 0) return;
    const priceInSol = vSol / vToken;
    tradingService
      .estimateSolUsdPrice(this.getCtx())
      .then((solUsdPrice: number) => {
        const usdPrice = priceInSol * solUsdPrice;
        this.getCtx().store.updateMarketSnapshot(mint, {
          launchpad: 'pump.fun',
          liquidity: Number(curveData.realSolReserves),
          usdPrice,
          observedAt: new Date().toISOString(),
        });
      })
      .catch(() => {});
  }

  /**
   * Fires the discovery pipeline for a mint extracted directly from a Geyser
   * account update, bypassing getTransaction entirely.
   */
  private triggerGeyserDiscovery(mint: string, launchpad: string): void {
    if (this.getCtx().state.processedMints.has(mint)) return;
    const now = Date.now();
    const last = this.geyserRecentMints.get(mint) ?? 0;
    if (now - last < 60_000) return;
    this.geyserRecentMints.set(mint, now);
    void this.runDiscoveryLoop({
      reason: 'geyser-mint-init',
      forceDiscovery: true,
      mints: [mint],
      mintLaunchpads: { [mint]: launchpad },
    });
  }

  /**
   * Starts the optional Geyser account stream when configured. This is a
   * latency accelerator layered on top of RPC polling, never a replacement.
   * Handles pump.fun bonding curves, Raydium AMM V4 pools, and Meteora DLMM
   * pools — all feed marketSnapshots with real-time price/liquidity data.
   */
  private startGeyserIfEnabled(): void {
    const opts = geyserOptionsFromEnv();
    if (!opts) return;

    const logger = this.getCtx().logger;
    this.geyserClient = new GeyserClient({
      ...opts,
      onUpdate: (update) => {
        const state = this.getCtx().state;
        state.latestGeyserSlot = Math.max(state.latestGeyserSlot || 0, update.slot);

        // Evict stale pending curve PDAs (> 30s) to bound memory growth.
        if (this.pendingCurvePdas.size > 0) {
          const staleAt = Date.now() - 30_000;
          for (const [pda, entry] of this.pendingCurvePdas) {
            if (entry.at < staleAt) this.pendingCurvePdas.delete(pda);
          }
        }
        // Evict geyserRecentMints entries older than 60s.
        if (this.geyserRecentMints.size > 0) {
          const cutoff = Date.now() - 60_000;
          for (const [mint, ts] of this.geyserRecentMints) {
            if (ts < cutoff) this.geyserRecentMints.delete(mint);
          }
        }
        // Cap geyserSeenPools size to prevent unbounded memory leak.
        // It's a deduplication filter; occasionally clearing it is harmless.
        if (this.geyserSeenPools.size > 10_000) {
          this.geyserSeenPools.clear();
        }

        if (update.owner === PUMP_FUN_PROGRAM_ID) {
          const curveData = decodePumpCurve(update.data);
          if (!curveData) return;

          const mint = this.getCtx().state.curveToMint.get(update.pubkey);
          if (!mint) {
            // New mint: curveToMint not yet populated (WebSocket discovery fires ~1-2s later).
            // Queue and retry once after 2s so the first launch update isn't silently dropped.
            if (!this.pendingCurvePdas.has(update.pubkey)) {
              this.pendingCurvePdas.set(update.pubkey, { data: update.data, at: Date.now() });
              setTimeout(() => {
                const pending = this.pendingCurvePdas.get(update.pubkey);
                if (!pending) return;
                this.pendingCurvePdas.delete(update.pubkey);
                const resolvedMint = this.getCtx().state.curveToMint.get(update.pubkey);
                if (resolvedMint) this.processPumpCurveGeyserUpdate(resolvedMint, pending.data);
              }, 2000);
            }
            return;
          }

          this.processPumpCurveGeyserUpdate(mint, update.data);
        } else if (update.owner === RAYDIUM_AMM_V4_PROGRAM_ID) {
          // First write for this pool pubkey → fire discovery immediately (no getTransaction).
          if (!this.geyserSeenPools.has(update.pubkey)) {
            this.geyserSeenPools.add(update.pubkey);
            const newPool = decodeRaydiumPool(update.data);
            if (newPool) {
              const { baseMint, quoteMint } = newPool;
              const tokenMint = baseMint === SOL_MINT ? quoteMint : baseMint;
              if (tokenMint !== SOL_MINT) this.triggerGeyserDiscovery(tokenMint, 'raydium');
            }
          }
          const now = Date.now();
          const lastFetch = this.raydiumVaultFetchTs.get(update.pubkey) ?? 0;
          if (now - lastFetch < VelociBuyBot.RAYDIUM_FETCH_DEBOUNCE_MS) return;
          this.raydiumVaultFetchTs.set(update.pubkey, now);
          if (this.raydiumVaultFetchInFlight.has(update.pubkey)) return;

          const poolData = decodeRaydiumPool(update.data);
          if (!poolData) return;
          poolConfigsCache.set(update.pubkey, poolData);

          const baseMint = poolData.baseMint;
          const quoteMint = poolData.quoteMint;
          const tokenMint = baseMint === SOL_MINT ? quoteMint : baseMint;

          // Cache pool address for local routing (sell path)
          this.getCtx().state.mintToPool.set(tokenMint, update.pubkey);

          const raydiumFetchPromise: Promise<void> = rpcCall(
            this.getCtx(),
            'getMultipleAccounts',
            [
              [address(poolData.baseVault), address(poolData.quoteVault)],
              { encoding: 'base64', commitment: 'confirmed' },
            ],
            { priority: PRIORITY.HIGH }
          )
            .then(async (vaultInfo) => {
              const value = vaultInfo?.value;
              if (value && value.length === 2) {
                const baseAccount = value[0];
                const quoteAccount = value[1];
                if (baseAccount && quoteAccount) {
                  const baseData = baseAccount.data;
                  const quoteData = quoteAccount.data;
                  if (Array.isArray(baseData) && Array.isArray(quoteData)) {
                    const baseBuffer = Buffer.from(baseData[0], 'base64');
                    const quoteBuffer = Buffer.from(quoteData[0], 'base64');
                    if (baseBuffer.length >= 72 && quoteBuffer.length >= 72) {
                      const baseBalance = baseBuffer.readBigUInt64LE(64);
                      const quoteBalance = quoteBuffer.readBigUInt64LE(64);

                      const baseBalanceDecimal =
                        Number(baseBalance) / Math.pow(10, poolData.baseDecimals);
                      const quoteBalanceDecimal =
                        Number(quoteBalance) / Math.pow(10, poolData.quoteDecimals);

                      if (baseBalanceDecimal === 0 || quoteBalanceDecimal === 0) return;

                      let priceInSol: number;
                      let solReserves: number;
                      if (quoteMint === SOL_MINT) {
                        priceInSol = quoteBalanceDecimal / baseBalanceDecimal;
                        solReserves = quoteBalanceDecimal;
                      } else if (baseMint === SOL_MINT) {
                        priceInSol = baseBalanceDecimal / quoteBalanceDecimal;
                        solReserves = baseBalanceDecimal;
                      } else {
                        return; // Non-SOL pool
                      }

                      const solUsdPrice = await tradingService.estimateSolUsdPrice(this.getCtx());
                      const usdPrice = priceInSol * solUsdPrice;
                      const liquidity = solReserves * 2 * solUsdPrice;

                      this.getCtx().store.updateMarketSnapshot(tokenMint, {
                        launchpad: 'raydium',
                        liquidity: liquidity,
                        usdPrice: usdPrice,
                        observedAt: new Date().toISOString(),
                      });
                    }
                  }
                }
              }
            })
            .catch((err: unknown) => {
              logger(`Failed to get Raydium vault balances for Geyser update: ${err}`, 'debug');
            })
            .finally(() => {
              this.raydiumVaultFetchInFlight.delete(update.pubkey);
            });
          this.raydiumVaultFetchInFlight.set(update.pubkey, raydiumFetchPromise);
        } else if (update.owner === METEORA_DLMM_PROGRAM_ID) {
          // First write for this pool pubkey → fire discovery immediately (no getTransaction).
          if (!this.geyserSeenPools.has(update.pubkey)) {
            this.geyserSeenPools.add(update.pubkey);
            const newPool = decodeMeteoraPool(update.data);
            if (newPool) {
              const solIsXNew = newPool.tokenXMint === SOL_MINT;
              const newMint = solIsXNew ? newPool.tokenYMint : newPool.tokenXMint;
              if (newMint !== SOL_MINT) this.triggerGeyserDiscovery(newMint, 'meteora');
            }
          }
          const now = Date.now();
          const lastFetch = this.meteoraVaultFetchTs.get(update.pubkey) ?? 0;
          if (now - lastFetch < VelociBuyBot.METEORA_FETCH_DEBOUNCE_MS) return;
          this.meteoraVaultFetchTs.set(update.pubkey, now);
          if (this.meteoraVaultFetchInFlight.has(update.pubkey)) return;

          const poolData = decodeMeteoraPool(update.data);
          if (!poolData) return;
          poolConfigsCache.set(update.pubkey, poolData);

          const { tokenXMint, tokenYMint, reserveX, reserveY, activeId, binStep } = poolData;
          const solIsX = tokenXMint === SOL_MINT;
          const tokenMint = solIsX ? tokenYMint : tokenXMint;

          // Cache pool address for local routing (sell path)
          this.getCtx().state.mintToPool.set(tokenMint, update.pubkey);

          // Compute price from active bin: price = (1 + binStep/10_000)^activeId (token priced in SOL)
          const priceRaw = Math.pow(1 + binStep / 10_000, activeId);
          const priceInSol = solIsX ? 1 / priceRaw : priceRaw;

          const meteoraFetchPromise: Promise<void> = rpcCall(
            this.getCtx(),
            'getMultipleAccounts',
            [
              [address(reserveX), address(reserveY)],
              { encoding: 'base64', commitment: 'confirmed' },
            ],
            { priority: PRIORITY.HIGH }
          )
            .then(async (vaultInfo) => {
              const value = vaultInfo?.value;
              if (!value || value.length < 2) return;
              const xAccount = value[0];
              const yAccount = value[1];
              if (!xAccount || !yAccount) return;
              const xData = xAccount.data;
              const yData = yAccount.data;
              if (!Array.isArray(xData) || !Array.isArray(yData)) return;
              const xBuf = Buffer.from(xData[0], 'base64');
              const yBuf = Buffer.from(yData[0], 'base64');
              if (xBuf.length < 72 || yBuf.length < 72) return;
              // SPL token account: amount at offset 64 (u64 LE)
              const xBalance = Number(xBuf.readBigUInt64LE(64));
              const yBalance = Number(yBuf.readBigUInt64LE(64));
              const solBalance = solIsX ? xBalance : yBalance;
              if (solBalance <= 0) return;
              const solReserves = solBalance / 1e9;
              const solUsdPrice = await tradingService.estimateSolUsdPrice(this.getCtx());
              const usdPrice = priceInSol * solUsdPrice;
              const liquidity = solReserves * 2 * solUsdPrice;
              this.getCtx().store.updateMarketSnapshot(tokenMint, {
                launchpad: 'meteora',
                liquidity,
                usdPrice,
                observedAt: new Date().toISOString(),
              });
            })
            .catch((err: unknown) => {
              logger(`Failed to get Meteora vault balances for Geyser update: ${err}`, 'debug');
            })
            .finally(() => {
              this.meteoraVaultFetchInFlight.delete(update.pubkey);
            });
          this.meteoraVaultFetchInFlight.set(update.pubkey, meteoraFetchPromise);
        }
      },
      log: (msg, level) => logger(msg, level, { console: true }),
    });
    this.geyserClient.start();
    logger(
      `Geyser stream client started (${opts.tcpAddr ?? opts.socketPath}). RPC polling remains the fallback.`,
      'info',
      { console: true }
    );
  }

  /**
   * Signals the bot to begin a graceful shutdown.
   */
  public stop(): void {
    if (this.shouldStop) return;
    this.shouldStop = true;
  }

  /**
   * Internal shutdown logic to cleanup resources and persist final state.
   */
  private async performShutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    this.getCtx().logger('Initiating graceful shutdown...', 'info', { console: true });

    if (this.monitorTimer) clearInterval(this.monitorTimer);
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.trendingTimer) clearInterval(this.trendingTimer);
    if (this.swingTimer) clearInterval(this.swingTimer);
    if (this.fastSwingTimer) clearInterval(this.fastSwingTimer);
    if (this.blockhashPrewarmerTimer) clearInterval(this.blockhashPrewarmerTimer);

    discovery.discoveryService.stop();

    // Clear all pending cooldown timers
    for (const timer of this.coolDownTimers.values()) {
      clearTimeout(timer);
    }
    this.coolDownTimers.clear();

    if (this.tui) {
      this.tui.disable();
      setConsoleSuppressed(false);
    }

    if (this.config.closePositionsOnShutdown) {
      this.getCtx().logger('Emergency exit: closing all open positions.', 'warn', {
        console: true,
      });
      try {
        await services.closeAllOpenPositions(this.getCtx());
      } catch (e) {
        this.getCtx().logger(
          `Shutdown exit failure: ${e instanceof Error ? e.message : String(e)}`,
          'error'
        );
      }
    }

    ghostTrader.stop();
    mlService.stop();
    swingTapeManager.unsubscribeAll();
    if (this.geyserClient) {
      this.geyserClient.stop();
      this.geyserClient = null;
    }
    // Flush all queued writes while the worker is still accepting them, then
    // request shutdown last and await it — requestShutdown() flips an internal
    // flag that turns persist()/flush() into no-ops, so it must come after, and
    // it performs the final flush + closes the worker and DB.
    await this.store.persist({ force: true });
    await this.store.requestShutdown();

    this.getCtx().logger('All services stopped. Persistence complete.', 'info', {
      console: true,
    });
  }
}
