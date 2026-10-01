// In-process demo sonar. Speaks real Sonar4 datagrams (so the whole decode path
// is exercised) and honours settings commands: gain, contrast, noise filter,
// range and simulator all change what it sends back.

import { EventEmitter } from 'node:events';
import {
  VERSION, MsgId, PING_CONFIGS, CHAN_SETTINGS_LEN, SYS_SETTINGS_LEN, CS, SS, UNIT_WIFISH, messageId, parseChannelSettings,
  parseSystemSettings,
} from './sonar4';
import { DEPTH_UNITS, presetCm } from './shared/units';
import type { Transport, TransportEvents } from './transport';

export interface DemoOptions {
  /** 'dragonfly' = CHIRP sonar + DownVision, 'wifish' = DownVision only (like a Wi-Fish dv). */
  model?: 'dragonfly' | 'wifish';
  /** Pings per second per channel. */
  pingRate?: number;
  /** Deterministic scene for tests. */
  seed?: number;
}

const SESSION = 0x5eed;
const METRES = DEPTH_UNITS[1];

/** Zeroed datagram of `len` bytes with the common header (id, length, version, session) filled in. */
function header(id: number, len: number): { b: Uint8Array; v: DataView } {
  const b = new Uint8Array(len);
  const v = new DataView(b.buffer);
  v.setUint32(0, id, true); v.setUint32(4, len, true); v.setUint32(8, VERSION, true); v.setUint32(12, SESSION, true);
  return { b, v };
}
/** Write an ASCII string into a zeroed `max`-byte field, truncated to leave its NUL terminator. */
function putStr(b: Uint8Array, off: number, s: string, max: number): void {
  for (let i = 0; i < Math.min(s.length, max - 1); i++) b[off + i] = s.charCodeAt(i) & 0xff;
}

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Fish { x: number; depthCm: number; size: number }
interface Tree { x: number; width: number; heightCm: number }

export class DemoDevice extends EventEmitter<TransportEvents> implements Transport {
  readonly kind = 'demo' as const;
  readonly canSend = true;
  readonly model: 'dragonfly' | 'wifish';
  #rate: number;
  #rand: () => number;
  #timers: NodeJS.Timeout[] = [];
  #connected: NodeJS.Immediate | null = null;
  #chan = new Map<number, Uint8Array>();
  #sys: Uint8Array;
  #x = 0;
  #pingSeq = 0;
  #fish: Fish[] = [];
  #trees: Tree[] = [];
  #tempCentiC = 1530;
  #autoEnd = new Map<number, number>();

  /** Build the demo unit's settings: CHIRP and DownVision channels, the other ping configs disabled, metres. */
  constructor(opts: DemoOptions = {}) {
    super();
    this.model = opts.model ?? 'dragonfly';
    this.#rate = opts.pingRate !== undefined && opts.pingRate > 0 ? opts.pingRate : 12;
    this.#rand = rng(opts.seed ?? 42);
    this.#chan.set(0, this.#makeChannel(0, 'CHIRP 200kHz'));
    this.#chan.set(1, this.#makeChannel(1, 'DownVision 350kHz'));
    // A real unit reports all 32 ping configurations; the unused ones are disabled.
    for (let i = 2; i < PING_CONFIGS; i++) {
      const c = this.#makeChannel(i, `Config ${i}`);
      c[CS.ENABLED] = 0;
      this.#chan.set(i, c);
    }
    const { b, v } = header(MsgId.SYS_SETTINGS, SYS_SETTINGS_LEN);
    putStr(b, SS.NAME, 'Demo', 32);
    v.setInt32(SS.TRANSDUCER_OFFSET, 0, true);
    b[SS.DEPTH_UNIT] = 1;
    b[SS.SIMULATOR] = 0;
    this.#sys = b;
  }

  /** Channel settings datagram for ping config `index`: enabled, auto range 0-20 m, auto gain/contrast/noise. */
  #makeChannel(index: number, name: string): Uint8Array {
    const { b, v } = header(MsgId.CHAN_SETTINGS, CHAN_SETTINGS_LEN);
    b[CS.INDEX] = index;
    putStr(b, CS.NAME, name, 32);
    b[CS.ENABLED] = 1;
    b[CS.RANGE_AUTO] = 1;
    v.setInt32(CS.RANGE_SHALLOW, 0, true);
    v.setInt32(CS.RANGE_DEEP, 2000, true);
    b[CS.GAIN_AUTO] = 1; b[CS.GAIN] = 50;
    b[CS.CONTRAST_AUTO] = 1; b[CS.CONTRAST] = 50;
    b[CS.NOISE_AUTO] = 2; b[CS.NOISE] = 50;
    return b;
  }

  /** Report 'connecting', then send status every second and pings at the ping rate; 'connected' right after. */
  start(): void {
    if (this.#timers.length) return;
    this.emit('link', 'connecting', 'Connecting to demo sonar');
    this.#broadcast();
    this.#timers.push(setInterval(() => this.#broadcast(), 1000));
    this.#timers.push(setInterval(() => this.#ping(), 1000 / this.#rate));
    this.#connected = setImmediate(() => { this.#connected = null; this.emit('link', 'connected', 'Demo sonar'); });
  }

  /** Cancel all timers and report the link 'offline'. */
  stop(): void {
    if (this.#connected) clearImmediate(this.#connected);
    this.#connected = null;
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
    this.emit('link', 'offline', 'stopped');
  }

  /** Commands from the client: apply settings like a device would, then echo them. */
  send(b: Uint8Array): void {
    const id = messageId(b);
    if (id === MsgId.CHAN_SETTINGS) {
      const s = parseChannelSettings(b);
      if (s && this.#chan.has(s.index)) {
        this.#chan.set(s.index, Uint8Array.from(b));
        this.emit('datagram', Uint8Array.from(b));
      }
    } else if (id === MsgId.SYS_SETTINGS && parseSystemSettings(b)) {
      this.#sys = Uint8Array.from(b);
      this.emit('datagram', Uint8Array.from(b));
    }
  }

  /** Transducer offset from the current system settings, cm. */
  get #offsetCm(): number { return new DataView(this.#sys.buffer).getInt32(SS.TRANSDUCER_OFFSET, true); }

  /** Once-a-second status burst: unit, environment (water temp), errors, system status and all settings. */
  #broadcast(): void {
    const unit = new Uint8Array(52);
    const uv = new DataView(unit.buffer);
    uv.setUint32(0, MsgId.UNIT, true);
    uv.setUint32(4, this.model === 'wifish' ? UNIT_WIFISH : 67, true);
    uv.setUint32(8, 0xde304, true);
    putStr(unit, 20, this.model === 'wifish' ? 'Wi-Fish (demo)' : 'Dragonfly-4 PRO (demo)', 32);
    this.emit('datagram', unit);

    this.#tempCentiC += Math.round((this.#rand() - 0.5) * 6);
    this.#tempCentiC = Math.max(1200, Math.min(1900, this.#tempCentiC));
    const env = header(MsgId.ENV, 68);
    env.v.setInt16(28, this.#tempCentiC, true);
    this.emit('datagram', env.b);

    const err = header(MsgId.ERROR, 20);
    this.emit('datagram', err.b);

    const st = header(MsgId.SYS_STATUS, 1063);
    st.b[18] = 3; st.b[19] = 12;
    putStr(st.b, 39, 'Demo sonar OK', 64);
    this.emit('datagram', st.b);

    this.emit('datagram', Uint8Array.from(this.#sys));
    for (const c of this.#chan.values()) this.emit('datagram', Uint8Array.from(c));
  }

  // ---------------------------------------------------------------- scene

  /** Bottom below the transducer, cm, at along-track position x (one unit per ping). */
  #bottomAt(x: number): number {
    const d = 900 + 380 * Math.sin(x / 520) + 170 * Math.sin(x / 131 + 1.3) + 45 * Math.sin(x / 29);
    return Math.max(250, d);
  }

  /** Move one ping along track, occasionally spawning fish and trees ahead and dropping those passed. */
  #advanceScene(): void {
    this.#x++;
    const x = this.#x;
    if (this.#rand() < 0.02) {
      const b = this.#bottomAt(x + 60);
      this.#fish.push({ x: x + 60, depthCm: 150 + this.#rand() * (b - 250), size: 0.5 + this.#rand() });
    }
    if (this.#rand() < 0.004) this.#trees.push({ x: x + 80, width: 15 + this.#rand() * 30, heightCm: 100 + this.#rand() * 250 });
    this.#fish = this.#fish.filter((f) => f.x > x - 60);
    this.#trees = this.#trees.filter((t) => t.x + t.width > x - 10);
  }

  /** One ping: advance the scene, send each channel's results and data, then the bottom depth message. */
  #ping(): void {
    this.#advanceScene();
    const bottom = this.#bottomAt(this.#x);
    const channels = this.model === 'wifish' ? [1] : [0, 1];
    for (const ch of channels) this.#pingChannel(ch, bottom);
    const bot = header(MsgId.BOTTOM, 22);
    bot.b[16] = 3;
    bot.v.setInt32(17, Math.round(bottom + this.#offsetCm), true);
    bot.b[21] = this.model === 'wifish' ? 1 : 0;
    this.emit('datagram', bot.b);
  }

  /** Send one channel's ping results and its column, split into 400-sample PING_DATA segments. */
  #pingChannel(ch: number, bottom: number): void {
    const cfg = this.#chan.get(ch)!;
    const cv = new DataView(cfg.buffer);
    const auto = cfg[CS.RANGE_AUTO] === 1;
    let start = 0;
    let end: number;
    if (auto) {
      // Auto range with hysteresis: step up when the bottom nears the edge, down when it is far above it.
      const cur = this.#autoEnd.get(ch) ?? 0;
      if (!(cur > 0) || bottom > cur * 0.85 || bottom < cur * 0.4) {
        const want = bottom * 1.35;
        const i = METRES.ranges.findIndex((_, k) => presetCm(METRES, k) >= want);
        this.#autoEnd.set(ch, presetCm(METRES, i < 0 ? METRES.ranges.length - 1 : i));
      }
      end = this.#autoEnd.get(ch)!;
    } else {
      start = cv.getInt32(CS.RANGE_SHALLOW, true);
      end = Math.max(start + 100, cv.getInt32(CS.RANGE_DEEP, true));
    }
    const seq = this.#pingSeq = (this.#pingSeq + 1) & 0xff;

    const res = header(MsgId.PING_RESULTS, 130);
    res.b[16] = seq;
    res.b[95] = ch;
    res.v.setInt32(104, start, true);
    res.v.setInt32(108, end, true);
    this.emit('datagram', res.b);

    const n = ch === 0 ? 600 : 800;
    const samples = this.#column(ch, n, end, bottom, cfg);
    const segLen = 400;
    const count = Math.ceil(n / segLen);
    for (let s = 0; s < count; s++) {
      const part = samples.subarray(s * segLen, Math.min(n, (s + 1) * segLen));
      const { b, v } = header(MsgId.PING_DATA, 37 + part.length);
      v.setUint32(16, 0, true); v.setUint32(20, s * segLen, true); v.setUint32(24, n, true);
      b[32] = ch; b[33] = seq; b[34] = s; b[35] = count; b[36] = ch;
      b.set(part, 37);
      this.emit('datagram', b);
    }
  }

  /** Synthesize an `n`-sample column down to `endCm`, shaped by the channel's gain, contrast and noise filter. */
  #column(ch: number, n: number, endCm: number, bottom: number, cfg: Uint8Array): Uint8Array {
    const gain = cfg[CS.GAIN_AUTO] === 1 ? 50 : cfg[CS.GAIN];
    const contrast = cfg[CS.CONTRAST_AUTO] === 1 ? 50 : cfg[CS.CONTRAST];
    const noise = cfg[CS.NOISE_AUTO] > 0 ? 50 : cfg[CS.NOISE];
    const g = 0.35 + (gain / 100) * 1.3;
    const gamma = 1.6 - contrast / 100;
    const noiseAmp = (1 - noise / 100) * (ch === 0 ? 70 : 45) + 6;
    const out = new Uint8Array(n);
    const x = this.#x;
    const cmPer = endCm / n;
    for (let i = 0; i < n; i++) {
      const z = (i + 0.5) * cmPer;
      let v = 0;
      // Surface clutter and near-field ringing.
      if (z < 80) v += 230 * Math.exp(-z / 25);
      // Speckle / plankton, stronger around a thermocline.
      const thermo = Math.exp(-(((z - 420) / 70) ** 2));
      v += this.#rand() * noiseAmp * (0.4 + thermo * (ch === 0 ? 1.3 : 0.6));
      // Bottom: hard return, then a long (CHIRP) or short textured (DownVision) tail.
      if (z >= bottom) {
        const dz = z - bottom;
        if (ch === 0) {
          v += 255 * Math.exp(-dz / 25) + 215 * Math.exp(-dz / (bottom * 0.6)) * (0.8 + 0.2 * this.#rand());
        } else {
          const tex = 0.6 + 0.4 * Math.sin(z / 9 + x / 7) * Math.sin(z / 23 - x / 13);
          v += (230 * Math.exp(-dz / 40) + 120 * Math.exp(-dz / 220)) * tex;
        }
      }
      // Second bottom echo.
      if (ch === 0 && Math.abs(z - 2 * bottom) < 60) v += 70 * (1 - Math.abs(z - 2 * bottom) / 60);
      out[i] = Math.max(0, Math.min(255, 255 * Math.pow(Math.min(1, (v * g) / 255), gamma)));
    }
    // Fish: arches on CHIRP (range grows off-axis), short streaks on DownVision.
    for (const f of this.#fish) {
      const dx = x - f.x;
      const half = ch === 0 ? 22 * f.size : 6 * f.size;
      if (Math.abs(dx) > half) continue;
      const apparent = ch === 0 ? Math.sqrt(f.depthCm ** 2 + (dx * 13) ** 2) : f.depthCm;
      const strength = 255 * g * f.size * (1 - (Math.abs(dx) / half) ** 2);
      const thick = ch === 0 ? 10 : 5;
      this.#blob(out, apparent / cmPer, thick * f.size / cmPer + 1, strength);
    }
    // Submerged trees (DownVision shows them best).
    for (const t of this.#trees) {
      const dx = x - t.x;
      if (dx < 0 || dx > t.width) continue;
      const u = dx / t.width;
      const top = bottom - t.heightCm * Math.sin(Math.PI * u) * (0.7 + 0.3 * Math.sin(dx * 1.7));
      for (let z = Math.max(0, top); z < bottom; z += cmPer) {
        const branch = Math.abs(Math.sin(z / 17 + dx * 0.9)) > 0.75 ? 1 : 0.25;
        const i = Math.floor(z / cmPer);
        if (i < n) out[i] = Math.max(out[i], Math.min(255, (ch === 1 ? 190 : 110) * branch * g));
      }
    }
    return out;
  }

  /** Max-blend a Gaussian echo centred on sample `centre` into the column. */
  #blob(out: Uint8Array, centre: number, radius: number, strength: number): void {
    const from = Math.max(0, Math.floor(centre - radius * 2));
    const to = Math.min(out.length - 1, Math.ceil(centre + radius * 2));
    for (let i = from; i <= to; i++) {
      const w = Math.exp(-(((i - centre) / radius) ** 2));
      out[i] = Math.max(out[i], Math.min(255, strength * w));
    }
  }
}
