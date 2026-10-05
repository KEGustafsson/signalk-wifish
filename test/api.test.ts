import { describe, test, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import { plugin } from '../src/plugin';
import {
  Api, DEMO_IDLE_MS, MAX_BACKLOG_BYTES, MAX_BODY_BYTES, MAX_STREAMS, MAX_UNREAD_BYTES, backlogFrames, parseChannelPatch, parseSystemPatch,
} from '../src/api';
import type { Engine, HistoryEntry } from '../src/engine';
import type { Delta } from '../src/signalk';
import type { ColumnMessage, ChannelName } from '../src/shared/api';
import { FakeRes, bottomMsg, captureFile, req, sleep, tempDir, until } from './helpers';
import { DEPTH_UNITS, presetCm } from '../src/shared/units';

describe('patch validation', () => {
  test('every Shallow/Deep preset pair the Range dialog offers is accepted, in every unit', () => {
    // The dialog lets Deep be any preset deeper than Shallow; 5 ft and 6 ft are only 30 cm apart.
    for (const u of DEPTH_UNITS) {
      for (let i = 0; i < u.ranges.length; i++) {
        for (let j = i + 1; j < u.ranges.length; j++) {
          const patch = { rangeShallowCm: presetCm(u, i), rangeDeepCm: presetCm(u, j) };
          expect(parseChannelPatch(patch), `${u.ranges[i]}..${u.ranges[j]} ${u.symbol}`).toEqual(patch);
        }
      }
    }
  });

  test('channel patch', () => {
    expect(parseChannelPatch({ gain: 40.4, gainAuto: false })).toEqual({ gain: 40, gainAuto: false });
    expect(parseChannelPatch({ gain: 101 })).toMatch(/0..100/);
    expect(parseChannelPatch({ gainAuto: 'yes' })).toMatch(/boolean/);
    expect(parseChannelPatch({ rangeShallowCm: 500, rangeDeepCm: 400 })).toMatch(/less than/);
    expect(parseChannelPatch({ rangeShallowCm: 500, rangeDeepCm: 520 })).toMatch(/at least 30 cm/); // window too small
    expect(parseChannelPatch({ rangeShallowCm: 500, rangeDeepCm: 530 })).toEqual({ rangeShallowCm: 500, rangeDeepCm: 530 });
    expect(parseChannelPatch({ rangeDeepCm: 40_001 })).toMatch(/0..40000/);
    expect(parseChannelPatch({ rangeDeepCm: -1 })).toMatch(/0..40000/);
    expect(parseChannelPatch({ rangeDeepCm: 2000.4 })).toEqual({ rangeDeepCm: 2000 });
    expect(parseChannelPatch({ bogus: 1 })).toMatch(/unknown/);
    expect(parseChannelPatch({})).toMatch(/empty/);
    expect(parseChannelPatch([])).toMatch(/object/);
    expect(parseChannelPatch(null)).toMatch(/object/);
  });
  test('system patch', () => {
    expect(parseSystemPatch({ transducerOffsetCm: -30, simulator: true })).toEqual({ transducerOffsetCm: -30, simulator: true });
    expect(parseSystemPatch({ transducerOffsetCm: 400 })).toMatch(/-300..300/);
    expect(parseSystemPatch({ transducerOffsetCm: '1' })).toMatch(/-300..300/);
    expect(parseSystemPatch({ simulator: 1 })).toMatch(/boolean/);
    expect(parseSystemPatch({ depthUnit: 1 })).toMatch(/unknown/);
    expect(parseSystemPatch({})).toMatch(/empty/);
  });
});

type Next = (e?: unknown) => void;
type Mw = (req: http.IncomingMessage & { path?: string }, res: http.ServerResponse, next: Next) => void;

let server: http.Server | null = null;
let stop: (() => void) | null = null;
/** Close the test server at once: idle keep-alive connections would otherwise hold close() for seconds. */
async function closeServer(): Promise<void> {
  const s = server;
  server = null;
  if (!s) return;
  s.closeAllConnections();
  await new Promise<void>((r) => s.close(() => r()));
}
afterEach(async () => {
  stop?.();
  stop = null;
  await closeServer();
});

async function startPlugin(config: Record<string, unknown>, dataDir?: string) {
  const deltas: Delta[] = [];
  const statuses: string[] = [];
  const p = plugin({
    handleMessage: (_id, d) => deltas.push(d), setPluginStatus: (m) => statuses.push(m), setPluginError: (m) => statuses.push(`ERR ${m}`),
    getDataDirPath: dataDir ? () => dataDir : undefined,
  });
  let mw: Mw | null = null;
  p.registerWithRouter({ use: (fn: Mw) => { mw = fn; } });
  p.start(config);
  stop = () => p.stop();
  server = http.createServer((req, res) => {
    const r = req as http.IncomingMessage & { path?: string };
    r.path = new URL(req.url ?? '/', 'http://x').pathname;
    mw!(r, res, () => { res.statusCode = 404; res.end(); });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return { p, base, deltas, statuses };
}

const json = { 'content-type': 'application/json' };

describe('plugin HTTP API (demo source)', () => {
  test('state, settings and the event stream', async () => {
    const { base, deltas } = await startPlugin({ source: 'demo' });
    await until(() => deltas.length > 0); // the demo connects at once and sends a bottom record every 83 ms
    const state = await (await fetch(`${base}/api/state`)).json();
    expect(state).toMatchObject({ source: 'demo', link: 'connected', canControl: true });

    const r = await fetch(`${base}/api/channel/sonar`, { method: 'POST', headers: json, body: JSON.stringify({ gain: 77, gainAuto: false }) });
    expect(r.status).toBe(200);
    expect((await r.json()).channels.sonar).toMatchObject({ gain: 77, gainAuto: false });

    const bad = await fetch(`${base}/api/channel/sonar`, { method: 'POST', headers: json, body: '{"gain":900}' });
    expect(bad.status).toBe(400);
    const garbled = await fetch(`${base}/api/channel/sonar`, { method: 'POST', headers: json, body: '{"gain":' });
    expect(garbled.status).toBe(400);
    // A cross-site "simple request" (text/plain, no CORS preflight) must not reach the sonar.
    const plain = await fetch(`${base}/api/system`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"simulator":true}' });
    expect(plain.status).toBe(415);
    const sys = await fetch(`${base}/api/system`, { method: 'POST', headers: json, body: '{"simulator":true}' });
    expect((await sys.json()).system.simulator).toBe(true);
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);

    // SSE: state first, then the backlog, then "live".
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/stream`, { signal: ctrl.signal });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes('event: live')) {
      const { done, value } = await reader.read();
      if (done) throw new Error('stream ended before the backlog was sent');
      text += new TextDecoder().decode(value);
    }
    ctrl.abort();
    const events = [...text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    expect(events.slice(0, 3)).toEqual(['display', 'state', 'vessel']);
    // One read can carry "live" and the live columns that follow it (the demo pings at 12 Hz),
    // so check the order up to the first "live": only the backlog and the live events that were
    // queued while it drained (columns and states) come before it.
    const live = events.indexOf('live');
    expect(events.slice(3, live).every((e) => e === 'col' || e === 'state')).toBe(true);
  });

  test('refuses oversized bodies, unknown channels and POSTs to GET routes', async () => {
    const { base } = await startPlugin({ source: 'demo' });
    const big = await fetch(`${base}/api/channel/sonar`, { method: 'POST', headers: json, body: JSON.stringify({ gain: 1, pad: 'x'.repeat(MAX_BODY_BYTES) }) });
    expect(big.status).toBe(413);
    expect((await fetch(`${base}/api/channel/bogus`, { method: 'POST', headers: json, body: '{"gain":1}' })).status).toBe(404);
    expect((await fetch(`${base}/api/state`, { method: 'POST', headers: json, body: '{}' })).status).toBe(404);
    expect((await fetch(`${base}/api/stream`, { method: 'POST', headers: json, body: '{}' })).status).toBe(404);
  });

  test('display units are shared by all viewers and survive a restart', async () => {
    const dir = tempDir();
    let { base } = await startPlugin({ source: 'demo' }, dir);
    expect(await (await fetch(`${base}/api/display`)).json()).toEqual({});

    // A viewer listening on the stream gets the change another viewer makes.
    const ctrl = new AbortController();
    const reader = (await fetch(`${base}/api/stream`, { signal: ctrl.signal })).body!.getReader();
    const bad = await fetch(`${base}/api/display`, { method: 'POST', headers: json, body: '{"tempUnit":"K"}' });
    expect(bad.status).toBe(400);
    const r = await fetch(`${base}/api/display`, { method: 'POST', headers: json, body: '{"depthUnit":"ft","tempUnit":"F"}' });
    expect(await r.json()).toEqual({ depthUnit: 'ft', tempUnit: 'F' });
    const text = await readUntil(reader, /event: display\ndata: \{"depthUnit/);
    ctrl.abort();
    expect(text).toContain('event: display\ndata: {}\n\n');
    expect(text).toContain('event: display\ndata: {"depthUnit":"ft","tempUnit":"F"}');

    // Following the sonar's unit is a choice too (null), and the file outlives the plugin.
    await fetch(`${base}/api/display`, { method: 'POST', headers: json, body: '{"depthUnit":null}' });
    stop!();
    await closeServer();
    ({ base } = await startPlugin({ source: 'demo' }, dir));
    expect(await (await fetch(`${base}/api/display`)).json()).toEqual({ depthUnit: null, tempUnit: 'F' });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('vessel settings are shared by all viewers, survive a restart and reach Signal K', async () => {
    const dir = tempDir();
    let { base, deltas } = await startPlugin({ source: 'demo' }, dir);
    expect(await (await fetch(`${base}/api/vessel`)).json()).toEqual({});
    const ctrl = new AbortController();
    const reader = (await fetch(`${base}/api/stream`, { signal: ctrl.signal })).body!.getReader();
    expect((await fetch(`${base}/api/vessel`, { method: 'POST', headers: json, body: '{"surfaceToTransducerCm":500}' })).status).toBe(400);
    const r = await fetch(`${base}/api/vessel`, { method: 'POST', headers: json, body: '{"surfaceToTransducerCm":40}' });
    expect(await r.json()).toEqual({ surfaceToTransducerCm: 40 });
    const text = await readUntil(reader, /event: vessel\ndata: \{"surfaceToTransducerCm":40\}/);
    ctrl.abort();
    expect(text).toContain('event: vessel\ndata: {}');
    const published = () => deltas.flatMap((d) => d.updates[0].values);
    await until(() => published().some((v) => v.path === 'environment.depth.surfaceToTransducer' && v.value === 0.4));
    stop!();
    await closeServer();
    ({ base, deltas } = await startPlugin({ source: 'demo' }, dir));
    expect(await (await fetch(`${base}/api/vessel`)).json()).toEqual({ surfaceToTransducerCm: 40 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('replay without a file is a plugin error, not a silent demo', async () => {
    const { base, statuses } = await startPlugin({ source: 'replay' });
    expect(statuses).toEqual(['ERR Replay file not set (Data source = replay)']);
    expect((await fetch(`${base}/api/state`)).status).toBe(503);
  });

  test('replay of a missing file reports offline and refuses settings', async () => {
    const { base, statuses } = await startPlugin({ source: 'replay', replayFile: '/nonexistent/capture.bin' });
    await until(() => statuses.some((m) => m.startsWith('ERR'))); // the file is read asynchronously
    expect(statuses.find((m) => m.startsWith('ERR'))).toMatch(/Cannot replay \/nonexistent\/capture.bin/);
    const s = await (await fetch(`${base}/api/state`)).json();
    expect(s).toMatchObject({ source: 'replay', link: 'offline', canControl: false });
    const r = await fetch(`${base}/api/channel/sonar`, { method: 'POST', headers: json, body: '{"gain":1}' });
    expect(r.status).toBe(409);
  });

  test('a replay cannot be controlled: canControl false and 409 on settings', async () => {
    const file = captureFile([0, 100, 200].map((ts) => bottomMsg(1000 + ts)));
    const { base } = await startPlugin({ source: 'replay', replayFile: file });
    // Poll with one awaited request at a time: a fire-and-forget fetch still in flight when the
    // test server closes rejects unhandled (ECONNRESET on macOS) and fails the run.
    const state = async (): Promise<{ link: string; canControl: boolean }> => (await fetch(`${base}/api/state`)).json();
    const t0 = Date.now();
    let s = await state();
    while (s.link !== 'connected') {
      if (Date.now() - t0 > 3000) throw new Error(`replay never connected (link ${s.link})`);
      await sleep(10);
      s = await state();
    }
    expect(s.canControl).toBe(false);
    const r = await fetch(`${base}/api/system`, { method: 'POST', headers: json, body: '{"simulator":true}' });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/cannot be changed/);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});

describe('plugin lifecycle', () => {
  test('schema has defaults and start/stop never throw', async () => {
    const p = plugin({ handleMessage: () => {} });
    stop = () => p.stop();
    const schema = p.schema();
    expect(schema.type).toBe('object');
    expect(schema.properties.source.default).toBe('device');
    expect(schema.properties.source.enum).toEqual(['device', 'demo', 'replay']);
    expect(schema.properties.demoModel.enum).toEqual(['dragonfly', 'wifish']);
    expect(schema.properties.historyColumns).toMatchObject({ default: 1500, maximum: 20000 });
    // (The device source binds the real discovery port: covered by its own tests.)
    for (const cfg of [{}, { source: 'demo' }, { source: 'demo', demoModel: 'wifish' }, { source: 'replay', replayFile: 'relative.bin' }]) {
      expect(() => p.start(cfg as never)).not.toThrow();
      await sleep(20);
      expect(() => p.stop()).not.toThrow();
    }
    expect(() => p.stop()).not.toThrow();
  });

  test('demo viewers get a demo sonar of their own that publishes nothing to Signal K', async () => {
    // The configured source is offline, like a sonar that is switched off.
    const { base, deltas, statuses } = await startPlugin({ source: 'replay', replayFile: '/nonexistent/capture.bin' });
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/stream?demo=1`, { signal: ctrl.signal });
    const text = await readUntil(res.body!.getReader(), /event: col\n/);
    ctrl.abort();
    expect(text).toMatch(/event: state\ndata: \{[^\n]*"source":"demo"/);
    expect(text).toContain('event: sonar\ndata: {"link":"offline"}');
    const demo = await (await fetch(`${base}/api/state?demo=1`)).json();
    expect(demo).toMatchObject({ source: 'demo', link: 'connected', canControl: true });
    const r = await fetch(`${base}/api/channel/sonar?demo=1`, { method: 'POST', headers: json, body: JSON.stringify({ gain: 77, gainAuto: false }) });
    expect((await r.json()).channels.sonar).toMatchObject({ gain: 77, gainAuto: false });
    // The plugin's own engine is untouched: still the offline replay, settings refused.
    expect(await (await fetch(`${base}/api/state`)).json()).toMatchObject({ source: 'replay', link: 'offline' });
    expect((await fetch(`${base}/api/channel/sonar`, { method: 'POST', headers: json, body: '{"gain":50}' })).status).toBe(409);
    expect(deltas).toEqual([]);
    expect(statuses.every((m) => !/demo/i.test(m))).toBe(true);
  });

  test('API answers 503 while stopped', async () => {
    const { p, base } = await startPlugin({ source: 'demo' });
    p.stop();
    expect((await fetch(`${base}/api/state`)).status).toBe(503);
  });
});

// ---------------------------------------------------------------- Api with fakes

/** A POST whose JSON body the server already parsed (Signal K's body-parser). */
const parsed = (body: unknown, o: Record<string, unknown> = {}) => req({ method: 'POST', headers: json, body, readableEnded: true, ...o });
const READONLY = { skIsAuthenticated: true, skPrincipal: { identifier: 'guest', permissions: 'readonly' } };

type FakeEngine = EventEmitter & Pick<Engine, 'state' | 'history' | 'setChannel' | 'setSystem' | 'vesselChanged'>;
/** An engine stand-in; `cols` gives each channel's history as ColumnMessages. */
function fakeEngine(o: Partial<Omit<FakeEngine, 'history'>> & { cols?: (ch: ChannelName) => ColumnMessage[] } = {}): FakeEngine {
  const { cols = () => [], ...rest } = o;
  return Object.assign(new EventEmitter(), {
    state: () => ({ canControl: true }) as never, setChannel: () => null, setSystem: () => null, vesselChanged() {}, ...rest,
    history: (ch: ChannelName): HistoryEntry[] => cols(ch).map((c) => ({ t: c.t, json: JSON.stringify(c) })),
  });
}
const col = (ch: ChannelName, n: number, t: number, data = ''): ColumnMessage => ({ ch, n, t, startCm: 0, endCm: 1000, bottomCm: null, waterTempCentiC: null, data });
/** A new column from the engine, with its JSON as the engine sends it. */
const emitCol = (engine: EventEmitter, c: ColumnMessage) => engine.emit('column', c, JSON.stringify(c));
/** Read an event stream until its text matches `re`; fails if the stream ends first. */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, re: RegExp): Promise<string> {
  let text = '';
  while (!re.test(text)) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`stream ended before ${re}`);
    text += new TextDecoder().decode(value);
  }
  return text;
}
/** Wait (microtasks only, so fake timers don't matter) until the stream has gone live. */
async function live(r: FakeRes): Promise<void> {
  for (let i = 0; i < 100 && !r.events.includes('live'); i++) await Promise.resolve();
  if (!r.events.includes('live')) throw new Error('stream never went live');
}
const stream = (api: Api, r: FakeRes, o: Record<string, unknown> = {}) => api.handle(req(o) as never, r as never, '/api/stream');

afterEach(() => { vi.useRealTimers(); });

describe('Api request handling', () => {
  test('pre-parsed bodies: 200, 415 without JSON content type, 413 by Content-Length, 409 before settings arrive', async () => {
    const setChannel = vi.fn<Engine['setChannel']>(() => null);
    const api = new Api(() => fakeEngine({ setChannel }) as never);
    let r = new FakeRes();
    expect(await api.handle(parsed({ gain: 5 }) as never, r as never, '/api/channel/downvision')).toBe(true);
    expect(r.statusCode).toBe(200);
    expect(setChannel).toHaveBeenCalledWith('downvision', { gain: 5 });
    r = new FakeRes();
    await api.handle(parsed({ gain: 5 }, { headers: {} }) as never, r as never, '/api/channel/sonar');
    expect(r.statusCode).toBe(415);
    r = new FakeRes();
    await api.handle(parsed({ gain: 5 }, { headers: { ...json, 'content-length': String(MAX_BODY_BYTES + 1) } }) as never, r as never, '/api/channel/sonar');
    expect(r.statusCode).toBe(413);
    r = new FakeRes();
    await api.handle(parsed({ gain: 5 }, { headers: { ...json, 'content-length': String(MAX_BODY_BYTES) } }) as never, r as never, '/api/channel/sonar');
    expect(r.statusCode).toBe(200);
    setChannel.mockReturnValue('Channel settings not received from the sonar yet');
    r = new FakeRes();
    await api.handle(parsed({ gain: 5 }) as never, r as never, '/api/channel/sonar');
    expect(r.statusCode).toBe(409);
    expect(r.json.error).toMatch(/not received/);
  });

  test('streamed bodies: 413 past MAX_BODY_BYTES without a Content-Length, 400 for bad JSON', async () => {
    const api = new Api(() => fakeEngine() as never);
    const streamed = (...chunks: Buffer[]) => req({ method: 'POST', headers: json, [Symbol.asyncIterator]: async function* () { yield* chunks; } });
    let r = new FakeRes();
    await api.handle(streamed(Buffer.alloc(MAX_BODY_BYTES), Buffer.alloc(1)) as never, r as never, '/api/system');
    expect(r.statusCode).toBe(413);
    r = new FakeRes();
    await api.handle(streamed(Buffer.from('{"simulator":')) as never, r as never, '/api/system');
    expect(r.statusCode).toBe(400);
    expect(r.json.error).toBe('invalid JSON');
    r = new FakeRes();
    await api.handle(streamed(Buffer.from('{"simulator":true}')) as never, r as never, '/api/system');
    expect(r.statusCode).toBe(200);
  });

  test('unknown channels, other methods and other paths are not ours', async () => {
    const api = new Api(() => fakeEngine() as never);
    expect(await api.handle(parsed({ gain: 1 }) as never, new FakeRes() as never, '/api/channel/bogus')).toBe(false);
    expect(await api.handle(parsed({ gain: 1 }) as never, new FakeRes() as never, '/api/channel/sonar/extra')).toBe(false);
    expect(await api.handle(parsed({}) as never, new FakeRes() as never, '/api/state')).toBe(false);
    expect(await api.handle(req({ method: 'DELETE' }) as never, new FakeRes() as never, '/api/system')).toBe(false);
    expect(await api.handle(req() as never, new FakeRes() as never, '/api/other')).toBe(false);
  });

  test('a readonly principal gets 403 on POST and canControl false everywhere', async () => {
    const setChannel = vi.fn<Engine['setChannel']>(() => null);
    const engine = fakeEngine({ setChannel });
    const api = new Api(() => engine as never);
    api.bind();
    let r = new FakeRes();
    await api.handle(parsed({ gain: 5 }, READONLY) as never, r as never, '/api/channel/sonar');
    expect(r.statusCode).toBe(403);
    expect(setChannel).not.toHaveBeenCalled();
    r = new FakeRes();
    await api.handle(parsed({ tempUnit: 'F' }, READONLY) as never, r as never, '/api/display');
    expect(r.statusCode).toBe(403);
    r = new FakeRes();
    await api.handle(req(READONLY) as never, r as never, '/api/state');
    expect(r.json.canControl).toBe(false);
    r = new FakeRes();
    await api.handle(req() as never, r as never, '/api/state');
    expect(r.json.canControl).toBe(true);
    // An authenticated readwrite user is not readonly; an unauthenticated request (no security) is not either.
    r = new FakeRes();
    await api.handle(parsed({ gain: 5 }, { skIsAuthenticated: true, skPrincipal: { permissions: 'readwrite' } }) as never, r as never, '/api/channel/sonar');
    expect(r.statusCode).toBe(200);

    const ro = new FakeRes(), rw = new FakeRes();
    await stream(api, ro, READONLY);
    await stream(api, rw);
    await live(ro); await live(rw);
    expect(ro.chunks[2]).toBe('event: state\ndata: {"canControl":false}\n\n');
    expect(rw.chunks[2]).toBe('event: state\ndata: {"canControl":true}\n\n');
    engine.emit('state', { canControl: true, link: 'connected' });
    expect(ro.chunks.at(-1)).toBe('event: state\ndata: {"canControl":false,"link":"connected"}\n\n');
    expect(rw.chunks.at(-1)).toBe('event: state\ndata: {"canControl":true,"link":"connected"}\n\n');
    api.close();
  });

  test('errors in a handler answer 500 and are logged', async () => {
    const errors: string[] = [];
    const api = new Api(() => fakeEngine({ setSystem: () => { throw new Error('kaboom'); } }) as never, undefined, undefined, { error: (m) => errors.push(m) });
    const r = new FakeRes();
    await api.handle(parsed({ simulator: true }) as never, r as never, '/api/system');
    expect(r.statusCode).toBe(500);
    expect(errors).toEqual(['POST /api/system: kaboom']);
  });
});

describe('SSE streams', () => {
  test('the backlog is interleaved by time across both channels, then live', async () => {
    const sonar = [col('sonar', 1, 10), col('sonar', 2, 30)], downvision = [col('downvision', 1, 20)];
    const api = new Api(() => fakeEngine({ cols: (ch) => (ch === 'sonar' ? sonar : downvision) }) as never);
    const r = new FakeRes();
    await stream(api, r);
    await live(r);
    expect(r.events).toEqual(['display', 'state', 'vessel', 'col', 'col', 'col', 'live']);
    expect(r.cols.map((c) => [c.ch, c.n])).toEqual([['sonar', 1], ['downvision', 1], ['sonar', 2]]);
    api.close();
    expect(api.streams).toBe(0);
  });

  test('the backlog is capped by bytes, keeping the newest columns', async () => {
    const cols = Array.from({ length: 5 }, (_, i) => col('sonar', i + 1, i + 1, 'x'.repeat(300)));
    const engine = fakeEngine({ cols: (ch) => (ch === 'sonar' ? cols : []) });
    const frames = backlogFrames(engine as never, 1000);
    expect(frames).toHaveLength(2);
    expect(frames.map((f) => JSON.parse(f.slice('event: col\ndata: '.length)).n)).toEqual([4, 5]);
    expect(frames.join('').length).toBeLessThanOrEqual(1000);
    expect(backlogFrames(engine as never, 10)).toEqual([]);

    // The stream applies MAX_BACKLOG_BYTES: 30 columns of ~100 KB cannot all go.
    const big = Array.from({ length: 30 }, (_, i) => col('downvision', i + 1, i + 1, 'y'.repeat(100_000)));
    const api = new Api(() => fakeEngine({ cols: (ch) => (ch === 'downvision' ? big : []) }) as never);
    const r = new FakeRes();
    await stream(api, r);
    await live(r);
    const ns = r.cols.map((c) => c.n);
    expect(ns.length).toBeGreaterThan(10);
    expect(ns.length).toBeLessThan(30);
    expect(ns.at(-1)).toBe(30);
    expect(ns[0]).toBe(31 - ns.length);
    expect(r.cols.reduce((n, c) => n + JSON.stringify(c).length, 0)).toBeLessThanOrEqual(MAX_BACKLOG_BYTES);
    api.close();
  });

  test('columns are sent as the engine serialised them, never serialised again per viewer', async () => {
    const engine = fakeEngine({ cols: (ch) => (ch === 'sonar' ? [col('sonar', 1, 1, 'abc')] : []) });
    const api = new Api(() => engine as never);
    api.bind();
    const viewers = [new FakeRes(), new FakeRes(), new FakeRes()];
    for (const r of viewers) { await stream(api, r); await live(r); }
    const stringify = vi.spyOn(JSON, 'stringify');
    const liveCol = col('sonar', 2, 2, 'def');
    engine.emit('column', liveCol, '{"the":"engine\'s JSON"}');
    expect(stringify).not.toHaveBeenCalled();
    stringify.mockRestore();
    for (const r of viewers) {
      expect(r.cols[0].data).toBe('abc'); // the backlog column
      expect(r.chunks.at(-1)).toBe('event: col\ndata: {"the":"engine\'s JSON"}\n\n');
    }
    api.close();
  });

  test('the backlog merge keeps time order, sonar first on equal times', () => {
    const engine = fakeEngine({ cols: (ch) => (ch === 'sonar' ? [col('sonar', 1, 5), col('sonar', 2, 7), col('sonar', 3, 9)] : [col('downvision', 1, 5), col('downvision', 2, 8)]) });
    const order = backlogFrames(engine as never).map((f) => JSON.parse(f.slice('event: col\ndata: '.length))).map((c: ColumnMessage) => `${c.ch[0]}${c.n}`);
    expect(order).toEqual(['s1', 'd1', 's2', 'd2', 's3']);
  });

  test('backlog writes honour backpressure and live columns wait their turn', async () => {
    const engine = fakeEngine({ cols: (ch) => (ch === 'sonar' ? [col('sonar', 1, 1), col('sonar', 2, 2)] : []) });
    const api = new Api(() => engine as never);
    api.bind();
    const r = new FakeRes();
    r.full = true; // the first write fills the socket
    await stream(api, r);
    await Promise.resolve();
    expect(r.chunks).toEqual(['retry: 2000\n\n']); // waiting for 'drain'
    emitCol(engine, col('sonar', 3, 3)); // arrives while the backlog is pending
    engine.emit('state', { canControl: true });
    expect(r.chunks).toHaveLength(1);
    r.full = false;
    r.emit('drain');
    await live(r);
    expect(r.events).toEqual(['display', 'state', 'vessel', 'col', 'col', 'col', 'state', 'live']);
    expect(r.cols.map((c) => c.n)).toEqual([1, 2, 3]);
    emitCol(engine, col('sonar', 4, 4));
    expect(r.events.at(-1)).toBe('col');
    api.close();
  });

  test('a viewer that closes while its backlog drains is forgotten without error', async () => {
    const errors: string[] = [];
    const api = new Api(() => fakeEngine({ cols: () => [col('sonar', 1, 1)] }) as never, undefined, undefined, { error: (m) => errors.push(m) });
    const r = new FakeRes();
    r.full = true;
    await stream(api, r);
    expect(api.streams).toBe(1);
    r.destroy();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(api.streams).toBe(0);
    expect(r.events).not.toContain('live');
    expect(errors).toEqual([]);
  });

  test('drops a viewer that stops reading, keeps one that reads', async () => {
    const engine = fakeEngine({ state: () => ({ link: 'connected' }) as never });
    const api = new Api(() => engine as never);
    api.bind();
    const slow = new FakeRes(), fast = new FakeRes();
    for (const r of [slow, fast]) { await stream(api, r); await live(r); }
    slow.writableLength = 2 * MAX_UNREAD_BYTES; // 8 MB of live data never drained
    fast.writableLength = 0;
    emitCol(engine, col('sonar', 1, 1));
    expect(slow.destroyed).toBe(true);
    expect(fast.destroyed).toBe(false);
    const before = slow.chunks.length;
    emitCol(engine, col('sonar', 2, 2));
    expect(slow.chunks.length).toBe(before);
    expect(fast.chunks.at(-1)).toMatch(/event: col/);
    api.close();
  });

  test('pings keep live viewers, skip dead responses and drop stalled ones', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const api = new Api(() => fakeEngine() as never);
    api.bind();
    const ok = new FakeRes(), dead = new FakeRes(), stalled = new FakeRes(), closed = new FakeRes();
    for (const r of [ok, dead, stalled, closed]) { await stream(api, r); await live(r); }
    expect(api.streams).toBe(4);
    dead.destroyed = true; // went away without a 'close' we saw
    stalled.writableLength = MAX_UNREAD_BYTES + 1;
    closed.destroy(); // normal close: ping interval cleared
    const written = { dead: dead.chunks.length, stalled: stalled.chunks.length, closed: closed.chunks.length };
    vi.advanceTimersByTime(15_000);
    expect(ok.chunks.at(-1)).toBe(': ping\n\n');
    expect(dead.chunks.length).toBe(written.dead);
    expect(stalled.destroyed).toBe(true);
    expect(stalled.chunks.length).toBe(written.stalled);
    expect(closed.chunks.length).toBe(written.closed);
    expect(api.streams).toBe(1);
    vi.advanceTimersByTime(15_000);
    expect(ok.chunks.filter((c) => c === ': ping\n\n')).toHaveLength(2);
    api.close();
    vi.advanceTimersByTime(15_000);
    expect(ok.chunks.filter((c) => c === ': ping\n\n')).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('refuses viewers beyond MAX_STREAMS', async () => {
    const api = new Api(() => fakeEngine() as never);
    const all = Array.from({ length: MAX_STREAMS }, () => new FakeRes());
    for (const r of all) await stream(api, r);
    const extra = new FakeRes();
    await stream(api, extra);
    expect(extra.statusCode).toBe(503);
    all[0].emit('close');
    const again = new FakeRes();
    await stream(api, again);
    expect(again.statusCode).toBe(200);
    api.close();
  });

  test('bind() to no engine sends state null; a new engine sends reset then its state', async () => {
    let engine: FakeEngine | null = fakeEngine();
    const api = new Api(() => engine as never);
    api.bind();
    const r = new FakeRes();
    await stream(api, r);
    await live(r);
    engine = null;
    api.bind();
    expect(r.chunks.at(-1)).toBe('event: state\ndata: null\n\n');
    engine = fakeEngine({ state: () => ({ canControl: false }) as never });
    api.bind();
    expect(r.events.slice(-2)).toEqual(['reset', 'state']);
    expect(r.chunks.at(-1)).toContain('"canControl":false');
    api.close();
  });
});

describe('demo engine', () => {
  type DemoFake = FakeEngine & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
  /** Engine stand-in with start/stop spies; `link` is its state's link. */
  const engineWith = (link: string, o: Partial<Omit<FakeEngine, 'history'>> = {}): DemoFake =>
    Object.assign(fakeEngine({ state: () => ({ link, canControl: true }) as never, ...o }), { start: vi.fn(), stop: vi.fn() });
  const DEMO = { url: '/api/stream?demo=1' };

  test('started for the first demo viewer, kept apart from the others, stopped DEMO_IDLE_MS after the last left', async () => {
    vi.useFakeTimers();
    const real = engineWith('searching');
    const demos: DemoFake[] = [];
    const api = new Api(() => real as never, undefined, undefined, { demo: () => { const e = engineWith('connected'); demos.push(e); return e as never; } });
    api.bind();
    const plain = new FakeRes();
    await stream(api, plain);
    expect(demos).toHaveLength(0); // nobody asked for the demo
    const a = new FakeRes(), b = new FakeRes();
    await stream(api, a, DEMO);
    await stream(api, b, DEMO);
    expect(demos).toHaveLength(1);
    expect(demos[0].start).toHaveBeenCalledOnce();
    expect(a.events.slice(0, 4)).toEqual(['display', 'state', 'vessel', 'sonar']);
    expect(a.chunks.find((c) => c.startsWith('event: sonar'))).toBe('event: sonar\ndata: {"link":"searching"}\n\n');

    // Each engine's columns and states reach only its own viewers; the real link reaches demo viewers.
    emitCol(demos[0], col('sonar', 1, 1));
    emitCol(real, col('sonar', 7, 1));
    real.emit('state', { link: 'connected' });
    real.emit('state', { link: 'connected', depthCm: 5 }); // same link: no second "sonar"
    expect(a.cols.map((c) => c.n)).toEqual([1]);
    expect(plain.cols.map((c) => c.n)).toEqual([7]);
    expect(a.chunks.filter((c) => c.startsWith('event: sonar')).at(-1)).toBe('event: sonar\ndata: {"link":"connected"}\n\n');
    expect(a.events.filter((e) => e === 'sonar')).toHaveLength(2);
    expect(plain.events).not.toContain('sonar');

    // Settings go to the engine the request names.
    const setChannel = vi.fn(() => null);
    Object.assign(demos[0], { setChannel });
    const r = new FakeRes();
    await api.handle(parsed({ gain: 10 }, { url: '/api/channel/sonar?demo=1' }) as never, r as never, '/api/channel/sonar');
    expect(r.statusCode).toBe(200);
    expect(setChannel).toHaveBeenCalledWith('sonar', { gain: 10 });

    // Last demo viewer gone: the demo runs on for DEMO_IDLE_MS; a viewer back in time keeps it.
    a.emit('close'); b.emit('close');
    vi.advanceTimersByTime(DEMO_IDLE_MS - 1);
    const c = new FakeRes();
    await stream(api, c, DEMO);
    vi.advanceTimersByTime(DEMO_IDLE_MS);
    expect(demos).toHaveLength(1);
    expect(demos[0].stop).not.toHaveBeenCalled();
    c.emit('close');
    vi.advanceTimersByTime(DEMO_IDLE_MS);
    expect(demos[0].stop).toHaveBeenCalledOnce();
    const s = new FakeRes();
    await api.handle(req({ url: '/api/state?demo=1' }) as never, s as never, '/api/state');
    expect(s.statusCode).toBe(503);
    api.close();
  });

  test('runs only while the plugin does: stopped with it, started again for the demo viewers still there', async () => {
    let real: DemoFake | null = engineWith('searching');
    const demos: DemoFake[] = [];
    const api = new Api(() => real as never, undefined, undefined, { demo: () => { const e = engineWith('connected'); demos.push(e); return e as never; } });
    api.bind();
    const a = new FakeRes();
    await stream(api, a, DEMO);
    await live(a);
    real = null;
    api.bind();
    expect(demos[0].stop).toHaveBeenCalledOnce();
    expect(a.chunks.slice(-2)).toEqual(['event: sonar\ndata: {"link":null}\n\n', 'event: state\ndata: null\n\n']);
    // A viewer joining meanwhile gets no demo.
    const b = new FakeRes();
    await stream(api, b, DEMO);
    expect(b.chunks.find((c) => c.startsWith('event: state'))).toBe('event: state\ndata: null\n\n');
    expect(demos).toHaveLength(1);
    real = engineWith('searching');
    api.bind();
    expect(demos).toHaveLength(2);
    expect(demos[1].start).toHaveBeenCalledOnce();
    expect(a.events.slice(-3)).toEqual(['sonar', 'reset', 'state']);
    expect(a.chunks.at(-1)).toContain('"link":"connected"');
    api.close();
    expect(demos[1].stop).toHaveBeenCalledOnce();
  });

  test('without a demo factory demo viewers get state null and demo settings 503', async () => {
    const api = new Api(() => fakeEngine() as never);
    api.bind();
    const a = new FakeRes();
    await stream(api, a, DEMO);
    expect(a.chunks.find((c) => c.startsWith('event: state'))).toBe('event: state\ndata: null\n\n');
    const r = new FakeRes();
    await api.handle(parsed({ gain: 10 }, { url: '/api/channel/sonar?demo=1' }) as never, r as never, '/api/channel/sonar');
    expect(r.statusCode).toBe(503);
    expect(r.json).toEqual({ error: 'demo not running' });
    api.close();
  });

  test('a demo whose factory throws is logged, not thrown', async () => {
    const error = vi.fn();
    const api = new Api(() => fakeEngine() as never, undefined, undefined, { error, demo: () => { throw new Error('nope'); } });
    api.bind();
    const a = new FakeRes();
    await stream(api, a, DEMO);
    expect(error).toHaveBeenCalledWith('demo: nope');
    expect(a.statusCode).toBe(200);
    api.close();
  });
});
