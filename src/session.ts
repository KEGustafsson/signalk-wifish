// Sonar4 session state: decodes datagrams from any transport (UDP device, demo
// device, capture replay) and keeps what the app keeps. Builds settings commands.
// No I/O here; the owner sends what build* returns.

import { EventEmitter } from 'node:events';
import {
  VERSION, MsgId, REQUIRED, PING_CONFIGS, messageId, parseHeader, isWellFormed, parseUnit, parseBottom, parseEnv,
  parseError, parseSystemStatus, parsePingResults, parsePingData, parseChannelSettings, parseSystemSettings,
  buildChannelSettings, buildSystemSettings, PingAssembler,
  type Unit, type SystemStatus, type ChannelSettings, type SystemSettings, type ChannelSettingsPatch,
  type SystemSettingsPatch, type ChannelId,
} from './sonar4';

export interface SessionColumn {
  channel: ChannelId;
  configIndex: number;
  seq: number;
  /** Samples cover 0 .. endCm below the transducer (one byte each, 0 = no return). */
  samples: Uint8Array;
  /** Default view window: range start / end in cm below the transducer. */
  startCm: number;
  endCm: number;
}

interface Held<T> { parsed: T; raw: Uint8Array }
/** A settings change sent to the sonar and not yet confirmed by its broadcasts. */
interface Pending<T, P> extends Held<T> {
  sentAt: number;
  sends: number;
  /** The sonar broadcast older settings after our last send: the change did not land (yet). */
  stale: boolean;
  /**
   * Our change, cumulative over the unconfirmed changes it was built on, so a resend can be
   * rebuilt on whatever the sonar holds now (another client may have changed it meanwhile).
   */
  patch: P;
}

/** Resend an unconfirmed settings change after this long (UDP may drop it). */
export const RESEND_MS = 1000;
/** Sends per change; after that, evidence it did not land restores the sonar's own values. */
export const MAX_SENDS = 3;

export interface SessionEvents {
  unit: [Unit];
  bottom: [number | null];
  temperature: [number | null];
  errorFlags: [number];
  systemStatus: [SystemStatus];
  systemSettings: [SystemSettings];
  channelSettings: [ChannelSettings];
  column: [SessionColumn];
  warn: [string];
}

/** Byte-for-byte equality of two datagrams. */
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export class Sonar4Session extends EventEmitter<SessionEvents> {
  readonly seen = new Map<number, number>();
  asm = new PingAssembler();
  unit: Unit | null = null;
  bottomCm: number | null = null;
  waterTempCentiC: number | null = null;
  errorFlags: number | null = null;
  systemStatus: SystemStatus | null = null;
  /** Settings as the sonar last broadcast them. */
  #system: Held<SystemSettings> | null = null;
  #channels = new Map<number, Held<ChannelSettings>>();
  /** Changes we sent that the sonar has not confirmed yet; shown in place of its values meanwhile. */
  #pendingSystem: Pending<SystemSettings, SystemSettingsPatch> | null = null;
  #pendingChannels = new Map<number, Pending<ChannelSettings, ChannelSettingsPatch>>();
  /** Ping configuration index last seen per channel (0 = sonar, 1 = DownVision). */
  readonly configIndex: [number | null, number | null] = [null, null];
  #warned = new Set<string>();

  /** System settings: our unconfirmed change if any, else the device's; null before any arrived. */
  get system(): SystemSettings | null {
    return this.#pendingSystem?.parsed ?? this.#system?.parsed ?? null;
  }
  /** System settings as the sonar last broadcast them (what it applies to the depth it reports). */
  get deviceSystem(): SystemSettings | null {
    return this.#system?.parsed ?? null;
  }
  /** Settings for ping configuration `index` (our unconfirmed change if any), or null if not received. */
  channelSettings(index: number | null): ChannelSettings | null {
    if (index === null) return null;
    return this.#pendingChannels.get(index)?.parsed ?? this.#channels.get(index)?.parsed ?? null;
  }
  /** Whether a settings change still waits for the sonar's confirmation. */
  get pending(): boolean {
    return this.#pendingSystem !== null || this.#pendingChannels.size > 0;
  }
  /**
   * Keepalive may report "connected" (§3.4): like the app, the unit id, every
   * REQUIRED message and all PING_CONFIGS channel settings have been received.
   */
  get ready(): boolean {
    return this.unit !== null && this.#channels.size >= PING_CONFIGS && REQUIRED.every((id) => this.seen.has(id));
  }

  /** Forget per-connection state (the app resets its decoders on reconnect); warnings may repeat for the new connection. */
  reset(): void {
    this.seen.clear();
    this.unit = null;
    this.#system = null;
    this.#channels.clear();
    this.configIndex[0] = this.configIndex[1] = null;
    this.clearReadings();
    this.errorFlags = null;
    this.systemStatus = null;
    this.#pendingSystem = null;
    this.#pendingChannels.clear();
    this.#warned.clear();
    this.asm = new PingAssembler();
  }

  /** Forget the bottom depth and water temperature without emitting (the link dropped; the app blanks both). */
  clearReadings(): void {
    this.bottomCm = null;
    this.waterTempCentiC = null;
  }

  /** Emit `warn` with `msg` only the first time `key` is seen, so a bad stream doesn't flood the log. */
  #warnOnce(key: string, msg: string): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.emit('warn', msg);
  }

  /** Feed one datagram. Returns the message id, or null if it was ignored. */
  handle(b: Uint8Array, now = Date.now()): number | null {
    const id = messageId(b);
    if (id === MsgId.UNIT) {
      const u = parseUnit(b);
      if (u && (this.unit?.type !== u.type || this.unit.name !== u.name || this.unit.serial !== u.serial)) {
        this.unit = u;
        this.emit('unit', u);
      }
      return u ? id : null;
    }
    const h = parseHeader(b);
    if (!h) return null;
    const hex = `0x${h.id.toString(16)}`;
    if (h.version !== VERSION) {
      this.#warnOnce(`ver${h.id}`, `${hex} protocol version ${h.version} != ${VERSION}, ignored`);
      return null;
    }
    if (!isWellFormed(b, h)) {
      this.#warnOnce(`len${h.id}`, `${hex} malformed (${b.length} bytes, header says ${h.length}), dropping these`);
      return null;
    }
    let ok = true;
    switch (h.id) {
      case MsgId.BOTTOM: {
        const m = parseBottom(b)!;
        this.bottomCm = m.depthCm;
        this.emit('bottom', m.depthCm);
        break;
      }
      case MsgId.ENV: {
        this.waterTempCentiC = parseEnv(b)!.waterTempCentiC;
        this.emit('temperature', this.waterTempCentiC);
        break;
      }
      case MsgId.ERROR:
        this.errorFlags = parseError(b)!.flags;
        this.emit('errorFlags', this.errorFlags);
        break;
      case MsgId.SYS_STATUS: {
        const s = parseSystemStatus(b);
        if (s) { this.systemStatus = s; this.emit('systemStatus', s); } else ok = false;
        break;
      }
      case MsgId.SYS_SETTINGS: {
        const s = parseSystemSettings(b);
        if (!s) { ok = false; break; }
        // Like the app: only a newer seq replaces what we hold.
        const newer = !this.#system || s.seq > this.#system.parsed.seq;
        if (newer) this.#system = { parsed: s, raw: Uint8Array.from(b) };
        const p = this.#pendingSystem;
        if (p && s.seq >= p.parsed.seq) {
          // Our change (or a newer one from another client) is what the sonar now has.
          this.#pendingSystem = null;
          this.emit('systemSettings', this.#system!.parsed);
        } else if (p) {
          p.stale = true;
        } else if (newer) {
          this.emit('systemSettings', s);
        }
        break;
      }
      case MsgId.CHAN_SETTINGS: {
        const s = parseChannelSettings(b);
        if (!s) { ok = false; this.#warnOnce('chanset', 'channel settings with bad size or index, ignored'); break; }
        const held = this.#channels.get(s.index);
        const newer = !held || s.seq > held.parsed.seq;
        if (newer) this.#channels.set(s.index, { parsed: s, raw: Uint8Array.from(b) });
        const p = this.#pendingChannels.get(s.index);
        if (p && s.seq >= p.parsed.seq) {
          this.#pendingChannels.delete(s.index);
          this.emit('channelSettings', this.#channels.get(s.index)!.parsed);
        } else if (p) {
          p.stale = true;
        } else if (newer) {
          this.emit('channelSettings', s);
        }
        break;
      }
      case MsgId.PING_RESULTS: {
        // Results may follow their ping data; the assembler hands back the waiting column.
        const col = this.asm.addResults(parsePingResults(b), now);
        if (col) this.#column(col.results, col.setting, col.seq, col.samples);
        break;
      }
      case MsgId.PING_DATA: {
        const col = this.asm.push(parsePingData(b), now);
        if (col) this.#column(col.results, col.setting, col.seq, col.samples);
        break;
      }
    }
    if (ok) this.seen.set(h.id, (this.seen.get(h.id) ?? 0) + 1);
    return ok ? h.id : null;
  }

  /** Emit a completed column for an enabled configuration, with its view window from the channel's range settings. */
  #column(r: ReturnType<typeof parsePingResults>, configIndex: number, seq: number, samples: Uint8Array): void {
    if (!r || (r.channel !== 0 && r.channel !== 1)) return; // can't tell which trace it belongs to
    const channel = r.channel as ChannelId;
    const cs = this.channelSettings(configIndex);
    // The app draws only configurations whose settings it holds as enabled (e0.f.n()).
    if (!cs || !cs.enabled) return;
    this.configIndex[channel] = configIndex;
    let startCm = cs.rangeAuto ? r.rangeStartCm : cs.rangeShallowCm;
    let endCm = cs.rangeAuto ? r.rangeEndCm : cs.rangeDeepCm;
    if (!(endCm > 0)) { endCm = r.rangeEndCm > 0 ? r.rangeEndCm : 1000; }
    if (!(startCm >= 0 && startCm < endCm)) startCm = 0;
    this.emit('column', { channel, configIndex, seq, samples, startCm, endCm });
  }

  /** Ping configuration used for `ch`: the last one seen in its data, else the app's defaults (sonar 0, DownVision 1). */
  indexFor(ch: ChannelId): number {
    return this.configIndex[ch] ?? (ch === 1 ? 1 : 0);
  }

  /**
   * Channel settings datagrams for a UI change on `channel`. Range fields apply
   * to both channels, like the app's Range tab; the rest only to `channel`.
   */
  buildChannelCommands(channel: ChannelId, patch: ChannelSettingsPatch, now = Date.now()): Uint8Array[] {
    const { rangeAuto, rangeShallowCm, rangeDeepCm, ...own } = patch;
    const range: ChannelSettingsPatch = {};
    if (rangeAuto !== undefined) range.rangeAuto = rangeAuto;
    if (rangeShallowCm !== undefined) range.rangeShallowCm = rangeShallowCm;
    if (rangeDeepCm !== undefined) range.rangeDeepCm = rangeDeepCm;
    const out: Uint8Array[] = [];
    for (const ch of [0, 1] as const) {
      const p: ChannelSettingsPatch = { ...range, ...(ch === channel ? own : {}) };
      if (!Object.keys(p).length) continue;
      const idx = this.indexFor(ch);
      // Build on an unconfirmed change, so a quick second change keeps the first one.
      const prev = this.#pendingChannels.get(idx);
      const base = prev ?? this.#channels.get(idx);
      if (!base) continue;
      const raw = buildChannelSettings(base.raw, p, base.parsed.seq + 1);
      const parsed = parseChannelSettings(raw)!;
      this.#pendingChannels.set(idx, { parsed, raw, sentAt: now, sends: 1, stale: false, patch: { ...prev?.patch, ...p } });
      this.emit('channelSettings', parsed);
      out.push(raw);
    }
    return out;
  }

  /** System settings datagram for a change, or null before the device sent its settings. */
  buildSystemCommand(patch: SystemSettingsPatch, now = Date.now()): Uint8Array | null {
    const prev = this.#pendingSystem;
    const base = prev ?? this.#system;
    if (!base) return null;
    const raw = buildSystemSettings(base.raw, patch, base.parsed.seq + 1);
    const parsed = parseSystemSettings(raw)!;
    this.#pendingSystem = { parsed, raw, sentAt: now, sends: 1, stale: false, patch: { ...prev?.patch, ...patch } };
    this.emit('systemSettings', parsed);
    return raw;
  }

  /**
   * Call about once a second. Returns unconfirmed changes to send again: after RESEND_MS,
   * or at once when the sonar broadcast older settings since the last send. A stale change
   * is rebuilt on what the sonar holds now, at its seq + 1: when another client changed the
   * settings meanwhile (a broadcast newer than our base but older than our seq), its change
   * survives and our seq stays ahead instead of resending an obsolete copy. After MAX_SENDS,
   * a change the sonar still reports as not applied is dropped and its own values are shown
   * again. A sonar that broadcasts nothing gives no such evidence, so the change stays shown.
   */
  retryPending(now = Date.now()): Uint8Array[] {
    const out: Uint8Array[] = [];
    /** Resend `p` (rebuilt on `held` when stale), or report that it is to be dropped (true). */
    const step = <T, P>(p: Pending<T, P>, held: Held<T> | null, build: (held: Held<T>, patch: P) => Held<T>, event: () => void): boolean => {
      if (!p.stale && now - p.sentAt < RESEND_MS) return false;
      if (p.sends >= MAX_SENDS) return p.stale;
      if (p.stale && held) {
        const fresh = build(held, p.patch);
        if (!sameBytes(fresh.raw, p.raw)) {
          p.raw = fresh.raw;
          p.parsed = fresh.parsed;
          event();
        }
      }
      p.sends++;
      p.sentAt = now;
      p.stale = false;
      out.push(p.raw);
      return false;
    };
    for (const [idx, p] of this.#pendingChannels) {
      const held = this.#channels.get(idx) ?? null;
      const build = (h: Held<ChannelSettings>, patch: ChannelSettingsPatch): Held<ChannelSettings> => {
        const raw = buildChannelSettings(h.raw, patch, h.parsed.seq + 1);
        return { raw, parsed: parseChannelSettings(raw)! };
      };
      if (!step(p, held, build, () => this.emit('channelSettings', p.parsed))) continue;
      this.#pendingChannels.delete(idx);
      this.emit('warn', `sonar did not apply the settings change for ping configuration ${idx}; showing its own values`);
      if (held) this.emit('channelSettings', held.parsed);
    }
    const ps = this.#pendingSystem;
    if (ps) {
      const build = (h: Held<SystemSettings>, patch: SystemSettingsPatch): Held<SystemSettings> => {
        const raw = buildSystemSettings(h.raw, patch, h.parsed.seq + 1);
        return { raw, parsed: parseSystemSettings(raw)! };
      };
      if (step(ps, this.#system, build, () => this.emit('systemSettings', ps.parsed))) {
        this.#pendingSystem = null;
        this.emit('warn', 'sonar did not apply the system settings change; showing its own values');
        if (this.#system) this.emit('systemSettings', this.#system.parsed);
      }
    }
    return out;
  }
}
