import { Config } from '#types/index.js';

export class ConfigView {
  constructor(private readonly config: Config) {}

  public get raw(): Config {
    return this.config;
  }

  public getNumber(key: keyof Config, defaultValue: number): number {
    const val = this.config[key];
    if (typeof val === 'number' && !isNaN(val)) {
      return val;
    }
    return defaultValue;
  }

  public getBoolean(key: keyof Config, defaultValue: boolean): boolean {
    const val = this.config[key];
    if (typeof val === 'boolean') {
      return val;
    }
    return defaultValue;
  }

  public getString(key: keyof Config, defaultValue: string): string {
    const val = this.config[key];
    if (typeof val === 'string' && val.length > 0) {
      return val;
    }
    return defaultValue;
  }

  public getArray<T = string>(key: keyof Config, defaultValue: T[]): T[] {
    const val = this.config[key];
    if (Array.isArray(val)) {
      return val as T[];
    }
    return defaultValue;
  }

  public getRateLimitBackoffMs(attempt: number = 0): number {
    const baseDelay = this.getNumber('mintSignalRetryDelayMs', 1000);
    return baseDelay * Math.pow(2, attempt);
  }

  public getAuditConcurrency(): number {
    return Math.max(1, this.getNumber('maxConcurrentAudits', 5));
  }

  public isDryRun(): boolean {
    return this.getBoolean('dryRun', true);
  }

  public isPaperTrading(): boolean {
    return this.getBoolean('paperTrading', true);
  }

  public isLiveTrading(): boolean {
    return this.getBoolean('liveTradingEnabled', false);
  }
}
