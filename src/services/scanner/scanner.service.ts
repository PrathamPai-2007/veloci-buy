import {
  runBoundedPool,
  PRIORITY,
  isTransientOperationError,
  derivePumpCurvePda,
} from '#core/utils.js';
import { appService } from '../services.js';
import { auditService } from '../audit/audit.service.js';
import { batchFetchDirectMarketData, DirectMarketData } from '../market-data.js';
import { portfolioService } from '../trading/portfolio.service.js';
import { fetchSdkSwapOrder } from '../trading/swap-executor.js';
import { MARKET_SNAPSHOT_RETENTION_MS, SOL_MINT } from '#core/config.js';
import {
  Context,
  RecheckItem,
  TokenMetadata,
  EvaluationResult,
  SwapOrder,
  MintSignals,
} from '#types/index.js';

const MAX_INDEXING_LAG_RETRIES = 3;

/**
 * Type representing a work item in the scanning pipeline.
 */
interface WorkItem {
  token: TokenMetadata;
  recheckEntry?: RecheckItem;
}

interface StageDurations {
  priceFetchMs: number[];
  lightAuditMs: number[];
  heavyAuditMs: number[];
  buyMs: number[];
}

interface ScanMetrics {
  discovery: number;
  rechecks: number;
  buys: number;
  rejected: number;
  requeued: number;
  errors: number;
  lagRetries: number;
  reservedBuys: number;
  skipped: number;
}

/**
 * Checks if a token is older than the configured threshold.
 * @param token - The token metadata.
 * @param maxAgeMinutes - Maximum age in minutes.
 * @returns True if the token exceeds the age limit.
 */
function isTokenTooOld(token: TokenMetadata, maxAgeMinutes: number): boolean {
  if (!token.firstPool?.createdAt) return false;
  const ageMs = Date.now() - new Date(token.firstPool.createdAt).getTime();
  return ageMs > maxAgeMinutes * 60 * 1000;
}

/**
 * Pre-fetches a buy quote from Jupiter API for a token to minimize latency.
 * @param ctx - The application context.
 * @param mint - The token mint address.
 * @returns A promise resolving to a SwapOrder or null.
 */
async function prefetchBuyQuote(ctx: Context, mint: string): Promise<SwapOrder | null> {
  try {
    return await fetchSdkSwapOrder(ctx, SOL_MINT, mint, ctx.config.buyAmountLamports);
  } catch (err) {
    ctx.logger(
      `[QuotePrefetch] Failed for ${mint}: ${err instanceof Error ? err.message : String(err)}`,
      'debug'
    );
    return null;
  }
}

/**
 * Handles processing errors for a candidate, including recheck scheduling and indexing lag detection.
 * @param ctx - The application context.
 * @param item - The work item that failed.
 * @param err - The error object.
 * @param metrics - Current scan metrics.
 */
function handleProcessError(
  ctx: Context,
  item: WorkItem,
  err: unknown,
  metrics: ScanMetrics
): void {
  const { store } = ctx;
  const token = item.token;

  if (err instanceof Error && err.message.includes('RPC Indexing Lag')) {
    const retries = item.recheckEntry?.indexingLagRetries || 0;
    if (retries < MAX_INDEXING_LAG_RETRIES) {
      metrics.lagRetries++;
      scannerService.scheduleIndexingLagRetry(ctx, item, retries + 1);
      return;
    }
  }

  if (isTransientOperationError(err)) {
    metrics.errors++;
    ctx.recordScanBackpressureEvent?.(err);
    return;
  }

  const msg = err instanceof Error ? err.message : String(err);
  ctx.logger(`[ScanError] ${token.symbol}: ${msg}`, 'warn');
  metrics.errors++;
  store.trackMint(token.id);
}

/**
 * Scans for token candidates based on incoming discovery items and pending rechecks.
 * Coordinates batch audits, evaluations, and trade executions.
 *
 * @param ctx - The application context.
 * @param discoveryItems - Newly discovered token candidates.
 * @param due - Pending rechecks that are now eligible for processing.
 */
export async function scanForCandidates(
  ctx: Context,
  discoveryItems?: TokenMetadata[],
  due?: RecheckItem[]
): Promise<void> {
  const { state, store, config } = ctx;
  const scanStart = Date.now();

  const actualDue = due ?? scannerService.getDueCandidateRechecks(ctx);
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

  // Update market snapshots with current prices of discovery candidates
  for (const t of actualDiscovery) {
    if (t.id && t.usdPrice !== undefined) {
      store.updateMarketSnapshot(t.id, {
        launchpad: t.launchpad || 'unknown',
        liquidity: Number(t.liquidity || 0),
        usdPrice: Number(t.usdPrice || 0),
        observedAt: new Date().toISOString(),
      });
      if (t.launchpad === 'pump.fun') {
        derivePumpCurvePda(t.id)
          .then((pda) => {
            if (pda) state.curveToMint.set(pda, t.id);
          })
          .catch(() => {});
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

  // Pre-fetch missing market data (price/liquidity) for all items in the scan
  const allMints = [
    ...new Set([...actualDiscovery.map((i) => i.id), ...actualDue.map((i) => i.mint)]),
  ];
  // A snapshot with usdPrice/liquidity <= 0 is treated as missing too: fresh pump.fun mints
  // arrive from Jupiter `recent` with zero price/liquidity, and skipping them here meant they
  // never hit the on-chain bonding-curve fallback (fetchDirectMarketData) — surfacing as
  // "No price" / "$0.00 liquidity" hard rejects. Re-fetch them so the curve fills real values.
  //
  // Candidates that are *due* for a recheck (survival waits especially) are ALWAYS re-priced,
  // even when they already have a snapshot: the survival-momentum gate compares the current
  // price against the price captured when the delay was scheduled, so re-evaluating against a
  // stale snapshot pins momentum at exactly 1.000x and nothing ever passes survival.
  const dueMints = new Set(actualDue.map((d) => d.mint));
  const missingMints = allMints.filter((m) => {
    if (dueMints.has(m)) return true;
    const snap = state.marketSnapshots.get(m);
    return !snap || !(Number(snap.usdPrice) > 0) || !(Number(snap.liquidity) > 0);
  });

  if (missingMints.length > 0) {
    const started = Date.now();
    try {
      // ponytail: flat 20s deadline so the Jupiter residual/fallback path inside
      // fetchPricesBestEffort can't blow the 60s scan watchdog. The underlying fetchJson/rpcCall
      // are each Promise.race-guarded already; this only bounds their *sum* in the scan path.
      // On timeout we drop the merge (token keeps its missing price and gets requeued as unborn).
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
      void fetchPromise.catch(() => {}); // swallow a late rejection if the timeout wins the race
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
        // Merge over any existing snapshot so a re-fetch never clobbers a known launchpad
        // (the curve fallback returns price/liquidity but no launchpad) or a good price.
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
          // Assume pump if unknown just in case
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

  // Build work items pool
  const workItems: WorkItem[] = [];
  for (const token of actualDiscovery) {
    if (state.processedMints.has(token.id) || state.pendingCandidateRechecks.has(token.id))
      continue;
    workItems.push({ token });
  }
  for (const entry of actualDue) {
    if (state.processedMints.has(entry.mint)) continue;

    // Check for pullback price deterioration
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

    // Overlay the freshly pre-fetched price/liquidity onto the (otherwise frozen) snapshot so
    // evaluateCandidate sees the live price. Without this the survival-momentum check divides a
    // stale price by itself (1.000x) and the candidate can never clear the gate.
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

  // Account-wide drawdown circuit breaker — evaluated ONCE per scan (it's a global kill-switch,
  // not a per-token rule), so a tripped breaker logs a single line instead of one per candidate.
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
      `[SCAN] ${workItems.length} items skipped — new buys paused by drawdown breaker.`,
      'info'
    );
    return;
  }

  // Run audits in parallel pools grouped by audit depth
  const lightAudits = workItems.filter((i) => !i.recheckEntry?.isFinalAudit);
  const heavyAudits = workItems.filter((i) => i.recheckEntry?.isFinalAudit);

  // Priority: the bounded pool processes items in array order and `processItem` claims the
  // limited per-scan buy/position slots first-come, so ordering trending coins first gives
  // them first dibs. Stable-sort keeps the relative order of non-trending items unchanged.
  lightAudits.sort(
    (a, b) => Number(b.token.isTrending ?? false) - Number(a.token.isTrending ?? false)
  );

  const batchedSignalsMap = new Map<string, MintSignals>();
  if (heavyAudits.length > 0) {
    // Consume any signals pre-fetched during the survival delay window
    for (const item of heavyAudits) {
      const cached = ctx.state.prefetchedMintSignals.get(item.token.id);
      if (cached) {
        batchedSignalsMap.set(item.token.id, cached);
        ctx.state.prefetchedMintSignals.delete(item.token.id);
      }
    }

    const uncachedHeavy = heavyAudits.filter((i) => !batchedSignalsMap.has(i.token.id));
    if (uncachedHeavy.length > 0) {
      const prefetchStart = Date.now();
      try {
        const signals = await auditService.batchGetMintSignals(
          ctx,
          uncachedHeavy.map((i) => i.token.id),
          { priority: PRIORITY.HIGH }
        );
        for (const [m, s] of signals) {
          batchedSignalsMap.set(m, s);
        }
        ctx.logger(
          `[BatchAudit] Pre-fetched signals for ${uncachedHeavy.length} candidates in ${Date.now() - prefetchStart}ms (${heavyAudits.length - uncachedHeavy.length} from survival cache)`,
          'debug'
        );
      } catch (err) {
        ctx.logger(
          `Batch signal pre-fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          'warn'
        );
      }
    } else {
      ctx.logger(
        `[BatchAudit] All ${heavyAudits.length} candidates served from survival prefetch cache`,
        'debug'
      );
    }
  }

  /**
   * Worker function to process a single work item.
   */
  const processItem = async (item: WorkItem): Promise<void> => {
    const isFinalAudit = item.recheckEntry?.isFinalAudit;

    // Final check for global limits before starting expensive audit
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
      // Never open a second position in a mint we already hold. Scans are serialized so this
      // shouldn't trigger, but it's a cheap last line of defense against any concurrent buy path
      // double-buying the same token (this pipeline doesn't average into existing positions).
      if (state.positions.has(token.id)) {
        store.trackMint(token.id);
        metrics.skipped++;
        return;
      }

      // Portfolio Risk Check
      const riskCheck = portfolioService.canBuy(ctx, token);
      if (!riskCheck.approved) {
        ctx.logger(`[RiskBlock] ${token.symbol}: ${riskCheck.reason}`, 'warn');
        metrics.skipped++;
        return;
      }

      // Age check
      if (isTokenTooOld(token, config.maxCandidateAgeMinutes)) {
        metrics.rejected++;
        store.trackMint(token.id);
        return;
      }

      // Max recheck check
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

      // Start pre-fetching quote for high-confidence final audits to minimize execution latency
      let prefetchedQuotePromise: Promise<SwapOrder | null> | null = null;
      if (isFinalAudit && !config.dryRun && !config.paperTrading) {
        prefetchedQuotePromise = prefetchBuyQuote(ctx, token.id);
      }

      // For burst survival checks, use on-chain curve samples for richer price history + liquidity.
      // Sort by timestamp so [0] is always the earliest sample regardless of RPC response order.
      const burstSamples =
        (isSurvivalWait || isFinalAudit) && config.burstModeEnabled
          ? (ctx.state.burstPriceSamples.get(token.id) ?? [])
              .slice()
              .sort((a, b) => a.timestamp - b.timestamp)
          : [];
      const enrichedPriceHistory =
        burstSamples.length > 0
          ? burstSamples
          : (item.recheckEntry?.tokenSnapshot?.priceHistory ?? []);
      const liquidityAtStart =
        burstSamples.length > 0
          ? burstSamples[0]!.liquidity
          : item.recheckEntry?.tokenSnapshot?.liquidity;

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
            scannerService.scheduleFinalAudit(ctx, item);
            return;
          }

          metrics.requeued++;
          store.incrementMetric('passedCheapAudit');
          scannerService.scheduleSurvivalDelay(ctx, item, evaluation.candidateScore);
          return;
        }

        // Final Audit Passed -> Buy
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
        // Rejected -> Check if recheck eligible
        const reasons =
          evaluation.blockers.length > 0
            ? evaluation.blockers.join(' | ')
            : `Scorecard check failed (score: ${evaluation.candidateScore} < ${ctx.config.minCandidateScore})`;
        ctx.logger(`[REJECT] ${token.symbol} (${token.id}): ${reasons}`, 'debug');

        // Aggregate the dominant rejection reason into metrics so the scan
        // summary can surface why candidates are being dropped.
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
          scannerService.scheduleRecheckEligibleWaitlist(ctx, item, recheckReason.code);
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

/**
 * Logs a summary of the scan results and performance metrics.
 */
function logScanSummary(
  ctx: Context,
  _stageDurations: StageDurations,
  metrics: ScanMetrics,
  workItems: WorkItem[],
  _dueCount: number,
  _discoveryCount: number,
  scanStart: number,
  _lightC: number,
  _heavyC: number
): void {
  ctx.logger(
    `[SCAN] ${workItems.length} items. ` +
      `pos: ${ctx.state.positions.size}, buys: ${metrics.buys}, skip: ${metrics.skipped}, rchk: ${metrics.requeued}, rej: ${metrics.rejected}, err: ${metrics.errors}${metrics.lagRetries > 0 ? ` (lag:${metrics.lagRetries})` : ''}. ` +
      `(Total: ${Date.now() - scanStart}ms)`,
    'info'
  );
}

/**
 * Schedules a pullback recheck for a candidate.
 */
export function schedulePullbackRecheck(ctx: Context, item: WorkItem, reason: string): void {
  const { store } = ctx;
  const delayMs = 15000;
  store.upsertRecheckEntry({
    mint: item.token.id,
    tokenSnapshot: item.token,
    reason: `pullback:${reason}`,
    scheduledTime: Date.now() + delayMs,
    basePriceUsd: item.recheckEntry?.basePriceUsd || item.token.usdPrice,
    auditAttempts: (item.recheckEntry?.auditAttempts || 0) + 1,
  });
}

/**
 * Schedules a recheck for a candidate that is eligible for retry after rejection.
 */
export function scheduleRecheckEligibleWaitlist(
  ctx: Context,
  item: WorkItem,
  code: string,
  options?: { lowHolderWaitlist?: boolean }
): void {
  const { config, store } = ctx;
  let delayMs = config.borderlineRecheckMinDelayMs || 8000;
  if (code === 'low-holders' || options?.lowHolderWaitlist) {
    delayMs = (config.holderCountWaitlistSeconds || 33) * 1000;
  }
  const isTooNew = code === 'too-new';
  store.upsertRecheckEntry({
    mint: item.token.id,
    tokenSnapshot: item.token,
    reason: `waitlist:${code || 'low-holders'}`,
    scheduledTime: Date.now() + delayMs,
    auditAttempts: isTooNew
      ? item.recheckEntry?.auditAttempts || 0
      : (item.recheckEntry?.auditAttempts || 0) + 1,
    isWaitlist: true,
  });
}

interface SamplingBatch {
  ctx: Context;
  mints: Set<string>;
  resolvers: Map<string, Array<(data: DirectMarketData | null) => void>>;
  timer: ReturnType<typeof setTimeout> | null;
}

let activeSamplingBatch: SamplingBatch | null = null;

/**
 * Batched variant of fetchDirectMarketData for burst sampling.
 * Groups multiple single-mint requests into a single batchFetchDirectMarketData call
 * within a small window (e.g. 50ms) to prevent getAccountInfo RPC bursts.
 */
function batchedFetchDirectMarketData(
  ctx: Context,
  mint: string
): Promise<DirectMarketData | null> {
  return new Promise((resolve) => {
    if (!activeSamplingBatch) {
      activeSamplingBatch = {
        ctx,
        mints: new Set(),
        resolvers: new Map(),
        timer: null,
      };
    }

    const batch = activeSamplingBatch;
    batch.mints.add(mint);

    let mintResolvers = batch.resolvers.get(mint);
    if (!mintResolvers) {
      mintResolvers = [];
      batch.resolvers.set(mint, mintResolvers);
    }
    mintResolvers.push(resolve);

    if (!batch.timer) {
      batch.timer = setTimeout(() => {
        const currentBatch = activeSamplingBatch;
        activeSamplingBatch = null;

        if (!currentBatch) return;

        const uniqueMints = Array.from(currentBatch.mints);
        batchFetchDirectMarketData(currentBatch.ctx, uniqueMints)
          .then((dataMap) => {
            for (const m of uniqueMints) {
              const resList = currentBatch.resolvers.get(m) || [];
              const result = dataMap[m] || null;
              for (const res of resList) {
                try {
                  res(result);
                } catch {
                  // Suppress user callback execution errors
                }
              }
            }
          })
          .catch((err) => {
            currentBatch.ctx.logger(
              `Batched burst sampling market data fetch failed: ${err instanceof Error ? err.message : String(err)}`,
              'warn'
            );
            for (const m of uniqueMints) {
              const resList = currentBatch.resolvers.get(m) || [];
              for (const res of resList) {
                try {
                  res(null);
                } catch {}
              }
            }
          });
      }, 50); // 50ms debounce window
    }
  });
}

/**
 * Schedules a survival delay for a candidate after passing cheap audits.
 */
export function scheduleSurvivalDelay(ctx: Context, item: WorkItem, score: number): void {
  const { config, store } = ctx;
  const baseSeconds = config.burstModeEnabled
    ? config.burstSurvivalSeconds || 1.5
    : config.survivalDelaySeconds || 5;
  let delayMs = baseSeconds * 1000;
  if (!config.burstModeEnabled) {
    if (score >= (config.survivalDelayThresholdVeryHigh || 90)) {
      delayMs = baseSeconds * 100;
    } else if (score >= (config.survivalDelayThresholdHigh || 75)) {
      delayMs = baseSeconds * 500;
    }
  }
  store.upsertRecheckEntry({
    mint: item.token.id,
    tokenSnapshot: item.token,
    reason: 'survival',
    scheduledTime: Date.now() + delayMs,
    candidateScore: score,
    basePriceUsd: item.token.usdPrice,
    isSurvivalWait: true,
    auditAttempts: item.recheckEntry?.auditAttempts || 0,
  });

  if (config.burstModeEnabled) {
    auditService
      .getMintSignals(ctx, item.token.id, { priority: PRIORITY.LOW })
      .then((signals) => {
        ctx.state.prefetchedMintSignals.set(item.token.id, signals);
      })
      .catch(() => {});

    // Sample on-chain bonding curve during the survival window.
    // Only schedule timers that fire before the window closes to avoid stale
    // writes after the candidate has already been decided, and guard each
    // callback so it skips mints that were cleaned up between scheduling and firing.
    const sampledMint = item.token.id;
    const sampleTimes = [0, 1500, 3000, 4500].filter((t) => t < delayMs);
    for (const sampleDelay of sampleTimes) {
      setTimeout(() => {
        // Guard applies to all delays (including T=0) so a retired mint never
        // triggers a fetch or leaves a stale burstPriceSamples entry.
        if (!ctx.state.pendingCandidateRechecks.has(sampledMint)) return;
        batchedFetchDirectMarketData(ctx, sampledMint)
          .then((data) => {
            if (!data || !(data.usdPrice > 0)) return;
            // Skip if the mint was cleaned up (trackMint called) between scheduling and now.
            if (!ctx.state.pendingCandidateRechecks.has(sampledMint)) return;
            const existing = ctx.state.burstPriceSamples.get(sampledMint) ?? [];
            existing.push({
              price: data.usdPrice,
              liquidity: data.liquidity,
              timestamp: Date.now(),
            });
            ctx.state.burstPriceSamples.set(sampledMint, existing);
          })
          .catch(() => {});
      }, sampleDelay);
    }
  }
}

/**
 * Schedules a final audit for a candidate.
 */
export function scheduleFinalAudit(ctx: Context, item: WorkItem): void {
  const { config, store } = ctx;
  const delayMs = (config.finalAuditSeconds ?? 2) * 1000;
  store.incrementMetric('finalAuditQueued');
  store.upsertRecheckEntry({
    mint: item.token.id,
    tokenSnapshot: item.token,
    reason: 'final-audit',
    scheduledTime: Date.now() + delayMs,
    isFinalAudit: true,
    auditAttempts: item.recheckEntry?.auditAttempts || 0,
    // Carry forward survival-window price so burst overlay can compute entryMomentum.
    basePriceUsd: item.recheckEntry?.basePriceUsd,
    candidateScore: item.recheckEntry?.candidateScore,
  });
}

/**
 * Schedules a retry for a candidate experiencing RPC indexing lag.
 */
export function scheduleIndexingLagRetry(ctx: Context, item: WorkItem, retryCount: number): void {
  const { store } = ctx;
  if (retryCount > MAX_INDEXING_LAG_RETRIES) {
    store.trackMint(item.token.id);
    return;
  }
  store.incrementMetric('finalAuditDeferredIndexing', 1);
  const delayMs = 5000;
  store.upsertRecheckEntry({
    ...item.recheckEntry!,
    mint: item.token.id,
    tokenSnapshot: item.token,
    scheduledTime: Date.now() + delayMs,
    indexingLagRetries: retryCount,
  });
}

/**
 * Retrieves all pending rechecks that are due for processing.
 */
export function getDueCandidateRechecks(ctx: Context): RecheckItem[] {
  const { state } = ctx;
  const now = Date.now();
  const getDueTime = (r: RecheckItem): number => {
    if (Number.isFinite(r.scheduledTime)) return Number(r.scheduledTime);
    const parsed = r.nextEligibleAt ? new Date(r.nextEligibleAt).getTime() : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return Array.from(state.pendingCandidateRechecks.values())
    .filter((r) => getDueTime(r) <= now)
    .sort((a, b) => getDueTime(a) - getDueTime(b));
}

/**
 * Refreshes market snapshots and removes expired entries.
 */
export async function refreshMarketSnapshots(
  ctx: Context,
  launches: TokenMetadata[]
): Promise<void> {
  const { state, store } = ctx;
  const now = Date.now();
  for (const t of launches) {
    if (t?.id) {
      store.updateMarketSnapshot(t.id, {
        launchpad: t.launchpad || 'unknown',
        liquidity: Number(t.liquidity || 0),
        usdPrice: Number(t.usdPrice || 0),
        observedAt: new Date().toISOString(),
      });
      if (t.launchpad === 'pump.fun') {
        derivePumpCurvePda(t.id)
          .then((pda) => {
            if (pda) state.curveToMint.set(pda, t.id);
          })
          .catch(() => {});
      }
    }
  }
  for (const [m, s] of state.marketSnapshots.entries()) {
    if (state.positions.has(m) || state.pendingCandidateRechecks.has(m)) continue;
    if (now - new Date(s.observedAt || 0).getTime() > MARKET_SNAPSHOT_RETENTION_MS) {
      store.removeMarketSnapshot(m);
    }
  }
}

/**
 * Service object to allow for easier mocking in ESM environments.
 */
export const scannerService = {
  scanForCandidates,
  schedulePullbackRecheck,
  scheduleRecheckEligibleWaitlist,
  scheduleSurvivalDelay,
  scheduleFinalAudit,
  scheduleIndexingLagRetry,
  getDueCandidateRechecks,
  refreshMarketSnapshots,
};
