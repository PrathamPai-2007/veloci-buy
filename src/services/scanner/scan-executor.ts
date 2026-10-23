import { runBoundedPool, PRIORITY, derivePumpCurvePda } from '#core/utils.js';
import { appService } from '../services.js';
import { portfolioService } from '../trading/portfolio.service.js';
import { Context, RecheckItem, TokenMetadata, EvaluationResult, SwapOrder } from '#types/index.js';
import { localMarketState } from '../market-state/index.js';
import { registerPumpMintPda } from '../../core/bot-internals/geyser-coordinator.js';
import {
  WorkItem,
  getDueCandidateRechecks,
  scheduleFinalAudit,
  scheduleRecheckEligibleWaitlist,
  scheduleSurvivalDelay,
} from './scan-scheduler.js';
import { batchPreFetchAudits } from './scan-auditor.js';
import { prefetchBuyQuote } from './stages/price-fetcher.js';
export { refreshMarketSnapshots } from './stages/price-fetcher.js';
import {
  StageDurations,
  ScanMetrics,
  isTokenTooOld,
  handleProcessError,
  logScanSummary,
} from './stages/candidate-evaluator.js';

export async function scanForCandidates(
  ctx: Context,
  discoveryItems?: TokenMetadata[],
  due?: RecheckItem[]
): Promise<void> {
  const { state, store, config } = ctx;
  const scanStart = Date.now();

  const actualDue = due ?? getDueCandidateRechecks(ctx);
  let actualDiscovery = discoveryItems;
  if (!actualDiscovery) {
    try {
      actualDiscovery = await appService.fetchRecentLaunches(ctx);
    } catch (e) {
      ctx.logger(
        `Failed to fetch recent launches: ${e instanceof Error ? e.message : String(e)}`,
        'warn'
      );
      actualDiscovery = [];
    }
  }

  for (const t of actualDiscovery) {
    if (t.id) {
      const isPump = t.launchpad === 'pump.fun' || t.id.toLowerCase().endsWith('pump');
      if (isPump) {
        registerPumpMintPda(ctx, t.id);
      }
      if (t.usdPrice !== undefined) {
        store.updateMarketSnapshot(t.id, {
          launchpad: t.launchpad || 'unknown',
          liquidity: Number(t.liquidity || 0),
          usdPrice: Number(t.usdPrice || 0),
          observedAt: new Date().toISOString(),
        });
      } else if (isPump) {
        const provSnap = localMarketState.getSnapshot(t.id);
        if (provSnap) {
          store.updateMarketSnapshot(t.id, {
            launchpad: 'pump.fun',
            liquidity: provSnap.liquidityUsd,
            usdPrice: provSnap.priceUsd,
            observedAt: new Date().toISOString(),
          });
        }
      }
    }
  }

  const metrics: ScanMetrics = {
    discovery: actualDiscovery.length,
    rechecks: actualDue.length,
    buys: 0,
    rejected: 0,
    requeued: 0,
    errors: 0,
    lagRetries: 0,
    reservedBuys: 0,
    skipped: 0,
  };

  const stageDurations: StageDurations = {
    priceFetchMs: [],
    lightAuditMs: [],
    heavyAuditMs: [],
    buyMs: [],
  };

  // P0-D: Earliest capacity check short-circuit before any RPC or expensive work
  if (!portfolioService.hasCapacity(ctx)) {
    ctx.logger(
      `[Scan] Short-circuiting candidate evaluation: max total open positions reached (${state.positions.size}/${config.maxOpenPositions})`,
      'info'
    );
    return;
  }

  const allMints = [
    ...new Set([...actualDiscovery.map((i) => i.id), ...actualDue.map((i) => i.mint)]),
  ];
  const dueMints = new Set(actualDue.map((d) => d.mint));
  const missingMints = allMints.filter((m) => {
    if (dueMints.has(m)) return true;
    const snap = state.marketSnapshots.get(m);
    return !snap || !(Number(snap.usdPrice) > 0) || !(Number(snap.liquidity) > 0);
  });

  if (missingMints.length > 0) {
    const started = Date.now();
    try {
      const controller = new AbortController();
      const fetchPromise = appService.fetchPricesBestEffort(
        ctx,
        missingMints,
        'scan pre-fetch',
        null,
        {
          onChainFirst: true,
          signal: controller.signal,
        }
      );
      void fetchPromise.catch(() => {});
      let timeoutId: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          reject(new Error('scan pre-fetch timed out after 20s'));
        }, 20_000);
      });
      let prices;
      try {
        prices = await Promise.race([fetchPromise, timeoutPromise]);
      } finally {
        clearTimeout(timeoutId);
      }
      for (const [mint, data] of Object.entries(prices)) {
        const prev = state.marketSnapshots.get(mint);
        const nextUsdPrice = data.usdPrice > 0 ? data.usdPrice : prev?.usdPrice || 0;
        const nextLiquidity =
          Number(data.liquidity) > 0 ? Number(data.liquidity) : prev?.liquidity || 0;
        store.updateMarketSnapshot(mint, {
          launchpad: data.launchpad ? String(data.launchpad) : prev?.launchpad || 'unknown',
          liquidity: nextLiquidity,
          usdPrice: nextUsdPrice,
          observedAt: new Date().toISOString(),
        });
        if (data.launchpad === 'pump.fun' || !data.launchpad) {
          derivePumpCurvePda(mint)
            .then((pda: string) => {
              if (pda) state.curveToMint.set(pda, mint);
            })
            .catch(() => {});
        }
      }
    } catch (e) {
      ctx.logger(
        `Scan market data pre-fetch failed: ${e instanceof Error ? e.message : String(e)}`,
        'warn'
      );
    }
    stageDurations.priceFetchMs.push(Date.now() - started);
  }

  const workItems: WorkItem[] = [];
  for (const token of actualDiscovery) {
    if (state.processedMints.has(token.id) || state.pendingCandidateRechecks.has(token.id))
      continue;
    workItems.push({ token });
  }
  for (const entry of actualDue) {
    if (state.processedMints.has(entry.mint)) continue;

    if (entry.highestSeenPriceUsd && config.recheckPriceDropPct) {
      const currentPrice = state.marketSnapshots.get(entry.mint)?.usdPrice;
      if (currentPrice !== undefined && currentPrice > 0) {
        const dropPct =
          ((entry.highestSeenPriceUsd - currentPrice) / entry.highestSeenPriceUsd) * 100;
        if (dropPct > config.recheckPriceDropPct) {
          ctx.logger(
            `[Scan] Cancelling pullback recheck for ${entry.mint}: price dropped ${dropPct.toFixed(2)}% from high of ${entry.highestSeenPriceUsd} to ${currentPrice} (limit ${config.recheckPriceDropPct}%)`,
            'warn'
          );
          store.trackMint(entry.mint);
          continue;
        }
      }
    }

    const snap = state.marketSnapshots.get(entry.mint);
    const baseToken =
      entry.tokenSnapshot || ({ id: entry.mint, symbol: '?', name: '?' } as TokenMetadata);
    const token =
      snap && Number(snap.usdPrice) > 0
        ? {
            ...baseToken,
            usdPrice: Number(snap.usdPrice),
            liquidity: Number(snap.liquidity) > 0 ? Number(snap.liquidity) : baseToken.liquidity,
          }
        : baseToken;

    workItems.push({ token, recheckEntry: entry });
  }

  if (workItems.length === 0) return;

  // Filter candidates by portfolio capacity before doing expensive heavy audits
  const eligibleWorkItems = workItems.filter((i) => {
    const riskCheck = portfolioService.canBuy(ctx, i.token);
    return riskCheck.approved;
  });

  if (eligibleWorkItems.length === 0) {
    ctx.logger(
      `[Scan] All ${workItems.length} candidate(s) skipped: sector capacity / max positions reached.`,
      'info'
    );
    return;
  }

  const breaker = await portfolioService.evaluateDrawdownBreaker(ctx);
  if (breaker.event === 'tripped') {
    ctx.logger(`[RiskBlock] ${breaker.reason}`, 'warn', { console: true });
  } else if (breaker.event === 'resumed') {
    ctx.logger('[RiskBlock] Drawdown cooldown elapsed — resuming new buys.', 'info', {
      console: true,
    });
  }
  if (breaker.blocked) {
    ctx.logger(
      `[SCAN] ${eligibleWorkItems.length} items skipped — new buys paused by drawdown breaker.`,
      'info'
    );
    return;
  }

  const lightAudits = eligibleWorkItems.filter((i) => !i.recheckEntry?.isFinalAudit);
  const heavyAudits = eligibleWorkItems.filter((i) => i.recheckEntry?.isFinalAudit);

  lightAudits.sort(
    (a, b) => Number(b.token.isTrending ?? false) - Number(a.token.isTrending ?? false)
  );

  const batchedSignalsMap = await batchPreFetchAudits(ctx, heavyAudits);

  const processItem = async (item: WorkItem): Promise<void> => {
    const isFinalAudit = item.recheckEntry?.isFinalAudit;

    if (
      state.positions.size + metrics.reservedBuys >= config.maxOpenPositions ||
      metrics.buys + metrics.reservedBuys >= config.maxBuysPerScan
    ) {
      metrics.skipped++;
      return;
    }

    if (isFinalAudit) {
      metrics.reservedBuys++;
    }

    const reservedIncremented = isFinalAudit;
    const token = item.token;
    try {
      if (state.positions.has(token.id)) {
        store.trackMint(token.id);
        metrics.skipped++;
        return;
      }

      const riskCheck = portfolioService.canBuy(ctx, token);
      if (!riskCheck.approved) {
        ctx.logger(`[RiskBlock] ${token.symbol}: ${riskCheck.reason}`, 'warn');
        metrics.skipped++;
        return;
      }

      if (isTokenTooOld(token, config.maxCandidateAgeMinutes)) {
        metrics.rejected++;
        store.trackMint(token.id);
        return;
      }

      if (
        item.recheckEntry &&
        (item.recheckEntry.auditAttempts || 0) >= (config.maxRecheckAttempts || 5)
      ) {
        ctx.logger(`[MaxRechecks] ${token.symbol} reached limit. Dropping.`, 'warn');
        store.trackMint(token.id);
        metrics.rejected++;
        return;
      }

      const isSurvivalWait = item.recheckEntry?.isSurvivalWait;
      const depth = isFinalAudit ? 'full' : 'cheap';
      const priority = isFinalAudit ? PRIORITY.HIGH : PRIORITY.LOW;

      let prefetchedQuotePromise: Promise<SwapOrder | null> | null = null;
      if (isFinalAudit && !config.dryRun && !config.paperTrading) {
        prefetchedQuotePromise = prefetchBuyQuote(ctx, token.id);
      }

      const enrichedPriceHistory = item.recheckEntry?.tokenSnapshot?.priceHistory ?? [];
      const liquidityAtStart = item.recheckEntry?.tokenSnapshot?.liquidity;

      const auditStart = Date.now();
      let evaluation: EvaluationResult;
      try {
        evaluation = await appService.evaluateCandidate(
          ctx,
          token,
          item.recheckEntry?.highestSeenPriceUsd,
          enrichedPriceHistory,
          item.recheckEntry?.basePriceUsd,
          liquidityAtStart,
          item.recheckEntry?.tokenSnapshot?.tapeAtStart || null,
          item.recheckEntry?.tokenSnapshot?.tapeHistory || [],
          depth,
          priority,
          batchedSignalsMap.get(token.id)
        );
      } finally {
        stageDurations[depth === 'full' ? 'heavyAuditMs' : 'lightAuditMs'].push(
          Date.now() - auditStart
        );
      }

      if (evaluation.approved) {
        if (depth === 'cheap') {
          if (isSurvivalWait) {
            metrics.requeued++;
            store.incrementMetric('passedSurvival');
            scheduleFinalAudit(ctx, item);
            return;
          }

          metrics.requeued++;
          store.incrementMetric('passedCheapAudit');
          scheduleSurvivalDelay(ctx, item, evaluation.candidateScore);
          return;
        }

        if (localMarketState.isProvisional(token.id)) {
          ctx.logger(
            `[POSITION_DATA_BLOCKED] mint=${token.id} status=PROVISIONAL reason=authoritative-market-state-unavailable; requeueing final audit.`,
            'warn',
            { console: true }
          );
          metrics.requeued++;
          scheduleFinalAudit(ctx, item);
          return;
        }

        store.incrementMetric('finalAuditPassed');
        const buyStart = Date.now();
        try {
          const pos = await appService.buyCandidate(ctx, evaluation, prefetchedQuotePromise);
          if (pos) {
            metrics.buys++;
            store.incrementMetric('boughtPositions');
            store.trackMint(token.id);
          } else {
            handleProcessError(
              ctx,
              item,
              new Error('Buy execution returned null position.'),
              metrics
            );
          }
        } finally {
          stageDurations.buyMs.push(Date.now() - buyStart);
        }
      } else {
        const reasons =
          evaluation.blockers.length > 0
            ? evaluation.blockers.join(' | ')
            : `Scorecard check failed (score: ${evaluation.candidateScore} < ${ctx.config.minCandidateScore})`;
        ctx.logger(`[REJECT] ${token.symbol} (${token.id}): ${reasons}`, 'debug');

        const rejectionCode =
          evaluation.rejectionReasons.find((r) => !r.recheckEligible)?.code ??
          evaluation.rejectionReasons[0]?.code ??
          'score-too-low';
        store.recordRejection(rejectionCode);

        const hasHardBlocker = evaluation.rejectionReasons.some((r) => !r.recheckEligible);
        const recheckReason = hasHardBlocker
          ? undefined
          : evaluation.rejectionReasons.find((r) => r.recheckEligible);
        if (
          config.borderlineRecheckEnabled &&
          recheckReason &&
          (item.recheckEntry?.auditAttempts || 0) < (config.maxRecheckAttempts || 5)
        ) {
          metrics.requeued++;
          scheduleRecheckEligibleWaitlist(ctx, item, recheckReason.code);
        } else {
          metrics.rejected++;
          store.trackMint(token.id);
        }
      }
      ctx.recordScanBackpressureEvent?.(null);
    } catch (err: unknown) {
      handleProcessError(ctx, item, err, metrics);
    } finally {
      if (reservedIncremented) {
        metrics.reservedBuys--;
      }
    }
  };

  const lightConcurrency = ctx.getEffectiveParallelism?.(config.scanParallelismLight || 10) || 10;
  const heavyConcurrency = ctx.getEffectiveParallelism?.(config.scanParallelismHeavy || 4) || 4;

  await Promise.all([
    runBoundedPool(lightAudits, processItem, { concurrency: lightConcurrency }),
    runBoundedPool(heavyAudits, processItem, { concurrency: heavyConcurrency }),
  ]);

  logScanSummary(
    ctx,
    stageDurations,
    metrics,
    workItems,
    actualDue.length,
    actualDiscovery.length,
    scanStart,
    lightConcurrency,
    heavyConcurrency
  );
}
