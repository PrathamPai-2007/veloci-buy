'use strict';

(global as any).__TEST__ = true;

import {
  Config,
  State,
  Context,
  Position,
  MarketSnapshot,
  RecheckItem,
  TokenMetadata,
} from '../src/types/index.js';
import { StateStore } from '../src/core/store.js';
import { _resetBucketsForTest } from '../src/core/utils/rate-limit.js';
import {
  jupiterDiscoveryBreaker,
  jupiterPositionBreaker,
} from '../src/services/jupiter-circuit-breaker.js';
import * as bot from '../src/index.js';

import { TestConfigBuilder, createTestConfig } from './factories/config.js';
import { createTestToken, createTestMarketSnapshot } from './factories/token.js';
import { createTestPosition } from './factories/position.js';

export {
  TestConfigBuilder,
  createTestConfig,
  createTestToken,
  createTestMarketSnapshot,
  createTestPosition,
};

export function createState(overrides: Partial<State> = {}): State {
  return {
    processedMintQueue: [],
    processedMints: new Set<string>(),
    pendingCandidateRechecks: new Map<string, RecheckItem>(),
    positions: new Map<string, Position>(),
    marketSnapshots: new Map<string, MarketSnapshot>(),
    curveToMint: new Map<string, string>(),
    paperSolBalanceLamports: '1000000000',
    tradeHistory: [],
    moodPauseUntil: null,
    moodPauseTradeCount: null,
    lastBuyAt: null,
    coolDownMints: new Map(),
    retiredMints: new Map(),
    closedTrades: [],
    launchHistory: [],
    sessionStartingSolBalanceLamports: null,
    peakSessionSolBalanceLamports: null,
    drawdownPauseUntil: null,
    consecutiveLosses: 0,
    recentPnlWindow: [],
    lossStreakPauseActive: false,
    mintToPool: new Map(),
    prefetchedMintSignals: new Map(),
    metrics: {
      discoveredCandidates: 0,
      passedCheapAudit: 0,
      passedSurvival: 0,
      boughtPositions: 0,
      passedAudit: 0,
      failedMomentum: 0,
      buyAttempts: 0,
      buyFailures: 0,
      buyRejectedThinLiquidity: 0,
      profitableTrades: 0,
      stopLosses: 0,
      trailingExits: 0,
      finalAuditQueued: 0,
      finalAuditPassed: 0,
      finalAuditDeferredIndexing: 0,
      finalAuditRejected: 0,
      jupiterCircuitOpens: 0,
      jupiterCircuitCloses: 0,
      jupiterCircuitProbes: 0,
      jupiterSuppressedRequests: 0,
      consecutiveJupiterFailures: 0,
      jupiterDiscoveryRequests: 0,
      jupiterDiscoveryTimeouts: 0,
      monitorTicks: 0,
      monitorTicksAborted: 0,
      monitorRpcFailures: 0,
      monitorTicksUsingCachedBalance: 0,
      securityAuditsQueued: 0,
      securityAuditsSkippedInFlight: 0,
      securityAuditsCompleted: 0,
      securityAuditsFailed: 0,
      exitReasonCounts: {},
      rejectionReasons: {},
    },
    ...overrides,
  };
}

export function createCtx(
  configOverrides: Partial<Config> = {},
  stateOverrides: Partial<State> = {}
): Context {
  // Breakers and rate buckets are process-wide; start every test context from a clean slate.
  jupiterDiscoveryBreaker.reset();
  jupiterPositionBreaker.reset();
  _resetBucketsForTest();
  const config = createTestConfig(configOverrides);
  const store = new StateStore(config);
  Object.assign(store.state, createState(stateOverrides));

  // A functional proxy for mock RPC methods that returns a .send() method
  const rpcProxy = new Proxy(
    {},
    {
      get: (_target, prop) => {
        return () => ({
          send: async () => {
            if (prop === 'getTokenAccountsByOwner') return { value: [] };
            return { value: { blockhash: '1'.repeat(32), lastValidBlockHeight: 12345 } };
          },
        });
      },
    }
  );

  return {
    config,
    state: store.state,
    store,
    rpc: rpcProxy as any,
    rpcs: [rpcProxy as any],
    rpcSubscriptions: {} as any,
    rpcSubscriptionPool: [],
    wallet: { address: '5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq' },
    logger: () => {},
    persistState: async () => {},
    calculateGMI: () => 0.5,
    rotateRpcSubscriptions: () => {},
    getCurrentRpcSubscriptions: () => ({}) as any,
  };
}

export async function withMockedFetch<T>(
  handler: (input: any, init?: any) => Promise<Response>,
  fn: () => Promise<T>
): Promise<T> {
  const originalFetch = global.fetch;
  global.fetch = handler as any;
  try {
    return await fn();
  } finally {
    global.fetch = originalFetch;
  }
}

export async function withPatchedMembers<T>(
  target: any,
  patches: Record<string, any>,
  fn: () => Promise<T>
): Promise<T> {
  const originals = new Map();
  for (const [key, value] of Object.entries(patches)) {
    originals.set(key, target[key]);
    target[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of originals) {
      target[key] = value;
    }
  }
}

export function serializeForSnapshot(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return { __bigint: value.toString() };
  if (value instanceof Map) {
    return {
      __map: Array.from(value.entries(), ([k, v]) => [
        serializeForSnapshot(k),
        serializeForSnapshot(v),
      ]),
    };
  }
  if (value instanceof Set) {
    return { __set: Array.from(value, (v) => serializeForSnapshot(v)) };
  }
  if (Array.isArray(value)) {
    return value.map((v) => serializeForSnapshot(v));
  }
  if (typeof value === 'object' && !(value instanceof Date) && !(value instanceof RegExp)) {
    const obj: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      obj[key] = serializeForSnapshot((value as Record<string, unknown>)[key]);
    }
    return obj;
  }
  return value;
}

export function createCannedToken(overrides: Partial<TokenMetadata> = {}): TokenMetadata {
  const now = Date.now();
  return {
    id: 'CannedMint123',
    symbol: 'CND',
    name: 'Canned Token',
    decimals: 9,
    usdPrice: 0.001,
    liquidity: 5_000,
    holderCount: 200,
    organicScore: 100,
    fdv: 1_000_000,
    firstPool: { createdAt: new Date(now - 60_000).toISOString() },
    launchpad: 'pump.fun',
    stats5m: { numBuys: 50, numSells: 10 },
    ...overrides,
  };
}

export function seedBotState(
  configOverrides: Partial<Config> = {},
  stateOverrides: Partial<State> = {}
) {
  const config = createTestConfig(configOverrides);
  const store = new StateStore(config);
  Object.assign(store.state, createState(stateOverrides));

  bot._setTestConfig(config);
  bot._setTestState(store.state);

  const ctx: Context = {
    config,
    state: store.state,
    store,
    rpc: {} as any,
    rpcs: [],
    rpcSubscriptions: {} as any,
    rpcSubscriptionPool: [],
    wallet: { address: '11111111111111111111111111111111' },
    logger: () => {},
    persistState: async () => {},
    calculateGMI: store.calculateGMI.bind(store),
    rotateRpcSubscriptions: () => {},
    getCurrentRpcSubscriptions: () => ({}) as any,
  };

  bot._setTestCtx(ctx);

  return {
    config,
    state: store.state,
    store,
    cleanup: () => {
      bot._setTestCtx(null);
    },
  };
}
