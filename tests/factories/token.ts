import { TokenMetadata, MarketSnapshot } from '../../src/types/index.js';

let mintCounter = 0;

export function createTestToken(overrides: Partial<TokenMetadata> = {}): TokenMetadata {
  mintCounter += 1;
  const id =
    overrides.id || `Mint${mintCounter.toString().padStart(6, '0')}${Date.now().toString(36)}`;
  return {
    id,
    name: `Test Token ${mintCounter}`,
    symbol: `TST${mintCounter}`,
    decimals: 9,
    usdPrice: 0.001,
    liquidity: 5000,
    marketCapUsd: 10000,
    holderCount: 150,
    organicScore: 85,
    isVerified: true,
    launchpad: 'pump.fun',
    stats5m: {
      numBuys: 40,
      numSells: 10,
    },
    ...overrides,
  };
}

export function createTestMarketSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    launchpad: 'pump.fun',
    usdPrice: 0.001,
    liquidityUsd: 5000,
    holderCount: 150,
    observedAt: new Date().toISOString(),
    isVerified: true,
    ...overrides,
  };
}
