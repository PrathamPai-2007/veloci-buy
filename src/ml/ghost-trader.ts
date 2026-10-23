import { log, journalGhostTrade } from '#core/utils.js';
import {
  Context,
  EvaluationResult,
  GhostPosition,
  TrainingSample,
  ClosedTrade,
  Position,
} from '#types/index.js';
import { extractFeatures } from './features.js';
import { MlService } from './ml-service.js';
import { marketDataProvider } from '../services/market-state/index.js';
import { evaluateExitChain, defaultExitChain } from '../services/monitor/exits/exit-chain.js';
import { takeProfitLadderGuard } from '../services/monitor/exits/rules/take-profit-ladder.js';
import { tradingService } from '../services/trading/index.js';

// Ghost uses real exit chain minus live-only side-effecting guards (optimistic, fee-free).
const GHOST_EXIT_CHAIN = defaultExitChain.filter((r) => r !== takeProfitLadderGuard);

const DEFAULT_TICK_INTERVAL_MS = 1000;
const DEFAULT_MAX_POSITIONS = 3;
const DEFAULT_MAX_HOLD_MINUTES = 5;
const CANDIDATE_QUEUE_CAP = 50;
const STALE_PRICE_GRACE_MS = 5 * 60_000;

interface GhostCandidate {
  evalResult: EvaluationResult;
  featuresJson: string;
  queuedAt: number;
  tier: 'cheap' | 'deep';
  score: number;
}

export class GhostTrader {
  private ghosts = new Map<string, GhostPosition>();
  private candidateQueue: GhostCandidate[] = [];
  private timer: NodeJS.Timeout | null = null;
  private ctx: Context | null = null;
  private mlSvc: MlService | null = null;
  private logFile = '';
  private minScore = 0;

  private readonly tickIntervalMs: number;
  private maxPositions: number;
  private maxHoldMs: number;
  private maxHoldMinutesResolved = DEFAULT_MAX_HOLD_MINUTES;
  private lastSolPriceUsd = 0;

  constructor() {
    this.tickIntervalMs = Number(process.env.GHOST_TICK_INTERVAL_MS ?? DEFAULT_TICK_INTERVAL_MS);
    this.maxPositions = Number(process.env.GHOST_MAX_POSITIONS ?? DEFAULT_MAX_POSITIONS);
    // Default until ctx is available; start() resolves to ctx.config.maxHoldMinutes.
    this.maxHoldMs =
      Number(process.env.GHOST_MAX_HOLD_MINUTES ?? DEFAULT_MAX_HOLD_MINUTES) * 60_000;
  }

  start(ctx: Context, mlSvc: MlService): void {
    this.ctx = ctx;
    this.mlSvc = mlSvc;
    this.logFile = ctx.config.logFile;
    this.minScore = Number(process.env.GHOST_MIN_SCORE ?? ctx.config.minCandidateScore);

    // Full Parity: follow live strategy hold — optimistic, fee-free. Explicit env override still wins.
    if (
      process.env.GHOST_MAX_HOLD_MINUTES == null ||
      process.env.GHOST_MAX_HOLD_MINUTES.trim() === ''
    ) {
      this.maxHoldMinutesResolved = ctx.config.maxHoldMinutes;
      this.maxHoldMs = this.maxHoldMinutesResolved * 60_000;
    } else {
      this.maxHoldMinutesResolved = Number(process.env.GHOST_MAX_HOLD_MINUTES);
      this.maxHoldMs = this.maxHoldMinutesResolved * 60_000;
    }

    this.timer = setInterval(() => {
      this._tick().catch((err: unknown) => {
        log(
          this.logFile,
          `[GHOST] Tick error: ${err instanceof Error ? err.message : String(err)}`,
          'error'
        );
      });
    }, this.tickIntervalMs);

    log(
      this.logFile,
      `[GHOST] Started. Interval: ${this.tickIntervalMs / 1000}s, max positions: ${this.maxPositions}, maxHold: ${this.maxHoldMinutesResolved}m (trail ${ctx.config.trailingStopDrawdownPct * 100}%, SL ${ctx.config.stopLossPct * 100}%).`,
      'info'
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Called by the engine after rule-based checks pass (before the ML gate is applied).
   * The ghost trader observes every heuristic-approved candidate — including those the
   * ML gate later blocks — so their real-world outcomes can feed back into training.
   * Tier-aware: 'deep' candidates passed the full audit and are preferred when slots are scarce.
   */
  notifyCandidate(evalResult: EvaluationResult, tier: 'cheap' | 'deep' = 'cheap'): void {
    if (!this.ctx) return;
    if (evalResult.candidateScore < this.minScore) return;

    const features = extractFeatures(evalResult);
    const featuresJson = JSON.stringify(Array.from(features));

    const candidate: GhostCandidate = {
      evalResult,
      featuresJson,
      queuedAt: Date.now(),
      tier,
      score: evalResult.candidateScore,
    };
    this.candidateQueue.push(candidate);
    if (this.candidateQueue.length > CANDIDATE_QUEUE_CAP) {
      // Score-aware eviction: prefer dropping lowest-score cheap candidatos; if no cheap, drop lowest deep
      const cheapPool = this.candidateQueue
        .map((c, idx) => ({ c, idx }))
        .filter((x) => x.c.tier === 'cheap');
      const pool =
        cheapPool.length > 0 ? cheapPool : this.candidateQueue.map((c, idx) => ({ c, idx }));
      const worstIdx = pool.reduce(
        (worst, cur) =>
          cur.c.score < worst.c.score ||
          (cur.c.score === worst.c.score && cur.c.queuedAt < worst.c.queuedAt)
            ? cur
            : worst,
        pool[0]!
      ).idx;
      this.candidateQueue.splice(worstIdx, 1);
    }
  }

  private _ghostToPosition(ghost: GhostPosition, _pUsd: number): Position {
    // Cheap synthetic Position so evaluateExitChain sees the same shape as real.
    const nowIso = new Date(ghost.openedAt).toISOString();
    return {
      mint: ghost.mint,
      symbol: ghost.symbol,
      name: ghost.symbol,
      decimals: 6,
      openedAt: nowIso,
      mode: 'paper',
      entryPriceUsd: ghost.entryPriceUsd,
      entryUsdValue: 100,
      entryScore: ghost.entryScore,
      initialTokenAmountRaw: String(
        BigInt(Math.round((100 / Math.max(ghost.entryPriceUsd, 1e-9)) * 1e6))
      ),
      highestPriceUsd: ghost.highestPriceUsd,
      partiallyClosed: (ghost.targetsHit ?? 0) > 0,
      takeProfitMultiples: ghost.takeProfitMultiples ?? this.ctx!.config.takeProfitMultiples,
      takeProfitFractions: this.ctx!.config.takeProfitFractions,
      trailingStopDrawdownPctResolved: this.ctx!.config.trailingStopDrawdownPct,
      maxHoldMinutesResolved: this.maxHoldMinutesResolved,
      volatilityScaler: ghost.volatilityScaler ?? 0,
      entryLiquidityUsd: ghost.entryLiquidityUsd ?? 0,
      targetsHit: ghost.targetsHit ?? 0,
      earlyGuardExits: ghost.earlyGuardExits ?? 0,
      trailingArmed: ghost.trailingArmed,
      stopLossWarningSent: ghost.stopLossWarningSent,
      breakEvenStopArmed: ghost.breakEvenStopArmed,
      priceHistory: ghost.priceHistory,
      tapeHistory: ghost.tapeHistory,
      spreadHistory: ghost.spreadHistory,
      timeSeries: ghost.timeSeries,
      entryMarketCapUsd: ghost.entryMarketCapUsd,
      lastKnownLiquidityUsd: ghost.lastKnownLiquidityUsd,
      launchpad: ghost.launchpad,
      tpProfile: ghost.tpProfile,
    } as Position;
  }

  private async _tick(): Promise<void> {
    if (!this.ctx || !this.mlSvc) return;
    const now = Date.now();

    // Refresh cached SOL price once per tick (best-effort, fallback 100)
    if ((global as { __TEST__?: boolean }).__TEST__ || process.env.NODE_ENV === 'test') {
      if (!(this.lastSolPriceUsd > 0)) this.lastSolPriceUsd = 100;
    } else {
      try {
        const sol = await Promise.race([
          tradingService.estimateSolUsdPrice(this.ctx),
          new Promise<number>((_, rej) =>
            setTimeout(() => rej(new Error('sol price timeout')), 800)
          ),
        ]);
        if (sol > 0) this.lastSolPriceUsd = sol;
      } catch {
        if (!(this.lastSolPriceUsd > 0)) this.lastSolPriceUsd = 100;
      }
      if (!(this.lastSolPriceUsd > 0)) this.lastSolPriceUsd = 100;
    }

    // Prune stale queue entries (prevents ghost opening a mint whose market state aged out).
    const maxAgeMs = (this.ctx.config.maxCandidateAgeMinutes ?? 30) * 60_000;
    if (maxAgeMs > 0) {
      const cutoff = now - maxAgeMs;
      this.candidateQueue = this.candidateQueue.filter((c) => c.queuedAt >= cutoff);
    }

    // Step 1: Update ghost prices from unified provider (authoritative local-first, snapshot fallback) and check exits via real exit chain
    for (const [mint, ghost] of [...this.ghosts.entries()]) {
      const localDetails = marketDataProvider.getMarketPriceDetails(mint);
      const localSnap = marketDataProvider.getSnapshot(mint);
      const snap = this.ctx.state.marketSnapshots.get(mint);

      // Resolve price like monitor.service.ts:62 — local authoritative else snapshot.
      let currentPrice: number | undefined;
      let liq: number | undefined;
      let pRecord:
        | { usdPrice?: number; liquidity?: number; bidPrice?: number; askPrice?: number }
        | undefined;
      if (
        localDetails.status === 'AUTHORITATIVE' &&
        localDetails.isFresh &&
        localDetails.priceUsd != null &&
        localDetails.priceUsd > 0
      ) {
        currentPrice = localDetails.priceUsd;
        liq = localSnap?.liquidityUsd ?? snap?.liquidityUsd ?? snap?.liquidity;
        pRecord = { usdPrice: currentPrice, liquidity: liq };
        if (localDetails as unknown as { bidPrice?: number }) {
          // bid/ask rarely present for ghosts; leave undefined so spread guard is no-op unless snapshot has it
        }
      } else {
        currentPrice = snap?.usdPrice;
        liq = snap?.liquidityUsd ?? snap?.liquidity ?? localSnap?.liquidityUsd;
        if (currentPrice != null && currentPrice > 0)
          pRecord = { usdPrice: currentPrice, liquidity: liq };
      }

      const age = now - ghost.openedAt;
      // Direct stale / max-hold still honored before chain (chain's timeExit needs pUsd>0, stale has none).
      if (age >= this.maxHoldMs) {
        this._closeGhost(mint, ghost, currentPrice ?? ghost.entryPriceUsd, 'max-hold');
        continue;
      }
      if (currentPrice === undefined || currentPrice <= 0) {
        if (age > STALE_PRICE_GRACE_MS) {
          this._closeGhost(mint, ghost, ghost.entryPriceUsd, 'stale');
        }
        continue;
      }

      if (currentPrice > ghost.highestPriceUsd) ghost.highestPriceUsd = currentPrice;
      this._advanceTpLadder(ghost, currentPrice);
      // Optimistic TP: if all rungs cleared, close immediately (chain's TP ladder does live sells, not a ghost decision).
      if (
        ghost.targetsHit >=
        (ghost.takeProfitMultiples ?? this.ctx.config.takeProfitMultiples).length
      ) {
        // Keep timeSeries for PnL history
        ghost.timeSeries = ghost.timeSeries || [];
        ghost.timeSeries.push([now, currentPrice, liq ?? 0]);
        if (ghost.timeSeries.length > 2500) ghost.timeSeries.shift();
        this._closeGhost(mint, ghost, currentPrice, 'take-profit');
        continue;
      }

      // Track histories like monitor.service.ts:452 — needed for rug/EPG/spread guards.
      ghost.timeSeries = ghost.timeSeries || [];
      ghost.timeSeries.push([now, currentPrice, liq ?? 0]);
      if (ghost.timeSeries.length > 2500) ghost.timeSeries.shift();

      ghost.priceHistory = ghost.priceHistory || [];
      ghost.priceHistory.push({ price: currentPrice, timestamp: now, liquidity: liq });
      const cutoff60 = now - 60_000;
      ghost.priceHistory = ghost.priceHistory.filter((h) => h.timestamp > cutoff60);
      if (ghost.spreadHistory)
        ghost.spreadHistory = ghost.spreadHistory.filter((h) => h.timestamp > cutoff60);

      // Volatility scaler from priceHistory (mirrors engine.service.ts:153)
      if (ghost.priceHistory.length >= 5) {
        const prices = ghost.priceHistory.map((h) => h.price);
        const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
        const variance = prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length;
        const std = Math.sqrt(variance);
        ghost.volatilityScaler = mean > 0 ? std / mean : 0;
      }
      ghost.lastKnownLiquidityUsd = liq ?? ghost.lastKnownLiquidityUsd;

      // Liquidity collapse — mirror monitor.service.ts:411
      const liqFloor =
        ghost.lastKnownLiquidityUsd != null
          ? Math.max(
              this.ctx.config.liquidityCollapseThresholdUsd,
              Number(ghost.entryLiquidityUsd || 0) * this.ctx.config.liquidityCollapseThresholdRatio
            )
          : null;
      if (
        liqFloor != null &&
        ghost.lastKnownLiquidityUsd != null &&
        ghost.lastKnownLiquidityUsd <= liqFloor
      ) {
        this._closeGhost(mint, ghost, currentPrice, 'liquidity-exit');
        continue;
      }

      // Delegate to the real 14-rule chain (optimistic: preSignals undefined, synthetic balance $100).
      const syntheticPos = this._ghostToPosition(ghost, currentPrice);
      const ageSec = age / 1000;
      const multiples = syntheticPos.takeProfitMultiples;
      const exitCtx = {
        ctx: this.ctx,
        mint,
        pos: syntheticPos,
        balance: {
          mint,
          rawAmount: BigInt(syntheticPos.initialTokenAmountRaw),
          decimals: 6,
          uiAmount: 100 / Math.max(currentPrice, 1e-9),
        },
        pRecord,
        preSignals: undefined,
        pUsd: currentPrice,
        ageSec,
        multiples,
        moonBag: 0n,
        remainingRaw: BigInt(syntheticPos.initialTokenAmountRaw),
        isRunnerOnly: false,
        readOnly: true,
      };
      const decision = await evaluateExitChain(
        exitCtx as unknown as import('../services/monitor/exits/types.js').ExitContext,
        GHOST_EXIT_CHAIN
      );
      // Propagate chain-mutated trailing/TP state back onto ghost so ladder advances faithfully.
      ghost.targetsHit = syntheticPos.targetsHit ?? ghost.targetsHit;
      ghost.trailingArmed = syntheticPos.trailingArmed;
      ghost.earlyGuardExits = syntheticPos.earlyGuardExits;
      ghost.stopLossWarningSent = syntheticPos.stopLossWarningSent;
      ghost.breakEvenStopArmed = syntheticPos.breakEvenStopArmed;
      ghost.highestPriceUsd = syntheticPos.highestPriceUsd ?? ghost.highestPriceUsd;

      if (decision && decision.reason) {
        // takeProfit ladder is handled via self-managed _advanceTpLadder; ignore null returns from it
        this._closeGhost(mint, ghost, currentPrice, decision.reason);
      }
    }

    // Step 2: Open a new ghost from the highest-scoring queued candidate not already tracked
    if (this.ghosts.size < this.maxPositions && this.candidateQueue.length > 0) {
      // Deep tier first, then score desc, then fresher. Re-validate live price/liq before opening.
      const sorted = [...this.candidateQueue].sort((a, b) => {
        if (a.tier !== b.tier) return a.tier === 'deep' ? -1 : 1;
        const scoreDiff = b.score - a.score;
        return scoreDiff !== 0 ? scoreDiff : b.queuedAt - a.queuedAt;
      });

      for (const candidate of sorted) {
        const mint = candidate.evalResult.token.id;
        if (this.ghosts.has(mint)) continue;

        // Live re-validation: price must still be authoritative-ish and liquidity above floor
        const reDetails = marketDataProvider.getMarketPriceDetails(mint);
        const reSnap = marketDataProvider.getSnapshot(mint);
        const livePrice =
          reDetails.priceUsd ?? reSnap?.priceUsd ?? candidate.evalResult.token.usdPrice ?? 0;
        const liveLiq = reSnap?.liquidityUsd ?? candidate.evalResult.token.liquidity ?? 0;
        if (livePrice <= 0) continue;
        // Queue age prune already done, but skip if candidate is too stale at open time
        if (now - candidate.queuedAt > (this.ctx.config.maxCandidateAgeMinutes ?? 30) * 60_000)
          continue;
        const liqFloor = Math.max(
          this.ctx.config.minLiquidityUsd ?? 750,
          (candidate.evalResult.token.liquidity ?? 0) *
            (this.ctx.config.liquidityCollapseThresholdRatio ?? 0.25)
        );
        // If live liq is known and has collapsed below floor, skip this candidate (was a 1s wick)
        if (reSnap?.liquidityUsd != null && liveLiq > 0 && liveLiq <= liqFloor) continue;
        if (reDetails.status === 'PROVISIONAL' || reSnap?.source === 'initial-discovery-seed')
          continue;

        const entryPrice = livePrice;

        const ghost: GhostPosition = {
          mint,
          symbol: candidate.evalResult.token.symbol ?? mint,
          entryPriceUsd: entryPrice,
          entryScore: candidate.evalResult.candidateScore,
          highestPriceUsd: entryPrice,
          openedAt: now,
          featuresJson: candidate.featuresJson,
          tpProfile: candidate.evalResult.tpProfileOverride ?? null,
          launchpad: (candidate.evalResult.token as { launchpad?: string }).launchpad ?? null,
          targetsHit: 0,
          // Pre-entry price history — what the LSTM scorer can see at decision time.
          sequenceJson: JSON.stringify(candidate.evalResult.token.priceHistory ?? []),
          timeSeries: [[now, entryPrice, candidate.evalResult.token.liquidity ?? 0]],
          priceHistory: [
            { price: entryPrice, timestamp: now, liquidity: candidate.evalResult.token.liquidity },
          ],
          tapeHistory: candidate.evalResult.token.tapeHistory as
            | { buys: number; sells: number; timestamp: number }[]
            | undefined,
          spreadHistory: candidate.evalResult.token.tapeHistory ? undefined : undefined,
          entryMarketCapUsd:
            (candidate.evalResult.token.fdv as number | undefined) ??
            candidate.evalResult.token.fdvUsd,
          entryLiquidityUsd: candidate.evalResult.token.liquidity ?? 0,
          lastKnownLiquidityUsd: candidate.evalResult.token.liquidity ?? 0,
          volatilityScaler: candidate.evalResult.volatilityScaler ?? 0,
          takeProfitMultiples: this.ctx.config.takeProfitMultiples,
        };

        this.ghosts.set(mint, ghost);
        const idx = this.candidateQueue.indexOf(candidate);
        if (idx >= 0) this.candidateQueue.splice(idx, 1);

        log(
          this.logFile,
          `[GHOST] Opened: ${ghost.symbol} (${mint.slice(0, 6)}..${mint.slice(-4)}) @ $${entryPrice.toFixed(8)} (score: ${ghost.entryScore}, ${this.ghosts.size}/${this.maxPositions} active)`,
          'info'
        );
        break;
      }
    }
  }

  private _advanceTpLadder(ghost: GhostPosition, currentPrice: number): void {
    if (!this.ctx) return;
    const tps = ghost.takeProfitMultiples ?? this.ctx.config.takeProfitMultiples;
    while (ghost.targetsHit < tps.length) {
      const nextTp = tps[ghost.targetsHit];
      if (nextTp !== undefined && currentPrice >= ghost.entryPriceUsd * nextTp) {
        ghost.targetsHit++;
      } else {
        break;
      }
    }
  }

  private _closeGhost(mint: string, ghost: GhostPosition, exitPrice: number, reason: string): void {
    if (!this.ctx || !this.mlSvc) return;
    this.ghosts.delete(mint);
    const solPrice = this.lastSolPriceUsd > 0 ? this.lastSolPriceUsd : 100;

    // Compute weighted PnL across TP rungs, mirroring real partial-close mechanics (fractions are of remaining, not equal split).
    // Apply paper slippage (sell fee) so ghost PnL is realistic, not optimistic.
    const tps = ghost.takeProfitMultiples ?? this.ctx.config.takeProfitMultiples;
    const fracs = this.ctx.config.takeProfitFractions?.length
      ? this.ctx.config.takeProfitFractions
      : [this.ctx.config.takeProfitFraction, this.ctx.config.takeProfitFraction];
    const n = tps.length;
    const exitMult = exitPrice / ghost.entryPriceUsd;
    const feeFactor = Math.max(0, (10000 - this.ctx.config.slippageBps) / 10000);
    let pnlMultiple = 0;
    let remaining = 1.0;
    if (n > 0) {
      for (let i = 0; i < ghost.targetsHit && i < n; i++) {
        const frac = Math.min(Math.max(fracs[i] ?? fracs[fracs.length - 1] ?? 0.6, 0), 1);
        const sold = remaining * frac;
        // TP proceeds are at the TP multiple, discounted by fee
        pnlMultiple += sold * ((tps[i] ?? 1) * feeFactor - 1);
        remaining -= sold;
      }
    }
    // Remaining runner exits at current market price, also fee-discounted
    pnlMultiple += remaining * (exitMult * feeFactor - 1);

    // Clean label: require net >2% after fees, only genuine TP/trailing/breakeven wins. Dust-profit
    // liquidity/EPG/stop-loss on 1s wicks no longer train as wins even with locked profit.
    const PROFIT_THRESHOLD = 0.02;
    const isProfitable = pnlMultiple > PROFIT_THRESHOLD;
    const hasLockedProfit = (ghost.targetsHit ?? 0) > 0;
    const hardFailReasons = new Set(['rug-exit', 'stale', 'max-hold']);
    const winningReasons = new Set([
      'take-profit',
      'trailing-stop',
      'tp-trailing-max-exit',
      'adaptive-tp-exit',
      'time-exit',
      'moon-bag-trailing-exit',
      'breakeven-stop',
    ]);
    const label: 0 | 1 =
      isProfitable &&
      winningReasons.has(reason) &&
      !hardFailReasons.has(reason) &&
      !(reason === 'max-hold' && !hasLockedProfit) &&
      reason !== 'stale'
        ? 1
        : 0;

    const holdSeconds = (Date.now() - ghost.openedAt) / 1000;
    const sample: TrainingSample = {
      mint,
      symbol: ghost.symbol,
      label,
      featuresJson: ghost.featuresJson,
      realizedPnlUsd: pnlMultiple * 100, // notional $100 stake
      entryScore: ghost.entryScore,
      tpProfile: ghost.tpProfile,
      launchpad: ghost.launchpad,
      closedAt: new Date().toISOString(),
      exitReason: reason,
      holdSeconds,
      highestPriceUsd: ghost.highestPriceUsd,
      targetsHit: ghost.targetsHit,
      entryPriceUsd: ghost.entryPriceUsd,
      sequenceJson: ghost.sequenceJson,
      holdTimeSeriesJson: ghost.timeSeries ? JSON.stringify(ghost.timeSeries) : undefined,
    };

    this.ctx.store.addTrainingSample(sample);

    const realizedPnlUsd = pnlMultiple * 100;
    const realizedProceedsUsd = 100 * (1 + pnlMultiple);
    const realizedPnlSol = solPrice > 0 ? realizedPnlUsd / solPrice : 0;
    const realizedProceedsSol = solPrice > 0 ? realizedProceedsUsd / solPrice : 0;
    const entryPriceSol = solPrice > 0 ? ghost.entryPriceUsd / solPrice : 0;

    const trade: ClosedTrade = {
      mint,
      symbol: ghost.symbol,
      exitReason: reason,
      realizedPnlUsd,
      realizedPnlSol,
      realizedProceedsUsd,
      realizedProceedsSol,
      entryUsdValue: 100,
      entryPriceUsd: ghost.entryPriceUsd,
      entryPriceSol,
      highestPriceUsd: ghost.highestPriceUsd,
      holdSeconds,
      closedAt: sample.closedAt,
      entryScore: ghost.entryScore,
      tpProfile: ghost.tpProfile,
      takeProfitMultiples: ghost.takeProfitMultiples ?? this.ctx.config.takeProfitMultiples,
      takeProfitFractions:
        this.ctx.config.takeProfitFractions ??
        (this.ctx.config.takeProfitFraction ? [this.ctx.config.takeProfitFraction] : undefined),
      trailingStopDrawdownPctResolved: this.ctx.config.trailingStopDrawdownPct,
      maxHoldMinutesResolved: this.maxHoldMinutesResolved,
      volatilityScaler: ghost.volatilityScaler ?? 0,
      entryLiquidityUsd: ghost.entryLiquidityUsd ?? 0,
      launchpad: ghost.launchpad,
      targetsHit: ghost.targetsHit,
      isGhost: true,
      mode: 'ghost',
    };

    this.ctx.store.addClosedTrade(trade);
    journalGhostTrade(this.ctx, trade as unknown as Record<string, unknown>);

    log(
      this.logFile,
      `[GHOST] Closed ${ghost.symbol} (${mint.slice(0, 6)}..${mint.slice(-4)}) via ${reason}: ${pnlMultiple >= 0 ? '+' : ''}${(pnlMultiple * 100).toFixed(1)}% → label=${label}`,
      'info'
    );

    if (ghost.targetsHit > 0) {
      this.mlSvc.runParamOptimizerNow().catch((err: unknown) => {
        log(
          this.logFile,
          `[GHOST] Param optimizer error: ${err instanceof Error ? err.message : String(err)}`,
          'debug'
        );
      });
    }

    this.mlSvc.runEntryTunerNow().catch((err: unknown) => {
      log(
        this.logFile,
        `[GHOST] Entry tuner error: ${err instanceof Error ? err.message : String(err)}`,
        'debug'
      );
    });
  }

  /**
   * Opens ghost positions for a pre-ranked list of candidates (used by warmup).
   * Skips mints already tracked or with no valid entry price.
   * Returns the number of positions actually opened.
   */
  openGhostsFromCandidates(candidates: EvaluationResult[]): number {
    if (!this.ctx) return 0;
    const now = Date.now();
    let opened = 0;

    for (const evalResult of candidates) {
      if (this.ghosts.size >= this.maxPositions) break;

      const mint = evalResult.token.id;
      if (this.ghosts.has(mint)) continue;

      const entryPrice = evalResult.token.usdPrice ?? 0;
      if (entryPrice <= 0) continue;

      const features = extractFeatures(evalResult);
      const featuresJson = JSON.stringify(Array.from(features));

      const ghost: GhostPosition = {
        mint,
        symbol: evalResult.token.symbol ?? mint,
        entryPriceUsd: entryPrice,
        entryScore: evalResult.candidateScore,
        highestPriceUsd: entryPrice,
        openedAt: now,
        featuresJson,
        tpProfile: evalResult.tpProfileOverride ?? null,
        launchpad: (evalResult.token as { launchpad?: string }).launchpad ?? null,
        targetsHit: 0,
        // Pre-entry price history — what the LSTM scorer can see at decision time.
        sequenceJson: JSON.stringify(evalResult.token.priceHistory ?? []),
        timeSeries: [[now, entryPrice, evalResult.token.liquidity ?? 0]],
        priceHistory: [
          { price: entryPrice, timestamp: now, liquidity: evalResult.token.liquidity },
        ],
        entryMarketCapUsd: (evalResult.token.fdv as number | undefined) ?? evalResult.token.fdvUsd,
        entryLiquidityUsd: evalResult.token.liquidity ?? 0,
        lastKnownLiquidityUsd: evalResult.token.liquidity ?? 0,
        volatilityScaler: evalResult.volatilityScaler ?? 0,
        takeProfitMultiples: this.ctx.config.takeProfitMultiples,
      };

      this.ghosts.set(mint, ghost);
      opened++;
      log(
        this.logFile,
        `[GHOST] Opened: ${ghost.symbol} (${mint.slice(0, 6)}..${mint.slice(-4)}) @ $${entryPrice.toFixed(8)} (score: ${ghost.entryScore}, ${this.ghosts.size}/${this.maxPositions} active)`,
        'info'
      );
    }

    return opened;
  }

  /**
   * Runs one exit-check cycle using externally-fetched prices (used by warmup).
   * Updates high-water marks and closes positions that hit SL/TP/trailing/max-hold.
   * Does NOT open new positions from the candidate queue.
   * Returns the number of positions closed.
   * Warmup path is intentionally sync (no RPC guards) — _tick uses the full async exit chain.
   */
  tickWithPrices(priceMap: Record<string, { usdPrice?: number }>): number {
    if (!this.ctx || !this.mlSvc) return 0;
    const now = Date.now();
    let closed = 0;

    for (const [mint, ghost] of [...this.ghosts.entries()]) {
      const currentPrice = priceMap[mint]?.usdPrice;

      if (currentPrice !== undefined && currentPrice > 0) {
        if (currentPrice > ghost.highestPriceUsd) ghost.highestPriceUsd = currentPrice;
        this._advanceTpLadder(ghost, currentPrice);
        if (
          ghost.targetsHit >=
          (ghost.takeProfitMultiples ?? this.ctx!.config.takeProfitMultiples).length
        ) {
          this._closeGhost(mint, ghost, currentPrice, 'take-profit');
          closed++;
          continue;
        }
      }

      const age = now - ghost.openedAt;
      let reason: string | null = null;
      if (age >= this.maxHoldMs) reason = 'max-hold';
      else if (currentPrice === undefined || currentPrice <= 0) {
        if (age > STALE_PRICE_GRACE_MS) reason = 'stale';
      } else {
        // Light sync fallback — mirrors old ghost trailing/TP without async guards; _tick does full chain.
        const tps = ghost.takeProfitMultiples ?? this.ctx!.config.takeProfitMultiples;
        if (ghost.targetsHit > 0) {
          if (ghost.targetsHit >= tps.length) reason = 'take-profit';
          else {
            const trailLevel =
              ghost.highestPriceUsd * (1 - this.ctx!.config.trailingStopDrawdownPct);
            if (currentPrice <= trailLevel) reason = 'trailing-stop';
          }
        } else {
          const tp0 = tps[0];
          if (tp0 !== undefined) {
            const armMultiple = 1 + (tp0 - 1) / 2;
            const peakMult = ghost.highestPriceUsd / ghost.entryPriceUsd;
            if (peakMult >= armMultiple) {
              const trailLevel =
                ghost.highestPriceUsd * (1 - this.ctx!.config.trailingStopDrawdownPct);
              if (currentPrice <= trailLevel) reason = 'trailing-stop';
            }
          }
        }
        if (!reason && currentPrice <= ghost.entryPriceUsd * (1 - this.ctx!.config.stopLossPct))
          reason = 'stop-loss';
      }
      if (reason !== null) {
        this._closeGhost(mint, ghost, currentPrice ?? ghost.entryPriceUsd, reason);
        closed++;
      }
    }

    return closed;
  }

  setMaxPositions(n: number): void {
    this.maxPositions = n;
  }

  closeAllGhosts(reason: string): number {
    let closed = 0;
    for (const [mint, ghost] of [...this.ghosts.entries()]) {
      this._closeGhost(mint, ghost, ghost.entryPriceUsd, reason);
      closed++;
    }
    return closed;
  }

  // Exposed for testing and warmup
  getGhostCount(): number {
    return this.ghosts.size;
  }
  getActiveMints(): string[] {
    return Array.from(this.ghosts.keys());
  }
  getCandidateQueueLength(): number {
    return this.candidateQueue.length;
  }
  getGhost(mint: string): GhostPosition | undefined {
    return this.ghosts.get(mint);
  }
}

export const ghostTrader = new GhostTrader();
