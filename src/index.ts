import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

import { createKeyPairSignerFromBytes, KeyPairSigner } from '@solana/signers';

import { log, setConsoleSuppressed } from './core/utils.js';

import { loadConfig, validateStartupConfig } from './core/config.js';
import { StateStore } from './core/store.js';
import { VelociBuyBot } from './core/bot.js';
import { promptPassword, decodePrivateKeyBytes } from './core/utils/crypto.js';
export { VelociBuyBot, decodePrivateKeyBytes };
export const shutdownController = new AbortController();

import * as keystore from './core/keystore.js';

import { TuiService } from './services/tui.service.js';
import { ApiService } from './services/api.service.js';
import { Config, State, Context } from './types/index.js';

// Enforce default max listeners for event-heavy environments
EventEmitter.defaultMaxListeners = 100;

/**
 * VelociBuyBot is the core orchestrator for the trading system.
 * It manages service loops, RPC connection pools, state persistence,
 * and graceful shutdown procedures.
 */

let activeBot: VelociBuyBot | null = null;
let apiService: ApiService | null = null;
let globalShutdownInProgress = false;

/**
 * Handles OS termination signals for graceful shutdown.
 * @param sig - The OS signal name.
 */
const handleShutdown = async (sig: string): Promise<void> => {
  if (globalShutdownInProgress) return;
  globalShutdownInProgress = true;

  const msg = `Signal ${sig} received. Terminating firmly.`;
  if (activeBot) {
    activeBot.getCtx().logger(msg, 'warn', { console: true, sync: true });
  } else {
    log('./bot-error.log', msg, 'warn', { console: true, sync: true });
  }

  // Hard exit watchdog
  setTimeout(() => {
    const timeoutMsg = 'Shutdown timed out after 20s. Force exiting.';
    if (activeBot) {
      activeBot.getCtx().logger(timeoutMsg, 'error', { console: true, sync: true });
    } else {
      log('./bot-error.log', timeoutMsg, 'error', { console: true, sync: true });
    }
    process.exit(1);
  }, 20000).unref();

  if (apiService) {
    apiService.stop();
  }

  if (activeBot) {
    activeBot.stop();
  } else {
    process.exit(0);
  }

  shutdownController.abort();
};

process.on('SIGINT', () => void handleShutdown('SIGINT'));
process.on('SIGTERM', () => void handleShutdown('SIGTERM'));

/**
 * Handles an otherwise-fatal top-level error. Logs it through the active bot
 * logger (or a fallback file when no bot is running), then routes into the same
 * graceful shutdown path used for OS signals so the hard-exit watchdog and
 * shutdown abort still fire — preventing a crashed process from leaving live
 * positions unmonitored.
 * @param kind - The originating handler name.
 * @param err - The error or rejection reason.
 */
const handleFatalError = (kind: string, err: unknown): void => {
  // A broken stdout/stderr pipe (terminal closed, output piped to a reader that
  // exited) is not fatal: file logging is unaffected and the bot can keep
  // managing open positions headless. Swallow it rather than tearing down.
  if ((err as { code?: string } | undefined)?.code === 'EPIPE') {
    return;
  }
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  const msg = `Fatal ${kind}: ${detail}`;
  if (activeBot) {
    activeBot.getCtx().logger(msg, 'error', { console: true, sync: true });
  } else {
    log('./bot-error.log', msg, 'error', { console: true, sync: true });
  }
  void handleShutdown(kind);
};

process.on('unhandledRejection', (reason) => handleFatalError('unhandledRejection', reason));
process.on('uncaughtException', (err) => handleFatalError('uncaughtException', err));

/**
 * Application entry point. Loads config, initializes store, and boots the bot.
 */
export async function main(): Promise<void> {
  try {
    const args = process.argv.slice(2);

    // Support legacy strategy overrides
    const strategyIdx = args.findIndex((arg) => arg === '--strategy' || arg === '-s');
    if (strategyIdx !== -1 && args[strategyIdx + 1]) {
      process.env.STRATEGY = args[strategyIdx + 1];
    }

    const tuiEnabled = args.includes('--tui');

    const config = loadConfig();
    validateStartupConfig(config);

    const store = new StateStore(config);
    await store.load(config.stateFile);

    let pkRaw = '';
    if (config.keystorePath) {
      if (!fs.existsSync(config.keystorePath)) {
        throw new Error(`Keystore file not found: ${config.keystorePath}`);
      }
      const password =
        config.keystorePassword || (await promptPassword('Enter keystore password: '));
      const data = JSON.parse(
        fs.readFileSync(config.keystorePath, 'utf8')
      ) as keystore.KeystoreData;
      try {
        pkRaw = await keystore.decrypt(data, password);
      } catch (err) {
        throw new Error('Failed to decrypt keystore. Incorrect password?', { cause: err });
      }
    } else {
      pkRaw =
        config.privateKey ||
        (config.privateKeyPath ? fs.readFileSync(config.privateKeyPath, 'utf8') : '');
    }

    let signer: KeyPairSigner;
    try {
      signer = await createKeyPairSignerFromBytes(decodePrivateKeyBytes(pkRaw));
    } catch (err) {
      throw new Error(
        'Failed to create wallet signer from private key. Ensure the key is a valid 64-byte Solana keypair.',
        { cause: err }
      );
    }

    // Redact sensitive material immediately after loading into memory
    pkRaw = '';
    config.privateKey = '[REDACTED]';
    config.privateKeyPath = '[REDACTED]';
    config.keystorePassword = '[REDACTED]';

    activeBot = new VelociBuyBot(config, signer, store);

    if (tuiEnabled) {
      setConsoleSuppressed(true);
      const tui = new TuiService(activeBot.getCtx());
      tui.enable();
      activeBot.tui = tui;
    }

    apiService = new ApiService(activeBot.getCtx());
    apiService.start(config.apiPort);

    const runMode = config.paperTrading ? 'PAPER' : config.dryRun ? 'DRY-RUN' : 'LIVE';
    activeBot
      .getCtx()
      .logger(
        `VelociBuyBot ${runMode} started. Strategy: ${config.strategyName}. Wallet: ...${signer.address.slice(-5)}.`,
        'info',
        { console: true }
      );

    await activeBot.start();

    log(config.logFile, 'Main loop terminated. Exiting.', 'info', { console: true });
    process.exit(0);
  } catch (err) {
    setConsoleSuppressed(false);
    const errorMsg = err instanceof Error ? err.stack || err.message : String(err);
    log(
      activeBot?.config?.logFile || './bot-error.log',
      `Fatal startup error: ${errorMsg}`,
      'error',
      { console: true }
    );
    process.exit(1);
  }
}

/**
 * Internal helper for testing to inject a mock configuration.
 * @deprecated Use VelociBuyBot instance directly.
 */
export function _setTestConfig(mockConfig: Config): void {
  if (activeBot) activeBot.config = mockConfig;
}

/**
 * Internal helper for testing to inject a mock state.
 * @deprecated Use VelociBuyBot instance directly.
 */
export function _setTestState(mockState: State): void {
  if (activeBot) activeBot.state = mockState;
}

let testCtx: Context | null = null;
/**
 * Internal helper for testing to inject a mock context.
 */
export function _setTestCtx(ctx: Context | null): void {
  testCtx = ctx;
}

/**
 * Legacy accessor for application context.
 * @deprecated Use activeBot.getCtx() if available.
 */
export function getCtx(): Context {
  if (testCtx) return testCtx;
  if (activeBot) return activeBot.getCtx();
  throw new Error('Bot not initialized.');
}

// Execution trigger
const isPrimaryEntry =
  process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isPrimaryEntry) {
  main().catch((e: unknown) => {
    const msg = e instanceof Error ? e.stack || e.message : String(e);
    log(
      activeBot?.config?.logFile || './bot-error.log',
      `Unhandled top-level error: ${msg}`,
      'error'
    );
    process.exit(1);
  });
}
