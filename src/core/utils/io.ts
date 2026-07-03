import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { Context, LogLevel } from '#types/index.js';

export function ensureParentDirectory(filePath: string): void {
  const directory = path.dirname(path.resolve(filePath));
  fs.mkdirSync(directory, { recursive: true });
}

export async function sleep(ms: number): Promise<void> {
  if ((global as { __TEST__?: boolean }).__TEST__ || process.env.NODE_ENV === 'test') {
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function atomicWriteFile(
  filePath: string,
  content: string,
  options: { logErrors?: boolean } = {}
): Promise<void> {
  if (!filePath) return;
  const resolvedPath = path.resolve(filePath);
  ensureParentDirectory(resolvedPath);
  const tempPath = `${resolvedPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;

  const maxRetries = 5;
  let lastError: unknown;

  for (let i = 0; i < maxRetries; i++) {
    try {
      await fsPromises.writeFile(tempPath, content, 'utf8');
      await fsPromises.rename(tempPath, resolvedPath);
      return;
    } catch (err: unknown) {
      lastError = err;
      if (
        err instanceof Error &&
        ((err as { code?: string }).code === 'EPERM' ||
          (err as { code?: string }).code === 'EBUSY') &&
        i < maxRetries - 1
      ) {
        await sleep(50 * (i + 1));
        continue;
      }
      break;
    }
  }

  if (options.logErrors !== false) {
    safeConsole(
      'error',
      `[SYSTEM ERROR] Atomic write failed for ${filePath} after retries: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`
    );
  }
  try {
    if (fs.existsSync(tempPath)) await fsPromises.unlink(tempPath);
  } catch {}
  throw lastError;
}

export function appendFileLine(filePath: string, line: string): void {
  if (!filePath) return;
  ensureParentDirectory(filePath);
  fs.appendFile(path.resolve(filePath), `${line}\n`, (err) => {
    if (err) {
      safeConsole('error', `[SYSTEM ERROR] Failed to write to ${filePath}: ${err.message}`);
    }
  });
}

export function appendFileLineSync(filePath: string, line: string): void {
  if (!filePath) return;
  ensureParentDirectory(filePath);
  fs.appendFileSync(path.resolve(filePath), `${line}\n`);
}

export function safeJsonStringify(value: unknown, space?: number | string): string {
  return JSON.stringify(
    value,
    (_key, currentValue: unknown) =>
      typeof currentValue === 'bigint' ? currentValue.toString() : currentValue,
    space
  );
}

let consoleSuppressed = false;

export function setConsoleSuppressed(suppressed: boolean): void {
  consoleSuppressed = suppressed;
}

const LOG_PREFIX: Record<LogLevel, string> = {
  info: '[INFO]',
  warn: '[WARN]',
  error: '[ERROR]',
  trade: '[TRADE]',
  debug: '[DEBUG]',
};

export function log(
  logFilePath: string | undefined | null,
  message: string,
  level: LogLevel = 'info',
  options: { sync?: boolean; console?: boolean } = {}
): void {
  const prefix = LOG_PREFIX[level] ?? '[INFO]';
  const line = `${new Date().toISOString()} ${prefix} ${message}`;

  if (logFilePath) {
    if (options.sync) {
      appendFileLineSync(logFilePath, line);
    } else {
      appendFileLine(logFilePath, line);
    }
  }

  if (consoleSuppressed) return;

  const shouldPrint =
    options.console !== undefined
      ? options.console
      : level === 'error' || level === 'trade' || level === 'info';

  if (shouldPrint) {
    safeConsole('log', line);
  }
}

/**
 * Writes to the console without ever throwing. When stdout/stderr is a pipe
 * whose reader has gone away (terminal closed, `| head`, etc.) Node raises a
 * synchronous EPIPE on write. Left unhandled that surfaces as a fatal
 * uncaughtException — and because the shutdown path also logs, it cascades into
 * an unrecoverable loop. Swallowing the write error keeps the process alive
 * (file logging is unaffected, since it goes through fs above).
 */
export function safeConsole(method: 'log' | 'error', ...args: unknown[]): void {
  try {
    console[method](...args);
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code;
    if (code === 'EPIPE') return;
    // Any other console failure is non-fatal too; there is nowhere safe to
    // report it, so drop it rather than risk re-throwing into a crash loop.
  }
}

function appendJournalEntry(filePath: string, data: Record<string, unknown>): void {
  appendFileLine(filePath, safeJsonStringify({ timestamp: new Date().toISOString(), ...data }));
}

export function journalPaperTrade(ctx: Context, entry: Record<string, unknown>): void {
  if (!ctx.config.paperTrading || !ctx.config.paperTradeJournalFile) return;
  appendJournalEntry(ctx.config.paperTradeJournalFile, entry);
}

export function journalClosedTrade(ctx: Context, trade: Record<string, unknown>): void {
  if (!ctx.config.tradeJournalFile) return;
  appendJournalEntry(ctx.config.tradeJournalFile, trade);
}
