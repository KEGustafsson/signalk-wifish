// Ties a transport to a Sonar4 session and fans the result out: Signal K deltas,
// web-app state and echogram columns (with a history backlog for new viewers).

import { EventEmitter } from 'node:events';
import { Sonar4Session, type SessionColumn } from './session';
import { UNIT_TYPES, UNIT_WIFISH, ERROR_LOW_VOLTAGE, isSonarMessage, type ChannelSettings } from './sonar4';
import { PATH, centiCToK, depthValues, toDelta, Throttle, type Delta, type PathValue } from './signalk';
import type { LinkState, Transport } from './transport';
import {
  CHANNELS, CHANNEL_CODE, channelByCode, DEFAULT_HISTORY_COLUMNS, MAX_HISTORY_COLUMNS,
  type ChannelName, type ChannelPatch, type ChannelSettingsView, type ColumnMessage, type SystemPatch, type WifishState,
} from './shared/api';
import { MIN_RANGE_WINDOW_CM } from './shared/units';
import { errorMessage } from './util';

export interface EngineOptions {
  /** Columns kept per channel for viewers that connect later. */
  historyColumns?: number;
  emitDepth?: boolean;
  emitTemperature?: boolean;
  /** Waterline-to-transducer distance kept by the plugin, cm; null = not set. */
  surfaceToTransducerCm?: () => number | null;
  /** Receives Signal K deltas. */
  onDelta?: (d: Delta) => void;
  /** Diagnostics (debug level): session warnings. */
  log?: (msg: string) => void;
  /** Failures: a datagram, link or delta handler that threw. Falls back to `log`. */
  error?: (msg: string) => void;
}

/** A column kept for viewers that connect later: when it arrived and its ColumnMessage as JSON, serialised once. */
export interface HistoryEntry { readonly t: number; readonly json: string }

export interface EngineEvents {
  state: [WifishState];
  /** A new column and its JSON (the same string its history entry holds). */
  column: [ColumnMessage, string];
}

/** The app keeps showing the last depth this long after bottom lock is lost (msg 105). */
export const DEPTH_HOLD_MS = 6000;
/** Signal K output rates: depth at most 5 Hz with a 5 s heartbeat, water temperature at most 1 Hz with a 10 s heartbeat. */
export const DEPTH_MIN_INTERVAL_MS = 200;
export const DEPTH_HEARTBEAT_MS = 5000;
export const TEMP_MIN_INTERVAL_MS = 1000;
export const TEMP_HEARTBEAT_MS = 10_000;
/** Readings are dropped after this long without sonar data (the watchdog ticks once a second). */
export const STALE_MS = 5000;

/** History size from (possibly hand-edited) config: finite, 0..MAX_HISTORY_COLUMNS, default DEFAULT_HISTORY_COLUMNS. */
export function clampColumns(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_HISTORY_COLUMNS, Math.round(n))) : DEFAULT_HISTORY_COLUMNS;
}
/** Monotonic clock, ms. */
const mono = () => globalThis.performance.now();

/** Channel settings as shown to the web app, or null when not received yet. */
function view(s: ChannelSettings | null): ChannelSettingsView | null {
  if (!s) return null;
  const { index: configIndex, name, rangeAuto, rangeShallowCm, rangeDeepCm, gainAuto, gain, contrastAuto, contrast, noiseFilterAuto, noiseFilter } = s;
  return { configIndex, name, rangeAuto, rangeShallowCm, rangeDeepCm, gainAuto, gain, contrastAuto, contrast, noiseFilterAuto, noiseFilter };
}

/** Engines created by this process, for unique epochs. */
let engines = 0;

export class Engine extends EventEmitter<EngineEvents> {
  /** Unique per Engine and server run, so viewers can tell a restart from a reconnect. */
  readonly epoch = `${Date.now().toString(36)}.${++engines}`;
  readonly session = new Sonar4Session();
  readonly transport: Transport;
  #opts: Required<Omit<EngineOptions, 'onDelta' | 'log' | 'error'>> & Pick<EngineOptions, 'onDelta' | 'log'>;
  #error: (msg: string) => void;
  #link: LinkState = 'offline';
  #message = 'Starting';
  #history: Record<ChannelName, HistoryEntry[]> = { sonar: [], downvision: [] };
  #n: Record<ChannelName, number> = { sonar: 0, downvision: 0 };
  #throttles = {
    depth: new Throttle({ minIntervalMs: DEPTH_MIN_INTERVAL_MS, heartbeatMs: DEPTH_HEARTBEAT_MS }),
    temp: new Throttle({ minIntervalMs: TEMP_MIN_INTERVAL_MS, heartbeatMs: TEMP_HEARTBEAT_MS }),
  };
  #stateTimer: NodeJS.Timeout | null = null;
  /** The last state emitted, as JSON: an unchanged state is not sent again. */
  #lastState = '';
  #watchdog: NodeJS.Timeout | null = null;
  /** Sends a reading the rate limit held back as soon as it may go out. */
  #flushTimer: NodeJS.Timeout | null = null;
  #flushAt = 0;
  #lastData: number | null = null;
  #stale = false;
  /** Depth paths currently published, so ones that stop applying can be cleared. */
  #depthPaths = new Set<string>();
  /** The device offset the depth paths were last published with. */
  #depthOffset: number | null = null;
  #running = false;
  #stopped = false;
  #tempPublished = false;
  /** Depth shown to viewers: the last valid depth, held DEPTH_HOLD_MS after lock is lost. */
  #shownDepthCm: number | null = null;
  #holdTimer: NodeJS.Timeout | null = null;

  /** Wire transport datagrams and link changes into the session, and session events into deltas and state. */
  constructor(transport: Transport, opts: EngineOptions = {}) {
    super();
    this.transport = transport;
    this.#opts = {
      historyColumns: clampColumns(opts.historyColumns),
      emitDepth: opts.emitDepth ?? true,
      emitTemperature: opts.emitTemperature ?? true,
      surfaceToTransducerCm: opts.surfaceToTransducerCm ?? (() => null),
      onDelta: opts.onDelta,
      log: opts.log,
    };
    this.#error = (m) => (opts.error ?? opts.log)?.(m);
    const s = this.session;
    transport.on('datagram', (b) => {
      let id: number | null = null;
      try {
        id = s.handle(b);
      } catch (e) {
        this.#error(`error handling a datagram: ${errorMessage(e)}`);
      }
      if (isSonarMessage(id)) this.#lastData = mono();
    });
    transport.on('link', (state, msg) => {
      try {
        const prev = this.#link;
        this.#link = state;
        this.#message = msg;
        // The link change covers what the watchdog would otherwise find a few seconds later
        // (and repeat the null readings for): data before it does not count.
        this.#lastData = null;
        this.#stale = false;
        // A new session (not a recovery from 'lost') starts from scratch, like the app's decoder reset.
        const fresh = state === 'searching' || state === 'offline' || (state === 'connecting' && prev !== 'lost');
        // The app blanks depth and water temperature when the connection drops (msg 11/12).
        if (fresh || state === 'lost') this.#clearReadings();
        if (fresh) s.reset();
        // The sonar may restart before it is back: take its next settings whatever their seq.
        else if (state === 'lost') s.resync();
        this.#stateChanged(true);
      } catch (e) {
        this.#error(`error handling link '${state}': ${errorMessage(e)}`);
      }
    });
    s.on('warn', (m) => this.#opts.log?.(m));
    s.on('unit', () => this.#stateChanged());
    s.on('bottom', (cm) => { this.#depth(cm); this.#showDepth(cm); });
    s.on('temperature', (c) => { this.#temperature(c); this.#stateChanged(); });
    s.on('errorFlags', () => this.#stateChanged());
    s.on('systemStatus', () => this.#stateChanged());
    s.on('systemSettings', () => {
      // Republish with the offset now confirmed; nothing to do without a bottom and with the same offset.
      if (s.bottomCm !== null || (s.deviceSystem?.transducerOffsetCm ?? 0) !== this.#depthOffset) this.#depth(s.bottomCm, true);
      this.#stateChanged(true);
    });
    s.on('channelSettings', () => this.#stateChanged(true));
    s.on('column', (c) => this.#column(c));
  }

  /** Start the watchdog (stale data, heartbeats, resends) and the transport; an Engine cannot be restarted after stop(). */
  start(): void {
    if (this.#running || this.#stopped) return; // listeners are gone after stop(); make a new Engine

    this.#running = true;
    this.#watchdog = setInterval(() => this.#tick(), 1000);
    this.transport.start();
  }

  /** Stop timers and the transport and remove every listener; the Engine is single-use. */
  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    this.#stopped = true;
    try {
      this.#clearTimers();
      this.transport.stop(); // reports 'offline', which publishes null depth and temperature
    } finally {
      this.#clearTimers(); // anything the stop itself scheduled
      this.transport.removeAllListeners();
      this.session.removeAllListeners();
      this.removeAllListeners();
    }
  }

  /** Link state last reported by the transport. */
  get link(): LinkState { return this.#link; }
  /** Human-readable status that came with the last link change. */
  get message(): string { return this.#message; }

  /** Backlog of recent columns for a channel, oldest first. */
  history(ch: ChannelName): readonly HistoryEntry[] {
    return this.#history[ch];
  }

  /** Snapshot of link, unit, readings and channel/system settings for the web app. */
  state(): WifishState {
    const s = this.session;
    const u = s.unit;
    const sys = s.system;
    const st = s.systemStatus;
    return {
      epoch: this.epoch,
      source: this.transport.kind,
      link: this.#link,
      message: this.#message,
      canControl: this.transport.canSend && this.#link !== 'offline',
      unit: u ? { type: u.type, model: UNIT_TYPES[u.type] ?? `Unit ${u.type}`, name: u.name, serial: u.serial, wifish: u.type === UNIT_WIFISH } : null,
      softwareVersion: st ? `${st.swMajor}.${st.swMinor}` : null,
      depthCm: this.#shownDepthCm,
      waterTempCentiC: s.waterTempCentiC,
      lowVoltage: s.errorFlags !== null && (s.errorFlags & ERROR_LOW_VOLTAGE) !== 0,
      system: sys ? { transducerOffsetCm: sys.transducerOffsetCm, depthUnit: sys.depthUnit, simulator: sys.simulator } : null,
      channels: {
        sonar: view(s.channelSettings(s.indexFor(CHANNEL_CODE.sonar))),
        downvision: view(s.channelSettings(s.indexFor(CHANNEL_CODE.downvision))),
      },
      active: { sonar: this.#n.sonar > 0, downvision: this.#n.downvision > 0 },
      historyColumns: this.#opts.historyColumns,
    };
  }

  /** Apply a settings change from the UI. Returns an error message, or null when sent. */
  setChannel(ch: ChannelName, patch: ChannelPatch): string | null {
    if (!this.transport.canSend) return 'Sonar settings cannot be changed in this mode';
    const p = { ...patch };
    const rangeChange = p.rangeShallowCm !== undefined || p.rangeDeepCm !== undefined;
    // Picking a Shallow or Deep preset turns Auto range off, as in the app.
    if (rangeChange && p.rangeAuto === undefined) p.rangeAuto = false;
    // Range goes to both channels: it must leave a usable window against what each one holds.
    if (rangeChange) {
      for (const c of CHANNELS) {
        const held = this.session.channelSettings(this.session.indexFor(CHANNEL_CODE[c]));
        if (!held) continue;
        const shallow = p.rangeShallowCm ?? held.rangeShallowCm;
        const deep = p.rangeDeepCm ?? held.rangeDeepCm;
        if (deep - shallow < MIN_RANGE_WINDOW_CM) return `Shallow must be less than Deep by at least ${MIN_RANGE_WINDOW_CM} cm`;
      }
    }
    const msgs = this.session.buildChannelCommands(CHANNEL_CODE[ch], p);
    if (!msgs.length) return 'Channel settings not received from the sonar yet';
    for (const m of msgs) this.transport.send(m);
    return null;
  }

  /** The waterline-to-transducer distance changed: republish depth with it now. */
  vesselChanged(): void {
    this.#depth(this.session.bottomCm, true);
  }

  /** Apply a system settings change from the UI. Returns an error message, or null when sent. */
  setSystem(patch: SystemPatch): string | null {
    if (!this.transport.canSend) return 'Sonar settings cannot be changed in this mode';
    const m = this.session.buildSystemCommand(patch);
    if (!m) return 'System settings not received from the sonar yet';
    this.transport.send(m);
    return null;
  }

  // ------------------------------------------------------------------ internals

  /** Cancel every timer the engine owns. */
  #clearTimers(): void {
    if (this.#holdTimer) clearTimeout(this.#holdTimer);
    if (this.#watchdog) clearInterval(this.#watchdog);
    if (this.#stateTimer) clearTimeout(this.#stateTimer);
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#holdTimer = this.#watchdog = this.#stateTimer = this.#flushTimer = null;
  }

  /** Once a second: drop stale readings, send due heartbeats, resend unconfirmed settings. */
  #tick(): void {
    try {
      this.#checkStale();
      this.#heartbeat();
      this.#resendPending();
    } catch (e) {
      this.#error(`watchdog: ${errorMessage(e)}`);
    }
  }

  /** Emit 'state' immediately when `now`, else coalesce changes into one emit within 250 ms. */
  #stateChanged(now = false): void {
    if (now) {
      if (this.#stateTimer) clearTimeout(this.#stateTimer);
      this.#stateTimer = null;
      this.#emitState();
      return;
    }
    if (this.#stateTimer) return;
    this.#stateTimer = setTimeout(() => {
      this.#stateTimer = null;
      this.#emitState();
    }, 250);
  }

  /** Emit the state unless it is the one emitted last (the sonar re-sends status and temperature every second). */
  #emitState(): void {
    const s = this.state();
    const json = JSON.stringify(s);
    if (json === this.#lastState) return;
    this.#lastState = json;
    this.emit('state', s);
  }

  /**
   * Re-feed the held readings once `ms` has passed, so a change the rate limit held back goes
   * out then. One timer serves depth and temperature: it moves earlier when a sooner flush is due.
   */
  #scheduleFlush(ms: number): void {
    if (!this.#running) return;
    const at = mono() + ms;
    if (this.#flushTimer) {
      if (this.#flushAt <= at) return;
      clearTimeout(this.#flushTimer);
    }
    this.#flushAt = at;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.#heartbeat();
    }, ms);
  }

  /** Send the values as one Signal K delta, if there are any; a failing consumer is logged, not propagated. */
  #emitSk(values: PathValue[]): void {
    if (!values.length) return;
    try {
      this.#opts.onDelta?.(toDelta(values));
    } catch (e) {
      this.#error(`error delivering a delta: ${errorMessage(e)}`);
    }
  }

  /** Publish depth paths for `cm` (throttled unless `force`), sending null for paths that no longer apply. */
  #depth(cm: number | null, force = false): void {
    if (!this.#opts.emitDepth) return;
    if (cm === null && this.#depthPaths.size === 0) return; // nothing published yet, nothing to clear
    // The sonar applies its own offset to the depth it reports: use its confirmed value, not a pending change.
    const offset = this.session.deviceSystem?.transducerOffsetCm ?? 0;
    this.#depthOffset = offset;
    const values = depthValues(cm, offset, this.#opts.surfaceToTransducerCm());
    // A path that no longer applies (offset changed sign or went to 0, distance cleared) gets a final null,
    // otherwise the server would keep showing its last value.
    const current = new Set(values.map((v) => v.path));
    const gone: PathValue[] = [...this.#depthPaths].filter((p) => !current.has(p)).map((path) => ({ path, value: null }));
    for (const g of gone) this.#throttles.depth.shouldEmit(g.path, null, mono());
    this.#depthPaths = current;
    if (force) this.#throttles.depth.reset();
    const now = mono();
    // Each path goes through the throttle; one delta carries all that are due.
    const throttle = this.#throttles.depth;
    const due = values.filter((v) => throttle.shouldEmit(v.path, v.value, now));
    this.#emitSk([...gone, ...due]);
    for (const v of values) {
      const wait = due.includes(v) ? null : throttle.holdMs(v.path, v.value, now);
      if (wait !== null) this.#scheduleFlush(wait);
    }
  }

  /** Publish water temperature in kelvin (throttled); null clears it only once a value was published. */
  #temperature(c: number | null): void {
    if (!this.#opts.emitTemperature) return;
    if (c === null && !this.#tempPublished) return; // nothing to clear yet
    this.#tempPublished = c !== null;
    const value = c === null ? null : centiCToK(c);
    const now = mono();
    if (this.#throttles.temp.shouldEmit(PATH.waterTemp, value, now)) this.#emitSk([{ path: PATH.waterTemp, value }]);
    else {
      const wait = this.#throttles.temp.holdMs(PATH.waterTemp, value, now);
      if (wait !== null) this.#scheduleFlush(wait);
    }
  }

  /** Watchdog: clear readings once no sonar data has arrived for STALE_MS. */
  #checkStale(): void {
    const quiet = this.#lastData !== null && mono() - this.#lastData > STALE_MS;
    if (quiet && !this.#stale) {
      this.#clearReadings();
      this.#stateChanged(true);
    }
    this.#stale = quiet;
  }

  /**
   * Heartbeats are timer-driven: the held readings go through the throttles again so a due
   * heartbeat (or a change minInterval suppressed) is sent even when no new sample arrives.
   * Nothing is re-fed while stale or without readings, so a lost link or stale data sends
   * null once. (A sonar that keeps reporting "no bottom lock" re-sends null itself, and that
   * goes out at the depth heartbeat like any other unchanged value.)
   */
  #heartbeat(): void {
    if (this.#stale) return;
    const s = this.session;
    if (s.bottomCm !== null) this.#depth(s.bottomCm);
    if (s.waterTempCentiC !== null) this.#temperature(s.waterTempCentiC);
  }

  /** Send settings changes the sonar has not confirmed yet again (UDP may have dropped them). */
  #resendPending(): void {
    if (!this.transport.canSend || !this.session.pending) return;
    for (const m of this.session.retryPending()) this.transport.send(m);
  }

  /**
   * No trustworthy readings any more: publish null depth and temperature, blank the display.
   * Depth paths already at null stay as they are (no forced repeat).
   */
  #clearReadings(): void {
    const s = this.session;
    const hadDepth = s.bottomCm !== null;
    s.clearReadings();
    if (hadDepth) this.#depth(null, true);
    this.#temperature(null);
    if (this.#holdTimer) clearTimeout(this.#holdTimer);
    this.#holdTimer = null;
    this.#shownDepthCm = null;
  }

  /** Readout like the app: a valid depth shows at once; no lock blanks it only after DEPTH_HOLD_MS. */
  #showDepth(cm: number | null): void {
    if (cm !== null) {
      if (this.#holdTimer) clearTimeout(this.#holdTimer);
      this.#holdTimer = null;
      this.#shownDepthCm = Math.max(0, cm);
      this.#stateChanged();
      return;
    }
    if (this.#holdTimer || this.#shownDepthCm === null) return;
    this.#holdTimer = setTimeout(() => {
      this.#holdTimer = null;
      this.#shownDepthCm = null;
      this.#stateChanged(true);
    }, DEPTH_HOLD_MS);
  }

  /** Turn a session column into a ColumnMessage, append it to the channel's capped history and emit it. */
  #column(c: SessionColumn): void {
    const ch = channelByCode(c.channel);
    const offset = this.session.deviceSystem?.transducerOffsetCm ?? 0;
    const bottom = this.session.bottomCm;
    const msg: ColumnMessage = {
      ch,
      n: ++this.#n[ch],
      t: Date.now(),
      startCm: c.startCm,
      endCm: c.endCm,
      bottomCm: bottom === null ? null : bottom - offset,
      waterTempCentiC: this.session.waterTempCentiC,
      data: Buffer.from(c.samples.buffer, c.samples.byteOffset, c.samples.byteLength).toString('base64'),
    };
    // History keeps only the JSON: the one form every viewer is sent.
    const json = JSON.stringify(msg);
    const max = this.#opts.historyColumns;
    if (max > 0) {
      const h = this.#history[ch];
      h.push({ t: msg.t, json });
      if (h.length > max) h.splice(0, h.length - max);
    }
    if (this.#n[ch] === 1) this.#stateChanged(true);
    this.emit('column', msg, json);
  }
}
