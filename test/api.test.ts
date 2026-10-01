import { describe, test, expect, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { plugin } from '../src/plugin';
import { EventEmitter } from 'node:events';
import { Api, MAX_STREAMS, MAX_UNREAD_BYTES, parseChannelPatch, parseSystemPatch } from '../src/api';
import type { Engine } from '../src/engine';
import type { Delta } from '../src/signalk';

describe('patch validation', () => {
  test('channel patch', () => {
    expect(parseChannelPatch({ gain: 40.4, gainAuto: false })).toEqual({ gain: 40, gainAuto: false });
    expect(parseChannelPatch({ gain: 101 })).toMatch(/0..100/);
    expect(parseChannelPatch({ gainAuto: 'yes' })).toMatch(/boolean/);
    expect(parseChannelPatch({ rangeShallowCm: 500, rangeDeepCm: 400 })).toMatch(/less than/);
    expect(parseChannelPatch({ bogus: 1 })).toMatch(/unknown/);
    expect(parseChannelPatch({})).toMatch(/empty/);
    expect(parseChannelPatch([])).toMatch(/object/);
  });
  test('system patch', () => {
    expect(parseSystemPatch({ transducerOffsetCm: -30, simulator: true })).toEqual({ transducerOffsetCm: -30, simulator: true });
    expect(parseSystemPatch({ transducerOffsetCm: 400 })).toMatch(/-300..300/);
    expect(parseSystemPatch({ depthUnit: 1 })).toMatch(/unknown/);
  });
});

type Next = (e?: unknown) => void;
type Mw = (req: http.IncomingMessage & { path?: string }, res: http.ServerResponse, next: Next) => void;

let server: http.Server | null = null;
let stop: (() => void) | null = null;
afterEach(async () => {
  stop?.();
  stop = null;
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('plugin HTTP API (demo source)', () => {
  test('state, settings and the event stream', async () => {
    const { base, deltas } = await startPlugin({ source: 'demo' });
    await sleep(1300);
    const state = await (await fetch(`${base}/api/state`)).json();
    expect(state).toMatchObject({ source: 'demo', link: 'connected', canControl: true });

    const r = await fetch(`${base}/api/channel/sonar`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gain: 77, gainAuto: false }) });
    expect(r.status).toBe(200);
    expect((await r.json()).channels.sonar).toMatchObject({ gain: 77, gainAuto: false });

    const json = { 'content-type': 'application/json' };
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
    expect(events.slice(0, 2)).toEqual(['display', 'state']);
    expect(events.filter((e) => e === 'col').length).toBeGreaterThan(5);
    expect(deltas.length).toBeGreaterThan(0);
  });

  test('display units are shared by all viewers and survive a restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wifish-'));
    const json = { 'content-type': 'application/json' };
    let { base } = await startPlugin({ source: 'demo' }, dir);
    expect(await (await fetch(`${base}/api/display`)).json()).toEqual({});

    // A viewer listening on the stream gets the change another viewer makes.
    const ctrl = new AbortController();
    const reader = (await fetch(`${base}/api/stream`, { signal: ctrl.signal })).body!.getReader();
    const bad = await fetch(`${base}/api/display`, { method: 'POST', headers: json, body: '{"tempUnit":"K"}' });
    expect(bad.status).toBe(400);
    const r = await fetch(`${base}/api/display`, { method: 'POST', headers: json, body: '{"depthUnit":"ft","tempUnit":"F"}' });
    expect(await r.json()).toEqual({ depthUnit: 'ft', tempUnit: 'F' });
    let text = '';
    while (!/event: display\ndata: \{"depthUnit/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
    ctrl.abort();
    expect(text.startsWith('retry: 2000\n\nevent: display\ndata: {}')).toBe(true);
    expect(text).toContain('event: display\ndata: {"depthUnit":"ft","tempUnit":"F"}');

    // Following the sonar's unit is a choice too (null), and the file outlives the plugin.
    await fetch(`${base}/api/display`, { method: 'POST', headers: json, body: '{"depthUnit":null}' });
    stop!();
    await new Promise<void>((res) => server!.close(() => res()));
    ({ base } = await startPlugin({ source: 'demo' }, dir));
    expect(await (await fetch(`${base}/api/display`)).json()).toEqual({ depthUnit: null, tempUnit: 'F' });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('replay without a file falls back to the demo', async () => {
    const { base } = await startPlugin({ source: 'replay' });
    await sleep(200);
    expect((await (await fetch(`${base}/api/state`)).json()).source).toBe('demo');
  });

  test('replay of a missing file reports offline and refuses settings', async () => {
    const { base, statuses } = await startPlugin({ source: 'replay', replayFile: '/nonexistent/capture.bin' });
    await sleep(100);
    const s = await (await fetch(`${base}/api/state`)).json();
    expect(s).toMatchObject({ source: 'replay', link: 'offline', canControl: false });
    expect(statuses.some((m) => m.startsWith('ERR'))).toBe(true);
  });
});

describe('plugin lifecycle', () => {
  test('schema has defaults and start/stop never throw', async () => {
    const p = plugin({ handleMessage: () => {} });
    stop = () => p.stop();
    const schema = p.schema();
    expect(schema.type).toBe('object');
    expect(schema.properties.source.default).toBe('device');
    for (const cfg of [{}, { source: 'device', iface: '203.0.113.9' }, { source: 'demo' }, { source: 'demo', demoModel: 'wifish' }]) {
      expect(() => p.start(cfg as never)).not.toThrow();
      await sleep(20);
      expect(() => p.stop()).not.toThrow();
    }
    expect(() => p.stop()).not.toThrow();
  });

  test('API answers 503 while stopped', async () => {
    const { p, base } = await startPlugin({ source: 'demo' });
    p.stop();
    expect((await fetch(`${base}/api/state`)).status).toBe(503);
  });
});

describe('SSE backpressure', () => {
  class FakeRes extends EventEmitter {
    writableLength = 0;
    destroyed = false;
    statusCode = 0;
    chunks: string[] = [];
    setHeader() {}
    flushHeaders() {}
    write(c: string) { this.chunks.push(c); this.writableLength += c.length; return true; }
    end() { this.emit('close'); }
    destroy() { this.destroyed = true; this.emit('close'); }
  }

  test('drops a viewer that stops reading, keeps one that reads', async () => {
    const engine = Object.assign(new EventEmitter(), {
      state: () => ({ link: 'connected' }),
      history: () => [],
    });
    const api = new Api(() => engine as unknown as Engine);
    api.bind();
    const slow = new FakeRes(), fast = new FakeRes();
    for (const r of [slow, fast]) await api.handle(Object.assign(new EventEmitter(), { method: 'GET' }) as never, r as never, '/api/stream');
    slow.writableLength = 2 * MAX_UNREAD_BYTES; // backlog plus 4 MB of live data never drained
    fast.writableLength = 0;
    engine.emit('column', { ch: 'sonar', n: 1, data: '' });
    expect(slow.destroyed).toBe(true);
    expect(fast.destroyed).toBe(false);
    const before = slow.chunks.length;
    engine.emit('column', { ch: 'sonar', n: 2, data: '' });
    expect(slow.chunks.length).toBe(before);
    expect(fast.chunks.at(-1)).toMatch(/event: col/);
    api.close();
  });

  test('refuses viewers beyond MAX_STREAMS', async () => {
    const engine = Object.assign(new EventEmitter(), { state: () => ({}), history: () => [] });
    const api = new Api(() => engine as unknown as Engine);
    const req = () => Object.assign(new EventEmitter(), { method: 'GET' }) as never;
    const all = Array.from({ length: MAX_STREAMS }, () => new FakeRes());
    for (const r of all) await api.handle(req(), r as never, '/api/stream');
    const extra = new FakeRes();
    await api.handle(req(), extra as never, '/api/stream');
    expect(extra.statusCode).toBe(503);
    all[0].emit('close');
    const again = new FakeRes();
    await api.handle(req(), again as never, '/api/stream');
    expect(again.statusCode).toBe(200);
    api.close();
  });
});
