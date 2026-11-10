'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodePumpCreateEvent,
  decodePumpCreateEventMint,
  decodePumpTradeEvent,
} from '../src/services/discovery/providers/pump-decoder.js';
import { DiscoveryService } from '../src/services/discovery/discovery.service.js';
import {
  ingestPumpTrade,
  watchMint,
  _resetPumpTradeIngestForTest,
} from '../src/services/market-state/pump-trade-ingest.js';
import {
  MarketTapeManager,
  marketTapeManager,
} from '../src/services/market-state/market-tape-manager.js';
import { localMarketState } from '../src/services/market-state/local-market-state.js';
import { priceHistoryEngine } from '../src/services/market-state/price-history-engine.js';
import { _setSolPriceCacheForTest } from '../src/services/trading/paper-broker.js';
import { PUMP_FUN_PROGRAM_ID } from '../src/core/config.js';
import { createCtx } from './_test_helpers.js';

// Real mainnet `Program data:` lines captured from the pump.fun program log stream (2026-11).
const TRADE_LINE =
  'Program data: vdt/007mYe7oThRAk4SwNiUdnNeeRezGX4RWXH4LsBq7gh5/Cxf33Wv7ijQAAAAABlhlm6YUAAAB7/lJmf3QxUSDHc2E0VkjAhwnBAmnZE/qxJb1h3uvL+eUhPNqAAAAAEDwjVUIAAAA1ycZG+UxAwBARGpZAQAAANePBs9TMwIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABfAAAAAAAAAMrIfwAAAAAAK/dZSorTbTE9BjK+GY8szc6bsluQoSi6MC9Zk0gRGDEeAAAAAAAAAFtaKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEgAAAGJ1eV9leGFjdF9xdW90ZV9pbgAAAAAAAAAAAAAAAAAAAAAAiBMAAAAAAABl5D8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGv7ijQAAAAAQPCNVQgAAABARGpZAQAAAAAAAAAAAAAAAAAAAAAAAABbWigAAAAAAAAAAAAAAAAA';
const CREATE_LINE =
  'Program data: G3KpTd7rY3YUAAAAVEVTTEEgUk9BRFNURVIgU1RPQ0sDAAAAU09MQwAAAGh0dHBzOi8vaXBmcy5pby9pcGZzL1FtU0Q5dDRUYVRZeXlvc3pucmF0WGM4N3FvSHRqQkhrZ2ZNc1BocVFMR2JCZFlVKKIlGQBIsS7yNwjoo0ubdXAsEbU+xwKBYL/BjgPTXysI7fXUPj+7BxmyG/M3T42BAmFon2e6iKU0/C2gX9g/q+PbsE5kgTxjOpqDlToSWUJUGVD60Ts3sxxNwDOhrjCr49uwTmSBPGM6moOVOhJZQlQZUPrROzezHE3AM6GuMJWE82oAAAAAABDYR+PPAwAArCP8BgAAAAB4xftR0QIAAIDGpH6NAwAG3fbh7nWP3hhCXbzkbM3athr8TYO5DSf+vfko2KGL/AEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAArCP8BgAAAAAAAAAAAAAAAAA=';
const TRADE_MINT = 'Gdpe65jYLRPWZqmFXLoS66HU4r1J8B6GXjAhWXqtfork';

test('decodePumpTradeEvent decodes a real mainnet TradeEvent', () => {
  const t = decodePumpTradeEvent(TRADE_LINE);
  assert.ok(t);
  assert.equal(t.mint, TRADE_MINT);
  assert.equal(t.isBuy, true);
  assert.equal(t.user, 'H9kuqGKNYgPFYCA17uUTkaqXGum7MK8y1GwbS7cxsjDg');
  assert.equal(Number(t.solAmount) / 1e9, 0.881523563);
  assert.equal(Number(t.virtualSolReserves) / 1e9, 35.795103808);
  assert.equal(Number(t.realSolReserves) / 1e9, 5.795103808);
  // virtual SOL = real SOL + the 30 SOL curve offset
  assert.equal(t.virtualSolReserves - t.realSolReserves, 30_000_000_000n);
});

test('decodePumpTradeEvent rejects other events and truncated data', () => {
  assert.equal(decodePumpTradeEvent(CREATE_LINE), null);
  assert.equal(decodePumpTradeEvent('Program log: hello'), null);
  assert.equal(decodePumpTradeEvent(TRADE_LINE.slice(0, 80)), null);
});

test('decodePumpCreateEvent returns name, symbol, mint and creator', () => {
  const c = decodePumpCreateEvent(CREATE_LINE);
  assert.ok(c);
  assert.equal(c.name, 'TESLA ROADSTER STOCK');
  assert.equal(c.symbol, 'SOL');
  assert.equal(c.mint, '6jRbG2v9LYYCQibicotGxp1Ubpdn2863rN1mDXAQpump');
  assert.equal(c.creator, 'CZzEeJpTsTNWnSWaB5gY6r7fFEAyFpQVDP1aAzXdwQ4P');
  assert.equal(decodePumpCreateEventMint(CREATE_LINE), c.mint);
  assert.equal(decodePumpCreateEvent(TRADE_LINE), null);
});

test('MarketTapeManager.getTapeStats counts buys, sells and unique buyers in the window', () => {
  const tape = new MarketTapeManager();
  const now = 1_000_000;
  tape.recordTick('m', 'buy', 1, now - 400_000, 'old');
  tape.recordTick('m', 'buy', 2, now - 10_000, 'a');
  tape.recordTick('m', 'buy', 1, now - 5_000, 'a');
  tape.recordTick('m', 'buy', 0.5, now - 4_000, 'b');
  tape.recordTick('m', 'sell', 3, now - 1_000, 'a');
  const s = tape.getTapeStats('m', 300_000, now);
  assert.deepEqual(s, {
    buys: 3,
    sells: 1,
    buyVolumeSol: 3.5,
    sellVolumeSol: 3,
    uniqueBuyers: 2,
  });
  assert.equal(tape.hasTape('m'), true);
  assert.equal(tape.hasTape('none'), false);
});

test('ingestPumpTrade drops unwatched mints and records watched ones', () => {
  _resetPumpTradeIngestForTest();
  marketTapeManager.clear();
  priceHistoryEngine.clear();
  localMarketState.clear();
  _setSolPriceCacheForTest(150);
  const ctx = createCtx();
  const trade = decodePumpTradeEvent(TRADE_LINE)!;

  assert.equal(ingestPumpTrade(ctx, trade), false);
  assert.equal(marketTapeManager.hasTape(TRADE_MINT), false);

  watchMint(TRADE_MINT);
  assert.equal(ingestPumpTrade(ctx, trade), true);

  const stats = marketTapeManager.getTapeStats(TRADE_MINT);
  assert.equal(stats.buys, 1);
  assert.equal(stats.uniqueBuyers, 1);

  const snap = localMarketState.getSnapshot(TRADE_MINT);
  assert.ok(snap);
  assert.equal(snap.status, 'authoritative');
  assert.equal(snap.source, 'pump-trade-log');
  const expectedPrice = (35.795103808 / (Number(trade.virtualTokenReserves) / 1e6)) * 150;
  assert.ok(Math.abs(snap.priceUsd - expectedPrice) / expectedPrice < 1e-9);
  assert.ok(Math.abs(snap.liquidityUsd - 5.795103808 * 2 * 150) < 1e-6);
  assert.equal(priceHistoryEngine.getPriceHistory(TRADE_MINT).length, 1);
});

test('discovery handleLog ingests trades, keeps create metadata, and still finds the mint', () => {
  _resetPumpTradeIngestForTest();
  marketTapeManager.clear();
  localMarketState.clear();
  _setSolPriceCacheForTest(150);
  const service = new DiscoveryService();
  const ctx = createCtx();
  let flushed = 0;
  const created = decodePumpCreateEvent(CREATE_LINE)!;

  // A create tx whose logs also carry the dev's first buy (a trade for the same mint).
  watchMint(TRADE_MINT);
  service.handleLog(
    ctx,
    { signature: 'SigCreate', logs: ['Instruction: Create', CREATE_LINE, TRADE_LINE] },
    PUMP_FUN_PROGRAM_ID,
    0,
    () => {
      flushed++;
    }
  );

  assert.equal(flushed, 1);
  assert.equal((service as any).pendingMints.get(created.mint), PUMP_FUN_PROGRAM_ID);
  assert.equal(service.getCreateMeta(created.mint)?.symbol, 'SOL');
  assert.equal(marketTapeManager.getTapeStats(TRADE_MINT).buys, 1);
});
