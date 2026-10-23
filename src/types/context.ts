import type { Rpc, SolanaRpcApi } from '@solana/rpc';
import type { RpcSubscriptions, SolanaRpcSubscriptionsApi } from '@solana/rpc-subscriptions';
import type { KeyPairSigner } from '@solana/signers';
import type { Config, LogLevel } from './config.js';
import type { State, StateStore } from './state.js';

export interface Context {
  config: Config;
  state: State;
  rpc: Rpc<SolanaRpcApi>;
  rpcs: Rpc<SolanaRpcApi>[];
  getCurrentRpc?: () => Rpc<SolanaRpcApi>;
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  rpcSubscriptionPool: RpcSubscriptions<SolanaRpcSubscriptionsApi>[];
  wallet: { address: string; keypair?: KeyPairSigner };
  logger: (
    message: string,
    level?: LogLevel,
    options?: { console?: boolean; sync?: boolean }
  ) => void;
  persistState: (options?: { sync?: boolean; force?: boolean }) => Promise<void>;
  calculateGMI: () => number;
  rotateRpcSubscriptions: () => void;
  getCurrentRpcSubscriptions: () => RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  store: StateStore;
  tui?: {
    log: (message: string, level?: LogLevel) => void;
    refresh: (backpressureFactor?: number) => void;
  };
  getBackpressureFactor?: () => number;
  recordScanBackpressureEvent?: (error: unknown) => void;
  getSolUsdPrice?: () => Promise<number>;
  getEffectiveParallelism?: (base: number) => number;
  scanBackpressureFactor?: number;
  subscribeToVaultBalances?: (
    mint: string,
    poolAddress: string,
    type: 'raydium' | 'meteora'
  ) => Promise<void>;
  unsubscribeFromVaultBalances?: (mint: string) => void;
  subscribeToAtaBalance?: (mint: string) => Promise<void>;
  unsubscribeFromAtaBalance?: (mint: string) => void;
}

/**
 * Optional inputs for the probabilistic Jito tip on a buy. When present, the tip
 * is scaled by ML confidence and block congestion and capped at a fraction of the
 * trade's expected profit. Absent → the plain tip-floor logic is used (e.g. sells).
 */
export interface TipContext {
  /** ML confidence in [0,1]. */
  confidence: number;
  /** Expected gross profit of the trade, in lamports (caps the tip). */
  expectedValueLamports: bigint;
  /** Override panic multiplier with a graduated urgency factor (replaces binary isPanic scaling). */
  urgencyMultiplier?: number;
}
