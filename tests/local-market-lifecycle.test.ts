import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { localMarketState } from '../src/services/market-state/local-market-state.js';
import { marketDataProvider } from '../src/services/market-state/market-data-provider.js';
import { decodePumpCurveState } from '../src/services/market-state/decoders/pump-curve-decoder.js';
import { jupiterDiscoveryBreaker } from '../src/services/jupiter-circuit-breaker.js';
import { evaluateCandidate } from '../src/services/engine/engine.service.js';
import { derivePumpCurvePda } from '../src/core/utils.js';
import { createCtx, createState } from './_test_helpers.js';
import { TokenMetadata } from '../src/types/index.js';

describe('Local Market State Lifecycle & Pump.fun Discovery', () => {
  it('seeds provisional state on discovery and upgrades to authoritative on Geyser update', async () => {
    localMarketState.clear();
    const mint = 'PumpTestMint111111111111111111111111111111';

    // 1. Initial discovery seeding
    localMarketState.seedInitialPumpFunSnapshot(mint, 200);

    assert.equal(marketDataProvider.getStateStatus(mint), 'PROVISIONAL');
    assert.equal(marketDataProvider.isProvisional(mint), true);
    assert.equal(marketDataProvider.isAuthoritative(mint), false);

    const provPrice = marketDataProvider.getPrice(mint);
    const provLiq = marketDataProvider.getLiquidity(mint);
    assert.ok(provPrice !== null && provPrice > 0, 'Provisional price must be non-zero');
    assert.ok(provLiq !== null && provLiq > 0, 'Provisional liquidity must be non-zero');

    // 2. Zero-value overwrite protection
    const accepted = localMarketState.updateSnapshot({
      mint,
      venue: 'pumpfun',
      priceUsd: 0,
      liquidityUsd: 0,
      fdvUsd: 0,
      totalSupply: 1_000_000_000_000_000n,
      updatedAt: Date.now(),
      sourceSlot: 0,
      source: 'zero-value-test',
      status: 'authoritative',
      buyVolume1m: 0,
      sellVolume1m: 0,
      tradeCount1m: 0,
      top5ConcentrationPct: 0,
      top10ConcentrationPct: 0,
      holderCount: 0,
    });

    assert.equal(accepted, true);
    assert.equal(
      marketDataProvider.getPrice(mint),
      provPrice,
      'Zero price update must not overwrite valid price'
    );
    assert.equal(
      marketDataProvider.getLiquidity(mint),
      provLiq,
      'Zero liquidity update must not overwrite valid liquidity'
    );

    // 3. Authoritative curve update
    // Construct valid dummy 80-byte Pump.fun curve buffer
    const buf = Buffer.alloc(80);
    buf.writeBigUInt64LE(1_000_000_000n, 0); // discriminator stub
    buf.writeBigUInt64LE(1_073_000_000_000_000n, 8); // virtualTokenReserves
    buf.writeBigUInt64LE(30_000_000_000n, 16); // virtualSolReserves
    buf.writeBigUInt64LE(793_000_000_000_000n, 24); // realTokenReserves
    buf.writeBigUInt64LE(0n, 32); // realSolReserves (newly created curve)
    buf.writeBigUInt64LE(1_000_000_000_000_000n, 40); // totalSupply
    buf.writeUInt8(0, 48); // complete = false

    const authSnap = decodePumpCurveState(mint, buf, 200, 100, {
      ...localMarketState.getSnapshot(mint),
      source: 'geyser-pump-curve',
      status: 'authoritative',
    });

    assert.ok(authSnap, 'Curve decoder should parse valid buffer');
    localMarketState.updateSnapshot(authSnap!);

    assert.equal(marketDataProvider.getStateStatus(mint), 'AUTHORITATIVE');
    assert.equal(marketDataProvider.isAuthoritative(mint), true);
    assert.equal(marketDataProvider.isProvisional(mint), false);
    assert.ok(marketDataProvider.getPrice(mint)! > 0, 'Authoritative price must be non-zero');
  });

  it('evaluates newly discovered Pump.fun candidate cleanly when Jupiter is OPEN', async () => {
    localMarketState.clear();
    const mint = 'PumpJupiterOutageMint1111111111111111111';

    const ctx = createCtx(
      {
        allowVerifiedTokens: true,
        minMarketCapUsd: 1000,
      },
      createState()
    );

    // Trip Jupiter circuit breaker to OPEN state
    for (let i = 0; i < 5; i++) {
      jupiterDiscoveryBreaker.recordFailure(ctx, new Error('Jupiter 504 Gateway Timeout'));
    }
    assert.equal(
      jupiterDiscoveryBreaker.canExecute().allowed,
      false,
      'Jupiter circuit breaker should be OPEN'
    );

    // Seed local market state as happens during WS discovery
    localMarketState.seedInitialPumpFunSnapshot(mint, 200);

    const pda = await derivePumpCurvePda(mint);
    if (pda) ctx.state.curveToMint.set(pda, mint);

    const token: TokenMetadata = {
      id: mint,
      symbol: 'TEST',
      name: 'Test Token',
      decimals: 6,
      launchpad: 'pump.fun',
      usdPrice: localMarketState.getPrice(mint)!,
      liquidity: localMarketState.getLiquidity(mint)!,
      fdv: localMarketState.getFDV(mint)!,
      stats5m: { numBuys: 5, numSells: 1 },
    };

    const res = await evaluateCandidate(ctx, token);

    // Verify candidate was NOT rejected for missing-price or low-liquidity
    const missingPriceRejection = res.rejectionReasons.find((r) => r.code === 'missing-price');
    const lowLiquidityRejection = res.rejectionReasons.find((r) => r.code === 'low-liquidity');

    assert.equal(
      missingPriceRejection,
      undefined,
      'Fresh token must not be rejected for missing price when Jupiter is OPEN'
    );
    assert.equal(
      lowLiquidityRejection,
      undefined,
      'Fresh token must not be rejected for low liquidity when provisional seed exists'
    );

    jupiterDiscoveryBreaker.reset();
  });
});
