import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatUsd, safeConsole, atomicWriteFile } from '#core/utils.js';

interface TradeEvent {
  event: string;
  mint: string;
  symbol: string;
  priceUsd: number;
  priceSol?: number;
  tokenAmount?: string;
  solAmount?: string;
  proceedsUsd?: number;
  proceedsSol?: number;
  realizedPnlUsd?: number;
  realizedPnlSol?: number;
  reason?: string;
  timestamp: string;
  mode: string;
}

interface ClosedTrade {
  mint: string;
  symbol: string;
  exitReason: string;
  realizedPnlUsd: number;
  realizedPnlSol: number;
  realizedProceedsUsd: number;
  realizedProceedsSol: number;
  entryUsdValue: number;
  entryPriceUsd: number;
  entryPriceSol: number;
  highestPriceUsd: number;
  holdSeconds: number;
  closedAt: string;
  entryScore: number;
  initialBuyAmountSol: string | number | null;
  isGhost?: boolean;
  mode?: string;
}

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const content = fs.readFileSync(filePath, 'utf8').trim();
    if (!content) return [];
    return content
      .split('\n')
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as T];
        } catch {
          return [];
        }
      });
  } catch (err) {
    safeConsole('error', `Failed to read ${filePath}:`, err);
    return [];
  }
}

function formatSol(val: number): string {
  return `${val.toFixed(6)} SOL`;
}

export function generatePnlReport(sessionDir: string): string {
  const tradeJournalPath = path.join(sessionDir, 'trade-journal.jsonl');
  const paperJournalPath = path.join(sessionDir, 'paper-trade-journal.jsonl');

  const rawLiveTrades = readJsonl<ClosedTrade>(tradeJournalPath);
  // Ghost trades are stored separately (ghost-trade-journal.jsonl) but old journals may mix — filter here.
  const liveTrades = rawLiveTrades.filter(
    (t) =>
      !(t as unknown as { isGhost?: boolean }).isGhost &&
      (t as unknown as { mode?: string }).mode !== 'ghost'
  );
  const paperEventsRaw = readJsonl<TradeEvent>(paperJournalPath);
  // Filter ghost paper events (should never be there, but guard)
  const paperEvents = paperEventsRaw.filter(
    (e) =>
      (e as unknown as { isGhost?: boolean }).isGhost !== true &&
      (e as unknown as { mode?: string }).mode !== 'ghost'
  );

  const allClosedTrades: ClosedTrade[] = [...liveTrades];
  // Dedup key is mint+closedAt (not just mint) so relaunched same symbol or duplicate bug doesn't collapse distinct trades but still catches exact duplicates.
  const closedKeys = new Set(liveTrades.map((trade) => `${trade.mint}:${trade.closedAt}`));
  const closedMintsLegacy = new Set(liveTrades.map((t) => t.mint));

  // Add paper-only closed trades without duplicating records already in trade-journal.
  if (paperEvents.length > 0) {
    const byMint = new Map<string, TradeEvent[]>();
    for (const ev of paperEvents) {
      if (!byMint.has(ev.mint)) byMint.set(ev.mint, []);
      byMint.get(ev.mint)!.push(ev);
    }

    for (const [mint, events] of byMint) {
      // Dedup identical paper close events (duplicate rug→SL bug with same outAmount/proceeds within 60s)
      const uniqueCloses: TradeEvent[] = [];
      const seenOut = new Set<string>();
      for (const ev of events) {
        if (ev.event !== 'close' && ev.event !== 'sell') {
          uniqueCloses.push(ev);
          continue;
        }
        const key = `${ev.tokenAmount ?? ''}:${ev.proceedsSol ?? ''}:${ev.proceedsUsd ?? ''}`;
        // Only dedup consecutive duplicate closes with identical proceeds within short window
        const last = uniqueCloses[uniqueCloses.length - 1];
        if (last && last.event === 'close' && ev.event === 'close' && seenOut.has(key)) {
          // duplicate — skip double-counting
          continue;
        }
        seenOut.add(key);
        uniqueCloses.push(ev);
      }
      const buy = uniqueCloses.find((e) => e.event === 'buy');
      const last = uniqueCloses[uniqueCloses.length - 1];
      if (!buy || !last || last.event !== 'close') continue;
      const closedKey = `${mint}:${last.timestamp}`;
      if (closedKeys.has(closedKey) || closedMintsLegacy.has(mint)) {
        // Already covered in trade-journal (legacy mint-only check keeps old single-trade-per-mint journals correct)
        // Use key-based check for ghost-fixed journals
        if (closedKeys.has(closedKey)) continue;
        // If legacy journal had this mint, skip reconstruction to avoid double count
        continue;
      }
      // Fix absurd SOL PnL: if realizedPnlSol == proceedsSol while USD is negative, it's missing cost. Derive via USD/solPrice.
      const rawPnlUsd = uniqueCloses.reduce((sum, e) => sum + (e.realizedPnlUsd || 0), 0);
      let rawPnlSol = uniqueCloses.reduce((sum, e) => sum + (e.realizedPnlSol || 0), 0);
      const realizedProceedsUsd = uniqueCloses.reduce((sum, e) => sum + (e.proceedsUsd || 0), 0);
      const realizedProceedsSol = uniqueCloses.reduce((sum, e) => sum + (e.proceedsSol || 0), 0);
      if (
        Math.abs(rawPnlSol - realizedProceedsSol) < 1e-9 &&
        rawPnlUsd < 0 &&
        realizedProceedsSol > 0 &&
        realizedProceedsUsd > 0
      ) {
        const solPrice = realizedProceedsUsd / realizedProceedsSol;
        rawPnlSol = solPrice > 0 ? rawPnlUsd / solPrice : 0;
      } else if (
        Math.abs(rawPnlSol - realizedProceedsSol) < 1e-9 &&
        rawPnlUsd < 0 &&
        realizedProceedsSol > 0
      ) {
        rawPnlSol = 0;
      }

      allClosedTrades.push({
        mint,
        symbol: buy.symbol,
        exitReason: last.reason || 'unknown',
        realizedPnlUsd: rawPnlUsd,
        realizedPnlSol: rawPnlSol,
        realizedProceedsUsd,
        realizedProceedsSol,
        entryPriceUsd: buy.priceUsd,
        entryPriceSol: buy.priceSol || 0,
        closedAt: last.timestamp,
        entryUsdValue: realizedProceedsUsd - rawPnlUsd,
        highestPriceUsd: uniqueCloses.reduce((m, e) => Math.max(m, e.priceUsd ?? 0), 0),
        holdSeconds:
          (new Date(last.timestamp).getTime() - new Date(buy.timestamp).getTime()) / 1000,
        entryScore: 0,
        initialBuyAmountSol: buy.solAmount || null,
      });
      closedKeys.add(closedKey);
      closedMintsLegacy.add(mint);
    }
  }

  // Correct absurd SOL PnL on legacy journal entries (proceeds-as-PnL) before aggregating — derive via USD
  for (const t of allClosedTrades) {
    if (t.realizedPnlSol != null && t.realizedProceedsSol != null && t.realizedPnlUsd < 0) {
      if (Math.abs(t.realizedPnlSol - t.realizedProceedsSol) < 1e-9 && t.realizedProceedsSol > 0) {
        if (t.realizedProceedsUsd != null && t.realizedProceedsUsd > 0) {
          const solPrice = t.realizedProceedsUsd / t.realizedProceedsSol;
          t.realizedPnlSol = solPrice > 0 ? t.realizedPnlUsd / solPrice : 0;
        } else {
          t.realizedPnlSol = 0;
        }
      }
    }
  }

  let grossProfitUsd = 0;
  let grossProfitSol = 0;
  let totalPnlUsd = 0;
  let totalPnlSol = 0;
  let lostValueUsd = 0;
  let lostValueSol = 0;

  for (const trade of allClosedTrades) {
    const pnlUsd = trade.realizedPnlUsd || 0;
    const pnlSol = trade.realizedPnlSol || 0;

    totalPnlUsd += pnlUsd;
    totalPnlSol += pnlSol;

    if (pnlUsd > 0) {
      grossProfitUsd += pnlUsd;
    } else {
      lostValueUsd += Math.abs(pnlUsd);
    }

    if (pnlSol > 0) {
      grossProfitSol += pnlSol;
    } else {
      lostValueSol += Math.abs(pnlSol);
    }
  }

  const sessionName = path.basename(sessionDir);

  let md = `# PnL Report: ${sessionName}\n\n`;

  md += `## Executive Summary\n\n`;
  md += `| Metric | USD | SOL |\n`;
  md += `| :--- | :--- | :--- |\n`;
  md += `| **Gross Profit** | \`${formatUsd(grossProfitUsd)}\` | \`${formatSol(grossProfitSol)}\` |\n`;
  md += `| **Lost Value** | \`${formatUsd(lostValueUsd)}\` | \`${formatSol(lostValueSol)}\` |\n`;
  md += `| **Net PnL** | **\`${formatUsd(totalPnlUsd)}\`** | **\`${formatSol(totalPnlSol)}\`** |\n`;
  md += `| **Total Trades** | ${allClosedTrades.length} | - |\n\n`;

  md += `## Detailed Trade History\n\n`;
  md += `| Timestamp | Asset | Reason | PnL (USD) | PnL (SOL) | Proceeds (USD) | Proceeds (SOL) |\n`;
  md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;

  for (const trade of allClosedTrades) {
    md += `| ${trade.closedAt || 'N/A'} | ${trade.symbol} | ${trade.exitReason} | ${formatUsd(trade.realizedPnlUsd || 0)} | ${formatSol(trade.realizedPnlSol || 0)} | ${formatUsd(trade.realizedProceedsUsd || 0)} | ${formatSol(trade.realizedProceedsSol || 0)} |\n`;
  }

  md += `\n---\n*Generated by Veloci-Buy PnL Analyzer on ${new Date().toISOString()}*`;

  return md;
}

// CLI entry point
if (fs.realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const targetDir = process.argv[2] || process.cwd();
  const reportPath = path.join(targetDir, 'pnl-report.md');
  const md = generatePnlReport(targetDir);
  atomicWriteFile(reportPath, md)
    .then(() => safeConsole('log', `Report generated: ${reportPath}`))
    .catch((err: unknown) => safeConsole('error', 'Failed to generate report:', err));
}
