import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LocalMarketStateStore,
  PriceHistoryEngine,
  LiquidityEngine,
  MarketTapeManager,
  UnifiedMarketDataProvider,
  decodePumpCurveState,
} from '#services/market-state/index.js';

describe('Local Market State Engine', () => {
  it('LocalMarketStateStore updates snapshots and emits price/liquidity events', () => {
    const store = new LocalMarketStateStore();
    const pricesEmitted: number[] = [];
    let liqEmitted = false;
    store.on('priceUpdated', (snap) => {
      pricesEmitted.push(snap.priceUsd);
    });

    store.on('liquidityChanged', (mint, oldLiq, newLiq) => {
      liqEmitted = true;
      assert.equal(mint, 'mint123');
      assert.equal(oldLiq, 10000);
      assert.equal(newLiq, 8000);
    });

    store.updateSnapshot({
      mint: 'mint123',
      venue: 'pumpfun',
      priceUsd: 0.00005,
      liquidityUsd: 10000,
      fdvUsd: 50000,
      totalSupply: 1_000_000_000_000_000n,
      updatedAt: Date.now(),
      sourceSlot: 100,
      buyVolume1m: 0,
      sellVolume1m: 0,
      tradeCount1m: 0,
      top5ConcentrationPct: 15,
      top10ConcentrationPct: 25,
      holderCount: 150,
    });

    assert.equal(pricesEmitted.length, 1);
    assert.equal(pricesEmitted[0], 0.00005);
    assert.equal(store.getPrice('mint123'), 0.00005);
    assert.equal(store.getLiquidity('mint123'), 10000);

    store.updateSnapshot({
      mint: 'mint123',
      venue: 'pumpfun',
      priceUsd: 0.00006,
      liquidityUsd: 8000,
      fdvUsd: 60000,
      totalSupply: 1_000_000_000_000_000n,
      updatedAt: Date.now(),
      sourceSlot: 101,
      buyVolume1m: 0,
      sellVolume1m: 0,
      tradeCount1m: 0,
      top5ConcentrationPct: 15,
      top10ConcentrationPct: 25,
      holderCount: 150,
    });

    assert.equal(liqEmitted, true);
    assert.equal(store.getPrice('mint123'), 0.00006);
    assert.equal(store.getLiquidity('mint123'), 8000);
  });

  it('PriceHistoryEngine calculates momentum, velocity, and volatility', () => {
    const engine = new PriceHistoryEngine();
    const now = Date.now();

    engine.pushPrice('mintA', 1, 100, now - 60_000);
    engine.pushPrice('mintA', 2, 110, now - 30_000);
    engine.pushPrice('mintA', 3, 120, now);

    const momentum = engine.getMomentum('mintA', 60_000);
    assert.equal(momentum, 0.2); // (120 - 100) / 100 = 0.2 (+20%)

    const velocity = engine.getVelocity('mintA', 30_000);
    assert.ok(velocity > 0);

    const history = engine.getPriceHistory('mintA');
    assert.equal(history.length, 3);
  });

  it('LiquidityEngine detects liquidity collapse >30%', () => {
    const engine = new LiquidityEngine();
    const now = Date.now();

    const collapse1 = engine.pushLiquidity('mintB', 10000, now - 10000);
    assert.equal(collapse1, null);

    const collapse2 = engine.pushLiquidity('mintB', 6000, now); // 40% drop
    assert.ok(collapse2 !== null);
    assert.equal(collapse2?.dropPercentage, 40);
    assert.equal(collapse2?.previousUsd, 10000);
    assert.equal(collapse2?.currentUsd, 6000);
  });

  it('MarketTapeManager records ticks and returns swap volume', () => {
    const tape = new MarketTapeManager();
    const now = Date.now();

    tape.recordTick('mintC', 'buy', 2.5, now - 1000);
    tape.recordTick('mintC', 'buy', 1.5, now - 500);
    tape.recordTick('mintC', 'sell', 1.0, now - 100);

    const vol = tape.getSwapVolume('mintC', 60_000);
    assert.equal(vol.buyVolumeSol, 4.0);
    assert.equal(vol.sellVolumeSol, 1.0);
    assert.equal(vol.tradeCount, 3);
  });

  it('UnifiedMarketDataProvider integrates state, history, and tape', () => {
    const store = new LocalMarketStateStore();
    const history = new PriceHistoryEngine();
    const liq = new LiquidityEngine();
    const tape = new MarketTapeManager();
    const provider = new UnifiedMarketDataProvider(store, history, liq, undefined, tape);

    store.updateSnapshot({
      mint: 'mintD',
      venue: 'raydium',
      priceUsd: 1.25,
      liquidityUsd: 50000,
      fdvUsd: 1250000,
      totalSupply: 1_000_000n,
      updatedAt: Date.now(),
      sourceSlot: 500,
      buyVolume1m: 0,
      sellVolume1m: 0,
      tradeCount1m: 0,
      top5ConcentrationPct: 20,
      top10ConcentrationPct: 30,
      holderCount: 500,
    });

    assert.equal(provider.getPrice('mintD'), 1.25);
    assert.equal(provider.getLiquidity('mintD'), 50000);
    assert.equal(provider.getFDV('mintD'), 1250000);
  });

  it('decodePumpCurveState computes valid price and liquidity', () => {
    const buf = Buffer.alloc(81);
    buf.writeBigUInt64LE(1_000_000_000_000n, 8); // virtualTokenReserves
    buf.writeBigUInt64LE(30_000_000_000n, 16); // virtualSolReserves
    buf.writeBigUInt64LE(793_100_000_000n, 24); // realTokenReserves
    buf.writeBigUInt64LE(5_000_000_000n, 32); // realSolReserves
    buf.writeBigUInt64LE(1_000_000_000_000_000n, 40); // totalSupply

    const snap = decodePumpCurveState('pumpMint1', buf, 150.0);
    assert.ok(snap !== null);
    assert.equal(snap?.venue, 'pumpfun');
    assert.ok(Math.abs(snap!.priceUsd - 0.0045) < 0.00001); // (30 / 1000000) * 150 = 0.0045
    assert.equal(snap?.liquidityUsd, 1500); // 5 * 2 * 150 = 1500
  });
});
