import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getMintSignals } from '#services/audit/providers/onchain-auditor.js';
import { TokenAccountIndexService } from '#services/account-index/token-account-index.js';
import { StateStore } from '#core/state/state.store.js';

describe('Strict Mint Account Validation', () => {
  it('1. Malformed string is rejected by string validation without issuing RPC calls', async () => {
    const service = new TokenAccountIndexService();
    const store = new StateStore({} as any);
    const mockCtx: any = { store, logger: () => {} };

    await service.initializeMintSnapshot(mockCtx, 'not-a-valid-pubkey!!');
    assert.equal(store.state.metrics.invalidMintSkips, 1);
    assert.equal(store.state.metrics.getTokenLargestAccountsRequests, 0);
  });

  it('2. Valid base58 pubkey that is NOT a token mint is rejected by getMintSignals without calling getTokenLargestAccounts', async () => {
    const store = new StateStore({} as any);

    // Valid base58 address string representing a user wallet (System Account)
    const walletPubkey = '11111111111111111111111111111111';

    const mockCtx: any = {
      store,
      logger: () => {},
      config: { mintSignalMaxAttempts: 1 },
      getCurrentRpc: () => ({
        getAccountInfo: async () => ({
          value: {
            owner: '11111111111111111111111111111111', // System Program
            data: {
              parsed: {
                info: {},
                type: 'account', // NOT a 'mint'!
              },
            },
          },
        }),
        getTokenLargestAccounts: async () => {
          throw new Error('getTokenLargestAccounts SHOULD NEVER BE CALLED FOR NON-MINT ACCOUNT!');
        },
      }),
    };

    await assert.rejects(
      () => getMintSignals(mockCtx, walletPubkey),
      /RPC Indexing Lag \/ Non-Mint Account/
    );

    assert.equal(
      store.state.metrics.invalidMintSkips,
      1,
      'invalidMintSkips incremented for non-mint account'
    );
    assert.equal(
      store.state.metrics.getTokenLargestAccountsRequests,
      0,
      'getTokenLargestAccounts NOT called'
    );
  });

  it('3. Valid SPL Token mint succeeds and initializes holder snapshot', async () => {
    const store = new StateStore({} as any);
    const tokenMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    const mockCtx: any = {
      store,
      logger: () => {},
      config: { mintSignalMaxAttempts: 1 },
      getCurrentRpc: () => ({
        getAccountInfo: async () => ({
          value: {
            owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token Program
            data: {
              parsed: {
                info: {
                  decimals: 6,
                  supply: '1000000000000000',
                  mintAuthority: null,
                  freezeAuthority: null,
                },
                type: 'mint',
              },
            },
          },
        }),
        getTokenLargestAccounts: async () => ({
          value: [
            { address: '11111111111111111111111111111111', amount: '500000000000' },
            { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amount: '200000000000' },
          ],
        }),
      }),
    };

    const signals = await getMintSignals(mockCtx, tokenMint);
    assert.equal(signals.decimals, 6);
    assert.equal(store.state.metrics.getTokenLargestAccountsRequests, 1);
  });

  it('4. Token-2022 mint succeeds and initializes holder snapshot', async () => {
    const store = new StateStore({} as any);
    const token2022Mint = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

    const mockCtx: any = {
      store,
      logger: () => {},
      config: { mintSignalMaxAttempts: 1 },
      getCurrentRpc: () => ({
        getAccountInfo: async () => ({
          value: {
            owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022 Program
            data: {
              parsed: {
                info: {
                  decimals: 9,
                  supply: '1000000000000000000',
                  mintAuthority: null,
                  freezeAuthority: null,
                },
                type: 'mint',
              },
            },
          },
        }),
        getTokenLargestAccounts: async () => ({
          value: [{ address: '11111111111111111111111111111111', amount: '800000000000000' }],
        }),
      }),
    };

    const signals = await getMintSignals(mockCtx, token2022Mint);
    assert.equal(signals.decimals, 9);
    assert.equal(store.state.metrics.getTokenLargestAccountsRequests, 1);
  });
});
