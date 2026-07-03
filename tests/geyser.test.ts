'use strict';
import assert from 'node:assert/strict';
import test from 'node:test';
import { address } from '@solana/addresses';
import bs58 from 'bs58';

import { createTestConfig, withPatchedMembers } from './_test_helpers.js';
import { VelociBuyBot } from '../src/core/bot.js';
import { RAYDIUM_AMM_V4_PROGRAM_ID } from '../src/core/constants.js';
import { StateStore } from '../src/core/store.js';
import { GeyserClient, geyserOptionsFromEnv } from '../src/services/ingestion/geyser-client.js';
import { tradingService } from '../src/services/trading/trading.service.js';

test('geyserOptionsFromEnv is enabled by default but requires an endpoint', () => {
  const prevEnabled = process.env.GEYSER_ENABLED;
  const prevTcp = process.env.GEYSER_TCP_ADDR;
  const prevSock = process.env.GEYSER_SOCKET_PATH;
  try {
    delete process.env.GEYSER_ENABLED;
    delete process.env.GEYSER_TCP_ADDR;
    delete process.env.GEYSER_SOCKET_PATH;
    assert.equal(geyserOptionsFromEnv(), null, 'enabled by default but no endpoint -> null');

    process.env.GEYSER_ENABLED = 'false';
    process.env.GEYSER_TCP_ADDR = '127.0.0.1:9123';
    assert.equal(geyserOptionsFromEnv(), null, 'explicitly disabled -> null');

    process.env.GEYSER_ENABLED = 'true';
    delete process.env.GEYSER_TCP_ADDR;
    assert.equal(geyserOptionsFromEnv(), null, 'enabled but no endpoint → null');

    process.env.GEYSER_TCP_ADDR = '127.0.0.1:9123';
    const opts = geyserOptionsFromEnv();
    assert.ok(opts);
    assert.equal(opts!.tcpAddr, '127.0.0.1:9123');
  } finally {
    if (prevEnabled === undefined) delete process.env.GEYSER_ENABLED;
    else process.env.GEYSER_ENABLED = prevEnabled;
    if (prevTcp === undefined) delete process.env.GEYSER_TCP_ADDR;
    else process.env.GEYSER_TCP_ADDR = prevTcp;
    if (prevSock === undefined) delete process.env.GEYSER_SOCKET_PATH;
    else process.env.GEYSER_SOCKET_PATH = prevSock;
  }
});

test('VelociBuyBot startGeyserIfEnabled processes Raydium AMM V4 updates correctly', async () => {
  const config = createTestConfig({
    rpcUrls: ['http://localhost:8899'],
    wsRpcUrls: ['ws://localhost:8900'],
  });
  const walletSigner = { address: '5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq' } as any;
  const store = new StateStore(config);
  const bot = new VelociBuyBot(config, walletSigner, store);

  const prevEnabled = process.env.GEYSER_ENABLED;
  const prevTcp = process.env.GEYSER_TCP_ADDR;
  process.env.GEYSER_ENABLED = 'true';
  process.env.GEYSER_TCP_ADDR = '127.0.0.1:9000';

  const originalStart = GeyserClient.prototype.start;
  GeyserClient.prototype.start = () => {};

  try {
    (bot as any).startGeyserIfEnabled();
    const geyserClient = (bot as any).geyserClient;
    assert.ok(geyserClient);

    const onUpdate = (geyserClient as any).opts.onUpdate;
    assert.ok(onUpdate);

    const mockBaseVault = Buffer.alloc(32, 1);
    const mockQuoteVault = Buffer.alloc(32, 2);
    const mockBaseMint = Buffer.alloc(32, 3);
    const mockQuoteMint = Buffer.alloc(32, 4);
    void mockQuoteMint; // Ignore unused

    const baseAccountBuffer = Buffer.alloc(72);
    baseAccountBuffer.writeBigUInt64LE(1_000_000_000n, 64);

    const quoteAccountBuffer = Buffer.alloc(72);
    quoteAccountBuffer.writeBigUInt64LE(2_000_000_000n, 64);

    let rpcCalled = false;
    const mockRpc = {
      getMultipleAccounts: (addresses: any, options: any) => {
        rpcCalled = true;
        assert.deepEqual(addresses, [
          address(bs58.encode(new Uint8Array(mockBaseVault))),
          address(bs58.encode(new Uint8Array(mockQuoteVault))),
        ]);
        assert.equal(options.encoding, 'base64');
        assert.equal(options.commitment, 'confirmed');
        return {
          send: async () => {
            return {
              value: [
                {
                  data: [baseAccountBuffer.toString('base64'), 'base64'],
                },
                {
                  data: [quoteAccountBuffer.toString('base64'), 'base64'],
                },
              ],
            };
          },
        };
      },
    } as any;

    bot.rpc = mockRpc;
    bot.rpcs = [mockRpc];

    const poolBuffer = Buffer.alloc(752);
    poolBuffer.writeBigUInt64LE(9n, 32);
    poolBuffer.writeBigUInt64LE(9n, 40);
    mockBaseVault.copy(poolBuffer, 336);
    mockQuoteVault.copy(poolBuffer, 368);
    mockBaseMint.copy(poolBuffer, 400);
    const solMintBuffer = bs58.decode('So11111111111111111111111111111111111111112');
    Buffer.from(solMintBuffer).copy(poolBuffer, 432);

    await withPatchedMembers(
      tradingService,
      {
        estimateSolUsdPrice: async () => 150,
      },
      async () => {
        onUpdate({
          pubkey: 'MockRaydiumPoolStatePubkey',
          owner: RAYDIUM_AMM_V4_PROGRAM_ID,
          lamports: 1000,
          slot: 1000,
          writeVersion: 1,
          data: poolBuffer,
        });

        for (let i = 0; i < 20; i++) {
          if (
            rpcCalled &&
            store.state.marketSnapshots.has(address(bs58.encode(new Uint8Array(mockBaseMint))))
          ) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        assert.ok(rpcCalled);
        const tokenMint = address(bs58.encode(new Uint8Array(mockBaseMint)));
        const snapshot = store.state.marketSnapshots.get(tokenMint);
        assert.ok(snapshot);
        assert.equal(snapshot.launchpad, 'raydium');
        assert.equal(snapshot.usdPrice, 300);
        assert.equal(snapshot.liquidity, 600);
      }
    );
  } finally {
    GeyserClient.prototype.start = originalStart;
    if (prevEnabled === undefined) delete process.env.GEYSER_ENABLED;
    else process.env.GEYSER_ENABLED = prevEnabled;
    if (prevTcp === undefined) delete process.env.GEYSER_TCP_ADDR;
    else process.env.GEYSER_TCP_ADDR = prevTcp;

    bot.stop();
    await (bot as any).performShutdown();
  }
});
