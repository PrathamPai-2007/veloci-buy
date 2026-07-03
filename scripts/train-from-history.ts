/**
 * Trains the ML model from historical session data in logs/.
 * Outputs ml-pretrained-weights.json which the bot loads on next startup.
 *
 * Usage:
 *   npm run train-history                              # scan all sessions in logs/
 *   npm run train-history -- logs/paper-trading/...   # specific session directories
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import Database from 'better-sqlite3';
import { ScoringModel } from '../src/ml/scoring-model.js';
import { FEATURE_DIM } from '../src/ml/features.js';

const OUTPUT_FILE = 'ml-pretrained-weights.json';

interface RawSample {
  mint: string;
  symbol: string;
  label: 0 | 1;
  featuresJson: string;
  realizedPnlUsd: number;
  entryScore: number;
  tpProfile: string | null;
  launchpad: string | null;
  closedAt: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function safeLog1p(v: number): number {
  return Math.log1p(Math.max(0, v));
}

function makePartialFeatureVector(trade: Record<string, unknown>): string {
  const f = new Float32Array(FEATURE_DIM).fill(0);
  // Fill the 4 features derivable from trade-journal.jsonl
  f[0] = safeLog1p(Number(trade['entryLiquidityUsd'] ?? 0)); // log_liquidity
  f[5] = 0.5; // sell_ratio neutral
  f[6] = safeLog1p(Number(trade['entryPriceUsd'] ?? 0) * 1e9); // log_micro_price
  f[7] = 0.08; // ~5 min age default
  f[8] = 0.33; // one social link default
  f[9] = clamp(Number(trade['entryScore'] ?? 50) / 100, 0, 1); // candidate_score_norm
  f[10] = clamp(Number(trade['volatilityScaler'] ?? 0), 0, 2); // volatility_scaler
  f[11] = 1.0; // momentum neutral
  f[12] = 0.5; // consistency neutral
  f[14] = 0.3; // fdv_to_liq default
  f[15] = 1.0; // stability neutral
  return JSON.stringify(Array.from(f));
}

// ── Session discovery ─────────────────────────────────────────────────────────

function findSessionDirs(root: string): string[] {
  const dirs: string[] = [];
  if (!fs.existsSync(root)) return dirs;

  function walk(dir: string, depth: number) {
    if (depth > 4) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (
        (entry.name.endsWith('.db') || entry.name === 'trade-journal.jsonl') &&
        entry.isFile()
      ) {
        const parent = path.dirname(full);
        if (!dirs.includes(parent)) dirs.push(parent);
      }
    }
  }

  walk(root, 0);
  return dirs;
}

// ── Data loading ──────────────────────────────────────────────────────────────

function loadFromDb(dbPath: string): RawSample[] {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const tableExists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ml_training_samples'`)
      .get();
    if (!tableExists) {
      db.close();
      return [];
    }
    const rows = db
      .prepare(`SELECT * FROM ml_training_samples ORDER BY closed_at ASC`)
      .all() as Array<{
      mint: string;
      symbol: string;
      label: number;
      features_json: string;
      realized_pnl_usd: number;
      entry_score: number;
      tp_profile: string | null;
      launchpad: string | null;
      closed_at: string;
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
    }));
  } catch {
    return [];
  }
}

async function loadFromJournal(journalPath: string): Promise<RawSample[]> {
  if (!fs.existsSync(journalPath)) return [];
  const samples: RawSample[] = [];

  const rl = readline.createInterface({
    input: fs.createReadStream(journalPath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const trade = JSON.parse(trimmed) as Record<string, unknown>;
      const pnl = Number(trade['realizedPnlUsd'] ?? 0);
      const closedAt = String(trade['closedAt'] ?? trade['timestamp'] ?? new Date().toISOString());
      samples.push({
        mint: String(trade['mint'] ?? 'unknown'),
        symbol: String(trade['symbol'] ?? 'UNKNOWN'),
        label: pnl > 0 ? 1 : 0,
        featuresJson: makePartialFeatureVector(trade),
        realizedPnlUsd: pnl,
        entryScore: Number(trade['entryScore'] ?? 50),
        tpProfile: (trade['tpProfile'] as string | null) ?? null,
        launchpad: (trade['launchpad'] as string | null) ?? null,
        closedAt,
      });
    } catch {
      // skip malformed lines
    }
  }

  return samples;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const targetDirs = args.length > 0 ? args : findSessionDirs('logs');

  if (targetDirs.length === 0) {
    console.log('No session directories found under logs/. Nothing to train on.');
    process.exit(0);
  }

  console.log(
    `Scanning ${targetDirs.length} session director${targetDirs.length === 1 ? 'y' : 'ies'}...`
  );

  const allSamples: RawSample[] = [];
  const seen = new Set<string>();
  let fullCount = 0;
  let partialCount = 0;
  let sessionsWithData = 0;

  for (const dir of targetDirs) {
    let sessionSamples: RawSample[] = [];
    let source = '';

    // Try DB first
    for (const fname of ['sniper-state.db', 'state.db']) {
      const dbPath = path.join(dir, fname);
      if (fs.existsSync(dbPath)) {
        const rows = loadFromDb(dbPath);
        if (rows.length > 0) {
          sessionSamples = rows;
          source = `DB (${rows.length} samples)`;
          fullCount += rows.length;
          break;
        }
      }
    }

    // Fallback to trade-journal.jsonl
    if (sessionSamples.length === 0) {
      const journalPath = path.join(dir, 'trade-journal.jsonl');
      const rows = await loadFromJournal(journalPath);
      if (rows.length > 0) {
        sessionSamples = rows;
        source = `trade-journal.jsonl (${rows.length} partial samples)`;
        partialCount += rows.length;
      }
    }

    if (sessionSamples.length === 0) continue;

    sessionsWithData++;
    let added = 0;
    for (const s of sessionSamples) {
      const key = `${s.mint}_${s.closedAt}`;
      if (!seen.has(key)) {
        seen.add(key);
        allSamples.push(s);
        added++;
      }
    }
    console.log(`  ${path.relative(process.cwd(), dir)}: ${source} → ${added} unique added`);
  }

  console.log('');
  console.log(
    `Total unique samples: ${allSamples.length} (${fullCount} full-feature, ${partialCount} partial)`
  );

  if (allSamples.length === 0) {
    console.log(
      'No training samples found. Run the bot with ML_ENABLED=true to generate data first.'
    );
    process.exit(0);
  }

  const labelOnes = allSamples.filter((s) => s.label === 1).length;
  const labelZeros = allSamples.length - labelOnes;
  console.log(`Label distribution: ${labelOnes} profitable (1) / ${labelZeros} loss (0)`);

  if (partialCount > 0) {
    console.log(
      `Warning: ${partialCount} samples use partial feature reconstruction (4/18 features).`
    );
    console.log(
      '  These come from sessions where ML was disabled. Accuracy will improve as real ML-enabled sessions accumulate.'
    );
  }

  console.log('Training model...');
  const model = new ScoringModel(1);
  await model.train(allSamples);

  const kvStore: Record<string, string> = {};
  model.saveWeights((key, val) => {
    kvStore[key] = val;
  });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(kvStore, null, 2));

  console.log('');
  console.log(`Done. Pre-trained weights saved to: ${OUTPUT_FILE}`);
  console.log('The bot will automatically load these weights on next startup (ML_ENABLED=true).');
  console.log(`Sessions processed with data: ${sessionsWithData}/${targetDirs.length}`);
}

main().catch((err) => {
  console.error('train-history failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
