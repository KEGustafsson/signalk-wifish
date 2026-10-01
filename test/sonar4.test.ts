import { describe, test, expect } from 'vitest';
import {
  MsgId, VERSION, CS, SS, parseHeader, isWellFormed, parseAnnounce, checkService, parseUnit, parseBottom, parseEnv,
  parseError, parseSystemStatus, parsePingResults, parsePingData, buildKeepalive, PingAssembler, parseChannelSettings,
  buildChannelSettings, parseSystemSettings, buildSystemSettings,
} from '../src/sonar4';
import { msg, segment, channelSettings, systemSettings } from './helpers';

test('parseHeader accepts 0x2701xx and rejects others / short input', () => {
  expect(parseHeader(msg(MsgId.ENV, 68))).toEqual({ id: MsgId.ENV, length: 68, version: 116, seq: 7 });
  expect(parseHeader(Buffer.alloc(15))).toBeNull();
  expect(parseHeader(msg(0x123456, 16))).toBeNull();
});

test('parseAnnounce decodes sonar service (§2)', () => {
  const b = Buffer.alloc(36);
  b.writeUInt32LE(39, 8); b.set([239, 1, 2, 3], 20); b.writeUInt32LE(5801, 24);
  b.set([192, 168, 1, 1], 28); b.writeUInt32LE(5802, 32);
  expect(parseAnnounce(b)).toEqual({ service: 39, group: '239.1.2.3', port: 5801, device: '192.168.1.1', ctrlPort: 5802 });
  expect(parseAnnounce(b.subarray(0, 35))).toBeNull();
});

test('checkService rejects unusable announcements', () => {
  const s = { service: 39, group: '239.1.2.3', port: 5801, device: '192.168.1.1', ctrlPort: 5802 };
  expect(checkService(s, '192.168.1.1')).toBeNull();
  expect(checkService(s)).toBeNull();
  expect(checkService({ ...s, group: '10.0.0.1' })).toMatch(/not multicast/);
  expect(checkService({ ...s, port: 70000 })).toMatch(/data port/);
  expect(checkService({ ...s, ctrlPort: 0 })).toMatch(/control port/);
  expect(checkService(s, '192.168.1.66')).toMatch(/sender/);
  expect(checkService(null)).toBe('malformed');
});

test('isWellFormed enforces §5 minimum and header length', () => {
  const env = msg(MsgId.ENV, 68);
  expect(isWellFormed(env, parseHeader(env)!)).toBe(true);
  const short = msg(MsgId.ENV, 29);
  expect(isWellFormed(short, parseHeader(short)!)).toBe(false);
  const cut = msg(MsgId.ENV, 80).subarray(0, 70);
  expect(isWellFormed(cut, parseHeader(cut)!)).toBe(false);
  const shortHeader = msg(MsgId.ENV, 68, (b) => b.writeUInt32LE(20, 4)); // 68 bytes, header says 20
  expect(isWellFormed(shortHeader, parseHeader(shortHeader)!)).toBe(false);
  const unknown = msg(0x270109, 16);
  expect(isWellFormed(unknown, parseHeader(unknown)!)).toBe(true);
});

test('parseUnit strips NUL padding', () => {
  const b = Buffer.alloc(52);
  b.writeUInt32LE(1, 0); b.writeUInt32LE(63, 4); b.writeUInt32LE(0xabc123, 8); b.write('Wi-Fish', 20, 'latin1');
  expect(parseUnit(b)).toEqual({ type: 63, serial: 'abc123', name: 'Wi-Fish' });
});

test('parseBottom: depth in cm, INT32_MIN = no lock, short = null', () => {
  const ok = msg(MsgId.BOTTOM, 22, (b) => { b[16] = 3; b.writeInt32LE(1234, 17); b[21] = 1; });
  expect(parseBottom(ok)).toEqual({ depthCm: 1234, quality: 3, channel: 1 });
  expect(parseBottom(msg(MsgId.BOTTOM, 22, (b) => b.writeInt32LE(-0x80000000, 17)))!.depthCm).toBeNull();
  expect(parseBottom(ok.subarray(0, 18))).toBeNull();
});

test('parseEnv: centi-degC, INT16_MIN = invalid', () => {
  expect(parseEnv(msg(MsgId.ENV, 68, (b) => b.writeInt16LE(-150, 28)))!.waterTempCentiC).toBe(-150);
  expect(parseEnv(msg(MsgId.ENV, 68, (b) => b.writeInt16LE(-0x8000, 28)))!.waterTempCentiC).toBeNull();
  expect(parseEnv(msg(MsgId.ENV, 29))).toBeNull();
});

test('parseError flags low voltage (bit 0x100)', () => {
  expect(parseError(msg(MsgId.ERROR, 20, (b) => b.writeUInt32LE(0x100, 16)))).toEqual({ flags: 0x100, lowVoltage: true });
  expect(parseError(msg(MsgId.ERROR, 20))!.lowVoltage).toBe(false);
});

test('parseSystemStatus reads the software version and status text', () => {
  const b = msg(MsgId.SYS_STATUS, 1063, (x) => { x[18] = 3; x[19] = 12; x.write('OK', 39, 'latin1'); });
  expect(parseSystemStatus(b)).toEqual({ swMajor: 3, swMinor: 12, text: 'OK' });
  expect(parseSystemStatus(b.subarray(0, 1000))).toBeNull();
});

test('parsePingResults needs 112 bytes', () => {
  const b = msg(MsgId.PING_RESULTS, 130, (x) => { x[16] = 9; x[95] = 1; x.writeInt32LE(0, 104); x.writeInt32LE(1500, 108); });
  expect(parsePingResults(b)).toEqual({ seq: 9, channel: 1, rangeStartCm: 0, rangeEndCm: 1500 });
  expect(parsePingResults(b.subarray(0, 111))).toBeNull();
});

test('buildKeepalive matches §4 layout', () => {
  const k = Buffer.from(buildKeepalive({ connected: true, nowMs: 1_700_000_000_999 }));
  expect(k.length).toBe(37);
  expect(k.readUInt32LE(0)).toBe(0x270100);
  expect(k.readUInt32LE(4)).toBe(37);
  expect(k.readUInt32LE(8)).toBe(116);
  expect(k.readUInt32LE(12)).toBe(0xdeadbeef);
  expect(k[16]).toBe(1);
  expect(k.readBigUInt64LE(17)).toBe(1_700_000_000n);
  expect(k.readBigInt64LE(25)).toBe(-1n);
  expect(k.readInt32LE(33)).toBe(-0x80000000);
});

describe('channel settings 0x270102', () => {
  test('parse', () => {
    const s = parseChannelSettings(channelSettings(3, 41, { rangeAuto: 0, shallow: 100, deep: 1800, gain: 70, gainAuto: 0 }))!;
    expect(s).toMatchObject({ seq: 41, index: 3, name: 'CHIRP', enabled: true, rangeAuto: false, rangeShallowCm: 100, rangeDeepCm: 1800, gain: 70, gainAuto: false });
  });

  test('reads the enabled and noise-auto bytes as signed, like the app', () => {
    const b = channelSettings(1, 1);
    b[CS.ENABLED] = 0x90; b[CS.NOISE_AUTO] = 0x90;
    expect(parseChannelSettings(b)).toMatchObject({ enabled: false, noiseFilterAuto: false });
  });

  test('rejects wrong size and index >= 32, like the app', () => {
    const b = channelSettings(1, 1);
    b.writeUInt32LE(95, 4);
    expect(parseChannelSettings(b)).toBeNull();
    expect(parseChannelSettings(channelSettings(32, 1))).toBeNull();
  });

  test('build patches a copy, keeps unknown bytes, clamps percentages', () => {
    const raw = channelSettings(2, 10);
    const out = Buffer.from(buildChannelSettings(raw, { gain: 150, gainAuto: false, contrast: -3, noiseFilterAuto: true, rangeDeepCm: 3000 }, 11));
    expect(raw.readInt32LE(CS.SEQ)).toBe(10); // template untouched
    expect(out.readInt32LE(CS.SEQ)).toBe(11);
    expect(out[CS.GAIN]).toBe(100);
    expect(out[CS.GAIN_AUTO]).toBe(0);
    expect(out[CS.CONTRAST]).toBe(0);
    expect(out[CS.NOISE_AUTO]).toBe(2);
    expect(out.readInt32LE(CS.RANGE_DEEP)).toBe(3000);
    expect(out[73]).toBe(0xab);
    expect(out.readUInt32LE(8)).toBe(VERSION);
    expect(out.length).toBe(94);
  });
});

describe('system settings 0x270106', () => {
  test('parse + build round trip', () => {
    const raw = systemSettings(5, -40, 0);
    expect(parseSystemSettings(raw)).toEqual({ seq: 5, name: 'Demo', transducerOffsetCm: -40, depthUnit: 0, simulator: false });
    const out = Buffer.from(buildSystemSettings(raw, { transducerOffsetCm: 999, simulator: true }, 6));
    const p = parseSystemSettings(out)!;
    expect(p.seq).toBe(6);
    expect(p.transducerOffsetCm).toBe(300); // clamped to the app's ±300 cm
    expect(p.simulator).toBe(true);
    expect(out[SS.SIMULATOR]).toBe(2);
    expect(out[200]).toBe(0x5a);
  });
});

describe('PingAssembler', () => {
  test('reassembles in-order segments and pairs results', () => {
    const a = new PingAssembler();
    a.addResults({ seq: 4, channel: 0, rangeStartCm: 0, rangeEndCm: 600 });
    expect(a.push(parsePingData(segment({ seq: 4, seg: 0, count: 2, total: 4, offset: 0, data: [1, 2] })))).toBeNull();
    const col = a.push(parsePingData(segment({ seq: 4, seg: 1, count: 2, total: 4, offset: 2, data: [3, 4] })))!;
    expect([...col.samples]).toEqual([1, 2, 3, 4]);
    expect(col.results!.rangeEndCm).toBe(600);
    expect(col.dataType).toBe(2);
    expect(col.setting).toBe(5);
  });

  test('drops a ping on a gap, and interleaved seqs are independent', () => {
    const a = new PingAssembler();
    a.addResults({ seq: 2, channel: 1, rangeStartCm: 0, rangeEndCm: 900 });
    a.push(parsePingData(segment({ seq: 1, seg: 0, count: 3, total: 6, offset: 0, data: [1, 1] })));
    const two = a.push(parsePingData(segment({ seq: 2, seg: 0, count: 1, total: 2, offset: 0, data: [9, 9] })))!;
    expect([...two.samples]).toEqual([9, 9]);
    expect(a.push(parsePingData(segment({ seq: 1, seg: 2, count: 3, total: 6, offset: 4, data: [3, 3] })))).toBeNull();
    expect(a.dropped).toBe(1);
  });

  test('rejects malformed segments without throwing or huge allocs', () => {
    const a = new PingAssembler();
    const bad = [
      segment({ seq: 1, seg: 0, count: 1, total: 0xffffffff, offset: 0, data: [1] }),
      segment({ seq: 1, seg: 0, count: 1, total: 4, offset: 3, data: [1, 2] }),
      segment({ seq: 1, seg: 1, count: 1, total: 4, offset: 0, data: [1] }),
      segment({ seq: 1, seg: 0, count: 1, total: 4, offset: 0, data: [1], error: 1 }),
    ];
    for (const b of bad) expect(a.push(parsePingData(b))).toBeNull();
    expect(a.push(parsePingData(Buffer.alloc(36)))).toBeNull();
  });

  test('expires a stale partial column (seq wrap)', () => {
    const a = new PingAssembler({ staleMs: 1000 });
    a.push(parsePingData(segment({ seq: 3, seg: 0, count: 2, total: 4, offset: 0, data: [1, 1] })), 0);
    expect(a.push(parsePingData(segment({ seq: 3, seg: 1, count: 2, total: 4, offset: 2, data: [2, 2] })), 5000)).toBeNull();
    expect(a.dropped).toBe(1);
  });

  test('a column is as long as the bytes received, like the app', () => {
    const a = new PingAssembler();
    a.addResults({ seq: 6, channel: 0, rangeStartCm: 0, rangeEndCm: 600 });
    a.push(parsePingData(segment({ seq: 6, seg: 0, count: 2, total: 8, offset: 0, data: [1, 2] })));
    const col = a.push(parsePingData(segment({ seq: 6, seg: 1, count: 2, total: 8, offset: 2, data: [3, 4] })))!;
    expect([...col.samples]).toEqual([1, 2, 3, 4]);
    expect(col.filled).toBe(4);
  });

  test('pairs results that arrive after the ping data', () => {
    const a = new PingAssembler();
    expect(a.push(parsePingData(segment({ seq: 8, seg: 0, count: 1, total: 2, offset: 0, data: [5, 6] })), 0)).toBeNull();
    const col = a.addResults({ seq: 8, channel: 1, rangeStartCm: 0, rangeEndCm: 700 }, 10)!;
    expect([...col.samples]).toEqual([5, 6]);
    expect(col.results!.channel).toBe(1);
  });

  test('does not pair with stale results or a stale waiting column', () => {
    const a = new PingAssembler({ staleMs: 1000 });
    a.addResults({ seq: 9, channel: 0, rangeStartCm: 0, rangeEndCm: 700 }, 0);
    expect(a.push(parsePingData(segment({ seq: 9, seg: 0, count: 1, total: 1, offset: 0, data: [1] })), 5000)).toBeNull();
    expect(a.addResults({ seq: 9, channel: 0, rangeStartCm: 0, rangeEndCm: 700 }, 9000)).toBeNull();
  });
});
