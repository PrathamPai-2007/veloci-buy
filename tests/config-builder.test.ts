import test from 'node:test';
import assert from 'node:assert/strict';
import { NumberParser } from '#core/config-internals/env-loaders.js';
import { ConfigBuilder } from '#core/config-internals/builder.js';
import { DEFAULT_STRATEGY } from '#core/strategy-loader.js';

test('NumberParser.int returns fallback when env var is unset', () => {
  const parser = new NumberParser({});
  assert.equal(parser.int('MISSING_VAR', 42), 42);
});

test('NumberParser.int parses integer from env', () => {
  const parser = new NumberParser({ MY_INT: '100' });
  assert.equal(parser.int('MY_INT', 0), 100);
});

test('NumberParser.int throws on non-integer value', () => {
  const parser = new NumberParser({ MY_INT: '1.5' });
  assert.throws(() => parser.int('MY_INT', 0), /Invalid integer/);
});

test('NumberParser.float returns fallback when env var is unset', () => {
  const parser = new NumberParser({});
  assert.equal(parser.float('MISSING_VAR', 0.5), 0.5);
});

test('NumberParser.float parses float from env', () => {
  const parser = new NumberParser({ MY_FLOAT: '3.14' });
  assert.equal(parser.float('MY_FLOAT', 0), 3.14);
});

test('NumberParser.float throws on non-numeric value', () => {
  const parser = new NumberParser({ MY_FLOAT: 'abc' });
  assert.throws(() => parser.float('MY_FLOAT', 0), /Invalid number/);
});

test('NumberParser.boolean returns fallback when env var is unset', () => {
  const parser = new NumberParser({});
  assert.equal(parser.boolean('MISSING_VAR', true), true);
});

test('NumberParser.boolean parses truthy strings', () => {
  const parser = new NumberParser({ VAR1: 'true', VAR2: '1', VAR3: 'yes', VAR4: 'on' });
  assert.equal(parser.boolean('VAR1', false), true);
  assert.equal(parser.boolean('VAR2', false), true);
  assert.equal(parser.boolean('VAR3', false), true);
  assert.equal(parser.boolean('VAR4', false), true);
});

test('NumberParser.boolean parses falsy strings', () => {
  const parser = new NumberParser({ VAR1: 'false', VAR2: '0', VAR3: 'no', VAR4: 'off' });
  assert.equal(parser.boolean('VAR1', true), false);
  assert.equal(parser.boolean('VAR2', true), false);
  assert.equal(parser.boolean('VAR3', true), false);
  assert.equal(parser.boolean('VAR4', true), false);
});

test('NumberParser.bigint returns fallback when env var is unset', () => {
  const parser = new NumberParser({});
  assert.equal(parser.bigint('MISSING_VAR', 1000000000n), 1000000000n);
});

test('NumberParser.bigint parses decimal SOL string to lamports', () => {
  const parser = new NumberParser({ SOL_AMOUNT: '0.05' });
  assert.equal(parser.bigint('SOL_AMOUNT', 0n), 50000000n);
});

test('NumberParser.bigint throws on non-numeric value', () => {
  const parser = new NumberParser({ SOL_AMOUNT: 'abc' });
  assert.throws(() => parser.bigint('SOL_AMOUNT', 0n), /Invalid decimal/);
});

test('NumberParser.require throws on missing required var', () => {
  const parser = new NumberParser({});
  assert.throws(() => parser.require('REQUIRE_ME'), /Missing required environment variable/);
});

test('NumberParser.require returns value when set', () => {
  const parser = new NumberParser({ REQUIRE_ME: 'value' });
  assert.equal(parser.require('REQUIRE_ME'), 'value');
});

test('ConfigBuilder.withPreset sets strategy and builds config', () => {
  const env: NodeJS.ProcessEnv = {
    RPC_URL: 'http://localhost:8899',
    JUPITER_API_KEY: 'test-key',
    PRIVATE_KEY: 'test-key',
    PAPER_TRADING: 'true',
  };

  const config = new ConfigBuilder(env).withPreset(DEFAULT_STRATEGY).build();

  assert.equal(config.strategyName, 'standard');
  assert.equal(config.rpcUrl, 'http://localhost:8899');
  assert.equal(config.jupiterApiKey, 'test-key');
  assert.equal(config.paperTrading, true);
});

test('ConfigBuilder.withOverrides merges overrides on top of built config', () => {
  const env: NodeJS.ProcessEnv = {
    RPC_URL: 'http://localhost:8899',
    JUPITER_API_KEY: 'test-key',
    PRIVATE_KEY: 'test-key',
    PAPER_TRADING: 'true',
  };

  const config = new ConfigBuilder(env)
    .withPreset(DEFAULT_STRATEGY)
    .withOverrides({ maxOpenPositions: 99, customField: 'test' } as any)
    .build();

  assert.equal(config.maxOpenPositions, 99);
});

test('ConfigBuilder.validate calls validateStartupConfig and returns config on success', () => {
  const env: NodeJS.ProcessEnv = {
    RPC_URL: 'http://localhost:8899',
    JUPITER_API_KEY: 'test-key',
    PRIVATE_KEY: 'test-key',
    PAPER_TRADING: 'true',
    LIVE_TRADING_ENABLED: 'false',
    DRY_RUN: 'true',
  };

  const config = new ConfigBuilder(env).withPreset(DEFAULT_STRATEGY).validate();

  assert.equal(config.dryRun, true);
});

test('ConfigBuilder.validate throws on invalid config', () => {
  const env: NodeJS.ProcessEnv = {
    RPC_URL: 'http://localhost:8899',
    JUPITER_API_KEY: 'test-key',
    PRIVATE_KEY: 'test-key',
    PAPER_TRADING: 'false',
    DRY_RUN: 'false',
    LIVE_TRADING_ENABLED: 'false',
  };

  assert.throws(
    () => new ConfigBuilder(env).withPreset(DEFAULT_STRATEGY).validate(),
    /LIVE_TRADING_ENABLED=true/
  );
});

test('ConfigBuilder.fromEnv creates a new builder with given env', () => {
  const env: NodeJS.ProcessEnv = {
    RPC_URL: 'http://localhost:8899',
    JUPITER_API_KEY: 'test-key',
    PRIVATE_KEY: 'test-key',
    PAPER_TRADING: 'true',
    STRATEGY: 'custom-alpha',
  };

  const config = new ConfigBuilder().fromEnv(env).withStrategy('custom-alpha').build();

  assert.equal(config.strategyName, 'custom-alpha');
});
