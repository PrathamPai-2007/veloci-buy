import {
  formatUsd,
  ratioToPercentString,
  runBoundedPool,
  PRIORITY,
  computeSpread,
  isRateLimitError,
} from '#core/utils.js';
import { BURN_OWNERS, TAKE_PROFIT_MULTIPLES } from '#core/config.js';
import { tradingService } from '../trading/trading.service.js';
import { auditService } from '../audit/audit.service.js';
import { Context, MintSignals, Position } from '#types/index.js';

export * from './exit-calculator.js';
export * from './exit-executor.js';
export * from './trade-logger.js';

import {
  getTakeProfitPlan,
  getTakeProfitFraction,
  computeTakeProfitSellAmount,
  getMoodAdjustments,
} from './exit-calculator.js';
import { executePositionExit, sellTakeProfit, startCoolDown } from './exit-executor.js';
import {
  incrementExitReasonMetric,
  buildExitAccounting,
  recordTradeResult,
  recordClosedTrade,
} from './trade-logger.js';
import { describeBurstExit, getBurstExitDecision } from '../burst/index.js';
import { describeSwingExit, getSwingExitDecision } from '../swing/index.js';
import { migrationCooldowns } from '../trading/local-router.js';

const AUDIT_TIMEOUT_ERROR = 'batchGetMintSignals timed out';

export interface PriceRecord {
  usdPrice?: number;
  liquidity?: number;
  bidPrice?: number;
  askPrice?: number;
}

export async function monitorPositions(
  ctx: Context,
  fetchPricesBestEffort: (
    ctx: Context,
    mints: string[],
    label: string,
    apiKey?: string
  ) => Promise<Record<string, PriceRecord>>
): Promise<void> {
  if (ctx.state.positions.size === 0) return;

  const mints = Array.from(ctx.state.positions.keys());

  // Filter out mints that are actively receiving price updates via WebSocket push-stream
  const pollingMints = mints.filter((mint) => !ctx.state.vaultSubscriptions?.has(mint));

  let prices: Record<string, PriceRecord> = {};
  if (pollingMints.length > 0) {
    prices = await fetchPricesBestEffort(
      ctx,
      pollingMints,
      'position refresh',
      ctx.config.jupiterPositionApiKey
    );
  }

  let balanceMap: Awaited<ReturnType<typeof tradingService.getAllWalletTokenBalances>>;
  try {
    balanceMap = await tradingService.getAllWalletTokenBalances(ctx, PRIORITY.MEDIUM);
  } catch (err) {
    ctx.logger(
      `Monitor balance fetch failed, skipping tick: ${err instanceof Error ? err.message : String(err)}`,
      'warn'
    );
    return;
  }

  // Pre-batch security audit signals for all positions due for re-audit (30s cooldown).
  // Stamps timestamps before awaiting the batch so concurrent monitor ticks can't double-fire.
  const now = Date.now();
  const securityAuditDueMints = mints.filter((m) => {
    const pos = ctx.state.positions.get(m);
    return pos && (!pos.lastSecurityAuditAt || now - pos.lastSecurityAuditAt > 30000);
  });
  for (const m of securityAuditDueMints) {
    const pos = ctx.state.positions.get(m);
    if (pos) pos.lastSecurityAuditAt = now;
  }
  const securitySignalsMap = new Map<string, MintSignals>();
  if (securityAuditDueMints.length > 0) {
    try {
      const AUDIT_TIMEOUT_MS = 8000;
      const batchResult = await Promise.race([
        auditService.batchGetMintSignals(ctx, securityAuditDueMints, { priority: PRIORITY.LOW }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`${AUDIT_TIMEOUT_ERROR} after ${AUDIT_TIMEOUT_MS}ms`)),
            AUDIT_TIMEOUT_MS
          )
        ),
      ]);
      for (const [m, s] of batchResult) {
        securitySignalsMap.set(m, s);
      }
      // Clear stamps for mints the batch didn't return (partial success) so they retry next tick.
      for (const m of securityAuditDueMints) {
        if (!securitySignalsMap.has(m)) {
          const pos = ctx.state.positions.get(m);
          if (pos) pos.lastSecurityAuditAt = undefined;
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      ctx.logger(`Batch security audit pre-fetch failed: ${errMsg}`, 'warn');
      // Keep stamps on rate-limit or our own timeout — both indicate RPC pressure and the 30s
      // cooldown prevents an immediate retry storm. Clear on other errors so mints retry next tick.
      if (!isRateLimitError(err) && !errMsg.startsWith(AUDIT_TIMEOUT_ERROR)) {
        for (const m of securityAuditDueMints) {
          const pos = ctx.state.positions.get(m);
          if (pos) pos.lastSecurityAuditAt = undefined;
        }
      }
    }
  }

  await runBoundedPool(
    mints,
    async (mint) => {
      const pos = ctx.state.positions.get(mint);
      if (!pos) return;
      const balance = balanceMap.get(mint) ?? { mint, rawAmount: 0n, decimals: 0, uiAmount: 0 };
      const pRecord = prices[mint];
      const preSignals = securitySignalsMap.get(mint);
      await evaluateSinglePosition(ctx, mint, pos, balance, pRecord, preSignals);
    },
    { concurrency: ctx.config.scanParallelismLight || 5 }
  );
}

export async function closeAllOpenPositions(
  ctx: Context,
  fetchPricesBestEffort: (
    ctx: Context,
    mints: string[],
    label: string,
    apiKey?: string
  ) => Promise<Record<string, PriceRecord>>,
  reason = 'shutdown-exit'
): Promise<void> {
  const mints = Array.from(ctx.state.positions.keys());
  if (mints.length === 0) {
    ctx.logger('No positions to close.');
    return;
  }

  ctx.logger(`Closing ${mints.length} positions for shutdown...`, 'warn', { console: true });
  const prices = await fetchPricesBestEffort(
    ctx,
    mints,
    'shutdown exit',
    ctx.config.jupiterPositionApiKey
  );

  let balanceMap: Awaited<ReturnType<typeof tradingService.getAllWalletTokenBalances>> = new Map();
  try {
    balanceMap = await tradingService.getAllWalletTokenBalances(ctx, PRIORITY.HIGH);
  } catch (err) {
    ctx.logger(
      `Balance batch failed during shutdown close: ${err instanceof Error ? err.message : String(err)}`,
      'warn'
    );
  }

  await runBoundedPool(
    mints,
    async (mint) => {
      const pos = ctx.state.positions.get(mint);
      if (!pos) return;
      try {
        const bal = balanceMap.get(mint) ?? { mint, rawAmount: 0n, decimals: 0, uiAmount: 0 };
        if (bal.rawAmount <= 0n) {
          ctx.store.removePosition(mint);
          return;
        }
        const p = Number(prices[mint]?.usdPrice || pos.lastKnownPriceUsd || pos.entryPriceUsd || 0);
        await monitorService.executePositionExit(ctx, pos, bal, p, bal.rawAmount, reason);
      } catch (e: unknown) {
        ctx.logger(
          `Failed to close ${pos.symbol || mint}: ${e instanceof Error ? e.message : String(e)}`,
          'error',
          { console: true }
        );
      }
    },
    { concurrency: 4 }
  );
}

export const evaluatingMints = new Set<string>();

export async function evaluateSinglePosition(
  ctx: Context,
  mint: string,
  pos: Position,
  balance: { mint: string; rawAmount: bigint; decimals: number; uiAmount: number },
  pRecord: PriceRecord | undefined,
  preSignals: MintSignals | undefined
): Promise<void> {
  const { processingMints } = await import('./exit-executor.js');
  if (processingMints.has(mint)) return;

  if (evaluatingMints.has(mint)) return;
  evaluatingMints.add(mint);

  try {
    if (balance.rawAmount <= 0n) {
      if (!pos.balanceZeroSince) {
        pos.balanceZeroSince = Date.now();
        ctx.logger(
          `Position ${pos.symbol} zero balance detected; tolerating RPC index lag.`,
          'debug'
        );
        return;
      }

      const elapsed = Date.now() - pos.balanceZeroSince;
      if (elapsed < 15000) {
        return;
      }

      pos.realizedPnlUsd = -Number(pos.remainingCostUsd || 0);
      pos.realizedPnlSol = -Number(pos.remainingCostSol || 0);
      pos.remainingCostUsd = 0;
      pos.remainingCostSol = 0;
      ctx.logger(
        `Position ${pos.symbol} zero balance sustained; removing and marking as failed-confirmation loss of ${pos.realizedPnlUsd.toFixed(2)} USD.`,
        'warn'
      );
      recordClosedTrade(ctx, pos, 'failed-confirmation');
      recordTradeResult(ctx, false, pos.realizedPnlUsd);
      ctx.store.removePosition(mint);
      return;
    } else {
      if (pos.balanceZeroSince) {
        pos.balanceZeroSince = undefined;
      }
    }

    const snap = ctx.state.marketSnapshots.get(mint);
    const pUsd = Number(pRecord?.usdPrice || snap?.usdPrice || 0);

    if (pRecord?.liquidity != null) {
      pos.lastKnownLiquidityUsd = pRecord.liquidity;
      if (snap) {
        snap.liquidity = pRecord.liquidity;
        snap.usdPrice = pUsd;
        snap.observedAt = new Date().toISOString();
        ctx.store.updateMarketSnapshot(mint, snap);
      }
    } else if (snap?.liquidity != null || snap?.liquidityUsd != null) {
      pos.lastKnownLiquidityUsd = snap.liquidity || snap.liquidityUsd;
    }

    const liquidityExitFloor =
      pos.lastKnownLiquidityUsd != null
        ? Math.max(
            ctx.config.liquidityCollapseThresholdUsd,
            Number(pos.entryLiquidityUsd || 0) * ctx.config.liquidityCollapseThresholdRatio
          )
        : null;

    if (
      liquidityExitFloor != null &&
      pos.lastKnownLiquidityUsd != null &&
      pos.lastKnownLiquidityUsd <= liquidityExitFloor
    ) {
      ctx.logger(
        `Liquidity collapse detected for ${pos.symbol} ($${pos.lastKnownLiquidityUsd.toFixed(0)} <= $${liquidityExitFloor.toFixed(0)}).`,
        'warn',
        { console: true }
      );
      await monitorService.executePositionExit(
        ctx,
        pos,
        balance,
        pUsd || pos.lastKnownPriceUsd || pos.entryPriceUsd,
        balance.rawAmount,
        'liquidity-exit'
      );
      return;
    }

    if (!(pUsd > 0)) {
      ctx.logger(`Price unavailable for ${pos.symbol}; skipping price checks.`, 'debug');
      return;
    }

    pos.highestPriceUsd = Math.max(Number(pos.highestPriceUsd || pos.entryPriceUsd || 0), pUsd);
    pos.lastKnownBalanceRaw = balance.rawAmount.toString();
    pos.lastKnownPriceUsd = pUsd;

    pos.timeSeries = pos.timeSeries || [];
    pos.timeSeries.push([Date.now(), pUsd, pos.lastKnownLiquidityUsd ?? 0]);
    if (pos.timeSeries.length > 2500) {
      pos.timeSeries.shift();
    }

    pos.priceHistory = pos.priceHistory || [];
    pos.priceHistory.push({ price: pUsd, timestamp: Date.now() });
    if (
      pRecord &&
      pRecord.bidPrice !== undefined &&
      pRecord.askPrice !== undefined &&
      pRecord.bidPrice > 0 &&
      pRecord.askPrice > 0
    ) {
      pos.spreadHistory = pos.spreadHistory || [];
      pos.spreadHistory.push({
        spread: computeSpread(pRecord.bidPrice, pRecord.askPrice),
        timestamp: Date.now(),
      });
    }

    const cutoff = Date.now() - 60000;
    pos.priceHistory = pos.priceHistory.filter((h) => h.timestamp > cutoff);
    if (pos.spreadHistory) {
      pos.spreadHistory = pos.spreadHistory.filter((h) => h.timestamp > cutoff);
    }

    ctx.store.upsertPosition(pos);

    if (preSignals !== undefined) {
      try {
        const signals = preSignals;

        if (signals.mintAuthority || signals.freezeAuthority) {
          ctx.logger(
            `SECURITY ALERT: ${pos.symbol} authorities enabled after buy! Emergency Exit.`,
            'warn',
            { console: true }
          );
          await monitorService.executePositionExit(
            ctx,
            pos,
            balance,
            pUsd,
            balance.rawAmount,
            'security-rug-exit'
          );
          return;
        }

        const initialHolders = pos.mintSignals?.topAccounts || [];
        // Concentration-aware drift response. The old logic de-risked 40% on ANY top-holder
        // movement, which fires constantly (holders churn) and chops winners into fee-bleeding
        // confetti. Now the response is keyed on entry concentration:
        //   - distributed token (low top5): churn is normal -> just note it, keep the position.
        //   - concentrated token (high top5): an insider dump IS the rug -> full immediate exit.
        const entryTop5 = Number(pos.mintSignals?.top5Share ?? 0);
        const isConcentrated = entryTop5 >= ctx.config.insiderDriftConcentrationTop5;
        if (initialHolders.length > 0) {
          for (const initial of initialHolders) {
            if (!initial.owner || BURN_OWNERS.has(initial.owner)) continue;
            const current = signals.topAccounts.find((a) => a.owner === initial.owner);
            const initialAmt = Number(initial.rawAmount);
            const dropRatio = current ? 1 - Number(current.rawAmount) / initialAmt : 1;
            const drifted = current ? dropRatio > 0.25 : true; // left top 5 entirely
            if (!drifted) continue;

            pos.insiderDrifts = pos.insiderDrifts || {};
            if (pos.insiderDrifts[initial.owner]) continue;
            pos.insiderDrifts[initial.owner] = true;

            const action = current ? `sold ${(dropRatio * 100).toFixed(1)}%` : 'exited top 5';

            if (!isConcentrated) {
              ctx.logger(
                `Insider drift on distributed ${pos.symbol} (top5 ${ratioToPercentString(entryTop5)}): ${initial.owner.slice(0, 8)} ${action}. Holding — churn is normal.`,
                'info'
              );
              continue;
            }

            ctx.logger(
              `INSIDER RUG: concentrated ${pos.symbol} (top5 ${ratioToPercentString(entryTop5)}) holder ${initial.owner.slice(0, 8)} ${action}. Full exit.`,
              'warn',
              { console: true }
            );
            if (
              await monitorService.executePositionExit(
                ctx,
                pos,
                balance,
                pUsd,
                balance.rawAmount,
                'insider-rug-exit'
              )
            ) {
              return;
            }
          }
        }
      } catch (err: unknown) {
        ctx.logger(
          `Re-audit failed for ${pos.symbol}: ${err instanceof Error ? err.message : String(err)}`,
          'debug'
        );
      }
    }

    // Spread velocity: bid/ask blow-out precedes the price crash, so check here alongside
    // other rug signals — not after trailing-stop math has already run.
    if (Array.isArray(pos.spreadHistory) && pos.spreadHistory.length >= 2) {
      const last = pos.spreadHistory[pos.spreadHistory.length - 1]!;
      const prev = pos.spreadHistory[pos.spreadHistory.length - 2]!;
      const timeDiff = (last.timestamp - prev.timestamp) / 1000;
      if (timeDiff <= 15 && prev.spread > 0) {
        const spreadIncrease = last.spread / prev.spread - 1;
        if (spreadIncrease > 0.5) {
          ctx.logger(
            `SPREAD VELOCITY: Widened ${(spreadIncrease * 100).toFixed(1)}% for ${pos.symbol}. Rug risk.`,
            'warn',
            { console: true }
          );
          await monitorService.executePositionExit(
            ctx,
            pos,
            balance,
            pUsd,
            balance.rawAmount,
            'spread-velocity-exit'
          );
          return;
        }
      }
    }

    const ageSec = (Date.now() - new Date(pos.openedAt).getTime()) / 1000;
    const multiples =
      Array.isArray(pos.takeProfitMultiples) && pos.takeProfitMultiples.length > 0
        ? pos.takeProfitMultiples
        : TAKE_PROFIT_MULTIPLES;

    const moonBag = pos.moonBagRaw ? BigInt(pos.moonBagRaw) : 0n;
    const remainingRaw = BigInt(
      pos.lastKnownBalanceRaw ?? pos.initialTokenAmountRaw ?? balance.rawAmount.toString()
    );
    const isRunnerOnly =
      moonBag > 0n && remainingRaw > 0n && remainingRaw <= moonBag + moonBag / 100n;

    const burstExit = getBurstExitDecision(ctx, pos, balance, pUsd);
    if (burstExit) {
      ctx.logger(describeBurstExit(pos, pUsd, burstExit.reason), 'trade');
      await monitorService.executePositionExit(
        ctx,
        pos,
        balance,
        pUsd,
        burstExit.sellRaw,
        burstExit.reason
      );
      return;
    }

    if (pos.entryProfile === 'swing') {
      const wasArmed = pos.trailingArmed;
      const swingExit = getSwingExitDecision(ctx, pos, balance, pUsd);
      if (swingExit?.shouldExit) {
        ctx.logger(describeSwingExit(pos, pUsd, swingExit.reason), 'trade');
        await monitorService.executePositionExit(
          ctx,
          pos,
          balance,
          pUsd,
          swingExit.sellRaw,
          swingExit.reason
        );
      } else if (!wasArmed && pos.trailingArmed) {
        ctx.store.upsertPosition(pos);
      }
      return;
    }

    if (!isRunnerOnly && pos.minTpArmed && pos.targetsHit! < multiples.length) {
      const nextM = multiples[pos.targetsHit!]!;
      const minTpM = 1 + 0.5 * (nextM - 1);
      const minTpP = pos.entryPriceUsd * minTpM;
      if (pUsd < minTpP) {
        ctx.logger(
          `Price fell back to midpoint ${formatUsd(minTpP)} for ${pos.symbol} (Target ${pos.targetsHit! + 1}). Midpoint exit.`,
          'trade'
        );
        // Fill at midpoint trigger price, not the gapped tick. Price may have crashed straight
        // through minTpP in one tick — using pUsd would fill well below the intended exit level.
        const exited = await monitorService.executePositionExit(
          ctx,
          pos,
          balance,
          minTpP,
          balance.rawAmount,
          'adaptive-tp-exit'
        );
        if (!exited) {
          // Exit skipped (zero balance or processing lock); disarm so normal paths take over.
          pos.minTpArmed = false;
          ctx.store.upsertPosition(pos);
        }
        return;
      }
    }

    // Break-even stop guard: arms once the position has ever seen >= triggerMultiple unrealized
    // gain (tracked via highestPriceUsd). Once armed, any retreat to <= entry + floorPct exits
    // immediately. Fires before EPG so a position that peaked at +10%+ never closes at a loss
    // through the early-performance-guard path. No time delay — activates instantly.
    // Excluded for runners (isRunnerOnly): the moon-bag runner rides a wider trailing stop
    // (moonBagTrailingDrawdownPct) and must not be cut early by the tighter beFloor.
    if (ctx.config.breakEvenStopEnabled && !isRunnerOnly) {
      const beFloor = pos.entryPriceUsd * (1 + ctx.config.breakEvenStopFloorPct);
      // Cap beTrigger to the midpoint of the active TP target. When the configured trigger
      // sits above the TP midpoint (e.g. trigger=1.09 but midpoint=1.075 for a 1.15x TP),
      // midpoint arms first and breakeven never arms within that window — a protection gap.
      // Capping ensures breakeven arms at the same tick as the midpoint guard.
      const activeTpMidpointM =
        pos.targetsHit! < multiples.length ? 1 + 0.5 * (multiples[pos.targetsHit!]! - 1) : Infinity;
      const beTrigger =
        pos.entryPriceUsd * Math.min(ctx.config.breakEvenStopTriggerMultiple, activeTpMidpointM);
      if (!pos.breakEvenStopArmed && (pos.highestPriceUsd || 0) >= beTrigger) {
        pos.breakEvenStopArmed = true;
        ctx.store.upsertPosition(pos);
        ctx.logger(
          `[BreakevenStop] ARMED ${pos.symbol} — peak ${pos.highestPriceUsd.toExponential(4)}, floor ${beFloor.toExponential(4)}`,
          'info'
        );
      }
      if (pos.breakEvenStopArmed && pUsd <= beFloor) {
        ctx.logger(
          `[BreakevenStop] EXIT ${pos.symbol} — price ${pUsd.toExponential(4)} at or below floor ${beFloor.toExponential(4)}`,
          'trade'
        );
        await monitorService.executePositionExit(
          ctx,
          pos,
          balance,
          pUsd,
          balance.rawAmount,
          'breakeven-stop'
        );
        return;
      }
    }

    // Unified early-exit block. Outer gate is shared; rug-exit fires first (tighter price
    // threshold, full exit); EPG fires second (buy-collapse tape signal or wider price drop).
    // Both share the same drop computation and earlyGuardExits counter.
    // Upper bound on ageSec prevents wasted computation for aged positions where neither arm can fire.
    if (
      pos.targetsHit === 0 &&
      pos.entryProfile !== 'burst' &&
      (pos.earlyGuardExits ?? 0) === 0 &&
      ageSec <= ctx.config.earlyPerformanceGuardSeconds
    ) {
      const drop = (pos.entryPriceUsd - pUsd) / pos.entryPriceUsd;
      const buyCollapse =
        Array.isArray(pos.tapeHistory) &&
        pos.tapeHistory.length >= 2 &&
        (pos.tapeHistory[pos.tapeHistory.length - 1]?.buys ?? 0) -
          (pos.tapeHistory[pos.tapeHistory.length - 2]?.buys ?? 0) <=
          0;

      // Rug-exit: price drop, spread expansion, or volume tape collapse within rugExitWindowSec of entry = post-peak fill or rug. Full exit.
      if (ctx.config.rugExitGuardEnabled && ageSec < ctx.config.rugExitWindowSec) {
        let dynamicDropPct = ctx.config.rugExitDropPct;
        if (ctx.config.rugExitDynamicScalingEnabled && pos.entryMarketCapUsd) {
          if (pos.entryMarketCapUsd < ctx.config.rugExitMicroCapThresholdUsd) {
            dynamicDropPct *= ctx.config.rugExitMicroCapMultiplier;
          } else if (pos.entryMarketCapUsd > ctx.config.rugExitHighCapThresholdUsd) {
            dynamicDropPct *= ctx.config.rugExitHighCapMultiplier;
          }
        }
        if (ctx.config.rugExitVolatilityScalingEnabled && pos.volatilityScaler) {
          dynamicDropPct *= 1 + pos.volatilityScaler;
        }

        let spreadReason: string | null = null;
        if (
          ctx.config.rugExitSpreadGuardEnabled &&
          Array.isArray(pos.spreadHistory) &&
          pos.spreadHistory.length > 0
        ) {
          const currentSpread = pos.spreadHistory[pos.spreadHistory.length - 1]?.spread;
          const initialSpread = pos.spreadHistory[0]?.spread;
          if (currentSpread !== undefined && initialSpread !== undefined) {
            if (currentSpread > ctx.config.rugExitMaxSpreadPct) {
              spreadReason = `spread too wide (${(currentSpread * 100).toFixed(1)}% > ${(ctx.config.rugExitMaxSpreadPct * 100).toFixed(1)}%)`;
            } else if (
              initialSpread > 0 &&
              currentSpread > initialSpread * ctx.config.rugExitSpreadExpansionMultiplier
            ) {
              spreadReason = `spread expanded (${(currentSpread * 100).toFixed(1)}% vs initial ${(initialSpread * 100).toFixed(1)}%)`;
            }
          }
        }

        let volumeReason: string | null = null;
        if (ctx.config.rugExitVolumeGuardEnabled) {
          if (Array.isArray(pos.tapeHistory) && pos.tapeHistory.length >= 2) {
            const latest = pos.tapeHistory[pos.tapeHistory.length - 1];
            const previous = pos.tapeHistory[pos.tapeHistory.length - 2];
            if (latest && previous) {
              const recentBuys = (latest.buys ?? 0) - (previous.buys ?? 0);
              const recentSells = (latest.sells ?? 0) - (previous.sells ?? 0);
              if (
                recentSells > recentBuys * ctx.config.rugExitSellDominanceMultiplier &&
                recentSells > 0
              ) {
                volumeReason = `sell dominance (${recentSells} sells vs ${recentBuys} buys)`;
              } else if (buyCollapse) {
                volumeReason = `buy collapse (stalled tape)`;
              }
            }
          }
        }

        const dropTriggered = drop > dynamicDropPct;
        const spreadTriggered = spreadReason !== null;
        const volumeTriggered = volumeReason !== null;

        const migrationTs = migrationCooldowns.get(mint);
        const isMigrating = migrationTs !== undefined && Date.now() - migrationTs < 20_000;
        if (isMigrating) {
          ctx.logger(`Migration cooldown active for ${pos.symbol}; suppressing rug-exit.`, 'debug');
        } else if (
          dropTriggered ||
          spreadTriggered ||
          (volumeTriggered && drop > dynamicDropPct * 0.5)
        ) {
          let logMsg = `Rug exit for ${pos.symbol}: age ${ageSec.toFixed(1)}s.`;
          if (dropTriggered) {
            logMsg += ` Price down ${(drop * 100).toFixed(1)}% (threshold ${(dynamicDropPct * 100).toFixed(1)}%).`;
          }
          if (spreadReason) {
            logMsg += ` Spread: ${spreadReason}.`;
          }
          if (volumeReason) {
            logMsg += ` Volume: ${volumeReason}.`;
          }

          pos.earlyGuardExits = (pos.earlyGuardExits ?? 0) + 1;
          ctx.store.upsertPosition(pos);
          ctx.logger(logMsg, 'trade');
          await monitorService.executePositionExit(
            ctx,
            pos,
            balance,
            pUsd,
            balance.rawAmount,
            'rug-exit'
          );
          return;
        }
      }

      // EPG: fires after rug-exit window closes (rugExitWindowSec) up to earlyPerformanceGuardSeconds.
      if (
        ageSec >= ctx.config.rugExitWindowSec &&
        ageSec <= ctx.config.earlyPerformanceGuardSeconds
      ) {
        if (drop > ctx.config.earlyPerformanceDropPct / 100 || buyCollapse) {
          const partialAmount = computeTakeProfitSellAmount(
            balance.rawAmount,
            ctx.config.earlyPerformanceSellPct / 100
          );
          const sellAmount = partialAmount > 0n ? partialAmount : balance.rawAmount;
          const isFullExit = sellAmount === balance.rawAmount;
          // Increment before the await so re-entry is blocked even if executePositionExit
          // returns false (dry-run, RPC error, partial fill in live mode).
          pos.earlyGuardExits = (pos.earlyGuardExits ?? 0) + 1;
          ctx.store.upsertPosition(pos);
          ctx.logger(
            `Early Guard for ${pos.symbol}: drop ${(drop * 100).toFixed(1)}% or buy collapse. ${isFullExit ? 'Full' : 'Partial'} exit.`,
            'warn',
            { console: true }
          );
          await monitorService.executePositionExit(
            ctx,
            pos,
            balance,
            pUsd,
            sellAmount,
            'early-performance-guard'
          );
          return;
        }
      }
    }

    const baseSlPct = ctx.config.stopLossPct;
    const adjustedSlPct = baseSlPct * (1 + (pos.volatilityScaler || 0));
    const effectiveSlPct =
      ageSec < ctx.config.earlyStopLossWindowSec
        ? ctx.config.earlyStopLossPct
        : ageSec < ctx.config.midStopLossWindowSec
          ? ctx.config.midStopLossPct
          : adjustedSlPct;
    let slP = pos.entryPriceUsd * (1 - effectiveSlPct);
    // Breakeven ratchet: once a TP target has been banked, never let the position round-trip
    // below cost. This is the core net-expectancy fix for winners (e.g. RAGE/CWU) that hit a
    // take-profit and then gave the entire gain back on the runner. The stop floor is lifted to
    // ~entry (+ a small buffer covering fees/slippage). Applies to the runner too, by design.
    if (ctx.config.breakevenRatchetEnabled && (pos.targetsHit ?? 0) >= 1) {
      slP = Math.max(slP, pos.entryPriceUsd * (1 + ctx.config.breakevenRatchetBufferPct));
    }
    // Break-even stop: if the position ever saw >= threshold% unrealized gain (via
    // highestPriceUsd, even if price has since reversed), lift the stop floor to entry.
    // Covers the Durio failure mode — tokens that pump but never reach TP1.
    // Division of responsibility: breakEvenStop (above) governs non-runners and returns early,
    // so this path activates only for runners (isRunnerOnly) or when breakEvenStopEnabled=false.
    if (
      ctx.config.slBreakevenEnabled &&
      (pos.highestPriceUsd || 0) >= pos.entryPriceUsd * (1 + ctx.config.slBreakevenThresholdPct)
    ) {
      slP = Math.max(slP, pos.entryPriceUsd * (1 + ctx.config.slBreakevenBufferPct));
    }
    // Half-SL warning at the midpoint between the final (ratchet/break-even adjusted) stop and
    // entry. Using the final slP ensures the warning always precedes the stop even when slP has
    // been lifted above entry by the break-even or ratchet mechanism.
    const slWP = (pos.entryPriceUsd + slP) / 2;

    if (pUsd <= slWP && !pos.stopLossWarningSent) {
      pos.stopLossWarningSent = true;
      ctx.logger(
        `WARNING: ${pos.symbol} half-SL touched. Drawdown: ${((1 - pUsd / pos.entryPriceUsd) * 100).toFixed(2)}%.`,
        'warn',
        { console: true }
      );
      ctx.store.upsertPosition(pos);
    }

    const slMigrationTs = migrationCooldowns.get(mint);
    const slIsMigrating = slMigrationTs !== undefined && Date.now() - slMigrationTs < 20_000;
    if (slIsMigrating && pUsd <= slP) {
      ctx.logger(`Migration cooldown active for ${pos.symbol}; suppressing stop-loss.`, 'debug');
    } else if (pUsd <= slP) {
      ctx.logger(`STOP LOSS hit for ${pos.symbol} at ${formatUsd(pUsd)}.`, 'trade');
      await monitorService.executePositionExit(
        ctx,
        pos,
        balance,
        pUsd,
        balance.rawAmount,
        'stop-loss'
      );
      return;
    }

    if (!pos.trailingArmed) {
      pos.trailingArmed = true;
      ctx.store.upsertPosition(pos);
    }

    if (ageSec < ctx.config.minHoldTimeSeconds) return;

    if (
      ageSec > ctx.config.performanceCheckSeconds &&
      pos.targetsHit === 0 &&
      pUsd < pos.entryPriceUsd * ctx.config.performanceMinMomentum
    ) {
      ctx.logger(`No early performance for ${pos.symbol}; exiting.`, 'trade');
      await monitorService.executePositionExit(
        ctx,
        pos,
        balance,
        pUsd,
        balance.rawAmount,
        'no-early-performance'
      );
      return;
    }

    let trailingDrawdownPct = Number(
      pos.trailingStopDrawdownPctResolved || ctx.config.trailingStopDrawdownPct || 0.2
    );
    const currentMultiple = pUsd / pos.entryPriceUsd;

    if (currentMultiple > 1.8) {
      const acceleration = Math.min(0.12, (currentMultiple - 1.8) * 0.04);
      trailingDrawdownPct = Math.max(0.04, trailingDrawdownPct - acceleration);
    }

    // Determine whether only the reserved moon-bag runner remains. The core position uses the
    // tight trailing stop; once it has been taken off, the runner rides a much wider one.
    const trailP = (pos.highestPriceUsd || pUsd) * (1 - trailingDrawdownPct);
    if (!isRunnerOnly && pUsd < trailP) {
      ctx.logger(
        `Trailing Stop hit for ${pos.symbol}: price ${formatUsd(pUsd)} < ${ratioToPercentString(1 - trailingDrawdownPct)} of peak (${formatUsd(pos.highestPriceUsd)}).`,
        'trade'
      );
      // moon-bag-protected: sells the core down to the reserved runner (returns true) or, if the
      // runner is all that remains, this branch is skipped (isRunnerOnly) so the wider moon-bag
      // trailing below governs — a true moonshot isn't cut at the tight core stop.
      await monitorService.executePositionExit(
        ctx,
        pos,
        balance,
        pUsd,
        balance.rawAmount,
        'tp-trailing-max-exit'
      );
      return;
    }

    // Moon-bag runner: once only the reserved runner remains, let it ride on a much wider
    // trailing stop. This is the structural moonshot-capture mechanism — one 10x+ runner pays
    // for many small losses (net-expectancy objective).
    if (isRunnerOnly && pos.trailingArmed) {
      const moonTrailP =
        (pos.highestPriceUsd || pUsd) * (1 - ctx.config.moonBagTrailingDrawdownPct);
      if (pUsd < moonTrailP) {
        ctx.logger(
          `Moon-bag trailing hit for ${pos.symbol}: price ${formatUsd(pUsd)} < ${ratioToPercentString(1 - ctx.config.moonBagTrailingDrawdownPct)} of peak (${formatUsd(pos.highestPriceUsd)}). Closing runner.`,
          'trade'
        );
        await monitorService.executePositionExit(
          ctx,
          pos,
          balance,
          pUsd,
          balance.rawAmount,
          'moon-bag-trailing-exit'
        );
        return;
      }
    }

    const ageMin = ageSec / 60;
    const maxHoldMinutesResolved = Number(
      pos.maxHoldMinutesResolved || ctx.config.maxHoldMinutes || 20
    );
    if (
      ageMin >= maxHoldMinutesResolved &&
      pUsd < pos.entryPriceUsd * ctx.config.timeExitMinMultiple
    ) {
      ctx.logger(
        `Max hold time reached for ${pos.symbol} (${ageMin.toFixed(1)}m); exiting.`,
        'trade'
      );
      await monitorService.executePositionExit(
        ctx,
        pos,
        balance,
        pUsd,
        balance.rawAmount,
        'time-exit'
      );
      return;
    }

    if (!isRunnerOnly) {
      while (pos.targetsHit! < multiples.length) {
        const nextM = multiples[pos.targetsHit!]!;
        const targetP = pos.entryPriceUsd * nextM;
        const minTpM = 1 + 0.5 * (nextM - 1);
        const minTpP = pos.entryPriceUsd * minTpM;

        if (pUsd >= minTpP && !pos.minTpArmed) {
          pos.minTpReached = true;
          pos.minTpArmed = true;
          ctx.logger(
            `Midpoint Profit Guard ARMED for ${pos.symbol} (Target ${pos.targetsHit! + 1}).`,
            'info'
          );
          ctx.store.upsertPosition(pos);
        }

        if (pUsd < targetP) break;

        const freshBalance = await tradingService.getWalletTokenBalance(
          ctx,
          pos.mint,
          PRIORITY.HIGH
        );
        if (await monitorService.sellTakeProfit(ctx, pos, freshBalance, pUsd, nextM)) {
          pos.minTpReached = false;
          pos.minTpArmed = false;
          ctx.store.upsertPosition(pos);
        } else {
          break;
        }
      }
    }
  } finally {
    evaluatingMints.delete(mint);
  }
}

export const monitorService = {
  evaluateSinglePosition,
  evaluatingMints,
  incrementExitReasonMetric,
  executePositionExit,
  sellTakeProfit,
  buildExitAccounting,
  getTakeProfitPlan,
  getTakeProfitFraction,
  computeTakeProfitSellAmount,
  getMoodAdjustments,
  recordTradeResult,
  recordClosedTrade,
  startCoolDown,
  monitorPositions,
  closeAllOpenPositions,
};
