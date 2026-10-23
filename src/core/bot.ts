import { Rpc, SolanaRpcApi, createSolanaRpc } from '@solana/rpc';
import {
  RpcSubscriptions,
  SolanaRpcSubscriptionsApi,
  createSolanaRpcSubscriptions,
} from '@solana/rpc-subscriptions';
import { KeyPairSigner } from '@solana/signers';

import {
  sleep,
  log,
  atomicToDecimalString,
  setConsoleSuppressed,
  setRpcRateLimits,
} from './utils.js';
import { localMarketState } from '#services/market-state/index.js';

import { StateStore } from './store.js';

import * as services from '#services/services.js';
import * as discovery from '#services/discovery/discovery.service.js';
import * as scanner from '#services/scanner/scanner.service.js';
import { startBlockhashPrewarmer } from '#services/trading/swap-executor.js';
import { TuiService } from '#services/tui.service.js';
import { Config, State, Context, TokenMetadata, LogLevel, Position } from '#types/index.js';
import { mlService } from '#ml/ml-service.js';
import { ghostTrader } from '#ml/ghost-trader.js';
import { GeyserClient } from '#services/ingestion/geyser-client.js';
import { VaultSubscriptionManager } from './bot-internals/vault-subscriptions.js';
import {
  GeyserStreamCoordinator,
  registerPumpMintPda,
} from './bot-internals/geyser-coordinator.js';
import { ScanBackpressureManager } from './bot-internals/backpressure-manager.js';
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
  private vaultSubscriptionManager!: VaultSubscriptionManager;
  private geyserCoordinator!: GeyserStreamCoordinator;
  private backpressureManager = new ScanBackpressureManager();

  public get geyserClient(): GeyserClient | null {
    return this.geyserCoordinator.geyserClient;
  }

  public startGeyserIfEnabled(): void {
    this.geyserCoordinator.startGeyserIfEnabled();
  }

  public get scanBackpressure(): { events: { error: boolean; at: number }[]; factor: number } {
    return {
      events: this.backpressureManager.events,
      factor: this.backpressureManager.factor,
    };
  }

  private monitorLoopBusy = false;
  private discoveryLoopBusy = false;
  // Serializes every scanForCandidates call (discovery + trending) so they never overlap.
  private scanChain: Promise<void> = Promise.resolve();
  private currentRpcSubIndex = 0;
  private cachedContext: Context | null = null;

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
    this.vaultSubscriptionManager = new VaultSubscriptionManager(
      () => this.getCtx(),
      this.wallet.address
    );
    this.geyserCoordinator = new GeyserStreamCoordinator(
      () => this.getCtx(),
      (opts) => this.runDiscoveryLoop(opts)
    );

    if (!config.rpcUrls?.length) throw new Error('No RPC URLs provided in configuration.');
    if (!config.wsRpcUrls?.length)
      throw new Error('No WebSocket RPC URLs provided in configuration.');

    setRpcRateLimits(config.rpcRateLimits, config.rpcSendTxRateLimits);

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
    this.backpressureManager.recordEvent(error, this.config);
  }

  /**
   * Returns adjusted parallelism count based on current RPC health.
   * @param base - The target parallelism count.
   * @returns The health-adjusted parallelism count.
   */
  public getEffectiveParallelism(base: number): number {
    return this.backpressureManager.getEffectiveParallelism(base);
  }

  private readonly logListeners = new Set<
    (msg: string, lvl?: LogLevel, opts?: { console?: boolean; sync?: boolean }) => void
  >();

  public addLogListener(
    listener: (msg: string, lvl?: LogLevel, opts?: { console?: boolean; sync?: boolean }) => void
  ): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  /**
   * Generates a unified execution context for all services.
   * @returns The current application context.
   */
  public getCtx(): Context {
    if (this.cachedContext) {
      this.cachedContext.config = this.config;
      this.cachedContext.rpc = this.rpc;
      this.cachedContext.rpcs = this.rpcs;
      this.cachedContext.rpcSubscriptions = this.rpcSubscriptions;
      this.cachedContext.rpcSubscriptionPool = this.rpcSubscriptionPool;
      this.cachedContext.scanBackpressureFactor = this.scanBackpressure.factor;
      this.cachedContext.state = this.state;
      this.cachedContext.tui = this.tui || undefined;
      return this.cachedContext;
    }

    this.cachedContext = {
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
        for (const listener of this.logListeners) {
          try {
            listener(finalMsg, lvl, opts);
          } catch {}
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
      subscribeToAtaBalance: (m) => this.vaultSubscriptionManager.subscribeToAtaBalance(m),
      unsubscribeFromAtaBalance: (m) => this.vaultSubscriptionManager.unsubscribeFromAtaBalance(m),
    };
    return this.cachedContext;
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
    const monitorTickStartedAt = Date.now();
    try {
      await services.monitorPositions(this.getCtx());
      const monitorTickCompletedAt = Date.now();
      const monitorTickDurationMs = monitorTickCompletedAt - monitorTickStartedAt;
      this.getCtx().logger(
        `[MonitorTick] Completed in ${monitorTickDurationMs}ms (positions=${this.state.positions.size}).`,
        'debug'
      );
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
          discoveryItems = wsMints.map((mint) => {
            const lp =
              launchpads[mint] || (mint.toLowerCase().endsWith('pump') ? 'pump.fun' : 'unknown');
            if (lp === 'pump.fun' || mint.toLowerCase().endsWith('pump')) {
              registerPumpMintPda(this.getCtx(), mint);
              const provSnap = localMarketState.getSnapshot(mint);
              if (provSnap) {
                this.getCtx().store.updateMarketSnapshot(mint, {
                  launchpad: 'pump.fun',
                  liquidity: provSnap.liquidityUsd,
                  usdPrice: provSnap.priceUsd,
                  observedAt: new Date().toISOString(),
                });
              }
            }
            return {
              id: mint,
              symbol: '?',
              name: '?',
              launchpad: lp,
            } as TokenMetadata;
          });
        }
        await this.runScanExclusive(() =>
          scanner.scanCoordinator.requestScan(this.getCtx(), discoveryItems, reason)
        );
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
        await this.runScanExclusive(() =>
          scanner.scanCoordinator.requestScan(ctx, trending, 'trending')
        );
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.getCtx().logger(`Trending loop error: ${msg}`, 'warn');
    } finally {
      this.trendingLoopBusy = false;
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
    return this.vaultSubscriptionManager.subscribeToVaultBalances(mint, poolAddress, type);
  }

  public unsubscribeFromVaultBalances(mint: string): void {
    return this.vaultSubscriptionManager.unsubscribeFromVaultBalances(mint);
  }

  public subscribeToAtaBalance(mint: string): Promise<void> {
    return this.vaultSubscriptionManager.subscribeToAtaBalance(mint);
  }

  public unsubscribeFromAtaBalance(mint: string): void {
    return this.vaultSubscriptionManager.unsubscribeFromAtaBalance(mint);
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
    this.geyserCoordinator.startGeyserIfEnabled();

    // Perform initial discovery run to populate state
    await this.runDiscoveryLoop(true);

    if (this.config.useJito) {
      this.blockhashPrewarmerTimer = startBlockhashPrewarmer(this.getCtx());
      this.getCtx().logger('Blockhash pre-warmer active (Jito mode).', 'info', { console: true });
    }

    this.monitorTimer = setInterval(() => this.runMonitorLoop(), this.config.scanIntervalMs);
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
    this.getCtx().logger('Core service loops initialized.', 'info', { console: true });

    while (!this.shouldStop) {
      await sleep(100);
    }

    await this.performShutdown();
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
    this.shouldStop = true;

    this.getCtx().logger('Initiating graceful shutdown...', 'info', { console: true });

    if (this.monitorTimer) clearInterval(this.monitorTimer);
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.trendingTimer) clearInterval(this.trendingTimer);
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

    // Wait for in-flight monitor or discovery loops to settle (bounded wait up to 3s)
    const settleStart = Date.now();
    while ((this.monitorLoopBusy || this.discoveryLoopBusy) && Date.now() - settleStart < 3000) {
      await sleep(50);
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
    this.geyserCoordinator.stop();

    // Flush all queued writes while the worker is still accepting them, then
    // request shutdown last and await it — requestShutdown() performs the final flush
    // and closes the worker and DB.
    await this.store.flush({ force: true });
    await this.store.requestShutdown();

    this.getCtx().logger('All services stopped. Persistence complete.', 'info', {
      console: true,
    });
  }
}
