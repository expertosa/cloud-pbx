import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

export class AriError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Minimal Asterisk REST Interface client: REST calls + the Stasis event stream. */
export class Ari extends EventEmitter {
  private ws?: WebSocket;
  private stopped = false;
  private retry = 0;
  connected = false;

  private get auth() {
    return 'Basic ' + Buffer.from(`${config.ari.user}:${config.ari.password}`).toString('base64');
  }

  async request<T = any>(method: string, path: string, opts: { query?: Record<string, unknown>; body?: unknown } = {}): Promise<T> {
    const url = new URL(config.ari.url.replace(/\/$/, '') + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    const res = await fetch(url, {
      method,
      headers: { Authorization: this.auth, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new AriError(res.status, `ARI ${method} ${path} -> ${res.status} ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  get = <T = any>(p: string, query?: Record<string, unknown>) => this.request<T>('GET', p, { query });
  post = <T = any>(p: string, query?: Record<string, unknown>, body?: unknown) => this.request<T>('POST', p, { query, body });
  put = <T = any>(p: string, query?: Record<string, unknown>, body?: unknown) => this.request<T>('PUT', p, { query, body });
  del = <T = any>(p: string, query?: Record<string, unknown>) => this.request<T>('DELETE', p, { query });

  /** Same as request but ignores "already gone" errors (404/409/422) for best-effort cleanup. */
  async quiet<T = any>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AriError && [404, 409, 422].includes(e.status)) return undefined;
      throw e;
    }
  }

  connect(): void {
    this.stopped = false;
    const base = config.ari.url.replace(/^http/, 'ws').replace(/\/$/, '');
    const url = `${base}/events?app=${encodeURIComponent(config.ari.app)}&subscribeAll=false`;
    const ws = new WebSocket(url, { headers: { Authorization: this.auth } });
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true;
      this.retry = 0;
      logger.info('ARI connected');
      this.emit('connected');
    });
    ws.on('message', (data) => {
      let ev: any;
      try {
        ev = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.emit('event', ev);
      this.emit(ev.type, ev);
    });
    const onClose = () => {
      if (this.ws !== ws) return;
      const wasConnected = this.connected;
      this.connected = false;
      if (wasConnected) this.emit('disconnected');
      if (this.stopped) return;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.retry++, 5));
      logger.warn({ delay }, 'ARI connection lost, reconnecting');
      setTimeout(() => this.connect(), delay);
    };
    ws.on('close', onClose);
    ws.on('error', (err) => {
      logger.warn({ err: err.message }, 'ARI websocket error');
    });
  }

  close(): void {
    this.stopped = true;
    this.ws?.close();
  }
}

export const ari = new Ari();
