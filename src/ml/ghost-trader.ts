import { log } from '#core/utils.js';
import {
  Context,
  EvaluationResult,
  GhostPosition,
  TrainingSample,
  ClosedTrade,
} from '#types/index.js';
import { extractFeatures } from './features.js';
import { MlService } from './ml-service.js';

const DEFAULT_TICK_INTERVAL_MS = 1000;
const DEFAULT_MAX_POSITIONS = 10;
const DEFAULT_MAX_HOLD_MINUTES = 15;
const CANDIDATE_QUEUE_CAP = 50;
const STALE_PRICE_GRACE_MS = 5 * 60_000;

interface GhostCandidate {
  evalResult: EvaluationResult;
  featuresJson: string;
  queuedAt: number;
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
  private readonly maxHoldMs: number;

  constructor() {
    this.tickIntervalMs = Number(process.env.GHOST_TICK_INTERVAL_MS ?? DEFAULT_TICK_INTERVAL_MS);
    this.maxPositions = Number(process.env.GHOST_MAX_POSITIONS ?? DEFAULT_MAX_POSITIONS);
    this.maxHoldMs =
      Number(process.env.GHOST_MAX_HOLD_MINUTES ?? DEFAULT_MAX_HOLD_MINUTES) * 60_000;
  }

  start(ctx: Context, mlSvc: MlService): void {
    this.ctx = ctx;
    this.mlSvc = mlSvc;
    this.logFile = ctx.config.logFile;
    this.minScore = Number(process.env.GHOST_MIN_SCORE ?? ctx.config.minCandidateScore);

    this.timer = setInterval(() => {
      this._tick().catch((err: unknown) => {
        log(
          this.logFile,
          `[Ghost] Tick error: ${err instanceof Error ? err.message : String(err)}`,
          'error'
        );
      });
    }, this.tickIntervalMs);

    log(
      this.logFile,
      `[Ghost] Started. Interval: ${this.tickIntervalMs / 1000}s, max positions: ${this.maxPositions}.`,
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
   */
  notifyCandidate(evalResult: EvaluationResult): void {
    if (!this.ctx) return;
    if (evalResult.candidateScore < this.minScore) return;

    const features = extractFeatures(evalResult);
    const featuresJson = JSON.stringify(Array.from(features));

    this.candidateQueue.push({ evalResult, featuresJson, queuedAt: Date.now() });
    if (this.candidateQueue.length > CANDIDATE_QUEUE_CAP) {
      this.candidateQueue.shift();
    }
  }

  private async _tick(): Promise<void> {
    if (!this.ctx || !this.mlSvc) return;
    const now = Date.now();

    // Step 1: Update ghost prices from the in-memory market snapshot cache and check exits
    for (const [mint, ghost] of this.ghosts) {
      const snapshot = this.ctx.state.marketSnapshots.get(mint);
      const currentPrice = snapshot?.usdPrice;

      if (currentPrice !== undefined && currentPrice > 0) {
        if (currentPrice > ghost.highestPriceUsd) ghost.highestPriceUsd = currentPrice;
        this._advanceTpLadder(ghost, currentPrice);
      }

      ghost.timeSeries = ghost.timeSeries || [];
      if (currentPrice !== undefined && currentPrice > 0) {
        ghost.timeSeries.push([
          now,
          currentPrice,
          snapshot?.liquidityUsd ?? snapshot?.liquidity ?? 0,
        ]);
        if (ghost.timeSeries.length > 2500) {
          ghost.timeSeries.shift();
        }
      }

      const exitReason = this._checkExit(ghost, currentPrice, now);
      if (exitReason !== null) {
        this._closeGhost(mint, ghost, currentPrice ?? ghost.entryPriceUsd, exitReason);
      }
    }

    // Step 2: Open a new ghost from the highest-scoring queued candidate not already tracked
    if (this.ghosts.size < this.maxPositions && this.candidateQueue.length > 0) {
      // Sort descending by candidateScore; among equals, prefer fresher entries
      const sorted = [...this.candidateQueue].sort((a, b) => {
        const scoreDiff = b.evalResult.candidateScore - a.evalResult.candidateScore;
        return scoreDiff !== 0 ? scoreDiff : b.queuedAt - a.queuedAt;
      });

      for (const candidate of sorted) {
        const mint = candidate.evalResult.token.id;
        if (this.ghosts.has(mint)) continue;

        const entryPrice = candidate.evalResult.token.usdPrice ?? 0;
        if (entryPrice <= 0) continue;

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
        };

        this.ghosts.set(mint, ghost);
        const idx = this.candidateQueue.indexOf(candidate);
        if (idx >= 0) this.candidateQueue.splice(idx, 1);

        log(
          this.logFile,
          `[Ghost] Opened: ${ghost.symbol} @ $${entryPrice.toFixed(8)} (score: ${ghost.entryScore}, ${this.ghosts.size}/${this.maxPositions} active)`,
          'info'
        );
        break;
      }
    }
  }

  private _advanceTpLadder(ghost: GhostPosition, currentPrice: number): void {
    if (!this.ctx) return;
    const tps = this.ctx.config.takeProfitMultiples;
    while (ghost.targetsHit < tps.length) {
      const nextTp = tps[ghost.targetsHit];
      if (nextTp !== undefined && currentPrice >= ghost.entryPriceUsd * nextTp) {
        ghost.targetsHit++;
      } else {
        break;
      }
    }
  }

  private _checkExit(
    ghost: GhostPosition,
    currentPrice: number | undefined,
    now: number
  ): string | null {
    if (!this.ctx) return null;
    const config = this.ctx.config;
    const age = now - ghost.openedAt;

    if (age >= this.maxHoldMs) return 'max-hold';

    if (currentPrice === undefined || currentPrice <= 0) {
      return age > STALE_PRICE_GRACE_MS ? 'stale' : null;
    }

    if (currentPrice <= ghost.entryPriceUsd * (1 - config.stopLossPct)) return 'stop-loss';

    const tps = config.takeProfitMultiples;
    if (ghost.targetsHit > 0) {
      // All TP rungs cleared — close the remaining fraction
      if (ghost.targetsHit >= tps.length) return 'take-profit';
      // Trailing stop armed after first TP rung cleared
      const trailLevel = ghost.highestPriceUsd * (1 - config.trailingStopDrawdownPct);
      if (currentPrice <= trailLevel) return 'trailing-stop';
    } else {
      // Before first TP: arm protective trailing stop at midpoint to first TP
      const tp0 = tps[0];
      if (tp0 !== undefined) {
        const armMultiple = 1 + (tp0 - 1) / 2;
        const peakMult = ghost.highestPriceUsd / ghost.entryPriceUsd;
        if (peakMult >= armMultiple) {
          const trailLevel = ghost.highestPriceUsd * (1 - config.trailingStopDrawdownPct);
          if (currentPrice <= trailLevel) return 'trailing-stop';
        }
      }
    }

    return null;
  }

  private _closeGhost(mint: string, ghost: GhostPosition, exitPrice: number, reason: string): void {
    if (!this.ctx || !this.mlSvc) return;
    this.ghosts.delete(mint);

    // Compute weighted PnL across TP rungs, mirroring real partial-close mechanics.
    // Each TP rung gets an equal fraction of the notional $100 stake.
    const tps = this.ctx.config.takeProfitMultiples;
    const n = tps.length;
    const exitMult = exitPrice / ghost.entryPriceUsd;
    let pnlMultiple = 0;
    let remaining = 1.0;
    if (n > 0) {
      const frac = 1 / n;
      for (let i = 0; i < ghost.targetsHit && i < n; i++) {
        pnlMultiple += frac * ((tps[i] ?? 1) - 1);
        remaining -= frac;
      }
    }
    pnlMultiple += remaining * (exitMult - 1);

    // A genuine win requires a TP or trailing-stop exit with positive net PnL.
    // Max-hold and stale exits are labeled 0 — momentum faded without hitting a target.
    const label: 0 | 1 =
      (reason === 'take-profit' || reason === 'trailing-stop') && pnlMultiple > 0 ? 1 : 0;

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

    const trade: ClosedTrade = {
      mint,
      symbol: ghost.symbol,
      exitReason: reason,
      realizedPnlUsd: pnlMultiple * 100,
      realizedPnlSol: 0,
      realizedProceedsUsd: 100 * (1 + pnlMultiple),
      realizedProceedsSol: 0,
      entryUsdValue: 100,
      entryPriceUsd: ghost.entryPriceUsd,
      entryPriceSol: 0,
      highestPriceUsd: ghost.highestPriceUsd,
      holdSeconds,
      closedAt: sample.closedAt,
      entryScore: ghost.entryScore,
      tpProfile: ghost.tpProfile,
      takeProfitMultiples: this.ctx.config.takeProfitMultiples,
      takeProfitFractions: this.ctx.config.takeProfitFraction
        ? [this.ctx.config.takeProfitFraction]
        : undefined,
      trailingStopDrawdownPctResolved: this.ctx.config.trailingStopDrawdownPct,
      maxHoldMinutesResolved: this.ctx.config.maxHoldMinutes,
      volatilityScaler: 1,
      entryLiquidityUsd: 0,
      launchpad: ghost.launchpad,
      targetsHit: ghost.targetsHit,
      isGhost: true,
    };

    this.ctx.store.addClosedTrade(trade);

    log(
      this.logFile,
      `[Ghost] Closed ${ghost.symbol} via ${reason}: ${pnlMultiple >= 0 ? '+' : ''}${(pnlMultiple * 100).toFixed(1)}% → label=${label}`,
      'info'
    );

    if (ghost.targetsHit > 0) {
      this.mlSvc.runParamOptimizerNow().catch((err: unknown) => {
        log(
          this.logFile,
          `[Ghost] Param optimizer error: ${err instanceof Error ? err.message : String(err)}`,
          'debug'
        );
      });
    }

    this.mlSvc.runEntryTunerNow().catch((err: unknown) => {
      log(
        this.logFile,
        `[Ghost] Entry tuner error: ${err instanceof Error ? err.message : String(err)}`,
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
      };

      this.ghosts.set(mint, ghost);
      opened++;
      log(
        this.logFile,
        `[Ghost] Opened: ${ghost.symbol} @ $${entryPrice.toFixed(8)} (score: ${ghost.entryScore}, ${this.ghosts.size}/${this.maxPositions} active)`,
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
   */
  tickWithPrices(priceMap: Record<string, { usdPrice?: number }>): number {
    if (!this.ctx || !this.mlSvc) return 0;
    const now = Date.now();
    let closed = 0;

    for (const [mint, ghost] of this.ghosts) {
      const currentPrice = priceMap[mint]?.usdPrice;

      if (currentPrice !== undefined && currentPrice > 0) {
        if (currentPrice > ghost.highestPriceUsd) ghost.highestPriceUsd = currentPrice;
        this._advanceTpLadder(ghost, currentPrice);
      }

      const exitReason = this._checkExit(ghost, currentPrice, now);
      if (exitReason !== null) {
        this._closeGhost(mint, ghost, currentPrice ?? ghost.entryPriceUsd, exitReason);
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
