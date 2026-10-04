// HTTP API for the web app. Plain node req/res so it works both under the
// Signal K server's Express router and in the stand-alone dev server.
//
//   GET  api/state             current WifishState
//   GET  api/stream            Server-Sent Events: "display", "state", "vessel", "col" (backlog first, then live)
//   POST api/channel/:channel  ChannelPatch  (channel = sonar | downvision)
//   POST api/system            SystemPatch
//   GET  api/display           DisplayPrefs (depth and temperature units shared by all viewers)
//   POST api/display           DisplayPrefs patch
//   GET  api/vessel            VesselSettings (waterline-to-transducer distance)
//   POST api/vessel            VesselSettings patch
//
// Under Signal K the GETs are registered for readonly users and the POSTs for readwrite
// users (plugin.ts); on a server without per-route plugin access every route is admin-only.
// A readonly principal sees canControl false in every state it is sent, and a POST that
// reaches the API with one anyway (defence in depth) gets 403.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Engine, HistoryEntry } from './engine';
import { DisplayStore, VesselStore, parseDisplayPatch, parseVesselPatch } from './store';
import { isChannelName, type ChannelName, type ChannelPatch, type SystemPatch, type WifishState } from './shared/api';
import { MAX_RANGE_CM, MAX_TRANSDUCER_OFFSET_CM, MIN_RANGE_WINDOW_CM } from './shared/units';
import { errorMessage } from './util';

/** Authentication the Signal K server attaches to a request (its SKRequest); absent stand-alone. */
interface SKRequest {
  skIsAuthenticated?: boolean;
  skPrincipal?: { identifier?: string; permissions?: string };
}
type Req = IncomingMessage & SKRequest & { body?: unknown };
type Res = ServerResponse & { flush?: () => void };

/**
 * Live data a viewer may leave unread before it is dropped (it reconnects after
 * `retry` and gets a fresh backlog).
 */
export const MAX_UNREAD_BYTES = 4 * 1024 * 1024;
/** Concurrent event streams. */
export const MAX_STREAMS = 16;
/** History a new viewer gets, as bytes of SSE frames, newest columns first (about 1500 full columns). */
export const MAX_BACKLOG_BYTES = 2 * 1024 * 1024;
/**
 * Largest JSON request body. Under Signal K the body arrives already parsed by the server's
 * bodyParser.json (10 MB limit), so the streaming check in readBody only applies stand-alone;
 * the Content-Length check in handle() applies in both modes.
 */
export const MAX_BODY_BYTES = 16 * 1024;
/** SSE comment keeping idle streams alive through proxies. */
const PING_MS = 15_000;

/** The Signal K principal may look but not change anything (anonymous readonly access included). */
const isReadonly = (req: Req): boolean => req.skIsAuthenticated === true && req.skPrincipal?.permissions === 'readonly';

/** Send a JSON response with the given status, marked uncacheable. */
function sendJson(res: Res, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
/** sendJson for handle(): the request was ours. */
function reply(res: Res, status: number, body: unknown): true {
  sendJson(res, status, body);
  return true;
}

class BodyTooLarge extends Error {
  constructor() { super(`body larger than ${MAX_BODY_BYTES} bytes`); }
}

/** Parse the JSON request body (or reuse the server's already-parsed one); rejects bodies over MAX_BODY_BYTES. */
async function readBody(req: Req): Promise<unknown> {
  // Already consumed and parsed by the server's body parser.
  if (req.body !== undefined && req.readableEnded) return req.body;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

const isObject = (b: unknown): b is Record<string, unknown> => !!b && typeof b === 'object' && !Array.isArray(b);
/** Finite number within [lo, hi]. */
const isNum = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

const BOOL_KEYS = ['rangeAuto', 'gainAuto', 'contrastAuto', 'noiseFilterAuto'] as const;
const PCT_KEYS = ['gain', 'contrast', 'noiseFilter'] as const;
const CM_KEYS = ['rangeShallowCm', 'rangeDeepCm'] as const;
const CHANNEL_KEYS: ReadonlySet<string> = new Set([...BOOL_KEYS, ...PCT_KEYS, ...CM_KEYS]);

/** Validated channel patch, or an error string. */
export function parseChannelPatch(body: unknown): ChannelPatch | string {
  if (!isObject(body)) return 'expected a JSON object';
  for (const k of Object.keys(body)) if (!CHANNEL_KEYS.has(k)) return `unknown field ${k}`;
  const out: ChannelPatch = {};
  for (const k of BOOL_KEYS) {
    if (!(k in body)) continue;
    const v = body[k];
    if (typeof v !== 'boolean') return `${k} must be boolean`;
    out[k] = v;
  }
  for (const k of PCT_KEYS) {
    if (!(k in body)) continue;
    const v = body[k];
    if (!isNum(v, 0, 100)) return `${k} must be 0..100`;
    out[k] = Math.round(v);
  }
  for (const k of CM_KEYS) {
    if (!(k in body)) continue;
    const v = body[k];
    if (!isNum(v, 0, MAX_RANGE_CM)) return `${k} must be 0..${MAX_RANGE_CM} cm`;
    out[k] = Math.round(v);
  }
  if (out.rangeShallowCm !== undefined && out.rangeDeepCm !== undefined && out.rangeDeepCm - out.rangeShallowCm < MIN_RANGE_WINDOW_CM) {
    return `rangeShallowCm must be less than rangeDeepCm by at least ${MIN_RANGE_WINDOW_CM} cm`;
  }
  return Object.keys(out).length ? out : 'empty patch';
}

const SYSTEM_KEYS: ReadonlySet<string> = new Set(['transducerOffsetCm', 'simulator']);

/** Validated system patch, or an error string. */
export function parseSystemPatch(body: unknown): SystemPatch | string {
  if (!isObject(body)) return 'expected a JSON object';
  for (const k of Object.keys(body)) if (!SYSTEM_KEYS.has(k)) return `unknown field ${k}`;
  const out: SystemPatch = {};
  if ('simulator' in body) {
    const v = body.simulator;
    if (typeof v !== 'boolean') return 'simulator must be boolean';
    out.simulator = v;
  }
  if ('transducerOffsetCm' in body) {
    const v = body.transducerOffsetCm;
    if (!isNum(v, -MAX_TRANSDUCER_OFFSET_CM, MAX_TRANSDUCER_OFFSET_CM)) return `transducerOffsetCm must be -${MAX_TRANSDUCER_OFFSET_CM}..${MAX_TRANSDUCER_OFFSET_CM}`;
    out.transducerOffsetCm = Math.round(v);
  }
  return Object.keys(out).length ? out : 'empty patch';
}

/** Channel named in an `/api/channel/<name>` path, or null for any other path. */
function channelRoute(path: string): ChannelName | null {
  const m = /^\/api\/channel\/([^/]+)$/.exec(path);
  const ch = m?.[1];
  return isChannelName(ch) ? ch : null;
}

/** SSE frame for already serialised data. */
const rawFrame = (event: string, json: string): string => `event: ${event}\ndata: ${json}\n\n`;
/** One SSE frame. */
const frame = (event: string, data: unknown): string => rawFrame(event, JSON.stringify(data));
const LIVE_FRAME = frame('live', null);

/**
 * Frames of the newest backlog columns that fit in `maxBytes`, oldest first, both channels
 * interleaved by time so the viewer rebuilds history in order. Each channel's history is
 * already in time order: a merge from the newest end stops at the budget instead of sorting
 * the whole history.
 */
export function backlogFrames(engine: Pick<Engine, 'history'>, maxBytes = MAX_BACKLOG_BYTES): string[] {
  const a = engine.history('sonar'), b = engine.history('downvision');
  let i = a.length - 1, j = b.length - 1;
  const out: string[] = [];
  let bytes = 0;
  while (i >= 0 || j >= 0) {
    // Newest first; on equal times DownVision, so the forward order puts sonar first.
    const e: HistoryEntry = j < 0 || (i >= 0 && a[i].t > b[j].t) ? a[i--] : b[j--];
    const f = rawFrame('col', e.json);
    bytes += f.length; // JSON of a column is ASCII: one byte per char
    if (bytes > maxBytes) break;
    out.push(f);
  }
  return out.reverse();
}

/** One connected event stream. */
interface Client {
  res: Res;
  /** Signal K readonly principal: every state it gets says canControl false. */
  readonly: boolean;
  /** Live frames held back while the backlog drains, so columns stay in order; null once live. */
  queue: string[] | null;
  /** Bytes in `queue`. */
  queued: number;
  ping: NodeJS.Timeout | null;
}

export interface ApiOptions {
  /** Where failures are reported (a handler that threw, a stream that failed). */
  error?: (msg: string) => void;
}

export class Api {
  #engine: () => Engine | null;
  #clients = new Map<Res, Client>();
  #unsub: (() => void) | null = null;
  #bound: Engine | null = null;
  #display: DisplayStore;
  #vessel: VesselStore;
  #error: (msg: string) => void;

  /**
   * `engine` is a getter so the plugin can swap engines on restart; `display` keeps the
   * viewers' units and `vessel` the waterline-to-transducer distance.
   */
  constructor(engine: () => Engine | null, display = new DisplayStore(), vessel = new VesselStore(), opts: ApiOptions = {}) {
    this.#engine = engine;
    this.#display = display;
    this.#vessel = vessel;
    this.#error = opts.error ?? (() => {});
  }

  /** Route a request whose path is relative to the plugin root. Returns false when not ours. */
  async handle(req: Req, res: Res, path: string): Promise<boolean> {
    const method = req.method ?? 'GET';
    if (method === 'GET') {
      switch (path) {
        case '/api/state': {
          const engine = this.#engine();
          return engine ? reply(res, 200, this.#stateFor(engine, isReadonly(req))) : reply(res, 503, { error: 'plugin not running' });
        }
        case '/api/display': return reply(res, 200, this.#display.get());
        case '/api/vessel': return reply(res, 200, this.#vessel.get());
        case '/api/stream':
          if (this.#clients.size >= MAX_STREAMS) return reply(res, 503, { error: 'too many viewers' });
          this.#stream(req, res);
          return true;
        default: return false;
      }
    }
    const channel = channelRoute(path);
    if (method !== 'POST' || (!channel && path !== '/api/system' && path !== '/api/display' && path !== '/api/vessel')) return false;
    // Servers without per-route plugin access let a readonly user reach the POSTs.
    if (isReadonly(req)) return reply(res, 403, { error: 'read-only access' });
    // JSON only: a cross-site form or text/plain POST (no CORS preflight) must not reach the sonar.
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) {
      return reply(res, 415, { error: 'Content-Type must be application/json' });
    }
    // Declared size first, so an oversized body is refused in both the streaming and the pre-parsed mode.
    if (Number(req.headers['content-length']) > MAX_BODY_BYTES) return reply(res, 413, { error: `body larger than ${MAX_BODY_BYTES} bytes` });
    let body: unknown;
    try {
      body = await readBody(req);
    } catch (e) {
      if (e instanceof BodyTooLarge) return reply(res, 413, { error: e.message });
      return reply(res, 400, { error: e instanceof SyntaxError ? 'invalid JSON' : errorMessage(e) });
    }
    try {
      if (path === '/api/display') {
        // Display units belong to the viewers, not the sonar: kept even while the plugin is stopped.
        const patch = parseDisplayPatch(body);
        if (typeof patch === 'string') return reply(res, 400, { error: patch });
        const d = this.#display.set(patch);
        this.#broadcast('display', d);
        return reply(res, 200, d);
      }
      if (path === '/api/vessel') {
        // Kept while the plugin is stopped too; a running engine republishes depth with it.
        const patch = parseVesselPatch(body);
        if (typeof patch === 'string') return reply(res, 400, { error: patch });
        const v = this.#vessel.set(patch);
        this.#engine()?.vesselChanged();
        this.#broadcast('vessel', v);
        return reply(res, 200, v);
      }
      const engine = this.#engine(); // read after the body: the plugin may have restarted meanwhile
      if (!engine) return reply(res, 503, { error: 'plugin not running' });
      let err: string | null;
      if (channel) {
        const patch = parseChannelPatch(body);
        if (typeof patch === 'string') return reply(res, 400, { error: patch });
        err = engine.setChannel(channel, patch);
      } else {
        const patch = parseSystemPatch(body);
        if (typeof patch === 'string') return reply(res, 400, { error: patch });
        err = engine.setSystem(patch);
      }
      return err ? reply(res, 409, { error: err }) : reply(res, 200, engine.state());
    } catch (e) {
      this.#error(`${method} ${path}: ${errorMessage(e)}`);
      return reply(res, 500, { error: 'internal error' });
    }
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
    /** Forward each new echogram column, serialised once by the engine, to every viewer. */
    const onCol = (_c: unknown, json: string) => this.#broadcastFrame(rawFrame('col', json));
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
    for (const c of [...this.#clients.values()]) {
      this.#forget(c);
      c.res.end();
    }
  }

  /** Number of connected event streams. */
  get streams(): number { return this.#clients.size; }

  /** The engine's state as this viewer may see it. */
  #stateFor(engine: Engine, readonly: boolean): WifishState {
    const s = engine.state();
    return readonly ? { ...s, canControl: false } : s;
  }

  /**
   * Open an SSE stream: display units, current state, vessel settings, the column backlog
   * (newest MAX_BACKLOG_BYTES, written as the client takes it), live events that arrived
   * meanwhile, a 'live' marker, then live events and pings.
   */
  #stream(req: Req, res: Res): void {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const client: Client = { res, readonly: isReadonly(req), queue: [], queued: 0, ping: null };
    this.#clients.set(res, client);
    // The response closes when the viewer goes away or the stream ends ('close' on the request
    // can also mean only that its body was read).
    res.on('close', () => this.#forget(client));
    // An 'error' with no listener would take the server down; the stream is simply dropped.
    res.on('error', (e) => { this.#error(`event stream: ${errorMessage(e)}`); this.#drop(client); });
    const engine = this.#engine();
    const head = [
      'retry: 2000\n\n',
      frame('display', this.#display.get()),
      frame('state', engine ? this.#stateFor(engine, client.readonly) : null),
      frame('vessel', this.#vessel.get()),
      ...(engine ? backlogFrames(engine) : []),
    ];
    this.#open(client, head).catch((e) => {
      this.#error(`event stream: ${errorMessage(e)}`);
      this.#drop(client);
    });
  }

  /** Write the opening frames with backpressure, then what queued up meanwhile, then go live. */
  async #open(client: Client, head: string[]): Promise<void> {
    if (!(await this.#drain(client, head))) return;
    while (client.queue && client.queue.length) {
      const q = client.queue;
      client.queue = [];
      client.queued = 0;
      if (!(await this.#drain(client, q))) return;
    }
    client.queue = null;
    client.res.write(LIVE_FRAME);
    client.res.flush?.();
    client.ping = setInterval(() => this.#ping(client), PING_MS);
  }

  /** Write frames one by one, waiting for 'drain' when the socket is full. False once the viewer is gone. */
  async #drain(client: Client, frames: string[]): Promise<boolean> {
    const { res } = client;
    for (const f of frames) {
      if (!this.#alive(client)) return false;
      if (!res.write(f)) {
        res.flush?.();
        await new Promise<void>((resolve) => {
          const once = () => { res.off('drain', once); res.off('close', once); res.off('error', once); resolve(); };
          res.on('drain', once);
          res.on('close', once);
          res.on('error', once);
        });
      }
    }
    res.flush?.(); // compression middleware buffers otherwise
    return this.#alive(client);
  }

  /** Still registered and writable. */
  #alive(client: Client): boolean {
    return this.#clients.has(client.res) && !client.res.destroyed && !client.res.writableEnded;
  }

  /** Keepalive comment every PING_MS; a viewer that is gone or has stopped reading is dropped instead. */
  #ping(client: Client): void {
    if (!this.#alive(client)) return this.#forget(client);
    if (client.res.writableLength > MAX_UNREAD_BYTES) return this.#drop(client);
    client.res.write(': ping\n\n');
    client.res.flush?.();
  }

  /** Stop pinging and forget the viewer. */
  #forget(client: Client): void {
    if (client.ping) clearInterval(client.ping);
    client.ping = null;
    this.#clients.delete(client.res);
  }

  /** Forget the viewer and cut its connection (it reconnects after `retry` and gets a fresh backlog). */
  #drop(client: Client): void {
    this.#forget(client);
    client.res.destroy();
  }

  /** Send an event to every viewer, dropping any whose unread output exceeds its budget. */
  #broadcast(event: string, data: unknown): void {
    if (!this.#clients.size) return;
    /** The same state for readonly viewers, built once if any needs it. */
    let ro: string | null = null;
    const readonly = event === 'state' && data ? () => (ro ??= frame('state', { ...(data as WifishState), canControl: false })) : undefined;
    this.#broadcastFrame(frame(event, data), readonly);
  }

  /** Send a frame to every viewer (`readonly()` instead to readonly viewers, when given). */
  #broadcastFrame(f: string, readonly?: () => string): void {
    if (!this.#clients.size) return;
    for (const c of this.#clients.values()) { // deleting the current entry while iterating a Map is safe
      if (!this.#alive(c)) { this.#forget(c); continue; }
      // A viewer that stopped reading (stalled proxy, suspended tab) would buffer forever.
      if (c.res.writableLength + c.queued > MAX_UNREAD_BYTES) { this.#drop(c); continue; }
      const out = c.readonly && readonly ? readonly() : f;
      if (c.queue) {
        c.queue.push(out);
        c.queued += out.length;
        continue;
      }
      c.res.write(out);
      c.res.flush?.();
    }
  }
}
