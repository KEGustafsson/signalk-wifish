import { describe, test, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Engine } from '../src/engine';
import { DemoDevice } from '../src/demo';
import { MsgId, messageId, parseChannelSettings } from '../src/sonar4';
import type { Transport, TransportEvents } from '../src/transport';
import type { Delta } from '../src/signalk';
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
