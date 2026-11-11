/**
 * Deep audit stage of candidate evaluation: on-chain mint/holder signals, RugCheck, BubbleMaps,
 * owner risk, symbol cooldown and the re-entry gate. Runs only for candidates that already passed
 * every cheap local gate (see evaluateCandidate).
 */
import { isPumpMintAddress, ratioToPercentString } from '#core/utils.js';
import { BURN_OWNERS } from '#core/config.js';
import * as audit from '../audit/audit.service.js';
import type {
  Context,
  TokenMetadata,
  MintSignals,
  RugCheckSignals,
  BubbleMapsSignals,
} from '#types/index.js';
import { finiteNumber } from './scoring.js';

const BB_TIMEOUT_MS = 2000;

export interface DeepAuditInput {
  ctx: Context;
  token: TokenMetadata;
  priority?: number;
  preFetchedSignals?: MintSignals;
  isTrending: boolean;
  /** Effective (trending-adjusted) top-1 / top-5 holder caps, in percent. */
  maxTop1Pct: number;
  maxTop5Pct: number;
  usdPrice: number;
  entryScore: number;
  notes: string[];
  addBlocker: (message: string, code?: string, recheckEligible?: boolean) => void;
}

export interface DeepAuditResult {
  mintSignals: MintSignals;
  rugCheckSignals: RugCheckSignals | null;
  bubbleMapsSignals: BubbleMapsSignals | null;
  /** The entry score after the RugCheck risk adjustment. */
  entryScore: number;
}

/** Adds blockers/notes through the caller's accumulators; returns the signals and adjusted score. */
export async function runDeepAudit(input: DeepAuditInput): Promise<DeepAuditResult> {
  const { ctx, token, priority, preFetchedSignals, isTrending, usdPrice, notes, addBlocker } =
    input;
  let entryScore = input.entryScore;

  const [mintSignals, rugCheckSignals, bbSignals] = await Promise.all([
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

  // Never buy blind: with no holder data every concentration share reads 0% and passes.
  if (mintSignals.holdersKnown === false) {
    addBlocker(
      'Holder data unavailable; refusing to buy without a holder check.',
      'holders-unknown',
      true
    );
  }

  if (mintSignals.mintAuthority) {
    addBlocker(`Mint authority set: ${mintSignals.mintAuthority}`, 'mint-authority-enabled');
  }
  if (mintSignals.freezeAuthority) {
    addBlocker(`Freeze authority set: ${mintSignals.freezeAuthority}`, 'freeze-authority-enabled');
  }

  // Authentic Pump.fun verification
  if (token.launchpad === 'pump.fun' || isPumpMintAddress(token.id)) {
    if (!isPumpMintAddress(token.id)) {
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

  if (mintSignals.top1Share > input.maxTop1Pct / 100) {
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
  if (mintSignals.top5Share > input.maxTop5Pct / 100) {
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
  const retired = ctx.state?.retiredMints?.get(token.id);
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

  return { mintSignals, rugCheckSignals, bubbleMapsSignals: bbSignals, entryScore };
}
