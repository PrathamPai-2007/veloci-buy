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

  const liveTrades = readJsonl<ClosedTrade>(tradeJournalPath);
  const paperEvents = readJsonl<TradeEvent>(paperJournalPath);

  const allClosedTrades: ClosedTrade[] = [...liveTrades];

  // Fallback: reconstruct from paper events only when trade-journal is absent/empty
  if (allClosedTrades.length === 0 && paperEvents.length > 0) {
    const byMint = new Map<string, TradeEvent[]>();
    for (const ev of paperEvents) {
      if (!byMint.has(ev.mint)) byMint.set(ev.mint, []);
      byMint.get(ev.mint)!.push(ev);
    }

    for (const [mint, events] of byMint) {
      const buy = events.find((e) => e.event === 'buy');
      const last = events[events.length - 1];
      // ponytail: only reconstruct fully-closed positions; partial TP sells are not exits
      if (buy && last && last.event === 'close') {
        const realizedPnlUsd = events.reduce((sum, e) => sum + (e.realizedPnlUsd || 0), 0);
        const realizedPnlSol = events.reduce((sum, e) => sum + (e.realizedPnlSol || 0), 0);
        const realizedProceedsUsd = events.reduce((sum, e) => sum + (e.proceedsUsd || 0), 0);
        const realizedProceedsSol = events.reduce((sum, e) => sum + (e.proceedsSol || 0), 0);

        allClosedTrades.push({
          mint,
          symbol: buy.symbol,
          exitReason: last.reason || 'unknown',
          realizedPnlUsd,
          realizedPnlSol,
          realizedProceedsUsd,
          realizedProceedsSol,
          entryPriceUsd: buy.priceUsd,
          entryPriceSol: buy.priceSol || 0,
          closedAt: last.timestamp,
          entryUsdValue: realizedProceedsUsd - realizedPnlUsd,
          highestPriceUsd: events.reduce((m, e) => Math.max(m, e.priceUsd), 0),
          holdSeconds:
            (new Date(last.timestamp).getTime() - new Date(buy.timestamp).getTime()) / 1000,
          entryScore: 0,
          initialBuyAmountSol: buy.solAmount || null,
        });
      }
    }
  } else if (paperEvents.length > 0 && allClosedTrades.length > 0) {
    safeConsole(
      'log',
      '[pnl-analyzer] paper-trade-journal exists but skipped — trade-journal has records'
    );
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
