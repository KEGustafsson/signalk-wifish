import { describe, test, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Engine, clampColumns, DEPTH_HEARTBEAT_MS, TEMP_HEARTBEAT_MS } from '../src/engine';
import { DemoDevice } from '../src/demo';
import { MsgId, messageId, parseChannelSettings } from '../src/sonar4';
import type { Transport, TransportEvents } from '../src/transport';
import { PATH, type Delta } from '../src/signalk';
import { msg, results, segment, channelSettings, systemSettings } from './helpers';

class FakeTransport extends EventEmitter<TransportEvents> implements Transport {
  readonly kind = 'device' as const;
  canSend = true;
  sent: Uint8Array[] = [];
  start() { this.emit('link', 'connected', 'fake'); }
  stop() { this.emit('link', 'offline', 'stopped'); }
  send(b: Uint8Array) { this.sent.push(b); }
  feed(b: Uint8Array) { this.emit('datagram', b); }
}

afterEach(() => { vi.useRealTimers(); });

describe('Engine', () => {
  test('state carries an epoch unique to the engine, so viewers detect a restart', () => {
    const a = new Engine(new FakeTransport());
    const b = new Engine(new FakeTransport());
    expect(a.state().epoch).toBe(a.state().epoch);
    expect(a.state().epoch).not.toBe(b.state().epoch);
  });

  test('publishes depth with the offset convention and temperature', () => {
    const t = new FakeTransport();
    const deltas: Delta[] = [];
    const e = new Engine(t, { onDelta: (d) => deltas.push(d) });
    e.start();
    t.feed(systemSettings(1, 50));
    t.feed(msg(MsgId.BOTTOM, 22, (b) => b.writeInt32LE(1050, 17)));
    t.feed(msg(MsgId.ENV, 68, (b) => b.writeInt16LE(1234, 28)));
    const values = deltas.flatMap((d) => d.updates[0].values);
    expect(values).toContainEqual({ path: 'environment.depth.belowTransducer', value: 10 });
    expect(values).toContainEqual({ path: 'environment.depth.belowSurface', value: 10.5 });
    expect(values).toContainEqual({ path: 'environment.water.temperature', value: 285.49 });
    e.stop();
  });

  test('clears a depth path that stops applying when the offset changes', () => {
    const t = new FakeTransport();
    const deltas: Delta[] = [];
    const e = new Engine(t, { onDelta: (d) => deltas.push(d) });
    e.start();
    t.feed(systemSettings(1, 50));
    t.feed(msg(MsgId.BOTTOM, 22, (b) => b.writeInt32LE(1050, 17)));
    deltas.length = 0;
    t.feed(systemSettings(2, 0));
    const values = deltas.flatMap((d) => d.updates[0].values);
    expect(values).toContainEqual({ path: 'environment.depth.belowSurface', value: null });
    expect(values).toContainEqual({ path: 'environment.depth.belowTransducer', value: 10.5 });
    deltas.length = 0;
    t.feed(systemSettings(3, -30));
    expect(deltas.flatMap((d) => d.updates[0].values)).toContainEqual({ path: 'environment.depth.belowKeel', value: 10.5 });
    e.stop();
  });

  test('the waterline-to-transducer distance adds depth below surface and is republished when changed', () => {
    const t = new FakeTransport();
    const deltas: Delta[] = [];
    let distance: number | null = null;
    const e = new Engine(t, { onDelta: (d) => deltas.push(d), surfaceToTransducerCm: () => distance });
    e.start();
    t.feed(systemSettings(1, -30));
    t.feed(msg(MsgId.BOTTOM, 22, (b) => b.writeInt32LE(970, 17)));
    const values = () => deltas.flatMap((d) => d.updates[0].values);
    expect(values()).toContainEqual({ path: 'environment.depth.belowKeel', value: 9.7 });
    expect(values()).toContainEqual({ path: 'environment.depth.transducerToKeel', value: 0.3 });
    expect(values().map((v) => v.path)).not.toContain('environment.depth.belowSurface');
    deltas.length = 0;
    distance = 40;
    e.vesselChanged(); // at once, not with the next bottom record
    expect(values()).toContainEqual({ path: 'environment.depth.belowSurface', value: 10.4 });
    expect(values()).toContainEqual({ path: 'environment.depth.surfaceToTransducer', value: 0.4 });
    deltas.length = 0;
    distance = null;
    e.vesselChanged();
    expect(values()).toContainEqual({ path: 'environment.depth.belowSurface', value: null });
    expect(values()).toContainEqual({ path: 'environment.depth.surfaceToTransducer', value: null });
    e.stop();
  });

  test('an offset change counts for depth only once the sonar confirms it; the watchdog resends it', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date', 'performance'] });
    const t = new FakeTransport();
    const deltas: Delta[] = [];
    const e = new Engine(t, { onDelta: (d) => deltas.push(d) });
    e.start();
    t.feed(systemSettings(1, 0));
    t.feed(msg(MsgId.BOTTOM, 22, (b) => b.writeInt32LE(1050, 17)));
    deltas.length = 0;
    expect(e.setSystem({ transducerOffsetCm: 50 })).toBeNull();
    expect(e.state().system!.transducerOffsetCm).toBe(50); // shown at once
    const paths = () => deltas.flatMap((d) => d.updates[0].values).map((v) => v.path);
    t.feed(msg(MsgId.BOTTOM, 22, (b) => b.writeInt32LE(1060, 17)));
    expect(paths()).not.toContain('environment.depth.belowSurface');
    // Lost on the way: the sonar keeps its seq 1 settings, the watchdog sends ours again.
    t.sent.length = 0;
    t.feed(systemSettings(1, 0));
    vi.advanceTimersByTime(1000);
    expect(t.sent.filter((b) => messageId(b) === MsgId.SYS_SETTINGS)).toHaveLength(1);
    t.feed(systemSettings(2, 50)); // applied
    t.feed(msg(MsgId.BOTTOM, 22, (b) => b.writeInt32LE(1070, 17)));
    expect(paths()).toContain('environment.depth.belowSurface');
    e.stop();
  });

  test('publishes nothing for depth before the first bottom record', () => {
    const t = new FakeTransport();
    const deltas: Delta[] = [];
    const e = new Engine(t, { onDelta: (d) => deltas.push(d) });
    e.start();
    t.feed(systemSettings(1, 50));
    expect(deltas).toHaveLength(0);
    e.stop();
  });

  test('rejects a range that would end up shallow >= deep, and a preset turns Auto range off', () => {
    const t = new FakeTransport();
    const e = new Engine(t);
    e.start();
    t.feed(channelSettings(0, 1, { deep: 2000 }));
    t.feed(channelSettings(1, 1, { deep: 2000 }));
    expect(e.setChannel('sonar', { rangeShallowCm: 2500 })).toMatch(/Shallow must be less than Deep/);
    expect(t.sent).toHaveLength(0);
    expect(e.setChannel('sonar', { rangeDeepCm: 3000 })).toBeNull();
    expect(t.sent.map((b) => parseChannelSettings(b))).toEqual([
      expect.objectContaining({ index: 0, rangeAuto: false, rangeDeepCm: 3000 }),
      expect.objectContaining({ index: 1, rangeAuto: false, rangeDeepCm: 3000 }),
    ]);
    e.stop();
  });

  test('a new session forgets the old one; a lost link blanks depth and temperature', () => {
    const t = new FakeTransport();
    const deltas: Delta[] = [];
    const e = new Engine(t, { onDelta: (d) => deltas.push(d) });
    e.start();
    t.feed(channelSettings(0, 5, { gain: 10 }));
    t.feed(msg(MsgId.BOTTOM, 22, (b) => b.writeInt32LE(1000, 17)));
    t.feed(msg(MsgId.ENV, 68, (b) => b.writeInt16LE(1234, 28)));
    t.emit('link', 'lost', 'lost');
    const values = deltas.flatMap((d) => d.updates[0].values);
    expect(values).toContainEqual({ path: 'environment.depth.belowTransducer', value: null });
    expect(values).toContainEqual({ path: 'environment.water.temperature', value: null });
    expect(e.state()).toMatchObject({ depthCm: null, waterTempCentiC: null });
    t.emit('link', 'connected', 'back');
    expect(e.state().channels.sonar).not.toBeNull(); // recovered: settings kept
    t.emit('link', 'connecting', 'new service');
    expect(e.session.channelSettings(0)).toBeNull(); // a new session starts clean
    t.feed(channelSettings(0, 1, { gain: 60 })); // a lower seq from a new unit is accepted
    expect(e.session.channelSettings(0)!.gain).toBe(60);
    e.stop();
  });

  test('the readout keeps the last depth for 6 s after bottom lock is lost', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date', 'performance'] });
    const t = new FakeTransport();
    const e = new Engine(t);
    e.start();
    const bottom = (cm: number) => t.feed(msg(MsgId.BOTTOM, 22, (b) => b.writeInt32LE(cm, 17)));
    bottom(1000);
    expect(e.state().depthCm).toBe(1000);
    for (let i = 0; i < 5; i++) { vi.advanceTimersByTime(1000); bottom(-0x80000000); }
    expect(e.state().depthCm).toBe(1000); // t = 5 s, first no-lock at t = 1 s
    vi.advanceTimersByTime(2500); // t = 7.5 s > 1 s + 6 s
    expect(e.state().depthCm).toBeNull();
    bottom(-20);
    expect(e.state().depthCm).toBe(0); // negative shows as 0, like the app
    e.stop();
  });

  test('can turn Signal K output off', () => {
    const t = new FakeTransport();
    const deltas: Delta[] = [];
    const e = new Engine(t, { onDelta: (d) => deltas.push(d), emitDepth: false, emitTemperature: false });
    e.start();
    t.feed(msg(MsgId.BOTTOM, 22, (b) => b.writeInt32LE(1050, 17)));
    t.feed(msg(MsgId.ENV, 68, (b) => b.writeInt16LE(1234, 28)));
    expect(deltas).toHaveLength(0);
    e.stop();
  });

  test('keeps a bounded history and reports columns transducer-relative', () => {
    const t = new FakeTransport();
    const e = new Engine(t, { historyColumns: 3 });
    e.start();
    t.feed(systemSettings(1, 100));
    t.feed(channelSettings(0, 1));
    t.feed(msg(MsgId.BOTTOM, 22, (b) => b.writeInt32LE(1100, 17)));
    for (let i = 0; i < 5; i++) {
      t.feed(results(i, 0, 0, 2000));
      t.feed(segment({ seq: i, seg: 0, count: 1, total: 3, offset: 0, data: [i, 2, 3], setting: 0 }));
    }
    const h = e.history('sonar');
    expect(h.map((c) => c.n)).toEqual([3, 4, 5]);
    expect(h[2]).toMatchObject({ ch: 'sonar', startCm: 0, endCm: 2000, bottomCm: 1000 });
    expect(Buffer.from(h[2].data, 'base64')).toEqual(Buffer.from([4, 2, 3]));
    expect(e.state().active).toEqual({ sonar: true, downvision: false });
    e.stop();
  });

  test('forwards settings changes to the transport, refuses when it cannot send', () => {
    const t = new FakeTransport();
    const e = new Engine(t);
    e.start();
    expect(e.setChannel('sonar', { gain: 10 })).toMatch(/not received/);
    t.feed(channelSettings(0, 1));
    expect(e.setChannel('sonar', { gain: 10 })).toBeNull(); // default ping configuration 0, before any data
    expect(parseChannelSettings(t.sent[0])).toMatchObject({ gain: 10, seq: 2 });
    expect(e.setSystem({ simulator: true })).toMatch(/not received/);
    t.canSend = false;
    expect(e.setChannel('sonar', { gain: 20 })).toMatch(/cannot be changed/);
    e.stop();
  });

  test('clears depth when data stops', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date', 'performance'] });
    const t = new FakeTransport();
    const deltas: Delta[] = [];
    const e = new Engine(t, { onDelta: (d) => deltas.push(d) });
    e.start();
    t.feed(msg(MsgId.BOTTOM, 22, (b) => b.writeInt32LE(1000, 17)));
    vi.advanceTimersByTime(7000);
    const last = deltas.at(-1)!.updates[0].values;
    expect(last).toContainEqual({ path: 'environment.depth.belowTransducer', value: null });
    expect(e.state().depthCm).toBeNull();
    e.stop();
  });

  test('runs end to end against the demo sonar, including a settings round trip', () => {
    vi.useFakeTimers();
    const demo = new DemoDevice({ seed: 1, pingRate: 10 });
    const e = new Engine(demo);
    e.start();
    vi.advanceTimersByTime(3000);
    const s = e.state();
    expect(s.link).toBe('connected');
    expect(s.unit?.model).toBe('Dragonfly-4 Pro');
    expect(s.channels.sonar?.gainAuto).toBe(true);
    expect(e.history('sonar').length).toBeGreaterThan(10);
    expect(e.history('downvision').length).toBeGreaterThan(10);
    expect(s.depthCm).toBeGreaterThan(200);
    expect(e.setChannel('downvision', { gainAuto: false, gain: 90 })).toBeNull();
    vi.advanceTimersByTime(1500);
    expect(e.state().channels.downvision).toMatchObject({ gainAuto: false, gain: 90 });
    expect(e.setChannel('sonar', { rangeAuto: false, rangeShallowCm: 0, rangeDeepCm: 3000 })).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(e.history('sonar').at(-1)!.endCm).toBe(3000);
    expect(e.setSystem({ transducerOffsetCm: 50 })).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(e.state().system?.transducerOffsetCm).toBe(50);
    e.stop();
  });

  test('wifish demo only pings DownVision', () => {
    vi.useFakeTimers();
    const e = new Engine(new DemoDevice({ model: 'wifish' }));
    e.start();
    vi.advanceTimersByTime(2000);
    expect(e.state().unit?.wifish).toBe(true);
    expect(e.history('sonar')).toHaveLength(0);
    expect(e.history('downvision').length).toBeGreaterThan(5);
    e.stop();
  });
});

const FAKE_CLOCK = { toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date', 'performance'] } as const;
const bottomMsg = (cm: number) => msg(MsgId.BOTTOM, 22, (b) => b.writeInt32LE(cm, 17));
const envMsg = (centiC: number) => msg(MsgId.ENV, 68, (b) => b.writeInt16LE(centiC, 28));
/** An error-status message: sonar data that carries no reading (keeps the watchdog fed). */
const errMsg = () => msg(MsgId.ERROR, 20);
const valuesOf = (deltas: Delta[]) => deltas.flatMap((d) => d.updates[0].values);
const pathValues = (deltas: Delta[], path: string) => valuesOf(deltas).filter((v) => v.path === path).map((v) => v.value);

describe('Engine lifecycle and output timing', () => {
  test('clampColumns: strings, NaN, out of range and 0', () => {
    expect(clampColumns(undefined)).toBe(1500);
    expect(clampColumns(NaN)).toBe(1500);
    expect(clampColumns('abc')).toBe(1500);
    expect(clampColumns('')).toBe(1500);
    expect(clampColumns('300')).toBe(300);
    expect(clampColumns(2.6)).toBe(3);
    expect(clampColumns(-5)).toBe(0);
    expect(clampColumns(0)).toBe(0);
    expect(clampColumns(1e9)).toBe(20_000);
    expect(clampColumns(Infinity)).toBe(1500);
    const e = new Engine(new FakeTransport(), { historyColumns: 0 });
    e.start();
    expect(e.history('sonar')).toHaveLength(0);
    e.stop();
  });

  test('stop() leaves no timers, even with hold and state timers pending, and publishes null readings', () => {
    vi.useFakeTimers(FAKE_CLOCK);
    const t = new FakeTransport();
    const deltas: Delta[] = [];
    const e = new Engine(t, { onDelta: (d) => deltas.push(d) });
    e.start();
    t.feed(bottomMsg(1000));
    t.feed(envMsg(1500));
    t.feed(bottomMsg(-0x80000000)); // starts the 6 s hold timer
    t.feed(envMsg(1510)); // coalesced state timer (250 ms)
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(3);
    expect(pathValues(deltas, PATH.depth)).toEqual([10, null]); // no lock: null went out at once
    e.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(t.listenerCount('datagram')).toBe(0);
    expect(pathValues(deltas, PATH.depth)).toEqual([10, null]); // already null: not repeated by stop()
    expect(pathValues(deltas, PATH.waterTemp)).toEqual([288.15, null]); // cleared by stop()
    expect(e.state().link).toBe('offline');
    e.start(); // single use
    expect(vi.getTimerCount()).toBe(0);
  });

  test('stop() cleans up even when the transport fails to stop', () => {
    vi.useFakeTimers(FAKE_CLOCK);
    const t = new FakeTransport();
    t.stop = () => { throw new Error('socket already closed'); };
    const e = new Engine(t);
    e.start();
    expect(() => e.stop()).toThrow(/socket already closed/);
    expect(vi.getTimerCount()).toBe(0);
    expect(t.listenerCount('link')).toBe(0);
  });

  test('a throwing delta consumer is contained and logged; stop() still cleans up', () => {
    vi.useFakeTimers(FAKE_CLOCK);
    const t = new FakeTransport();
    const errors: string[] = [];
    let calls = 0;
    const e = new Engine(t, { onDelta: () => { calls++; throw new Error('consumer down'); }, error: (m) => errors.push(m) });
    e.start();
    expect(() => t.feed(bottomMsg(1000))).not.toThrow();
    expect(() => t.feed(envMsg(1200))).not.toThrow();
    expect(calls).toBe(2);
    expect(errors).toEqual(['error delivering a delta: consumer down', 'error delivering a delta: consumer down']);
    expect(e.state().depthCm).toBe(1000); // the engine itself carried on
    expect(() => e.stop()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('a throwing link listener is contained; errors fall back to log when no error logger is given', () => {
    const t = new FakeTransport();
    const logs: string[] = [];
    const e = new Engine(t, { log: (m) => logs.push(m), onDelta: () => { throw new Error('x'); } });
    e.start();
    t.feed(bottomMsg(100));
    expect(logs).toEqual(['error delivering a delta: x']);
    e.on('state', () => { throw new Error('viewer broke'); });
    expect(() => t.emit('link', 'lost', 'gone')).not.toThrow();
    expect(logs.at(-1)).toBe("error handling link 'lost': viewer broke");
    e.stop();
  });

  test('depth is rate limited to 5 Hz and temperature to 1 Hz', () => {
    vi.useFakeTimers(FAKE_CLOCK);
    const t = new FakeTransport();
    const deltas: Delta[] = [];
    const e = new Engine(t, { onDelta: (d) => deltas.push(d) });
    e.start();
    for (let i = 0; i < 20; i++) { // samples at 20 Hz, every one different
      t.feed(bottomMsg(1000 + i));
      t.feed(envMsg(1500 + i));
      if (i < 19) vi.advanceTimersByTime(50);
    }
    // t = 950 ms: depth went out at 0, 200, 400, 600 and 800 ms, temperature once.
    expect(pathValues(deltas, PATH.depth)).toEqual([10, 10.04, 10.08, 10.12, 10.16]);
    expect(pathValues(deltas, PATH.waterTemp)).toEqual([288.15]);
    vi.advanceTimersByTime(50); // t = 1 s: the tick flushes the latest values the limits held back
    expect(pathValues(deltas, PATH.depth)).toEqual([10, 10.04, 10.08, 10.12, 10.16, 10.19]);
    expect(pathValues(deltas, PATH.waterTemp)).toEqual([288.15, 288.34]);
    e.stop();
  });

  test('heartbeats are timer-driven: unchanged readings repeat at 5 s / 10 s with no new sample', () => {
    vi.useFakeTimers(FAKE_CLOCK);
    const t = new FakeTransport();
    const deltas: Delta[] = [];
    const e = new Engine(t, { onDelta: (d) => deltas.push(d) });
    e.start();
    t.feed(bottomMsg(1000));
    t.feed(envMsg(1500));
    expect(pathValues(deltas, PATH.depth)).toEqual([10]);
    expect(pathValues(deltas, PATH.waterTemp)).toEqual([288.15]);
    // The sonar keeps talking (error status) but sends no new depth or temperature.
    for (let ms = 0; ms < DEPTH_HEARTBEAT_MS - 1000; ms += 1000) { vi.advanceTimersByTime(1000); t.feed(errMsg()); }
    expect(pathValues(deltas, PATH.depth)).toEqual([10]); // t = 4 s: not yet
    vi.advanceTimersByTime(1000); // t = 5 s
    expect(pathValues(deltas, PATH.depth)).toEqual([10, 10]);
    expect(pathValues(deltas, PATH.waterTemp)).toEqual([288.15]);
    for (let ms = DEPTH_HEARTBEAT_MS; ms < TEMP_HEARTBEAT_MS; ms += 1000) { t.feed(errMsg()); vi.advanceTimersByTime(1000); }
    expect(pathValues(deltas, PATH.waterTemp)).toEqual([288.15, 288.15]); // t = 10 s
    expect(pathValues(deltas, PATH.depth)).toEqual([10, 10, 10]); // and depth again at 10 s
    expect(e.state()).toMatchObject({ depthCm: 1000, waterTempCentiC: 1500 }); // still fresh
    e.stop();
  });

  test('a change the rate limit suppressed is flushed by the next tick, not lost until the next sample', () => {
    vi.useFakeTimers(FAKE_CLOCK);
    const t = new FakeTransport();
    const deltas: Delta[] = [];
    const e = new Engine(t, { onDelta: (d) => deltas.push(d) });
    e.start();
    t.feed(bottomMsg(1000));
    vi.advanceTimersByTime(100);
    t.feed(bottomMsg(1010)); // inside the 200 ms window: suppressed
    expect(pathValues(deltas, PATH.depth)).toEqual([10]);
    vi.advanceTimersByTime(900); // the 1 s tick re-feeds what the session holds
    expect(pathValues(deltas, PATH.depth)).toEqual([10, 10.1]);
    e.stop();
  });

  test('an invalid temperature before any value publishes nothing, also when the link drops', () => {
    const t = new FakeTransport();
    const deltas: Delta[] = [];
    const e = new Engine(t, { onDelta: (d) => deltas.push(d) });
    e.start();
    t.feed(envMsg(-0x8000));
    t.emit('link', 'lost', 'gone');
    expect(pathValues(deltas, PATH.waterTemp)).toEqual([]);
    t.emit('link', 'connected', 'back');
    t.feed(envMsg(1500));
    t.feed(envMsg(-0x8000));
    expect(pathValues(deltas, PATH.waterTemp)).toEqual([288.15, null]);
    e.stop();
  });

  test('null depth and temperature go out once after a lost link, not again from the watchdog', () => {
    vi.useFakeTimers(FAKE_CLOCK);
    const t = new FakeTransport();
    const deltas: Delta[] = [];
    const e = new Engine(t, { onDelta: (d) => deltas.push(d) });
    e.start();
    t.feed(bottomMsg(1000));
    t.feed(envMsg(1500));
    vi.advanceTimersByTime(3000);
    t.emit('link', 'lost', 'Trying to restore connection');
    expect(pathValues(deltas, PATH.depth)).toEqual([10, null]);
    expect(pathValues(deltas, PATH.waterTemp)).toEqual([288.15, null]);
    vi.advanceTimersByTime(15_000); // the watchdog would have found the data stale meanwhile
    expect(pathValues(deltas, PATH.depth)).toEqual([10, null]);
    expect(pathValues(deltas, PATH.waterTemp)).toEqual([288.15, null]);
    // The same the other way round: stale first, then the link reports it.
    t.emit('link', 'connected', 'back');
    t.feed(bottomMsg(1200));
    vi.advanceTimersByTime(7000); // heartbeat at 5 s, then stale (> 5 s without data) clears
    const seq = [10, null, 12, 12, null];
    expect(pathValues(deltas, PATH.depth)).toEqual(seq);
    t.emit('link', 'lost', 'again');
    t.emit('link', 'searching', 'gone');
    expect(pathValues(deltas, PATH.depth)).toEqual(seq);
    e.stop();
    expect(pathValues(deltas, PATH.depth)).toEqual(seq); // nothing left to clear
  });

  test('a replay wrap (connecting then connected) starts a new session that accepts older seqs', () => {
    const t = new FakeTransport();
    const deltas: Delta[] = [];
    const e = new Engine(t, { onDelta: (d) => deltas.push(d) });
    e.start();
    t.feed(channelSettings(0, 9, { gain: 10 }));
    t.feed(bottomMsg(1000));
    t.feed(channelSettings(0, 3, { gain: 20 })); // older seq: ignored within a session
    expect(e.session.channelSettings(0)!.gain).toBe(10);
    t.emit('link', 'connecting', 'Replaying again');
    t.emit('link', 'connected', 'Replaying');
    expect(pathValues(deltas, PATH.depth)).toEqual([10, null]);
    expect(e.session.channelSettings(0)).toBeNull();
    t.feed(channelSettings(0, 3, { gain: 20 }));
    expect(e.session.channelSettings(0)!.gain).toBe(20);
    expect(e.state().link).toBe('connected');
    e.stop();
  });

  test('range changes must leave the smallest preset window (30 cm) against the held settings', () => {
    const t = new FakeTransport();
    const e = new Engine(t);
    e.start();
    t.feed(channelSettings(0, 1, { shallow: 0, deep: 2000 }));
    t.feed(channelSettings(1, 1, { shallow: 0, deep: 2000 }));
    expect(e.setChannel('sonar', { rangeShallowCm: 1980 })).toMatch(/at least 30 cm/);
    expect(e.setChannel('sonar', { rangeShallowCm: 1970 })).toBeNull();
    e.stop();
  });
});
