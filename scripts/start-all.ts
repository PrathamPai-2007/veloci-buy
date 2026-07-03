import { spawn, exec, type ChildProcess } from 'child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, '..');

// Color codes
const RESET = '\x1b[0m';
const BOT_COLOR = '\x1b[36m'; // Cyan
const WEB_COLOR = '\x1b[35m'; // Magenta
const SYSTEM_COLOR = '\x1b[33m'; // Yellow

/**
 * Reads a single KEY=value from a .env-style file. Returns the raw (trimmed)
 * value, or undefined when the file or key is absent.
 */
function readEnvValue(content: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`^${escaped}=(.*)$`, 'm'));
  return match?.[1]?.trim();
}

/**
 * Writes KEY=value into a .env-style string, replacing an existing line or
 * appending. Uses a function-form replacement so `$n` sequences in the value
 * are never treated as backreferences (mirrors ApiService.writeEnvKey).
 */
function upsertEnvValue(content: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}=.*$`, 'm');
  if (pattern.test(content)) return content.replace(pattern, () => line);
  return content + (content.endsWith('\n') || content === '' ? '' : '\n') + line + '\n';
}

/**
 * Makes the dashboard "just work": ensures the bot has an API_TOKEN (generating
 * one if absent) and mirrors it — plus the WS URL — into website/.env.local so
 * the Vite frontend authenticates without any manual editing. Runs before either
 * child process starts, so both pick up the synced values.
 */
function syncApiToken(): void {
  const envPath = path.join(rootDir, '.env');
  let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

  let token = readEnvValue(envContent, 'API_TOKEN');
  if (!token) {
    token = randomBytes(32).toString('hex');
    envContent = upsertEnvValue(envContent, 'API_TOKEN', token);
    fs.writeFileSync(envPath, envContent);
    console.log(`${SYSTEM_COLOR}[SYSTEM] Generated a new API_TOKEN in .env${RESET}`);
  }

  const port = readEnvValue(envContent, 'API_PORT') || '8080';
  const localPath = path.join(rootDir, 'website', '.env.local');
  let localContent = fs.existsSync(localPath) ? fs.readFileSync(localPath, 'utf8') : '';
  localContent = upsertEnvValue(localContent, 'VITE_WS_URL', `ws://localhost:${port}`);
  localContent = upsertEnvValue(localContent, 'VITE_WS_TOKEN', token);
  fs.writeFileSync(localPath, localContent);
  console.log(`${SYSTEM_COLOR}[SYSTEM] Synced API token → website/.env.local${RESET}`);
}

syncApiToken();

console.log(`${SYSTEM_COLOR}[SYSTEM] Starting bot and website concurrently...${RESET}`);

// Helper to spawn a process and prefix its output. The command is passed as a
// single shell string (no args array) so Node doesn't emit DEP0190 — that
// warning only fires when an args array is combined with `shell: true`.
function runCommand(command: string, cwd: string, prefix: string, color: string): ChildProcess {
  const child = spawn(command, {
    cwd,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n')) {
      if (line.trim()) {
        console.log(`${color}${prefix}${RESET} ${line.trim()}`);
      }
    }
  });

  child.stderr?.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n')) {
      if (line.trim()) {
        console.error(`${color}${prefix} [ERROR]${RESET} ${line.trim()}`);
      }
    }
  });

  return child;
}

/**
 * Helper to kill a child process and all its children.
 * On Windows, standard .kill() only terminates the root process (usually cmd.exe / npm wrapper),
 * leaving the actual node.exe/child process running orphaned. We use taskkill to clean the tree.
 */
function killProcess(child: ChildProcess, signal?: string): void {
  if (!child || child.pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      exec(`taskkill /pid ${child.pid} /t /f`, () => {});
    } catch {
      child.kill(signal as NodeJS.Signals);
    }
  } else {
    child.kill(signal as NodeJS.Signals);
  }
}

// Start backend trading bot.
let botProcess: ChildProcess;

function startBot(): ChildProcess {
  const child = runCommand('npm run start', rootDir, '[BOT]', BOT_COLOR);
  child.on('exit', (code) => {
    console.log(`${BOT_COLOR}[BOT] exited with code ${code}${RESET}`);
    if (!shuttingDown) {
      if (code === 0) {
        console.log(`\n${SYSTEM_COLOR}[SYSTEM] Reloading bot configuration...${RESET}\n`);
        botProcess = startBot();
      } else {
        initiateShutdown('INTERNAL_ERROR');
        checkExit();
      }
    } else {
      // Bot has finished its graceful shutdown (state flushed). Vite has no
      // persistent state, so kill it immediately rather than waiting for it.
      killProcess(webProcess, 'SIGKILL');
      checkExit();
    }
  });
  return child;
}

botProcess = startBot();

// Start frontend website.
const webProcess = runCommand('npm run dev', path.join(rootDir, 'website'), '[WEB]', WEB_COLOR);

// Handle terminations cleanly.
let shuttingDown = false;
let exitedCount = 0;

function checkExit(): void {
  exitedCount++;
  if (exitedCount >= 2) {
    console.log(
      `\n${SYSTEM_COLOR}[SYSTEM] All processes exited. Shutting down completely.${RESET}`
    );
    process.exit(0);
  }
}

function initiateShutdown(signal?: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(
    `\n${SYSTEM_COLOR}[SYSTEM] Shutting down processes gracefully... Please wait.${RESET}`
  );

  // If initiated programmatically or by SIGTERM, send signal to children.
  // We skip sending SIGINT because the OS already broadcasts Ctrl+C to the process group,
  // and manually calling .kill('SIGINT') on Windows causes forceful immediate termination.
  if (signal && signal !== 'SIGINT') {
    const killSignal = signal === 'INTERNAL_ERROR' ? 'SIGTERM' : signal;
    killProcess(botProcess, killSignal);
    killProcess(webProcess, killSignal);
  }

  // Fallback timeout to force exit if children hang
  setTimeout(() => {
    console.log(`\n${SYSTEM_COLOR}[SYSTEM] Shutdown timeout reached. Force killing.${RESET}`);
    killProcess(botProcess, 'SIGKILL');
    killProcess(webProcess, 'SIGKILL');
    process.exit(1);
  }, 25000).unref();
}

process.on('SIGINT', () => initiateShutdown('SIGINT'));
process.on('SIGTERM', () => initiateShutdown('SIGTERM'));

// Bot process exit handler is registered dynamically in startBot()

webProcess.on('exit', (code) => {
  console.log(`${WEB_COLOR}[WEB] exited with code ${code}${RESET}`);
  if (!shuttingDown) initiateShutdown('INTERNAL_ERROR');
  checkExit();
});
