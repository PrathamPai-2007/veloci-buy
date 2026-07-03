import { formatUsd, ratioToPercentString } from '#core/utils.js';
import { BURN_OWNERS } from '#core/config.js';
import * as audit from '../audit/audit.service.js';
import { Context, TokenMetadata, EvaluationResult, MintSignals } from '#types/index.js';
import { mlService } from '#ml/ml-service.js';
import { extractFeatures } from '#ml/features.js';
import { ghostTrader } from '#ml/ghost-trader.js';
import { applyBurstOverlay } from '../burst/index.js';
import {
  finiteNumber,
  getValidPriceHistory,
  getLaunchpadProfile,
  getLaunchpadAdjustedThresholds,
  computeCandidateScore,
  computeMomentumScore,
  looksLikeMemecoin,
  countSocialLinks,
  isReducedHistoricalSnapshot,
  isSlightlyBelowThreshold,
  computeEffectiveMinScore,
  applyMomentumFilters,
  maybeWarnClockSkew,
  CLOCK_SKEW_TOLERANCE_SECONDS,
} from './scoring.js';

// Re-export everything from scoring so existing imports keep working unchanged.
export {
  finiteNumber,
  getLaunchpadProfile,
  getLaunchpadAdjustedThresholds,
  computeCandidateScore,
  computeMomentumScore,
  looksLikeMemecoin,
  countSocialLinks,
  isReducedHistoricalSnapshot,
  isSlightlyBelowThreshold,
  computeEffectiveMinScore,
} from './scoring.js';

// Legacy aliases kept for callers that import these names.
export { countSocialLinks as countSocialLinksHelper } from './scoring.js';
export { finiteNumber as finiteNumberHelper } from './scoring.js';

const SURVIVAL_MOMENTUM_PASS_BAND_PCT = 2;
const MARKET_CAP_PASS_BAND_PCT = 4;

/**
 * Applies the ML scoring gate to an already rule-approved evaluation result.
 * In shadow mode the ML score is attached but never gates the trade.
 */
function applyMlGate(result: EvaluationResult): EvaluationResult {
  const mlScore = mlService.getScore(result);
  if (!mlScore) return result;

  const features = extractFeatures(result);
  const mlFeaturesJson = JSON.stringify(Array.from(features));

  if (mlScore.blocked && !mlScore.shadowMode) {
    return {
      ...result,
      approved: false,
      blockers: [...result.blockers, 'ML model confidence below threshold'],
      rejectionReasons: [
        ...result.rejectionReasons,
        { code: 'ml-low-confidence', recheckEligible: true },
      ],
      mlScore,
      mlFeaturesJson,
    };
  }

  return {
    ...result,
    mlScore,
    mlFeaturesJson,
    tpProfileOverride: mlScore.shadowMode ? undefined : mlScore.tpProfile,
  };
}

/**
 * Performs a multi-stage evaluation of a token candidate.
 * Applies strategy filters including momentum, liquidity, volume, and audits.
 *
 * @param ctx - The application context.
 * @param token - The token metadata to evaluate.
 * @param highestSeenPriceUsd - The highest price observed for this token.
 * @param priceHistory - Historical price data.
 * @param priceAtStartOfDelay - Price when the evaluation delay started.
 * @param liquidityAtStartOfDelay - Liquidity when the evaluation delay started.
 * @param tapeAtStart - Transaction tape (buys/sells) at the start of delay.
 * @param tapeHistory - Historical transaction tape data.
 * @param depth - Depth of evaluation ('cheap' skips heavy audits).
 * @param priority - RPC priority level.
 * @param preFetchedSignals - Optional pre-fetched mint signals to optimize performance.
 * @param opts - Additional options (e.g. lightAudit skip flag).
 * @returns An evaluation result with approval status and reasons.
 */
export async function evaluateCandidate(
  ctx: Context,
  token: TokenMetadata,
  highestSeenPriceUsd: number | null = null,
  priceHistory: unknown[] = [],
  priceAtStartOfDelay: number | null = null,
  liquidityAtStartOfDelay: number | null = null,
  tapeAtStart: { buys: number; sells: number } | null = null,
  tapeHistory: unknown[] = [],
  depth = 'cheap',
  priority: number | undefined = undefined,
  preFetchedSignals?: MintSignals,
  opts?: { lightAudit?: boolean }
): Promise<EvaluationResult> {
  const blockers: string[] = [];
  const rejectionReasons: { code: string; recheckEligible: boolean }[] = [];
  const notes: string[] = [];
  const now = Date.now();
  const firstPoolCreatedAt = token.firstPool?.createdAt
    ? new Date(token.firstPool.createdAt).getTime()
    : null;
  const rawAgeSeconds = Number.isFinite(firstPoolCreatedAt)
    ? Math.floor((now - (firstPoolCreatedAt as number)) / 1000)
    : null;
  // A significantly negative age means the pool was created "in the future" relative to our
  // local clock (system clock behind real time). Clamp to 0 and warn so the operator can fix NTP.
  let ageSeconds = rawAgeSeconds;
  if (rawAgeSeconds != null && rawAgeSeconds < 0) {
    if (rawAgeSeconds < -CLOCK_SKEW_TOLERANCE_SECONDS) {
      maybeWarnClockSkew(ctx, rawAgeSeconds);
    }
    ageSeconds = 0;
  }
  const socialLinks = countSocialLinks(token);
  const reducedHistoricalSnapshot = isReducedHistoricalSnapshot(token);

  const usdPrice = finiteNumber(token.usdPrice);
  const liquidity = finiteNumber(token.liquidity);
  const fdv = finiteNumber(token.fdv);
  const holderCount = finiteNumber(token.holderCount);
  const organicScore = finiteNumber(token.organicScore);
  const buys5m = finiteNumber(token.stats5m?.numBuys);
  const sells5m = finiteNumber(token.stats5m?.numSells);

  // Trending coins (from the Jupiter top-traded feed) are, by definition, ones the crowd is
  // already piling into — so the anti-top guards that reject "it already ran" candidates are
  // moderately relaxed for them only. The normal new-mint flow keeps the stricter thresholds.
  const isTrending = token.isTrending === true;
  const effMaxSurvivalGrowthPct = isTrending
    ? ctx.config.trendingMaxSurvivalGrowthPct
    : ctx.config.maxSurvivalGrowthPct;
  const effMaxBuyTopGrowthPct = isTrending
    ? ctx.config.trendingMaxBuyTopGrowthPct
    : ctx.config.maxBuyTopGrowthPct;
  const effMaxPriceDumpPct = isTrending
    ? ctx.config.trendingMaxPriceDumpPct
    : ctx.config.maxPriceDumpPct;
  const effMaxTop1Pct = isTrending
    ? ctx.config.trendingMaxTokenAccountTop1Pct
    : ctx.config.maxTokenAccountTop1Pct;
  const effMaxTop5Pct = isTrending
    ? ctx.config.trendingMaxTokenAccountTop5Pct
    : ctx.config.maxTokenAccountTop5Pct;

  const validPriceHistory = getValidPriceHistory(priceHistory);
  const launchpadProfile = getLaunchpadProfile(token.launchpad);
  const thresholds = getLaunchpadAdjustedThresholds(ctx, launchpadProfile);
  let entryScore = computeCandidateScore(token, launchpadProfile, thresholds, socialLinks);
  if (ctx.config.momentumScoringEnabled) {
    const momentumDelta = computeMomentumScore(
      token,
      validPriceHistory,
      finiteNumber(priceAtStartOfDelay, 0),
      usdPrice
    );
    entryScore = Math.min(100, Math.max(0, entryScore + momentumDelta));
  }

  let volatilityScaler = 0;
  if (validPriceHistory.length >= 5) {
    const prices = validPriceHistory.map((h) => h.price);
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    const variance = prices.reduce((sum, p) => sum + (p - mean) ** 2, 0) / prices.length;
    const stdDev = Math.sqrt(variance);
    volatilityScaler = mean > 0 ? stdDev / mean : 0;
  }

  const addBlocker = (message: string, code = 'other', recheckEligible = false) => {
    blockers.push(message);
    rejectionReasons.push({ code, recheckEligible });
  };

  // Reject tokens explicitly launched on a non-pump.fun platform (e.g. Raydium graduates).
  // Allow null/unknown — fresh mints often arrive untagged before Jupiter indexes their launchpad.
  // Normalize casing the same way getLaunchpadProfile does, so a capitalized 'Pump.fun' (which can
  // still reach here via the id-endsWith('pump') branch of the scan filter) is not wrongly blocked.
  const normalizedLaunchpad =
    typeof token.launchpad === 'string' ? token.launchpad.trim().toLowerCase() : token.launchpad;
  if (
    normalizedLaunchpad &&
    normalizedLaunchpad !== 'pump.fun' &&
    normalizedLaunchpad !== 'unknown'
  ) {
    addBlocker(`Non-pump.fun launchpad: ${token.launchpad}`, 'wrong-launchpad', false);
  }

  // Liquidity Drain Guard
  if (liquidityAtStartOfDelay != null && liquidityAtStartOfDelay > 0) {
    const liqDropRatio = 1 - liquidity / liquidityAtStartOfDelay;
    if (liqDropRatio > ctx.config.maxLiquidityDrawdownPct / 100) {
      addBlocker(
        `Liquidity is draining: ${formatUsd(liquidity)} is ${ratioToPercentString(liqDropRatio)} below start ${formatUsd(liquidityAtStartOfDelay)}.`,
        'liquidity-draining'
      );
    }
  }

  const startDelayPrice = finiteNumber(priceAtStartOfDelay, NaN);
  if (startDelayPrice > 0) {
    const currentPrice = usdPrice;
    const momentum = currentPrice / startDelayPrice;
    const growthPct = (momentum - 1) * 100;

    if (growthPct > effMaxSurvivalGrowthPct) {
      addBlocker(
        `Parabolic growth detected: ${growthPct.toFixed(1)}% exceeds limit of ${effMaxSurvivalGrowthPct}%.`,
        'parabolic-growth'
      );
    }
    if (momentum < ctx.config.minSurvivalMomentum * (1 - SURVIVAL_MOMENTUM_PASS_BAND_PCT / 100)) {
      addBlocker(
        `Survival momentum failed: ${momentum.toFixed(3)}x is below required ${ctx.config.minSurvivalMomentum}x (pass band ${SURVIVAL_MOMENTUM_PASS_BAND_PCT}%).`,
        'low-survival-momentum'
      );
    }
    if (momentum < ctx.config.minBreakoutMultiplier) {
      addBlocker(
        `Minimum breakout failed: ${momentum.toFixed(3)}x is below required ${ctx.config.minBreakoutMultiplier}x threshold.`,
        'low-breakout'
      );
    }

    applyMomentumFilters(
      ctx,
      validPriceHistory,
      currentPrice,
      now,
      startDelayPrice,
      token,
      tapeHistory,
      addBlocker
    );
  }

  const highestSeenPrice = finiteNumber(highestSeenPriceUsd, NaN);
  if (highestSeenPrice > 0) {
    const currentPrice = usdPrice;
    const dropRatio = 1 - currentPrice / highestSeenPrice;
    if (dropRatio > effMaxPriceDumpPct / 100) {
      addBlocker(
        `Price is dumping: ${formatUsd(currentPrice)} is ${ratioToPercentString(dropRatio)} below peak ${formatUsd(highestSeenPrice)}.`,
        'price-dumping'
      );
    }

    if (startDelayPrice > 0) {
      const growthSinceStart = (currentPrice / startDelayPrice - 1) * 100;
      const isNearAth =
        currentPrice >= highestSeenPrice * (1 - ctx.config.buyTopAthBufferPct / 100);
      if (growthSinceStart > effMaxBuyTopGrowthPct && isNearAth) {
        addBlocker(
          `Buying the top detected: Growth since start is ${growthSinceStart.toFixed(1)}% and price is near ATH. Waiting for pullback.`,
          'buying-the-top',
          true
        );
      }
    }
  }

  // Sell Pressure Guard
  if (tapeAtStart) {
    const startBuys = finiteNumber(tapeAtStart.buys);
    const startSells = finiteNumber(tapeAtStart.sells);
    const buysDelta = buys5m - startBuys;
    const sellsDelta = sells5m - startSells;
    if (sellsDelta > 0) {
      const effectiveBuysDelta = Math.max(1, buysDelta);
      const sellRatio = sellsDelta / effectiveBuysDelta;
      const sellPressureIncrease = (sellsDelta / Math.max(1, startSells)) * 100;
      if (sellRatio > 0.8 && sellPressureIncrease > ctx.config.maxSellPressureIncreasePct) {
        addBlocker(
          `High selling pressure: Sells increased by ${sellPressureIncrease.toFixed(1)}% during delay (Sell/Buy ratio: ${sellRatio.toFixed(2)}).`,
          'high-sell-pressure'
        );
      }
    }
  }

  // A mint caught by ws-mint-init at creation has an empty bonding curve: price/liquidity/buys
  // all zero. That is "not born yet", not "dead" — recheck it as the curve fills rather than
  // hard-rejecting (which blacklists it via trackMint and removes it from discovery forever).
  // A token that *had* liquidity and lost it is caught by the draining/dumping blockers above.
  const isUnbornMint = !(usdPrice > 0) && !(Number(liquidity) > 0) && buys5m === 0;
  const isNonPump = !!(normalizedLaunchpad && normalizedLaunchpad !== 'pump.fun');

  // Light audit hard-kill gates — categorically bad tokens regardless of any other signal
  if (!looksLikeMemecoin(ctx, token)) addBlocker('Does not match heuristic.', 'not-memecoin');

  // If Jupiter is behind for Raydium/Meteora, price will be 0. Soft-reject instead of hard-reject.
  if (!(usdPrice > 0)) addBlocker('No price.', 'missing-price', isUnbornMint || isNonPump);

  if (!Number.isFinite(liquidity) || liquidity < thresholds.minLiquidityUsd) {
    addBlocker(
      `Low liquidity ${formatUsd(liquidity)}.`,
      'low-liquidity',
      isUnbornMint ||
        isNonPump ||
        isSlightlyBelowThreshold(ctx, liquidity, thresholds.minLiquidityUsd)
    );
  }

  // Minimum market-cap floor (FDV is the proxy: pump.fun supply is ~fixed). Only applied when
  // FDV is known (>0) so brand-new mints without market data aren't hard-rejected before it
  // arrives. Recheck-eligible: a coin below the floor can climb across it.
  if (fdv > 0 && fdv < ctx.config.minMarketCapUsd * (1 - MARKET_CAP_PASS_BAND_PCT / 100)) {
    addBlocker(
      `Market cap too low: ${formatUsd(fdv)} below floor ${formatUsd(ctx.config.minMarketCapUsd)} (pass band ${MARKET_CAP_PASS_BAND_PCT}%).`,
      'low-market-cap',
      true
    );
  }

  // Zero buys = literally dead token; configured minBuys5m floor is evaluated in heavy audit
  if (!reducedHistoricalSnapshot && buys5m === 0) {
    addBlocker('Zero 5m buys.', 'zero-buys', isUnbornMint);
  }

  if (!ctx.config.allowVerifiedTokens && token.isVerified) {
    addBlocker('Verified tokens are disabled by config.', 'verified-token-disabled');
  }

  // isSus flag is a hard kill; topHoldersPercentage (soft threshold) is evaluated in heavy audit
  if (token.audit?.isSus) {
    addBlocker('Jupiter audit marks token as suspicious.', 'jupiter-audit-suspicious');
  }

  // Age Checks
  if (ageSeconds != null) {
    if (ageSeconds < thresholds.minPoolAgeSeconds) {
      addBlocker(`Too new ${ageSeconds}s.`, 'too-new', true);
    }
    if (ageSeconds > ctx.config.maxCandidateAgeMinutes * 60) {
      addBlocker(`Too old ${(ageSeconds / 60).toFixed(1)}m.`, 'too-old');
    }
  } else {
    notes.push('Missing age data.');
  }

  if (reducedHistoricalSnapshot) {
    if (!(holderCount > 0)) notes.push('Historical backfill is missing holder count.');
    if (!Number.isFinite(Number(token.organicScore)))
      notes.push('Historical backfill is missing organic score.');
    if (!Number.isFinite(Number(token.stats5m?.numBuys)))
      notes.push('Historical backfill is missing 5m buy tape.');
  }

  // Hard-kill gates done — return immediately if any fired, no ghost notification
  if (blockers.length > 0) {
    return {
      approved: false,
      blockers,
      rejectionReasons,
      notes,
      candidateScore: entryScore,
      volatilityScaler,
      launchpadProfile,
      adjustedThresholds: thresholds,
      token,
    };
  }

  // Cheap depth: notify ghost and apply ML/burst overlay, then return.
  // Soft quality gates (holders, organic score, buys floor, social links, FDV/liq ratio,
  // top-holder %, score gate) are deferred to heavy audit so they fire after on-chain
  // safety signals are known and token quality can be assessed with full information.
  if (depth === 'cheap') {
    const cheapResult: EvaluationResult = {
      approved: true,
      blockers,
      rejectionReasons,
      notes,
      candidateScore: entryScore,
      volatilityScaler,
      launchpadProfile,
      adjustedThresholds: thresholds,
      token,
    };
    ghostTrader.notifyCandidate(cheapResult);
    return applyBurstOverlay(ctx, applyMlGate(cheapResult), {
      priceHistory,
      priceAtStartOfDelay,
      liquidityAtStartOfDelay,
      tapeAtStart,
      tapeHistory,
    });
  }

  // Soft quality gates — heavy audit only, evaluated with full metadata context
  if (!reducedHistoricalSnapshot) {
    if (!Number.isFinite(holderCount) || holderCount < thresholds.minHolderCount) {
      addBlocker(
        `Low holders ${holderCount}.`,
        'low-holders',
        isSlightlyBelowThreshold(ctx, holderCount, thresholds.minHolderCount)
      );
    }
    if (!Number.isFinite(organicScore) || organicScore < ctx.config.minOrganicScore) {
      addBlocker(`Low organic score ${organicScore}.`, 'low-organic-score');
    }
    if (buys5m < thresholds.minBuys5m) {
      addBlocker(
        `Low 5m buys ${buys5m}.`,
        'low-buys',
        isSlightlyBelowThreshold(ctx, buys5m, thresholds.minBuys5m)
      );
    }
  }

  if (socialLinks < ctx.config.minSocialLinks) {
    addBlocker(`Low social links ${socialLinks}.`, 'low-social-links');
  }

  if (fdv > 0 && liquidity > 0) {
    const fdvToLiquidity = fdv / liquidity;
    if (fdvToLiquidity > ctx.config.maxFdvToLiquidity) {
      addBlocker(
        `FDV/liquidity too high: ${fdvToLiquidity.toFixed(2)} exceeds ${ctx.config.maxFdvToLiquidity}.`,
        'fdv-liquidity-too-high'
      );
    }
  }

  if (
    token.audit?.topHoldersPercentage != null &&
    token.audit.topHoldersPercentage > ctx.config.maxAuditTopHoldersPct
  ) {
    addBlocker(
      `Jupiter audit top holders ${token.audit.topHoldersPercentage}% exceeds ${ctx.config.maxAuditTopHoldersPct}%.`,
      'jupiter-audit-top-holders'
    );
  }

  // Score gate — fires after soft gates so the score is evaluated with full metadata context
  if (!reducedHistoricalSnapshot) {
    const { effective: adjustedMinScore, note } = computeEffectiveMinScore(
      ctx,
      ctx.config.minCandidateScore
    );
    if (note) notes.push(note);
    if (entryScore < adjustedMinScore) {
      addBlocker(
        `Low entry score ${entryScore} (Target ${adjustedMinScore.toFixed(1)}).`,
        'entry-score-too-low',
        isSlightlyBelowThreshold(ctx, entryScore, adjustedMinScore)
      );
    }
  }

  if (blockers.length > 0) {
    return {
      approved: false,
      blockers,
      rejectionReasons,
      notes,
      candidateScore: entryScore,
      volatilityScaler,
      launchpadProfile,
      adjustedThresholds: thresholds,
      token,
    };
  }

  // Deep Audit
  const emptyMintSignals: MintSignals = {
    decimals: 0,
    supplyRaw: 0n,
    mintAuthority: null,
    freezeAuthority: null,
    top1Share: 0,
    top3Share: 0,
    top5Share: 0,
    topAccounts: [],
  };
  const BB_TIMEOUT_MS = 2000;
  const [mintSignals, rugCheckSignals, bbSignals] = opts?.lightAudit
    ? ([emptyMintSignals, null, null] as const)
    : await Promise.all([
        preFetchedSignals
          ? Promise.resolve(preFetchedSignals)
          : audit.auditService.getMintSignals(ctx, token.id, { priority }),
        ctx.config.rugcheckEnabled
          ? audit.auditService.fetchRugCheckSignals(ctx, token.id)
          : Promise.resolve(null),
        ctx.config.bubblemapsEnabled
          ? Promise.race([
              audit.auditService.fetchBubbleMapsSignals(ctx, token.id, { isTrending }),
              new Promise<null>((res) => setTimeout(() => res(null), BB_TIMEOUT_MS)),
            ]).catch(() => null)
          : Promise.resolve(null),
      ]);

  if (mintSignals.mintAuthority) {
    addBlocker(`Mint authority set: ${mintSignals.mintAuthority}`, 'mint-authority-enabled');
  }
  if (mintSignals.freezeAuthority) {
    addBlocker(`Freeze authority set: ${mintSignals.freezeAuthority}`, 'freeze-authority-enabled');
  }

  // Authentic Pump.fun verification
  if (token.launchpad === 'pump.fun' || token.id.toLowerCase().endsWith('pump')) {
    if (!token.id.toLowerCase().endsWith('pump')) {
      addBlocker('Fake pump.fun token: address does not end in pump.', 'fake-pump-token', false);
    }
    if (mintSignals.decimals !== 6 && mintSignals.decimals !== 0) {
      // Sometimes 0 if RPC data is incomplete but usually it's exactly 6
      addBlocker(
        `Fake pump.fun token: invalid decimals (${mintSignals.decimals}, expected 6).`,
        'fake-pump-decimals',
        false
      );
    }
  }

  if (mintSignals.top1Share > effMaxTop1Pct / 100) {
    addBlocker(
      `High top1 concentration ${ratioToPercentString(mintSignals.top1Share)}.`,
      'top1-concentration'
    );
  }

  // Top3 concentration gate: detects bundler/insider coordinated launches where 3 wallets
  // collectively hold an outsized share. Research shows top-3 > ~25% = likely coordinated snipe.
  const effMaxTop3Pct = isTrending
    ? ctx.config.maxTokenAccountTop3Pct * 1.5 // relax 50% for trending (crowd already in)
    : ctx.config.maxTokenAccountTop3Pct;
  if (mintSignals.top3Share > effMaxTop3Pct / 100) {
    addBlocker(
      `High top3 concentration ${ratioToPercentString(mintSignals.top3Share)} (bundler signal).`,
      'top3-concentration'
    );
  }

  // Unconditional top5 concentration gate. top5Share is already computed by getMintSignals above
  // (zero added I/O). This previously only ran inside the BubbleMaps branch below, which is
  // skipped when BubbleMaps is advisory-only (no API key) -- so concentrated rugs (top5 >80%)
  // sailed through on the top1 check alone. This is the single highest-ROI entry fix.
  if (mintSignals.top5Share > effMaxTop5Pct / 100) {
    addBlocker(
      `High top5 concentration ${ratioToPercentString(mintSignals.top5Share)}.`,
      'top5-concentration'
    );
  }

  if (rugCheckSignals) {
    if (rugCheckSignals.status === 'ok') {
      rugCheckSignals.blockers.forEach((b) => addBlocker(b, 'rugcheck-signal'));
      notes.push(...rugCheckSignals.notes);
      // Apply RugCheck normalised risk score as a scoring adjustment. score_normalised is 0–100
      // where 0 = clean and 100 = maximally risky. Map to [-2 bonus, +10 penalty] then subtract.
      // This adjusts entryScore so clean tokens gain a small edge and very risky ones lose more.
      if (rugCheckSignals.riskScore != null) {
        const rugPenalty = (rugCheckSignals.riskScore / 100) * 12 - 2;
        entryScore = Math.min(
          100,
          Math.max(0, entryScore - Math.max(-2, Math.min(10, rugPenalty)))
        );
        notes.push(
          `RugCheck score: ${rugCheckSignals.riskScore} (score adj ${(-Math.max(-2, Math.min(10, (rugCheckSignals.riskScore / 100) * 12 - 2))).toFixed(1)})`
        );
      }
    } else {
      notes.push(`RugCheck audit failed (${rugCheckSignals.status}). Relying on on-chain signals.`);
    }
  }

  if (bbSignals) {
    if (bbSignals.status === 'ok') {
      bbSignals.blockers.forEach((b) => addBlocker(b, 'bubblemaps-signal'));
      if (bbSignals.score != null) notes.push(`BubbleMaps score: ${bbSignals.score}`);
    } else {
      notes.push(
        `BubbleMaps audit skipped (${bbSignals.status}). Applying stricter concentration checks.`
      );
      // When BubbleMaps is unavailable, fall back to on-chain top5 with a tighter threshold.
      if (mintSignals.top5Share > (ctx.config.maxTokenAccountTop5Pct - 10) / 100) {
        addBlocker(
          `BubbleMaps down and top5 concentration ${ratioToPercentString(mintSignals.top5Share)} is borderline.`,
          'bubblemaps-fail-safe-concentration'
        );
      }
    }
  }

  // Owner Audit
  const owners = Array.from(
    new Set(
      (mintSignals.topAccounts || [])
        .map((a) => a.owner)
        .filter((o): o is string => o !== null && !BURN_OWNERS.has(o))
    )
  );
  if (owners.length > 0) {
    const malicious = await audit.auditService.fetchRugCheckWalletSignals(ctx, owners);
    if (malicious.length > 0) {
      addBlocker(
        `High-risk owners flagged by RugCheck: ${malicious.join(', ')}`,
        'rugcheck-malicious-owner'
      );
    }
  }

  // Symbol-level cooldown: the per-mint re-entry gate below misses copycat relaunches that reuse a
  // name across different mints (e.g. JAMES bought 3x). Block a fresh buy of a symbol we just exited.
  if (token.symbol && ctx.store.isSymbolOnCooldown(token.symbol)) {
    addBlocker(`Symbol ${token.symbol} on post-exit cooldown.`, 'symbol-cooldown');
  }

  // Re-entry Gate
  const retired = ctx.state.retiredMints.get(token.id);
  const lastExitPriceUsd = finiteNumber(retired?.lastExitPriceUsd, NaN);
  if (lastExitPriceUsd > 0 && usdPrice > 0) {
    const diff = ((usdPrice - lastExitPriceUsd) / lastExitPriceUsd) * 100;
    if (diff > -ctx.config.reentryDipPct && diff < ctx.config.reentryBreakoutPct) {
      addBlocker(
        `Price distance failed: ${diff.toFixed(2)}% in avoid range.`,
        'price-distance-gate'
      );
    }
  }

  const deepResult: EvaluationResult = {
    approved: blockers.length === 0,
    blockers,
    rejectionReasons,
    notes,
    candidateScore: entryScore,
    volatilityScaler,
    launchpadProfile,
    adjustedThresholds: thresholds,
    token,
    mintSignals,
    rugCheckSignals,
    bubbleMapsSignals: bbSignals,
  };
  if (deepResult.approved) ghostTrader.notifyCandidate(deepResult);
  return deepResult.approved
    ? applyBurstOverlay(ctx, applyMlGate(deepResult), {
        priceHistory,
        priceAtStartOfDelay,
        liquidityAtStartOfDelay,
        tapeAtStart,
        tapeHistory,
      })
    : deepResult;
}
