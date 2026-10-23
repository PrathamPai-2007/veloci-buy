'use strict';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestConfig as baseTestConfig, serializeForSnapshot } from './_test_helpers.js';

// logFile is an absolute, machine-specific path; pin it so snapshots are portable.
const createTestConfig: typeof baseTestConfig = (overrides) => ({
  ...baseTestConfig(overrides),
  logFile: '<logFile>',
});

test('snapshots all default config fields', (t) => {
  const config = createTestConfig();
  const serialized = serializeForSnapshot(config);
  t.assert.snapshot(serialized);
});

test('config snapshot covers all expected top-level keys', (t) => {
  const config = createTestConfig();
  const keys = Object.keys(config).sort();
  t.assert.snapshot(keys);
});

test('config snapshot serializes bigint fields as string markers', () => {
  const config = createTestConfig();
  const serialized = serializeForSnapshot(config) as Record<string, unknown>;
  assert.ok(
    typeof serialized.buyAmountLamports === 'object' &&
      serialized.buyAmountLamports !== null &&
      '__bigint' in serialized.buyAmountLamports,
    'buyAmountLamports should be serialized as __bigint marker'
  );
  assert.ok(
    typeof serialized.jitoTipLamports === 'object' &&
      serialized.jitoTipLamports !== null &&
      '__bigint' in serialized.jitoTipLamports,
    'jitoTipLamports should be serialized as __bigint marker'
  );
});
