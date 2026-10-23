'use strict';

/**
 * Centralized external API mock factories for Jupiter, RugCheck, and BubbleMaps.
 */

export interface MockJupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: any[];
}

export function createMockJupiterQuote(
  overrides: Partial<MockJupiterQuote> = {}
): MockJupiterQuote {
  return {
    inputMint: 'So11111111111111111111111111111111111111112',
    inAmount: '50000000',
    outputMint: 'MintMock11111111111111111111111111111111111',
    outAmount: '1000000000',
    otherAmountThreshold: '950000000',
    swapMode: 'ExactIn',
    slippageBps: 500,
    priceImpactPct: '0.01',
    routePlan: [],
    ...overrides,
  };
}

export function createMockJupiterSwapResponse(txBase64 = 'c3dhcF90cmFuc2FjdGlvbl9kYXRh') {
  return {
    swapTransaction: txBase64,
    lastValidBlockHeight: 12345678,
  };
}

export interface MockRugCheckReport {
  mint: string;
  score: number;
  risks: Array<{ name: string; value: string; description: string; score: number; level: string }>;
  tokenMeta: {
    name: string;
    symbol: string;
    uri: string;
    mutable: boolean;
  };
  topHolders: Array<{ address: string; pct: number; uiAmount: number }>;
  freezeAuthority: string | null;
  mintAuthority: string | null;
}

export function createMockRugCheckReport(
  overrides: Partial<MockRugCheckReport> = {}
): MockRugCheckReport {
  return {
    mint: 'MintMock11111111111111111111111111111111111',
    score: 100,
    risks: [],
    tokenMeta: {
      name: 'Mock Token',
      symbol: 'MCK',
      uri: 'https://mock.uri',
      mutable: false,
    },
    topHolders: [
      { address: 'Holder1111111111111111111111111111111111', pct: 10, uiAmount: 1000 },
      { address: 'Holder2222222222222222222222222222222222', pct: 5, uiAmount: 500 },
    ],
    freezeAuthority: null,
    mintAuthority: null,
    ...overrides,
  };
}

export interface MockBubbleMapsProfile {
  mint: string;
  score: number;
  top10SharePct: number;
  largestClusterSharePct: number;
  clusterCount: number;
}

export function createMockBubbleMapsProfile(
  overrides: Partial<MockBubbleMapsProfile> = {}
): MockBubbleMapsProfile {
  return {
    mint: 'MintMock11111111111111111111111111111111111',
    score: 85,
    top10SharePct: 25,
    largestClusterSharePct: 12,
    clusterCount: 3,
    ...overrides,
  };
}
