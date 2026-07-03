/**
 * Offline entry-decision backtest.
 *
 * Measures whether the ML entry score separates winning trades from losing ones,
 * and what gating on each candidate `mlScoreGateThreshold` would do to realized
 * PnL versus the rule-only baseline (admit everything). Unlike `npm run analyze`
 * — which replays *exit* parameters — this evaluates the *entry* decision.
 *
 * It reads the `ml_training_samples` table the bot already writes (features +
 * pre-entry sequence + realized outcome) from one or more session databases.
 *
 * Usage:
 *   npm run backtest                       # scan all sessions under logs/
 *   npm run backtest -- path/to/state.db   # specific database file(s)
 *   npm run backtest -- --shuffle          # sanity check: AUC should collapse to ~0.5
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { TrainingSample } from '../src/types/index.js';
import { runEntryBacktest } from '../src/ml/backtest.js';
import { BacktestReport } from '../src/ml/backtest.types.js';

/** Recursively finds session directories containing a state database. */
function findDbFiles(root: string): string[] {
  const found: string[] = [];
  if (!fs.existsSync(root)) return found;

  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.db')) found.push(full);
    }
  };

  walk(root, 0);
  return found;
}

/** Loads training samples from one session database (read-only). */
function loadSamples(dbPath: string): TrainingSample[] {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const exists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ml_training_samples'`)
      .get();
    if (!exists) {
      db.close();
      return [];
    }
    const rows = db
      .prepare(
        `SELECT mint, symbol, label, features_json, realized_pnl_usd, entry_score,
                tp_profile, launchpad, closed_at, sequence_json
         FROM ml_training_samples
         WHERE features_json IS NOT NULL AND closed_at IS NOT NULL
         ORDER BY closed_at ASC`
      )
      .all() as Array<{
      mint: string;
      symbol: string | null;
      label: number;
      features_json: string;
      realized_pnl_usd: number;
      entry_score: number;
      tp_profile: string | null;
      launchpad: string | null;
      closed_at: string;
      sequence_json: string | null;
    }>;
    db.close();
    return rows.map((r) => ({
      mint: r.mint,
      symbol: r.symbol ?? 'UNKNOWN',
      label: (r.label === 1 ? 1 : 0) as 0 | 1,
      featuresJson: r.features_json,
      realizedPnlUsd: r.realized_pnl_usd,
      entryScore: r.entry_score,
      tpProfile: r.tp_profile,
      launchpad: r.launchpad,
      closedAt: r.closed_at,
      sequenceJson: r.sequence_json ?? undefined,
    }));
  } catch (err) {
    console.error(`  ! failed to read ${dbPath}: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

function fmtUsd(v: number): string {
  const sign = v >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function printReport(report: BacktestReport): void {
  console.log('');
  console.log('═══════════════════ ENTRY-DECISION BACKTEST ═══════════════════');
  console.log(
    `Train: ${report.trainSamples} samples  |  Eval (held-out): ${report.evalSamples} samples`
  );
  console.log(`Native LSTM available: ${report.nativeAvailable ? 'yes' : 'no (shadow mode)'}`);
  console.log(`AUC: ${report.auc.toFixed(3)}   (0.5 = no signal, 1.0 = perfect separation)`);
  if (!report.nativeAvailable) {
    console.log(
      'NOTE: native addon not built — model stays in shadow mode (confidence 0.5),\n' +
        '      so AUC and the sweep are not meaningful. Build with `npm run build:rust`.'
    );
  }
  console.log('');
  console.log('Rule-only baseline (admit every scored candidate):');
  console.log(
    `  win rate ${pct(report.baseline.winRate)}  |  total PnL ${fmtUsd(
      report.baseline.totalPnlUsd
    )}  |  avg/trade ${fmtUsd(report.baseline.avgPnlUsd)}`
  );
  console.log('');
  console.log('Threshold sweep (gate on mlScoreGateThreshold):');
  console.log('  thresh | taken | block | prec  | recall| winRate| avgPnL    | uplift/trade');
  console.log('  -------+-------+-------+-------+-------+--------+-----------+-------------');
  for (const m of report.sweep) {
    console.log(
      `   ${m.threshold.toFixed(2)}  |` +
        ` ${String(m.taken).padStart(5)} |` +
        ` ${String(m.blocked).padStart(5)} |` +
        ` ${pct(m.precision).padStart(5)} |` +
        ` ${pct(m.recall).padStart(5)} |` +
        ` ${pct(m.takenWinRate).padStart(6)} |` +
        ` ${fmtUsd(m.takenAvgPnlUsd).padStart(9)} |` +
        ` ${fmtUsd(m.avgPnlUpliftUsd).padStart(11)}`
    );
  }

  const best = [...report.sweep]
    .filter((m) => m.taken > 0)
    .sort((a, b) => b.avgPnlUpliftUsd - a.avgPnlUpliftUsd)[0];
  console.log('');
  if (best) {
    console.log(
      `Best PnL-uplift threshold: ${best.threshold.toFixed(2)} ` +
        `(${fmtUsd(best.avgPnlUpliftUsd)}/trade over baseline, admits ${best.taken}/${
          report.evalSamples
        }).`
    );
  } else {
    console.log('No threshold admitted any samples — model may be under-confident or untrained.');
  }
  console.log('═══════════════════════════════════════════════════════════════');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const shuffle = args.includes('--shuffle');
  const dbArgs = args.filter((a) => !a.startsWith('--'));

  const dbFiles = dbArgs.length > 0 ? dbArgs : findDbFiles('logs');
  if (dbFiles.length === 0) {
    console.log(
      'No session databases (*.db) found under logs/. Run the bot first to collect data.'
    );
    process.exit(0);
  }

  console.log(`Scanning ${dbFiles.length} database file(s)...`);
  const seen = new Set<string>();
  const all: TrainingSample[] = [];
  for (const dbPath of dbFiles) {
    const rows = loadSamples(dbPath);
    let added = 0;
    for (const s of rows) {
      const key = `${s.mint}_${s.closedAt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(s);
      added++;
    }
    console.log(`  ${path.relative(process.cwd(), dbPath)}: ${rows.length} rows → ${added} unique`);
  }

  const wins = all.filter((s) => s.label === 1).length;
  console.log(`\nTotal unique samples: ${all.length}  (${wins} win / ${all.length - wins} loss)`);
  if (shuffle) console.log('Mode: --shuffle (labels scrambled; expect AUC ≈ 0.5)');

  const report = await runEntryBacktest(all, { shuffleLabels: shuffle });
  if (!report) {
    console.log(
      '\nNot enough samples for a walk-forward split (need ≥10 in the training half).\n' +
        'Keep running the bot with ML_ENABLED=true to accumulate closed trades and ghost samples.'
    );
    process.exit(0);
  }

  printReport(report);
}

main().catch((err) => {
  console.error('Backtest entries script failed:', err);
  process.exit(1);
});
