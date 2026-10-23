import path from 'node:path';
import fs from 'node:fs';
import { safeConsole, decimalToAtomic } from '../utils.js';

export function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;

  try {
    const content = fs.readFileSync(envPath, 'utf8');
    content.split(/\r?\n/).forEach((line) => {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith('#')) return;
      const [key, ...valueParts] = trimmedLine.split('=');
      if (!key) return;
      const keyTrimmed = key.trim();
      const valueRaw = valueParts.join('=').trim();
      if (keyTrimmed && !process.env[keyTrimmed]) {
        process.env[keyTrimmed] = valueRaw.replace(/^["'](.*)["']$/, '$1');
      }
    });
  } catch (err: unknown) {
    safeConsole(
      'error',
      `[CONFIG] Failed to parse .env file: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function envRequire(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function envInt(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`Invalid integer in ${name}: ${raw}`);
  return value;
}

export function envFloat(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid number in ${name}: ${raw}`);
  return value;
}

export function envBigInt(
  name: string,
  fallback: bigint,
  decimals: number = 9,
  env: NodeJS.ProcessEnv = process.env
): bigint {
  const raw = env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (!/^\d+(\.\d+)?$/.test(String(raw).trim()))
    throw new Error(`Invalid decimal in ${name}: ${raw}`);
  return BigInt(decimalToAtomic(raw, decimals));
}

export function envBool(
  name: string,
  fallback: boolean,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const raw = env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

export class NumberParser {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  require(name: string): string {
    return envRequire(name, this.env);
  }

  int(name: string, fallback: number): number {
    return envInt(name, fallback, this.env);
  }

  float(name: string, fallback: number): number {
    return envFloat(name, fallback, this.env);
  }

  bigint(name: string, fallback: bigint, decimals: number = 9): bigint {
    return envBigInt(name, fallback, decimals, this.env);
  }

  boolean(name: string, fallback: boolean): boolean {
    return envBool(name, fallback, this.env);
  }
}

export const numberParser = new NumberParser();
