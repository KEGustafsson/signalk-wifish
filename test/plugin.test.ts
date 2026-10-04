import { describe, test, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { plugin, READONLY_GETS, READWRITE_POSTS, type AccessLevel, type Router, type ServerApp } from '../src/plugin';
import { FakeRes, bottomMsg, captureFile, req as mkReq, until } from './helpers';

// The real device transport binds the discovery port; here a constructor that fails on demand stands in.
vi.mock('../src/device', () => ({
  DeviceTransport: class extends EventEmitter {
    kind = 'device'; canSend = true;
    constructor(opts: { iface?: string }) {
      super();
      if (opts.iface === 'throw') throw new Error('no such interface');
    }
    start() { this.emit('link', 'searching', 'Looking'); }
    stop() { this.emit('link', 'offline', 'stopped'); }
    send() {}
  },
}));

type Handler = (req: Record<string, unknown>, res: FakeRes, next: (e?: unknown) => void) => void;
/** A plugin with recording app callbacks. */
function make(extra: Partial<ServerApp> = {}) {
  const statuses: string[] = [];
  const errors: string[] = [];
  const debugs: string[] = [];
  const app: ServerApp = {
    handleMessage: () => {},
    setPluginStatus: (m) => statuses.push(m),
    setPluginError: (m) => statuses.push(`ERR ${m}`),
    debug: (m) => debugs.push(String(m)),
    error: (m) => errors.push(String(m)),
    ...extra,
  };
  const p = plugin(app);
  let handler: Handler | null = null;
  p.registerWithRouter({ use: (fn) => { handler = fn as unknown as Handler; } });
  /** Run the catch-all handler and wait for it to answer or call next. */
  const call = (req: Record<string, unknown>) => new Promise<{ res: FakeRes; next: unknown[] | null }>((resolve) => {
    const res = new FakeRes();
    const finish = (next: unknown[] | null) => resolve({ res, next });
    res.once('close', () => finish(null));
    handler!(mkReq(req), res, (...a: unknown[]) => finish(a));
  });
  return { p, statuses, errors, debugs, call, handler: () => handler! };
}


let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
  vi.useRealTimers();
});

describe('registerWithRouter', () => {
  test('with access(): GETs for readonly, POSTs for readwrite, no catch-all', () => {
    const { p } = make();
    const registered: { level: AccessLevel; method: string; path: string }[] = [];
    const handlers = new Map<string, Handler>();
    const use = vi.fn();
    const router: Router = {
      use,
      access: (level) => {
        const reg = (method: string) => (path: string, fn: unknown) => {
          registered.push({ level, method, path });
          handlers.set(`${method} ${path}`, fn as Handler);
          return reg;
        };
        return { get: reg('GET'), post: reg('POST') };
      },
    };
    p.registerWithRouter(router);
    expect(use).not.toHaveBeenCalled();
    expect(registered.filter((r) => r.level === 'readonly').map((r) => `${r.method} ${r.path}`)).toEqual(READONLY_GETS.map((p) => `GET ${p}`));
    expect(registered.filter((r) => r.level === 'readwrite').map((r) => `${r.method} ${r.path}`)).toEqual(READWRITE_POSTS.map((p) => `POST ${p}`));
    expect(registered.map((r) => r.path)).toContain('/api/channel/:channel');
    expect(READONLY_GETS).toContain('/api/stream');
    expect(READWRITE_POSTS).not.toContain('/api/state');
  });

  test('access() handlers delegate to the API with the matched path', async () => {
    const { p } = make();
    const handlers = new Map<string, Handler>();
    p.registerWithRouter({
      use: () => {},
      access: () => {
        const reg = (method: string) => (path: string, fn: unknown) => { handlers.set(`${method} ${path}`, fn as Handler); return reg; };
        return { get: reg('GET'), post: reg('POST') };
      },
    });
    const run = (key: string, req: Record<string, unknown>) => new Promise<{ res: FakeRes; next: unknown[] | null }>((resolve) => {
      const res = new FakeRes();
      res.once('close', () => resolve({ res, next: null }));
      handlers.get(key)!(mkReq({ method: key.split(' ')[0], ...req }), res, (...a: unknown[]) => resolve({ res, next: a }));
    });
    // Fixed routes need no req.path at all.
    expect((await run('GET /api/state', {})).res.statusCode).toBe(503);
    expect((await run('GET /api/display', {})).res.body).toBe('{}');
    // The parameterised route takes the channel from the request path; an unknown one falls through.
    const bogus = await run('POST /api/channel/:channel', { path: '/api/channel/bogus', headers: { 'content-type': 'application/json' }, body: { gain: 1 }, readableEnded: true });
    expect(bogus.next).toEqual([]);
    const sonar = await run('POST /api/channel/:channel', { path: '/api/channel/sonar', headers: { 'content-type': 'application/json' }, body: { gain: 1 }, readableEnded: true });
    expect(sonar.res.statusCode).toBe(503); // ours, but no engine
  });

  test('without access() one catch-all is mounted; unknown paths go to next()', async () => {
    const { call } = make();
    const miss = await call({ path: '/api/nothing' });
    expect(miss.next).toEqual([]);
    expect(miss.res.writableEnded).toBe(false);
    const hit = await call({ path: '/api/state' });
    expect(hit.next).toBeNull();
    expect(hit.res.statusCode).toBe(503);
    const noPath = await call({ url: '/api/display' }); // old servers: no req.path
    expect(noPath.res.body).toBe('{}');
  });

  test('an unexpected failure answers a plain 500 and is logged, never next(err)', async () => {
    const { call, errors } = make();
    // No headers object at all: the handler throws before answering.
    const r = await call({ method: 'POST', path: '/api/system', headers: undefined });
    expect(r.next).toBeNull();
    expect(r.res.statusCode).toBe(500);
    expect(r.res.headers['content-type']).toBe('application/json');
    expect(JSON.parse(r.res.body)).toEqual({ error: 'internal error' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^POST \/api\/system: /);
    // Headers already sent: the response is just ended.
    const { handler } = make();
    const sent = await new Promise<FakeRes>((resolve) => {
      const res = new FakeRes();
      res.headersSent = true;
      res.statusCode = 200;
      res.once('close', () => resolve(res));
      handler()(mkReq({ method: 'POST', path: '/api/system', headers: undefined }), res, () => resolve(res));
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.writableEnded).toBe(true);
  });
});

describe('start / stop', () => {
  test('restarts with changed options leave no timers behind; stop before start is fine', async () => {
    vi.useFakeTimers();
    const { p, statuses } = make();
    cleanup.push(() => p.stop());
    expect(() => p.stop()).not.toThrow();
    p.start({ source: 'demo' });
    vi.advanceTimersByTime(1500);
    expect(statuses.at(-1)).toBe('Demo sonar');
    const timers = vi.getTimerCount();
    expect(timers).toBeGreaterThan(0);
    p.start({ source: 'demo', demoModel: 'wifish' }); // without stop(): the first engine must go away
    vi.advanceTimersByTime(1500);
    expect(vi.getTimerCount()).toBe(timers); // the same set of timers, not twice as many
    expect(statuses).toContain('stopped');
    p.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(statuses.filter((s) => s.startsWith('ERR'))).toEqual([]); // 'stopped' is a status, not an error
    p.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('start() with a replay but no file is a plugin error and no engine runs', async () => {
    const { p, statuses, call } = make();
    cleanup.push(() => p.stop());
    p.start({ source: 'replay', replayFile: '  ' });
    expect(statuses).toEqual(['ERR Replay file not set (Data source = replay)']);
    expect((await call({ path: '/api/state' })).res.statusCode).toBe(503);
  });

  test('a relative replay path is refused instead of resolved against the cwd', async () => {
    const { p, statuses, call } = make();
    cleanup.push(() => p.stop());
    p.start({ source: 'replay', replayFile: 'captures/x.bin' });
    expect(statuses).toEqual(['ERR Replay file must be an absolute path: captures/x.bin']);
    expect((await call({ path: '/api/state' })).res.statusCode).toBe(503);
  });

  test('link status maps to plugin status, offline to a plugin error except after stop', async () => {
    const file = captureFile([bottomMsg(900)]);
    const dir = path.dirname(file);
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { p, statuses } = make();
    cleanup.push(() => p.stop());
    p.start({ source: 'replay', replayFile: file });
    expect(statuses).toEqual([`Loading ${file}`]);
    await until(() => statuses.includes(`Replaying ${file}`));
    p.stop();
    expect(statuses.at(-1)).toBe('stopped');
    expect(statuses.some((s) => s.startsWith('ERR'))).toBe(false);

    p.start({ source: 'replay', replayFile: path.join(dir, 'missing.bin') });
    await until(() => statuses.some((s) => s.startsWith('ERR')));
    expect(statuses.at(-1)).toMatch(/^ERR Cannot replay .*missing\.bin/);
  });

  test('a transport that fails to construct is reported and leaves viewers with state null', async () => {
    const { p, statuses, errors, call, handler } = make();
    cleanup.push(() => p.stop());
    p.start({ source: 'demo' });
    // A viewer on the event stream (the catch-all never ends it).
    const streamRes = new FakeRes();
    handler()(mkReq({ path: '/api/stream' }), streamRes, () => {});
    for (let i = 0; i < 50 && !streamRes.events.includes('live'); i++) await Promise.resolve();
    expect(streamRes.events).toContain('live');
    expect(streamRes.chunks.find((c) => c.startsWith('event: state'))).toContain('"source":"demo"');

    p.start({ source: 'device', iface: 'throw' });
    expect(statuses.at(-1)).toBe('ERR Failed to start: no such interface');
    expect(errors).toContain('Failed to start: no such interface');
    expect(streamRes.chunks.at(-1)).toBe('event: state\ndata: null\n\n'); // api bound to no engine
    expect((await call({ path: '/api/state' })).res.statusCode).toBe(503);
  });

  test('the device transport gets the plugin error logger', async () => {
    const { p, statuses } = make();
    cleanup.push(() => p.stop());
    p.start({ source: 'device' });
    expect(statuses).toEqual(['Looking']);
    p.stop();
    expect(statuses.at(-1)).toBe('stopped');
  });
});
