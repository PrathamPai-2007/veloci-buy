/**
 * Client for the veloci-buy Geyser plugin (see `geyser-plugin/`).
 *
 * Connects to the plugin's NDJSON stream — a Unix Domain Socket or TCP endpoint
 * exposed by a validator running the plugin — and forwards account updates to a
 * callback. This is an *optional accelerator*: it is enabled by default, but
 * requires either a TCP endpoint or a socket path to be provided.
 * RPC polling. Geyser never becomes a hard dependency.
 *
 * Pool-account decoding (raw bytes → price) is deliberately left as an injected
 * hook (`decode`) because it is DEX-specific and evolves independently of the
 * transport. Until a decoder is supplied, updates are observed (for health
 * metrics) but do not mutate market state.
 */
import net from 'node:net';
import bs58 from 'bs58';

/** One account update line emitted by the plugin. */
export interface GeyserAccountUpdate {
  pubkey: string;
  owner: string;
  lamports: number;
  slot: number;
  writeVersion: number;
  /** Raw account data */
  data: Buffer;
}

export interface GeyserClientOptions {
  /** TCP endpoint "host:port"; takes precedence over socketPath if both set. */
  tcpAddr?: string;
  /** Unix Domain Socket path. */
  socketPath?: string;
  /** Called for each valid account update. */
  onUpdate: (update: GeyserAccountUpdate) => void;
  /** Connection-state logger. */
  log?: (msg: string, level: 'info' | 'warn' | 'error') => void;
  /** Reconnect backoff ceiling (ms). Default 10s. */
  maxBackoffMs?: number;
}

/**
 * Reconnecting binary client. `start()` connects and auto-reconnects with
 * exponential backoff; `stop()` tears down cleanly. All failures are non-fatal.
 */
export class GeyserClient {
  private socket: net.Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private stopped = false;
  private backoffMs = 500;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private updateCount = 0;

  constructor(private readonly opts: GeyserClientOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  /** Total updates parsed since start — useful for health/metrics. */
  getUpdateCount(): number {
    return this.updateCount;
  }

  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed && this.socket.readyState === 'open';
  }

  private log(msg: string, level: 'info' | 'warn' | 'error'): void {
    this.opts.log?.(msg, level);
  }

  private connect(): void {
    if (this.stopped) return;

    const onConnect = (): void => {
      this.backoffMs = 500; // reset backoff on a healthy connection
      this.log('[Geyser] Connected to plugin stream.', 'info');
    };

    let socket: net.Socket;
    if (this.opts.tcpAddr) {
      const [host, portStr] = this.opts.tcpAddr.split(':');
      const port = Number(portStr);
      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        this.log(
          `[Geyser] Invalid tcpAddr "${this.opts.tcpAddr}" — expected "host:port". Not connecting.`,
          'error'
        );
        return;
      }
      socket = net.createConnection({ host: host || '127.0.0.1', port }, onConnect);
    } else if (this.opts.socketPath) {
      socket = net.createConnection({ path: this.opts.socketPath }, onConnect);
    } else {
      this.log('[Geyser] No tcpAddr or socketPath configured — not connecting.', 'warn');
      return;
    }

    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (err) => {
      this.log(`[Geyser] Stream error: ${err.message}`, 'warn');
    });
    socket.on('close', () => {
      this.socket = null;
      this.scheduleReconnect();
    });

    this.socket = socket;
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 4) {
      const frameLen = this.buffer.readUInt32LE(0);
      if (this.buffer.length >= 4 + frameLen) {
        const frame = this.buffer.subarray(4, 4 + frameLen);
        this.buffer = this.buffer.subarray(4 + frameLen);
        this.parseFrame(frame);
      } else {
        break; // Wait for more data
      }
    }

    // Guard against massive unbounded buffers (e.g. malformed frames)
    if (this.buffer.length > 50_000_000) {
      this.log('[Geyser] Frame buffer exceeded 50MB, dropping', 'error');
      this.buffer = Buffer.alloc(0);
    }
  }

  private parseFrame(frame: Buffer) {
    if (frame.length < 32 + 32 + 8 + 8 + 8 + 4) return;

    let offset = 0;
    const pubkey = bs58.encode(frame.subarray(offset, offset + 32));
    offset += 32;
    const owner = bs58.encode(frame.subarray(offset, offset + 32));
    offset += 32;
    const lamports = Number(frame.readBigUInt64LE(offset));
    offset += 8;
    const slot = Number(frame.readBigUInt64LE(offset));
    offset += 8;
    const writeVersion = Number(frame.readBigUInt64LE(offset));
    offset += 8;
    const dataLen = frame.readUInt32LE(offset);
    offset += 4;

    if (frame.length >= offset + dataLen) {
      const data = frame.subarray(offset, offset + dataLen);
      const update: GeyserAccountUpdate = { pubkey, owner, lamports, slot, writeVersion, data };
      this.updateCount++;
      try {
        this.opts.onUpdate(update);
      } catch (err) {
        this.log(
          `[Geyser] onUpdate callback threw: ${err instanceof Error ? err.message : String(err)}`,
          'warn'
        );
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const ceiling = this.opts.maxBackoffMs ?? 10_000;
    const delay = Math.min(this.backoffMs, ceiling);
    this.backoffMs = Math.min(this.backoffMs * 2, ceiling);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

/** Reads Geyser client options from the environment, or null if disabled. */
export function geyserOptionsFromEnv(): { tcpAddr?: string; socketPath?: string } | null {
  if (process.env.GEYSER_ENABLED === 'false') return null;
  const tcpAddr = process.env.GEYSER_TCP_ADDR;
  const socketPath = process.env.GEYSER_SOCKET_PATH;
  if (!tcpAddr && !socketPath) return null;
  return { tcpAddr, socketPath };
}
