import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import yaml from 'js-yaml';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

// Helper to make __filename work in ESM
const __filename = fileURLToPath(import.meta.url);

import { ENTRY_PARAM_SPECS, PARAM_SPECS } from '../src/ml/param-optimizer.js';
import { DEFAULT_STRATEGY } from '../src/core/strategy-loader.js';

// Only the first 4 exit params (SL, trailing stop, TP×2) can be faithfully simulated
// from peak price alone. The remaining 4 (early-guard, early-drop, liquidity-collapse
// thresholds) require tick-by-tick time-series data that the JSONL history format does
// not carry — including them lets mutation randomise values that have zero effect on
// measured fitness, so the GA converges to noise on those axes.
const EXIT_SPECS_SIMULATABLE = PARAM_SPECS.slice(0, 4);
// minSurvivalMomentum and minBreakoutMultiplier require pre-entry price history which
// is not recorded in closed trade journals — exclude them to avoid the momentum feature
// being hardcoded to 1.0 and filtering out every trade whenever these params mutate > 1.0.
const ENTRY_SPECS_SIMULATABLE = ENTRY_PARAM_SPECS.filter(
  (s) => s.key !== 'minSurvivalMomentum' && s.key !== 'minBreakoutMultiplier'
);
const ALL_SPECS = [...ENTRY_SPECS_SIMULATABLE, ...EXIT_SPECS_SIMULATABLE];

const POPULATION_SIZE = 50;
const GENERATIONS = 20;
const MUTATION_RATE = 0.2;
const MUTATION_STRENGTH = 0.1;

interface Metrics {
  totalPnlUsd: number;
  winRate: number;
  tradesTaken: number;
  sharpe: number;
}

interface Individual {
  id: number;
  params: Record<string, number>;
  fitness: number;
  metrics: Metrics;
}

/** A reconstructed historical trade used to score a parameter set. */
interface HistorySample {
  mint: string;
  symbol: string;
  featuresJson: string;
  realizedPnlUsd: number;
  entryScore: number;
  entryPriceUsd: number;
  highestPriceUsd: number;
}

/** Main thread → worker: evaluate one individual against the sample set. */
interface EvaluateRequest {
  type: 'EVALUATE';
  payload: { id: number; params: Record<string, number>; samples: HistorySample[] };
}

/** Worker → main thread: the fitness/metrics for an evaluated individual. */
interface ResultResponse {
  type: 'RESULT';
  payload: { id: number; fitness: number; metrics: Metrics };
}

if (!isMainThread) {
  // ── WORKER THREAD ──────────────────────────────────────────────────────────

  // Need to import dynamically to use functions in the worker
  void import('../src/ml/param-optimizer.js').then((paramOptimizer) => {
    const { decodeEntryFeatures } = paramOptimizer;

    parentPort?.on('message', (msg: EvaluateRequest) => {
      if (msg.type === 'EVALUATE') {
        const { id, params, samples } = msg.payload;

        // Let's copy how simulateSamplePnl works roughly to get per-trade PnL
        // to compute Sharpe Ratio. The prompt said to compute Sharpe Ratio.
        // We will do a manual loop over samples using the provided params.

        const minScore = params['minCandidateScore'] ?? 0;
        const minLiq = params['minLiquidityUsd'] ?? 0;

        let totalPnl = 0;
        let wins = 0;
        let tradesTaken = 0;
        const pnls: number[] = [];

        for (const s of samples) {
          if (s.entryScore < minScore) continue;
          const decoded = decodeEntryFeatures(s.featuresJson);
          if (!decoded || decoded.liquidityUsd < minLiq) continue;

          // Apply basic filters
          const minHolders = params['minHolderCount'] ?? 0;
          if (decoded.holderCount < minHolders) continue;
          const minOrganic = params['minOrganicScore'] ?? -100;
          if (decoded.organicScore < minOrganic) continue;
          const maxFdvToLiq = params['maxFdvToLiquidity'] ?? 100;
          if (decoded.fdvToLiquidity > maxFdvToLiq) continue;

          // We will use the sample's realizedPnlUsd if exit params are not fully replayed,
          // but to truly respect exit params we need to simulate. Since `simulateSamplePnl`
          // isn't exported, we use a simple approximation based on peak mult.
          const entryPriceUsd = s.entryPriceUsd;
          const highestPriceUsd = s.highestPriceUsd;

          let pnl = 0;
          if (entryPriceUsd > 0 && highestPriceUsd) {
            const stopLossPct = params['stopLossPct'] ?? 0.15;
            const trailingStop = params['trailingStopDrawdownPct'] ?? 0.12;
            const tp0 = params['takeProfitMultiples_0'] ?? 1.3;
            const tp1 = params['takeProfitMultiples_1'] ?? 2.1;

            const stake = 100; // Notional stake
            const peakMult = highestPriceUsd / entryPriceUsd;

            if (peakMult <= 1) {
              pnl = -stopLossPct * stake;
            } else {
              let remaining = 1.0;
              const split = 0.5;
              if (peakMult >= tp0) {
                pnl += stake * remaining * split * (tp0 - 1);
                remaining -= split;
              }
              if (peakMult >= tp1) {
                pnl += stake * remaining * (tp1 - 1);
                remaining = 0;
              }
              if (remaining > 0) {
                const trailingExitMult = peakMult * (1 - trailingStop);
                const exitMult = Math.max(1 - stopLossPct, trailingExitMult);
                pnl += stake * remaining * (exitMult - 1);
              }
            }
          } else {
            // fallback if prices aren't available, just use realized
            pnl = s.realizedPnlUsd || 0;
          }

          pnls.push(pnl);
          totalPnl += pnl;
          tradesTaken++;
          if (pnl > 0) wins++;
        }

        let sharpe = 0;
        if (tradesTaken > 0) {
          const avgPnl = totalPnl / tradesTaken;
          const variance = pnls.reduce((sum, p) => sum + Math.pow(p - avgPnl, 2), 0) / tradesTaken;
          const stdDev = Math.sqrt(variance);
          sharpe = stdDev > 1e-6 ? avgPnl / stdDev : avgPnl;
        }

        // Fitness is Sharpe ratio, but also discourage taking no trades
        const fitness = tradesTaken > 0 ? sharpe * Math.log1p(tradesTaken) : -100;

        const result: ResultResponse = {
          type: 'RESULT',
          payload: {
            id,
            fitness,
            metrics: {
              totalPnlUsd: totalPnl,
              winRate: tradesTaken > 0 ? wins / tradesTaken : 0,
              tradesTaken,
              sharpe,
            },
          },
        };
        parentPort?.postMessage(result);
      }
    });
  });
} else {
  // ── MAIN THREAD ────────────────────────────────────────────────────────────

  const args = process.argv.slice(2);
  const baseStrategyPath =
    (args.includes('--base') ? args[args.indexOf('--base') + 1] : undefined) ??
    path.join('strategies', 'standard.yaml');
  const explicitData = args.includes('--data') ? args[args.indexOf('--data') + 1] : undefined;

  function discoverJournals(): string[] {
    const journals: string[] = [];
    for (const dir of ['logs/paper-trading', 'logs/live-trading']) {
      if (!fs.existsSync(dir)) continue;
      for (const session of fs.readdirSync(dir)) {
        const p = path.join(dir, session, 'trade-journal.jsonl');
        if (fs.existsSync(p)) journals.push(p);
      }
    }
    return journals.sort();
  }

  async function loadHistory(journalPathOrPaths: string | string[]): Promise<HistorySample[]> {
    const paths = Array.isArray(journalPathOrPaths) ? journalPathOrPaths : [journalPathOrPaths];
    const existing = paths.filter((p) => fs.existsSync(p));
    if (existing.length === 0) {
      console.warn(`No history files found. Continuing with empty array.`);
      return [];
    }
    const samples: HistorySample[] = [];
    for (const journalPath of existing) {
      const rl = readline.createInterface({
        input: fs.createReadStream(journalPath),
        crlfDelay: Infinity,
      });
      try {
        for await (const line of rl) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const trade = JSON.parse(trimmed) as Record<string, unknown>;

            const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
            const safeLog1p = (v: number) => Math.log1p(Math.max(0, v));

            const f = new Float32Array(18).fill(0);
            f[0] = safeLog1p(Number(trade['entryLiquidityUsd'] ?? 0));
            f[2] = safeLog1p(Number(trade['holderCount'] ?? 10)); // proxy
            f[5] = 0.5;
            f[6] = safeLog1p(Number(trade['entryPriceUsd'] ?? 0) * 1e9);
            f[7] = 0.08;
            f[8] = 0.33;
            f[9] = clamp(Number(trade['entryScore'] ?? 50) / 100, 0, 1);
            f[10] = clamp(Number(trade['volatilityScaler'] ?? 0), 0, 2);
            f[11] = 1.0;
            f[12] = 0.5;
            f[14] = 0.3;
            f[15] = 1.0;

            samples.push({
              mint: String(trade['mint'] ?? 'unknown'),
              symbol: String(trade['symbol'] ?? 'UNKNOWN'),
              featuresJson: JSON.stringify(Array.from(f)),
              realizedPnlUsd: Number(trade['realizedPnlUsd'] ?? 0),
              entryScore: Number(trade['entryScore'] ?? 50),
              entryPriceUsd: Number(trade['entryPriceUsd'] ?? 0),
              highestPriceUsd: Number(trade['highestPriceUsd'] ?? 0),
            });
          } catch {
            /* skip malformed lines */
          }
        }
      } finally {
        rl.close();
      }
    }
    return samples;
  }

  function loadBaseStrategy(filepath: string): Record<string, number> {
    const params: Record<string, number> = {};
    const defaults = DEFAULT_STRATEGY as unknown as Record<string, number>;
    if (fs.existsSync(filepath)) {
      const parsed = (yaml.load(fs.readFileSync(filepath, 'utf-8')) ?? {}) as Record<
        string,
        unknown
      >;
      const tpRaw = parsed['takeProfitMultiples'];
      const tp = Array.isArray(tpRaw) ? (tpRaw as number[]) : undefined;
      for (const spec of ALL_SPECS) {
        if (spec.key.startsWith('takeProfitMultiples_')) {
          const idxPart = /takeProfitMultiples_(\d+)$/.exec(spec.key)?.[1];
          const idx = idxPart !== undefined ? parseInt(idxPart, 10) : NaN;
          if (tp && tp[idx] !== undefined) {
            params[spec.key] = tp[idx];
          } else {
            params[spec.key] = defaults[spec.key] ?? spec.min;
          }
        } else if (parsed[spec.key] !== undefined) {
          params[spec.key] = Number(parsed[spec.key]);
        } else {
          params[spec.key] = defaults[spec.key] ?? spec.min;
        }
      }
    } else {
      console.warn(`Base strategy ${filepath} not found, using default bounds.`);
      for (const spec of ALL_SPECS) {
        params[spec.key] = defaults[spec.key] ?? spec.min;
      }
    }
    return params;
  }

  /** Clamps tp0 below tp1 in-place when both are present. */
  function enforceTpOrder(params: Record<string, number>): void {
    const tp0 = params['takeProfitMultiples_0'];
    const tp1 = params['takeProfitMultiples_1'];
    if (tp0 !== undefined && tp1 !== undefined && tp0 >= tp1) {
      params['takeProfitMultiples_0'] = tp1 - 0.1;
    }
  }

  function generateIndividual(
    id: number,
    base: Record<string, number>,
    isBase = false
  ): Individual {
    const params = { ...base };
    if (!isBase) {
      for (const spec of ALL_SPECS) {
        // Random mutation across the range
        if (Math.random() < 0.5) {
          const range = spec.max - spec.min;
          let val = spec.min + Math.random() * range;
          if (spec.integer) val = Math.round(val);
          params[spec.key] = val;
        }
      }
    }
    enforceTpOrder(params);
    return {
      id,
      params,
      fitness: -Infinity,
      metrics: { totalPnlUsd: 0, winRate: 0, tradesTaken: 0, sharpe: 0 },
    };
  }

  function mutate(params: Record<string, number>): Record<string, number> {
    const next = { ...params };
    for (const spec of ALL_SPECS) {
      if (Math.random() < MUTATION_RATE) {
        const range = spec.max - spec.min;
        const delta = (Math.random() * 2 - 1) * MUTATION_STRENGTH * range;
        let val = (next[spec.key] ?? spec.min) + delta;
        val = Math.max(spec.min, Math.min(spec.max, val));
        if (spec.integer) val = Math.round(val);
        next[spec.key] = val;
      }
    }
    enforceTpOrder(next);
    return next;
  }

  function crossover(
    p1: Record<string, number>,
    p2: Record<string, number>
  ): Record<string, number> {
    const child: Record<string, number> = {};
    for (const spec of ALL_SPECS) {
      child[spec.key] = (Math.random() < 0.5 ? p1[spec.key] : p2[spec.key]) ?? spec.min;
    }
    enforceTpOrder(child);
    return child;
  }

  async function evaluatePopulation(
    population: Individual[],
    samples: HistorySample[],
    workers: Worker[]
  ): Promise<void> {
    if (workers.length === 0) return;
    return new Promise((resolve, reject) => {
      let completed = 0;

      const onResult = (msg: ResultResponse) => {
        if (msg.type === 'RESULT') {
          const { id, fitness, metrics } = msg.payload;
          const ind = population.find((i) => i.id === id);
          if (ind) {
            ind.fitness = fitness;
            ind.metrics = metrics;
            completed++;
          }
          if (completed === population.length) {
            resolve();
          }
        }
      };

      // Ensure listeners are fresh
      for (const w of workers) {
        w.removeAllListeners('message');
        w.removeAllListeners('error');
        w.on('message', onResult);
        w.on('error', reject);
      }

      for (let i = 0; i < population.length; i++) {
        const individual = population[i];
        const worker = workers[i % workers.length];
        if (!individual || !worker) continue;
        const request: EvaluateRequest = {
          type: 'EVALUATE',
          payload: {
            id: individual.id,
            params: individual.params,
            samples,
          },
        };
        worker.postMessage(request);
      }
    });
  }

  async function run() {
    const dataSources: string | string[] = explicitData
      ? explicitData
      : (() => {
          const journals = discoverJournals();
          return journals.length > 0 ? journals : 'mock-trade-history.jsonl';
        })();
    const label = Array.isArray(dataSources)
      ? `${dataSources.length} session journal(s)`
      : dataSources;
    console.log(`Loading history data from ${label}...`);
    const samples = await loadHistory(dataSources);
    console.log(`Loaded ${samples.length} historical trades.`);

    if (samples.length === 0) {
      console.error('No historical trades to optimize against. Exiting.');
      process.exit(1);
    }

    console.log(`Loading base strategy from ${baseStrategyPath}...`);
    const baseParams = loadBaseStrategy(baseStrategyPath);

    let population: Individual[] = [];
    population.push(generateIndividual(0, baseParams, true)); // Keep base strategy in gen 0
    for (let i = 1; i < POPULATION_SIZE; i++) {
      population.push(generateIndividual(i, baseParams, false));
    }

    const numWorkers = Math.min(os.cpus().length, 8);
    console.log(`Spawning ${numWorkers} worker threads...`);
    const workers: Worker[] = [];

    const tsLoaders = process.execArgv.filter(
      (arg, i, arr) =>
        arg.includes('tsx') ||
        arg.includes('ts-node') ||
        arg === '--import' ||
        arg === '--require' ||
        arg === '--loader' ||
        (i > 0 &&
          (arr[i - 1] === '--import' || arr[i - 1] === '--require' || arr[i - 1] === '--loader'))
    );
    let workerExecArgv: string[];
    if (tsLoaders.length > 0) {
      workerExecArgv = tsLoaders;
    } else {
      try {
        workerExecArgv = ['--import', import.meta.resolve('tsx')];
      } catch {
        workerExecArgv = ['--import', 'tsx'];
      }
    }

    for (let i = 0; i < numWorkers; i++) {
      workers.push(new Worker(__filename, { execArgv: workerExecArgv }));
    }

    for (let gen = 0; gen < GENERATIONS; gen++) {
      process.stdout.write(`Generation ${gen + 1}/${GENERATIONS} evaluating... `);
      await evaluatePopulation(population, samples, workers);

      population.sort((a, b) => b.fitness - a.fitness);

      const best = population[0];
      if (best) {
        console.log(
          `Best Sharpe: ${best.metrics.sharpe.toFixed(2)} | Trades: ${best.metrics.tradesTaken} | Win Rate: ${(best.metrics.winRate * 100).toFixed(1)}% | PnL: $${best.metrics.totalPnlUsd.toFixed(2)}`
        );
      }

      // Next generation
      const nextGen: Individual[] = [];
      // Elitism: Keep top 20%
      const eliteCount = Math.max(1, Math.floor(POPULATION_SIZE * 0.2));
      for (let i = 0; i < eliteCount; i++) {
        const elite = population[i];
        if (elite) nextGen.push({ ...elite, id: i, fitness: -Infinity }); // reset fitness for safety
      }

      // Breed remainder
      while (nextGen.length < POPULATION_SIZE) {
        const p1 = population[Math.floor(Math.random() * eliteCount)]?.params;
        const p2 = population[Math.floor(Math.random() * eliteCount)]?.params;
        if (!p1 || !p2) break;
        let childParams = crossover(p1, p2);
        childParams = mutate(childParams);
        nextGen.push({
          id: nextGen.length,
          params: childParams,
          fitness: -Infinity,
          metrics: { totalPnlUsd: 0, winRate: 0, tradesTaken: 0, sharpe: 0 },
        });
      }

      population = nextGen;
    }

    // Final evaluation to ensure metrics are filled for elite
    await evaluatePopulation(population, samples, workers);
    population.sort((a, b) => b.fitness - a.fitness);

    // Terminate workers
    for (const w of workers) {
      void w.terminate();
    }

    const bestParams = population[0]?.params;
    if (!bestParams) {
      console.error('Optimization produced no candidates. Exiting.');
      process.exit(1);
    }

    // Output file prompting
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(
      '\nOptimization complete! Enter a name for the new strategy (e.g. optimized-v1): ',
      (answer) => {
        rl.close();
        let filename = answer.trim() || `optimized-${Date.now()}`;
        if (!filename.endsWith('.yaml')) filename += '.yaml';

        const outPath = path.join('strategies', filename);

        // Convert flat params back to nested config shape where needed (like takeProfitMultiples)
        const outConfig: Record<string, unknown> = {};
        const tpMultiples = [
          baseParams['takeProfitMultiples_0'] ?? 1.3,
          baseParams['takeProfitMultiples_1'] ?? 2.1,
        ];
        for (const [k, v] of Object.entries(bestParams)) {
          if (k === 'takeProfitMultiples_0') tpMultiples[0] = Number(v.toFixed(3));
          else if (k === 'takeProfitMultiples_1') tpMultiples[1] = Number(v.toFixed(3));
          else outConfig[k] = Number(Number(v).toFixed(3)); // clean decimals
        }
        outConfig['takeProfitMultiples'] = tpMultiples;

        // Load base config structure to inject into
        let baseConfig: Record<string, unknown> = {};
        if (fs.existsSync(baseStrategyPath)) {
          baseConfig = (yaml.load(fs.readFileSync(baseStrategyPath, 'utf-8')) ?? {}) as Record<
            string,
            unknown
          >;
        }
        const finalConfig = { ...baseConfig, ...outConfig };
        finalConfig['name'] = filename.replace('.yaml', '');
        finalConfig['description'] = 'Generated by Genetic Algorithm Optimizer';

        fs.writeFileSync(outPath, yaml.dump(finalConfig));
        console.log(`\n✅ Saved optimized strategy to ${outPath}`);
        console.log('You can now hot-swap to it at runtime or use it as default.');
      }
    );
  }

  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
