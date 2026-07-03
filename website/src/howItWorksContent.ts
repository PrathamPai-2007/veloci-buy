// Structured copy for the bespoke How It Works / features page.
// Wording is kept deliberately scrubbed of internal file names, class names,
// exact thresholds, and infra details — keep it that way when editing.

import type { IconName } from './components/HiwIcons';

export interface Gate {
  /** Two-digit display index, e.g. "01". */
  num: string;
  name: string;
  blurb: string;
  icon: IconName;
}

export interface Feature {
  title: string;
  blurb: string;
  bullets?: string[];
  icon: IconName;
  /** CSS color token used for the section accent (var(--...)). */
  accent: string;
}

export const hero = {
  eyebrow: 'V3 IS NOW LIVE',
  headline: 'Built for the speed of Solana.',
  subhead:
    'Veloci-Buy is an automated trading engine that finds, evaluates, and trades new Solana tokens — faster and more precisely than any manual process could.',
  cta: 'Start Trading',
  scrollCue: 'See how it works',
};

export const gatesIntro = {
  eyebrow: 'THE PIPELINE',
  title: 'Five gates between you and a token.',
  subhead:
    'Every candidate token passes through a layered evaluation pipeline before a single dollar is committed. Tokens that clear all five proceed to execution.',
};

export const gates: Gate[] = [
  {
    num: '01',
    name: 'Survival delay',
    blurb: 'Waits out the "instant dump" window where creators immediately sell into early buyers.',
    icon: 'radar',
  },
  {
    num: '02',
    name: 'Security audit',
    blurb: 'Checks mint authority, token ownership, and top wallet concentrations.',
    icon: 'shield',
  },
  {
    num: '03',
    name: 'Valuation check',
    blurb: 'Rejects pools with unbalanced liquidity or inflated market caps.',
    icon: 'scale',
  },
  {
    num: '04',
    name: 'Anti-FOMO guard',
    blurb: 'Skips tokens already in a parabolic vertical pump.',
    icon: 'flame',
  },
  {
    num: '05',
    name: 'ML confidence gate',
    blurb: 'Once trained, the model blocks low-confidence setups automatically.',
    icon: 'brain',
  },
];

export const features: Feature[] = [
  {
    title: 'Catch launches before the crowd',
    blurb:
      'Veloci-Buy listens directly to raw blockchain events — not explorers, not APIs with lag. New token launches are detected within seconds of hitting the chain, before most traders even know they exist.',
    icon: 'radar',
    accent: 'var(--color-cyan)',
  },
  {
    title: 'MEV-protected execution',
    blurb:
      'Orders are routed through validator bundle networks to prevent front-running and sandwich attacks. You don’t buy at the price you see — you buy at the price you intended.',
    icon: 'bolt',
    accent: 'var(--color-violet)',
  },
  {
    title: 'Machine learning, trained on real outcomes',
    blurb:
      'Veloci-Buy runs "ghost positions" — zero-capital shadow trades that track real price movement to generate ground-truth training data. The model trains on what actually happened, not simulations. Once it has seen enough real results, it begins filtering entries autonomously.',
    icon: 'ghost',
    accent: 'var(--color-cyan)',
  },
  {
    title: 'Exits that protect profits and cut losses fast',
    blurb: 'Position monitoring runs a full layered exit stack in real time:',
    bullets: [
      'Trailing stop that rises with price and never falls back',
      'Partial take-profits at configurable price tiers',
      'Moon-bag runner that holds a tranche on a wider stop for larger moves',
      'Rug-exit guard that detects sudden collapse and exits with maximum urgency',
      'Loss-streak breaker that pauses entries after consecutive losses',
    ],
    icon: 'ladder',
    accent: 'var(--color-error)',
  },
  {
    title: 'Multiple strategies, one engine',
    blurb:
      'Burst Mode is a short-duration scalp strategy for fast-moving opportunities — tighter parameters, shorter holds, higher urgency, toggled from the dashboard without a restart. Swing Bot targets tokens that have completed their bonding curve and entered standard pools, holding for minutes to hours on double-dip and volume-accumulation signals.',
    icon: 'layers',
    accent: 'var(--color-violet)',
  },
  {
    title: 'A live dashboard, always in sync',
    blurb:
      'The web dashboard connects directly to the trading engine over a secure real-time connection. View active signals, open positions, session P&L, ML model health, and a live activity log — all updating as events happen.',
    icon: 'monitor',
    accent: 'var(--color-cyan)',
  },
];

export const risk =
  'Trading digital assets carries significant financial risk. You may lose all of your capital. Veloci-Buy is not financial advice, and past performance does not predict future results. Only trade with what you can afford to lose entirely.';

export const disclaimer =
  'Veloci-Buy is an independent project. Not affiliated with Solana Foundation, Raydium, or any other protocol.';

export const closing = {
  eyebrow: 'READY?',
  title: 'Trade at the speed of the chain.',
  subhead: 'Open the dashboard and watch the engine work in real time.',
  cta: 'Start Trading',
};
