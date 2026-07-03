import fs from 'node:fs';
import { log } from '#core/utils.js';
import {
  ClosedTrade,
  Config,
  EvaluationResult,
  MlScoreResult,
  TrainingSample,
} from '#types/index.js';
import { StateStore } from '#core/store.js';
import { extractFeatures } from './features.js';
import { buildSequence } from './sequence-features.js';
import { EnsembleModel } from './ensemble-model.js';
import { TrainMetrics } from './scoring-model.js';
import { RlExitOptimizer } from './rl-exit-optimizer.js';
import {
  ENTRY_PARAM_SPECS,
  PARAM_SPECS,
  applyGradientStep,
  estimateEntryGradients,
  estimateGradients,
  estimateGradientsFromSamples,
  weightedAverageGradients,
  extractCurrentEntryParams,
  extractCurrentParams,
  scoreExitParams,
  restoreParams,
} from './param-optimizer.js';

const DEFAULT_RETRAIN_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_MIN_SAMPLES = 25;
const MIN_TRADES_FOR_OPTIMIZER = 5;
const MIN_GHOST_SAMPLES_FOR_OPTIMIZER = 15;
// Bounded ring of retrain metrics kept under `ml:retrainHistory` so model drift
// is visible over time instead of being overwritten on every cycle.
const MAX_RETRAIN_HISTORY = 50;

export class MlService {
  private scoringModel: EnsembleModel | null = null;
  private store: StateStore | null = null;
  private config: Config | null = null;
  private retrainTimer: NodeJS.Timeout | null = null;
  private enabled = false;
  private retrainIntervalMs = DEFAULT_RETRAIN_INTERVAL_MS;
  private logFile = '';
  // Hard gating stays OFF (advisory only) until the model has seen enough REAL closed
  // trades. Checked at startup and on each retrain cycle — not on the scoring hot path.
  private gateMinRealTrades = 5;
  private gatingActive = false;
  private prevCircuitBreakerActive = false;
  // Regime-conditioned RL optimizer for exit params (enabled by default via ML_RL_OPTIMIZER=true).
  // When active it governs SL/TP/trailing instead of the central-difference step.
  private rlOptimizer: RlExitOptimizer | null = null;

  init(store: StateStore, config: Config): void {
    this.store = store;
    this.config = config;
    this.logFile = config.logFile;
    this.enabled = process.env.ML_ENABLED === 'true';
    this.retrainIntervalMs = Number(
      process.env.ML_RETRAIN_INTERVAL_MS ?? DEFAULT_RETRAIN_INTERVAL_MS
    );
    this.gateMinRealTrades = config.mlGateMinRealTrades;
    const minSamples = Number(process.env.ML_MIN_TRAINING_SAMPLES ?? DEFAULT_MIN_SAMPLES);
    this.scoringModel = new EnsembleModel(minSamples);
    if (process.env.ML_RL_OPTIMIZER !== 'false') {
      this.rlOptimizer = new RlExitOptimizer();
    }
  }

  async initialize(): Promise<void> {
    if (!this.enabled || !this.scoringModel || !this.store) return;

    // NOTE: By design, the bot does not load 'ml:last_params' from the store at startup.
    // Starting fresh from standard yaml/env configuration baselines on reboot is an intentional
    // feature to prevent strategy parameters from suffering unbounded drift over long periods.
    let loaded = this.scoringModel.loadWeights((key) => this.store!.getKV(key));

    if (!loaded) {
      const fallbackPath = 'ml-pretrained-weights.json';
      if (fs.existsSync(fallbackPath)) {
        try {
          const kvStore = JSON.parse(fs.readFileSync(fallbackPath, 'utf8')) as Record<
            string,
            string
          >;
          loaded = this.scoringModel.loadWeights((key) => kvStore[key] ?? null);
          if (loaded) {
            this.scoringModel.saveWeights((key, val) => this.store!.upsertKV(key, val));
            log(
              this.logFile,
              '[ML] Loaded pre-trained weights from ml-pretrained-weights.json.',
              'info'
            );
          }
        } catch {
          log(this.logFile, '[ML] Failed to read ml-pretrained-weights.json — ignoring.', 'warn');
        }
      }
    }

    // Warm-start the RL exit policy from persisted weights when enabled.
    if (this.rlOptimizer?.available()) {
      const rlLoaded = this.rlOptimizer.loadWeights((key) => this.store!.getKV(key));
      log(
        this.logFile,
        `[ML RL] Exit-parameter optimizer enabled. Persisted policy loaded: ${rlLoaded}.`,
        'info'
      );
    }

    // Check gate once at startup so we don't query the DB on every getScore() call
    this._checkGating();

    if (!this.scoringModel.nativeAvailable()) {
      const hasWeights = loaded && this.scoringModel.getIsTrained();
      if (hasWeights) {
        log(
          this.logFile,
          '[ML] WARN: Rust addon not built — running in INFERENCE-ONLY mode. ' +
            'ML gating active but model cannot retrain. Run `npm run build:rust:win` to enable retraining.',
          'warn'
        );
      } else {
        log(
          this.logFile,
          '[ML] ERROR: Rust addon not built AND no pre-trained weights found. ' +
            'ML GATING IS DISABLED — all trades pass unchecked. ' +
            'Run `npm run build:rust:win` or place ml-pretrained-weights.json in the project root.',
          'error'
        );
      }
    }

    const backend = this.scoringModel.nativeAvailable()
      ? 'native'
      : this.scoringModel.tsFallbackActive()
        ? 'ts-fallback'
        : 'shadow';
    log(this.logFile, `[ML] Initialized. Weights loaded: ${loaded}. Backend: ${backend}.`, 'info');
  }

  /**
   * Scores an approved evaluation result. Returns null if ML is disabled.
   * Call this only after rule-based checks have passed (approved=true candidate).
   */
  getScore(evalResult: EvaluationResult): MlScoreResult | null {
    if (!this.enabled || !this.scoringModel || !this.config) return null;

    const threshold = this.config.mlScoreGateThreshold;
    const features = extractFeatures(evalResult);
    const sequence = buildSequence(evalResult.token.priceHistory);
    const launchpad = (evalResult.token as { launchpad?: string }).launchpad ?? null;
    const result = this.scoringModel.predict(features, sequence, threshold, launchpad);

    // Detect circuit breaker state transitions and log them
    const breakerNow = this.scoringModel.getCircuitBreakerActive();
    if (!this.prevCircuitBreakerActive && breakerNow) {
      log(
        this.logFile,
        '[ML] Circuit breaker activated — block rate exceeded threshold. ML gate paused until rate normalizes or model retrains.',
        'warn'
      );
    } else if (this.prevCircuitBreakerActive && !breakerNow) {
      log(
        this.logFile,
        '[ML] Circuit breaker reset — block rate normalized. ML gate reactivated.',
        'info'
      );
    }
    this.prevCircuitBreakerActive = breakerNow;

    if (!this.gatingActive && result.blocked) {
      return { ...result, blocked: false };
    }

    return result;
  }

  start(): void {
    if (!this.enabled) return;
    this.retrainTimer = setInterval(() => {
      this._retrain().catch((err: unknown) => {
        log(
          this.logFile,
          `[ML] Retrain error: ${err instanceof Error ? err.message : String(err)}`,
          'error'
        );
      });
    }, this.retrainIntervalMs);

    log(this.logFile, `[ML] Started. Retrain interval: ${this.retrainIntervalMs / 1000}s.`, 'info');
  }

  stop(): void {
    if (this.retrainTimer) {
      clearInterval(this.retrainTimer);
      this.retrainTimer = null;
    }
  }

  isModelTrained(): boolean {
    return this.scoringModel?.getIsTrained() ?? false;
  }

  getMinSamples(): number {
    return Number(process.env.ML_MIN_TRAINING_SAMPLES ?? DEFAULT_MIN_SAMPLES);
  }

  async retrainNeuralNetworkOnly(): Promise<void> {
    if (!this.scoringModel || !this.store) return;
    if (!this.scoringModel.nativeAvailable()) {
      log(this.logFile, '[ML] Skipping NN retrain — Rust addon not available.', 'debug');
      return;
    }

    const samples: TrainingSample[] = this.store.getTrainingSamples(500);
    if (samples.length === 0) return;

    const before = this.scoringModel.getIsTrained();
    const metrics = await this.scoringModel.train(samples);
    const after = this.scoringModel.getIsTrained();

    if (metrics) {
      if (!before && after) {
        log(
          this.logFile,
          `[ML] Model trained for the first time — train: ${metrics.trainSamples}, test: ${metrics.testSamples}. Exiting shadow mode.`,
          'info'
        );
      }
      log(
        this.logFile,
        `[ML] Model retrained — train: ${metrics.trainSamples} samples, acc ${(metrics.accuracy * 100).toFixed(1)}%, loss ${metrics.loss.toFixed(4)} (${metrics.epochsRan} epochs) | test: ${metrics.testSamples} samples, acc ${(metrics.testAccuracy * 100).toFixed(1)}%, prec ${(metrics.testPrecision * 100).toFixed(1)}%, recall ${(metrics.testRecall * 100).toFixed(1)}%, loss ${metrics.testLoss.toFixed(4)}`,
        'info'
      );
      this._recordRetrainMetrics(metrics);
    }

    this.scoringModel.saveWeights((key, val) => this.store!.upsertKV(key, val));

    // Re-check gate after retrain in case enough real trades have accumulated
    this._checkGating();

    // Adapt entry gates to the regime as ghost samples accumulate (trains during ghost mode).
    await this.runEntryTunerNow(samples);
  }

  /**
   * Runs just the parameter optimizer step without retraining the neural net.
   * Called immediately after a real position closes at TP so winning trade
   * patterns nudge exit parameters (SL, trailing stop, TP multiples) right away
   * rather than waiting for the next 30-minute retrain cycle.
   */
  async runParamOptimizerNow(): Promise<void> {
    if (!this.store || !this.config) return;

    // In RL mode the policy governs exit params on the retrain cycle; run it here
    // too so a fresh TP win is reflected immediately, then return.
    if (this.rlOptimizer?.available()) {
      this._runRlExitOptimizer(this.store.getTrainingSamples(500));
      return;
    }

    const trades = this.store.getRecentClosedTrades(200);
    const samples = this.store.getTrainingSamples(500);

    const hasEnoughData =
      trades.length >= MIN_TRADES_FOR_OPTIMIZER ||
      samples.length >= MIN_GHOST_SAMPLES_FOR_OPTIMIZER;
    if (!hasEnoughData) return;

    const changes = this._applyGuardedExitStep(trades, samples);
    if (!changes) return; // step rejected by drift guard — params held unchanged

    this.store.upsertKV('ml:last_params', JSON.stringify(extractCurrentParams(this.config)));

    const changedKeys = Object.keys(changes);
    if (changedKeys.length > 0) {
      const summary = changedKeys
        .map((k) => {
          const c = changes[k]!;
          return `${k}: ${c.before.toFixed(4)} → ${c.after.toFixed(4)}`;
        })
        .join(', ');
      log(
        this.logFile,
        `[ML Params] TP-triggered (real: ${trades.length}, ghost: ${samples.length}): ${summary}`,
        'info'
      );
    }
  }

  /**
   * Adapts the entry gates (minHolderCount, minCandidateScore, minLiquidityUsd) to the day's
   * regime using ghost + real trade outcomes. Ghost trades are taken regardless of the live
   * gate, so this gradient is two-directional — it can loosen a gate (admit more) or tighten
   * it. Mutates the live Config in place; the engine reads it on the next scan. No-op when the
   * tuner is disabled, when below the min-sample guard, or (in live mode) when not opted in.
   */
  async runEntryTunerNow(prefetchedSamples?: TrainingSample[]): Promise<void> {
    if (!this.store || !this.config) return;
    if (!this.config.entryTunerEnabled) return;
    if (!this.config.paperTrading && !this.config.entryTunerLiveEnabled) return;

    const samples: TrainingSample[] = prefetchedSamples ?? this.store.getTrainingSamples(500);
    if (samples.length < this.config.entryTunerMinSamples) return;

    const current = extractCurrentEntryParams(this.config);
    const gradients = estimateEntryGradients(samples, current, ENTRY_PARAM_SPECS);
    const scoreBefore = this.config.minCandidateScore;
    const changes = applyGradientStep(this.config, gradients, ENTRY_PARAM_SPECS);

    // In a dead market every ghost trade is a loss, so the gradient is one-directional
    // UP — the tuner would ratchet minCandidateScore higher and starve the bot of trades.
    // Only allow it to RAISE the score gate once we have enough REAL closed trades to
    // justify being pickier; downward (loosening) steps are always allowed so the
    // "no trades → no data" deadlock can still break.
    // Ghost trades don't count toward the "real data" guard — only on-chain outcomes justify
    // tightening the score gate, which can starve the bot of trades if raised prematurely.
    const realTrades = this.store
      .getRecentClosedTrades(this.gateMinRealTrades * 10)
      .filter((t) => !t.isGhost).length;
    if (realTrades < this.gateMinRealTrades && this.config.minCandidateScore > scoreBefore) {
      this.config.minCandidateScore = scoreBefore;
      delete changes['minCandidateScore'];
    }

    this.store.upsertKV('ml:entry_params', JSON.stringify(extractCurrentEntryParams(this.config)));

    const changedKeys = Object.keys(changes);
    if (changedKeys.length > 0) {
      const summary = changedKeys
        .map((k) => {
          const c = changes[k]!;
          return `${k}: ${c.before.toFixed(2)} → ${c.after.toFixed(2)}`;
        })
        .join(', ');
      log(this.logFile, `[Entry Tuner] ${summary} (from ${samples.length} samples)`, 'info');
    }
  }

  /**
   * Runs the opt-in RL exit-parameter optimizer. Returns true when it handled
   * exit-param tuning (so the caller skips the central-difference path), false
   * when disabled, unavailable, or short on data.
   */
  private _runRlExitOptimizer(samples: TrainingSample[]): boolean {
    if (!this.rlOptimizer || !this.config || !this.rlOptimizer.available()) return false;

    const result = this.rlOptimizer.optimize(this.config, samples);
    if (!result) return false;

    this.rlOptimizer.saveWeights((key, val) => this.store!.upsertKV(key, val));

    const changedKeys = Object.keys(result.changes);
    const summary =
      changedKeys.length > 0
        ? changedKeys
            .map((k) => {
              const c = result.changes[k]!;
              return `${k}: ${c.before.toFixed(4)} → ${c.after.toFixed(4)}`;
            })
            .join(', ')
        : 'no change';
    log(
      this.logFile,
      `[ML RL] Exit policy updated (samples: ${result.samples}, regime: ${result.regime.toFixed(2)}, avgReward: ${result.finalAvgReward.toFixed(2)}): ${summary}`,
      'info'
    );
    return true;
  }

  /**
   * Persists the latest retrain metrics two ways: `ml:lastRetrainMetrics` (the
   * single latest snapshot, kept for back-compat) and a bounded
   * `ml:retrainHistory` ring so accuracy/precision trends are visible over time
   * and model degradation can be caught.
   */
  private _recordRetrainMetrics(metrics: TrainMetrics): void {
    if (!this.store) return;
    this.store.upsertKV('ml:lastRetrainMetrics', JSON.stringify(metrics));

    let history: Array<TrainMetrics & { at: string }> = [];
    try {
      const raw = this.store.getKV('ml:retrainHistory');
      if (raw) history = JSON.parse(raw) as Array<TrainMetrics & { at: string }>;
    } catch {
      history = [];
    }
    history.push({ ...metrics, at: new Date().toISOString() });
    if (history.length > MAX_RETRAIN_HISTORY) {
      history = history.slice(history.length - MAX_RETRAIN_HISTORY);
    }
    this.store.upsertKV('ml:retrainHistory', JSON.stringify(history));
  }

  /**
   * Computes the combined real+ghost gradient, applies one exit-parameter step,
   * then validates it: if the step would LOWER the replayed net-PnL objective on
   * the same trades/samples, it is reverted. This drift guard keeps the online
   * optimizer from ratcheting into worse configs when a finite, clamped step
   * (or TP-ordering fixup) overshoots the local gradient.
   *
   * Returns the accepted changes (possibly empty), or null when the step was
   * rejected and reverted.
   */
  private _applyGuardedExitStep(
    trades: ClosedTrade[],
    samples: TrainingSample[]
  ): Record<string, { before: number; after: number }> | null {
    if (!this.config) return null;

    const before = extractCurrentParams(this.config);
    const beforeScore = scoreExitParams(trades, samples, before);

    const realGrad = estimateGradients(trades, before, PARAM_SPECS);
    const ghostGrad = estimateGradientsFromSamples(samples, before, PARAM_SPECS);
    const combined = weightedAverageGradients(realGrad, trades.length, ghostGrad, samples.length);
    const changes = applyGradientStep(this.config, combined, PARAM_SPECS);

    if (Object.keys(changes).length === 0) return changes;

    const afterScore = scoreExitParams(trades, samples, extractCurrentParams(this.config));
    // Tolerance scales with the objective magnitude so floating-point noise on a
    // large PnL doesn't trip the guard, while genuine regressions are caught.
    const tolerance = Math.max(1e-6, Math.abs(beforeScore) * 1e-3);
    if (afterScore < beforeScore - tolerance) {
      restoreParams(this.config, before);
      log(
        this.logFile,
        `[ML Params] Step rejected by drift guard — replay net PnL would drop ${beforeScore.toFixed(2)} → ${afterScore.toFixed(2)}. Params held.`,
        'warn'
      );
      return null;
    }
    return changes;
  }

  private _checkGating(): void {
    if (this.gatingActive || !this.store) return;
    // Ghost trades (isGhost=true) don't count — gate must be backed by real on-chain outcomes.
    const realTrades = this.store
      .getRecentClosedTrades(this.gateMinRealTrades * 10)
      .filter((t) => !t.isGhost).length;
    if (realTrades >= this.gateMinRealTrades) {
      this.gatingActive = true;
      log(
        this.logFile,
        `[ML] Gate activated after ${realTrades} real closed trades — now enforcing confidence threshold.`,
        'info'
      );
    }
  }

  private async _retrain(): Promise<void> {
    if (!this.scoringModel || !this.store || !this.config) return;

    log(this.logFile, '[ML] Starting retrain cycle...', 'info');

    // 1. Load training samples and retrain
    const samples: TrainingSample[] = this.store.getTrainingSamples(500);
    if (samples.length > 0) {
      const before = this.scoringModel.getIsTrained();
      const metrics = await this.scoringModel.train(samples);
      const after = this.scoringModel.getIsTrained();

      if (!after) {
        log(
          this.logFile,
          `[ML] Insufficient samples (${samples.length}) — remaining in shadow mode.`,
          'info'
        );
      } else if (metrics) {
        if (!before) {
          log(
            this.logFile,
            `[ML] Model trained for the first time — train: ${metrics.trainSamples}, test: ${metrics.testSamples}. Exiting shadow mode.`,
            'info'
          );
        }
        log(
          this.logFile,
          `[ML] Retrain complete — train: ${metrics.trainSamples} samples, acc ${(metrics.accuracy * 100).toFixed(1)}%, loss ${metrics.loss.toFixed(4)} (${metrics.epochsRan} epochs) | test: ${metrics.testSamples} samples, acc ${(metrics.testAccuracy * 100).toFixed(1)}%, prec ${(metrics.testPrecision * 100).toFixed(1)}%, recall ${(metrics.testRecall * 100).toFixed(1)}%, loss ${metrics.testLoss.toFixed(4)}`,
          'info'
        );
        this._recordRetrainMetrics(metrics);
      }

      this.scoringModel.saveWeights((key, val) => this.store!.upsertKV(key, val));
    }

    // 2. Re-check gate and run parameter optimizer (real trades + ghost samples combined)
    this._checkGating();

    const trades = this.store.getRecentClosedTrades(200);

    // When the RL optimizer is enabled and available, it governs exit params
    // (regime-conditioned) in place of the central-difference gradient step.
    if (this._runRlExitOptimizer(samples)) {
      await this.runEntryTunerNow(samples);
      log(this.logFile, '[ML] Retrain cycle complete.', 'info');
      return;
    }

    // Reuse the samples already fetched above for the neural net retrain
    const hasEnoughData =
      trades.length >= MIN_TRADES_FOR_OPTIMIZER ||
      samples.length >= MIN_GHOST_SAMPLES_FOR_OPTIMIZER;

    if (hasEnoughData) {
      const changes = this._applyGuardedExitStep(trades, samples);
      if (changes) {
        const changedKeys = Object.keys(changes);
        if (changedKeys.length > 0) {
          const summary = changedKeys
            .map((k) => {
              const c = changes[k]!;
              return `${k}: ${c.before.toFixed(4)} → ${c.after.toFixed(4)}`;
            })
            .join(', ');
          log(
            this.logFile,
            `[ML] Param optimizer updated (real: ${trades.length}, ghost: ${samples.length}): ${summary}`,
            'info'
          );
        }

        this.store.upsertKV('ml:last_params', JSON.stringify(extractCurrentParams(this.config)));
      }
    }

    // 3. Fuller entry-gate refit on the combined ghost + real dataset every cycle (~30m).
    await this.runEntryTunerNow(samples);

    log(this.logFile, '[ML] Retrain cycle complete.', 'info');
  }
}

export const mlService = new MlService();
