import { Position } from '../../src/types/index.js';

let positionCounter = 0;

export function createTestPosition(overrides: Partial<Position> = {}): Position {
  positionCounter += 1;
  const mint = overrides.mint || `PositionMint${positionCounter.toString().padStart(6, '0')}`;
  return {
    mint,
    symbol: overrides.symbol || `POS${positionCounter}`,
    name: overrides.name || `Position Token ${positionCounter}`,
    decimals: 9,
    openedAt: new Date().toISOString(),
    mode: 'paper',
    entryPriceUsd: 0.001,
    entryUsdValue: 10,
    entryScore: 80,
    initialTokenAmountRaw: '10000000000',
    highestPriceUsd: 0.001,
    partiallyClosed: false,
    takeProfitMultiples: [1.15, 1.75],
    takeProfitFractions: [0.75, 0.6],
    trailingStopDrawdownPctResolved: 0.2,
    maxHoldMinutesResolved: 60,
    volatilityScaler: 1.0,
    entryLiquidityUsd: 5000,
    targetsHit: 0,
    remainingCostUsd: 10,
    realizedPnlUsd: 0,
    ...overrides,
  };
}
