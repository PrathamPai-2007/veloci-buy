import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TopHolderTracker, TokenAccountIndexService } from '#services/account-index/index.js';

describe('Local Token Account Index', () => {
  it('TopHolderTracker maintains top holders and computes concentration', () => {
    const tracker = new TopHolderTracker();
    const supply = 1000n;

    tracker.update('acc1', 'owner1', 300n);
    tracker.update('acc2', 'owner2', 200n);
    tracker.update('acc3', 'owner3', 100n);
    tracker.update('acc4', 'owner4', 50n);

    assert.equal(tracker.holderCount, 4);

    const topHolders = tracker.getTopHolders(2);
    assert.equal(topHolders.length, 2);
    assert.equal(topHolders[0]!.owner, 'owner1');
    assert.equal(topHolders[0]!.amount, 300n);
    assert.equal(topHolders[1]!.owner, 'owner2');
    assert.equal(topHolders[1]!.amount, 200n);

    const concPct = tracker.getConcentrationPct(supply, 2);
    assert.equal(concPct, 50.0); // (300 + 200) / 1000 = 50%
  });

  it('TokenAccountIndexService tracks deltas and emits holderDrift events', () => {
    const index = new TokenAccountIndexService();
    const mint = 'tokenMint1';

    // Initial setup with top 5 holders
    index.updateBalance(mint, 'acc1', 'owner1', 500n);
    index.updateBalance(mint, 'acc2', 'owner2', 300n);

    const conc = index.getConcentration(mint);
    assert.ok(conc !== null);
    assert.ok(conc.totalTrackedHolders >= 2);

    let driftEmitted = false;
    index.on('holderDrift', (evt) => {
      driftEmitted = true;
      assert.equal(evt.mint, mint);
      assert.equal(evt.owner, 'owner1');
      assert.equal(evt.action, 'dumping');
      assert.equal(evt.previousAmount, 500n);
      assert.equal(evt.currentAmount, 200n);
    });

    // Top holder dumps balance from 500 down to 200
    const driftEvt = index.updateBalance(mint, 'acc1', 'owner1', 200n);
    assert.ok(driftEvt !== null);
    assert.equal(driftEmitted, true);
  });
});
