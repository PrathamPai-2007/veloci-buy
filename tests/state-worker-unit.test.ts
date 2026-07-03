'use strict';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestConfig } from './_test_helpers.js';
import { StatePersistence } from '../src/core/state/state.persistence.js';

function makeTempStateFile(): { stateFile: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veloci-buy-sw-test-'));
  const stateFile = path.join(dir, 'state.json');
  return {
    stateFile,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

async function withPersistence(
  configOverrides: Record<string, unknown>,
  fn: (p: StatePersistence, stateFile: string) => Promise<void>
): Promise<void> {
  const { stateFile, cleanup } = makeTempStateFile();
  const config = createTestConfig(configOverrides as any);
  const persistence = new StatePersistence(config);
  try {
    await persistence.init(stateFile);
    await fn(persistence, stateFile);
  } finally {
    await persistence.requestShutdown().catch(() => {});
    cleanup();
  }
}

// ── Write → Flush → Read roundtrip ────────────────────────────────────────────

test('StatePersistence: write followed by flush makes value readable', async () => {
  await withPersistence({ stateFlushIntervalMs: 50 }, async (p) => {
    p.runUpsertKV('test_key', 'test_value');
    await p.flush();
    assert.equal(p.getKV('test_key'), 'test_value');
  });
});

test('StatePersistence: multiple writes all committed before flush resolves', async () => {
  await withPersistence({ stateFlushIntervalMs: 50 }, async (p) => {
    p.runUpsertKV('k1', 'v1');
    p.runUpsertKV('k2', 'v2');
    p.runUpsertKV('k3', 'v3');
    await p.flush();
    assert.equal(p.getKV('k1'), 'v1');
    assert.equal(p.getKV('k2'), 'v2');
    assert.equal(p.getKV('k3'), 'v3');
  });
});

test('StatePersistence: flush on empty queue resolves without hanging', async () => {
  await withPersistence({ stateFlushIntervalMs: 50 }, async (p) => {
    // No writes — should resolve immediately rather than hanging
    await p.flush();
  });
});

// ── Concurrent flush ───────────────────────────────────────────────────────────

test('StatePersistence: concurrent flush() calls both resolve after writes committed', async () => {
  await withPersistence({ stateFlushIntervalMs: 200 }, async (p) => {
    p.runUpsertKV('concurrent_key', 'concurrent_value');
    // Two concurrent flush calls should both resolve; second piggybacks on the first ACK
    await Promise.all([p.flush(), p.flush()]);
    assert.equal(p.getKV('concurrent_key'), 'concurrent_value');
  });
});

test('StatePersistence: write enqueued after flush starts is committed before second flush resolves', async () => {
  await withPersistence({ stateFlushIntervalMs: 1000 }, async (p) => {
    p.runUpsertKV('first_key', 'first');
    const firstFlush = p.flush();
    // Enqueue a second write while the first flush may still be in progress
    p.runUpsertKV('second_key', 'second');
    await firstFlush;
    // At this point 'first' must be committed; 'second' may or may not be yet
    assert.equal(p.getKV('first_key'), 'first');

    // After a second flush, 'second' must be committed too
    await p.flush();
    assert.equal(p.getKV('second_key'), 'second');
  });
});

// ── KV overwrite / upsert ─────────────────────────────────────────────────────

test('StatePersistence: upsertKV overwrites existing key', async () => {
  await withPersistence({ stateFlushIntervalMs: 50 }, async (p) => {
    p.runUpsertKV('mykey', 'original');
    await p.flush();
    assert.equal(p.getKV('mykey'), 'original');

    p.runUpsertKV('mykey', 'updated');
    await p.flush();
    assert.equal(p.getKV('mykey'), 'updated');
  });
});

// ── Shutdown safety ────────────────────────────────────────────────────────────

test('StatePersistence: flush after shutdown is a no-op (does not reject)', async () => {
  const { stateFile, cleanup } = makeTempStateFile();
  const config = createTestConfig({ stateFlushIntervalMs: 50 } as any);
  const persistence = new StatePersistence(config);
  await persistence.init(stateFile);
  await persistence.requestShutdown();
  // Flush after shutdown should be a silent no-op
  await persistence.flush();
  cleanup();
});

// ── No-op when stateFile is empty ─────────────────────────────────────────────

test('StatePersistence: init with empty stateFile is a no-op (no worker spawned)', async () => {
  const config = createTestConfig({} as any);
  const persistence = new StatePersistence(config);
  await persistence.init(''); // no file → no worker
  // All operations are safe to call on an un-initialised persistence instance
  persistence.runUpsertKV('key', 'val'); // should be silently dropped
  await persistence.flush(); // should resolve immediately
  assert.equal(persistence.getKV('key'), null);
});
