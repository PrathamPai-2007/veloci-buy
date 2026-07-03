import { address } from '@solana/addresses';
import { Context, TipContext } from '#types/index.js';
import { rpcCall, PRIORITY, fetchJson } from '#core/utils.js';

const MIN_TIP_LAMPORTS = 100_000n;
const MAX_TIP_LAMPORTS = 200_000_000n;

// TTL caches — fee data changes at block granularity (~400ms); 5s is safe and
// eliminates redundant RPC/HTTP calls across swap retries and concurrent scans.
const FEE_CACHE_TTL_MS = 5_000;
let _cachedPriorityFee: { value: number; cachedAt: number } | null = null;
let _cachedJitoTipFloor: { value: bigint; cachedAt: number } | null = null;
let _priorityFeeInFlight: Promise<number> | null = null;
let _jitoTipInFlight: Promise<void> | null = null;

/**
 * Probabilistic MEV tip. Scales a baseline tip (the network tip floor) by the
 * trade's conviction and the current block congestion, then caps it so we never
 * pay more than a sensible fraction of what the trade is expected to earn:
 *
 *   tip = floor × (0.5 + confidence) × (1 + congestion) × panic
 *   tip = min(tip, maxFractionOfEv × expectedValue)
 *
 *   • confidence (ML) → bid up to win inclusion on high-conviction entries.
 *   • congestion [0,1] (e.g. GMI) → bid up when blocks are contested.
 *   • EV cap → the guardrail against overpaying to front-run a thin edge.
 *
 * Pure and deterministic so it can be unit-tested without network access.
 */
export function computeProbabilisticTip(
  baseTipLamports: bigint,
  opts: {
    confidence: number; // [0,1]
    congestion: number; // [0,1]
    expectedValueLamports: bigint;
    isPanic: boolean;
    panicMultiplier: number;
    maxFractionOfEv: number;
    minTip?: bigint;
    maxTip?: bigint;
    /** When set, overrides the isPanic/panicMultiplier calculation (graduated exits). */
    urgencyMultiplier?: number;
  }
): bigint {
  const confidence = clamp01(opts.confidence);
  const congestion = clamp01(opts.congestion);

  const confidenceFactor = 0.5 + confidence; // [0.5, 1.5], neutral at 0.5 → 1.0
  const congestionFactor = 1 + congestion; // [1, 2]
  const panicFactor =
    opts.urgencyMultiplier !== undefined
      ? Math.max(1, opts.urgencyMultiplier)
      : opts.isPanic
        ? Math.max(1, opts.panicMultiplier)
        : 1;

  const base = Number(baseTipLamports);
  let tip = Math.round(base * confidenceFactor * congestionFactor * panicFactor);

  // Never tip more than a fraction of the expected profit.
  if (opts.expectedValueLamports > 0n && opts.maxFractionOfEv > 0) {
    const cap = Math.round(Number(opts.expectedValueLamports) * opts.maxFractionOfEv);
    if (cap < tip) tip = cap;
  }

  let tipLamports = BigInt(Math.max(0, tip));
  const minTip = opts.minTip ?? MIN_TIP_LAMPORTS;
  const maxTip = opts.maxTip ?? MAX_TIP_LAMPORTS;
  if (tipLamports < minTip) tipLamports = minTip;
  if (tipLamports > maxTip) tipLamports = maxTip;
  return tipLamports;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Reads live congestion (GMI) and applies the probabilistic tip for a buy. */
function applyTipContext(
  ctx: Context,
  baseTip: bigint,
  isPanic: boolean,
  tipContext: TipContext
): bigint {
  const congestion = typeof ctx.calculateGMI === 'function' ? ctx.calculateGMI() : 0.5;
  return computeProbabilisticTip(baseTip, {
    confidence: tipContext.confidence,
    congestion,
    expectedValueLamports: tipContext.expectedValueLamports,
    isPanic,
    panicMultiplier: ctx.config.priorityFeePanicMultiplier || 2,
    maxFractionOfEv: ctx.config.jitoTipMaxFractionOfEv,
    urgencyMultiplier: tipContext.urgencyMultiplier,
  });
}

export async function fetchDynamicPriorityFee(
  ctx: Context,
  accountKeys: string[] = [],
  isPanic = false
): Promise<number> {
  // Serve from cache when no account-specific keys are requested (the common path).
  // Panic calls skip the cache because they need the multiplier applied fresh.
  if (!isPanic && !ctx.config.priorityFeeAccountLocal && _cachedPriorityFee) {
    if (Date.now() - _cachedPriorityFee.cachedAt < FEE_CACHE_TTL_MS) {
      return _cachedPriorityFee.value;
    }
  }
  if (!isPanic && !ctx.config.priorityFeeAccountLocal) {
    if (_priorityFeeInFlight) return _priorityFeeInFlight;
    _priorityFeeInFlight = _fetchPriorityFeeUncached(ctx, accountKeys).finally(() => {
      _priorityFeeInFlight = null;
    });
    return _priorityFeeInFlight;
  }
  return _fetchPriorityFeeUncached(ctx, accountKeys, isPanic);
}

async function _fetchPriorityFeeUncached(
  ctx: Context,
  accountKeys: string[],
  isPanic = false
): Promise<number> {
  try {
    const useAccountLocal = ctx.config.priorityFeeAccountLocal && accountKeys.length > 0;
    const publicKeys = useAccountLocal ? accountKeys.map((key) => address(key)) : [];

    const fees = (await rpcCall(ctx, 'getRecentPrioritizationFees', [publicKeys], {
      priority: PRIORITY.HIGH,
    })) as unknown as Array<{ prioritizationFee: number }>;

    if (fees.length === 0) {
      return ctx.config.priorityFeeBaseMicroLamports;
    }

    const sortedFees = fees.map((f) => Number(f.prioritizationFee)).sort((a, b) => a - b);
    const index = Math.floor((ctx.config.priorityFeePercentile / 100) * (sortedFees.length - 1));
    const baseFee = sortedFees[index] || 0;

    let finalFee = Math.max(ctx.config.priorityFeeBaseMicroLamports, baseFee);

    let volatilityMultiplier = ctx.config.priorityFeeVolatilityMultiplier || 1.0;
    const gmi = typeof ctx.calculateGMI === 'function' ? ctx.calculateGMI() : 0.5;
    if (gmi > 0.8) {
      volatilityMultiplier *= 1.5;
    } else if (gmi > 0.6) {
      volatilityMultiplier *= 1.2;
    }

    finalFee = Math.round(finalFee * volatilityMultiplier);

    if (isPanic) {
      finalFee = Math.round(finalFee * ctx.config.priorityFeePanicMultiplier);
    } else if (!ctx.config.priorityFeeAccountLocal) {
      _cachedPriorityFee = {
        value: Math.min(finalFee, ctx.config.priorityFeeMaxMicroLamports),
        cachedAt: Date.now(),
      };
    }

    return Math.min(finalFee, ctx.config.priorityFeeMaxMicroLamports);
  } catch (error: unknown) {
    ctx.logger(
      `Failed to fetch priority fees: ${error instanceof Error ? error.message : String(error)}. Using base fee.`,
      'warn'
    );
    return ctx.config.priorityFeeBaseMicroLamports;
  }
}

export async function getDynamicJitoTip(
  ctx: Context,
  isPanic = false,
  tipContext?: TipContext
): Promise<bigint> {
  const defaultTip = ctx.config.jitoTipLamports || 1_000_000n;
  if (!ctx.config.dynamicJitoTipEnabled) {
    return defaultTip;
  }
  if (!ctx.config.jitoTipFloorApiUrl && !ctx.config.jitoBlockEngineUrl) {
    // No floor source: still scale the static tip probabilistically when a
    // trade context is supplied (buys), otherwise return the static tip.
    return tipContext ? applyTipContext(ctx, defaultTip, isPanic, tipContext) : defaultTip;
  }

  let url = ctx.config.jitoTipFloorApiUrl;
  if (!url) {
    const engineUrl = ctx.config.jitoBlockEngineUrl;
    if (engineUrl.endsWith('/api/v1/bundles')) {
      url = engineUrl.replace('/api/v1/bundles', '/api/v1/tips');
    } else if (engineUrl.endsWith('/api/v1/bundles/')) {
      url = engineUrl.replace('/api/v1/bundles/', '/api/v1/tips');
    } else {
      url = `${engineUrl.replace(/\/$/, '')}/api/v1/tips`;
    }
  }

  // Serve the floor value from cache when it is fresh enough — tip floors change
  // at block granularity (~400ms) so a 5s cache is safe across all retry attempts.
  let floorTip: bigint | null =
    _cachedJitoTipFloor && Date.now() - _cachedJitoTipFloor.cachedAt < FEE_CACHE_TTL_MS
      ? _cachedJitoTipFloor.value
      : null;

  if (floorTip === null) {
    // Deduplicate concurrent cache-miss fetches: share one in-flight HTTP request
    // so two concurrent non-panic callers don't both hit the tip-floor API.
    const logFetchError = (err: unknown) => {
      ctx.logger(
        `Failed to fetch dynamic Jito tip floor: ${err instanceof Error ? err.message : String(err)}. Using default tip.`,
        'warn'
      );
    };
    if (!isPanic && _jitoTipInFlight) {
      await _jitoTipInFlight.catch(logFetchError);
    } else {
      const fetchPromise = _fetchAndCacheJitoFloor(ctx, url!);
      if (!isPanic) {
        _jitoTipInFlight = fetchPromise.finally(() => {
          _jitoTipInFlight = null;
        });
      }
      await fetchPromise.catch(logFetchError);
    }
    // Re-read cache after fetch (set by _fetchAndCacheJitoFloor on success).
    floorTip = _cachedJitoTipFloor?.value ?? null;
  }

  if (floorTip === null) {
    // API unavailable or returned no data — fall back to the default tip.
    if (tipContext) return applyTipContext(ctx, defaultTip, isPanic, tipContext);
    let tip = defaultTip;
    if (isPanic) tip *= BigInt(Math.max(1, ctx.config.priorityFeePanicMultiplier || 2));
    if (tip < MIN_TIP_LAMPORTS) tip = MIN_TIP_LAMPORTS;
    if (tip > MAX_TIP_LAMPORTS) tip = MAX_TIP_LAMPORTS;
    return tip;
  }

  // floorTip is set — either from the cache or from the fetch above.
  const resolvedFloor = floorTip;

  // Buys carry a trade context → scale the floor by conviction/congestion and
  // cap by EV. Other flows (sells/exits) keep the plain percentile + panic tip.
  if (tipContext) {
    return applyTipContext(ctx, resolvedFloor, isPanic, tipContext);
  }

  let tipLamports = resolvedFloor;
  if (isPanic) {
    const multiplier = BigInt(Math.max(1, ctx.config.priorityFeePanicMultiplier || 2));
    tipLamports *= multiplier;
  }
  if (tipLamports < MIN_TIP_LAMPORTS) tipLamports = MIN_TIP_LAMPORTS;
  if (tipLamports > MAX_TIP_LAMPORTS) tipLamports = MAX_TIP_LAMPORTS;
  return tipLamports;
}

/**
 * Resets all module-level TTL caches.
 * @testOnly — never call in production code; cache bleed between test cases causes flaky fees.
 */
export function _resetFeeCacheForTest(): void {
  _cachedPriorityFee = null;
  _cachedJitoTipFloor = null;
  _priorityFeeInFlight = null;
  _jitoTipInFlight = null;
}

/** Fetches the Jito tip floor and writes it to `_cachedJitoTipFloor`. Throws on error. */
async function _fetchAndCacheJitoFloor(ctx: Context, url: string): Promise<void> {
  const response = (await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'getTipFloor',
      params: [],
    },
    timeoutMs: 4000,
    retries: 1,
  })) as {
    result?: Array<{
      landed_tips_25th_percentile?: number;
      landed_tips_50th_percentile?: number;
      landed_tips_75th_percentile?: number;
      landed_tips_95th_percentile?: number;
      landed_tips_99th_percentile?: number;
    }>;
  };

  const stats = response?.result?.[0];
  if (!stats) return; // caller handles floorTip === null as a fallback

  const percentile = ctx.config.jitoTipPercentile || 75;
  let solPrice = stats.landed_tips_75th_percentile || 0.001;
  if (percentile === 25) solPrice = stats.landed_tips_25th_percentile || solPrice;
  else if (percentile === 50) solPrice = stats.landed_tips_50th_percentile || solPrice;
  else if (percentile === 75) solPrice = stats.landed_tips_75th_percentile || solPrice;
  else if (percentile === 95) solPrice = stats.landed_tips_95th_percentile || solPrice;
  else if (percentile === 99) solPrice = stats.landed_tips_99th_percentile || solPrice;

  _cachedJitoTipFloor = { value: BigInt(Math.round(solPrice * 1e9)), cachedAt: Date.now() };
}
