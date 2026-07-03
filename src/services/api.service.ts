import { WebSocketServer, WebSocket } from 'ws';
import { Context } from '../types/index.js';
import { ghostTrader } from '../ml/ghost-trader.js';
import fs from 'node:fs';
import path from 'node:path';

/** Shape of messages the dashboard sends us (validated loosely at runtime). */
interface IncomingMessage {
  type?: string;
  mode?: string;
  mint?: string;
  strategy?: string;
  enabled?: boolean;
}

/** Strategy names must be simple identifiers — no path chars, no newlines, no shell specials. */
const STRATEGY_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export class ApiService {
  private wss: WebSocketServer | null = null;
  private interval: NodeJS.Timeout | null = null;
  private ctx: Context;
  private cachedStrategies: string[] = [];
  private logBuffer: string[] = [];
  // Throttle the "unauthorized connection" warning so a misconfigured dashboard
  // reconnecting every few seconds can't flood the log.
  private rejectCount = 0;
  private rejectLastLoggedAt = 0;
  private static readonly REJECT_LOG_INTERVAL_MS = 60_000;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  public start(port = 8080): void {
    // Intercept the bot logger to feed the dashboard activity log.
    const origLogger = this.ctx.logger.bind(this.ctx);
    this.ctx.logger = (message, level, options) => {
      origLogger(message, level, options);
      if (level !== 'debug') {
        const ts = new Date().toISOString().slice(11, 19);
        const tag =
          level === 'error' ? 'ERR' : level === 'warn' ? 'WRN' : level === 'trade' ? 'TRD' : 'INF';
        this.logBuffer.push(`${ts} [${tag}] ${message}`);
        if (this.logBuffer.length > 75) this.logBuffer.shift();
      }
    };

    const host = this.ctx.config.apiHost;
    this.wss = new WebSocketServer({ port, host });
    this.ctx.logger(`API WebSocket server started on ws://${host}:${port}`, 'info', {
      console: true,
    });
    if (host === '0.0.0.0') {
      this.ctx.logger(
        'API_HOST=0.0.0.0 — dashboard API is reachable from other machines on the network. Ensure API_TOKEN is set.',
        'warn',
        { console: true }
      );
    }

    // Cache strategies once at startup so GET_STRATEGIES never blocks the event loop.
    this.cachedStrategies = this.loadStrategies();

    const token = this.ctx.config.apiToken;
    if (!token) {
      this.ctx.logger(
        'API WebSocket has no API_TOKEN — anyone who can reach the port can read engine state and control trading. Set API_TOKEN to lock it down.',
        'warn',
        { console: true }
      );
    }

    this.wss.on('connection', (ws, req) => {
      // Token gate: when API_TOKEN is configured, require a matching ?token= query param.
      if (token) {
        const provided = new URL(req.url ?? '', 'http://localhost').searchParams.get('token');
        if (provided !== token) {
          this.rejectCount++;
          const now = Date.now();
          if (now - this.rejectLastLoggedAt >= ApiService.REJECT_LOG_INTERVAL_MS) {
            const suppressed = this.rejectCount - 1;
            this.ctx.logger(
              `Rejected unauthorized dashboard WS connection (bad/missing token).${
                suppressed > 0 ? ` (${suppressed} more suppressed)` : ''
              }`,
              'warn',
              { console: true }
            );
            this.rejectLastLoggedAt = now;
            this.rejectCount = 0;
          }
          ws.close(1008, 'unauthorized');
          return;
        }
      }

      this.ctx.logger('Dashboard client connected via WS.', 'debug');
      ws.send(JSON.stringify(this.buildPayload()));

      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message.toString()) as IncomingMessage;
          if (data.type === 'SET_TRADING_MODE') {
            const isPaper = data.mode === 'paper';
            // Refuse to enable LIVE trading over an unauthenticated socket — without a
            // token there's no way to know the caller is the operator, and a live switch
            // moves real funds. Paper is allowed for local dev convenience.
            if (!isPaper && !token) {
              this.ctx.logger(
                'Refused LIVE trading switch from dashboard: API_TOKEN not set.',
                'warn',
                { console: true }
              );
              ws.send(
                JSON.stringify({
                  type: 'TRADE_DETAILS_RESULT',
                  error:
                    'Live trading cannot be enabled from the dashboard until API_TOKEN is configured on the bot.',
                })
              );
              this.broadcast(); // Re-sync UI back to the actual (still paper) mode
              return;
            }
            this.ctx.config.paperTrading = isPaper;
            this.ctx.logger(
              `Trading mode changed via Dashboard to: ${isPaper ? 'PAPER' : 'LIVE'}`,
              'warn',
              { console: true }
            );
            this.broadcast(); // Send updated state immediately
          } else if (data.type === 'GET_TRADE_DETAILS') {
            const mint = data.mint ?? '';
            let trade: unknown = this.ctx.state.positions.get(mint);
            if (!trade) {
              const activeGhost = ghostTrader.getGhost(mint);
              if (activeGhost) {
                trade = {
                  mint: activeGhost.mint,
                  symbol: activeGhost.symbol,
                  entryPriceUsd: activeGhost.entryPriceUsd,
                  highestPriceUsd: activeGhost.highestPriceUsd,
                  realizedPnlSol: 0,
                  entryUsdValue: 0.1, // simulated size
                  exitReason: 'ACTIVE GHOST',
                  holdSeconds: Math.floor((Date.now() - activeGhost.openedAt) / 1000),
                  targetsHit: activeGhost.targetsHit,
                  entryScore: activeGhost.entryScore,
                  tpProfile: activeGhost.tpProfile || 'Default',
                  volatilityScaler: 1.0,
                  launchpad: activeGhost.launchpad || 'pump.fun',
                  isGhost: true,
                  closedAt: null,
                };
              }
            }
            if (!trade) {
              trade = this.ctx.state.closedTrades.find((t) => t.mint === mint);
            }
            if (trade) {
              ws.send(
                JSON.stringify({
                  type: 'TRADE_DETAILS_RESULT',
                  data: trade,
                })
              );
            } else {
              ws.send(
                JSON.stringify({
                  type: 'TRADE_DETAILS_RESULT',
                  error: 'Trade not found',
                })
              );
            }
          } else if (data.type === 'GET_STRATEGIES') {
            ws.send(
              JSON.stringify({
                type: 'STRATEGIES_RESULT',
                data: this.cachedStrategies,
                current: this.ctx.config.strategyName,
              })
            );
          } else if (data.type === 'SET_STRATEGY') {
            const strategy = data.strategy;
            if (!strategy || !STRATEGY_NAME_RE.test(strategy)) {
              ws.send(
                JSON.stringify({ type: 'STRATEGIES_RESULT', error: 'Invalid strategy name.' })
              );
            } else {
              this.writeEnvKey('STRATEGY', strategy);
              this.cachedStrategies = this.loadStrategies();
              this.ctx.logger(`Strategy changed to ${strategy}. Restarting bot...`, 'info', {
                console: true,
              });
              ws.send(JSON.stringify({ type: 'STRATEGY_SET_SUCCESS' }), () =>
                setTimeout(() => process.exit(0), 250)
              );
            }
          } else if (data.type === 'SET_BURST_MODE') {
            const enabled = data.enabled === true;
            this.writeEnvKey('BURST_MODE_ENABLED', enabled ? 'true' : 'false');
            this.ctx.logger(
              `Burst mode ${enabled ? 'enabled' : 'disabled'} via Dashboard. Restarting...`,
              'info',
              { console: true }
            );
            ws.send(JSON.stringify({ type: 'BURST_MODE_SET_SUCCESS' }), () =>
              setTimeout(() => process.exit(0), 250)
            );
          }
        } catch {
          this.ctx.logger('Failed to parse WS message from client', 'debug');
        }
      });
    });

    // Broadcast every 1000ms
    this.interval = setInterval(() => {
      this.broadcast();
    }, 1000);
  }

  public stop(): void {
    if (this.interval) clearInterval(this.interval);
    if (this.wss) {
      this.wss.clients.forEach((ws) => ws.terminate());
      this.wss.close();
    }
  }

  private broadcast() {
    if (!this.wss || this.wss.clients.size === 0) return;
    const payload = JSON.stringify(this.buildPayload());
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    });
  }

  /** Reads the strategies directory once and returns a sorted deduplicated list. */
  private loadStrategies(): string[] {
    const dir = path.join(process.cwd(), 'strategies');
    try {
      const files = fs.readdirSync(dir);
      const names = files.filter((f) => f.endsWith('.yaml')).map((f) => f.replace('.yaml', ''));
      if (!names.includes('standard')) names.push('standard');
      return names;
    } catch {
      return ['standard'];
    }
  }

  /**
   * Writes a single key=value line to the .env file, replacing an existing
   * occurrence or appending. The value must already be validated by the caller;
   * this helper uses a function-form replacement to prevent `$n` backreference
   * interpretation by String.replace.
   */
  private writeEnvKey(key: string, value: string): void {
    // Warn when a shell env var would override the .env value we just wrote; the change
    // will be invisible to the next process unless the shell var is also cleared.
    if (key in process.env) {
      this.ctx.logger(
        `writeEnvKey: shell environment already has ${key}="${process.env[key]}" — it takes precedence over .env on restart. Clear the shell var for this change to take effect.`,
        'warn',
        { console: true }
      );
    }
    const envPath = path.resolve(process.cwd(), '.env');
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const line = `${key}=${value}`;
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${escaped}=.*$`, 'm');
    if (pattern.test(content)) {
      content = content.replace(pattern, () => line);
    } else {
      content += `\n${line}\n`;
    }
    fs.writeFileSync(envPath, content);
  }

  private buildPayload() {
    const state = this.ctx.state;
    const activeSignals = state.pendingCandidateRechecks.size;

    let realizedPnlSol = 0;

    const activePos = Array.from(state.positions.values()).map((p) => ({
      mint: p.mint,
      symbol: p.symbol,
      entryPriceUsd: p.entryPriceUsd,
      highestPriceUsd: p.highestPriceUsd,
      realizedPnlSol: p.realizedPnlSol || 0,
      isGhost: false,
      closedAt: null as string | null,
      entryScore: p.entryScore,
      launchpad: p.launchpad,
    }));

    const activeGhosts = ghostTrader.getActiveMints().map((mint) => {
      const g = ghostTrader.getGhost(mint)!;
      return {
        mint: g.mint,
        symbol: g.symbol,
        entryPriceUsd: g.entryPriceUsd,
        highestPriceUsd: g.highestPriceUsd,
        realizedPnlSol: 0,
        isGhost: true,
        closedAt: null as string | null,
        entryScore: g.entryScore,
        launchpad: g.launchpad,
      };
    });

    const closed = state.closedTrades.map((t) => ({
      mint: t.mint,
      symbol: t.symbol,
      entryPriceUsd: t.entryPriceUsd,
      highestPriceUsd: t.highestPriceUsd,
      realizedPnlSol: t.realizedPnlSol || 0,
      isGhost: t.isGhost,
      closedAt: t.closedAt as string | null,
      entryScore: t.entryScore,
      launchpad: t.launchpad,
    }));

    const allTrades = [...activePos, ...activeGhosts, ...closed];
    allTrades.sort((a, b) => {
      if (a.closedAt === null && b.closedAt !== null) return -1;
      if (a.closedAt !== null && b.closedAt === null) return 1;
      if (a.closedAt === null && b.closedAt === null) return 0;
      return new Date(b.closedAt!).getTime() - new Date(a.closedAt!).getTime();
    });

    const realClosed = closed.filter((t) => !t.isGhost);
    const tokensTraded = realClosed.length + activePos.length;

    let winCount = 0;
    for (const trade of closed) {
      if (trade.realizedPnlSol) {
        realizedPnlSol += trade.realizedPnlSol;
      }
    }
    for (const trade of realClosed) {
      if (trade.realizedPnlSol && trade.realizedPnlSol > 0) {
        winCount++;
      }
    }
    const sessionWinRate = realClosed.length > 0 ? (winCount / realClosed.length) * 100 : 0;

    const mappedTrades = allTrades.slice(0, 50).map((t) => ({
      status:
        t.closedAt === null
          ? t.isGhost
            ? 'ACTIVE GHOST'
            : 'ACTIVE LIVE'
          : t.isGhost
            ? 'GHOST'
            : t.realizedPnlSol && t.realizedPnlSol > 0
              ? 'PROFIT'
              : 'LOSS',
      symbol: t.symbol || 'UNKNOWN',
      mint: t.mint, // Send RAW full mint address
      platform: t.launchpad || 'Unknown',
      color:
        t.closedAt === null
          ? t.isGhost
            ? 'var(--color-violet)'
            : 'var(--color-ink)'
          : t.isGhost
            ? 'var(--color-violet)'
            : t.realizedPnlSol && t.realizedPnlSol > 0
              ? 'var(--color-cyan-deep)'
              : 'var(--color-error)',
    }));

    // Surface ML training health so the dashboard can chart accuracy/precision
    // over time and spot model drift. Both keys are best-effort; malformed JSON
    // simply yields nulls rather than breaking the payload.
    let mlMetrics: unknown = null;
    let mlMetricsHistory: unknown[] = [];
    try {
      const last = this.ctx.store.getKV('ml:lastRetrainMetrics');
      if (last) mlMetrics = JSON.parse(last);
      const hist = this.ctx.store.getKV('ml:retrainHistory');
      if (hist) mlMetricsHistory = (JSON.parse(hist) as unknown[]).slice(-20);
    } catch {
      // ignore malformed metrics — leave defaults
    }

    return {
      activeSignals,
      sessionWinRate,
      tokensTraded,
      pnl: realizedPnlSol.toFixed(4),
      recentTrades: mappedTrades,
      isPaperTrading: this.ctx.config.paperTrading,
      burstModeEnabled: this.ctx.config.burstModeEnabled,
      mlMetrics,
      mlMetricsHistory,
      logs: [...this.logBuffer],
    };
  }
}
