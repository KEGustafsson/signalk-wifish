import { test, expect, beforeEach, afterEach, vi } from 'vitest';
import { PluginStream, isColumn, isSonarLink, isState, setChannel, setDemo, setDisplay, setSystem, setVessel, type StreamHandlers, DROP_GRACE_MS, RECONNECT_MIN_MS, RECONNECT_MAX_MS } from '../web/src/stream';

/** EventSource stub: records listeners, lets a test dispatch events and set readyState. */
class FakeES {
  static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
  static instances: FakeES[] = [];
  readyState = 0;
  closed = false;
  listeners = new Map<string, ((e: unknown) => void)[]>();
  constructor(readonly url: string) { FakeES.instances.push(this); }
  addEventListener(name: string, fn: (e: unknown) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  close() { this.closed = true; this.readyState = 2; }
  emit(name: string, data?: string) { for (const fn of this.listeners.get(name) ?? []) fn({ data }); }
}

const state = {
  epoch: 'e1', source: 'demo', link: 'connected', message: 'ok', canControl: true, unit: null, softwareVersion: null,
  depthCm: 123, waterTempCentiC: 1500, lowVoltage: false, system: null, channels: { sonar: null, downvision: null },
  active: { sonar: true, downvision: false },
};
const column = { ch: 'sonar', n: 1, t: 1000, startCm: 0, endCm: 1000, bottomCm: 500, waterTempCentiC: 1500, data: 'AQI=' };

function handlers(): StreamHandlers & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    state: (s) => calls.push(`state:${s === null ? 'null' : s.epoch}`),
    display: (d) => calls.push(`display:${JSON.stringify(d)}`),
    vessel: (v) => calls.push(`vessel:${JSON.stringify(v)}`),
    column: (c) => calls.push(`col:${c.ch}/${c.n}`),
    reset: () => calls.push('reset'),
    live: () => calls.push('live'),
    connection: (ok) => calls.push(`conn:${ok}`),
    sonar: (link) => calls.push(`sonar:${link}`),
  };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  FakeES.instances = [];
  vi.stubGlobal('EventSource', FakeES);
  vi.useFakeTimers();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); warn.mockRestore(); });

test('well-formed events reach the handlers', () => {
  const h = handlers();
  new PluginStream(h).open();
  const es = FakeES.instances[0];
  expect(es.url).toMatch(/\/plugins\/signalk-wifish\/api\/stream$/);
  es.emit('open');
  es.emit('state', JSON.stringify(state));
  es.emit('state', 'null');
  es.emit('col', JSON.stringify(column));
  es.emit('display', JSON.stringify({ tempUnit: 'C' }));
  es.emit('vessel', JSON.stringify({ surfaceToTransducerCm: 40 }));
  es.emit('reset');
  es.emit('live');
  expect(h.calls).toEqual(['conn:true', 'state:e1', 'state:null', 'col:sonar/1', 'display:{"tempUnit":"C"}', 'vessel:{"surfaceToTransducerCm":40}', 'reset', 'live']);
  expect(warn).not.toHaveBeenCalled();
});

test('malformed events are logged and ignored, and a throwing handler does not kill the stream', () => {
  const h = handlers();
  h.column = () => { throw new Error('boom'); };
  new PluginStream(h).open();
  const es = FakeES.instances[0];
  es.emit('state', '{not json');
  es.emit('state', JSON.stringify({ epoch: 'e2' })); // missing fields
  es.emit('state', JSON.stringify({ ...state, channels: null }));
  es.emit('state', '[1,2]');
  es.emit('col', JSON.stringify({ ...column, ch: 'sidevision' }));
  es.emit('col', JSON.stringify({ ...column, n: 'one' }));
  es.emit('col', JSON.stringify({ ...column, data: 7 }));
  es.emit('display', '42');
  es.emit('vessel', 'null');
  es.emit('col', JSON.stringify(column)); // valid, but the handler throws
  es.emit('state', JSON.stringify(state)); // still delivered afterwards
  expect(h.calls).toEqual(['state:e1']);
  expect(warn).toHaveBeenCalledTimes(10);
});

test('isState / isColumn shape checks', () => {
  expect(isState(null)).toBe(true);
  expect(isState(state)).toBe(true);
  expect(isState({ ...state, depthCm: null })).toBe(true);
  expect(isState({ ...state, depthCm: 'deep' })).toBe(false);
  expect(isState({ ...state, active: undefined })).toBe(false);
  expect(isState(undefined)).toBe(false);
  expect(isColumn(column)).toBe(true);
  expect(isColumn({ ...column, bottomCm: null })).toBe(true);
  expect(isColumn({ ...column, t: NaN })).toBe(false);
  expect(isColumn({ ...column, ch: 'sonar', n: undefined })).toBe(false);
});

test('a stream the browser gave up on is reopened with capped exponential backoff', () => {
  const h = handlers();
  const s = new PluginStream(h);
  s.open();
  // a plain drop (readyState CONNECTING): the browser retries itself, nothing scheduled
  FakeES.instances[0].readyState = 0;
  FakeES.instances[0].emit('error');
  vi.advanceTimersByTime(RECONNECT_MAX_MS);
  expect(FakeES.instances).toHaveLength(1);
  // a fatal reply (readyState CLOSED): reopen after 1 s, 2 s, 4 s ... 30 s
  let expected = RECONNECT_MIN_MS;
  for (let i = 0; i < 7; i++) {
    const es = FakeES.instances[FakeES.instances.length - 1];
    es.readyState = 2;
    es.emit('error');
    vi.advanceTimersByTime(expected - 1);
    expect(FakeES.instances).toHaveLength(i + 2 - 1);
    vi.advanceTimersByTime(1);
    expect(FakeES.instances).toHaveLength(i + 2);
    expect(es.closed).toBe(true);
    expected = Math.min(RECONNECT_MAX_MS, expected * 2);
  }
  expect(expected).toBe(RECONNECT_MAX_MS);
  // a successful open resets the backoff
  const es = FakeES.instances[FakeES.instances.length - 1];
  es.emit('open');
  es.readyState = 2;
  es.emit('error');
  vi.advanceTimersByTime(RECONNECT_MIN_MS);
  expect(FakeES.instances).toHaveLength(9);
  expect(h.calls.filter((c) => c === 'conn:false')).toHaveLength(9);
  // close() cancels a pending reopen
  const last = FakeES.instances[FakeES.instances.length - 1];
  last.readyState = 2;
  last.emit('error');
  s.close();
  vi.advanceTimersByTime(RECONNECT_MAX_MS * 2);
  expect(FakeES.instances).toHaveLength(9);
  expect(last.closed).toBe(true);
});

test('an error on a stale EventSource (replaced by open()) schedules nothing', () => {
  const s = new PluginStream(handlers());
  s.open();
  const old = FakeES.instances[0];
  s.open();
  old.readyState = 2;
  old.emit('error');
  vi.advanceTimersByTime(RECONNECT_MAX_MS * 2);
  expect(FakeES.instances).toHaveLength(2);
  s.close();
});

test('a drop the browser retries is reported only after DROP_GRACE_MS; a first connect or a fatal reply at once', () => {
  const h = handlers();
  const s = new PluginStream(h);
  s.open();
  const es = FakeES.instances[0];
  es.emit('error'); // the first connect fails: no grace
  expect(h.calls).toEqual(['conn:false']);
  es.emit('open');
  es.readyState = 0;
  es.emit('error'); // a Wi-Fi hiccup: the browser retries
  vi.advanceTimersByTime(DROP_GRACE_MS - 1);
  es.emit('open'); // back within the grace: nothing reported
  vi.advanceTimersByTime(DROP_GRACE_MS * 2);
  expect(h.calls).toEqual(['conn:false', 'conn:true', 'conn:true']);
  h.calls.length = 0;
  es.emit('error');
  vi.advanceTimersByTime(DROP_GRACE_MS - 1000);
  es.emit('error'); // a failed retry does not restart the grace
  vi.advanceTimersByTime(999);
  expect(h.calls).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(h.calls).toEqual(['conn:false']);
  es.emit('error'); // already reported down: at once
  expect(h.calls).toEqual(['conn:false', 'conn:false']);
  h.calls.length = 0;
  es.emit('open');
  es.emit('error');
  es.readyState = 2;
  es.emit('error'); // the browser gave up: at once, and the pending grace is dropped
  vi.advanceTimersByTime(DROP_GRACE_MS * 2);
  expect(h.calls).toEqual(['conn:true', 'conn:false']);
  // close() drops a pending report
  const next = FakeES.instances[FakeES.instances.length - 1];
  next.emit('open');
  next.readyState = 0;
  next.emit('error');
  s.close();
  vi.advanceTimersByTime(DROP_GRACE_MS * 2);
  expect(h.calls).toEqual(['conn:true', 'conn:false', 'conn:true']);
});

/** fetch stub returning `status` with `body` (a string is returned as-is, anything else as JSON). */
function fakeFetch(status: number, body: unknown) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
  }));
}

test('post: a 200 that is not the expected JSON rejects instead of becoming a fake state', async () => {
  vi.stubGlobal('fetch', fakeFetch(200, '<html>login</html>'));
  await expect(setChannel('sonar', { gain: 50 })).rejects.toThrow(/Unexpected reply/);
  vi.stubGlobal('fetch', fakeFetch(200, { hello: 'world' }));
  await expect(setChannel('sonar', { gain: 50 })).rejects.toThrow(/Unexpected reply/);
  vi.stubGlobal('fetch', fakeFetch(200, null));
  await expect(setChannel('sonar', { gain: 50 })).rejects.toThrow(/Unexpected reply/);
  vi.stubGlobal('fetch', fakeFetch(200, state));
  await expect(setChannel('sonar', { gain: 50 })).resolves.toMatchObject({ epoch: 'e1' });
  vi.stubGlobal('fetch', fakeFetch(200, { tempUnit: 'F' }));
  await expect(setDisplay({ tempUnit: 'F' })).resolves.toEqual({ tempUnit: 'F' });
});

test('post: errors carry the server message, or the HTTP status when the body is not JSON', async () => {
  vi.stubGlobal('fetch', fakeFetch(400, { error: 'gain out of range' }));
  await expect(setChannel('sonar', { gain: 500 })).rejects.toThrow('gain out of range');
  vi.stubGlobal('fetch', fakeFetch(502, '<html>Bad gateway</html>'));
  await expect(setChannel('sonar', { gain: 50 })).rejects.toThrow('HTTP 502');
});

test('demo mode: the stream and the sonar settings go to the demo engine, units and vessel do not', async () => {
  const fetch = fakeFetch(200, state);
  vi.stubGlobal('fetch', fetch);
  try {
    setDemo(true);
    const h = handlers();
    const st = new PluginStream(h);
    st.open();
    expect(FakeES.instances[0].url).toMatch(/\/api\/stream\?demo=1$/);
    FakeES.instances[0].emit('sonar', JSON.stringify({ link: 'searching' }));
    FakeES.instances[0].emit('sonar', JSON.stringify({ link: null }));
    FakeES.instances[0].emit('sonar', JSON.stringify({ link: 3 })); // ignored
    expect(h.calls).toEqual(['sonar:searching', 'sonar:null']);
    await setChannel('downvision', { gain: 50 });
    await setSystem({ simulator: true });
    await setDisplay({ tempUnit: 'C' }).catch(() => {});
    await setVessel({ surfaceToTransducerCm: 10 }).catch(() => {});
    setDemo(false);
    st.open(); // back to the real sonar
    expect(FakeES.instances[1].url).toMatch(/\/api\/stream$/);
    await setChannel('sonar', { gain: 50 });
    const urls = fetch.mock.calls.map((c) => (c as unknown[])[0]);
    expect(urls).toEqual([
      '/plugins/signalk-wifish/api/channel/downvision?demo=1', '/plugins/signalk-wifish/api/system?demo=1',
      '/plugins/signalk-wifish/api/display', '/plugins/signalk-wifish/api/vessel', '/plugins/signalk-wifish/api/channel/sonar',
    ]);
  } finally {
    setDemo(false);
  }
});

test('isSonarLink shape check', () => {
  expect(isSonarLink({ link: 'connected' })).toBe(true);
  expect(isSonarLink({ link: null })).toBe(true);
  expect(isSonarLink({})).toBe(false);
  expect(isSonarLink(null)).toBe(false);
});
