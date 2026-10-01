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
interface Pending<T> extends Held<T> {
  sentAt: number;
  sends: number;
  /** The sonar broadcast older settings after our last send: the change did not land (yet). */
  stale: boolean;
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
  #pendingSystem: Pending<SystemSettings> | null = null;
  #pendingChannels = new Map<number, Pending<ChannelSettings>>();
  /** Ping configuration index last seen per channel (0 = sonar, 1 = DownVision). */
  readonly configIndex: [number | null, number | null] = [null, null];
  columns = 0;
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

  /** Forget per-connection state (the app resets its decoders on reconnect). */
  reset(): void {
    this.seen.clear();
    this.unit = null;
    this.#system = null;
    this.#channels.clear();
    this.configIndex[0] = this.configIndex[1] = null;
    this.bottomCm = null;
    this.waterTempCentiC = null;
    this.errorFlags = null;
    this.systemStatus = null;
    this.#pendingSystem = null;
    this.#pendingChannels.clear();
    this.asm = new PingAssembler();
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
    this.columns++;
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
      const base = this.#pendingChannels.get(idx) ?? this.#channels.get(idx);
      if (!base) continue;
      const raw = buildChannelSettings(base.raw, p, base.parsed.seq + 1);
      const parsed = parseChannelSettings(raw)!;
      this.#pendingChannels.set(idx, { parsed, raw, sentAt: now, sends: 1, stale: false });
      this.emit('channelSettings', parsed);
      out.push(raw);
    }
    return out;
  }

  /** System settings datagram for a change, or null before the device sent its settings. */
  buildSystemCommand(patch: SystemSettingsPatch, now = Date.now()): Uint8Array | null {
    const base = this.#pendingSystem ?? this.#system;
    if (!base) return null;
    const raw = buildSystemSettings(base.raw, patch, base.parsed.seq + 1);
    const parsed = parseSystemSettings(raw)!;
    this.#pendingSystem = { parsed, raw, sentAt: now, sends: 1, stale: false };
    this.emit('systemSettings', parsed);
    return raw;
  }

  /**
   * Call about once a second. Returns unconfirmed changes to send again: after RESEND_MS,
   * or at once when the sonar broadcast older settings since the last send. After
   * MAX_SENDS, a change the sonar still reports as not applied is dropped and its own
   * values are shown again. A sonar that broadcasts nothing gives no such evidence, so
   * the change stays shown.
   */
  retryPending(now = Date.now()): Uint8Array[] {
    const out: Uint8Array[] = [];
    /** Resend `p`, or report that it is to be dropped (true). */
    const step = (p: Pending<unknown>): boolean => {
      if (!p.stale && now - p.sentAt < RESEND_MS) return false;
      if (p.sends >= MAX_SENDS) return p.stale;
      p.sends++;
      p.sentAt = now;
      p.stale = false;
      out.push(p.raw);
      return false;
    };
    for (const [idx, p] of this.#pendingChannels) {
      if (!step(p)) continue;
      this.#pendingChannels.delete(idx);
      this.emit('warn', `sonar did not apply the settings change for ping configuration ${idx}; showing its own values`);
      const held = this.#channels.get(idx);
      if (held) this.emit('channelSettings', held.parsed);
    }
    if (this.#pendingSystem && step(this.#pendingSystem)) {
      this.#pendingSystem = null;
      this.emit('warn', 'sonar did not apply the system settings change; showing its own values');
      if (this.#system) this.emit('systemSettings', this.#system.parsed);
    }
    return out;
  }
}
