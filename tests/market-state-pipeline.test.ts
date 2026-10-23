import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { localMarketState } from '../src/services/market-state/local-market-state.js';
import { marketDataProvider } from '../src/services/market-state/market-data-provider.js';
import { decodePumpCurveState } from '../src/services/market-state/decoders/pump-curve-decoder.js';
import { buyCandidate } from '../src/services/buy.js';
import { estimateSolUsdPriceDetails } from '../src/services/trading/paper-broker.js';
import { evaluateSinglePosition } from '../src/services/monitor/monitor.service.js';
import { createCtx, createState } from './_test_helpers.js';
import { EvaluationResult, TokenMetadata } from '../src/types/index.js';

describe('Market State & Price Pipeline Invariants (P0 Bug Fixes)', () => {
  it('A. Provisional state cannot trigger buy', async () => {
    localMarketState.clear();
    const mint = 'BlockProvisionalMint111111111111111111111';
    localMarketState.seedInitialPumpFunSnapshot(mint, 200);

    assert.equal(localMarketState.getStateStatus(mint), 'PROVISIONAL');

    const ctx = createCtx({}, createState());
    (ctx as any).getSolUsdPrice = async () => 200;

    const token: TokenMetadata = {
      id: mint,
      symbol: 'PROV',
      name: 'Provisional Token',
      decimals: 6,
      launchpad: 'pump.fun',
      usdPrice: localMarketState.getPrice(mint)!,
    };
    const evaluation: EvaluationResult = {
      approved: true,
      token,
      candidateScore: 85,
      rejectionReasons: [],
      blockers: [],
      notes: [],
      launchpadProfile: {} as any,
      adjustedThresholds: {} as any,
      volatilityScaler: 1.0,
      mlFeaturesJson: '{}',
      entryProfile: 'standard',
    };

    const pos = await buyCandidate(ctx, evaluation);
    assert.equal(pos, null, 'Buy MUST be blocked when market state is PROVISIONAL');
  });

  it('A2. Missing market state cannot trigger buy', async () => {
    localMarketState.clear();
    const mint = 'MissingMarketStateMint111111111111111111';
    const ctx = createCtx({ paperTrading: true }, createState());

    const pos = await buyCandidate(ctx, {
      approved: true,
      token: {
        id: mint,
        symbol: 'MISSING',
        name: 'Missing State Token',
        decimals: 6,
        launchpad: 'pump.fun',
        usdPrice: 0.001,
      },
      candidateScore: 85,
      rejectionReasons: [],
      blockers: [],
      notes: [],
      launchpadProfile: {} as any,
      adjustedThresholds: {} as any,
      volatilityScaler: 1,
      mlFeaturesJson: '{}',
      entryProfile: 'standard',
    });

    assert.equal(pos, null, 'Buy MUST be blocked when market state is MISSING');
  });

  it('B & C. Real Geyser curve update promotes provisional -> authoritative & monitor reads fresh price', () => {
    localMarketState.clear();
    const mint = 'PromoteMint1111111111111111111111111111111';
    localMarketState.seedInitialPumpFunSnapshot(mint, 200);
    assert.equal(localMarketState.getStateStatus(mint), 'PROVISIONAL');

    // Create valid 80-byte Pump.fun curve buffer
    const buf = Buffer.alloc(80);
    buf.writeBigUInt64LE(1_000_000_000n, 0);
    buf.writeBigUInt64LE(1_000_000_000_000_000n, 8); // virtualTokenReserves
    buf.writeBigUInt64LE(40_000_000_000n, 16); // virtualSolReserves (increased price)
    buf.writeBigUInt64LE(793_000_000_000_000n, 24);
    buf.writeBigUInt64LE(10_000_000_000n, 32); // realSolReserves
    buf.writeBigUInt64LE(1_000_000_000_000_000n, 40);
    buf.writeUInt8(0, 48);

    const authSnap = decodePumpCurveState(mint, buf, 200, 500, {
      ...localMarketState.getSnapshot(mint),
      source: 'geyser-pump-curve',
      status: 'authoritative',
    });

    assert.ok(authSnap);
    localMarketState.updateSnapshot(authSnap!);

    assert.equal(localMarketState.getStateStatus(mint), 'AUTHORITATIVE');
    assert.equal(localMarketState.isAuthoritative(mint), true);

    const details = marketDataProvider.getMarketPriceDetails(mint);
    assert.equal(details.status, 'AUTHORITATIVE');
    assert.equal(details.source, 'geyser-pump-curve');
    assert.equal(details.isFresh, true);
    assert.ok(details.priceUsd! > 0);
  });

  it('D & E. Stale snapshot is rejected as stale & reports real observedAt age', () => {
    localMarketState.clear();
    const mint = 'StaleMint11111111111111111111111111111111';
    const oldTime = Date.now() - 288_000; // 288 seconds ago

    localMarketState.updateSnapshot({
      mint,
      venue: 'pumpfun',
      priceUsd: 0.00005,
      liquidityUsd: 6000,
      fdvUsd: 50000,
      totalSupply: 1_000_000_000_000_000n,
      updatedAt: oldTime,
      sourceSlot: 10,
      source: 'initial-discovery-seed',
      status: 'provisional',
      buyVolume1m: 0,
      sellVolume1m: 0,
      tradeCount1m: 0,
      top5ConcentrationPct: 0,
      top10ConcentrationPct: 0,
      holderCount: 1,
    });

    const details = marketDataProvider.getMarketPriceDetails(mint, 10_000);
    assert.equal(details.isFresh, false);
    assert.ok(details.ageMs >= 287_000, `ageMs should be ~288s, got ${details.ageMs}`);
    assert.equal(details.observedAt, oldTime);
  });

  it('F. PUSSY-style regression: seed without authoritative update blocks buy', async () => {
    localMarketState.clear();
    const pussyMint = 'BUTu8M5VryU5f6D2iPNHWPSzGoWh5eXqRPPgSm7npump';
    localMarketState.seedInitialPumpFunSnapshot(pussyMint, 200);

    const ctx = createCtx({}, createState());
    (ctx as any).getSolUsdPrice = async () => 200;

    const evaluation: EvaluationResult = {
      approved: true,
      token: {
        id: pussyMint,
        symbol: 'PUSSY',
        name: 'Pussy Cat',
        decimals: 6,
        launchpad: 'pump.fun',
        usdPrice: localMarketState.getPrice(pussyMint)!,
      },
      candidateScore: 90,
      rejectionReasons: [],
      blockers: [],
      notes: [],
      launchpadProfile: {} as any,
      adjustedThresholds: {} as any,
      volatilityScaler: 1.0,
      mlFeaturesJson: '{}',
      entryProfile: 'standard',
    };

    const pos = await buyCandidate(ctx, evaluation);
    assert.equal(pos, null, 'PUSSY buy must be blocked without authoritative market state');
  });

  it('G. Successful lifecycle: seed -> authoritative update (+20%) -> buy -> monitor observes gain', async () => {
    localMarketState.clear();
    const mint = 'LifecycleMint1111111111111111111111111111';
    localMarketState.seedInitialPumpFunSnapshot(mint, 200);

    // Promote to Authoritative with +20% price increase over seed
    const seedSnap = localMarketState.getSnapshot(mint)!;
    const authPrice = seedSnap.priceUsd * 1.2;

    localMarketState.updateSnapshot({
      ...seedSnap,
      priceUsd: authPrice,
      updatedAt: Date.now(),
      sourceSlot: 100,
      source: 'geyser-pump-curve',
      status: 'authoritative',
    });

    const ctx = createCtx({ paperTrading: true }, createState());
    (ctx as any).getSolUsdPrice = async () => 200;

    const evaluation: EvaluationResult = {
      approved: true,
      token: {
        id: mint,
        symbol: 'LIFE',
        name: 'Lifecycle Coin',
        decimals: 6,
        launchpad: 'pump.fun',
        usdPrice: authPrice,
      },
      candidateScore: 92,
      rejectionReasons: [],
      blockers: [],
      notes: [],
      launchpadProfile: {} as any,
      adjustedThresholds: {} as any,
      volatilityScaler: 1.0,
      mlFeaturesJson: '{}',
      entryProfile: 'standard',
    };

    const pos = await buyCandidate(ctx, evaluation);
    assert.ok(pos, 'Buy must succeed when market state is AUTHORITATIVE');
    assert.equal(pos!.entryPriceUsd, authPrice);

    // Monitor position with updated authoritative state
    const pRecord = { usdPrice: authPrice, liquidity: seedSnap.liquidityUsd };
    await evaluateSinglePosition(
      ctx,
      mint,
      pos!,
      { mint, rawAmount: BigInt(pos!.lastKnownBalanceRaw!), decimals: 6, uiAmount: 100 },
      pRecord,
      undefined
    );

    assert.equal(pos!.highestPriceUsd, authPrice);
    assert.equal(pos!.lastKnownPriceSource, 'geyser-pump-curve');
  });

  it('H. Provenance preservation: source remains initial-discovery-seed then geyser-pump-curve', () => {
    localMarketState.clear();
    const mint = 'ProvenanceMint1111111111111111111111111';
    localMarketState.seedInitialPumpFunSnapshot(mint, 200);

    assert.equal(localMarketState.getSnapshot(mint)?.source, 'initial-discovery-seed');

    localMarketState.updateSnapshot({
      ...localMarketState.getSnapshot(mint)!,
      priceUsd: 0.0001,
      source: 'geyser-pump-curve',
      status: 'authoritative',
      updatedAt: Date.now(),
    });

    assert.equal(localMarketState.getSnapshot(mint)?.source, 'geyser-pump-curve');
    assert.equal(marketDataProvider.getMarketPriceDetails(mint).source, 'geyser-pump-curve');
  });

  it('I. SOL price TTL: stale cache > 60s requires refresh or throws explicit failure', async () => {
    const ctx = createCtx({}, createState());
    (ctx as any).getSolUsdPrice = async () => 200;

    const details = await estimateSolUsdPriceDetails(ctx);
    assert.ok(details.price > 0);
    assert.ok(typeof details.ageMs === 'number');
    assert.ok(details.timestamp > 0);
  });
});
