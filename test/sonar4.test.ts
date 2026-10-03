import { describe, test, expect } from 'vitest';
import {
  MsgId, VERSION, CS, SS, MIN_LEN, messageId, parseHeader, isWellFormed, parseAnnounce, checkService, parseUnit,
  parseBottom, parseEnv, parseError, parseSystemStatus, parsePingResults, parsePingData, buildKeepalive, PingAssembler,
  parseChannelSettings, buildChannelSettings, parseSystemSettings, buildSystemSettings,
} from '../src/sonar4';
import { MAX_RANGE_CM } from '../src/shared/units';
import { msg, segment, channelSettings, systemSettings } from './helpers';

/** `b` seen through a view with a non-zero byteOffset, as a slice of a receive buffer would be. */
const offsetView = (b: Uint8Array): Buffer => Buffer.concat([Buffer.alloc(13, 0xee), b]).subarray(13);

test('parseHeader accepts 0x2701xx and rejects others / short input', () => {
  expect(parseHeader(msg(MsgId.ENV, 68))).toEqual({ id: MsgId.ENV, length: 68, version: 116, session: 7 });
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

test('parsePingResults needs 130 bytes, like the app', () => {
  const b = msg(MsgId.PING_RESULTS, 130, (x) => { x[16] = 9; x[95] = 1; x.writeInt32LE(0, 104); x.writeInt32LE(1500, 108); });
  expect(parsePingResults(b)).toEqual({ seq: 9, channel: 1, rangeStartCm: 0, rangeEndCm: 1500 });
  expect(parsePingResults(b.subarray(0, 129))).toBeNull();
  expect(MIN_LEN[MsgId.PING_RESULTS]).toBe(130);
  expect(MIN_LEN[MsgId.ENV]).toBe(68);
  expect(parseEnv(msg(MsgId.ENV, 67))).toBeNull();
});

test('parsePingData: header length bounds the samples', () => {
  const full = segment({ seq: 2, seg: 0, count: 1, total: 6, offset: 0, data: [1, 2, 3, 4, 5, 6] });
  const p = parsePingData(full)!;
  expect(p).toMatchObject({ error: 0, offset: 0, total: 6, dataType: 2, seq: 2, segment: 0, count: 1, setting: 5 });
  expect([...p.samples]).toEqual([1, 2, 3, 4, 5, 6]);
  // header length < 37 with a longer datagram
  expect(parsePingData(msg(MsgId.PING_DATA, 43, (b) => { b.writeUInt32LE(36, 4); b[35] = 1; }))).toBeNull();
  // header length truncates the samples
  const cut = Buffer.from(full); cut.writeUInt32LE(40, 4);
  expect([...parsePingData(cut)!.samples]).toEqual([1, 2, 3]);
  // header length beyond the datagram: the datagram end wins
  const over = Buffer.from(full); over.writeUInt32LE(100, 4);
  expect([...parsePingData(over)!.samples]).toEqual([1, 2, 3, 4, 5, 6]);
  expect(parsePingData(full.subarray(0, 36))).toBeNull();
  expect(parsePingData(msg(MsgId.BOTTOM, 43))).toBeNull();
});

test('parseUnit / parseAnnounce: wrong id or short input is null', () => {
  const u = Buffer.alloc(52); u.writeUInt32LE(1, 0); u.writeUInt32LE(63, 4);
  expect(parseUnit(u)).not.toBeNull();
  expect(parseUnit(u.subarray(0, 51))).toBeNull();
  const wrongId = Buffer.from(u); wrongId.writeUInt32LE(2, 0);
  expect(parseUnit(wrongId)).toBeNull();
  const a = Buffer.alloc(36); a.writeUInt32LE(39, 8); a.set([224, 0, 0, 1], 20); a.writeUInt32LE(5800, 24); a.set([192, 168, 0, 1], 28); a.writeUInt32LE(5801, 32);
  expect(parseAnnounce(a)).not.toBeNull();
  const notAnnounce = Buffer.from(a); notAnnounce.writeUInt32LE(1, 0);
  expect(parseAnnounce(notAnnounce)).toBeNull();
  expect(parseAnnounce(Buffer.alloc(0))).toBeNull();
});

test('parseUnit strips control characters from an uninitialised name field', () => {
  const b = Buffer.alloc(52);
  b.writeUInt32LE(1, 0); b.writeUInt32LE(63, 4); b.writeUInt32LE(0xc7c035c5, 8);
  b.set([0x01, 0x45, 0x37, 0x1f, 0x30, 0x7f, 0x85, 0x32, 0x39, 0x30, 0x20], 20); // no NUL anywhere in the 32 bytes
  b.fill(0x41, 31, 52);
  expect(parseUnit(b)!.name).toBe('E70290 AAAAAAAAAAAAAAAAAAAAA');
  expect(parseUnit(b)!.serial).toBe('c7c035c5');
});

test('parseSystemStatus cuts the text at the field end and trims it', () => {
  const b = msg(MsgId.SYS_STATUS, 1200, (x) => { x.fill(0x20, 39, 60); x.fill(0x58, 60, 1200); });
  const text = parseSystemStatus(b)!.text;
  expect(text).toBe('X'.repeat(1100 - 60));
  const nul = msg(MsgId.SYS_STATUS, 1063, (x) => { x.write('  Ready  ', 39, 'latin1'); x[1098] = 0x59; });
  expect(parseSystemStatus(nul)!.text).toBe('Ready');
  expect(parseSystemStatus(msg(MsgId.ENV, 1063))).toBeNull();
});

test('isWellFormed with header length 0; messageId on < 4 bytes', () => {
  const zero = msg(MsgId.BOTTOM, 22, (b) => b.writeUInt32LE(0, 4));
  expect(isWellFormed(zero, parseHeader(zero)!)).toBe(false);
  expect(messageId(Buffer.alloc(3))).toBeNull();
  expect(messageId(Buffer.alloc(0))).toBeNull();
  expect(messageId(msg(MsgId.ENV, 68))).toBe(MsgId.ENV);
});

test('every parser works on a view with a non-zero byteOffset', () => {
  expect(parseHeader(offsetView(msg(MsgId.ENV, 68)))).toEqual({ id: MsgId.ENV, length: 68, version: 116, session: 7 });
  const a = Buffer.alloc(36); a.writeUInt32LE(39, 8); a.set([239, 1, 2, 3], 20); a.writeUInt32LE(5801, 24); a.set([192, 168, 1, 1], 28); a.writeUInt32LE(5802, 32);
  expect(parseAnnounce(offsetView(a))).toEqual({ service: 39, group: '239.1.2.3', port: 5801, device: '192.168.1.1', ctrlPort: 5802 });
  const u = Buffer.alloc(52); u.writeUInt32LE(1, 0); u.writeUInt32LE(66, 4); u.writeUInt32LE(0x1f, 8); u.write('DF5', 20, 'latin1');
  expect(parseUnit(offsetView(u))).toEqual({ type: 66, serial: '1f', name: 'DF5' });
  expect(parseBottom(offsetView(msg(MsgId.BOTTOM, 22, (b) => { b[16] = 2; b.writeInt32LE(777, 17); b[21] = 1; })))).toEqual({ depthCm: 777, quality: 2, channel: 1 });
  expect(parseEnv(offsetView(msg(MsgId.ENV, 68, (b) => b.writeInt16LE(1234, 28))))).toEqual({ waterTempCentiC: 1234 });
  expect(parseError(offsetView(msg(MsgId.ERROR, 20, (b) => b.writeUInt32LE(0x101, 16))))).toEqual({ flags: 0x101, lowVoltage: true });
  expect(parseSystemStatus(offsetView(msg(MsgId.SYS_STATUS, 1063, (b) => { b[18] = 13; b[19] = 31; b.write('OK', 39, 'latin1'); })))).toEqual({ swMajor: 13, swMinor: 31, text: 'OK' });
  expect(parsePingResults(offsetView(msg(MsgId.PING_RESULTS, 130, (b) => { b[16] = 3; b[95] = 0; b.writeInt32LE(10, 104); b.writeInt32LE(900, 108); }))))
    .toEqual({ seq: 3, channel: 0, rangeStartCm: 10, rangeEndCm: 900 });
  const seg = parsePingData(offsetView(segment({ seq: 1, seg: 0, count: 1, total: 2, offset: 0, data: [7, 8] })))!;
  expect([...seg.samples]).toEqual([7, 8]);
  expect(parseChannelSettings(offsetView(channelSettings(4, 12, { gain: 33 })))).toMatchObject({ index: 4, seq: 12, gain: 33, name: 'CHIRP' });
  expect(parseSystemSettings(offsetView(systemSettings(9, 25, 2)))).toMatchObject({ seq: 9, transducerOffsetCm: 25, depthUnit: 2, name: 'Demo' });
  const built = parseChannelSettings(buildChannelSettings(offsetView(channelSettings(4, 12)), { gain: 44 }, 13))!;
  expect(built).toMatchObject({ seq: 13, gain: 44 });
  expect(parseSystemSettings(buildSystemSettings(offsetView(systemSettings(9)), { simulator: true }, 10))).toMatchObject({ seq: 10, simulator: true });
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
    // the app accepts exactly 94 bytes: a longer datagram with a 94 header is rejected too
    expect(parseChannelSettings(Buffer.concat([channelSettings(1, 1), Buffer.alloc(1)]))).toBeNull();
    expect(parseChannelSettings(channelSettings(1, 1).subarray(0, 93))).toBeNull();
  });

  test('parses the auto flags, percentages, enabled byte and name', () => {
    const b = channelSettings(2, 3);
    b[CS.NOISE_AUTO] = 2; b[CS.CONTRAST_AUTO] = 1; b[CS.CONTRAST] = 80; b[CS.NOISE] = 30;
    expect(parseChannelSettings(b)).toMatchObject({ noiseFilterAuto: true, contrastAuto: true, contrast: 80, noiseFilter: 30, enabled: true });
    b[CS.CONTRAST_AUTO] = 0; b[CS.NOISE_AUTO] = 0;
    expect(parseChannelSettings(b)).toMatchObject({ noiseFilterAuto: false, contrastAuto: false });
    expect(parseChannelSettings(channelSettings(2, 3, { enabled: 0 }))!.enabled).toBe(false);
    expect(parseChannelSettings(channelSettings(2, 3, { enabled: 0x80 }))!.enabled).toBe(false);
    expect(parseChannelSettings(channelSettings(2, 3, { enabled: 0xff }))!.enabled).toBe(false);
    // name without a NUL anywhere in its 32 bytes, and with control bytes in it
    const noNul = channelSettings(2, 3);
    noNul.fill(0x41, CS.NAME, CS.NAME + 32);
    expect(parseChannelSettings(noNul)!.name).toBe('A'.repeat(32));
    const ctrl = channelSettings(2, 3);
    ctrl.fill(0, CS.NAME, CS.NAME + 32);
    ctrl.set([0x07, 0x44, 0x1b, 0x56, 0x9f, 0x00, 0x58], CS.NAME); // garbage, then a NUL, then more
    expect(parseChannelSettings(ctrl)!.name).toBe('DV');
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

  test('build: every patch field, clamped range, ignored negative / NaN, too-short template', () => {
    const raw = channelSettings(2, 10, { rangeAuto: 1, shallow: 100, deep: 2000 });
    const out = Buffer.from(buildChannelSettings(raw, {
      rangeAuto: false, rangeShallowCm: 250.4, contrastAuto: true, noiseFilter: 42.6, noiseFilterAuto: false, rangeDeepCm: 1e12,
    }, 11));
    const p = parseChannelSettings(out)!;
    expect(p).toMatchObject({ rangeAuto: false, rangeShallowCm: 250, contrastAuto: true, noiseFilter: 43, noiseFilterAuto: false, rangeDeepCm: MAX_RANGE_CM });
    expect(out[CS.NOISE_AUTO]).toBe(0);
    const ignored = parseChannelSettings(buildChannelSettings(raw, { rangeShallowCm: -5, rangeDeepCm: NaN, gain: NaN, contrast: Infinity }, 11))!;
    expect(ignored).toMatchObject({ rangeShallowCm: 100, rangeDeepCm: 2000, gain: 50, contrast: 0 });
    expect(() => buildChannelSettings(raw.subarray(0, 93), {}, 11)).toThrow(/too short/);
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

  test('build clamps the offset to -300, writes simulator 0, rewrites the header length; parse edge cases', () => {
    const raw = systemSettings(5, 0, 1);
    raw.writeUInt32LE(600, 4); // a longer broadcast than we send back
    const longer = Buffer.concat([raw, Buffer.alloc(38)]);
    const out = Buffer.from(buildSystemSettings(longer, { transducerOffsetCm: -999, simulator: false }, 6));
    expect(out.length).toBe(562);
    expect(out.readUInt32LE(4)).toBe(562);
    expect(out.readInt32LE(SS.TRANSDUCER_OFFSET)).toBe(-300);
    expect(out[SS.SIMULATOR]).toBe(0);
    expect(() => buildSystemSettings(raw.subarray(0, 561), {}, 6)).toThrow(/too short/);
    expect(parseSystemSettings(raw.subarray(0, 561))).toBeNull();
    const sim = systemSettings(1, 0, 2); sim[SS.SIMULATOR] = 2;
    expect(parseSystemSettings(sim)).toMatchObject({ simulator: true, depthUnit: 2 });
    sim[SS.SIMULATOR] = 1;
    expect(parseSystemSettings(sim)!.simulator).toBe(false);
    expect(parseSystemSettings(systemSettings(1, 0, 0))!.depthUnit).toBe(0);
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

  test('drops overlapping or non-contiguous segments', () => {
    const a = new PingAssembler();
    a.push(parsePingData(segment({ seq: 1, seg: 0, count: 3, total: 6, offset: 0, data: [1, 1] })));
    expect(a.push(parsePingData(segment({ seq: 1, seg: 1, count: 3, total: 6, offset: 1, data: [2, 2] })))).toBeNull(); // overlaps
    expect(a.dropped).toBe(1);
    expect(a.push(parsePingData(segment({ seq: 1, seg: 2, count: 3, total: 6, offset: 4, data: [3, 3] })))).toBeNull(); // nothing to continue
    expect(a.dropped).toBe(1);
    a.push(parsePingData(segment({ seq: 2, seg: 0, count: 2, total: 6, offset: 0, data: [1, 1] })));
    expect(a.push(parsePingData(segment({ seq: 2, seg: 1, count: 2, total: 6, offset: 4, data: [2, 2] })))).toBeNull(); // hole
    expect(a.dropped).toBe(2);
  });

  test('a repeated segment 0 restarts the ping and counts the lost partial', () => {
    const a = new PingAssembler();
    a.addResults({ seq: 5, channel: 0, rangeStartCm: 0, rangeEndCm: 600 });
    a.push(parsePingData(segment({ seq: 5, seg: 0, count: 2, total: 4, offset: 0, data: [1, 1] })));
    expect(a.push(parsePingData(segment({ seq: 5, seg: 0, count: 2, total: 4, offset: 0, data: [7, 7] })))).toBeNull();
    expect(a.dropped).toBe(1);
    const col = a.push(parsePingData(segment({ seq: 5, seg: 1, count: 2, total: 4, offset: 2, data: [8, 8] })))!;
    expect([...col.samples]).toEqual([7, 7, 8, 8]);
  });

  test('segment 1 before any segment 0 is ignored without counting a drop', () => {
    const a = new PingAssembler();
    expect(a.push(parsePingData(segment({ seq: 3, seg: 1, count: 2, total: 4, offset: 2, data: [1, 1] })))).toBeNull();
    expect(a.dropped).toBe(0);
    expect(a.push(null)).toBeNull();
    expect(a.addResults(null)).toBeNull();
  });

  test('keeps the last 32 results', () => {
    const a = new PingAssembler();
    for (let i = 0; i < 33; i++) a.addResults({ seq: i, channel: 0, rangeStartCm: 0, rangeEndCm: 100 + i }, 0);
    expect(a.push(parsePingData(segment({ seq: 0, seg: 0, count: 1, total: 1, offset: 0, data: [1] })), 1)).toBeNull(); // evicted
    const col = a.push(parsePingData(segment({ seq: 1, seg: 0, count: 1, total: 1, offset: 0, data: [1] })), 1)!;
    expect(col.results!.rangeEndCm).toBe(101);
    const last = a.push(parsePingData(segment({ seq: 32, seg: 0, count: 1, total: 1, offset: 0, data: [1] })), 1)!;
    expect(last.results!.rangeEndCm).toBe(132);
  });
});
