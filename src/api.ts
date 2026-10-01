// HTTP API for the web app. Plain node req/res so it works both under the
// Signal K server's Express router and in the stand-alone dev server.
//
//   GET  api/state             current WifishState
//   GET  api/stream            Server-Sent Events: "display", "state", "col" (backlog first, then live)
//   POST api/channel/:channel  ChannelPatch  (channel = sonar | downvision)
//   POST api/system            SystemPatch
//   GET  api/display           DisplayPrefs (depth and temperature units shared by all viewers)
//   POST api/display           DisplayPrefs patch

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Engine } from './engine';
import { DisplayStore, parseDisplayPatch } from './display';
import { CHANNELS, type ChannelName, type ChannelPatch, type ColumnMessage, type SystemPatch, type WifishState } from './shared/api';

type Req = IncomingMessage & { body?: unknown };

/**
 * Live data a viewer may leave unread before it is dropped (it reconnects after
 * `retry` and gets a fresh backlog). Counted on top of its initial backlog.
 */
export const MAX_UNREAD_BYTES = 4 * 1024 * 1024;
/** Concurrent event streams; each holds a copy of the backlog while it drains. */
export const MAX_STREAMS = 16;
type Res = ServerResponse & { flush?: () => void };

/** Send a JSON response with the given status, marked uncacheable. */
function sendJson(res: Res, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/** Parse the JSON request body (or reuse the server's already-parsed one); rejects bodies over 16 KiB. */
async function readBody(req: Req): Promise<unknown> {
  // Already consumed and parsed by the server's body parser.
  if (req.body !== undefined && req.readableEnded) return req.body;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 16_384) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

const BOOL_KEYS = ['rangeAuto', 'gainAuto', 'contrastAuto', 'noiseFilterAuto'] as const;
const PCT_KEYS = ['gain', 'contrast', 'noiseFilter'] as const;
const CM_KEYS = ['rangeShallowCm', 'rangeDeepCm'] as const;

/** Validated channel patch, or an error string. */
export function parseChannelPatch(body: unknown): ChannelPatch | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'expected a JSON object';
  const b = body as Record<string, unknown>;
  const out: ChannelPatch = {};
  for (const k of Object.keys(b)) {
    if ((BOOL_KEYS as readonly string[]).includes(k)) {
      if (typeof b[k] !== 'boolean') return `${k} must be boolean`;
      (out as Record<string, unknown>)[k] = b[k];
    } else if ((PCT_KEYS as readonly string[]).includes(k)) {
      const v = b[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) return `${k} must be 0..100`;
      (out as Record<string, unknown>)[k] = Math.round(v);
    } else if ((CM_KEYS as readonly string[]).includes(k)) {
      const v = b[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100_000) return `${k} must be 0..100000 cm`;
      (out as Record<string, unknown>)[k] = Math.round(v);
    } else {
      return `unknown field ${k}`;
    }
  }
  if (out.rangeShallowCm !== undefined && out.rangeDeepCm !== undefined && out.rangeShallowCm >= out.rangeDeepCm) {
    return 'rangeShallowCm must be less than rangeDeepCm';
  }
  return Object.keys(out).length ? out : 'empty patch';
}

/** Validated system patch, or an error string. */
export function parseSystemPatch(body: unknown): SystemPatch | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'expected a JSON object';
  const b = body as Record<string, unknown>;
  const out: SystemPatch = {};
  for (const k of Object.keys(b)) {
    if (k === 'simulator') {
      if (typeof b[k] !== 'boolean') return 'simulator must be boolean';
      out.simulator = b[k] as boolean;
    } else if (k === 'transducerOffsetCm') {
      const v = b[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 300) return 'transducerOffsetCm must be -300..300';
      out.transducerOffsetCm = Math.round(v);
    } else {
      return `unknown field ${k}`;
    }
  }
  return Object.keys(out).length ? out : 'empty patch';
}

/** Interleave both channels' backlogs by time so the viewer rebuilds history in order. */
export function backlog(engine: Pick<Engine, 'history'>): ColumnMessage[] {
  const all = CHANNELS.flatMap((c) => engine.history(c));
  return all.sort((a, b) => a.t - b.t);
}

export class Api {
  #engine: () => Engine | null;
  /** Connected viewers and how many buffered bytes each may have before it is dropped. */
  #clients = new Map<Res, number>();
  #unsub: (() => void) | null = null;
  #bound: Engine | null = null;
  #display: DisplayStore;

  /** `engine` is a getter so the plugin can swap engines on restart; `display` keeps the viewers' units. */
  constructor(engine: () => Engine | null, display = new DisplayStore()) {
    this.#engine = engine;
    this.#display = display;
  }

  /** Route a request whose path is relative to the plugin root. Returns false when not ours. */
  async handle(req: Req, res: Res, path: string): Promise<boolean> {
    const method = req.method ?? 'GET';
    if (method === 'GET' && path === '/api/state') {
      const engine = this.#engine();
      if (!engine) sendJson(res, 503, { error: 'plugin not running' });
      else sendJson(res, 200, engine.state());
      return true;
    }
    if (method === 'GET' && path === '/api/display') {
      sendJson(res, 200, this.#display.get());
      return true;
    }
    if (method === 'GET' && path === '/api/stream') {
      if (this.#clients.size >= MAX_STREAMS) return sendJson(res, 503, { error: 'too many viewers' }), true;
      this.#stream(req, res);
      return true;
    }
    const m = /^\/api\/channel\/(sonar|downvision)$/.exec(path);
    if (method !== 'POST' || (!m && path !== '/api/system' && path !== '/api/display')) return false;
    // JSON only: a cross-site form or text/plain POST (no CORS preflight) must not reach the sonar.
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) {
      return sendJson(res, 415, { error: 'Content-Type must be application/json' }), true;
    }
    let body: unknown;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof SyntaxError ? 'invalid JSON' : (e as Error).message }), true;
    }
    if (path === '/api/display') {
      // Display units belong to the viewers, not the sonar: kept even while the plugin is stopped.
      const patch = parseDisplayPatch(body);
      if (typeof patch === 'string') return sendJson(res, 400, { error: patch }), true;
      const d = this.#display.set(patch);
      this.#broadcast('display', d);
      return sendJson(res, 200, d), true;
    }
    const engine = this.#engine(); // read after the body: the plugin may have restarted meanwhile
    if (!engine) return sendJson(res, 503, { error: 'plugin not running' }), true;
    try {
      let err: string | null;
      if (m) {
        const patch = parseChannelPatch(body);
        if (typeof patch === 'string') return sendJson(res, 400, { error: patch }), true;
        err = engine.setChannel(m[1] as ChannelName, patch);
      } else {
        const patch = parseSystemPatch(body);
        if (typeof patch === 'string') return sendJson(res, 400, { error: patch }), true;
        err = engine.setSystem(patch);
      }
      sendJson(res, err ? 409 : 200, err ? { error: err } : engine.state());
    } catch {
      sendJson(res, 500, { error: 'internal error' });
    }
    return true;
  }

  /** Call after the engine was (re)created so live events reach connected viewers. */
  bind(): void {
    const engine = this.#engine();
    if (engine === this.#bound) return;
    this.#unsub?.();
    this.#unsub = null;
    this.#bound = engine;
    if (!engine) {
      this.#broadcast('state', null);
      return;
    }
    /** Forward engine state changes to every viewer. */
    const onState = (s: WifishState) => this.#broadcast('state', s);
    /** Forward each new echogram column to every viewer. */
    const onCol = (c: ColumnMessage) => this.#broadcast('col', c);
    engine.on('state', onState);
    engine.on('column', onCol);
    this.#unsub = () => { engine.off('state', onState); engine.off('column', onCol); };
    this.#broadcast('reset', null);
    this.#broadcast('state', engine.state());
  }

  /** Detach from the engine and end every viewer's event stream. */
  close(): void {
    this.#unsub?.();
    this.#unsub = null;
    this.#bound = null;
    for (const c of this.#clients.keys()) c.end();
    this.#clients.clear();
  }

  /** Open an SSE stream: display units, current state, the column backlog, a 'live' marker, then live events and pings. */
  #stream(req: Req, res: Res): void {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write('retry: 2000\n\n');
    const engine = this.#engine();
    this.#write(res, 'display', this.#display.get());
    this.#write(res, 'state', engine ? engine.state() : null);
    if (engine) for (const c of backlog(engine)) this.#write(res, 'col', c);
    this.#write(res, 'live', null);
    this.#clients.set(res, res.writableLength + MAX_UNREAD_BYTES);
    const ping = setInterval(() => { if (!res.destroyed) { res.write(': ping\n\n'); res.flush?.(); } }, 15_000);
    /** Stop pinging and forget the viewer once its connection closes. */
    const done = () => { clearInterval(ping); this.#clients.delete(res); };
    req.on('close', done);
    res.on('close', done);
  }

  /** Write one SSE event and flush it past any compression buffering. */
  #write(res: Res, event: string, data: unknown): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.flush?.(); // compression middleware buffers otherwise
  }

  /** Send an event to every viewer, dropping any whose unread output exceeds its budget. */
  #broadcast(event: string, data: unknown): void {
    for (const [c, budget] of this.#clients) {
      // A viewer that stopped reading (stalled proxy, suspended tab) would buffer forever.
      if (c.writableLength > budget) {
        this.#clients.delete(c);
        c.destroy();
        continue;
      }
      // Once its backlog has drained, hold it to the plain limit.
      if (c.writableLength < MAX_UNREAD_BYTES && budget > MAX_UNREAD_BYTES) this.#clients.set(c, MAX_UNREAD_BYTES);
      this.#write(c, event, data);
    }
  }
}
