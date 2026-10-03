// Pure "Sonar4" codec (docs/PROTOCOL.md). No I/O, no logging, no module state.
// Every parse* takes a Uint8Array (Buffer ok) and returns a plain object, or
// null when the datagram is too short / not the expected message.

import { MAX_TRANSDUCER_OFFSET_CM } from './shared/units';
export { MAX_TRANSDUCER_OFFSET_CM } from './shared/units';

export const VERSION = 116;
export const DISCOVERY = { group: '224.0.0.1', port: 5800 } as const;
export const SERVICE_SONAR = 39;
export const MAX_COLUMN = 1024;
export const HEADER_LEN = 16;
/** Ping configurations (channel settings indexes) the app waits for before reporting connected. */
export const PING_CONFIGS = 32;

export const MsgId = Object.freeze({
  ANNOUNCE: 0, UNIT: 1,
  KEEPALIVE: 0x270100, PING_DATA: 0x270101, CHAN_SETTINGS: 0x270102,
  SYS_STATUS: 0x270103, ENV: 0x270104, SYS_SETTINGS: 0x270106,
  BOTTOM: 0x270108, PING_RESULTS: 0x27010b, ERROR: 0x27010d,
});
/** Messages that must be seen before keepalive byte 16 = 1 (§3.4); also the unit id and all PING_CONFIGS channel settings. */
export const REQUIRED: readonly number[] = Object.freeze([MsgId.ENV, MsgId.ERROR, MsgId.SYS_STATUS, MsgId.SYS_SETTINGS, MsgId.CHAN_SETTINGS]);

/** Unit-type codes from discovery msg 1 (§2). */
export const UNIT_TYPES: Readonly<Record<number, string>> = Object.freeze({
  63: 'Wi-Fish dv', 66: 'Dragonfly-5 Pro', 67: 'Dragonfly-4 Pro', 78: 'Dragonfly-7 Pro',
});
export const UNIT_WIFISH = 63;

/** Sonar channel as reported by ping results off 95. */
export const Channel = Object.freeze({ SONAR: 0, DOWNVISION: 1 });
export type ChannelId = 0 | 1;

/** Error-status bit that means "supply voltage too low" (the app's low-voltage dialog). */
export const ERROR_LOW_VOLTAGE = 0x100;

/** Minimum datagram length each parser needs (the fields it reads). */
const MIN = { ANNOUNCE: 36, UNIT: 52, BOTTOM: 22, ENV: 30, ERROR: 20, PING_RESULTS: 112, PING_DATA: 37 };

/** Minimum message length the app accepts per id (PROTOCOL.md §5). Shorter = malformed. */
export const MIN_LEN: Readonly<Record<number, number>> = Object.freeze({
  [MsgId.PING_DATA]: 37, [MsgId.CHAN_SETTINGS]: 94, [MsgId.SYS_STATUS]: 1063, [MsgId.ENV]: 68,
  [MsgId.SYS_SETTINGS]: 562, [MsgId.BOTTOM]: 22, [MsgId.PING_RESULTS]: 130, [MsgId.ERROR]: 20,
});
export const CHAN_SETTINGS_LEN = 94;
export const SYS_SETTINGS_LEN = 562;

export interface Header { id: number; length: number; version: number; seq: number }

/** True when `b` is as long as both its header length field and the §5 minimum for its id. */
export function isWellFormed(b: Uint8Array, h: Header): boolean {
  const min = MIN_LEN[h.id] ?? HEADER_LEN;
  // Like the app, the header's own length must meet the minimum, not just the datagram.
  return h.length >= min && h.length <= b.length;
}

/** DataView over exactly `b`'s bytes (honours a subarray's offset). */
const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
/** Dotted-quad IPv4 address from the 4 bytes at offset `o`. */
const ip4 = (b: Uint8Array, o: number) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
/** Latin-1 string from a NUL-padded fixed-width field `[from, to)`, cut at the first NUL and trimmed. */
const cstr = (b: Uint8Array, from: number, to: number) =>
  new TextDecoder('latin1').decode(b.subarray(from, Math.min(to, b.length))).replace(/\0.*$/s, '').trim();

/** True for a message id of the 0x2701xx (sonar data and settings) family; discovery ids 0 and 1 are not. */
export const isSonarMessage = (id: number | null): id is number => id !== null && id >>> 8 === 0x2701;

/** Message id at offset 0, or null if < 4 bytes. */
export function messageId(b: Uint8Array): number | null {
  return b.length >= 4 ? dv(b).getUint32(0, true) : null;
}

/** Header of 0x2701xx messages only. */
export function parseHeader(b: Uint8Array): Header | null {
  if (b.length < HEADER_LEN) return null;
  const v = dv(b);
  const id = v.getUint32(0, true);
  if (!isSonarMessage(id)) return null;
  return { id, length: v.getUint32(4, true), version: v.getUint32(8, true), seq: v.getUint32(12, true) };
}

export interface Announce { service: number; group: string; port: number; device: string; ctrlPort: number }

/** Discovery msg 0. */
export function parseAnnounce(b: Uint8Array): Announce | null {
  if (b.length < MIN.ANNOUNCE || messageId(b) !== MsgId.ANNOUNCE) return null;
  const v = dv(b);
  return {
    service: v.getUint32(8, true),
    group: ip4(b, 20), port: v.getUint32(24, true),
    device: ip4(b, 28), ctrlPort: v.getUint32(32, true),
  };
}

/** True for an integer UDP port in 1..65535. */
const validPort = (p: number) => Number.isInteger(p) && p > 0 && p < 65536;

/**
 * Checks an announced sonar service before sockets are opened with it.
 * @param sender source address of the announcement; must match the announced device IP
 * @returns reason it is unusable, or null if ok
 */
export function checkService(s: Announce | null, sender?: string): string | null {
  if (!s) return 'malformed';
  const first = Number(s.group.split('.')[0]);
  if (first < 224 || first > 239) return `data group ${s.group} is not multicast`;
  if (!validPort(s.port)) return `bad data port ${s.port}`;
  if (!validPort(s.ctrlPort)) return `bad control port ${s.ctrlPort}`;
  if (sender !== undefined && sender !== s.device) return `device ${s.device} != sender ${sender}`;
  return null;
}

export interface Unit { type: number; serial: string; name: string }

/** Discovery msg 1. */
export function parseUnit(b: Uint8Array): Unit | null {
  if (b.length < MIN.UNIT || messageId(b) !== MsgId.UNIT) return null;
  const v = dv(b);
  return { type: v.getUint32(4, true), serial: v.getUint32(8, true).toString(16), name: cstr(b, 20, 52) };
}

export interface Bottom { depthCm: number | null; quality: number; channel: number }

/** 0x270108. depthCm null = no bottom lock (INT32_MIN). */
export function parseBottom(b: Uint8Array): Bottom | null {
  if (b.length < MIN.BOTTOM || messageId(b) !== MsgId.BOTTOM) return null;
  const d = dv(b).getInt32(17, true);
  return { depthCm: d === -0x80000000 ? null : d, quality: b[16], channel: b[21] };
}

/** 0x270104. waterTempCentiC null = invalid (INT16_MIN). Kept integer; convert at the edge. */
export function parseEnv(b: Uint8Array): { waterTempCentiC: number | null } | null {
  if (b.length < MIN.ENV || messageId(b) !== MsgId.ENV) return null;
  const t = dv(b).getInt16(28, true);
  return { waterTempCentiC: t === -0x8000 ? null : t };
}

/** 0x27010D. */
export function parseError(b: Uint8Array): { flags: number; lowVoltage: boolean } | null {
  if (b.length < MIN.ERROR || messageId(b) !== MsgId.ERROR) return null;
  const flags = dv(b).getUint32(16, true);
  return { flags, lowVoltage: (flags & ERROR_LOW_VOLTAGE) !== 0 };
}

export interface SystemStatus { swMajor: number; swMinor: number; text: string }

/** 0x270103. Software version is the i16 at off 18 (low byte major, high byte minor). */
export function parseSystemStatus(b: Uint8Array): SystemStatus | null {
  if (b.length < MIN_LEN[MsgId.SYS_STATUS] || messageId(b) !== MsgId.SYS_STATUS) return null;
  return { swMajor: b[18], swMinor: b[19], text: cstr(b, 39, 1100) };
}

export interface PingResults { seq: number; channel: number; rangeStartCm: number; rangeEndCm: number }

/** 0x27010B. */
export function parsePingResults(b: Uint8Array): PingResults | null {
  if (b.length < MIN.PING_RESULTS || messageId(b) !== MsgId.PING_RESULTS) return null;
  const v = dv(b);
  return { seq: b[16], channel: b[95], rangeStartCm: v.getInt32(104, true), rangeEndCm: v.getInt32(108, true) };
}

export interface PingSegment {
  error: number; offset: number; total: number; dataType: number; seq: number;
  segment: number; count: number; setting: number; samples: Uint8Array;
}

/** 0x270101 segment. `samples` is a view into b (copy before b is reused). */
export function parsePingData(b: Uint8Array): PingSegment | null {
  if (b.length < MIN.PING_DATA || messageId(b) !== MsgId.PING_DATA) return null;
  const v = dv(b);
  const len = Math.min(v.getUint32(4, true), b.length);
  if (len < MIN.PING_DATA) return null;
  return {
    error: v.getUint32(16, true), offset: v.getUint32(20, true), total: v.getUint32(24, true),
    dataType: b[32], seq: b[33], segment: b[34], count: b[35], setting: b[36],
    samples: b.subarray(37, len),
  };
}

/** 37-byte keepalive (§4). */
export function buildKeepalive({ connected = false, nowMs = Date.now() } = {}): Uint8Array {
  const k = new Uint8Array(37);
  const v = dv(k);
  v.setUint32(0, MsgId.KEEPALIVE, true); v.setUint32(4, 37, true); v.setUint32(8, VERSION, true);
  v.setUint32(12, 0xdeadbeef, true);
  v.setUint8(16, connected ? 1 : 0);
  v.setBigUint64(17, BigInt(Math.floor(nowMs / 1000)), true);
  v.setBigInt64(25, -1n, true);
  v.setInt32(33, -0x80000000, true);
  return k;
}

// ---------------------------------------------------------------------------
// Settings (§6). Both are read-modify-write: the device broadcasts its state,
// the client sends back a copy with some fields changed and seq (off 16) + 1.
// We patch a copy of the last received datagram so unknown bytes survive.
// ---------------------------------------------------------------------------

/** Byte offsets in the 94-byte sonar channel ("ping parameters") settings, 0x270102. */
export const CS = Object.freeze({
  SEQ: 16, INDEX: 20, NAME: 21, ENABLED: 55,
  RANGE_AUTO: 62, RANGE_SHALLOW: 63, RANGE_DEEP: 67,
  CONTRAST_AUTO: 76, CONTRAST: 77, GAIN_AUTO: 78, GAIN: 79, NOISE_AUTO: 80, NOISE: 81,
});

export interface ChannelSettings {
  seq: number;
  /** Ping configuration index (0..31); ping data off 36 names the one a column was made with. */
  index: number;
  name: string;
  enabled: boolean;
  rangeAuto: boolean;
  rangeShallowCm: number;
  rangeDeepCm: number;
  gainAuto: boolean;
  gain: number;
  contrastAuto: boolean;
  contrast: number;
  noiseFilterAuto: boolean;
  noiseFilter: number;
}

export type ChannelSettingsPatch = Partial<Pick<ChannelSettings,
  'rangeAuto' | 'rangeShallowCm' | 'rangeDeepCm' | 'gainAuto' | 'gain' | 'contrastAuto' | 'contrast' | 'noiseFilterAuto' | 'noiseFilter'>>;

/** 0x270102. The app rejects anything but exactly 94 bytes and indexes >= 32. */
export function parseChannelSettings(b: Uint8Array): ChannelSettings | null {
  if (b.length < CHAN_SETTINGS_LEN || messageId(b) !== MsgId.CHAN_SETTINGS) return null;
  const v = dv(b);
  if (v.getUint32(4, true) !== CHAN_SETTINGS_LEN || b[CS.INDEX] >= 32) return null;
  return {
    seq: v.getInt32(CS.SEQ, true),
    index: b[CS.INDEX],
    name: cstr(b, CS.NAME, CS.NAME + 32),
    enabled: b[CS.ENABLED] > 0 && b[CS.ENABLED] < 0x80, // the app reads it as a signed byte
    rangeAuto: b[CS.RANGE_AUTO] === 1,
    rangeShallowCm: v.getInt32(CS.RANGE_SHALLOW, true),
    rangeDeepCm: v.getInt32(CS.RANGE_DEEP, true),
    contrastAuto: b[CS.CONTRAST_AUTO] === 1,
    contrast: b[CS.CONTRAST],
    gainAuto: b[CS.GAIN_AUTO] === 1,
    gain: b[CS.GAIN],
    noiseFilterAuto: b[CS.NOISE_AUTO] > 0 && b[CS.NOISE_AUTO] < 0x80,
    noiseFilter: b[CS.NOISE],
  };
}

/** Round and clamp to a 0..100 percentage. */
const pct = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** Copy of a received 0x270102 with `patch` applied and seq set. Percentages are clamped to 0..100 (the app ignores values outside it). */
export function buildChannelSettings(raw: Uint8Array, patch: ChannelSettingsPatch, seq: number): Uint8Array {
  if (raw.length < CHAN_SETTINGS_LEN) throw new Error('channel settings template too short');
  const b = Uint8Array.from(raw.subarray(0, CHAN_SETTINGS_LEN));
  const v = dv(b);
  v.setInt32(CS.SEQ, seq, true);
  if (patch.rangeAuto !== undefined) b[CS.RANGE_AUTO] = patch.rangeAuto ? 1 : 0;
  if (patch.rangeShallowCm !== undefined && patch.rangeShallowCm >= 0) v.setInt32(CS.RANGE_SHALLOW, Math.round(patch.rangeShallowCm), true);
  if (patch.rangeDeepCm !== undefined && patch.rangeDeepCm >= 0) v.setInt32(CS.RANGE_DEEP, Math.round(patch.rangeDeepCm), true);
  if (patch.gainAuto !== undefined) b[CS.GAIN_AUTO] = patch.gainAuto ? 1 : 0;
  if (patch.gain !== undefined) b[CS.GAIN] = pct(patch.gain);
  if (patch.contrastAuto !== undefined) b[CS.CONTRAST_AUTO] = patch.contrastAuto ? 1 : 0;
  if (patch.contrast !== undefined) b[CS.CONTRAST] = pct(patch.contrast);
  if (patch.noiseFilterAuto !== undefined) b[CS.NOISE_AUTO] = patch.noiseFilterAuto ? 2 : 0;
  if (patch.noiseFilter !== undefined) b[CS.NOISE] = pct(patch.noiseFilter);
  return b;
}

/** Byte offsets in the 562-byte system settings, 0x270106. */
export const SS = Object.freeze({ SEQ: 16, NAME: 20, TRANSDUCER_OFFSET: 60, DEPTH_UNIT: 79, SIMULATOR: 80 });

export interface SystemSettings {
  seq: number;
  name: string;
  /**
   * cm. Positive = transducer below the waterline (reported depth is below surface),
   * negative = transducer above the keel (reported depth is below keel). 🟡 see PROTOCOL.md §6.
   */
  transducerOffsetCm: number;
  /** 0 feet, 1 metres, 2 fathoms. */
  depthUnit: number;
  simulator: boolean;
}
export type SystemSettingsPatch = Partial<Pick<SystemSettings, 'transducerOffsetCm' | 'simulator'>>;

/** 0x270106. */
export function parseSystemSettings(b: Uint8Array): SystemSettings | null {
  if (b.length < SYS_SETTINGS_LEN || messageId(b) !== MsgId.SYS_SETTINGS) return null;
  const v = dv(b);
  return {
    seq: v.getInt32(SS.SEQ, true),
    name: cstr(b, SS.NAME, SS.NAME + 32),
    transducerOffsetCm: v.getInt32(SS.TRANSDUCER_OFFSET, true),
    depthUnit: b[SS.DEPTH_UNIT],
    simulator: b[SS.SIMULATOR] === 2,
  };
}

/** Copy of a received 0x270106 with `patch` applied and seq set. */
export function buildSystemSettings(raw: Uint8Array, patch: SystemSettingsPatch, seq: number): Uint8Array {
  if (raw.length < SYS_SETTINGS_LEN) throw new Error('system settings template too short');
  const b = Uint8Array.from(raw.subarray(0, SYS_SETTINGS_LEN));
  const v = dv(b);
  v.setUint32(4, SYS_SETTINGS_LEN, true);
  v.setInt32(SS.SEQ, seq, true);
  if (patch.transducerOffsetCm !== undefined) {
    const o = Math.round(Math.max(-MAX_TRANSDUCER_OFFSET_CM, Math.min(MAX_TRANSDUCER_OFFSET_CM, patch.transducerOffsetCm)));
    v.setInt32(SS.TRANSDUCER_OFFSET, o, true);
  }
  if (patch.simulator !== undefined) b[SS.SIMULATOR] = patch.simulator ? 2 : 0;
  return b;
}

// ---------------------------------------------------------------------------
// Ping reassembly
// ---------------------------------------------------------------------------

export interface Column {
  seq: number;
  dataType: number;
  /** Ping configuration index (ping data off 36). */
  setting: number;
  samples: Uint8Array;
  filled: number;
  results: PingResults | null;
}

interface Partial_ { buf: Uint8Array; next: number; filled: number; t: number; dataType: number; setting: number }

/**
 * Reassembles 0x270101 segments into columns, keyed by ping seq (u8), and pairs
 * each column with the ping results (0x27010B) of the same seq in either order:
 * the app re-checks the pairing on both message types, so a column whose
 * results come later is held (up to `staleMs`) instead of dropped.
 * Faithful to the app: a column starts at segment 0, any gap drops it, it
 * completes at segment == count-1, and its length is the bytes received.
 * Adds bounds checks so a malformed segment is dropped instead of throwing or
 * allocating 4 GB, and expires partial columns and old results so a wrapped
 * seq can't be glued onto stale data.
 */
export class PingAssembler {
  #pings = new Map<number, Partial_>();
  #results = new Map<number, { r: PingResults; t: number }>();
  #waiting = new Map<number, { col: Column; t: number }>();
  dropped = 0;
  readonly staleMs: number;

  /** `staleMs`: how long partial columns, held results and waiting columns stay pairable. */
  constructor({ staleMs = 1000 } = {}) {
    this.staleMs = staleMs;
  }

  /**
   * Remember per-ping metadata for pairing (keeps the last 32). Returns the
   * column of the same seq if it completed before its results arrived.
   */
  addResults(r: PingResults | null, now = Date.now()): Column | null {
    if (!r) return null;
    const w = this.#waiting.get(r.seq);
    if (w) {
      this.#waiting.delete(r.seq);
      if (now - w.t <= this.staleMs) return { ...w.col, results: r };
    }
    this.#results.delete(r.seq);
    this.#results.set(r.seq, { r, t: now });
    if (this.#results.size > 32) this.#results.delete(this.#results.keys().next().value!);
    return null;
  }

  /** Returns a complete column paired with its results, or null (incomplete, dropped, or waiting for results). */
  push(s: PingSegment | null, now = Date.now()): Column | null {
    if (!s) return null;
    if (s.error !== 0 || s.count === 0 || s.segment >= s.count
        || s.total === 0 || s.total > MAX_COLUMN || s.offset + s.samples.length > s.total) {
      return this.#drop(s.seq);
    }
    let p = this.#pings.get(s.seq);
    if (s.segment === 0) {
      p = { buf: new Uint8Array(s.total), next: 0, filled: 0, t: now, dataType: s.dataType, setting: s.setting };
      this.#pings.set(s.seq, p);
    }
    if (!p || p.next !== s.segment || p.buf.length !== s.total || now - p.t > this.staleMs) return this.#drop(s.seq);
    p.buf.set(s.samples, s.offset);
    p.filled += s.samples.length;
    p.next++;
    if (s.segment !== s.count - 1) return null;
    this.#pings.delete(s.seq);
    const col: Column = {
      seq: s.seq, dataType: p.dataType, setting: p.setting,
      // The app scales the column over the bytes it received (e0.e.f()), not the announced total.
      samples: p.filled >= p.buf.length ? p.buf : p.buf.subarray(0, p.filled),
      filled: p.filled, results: null,
    };
    const res = this.#results.get(s.seq);
    if (res && now - res.t <= this.staleMs) {
      this.#results.delete(s.seq);
      return { ...col, results: res.r };
    }
    this.#waiting.set(s.seq, { col, t: now });
    for (const [k, w] of this.#waiting) if (now - w.t > this.staleMs) this.#waiting.delete(k);
    return null;
  }

  /** Discard the partial column for `seq` (counting it in `dropped` if one existed); always returns null. */
  #drop(seq: number): null {
    if (this.#pings.delete(seq)) this.dropped++;
    return null;
  }
}
