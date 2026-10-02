// Ties a transport to a Sonar4 session and fans the result out: Signal K deltas,
// web-app state and echogram columns (with a history backlog for new viewers).

import { EventEmitter } from 'node:events';
import { Sonar4Session, type SessionColumn } from './session';
import { UNIT_TYPES, UNIT_WIFISH, ERROR_LOW_VOLTAGE, type ChannelSettings, type ChannelId } from './sonar4';
import { PATH, centiCToK, depthValues, toDelta, Throttle, type Delta, type PathValue } from './signalk';
import type { LinkState, Transport } from './transport';
import {
  CHANNELS, type ChannelName, type ChannelPatch, type ChannelSettingsView, type ColumnMessage, type SystemPatch,
  type WifishState,
} from './shared/api';

export interface EngineOptions {
  /** Columns kept per channel for viewers that connect later. */
  historyColumns?: number;
  emitDepth?: boolean;
  emitTemperature?: boolean;
  /** Waterline-to-transducer distance kept by the plugin, cm; null = not set. */
  surfaceToTransducerCm?: () => number | null;
  /** Receives Signal K deltas. */
  onDelta?: (d: Delta) => void;
  log?: (msg: string) => void;
}

export interface EngineEvents {
  state: [WifishState];
  column: [ColumnMessage];
}

const NAMES: readonly ChannelName[] = CHANNELS;
/** The app keeps showing the last depth this long after bottom lock is lost (msg 105). */
export const DEPTH_HOLD_MS = 6000;

/** History size from (possibly hand-edited) config: finite, 0..20000, default 1500. */
function clampColumns(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(20_000, Math.round(n))) : 1500;
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
  #opts: Required<Omit<EngineOptions, 'onDelta' | 'log'>> & Pick<EngineOptions, 'onDelta' | 'log'>;
  #link: LinkState = 'offline';
  #message = 'Starting';
  #history: Record<ChannelName, ColumnMessage[]> = { sonar: [], downvision: [] };
  #n: Record<ChannelName, number> = { sonar: 0, downvision: 0 };
  #throttles = {
    depth: new Throttle({ minIntervalMs: 200, heartbeatMs: 5000 }),
    temp: new Throttle({ minIntervalMs: 1000, heartbeatMs: 10_000 }),
  };
  #stateTimer: NodeJS.Timeout | null = null;
  #watchdog: NodeJS.Timeout | null = null;
  #lastData: number | null = null;
  #stale = false;
  /** Depth paths currently published, so ones that stop applying can be cleared. */
  #depthPaths = new Set<string>();
  #running = false;
  #stopped = false;
  #tempPublished = false;
  /** Depth shown to viewers: the last valid depth, held DEPTH_HOLD_MS after lock is lost. */
  #shownDepthCm: number | null = null;
  #holdTimer: NodeJS.Timeout | null = null;

  /** Wire transport datagrams and link changes into the session, and session events into deltas and state. */
  constructor(transport: Transport, opts: EngineOptions = {}) {
    super();
    this.setMaxListeners(0);
    this.transport = transport;
    this.#opts = {
      historyColumns: clampColumns(opts.historyColumns),
      emitDepth: opts.emitDepth ?? true,
      emitTemperature: opts.emitTemperature ?? true,
      surfaceToTransducerCm: opts.surfaceToTransducerCm ?? (() => null),
      onDelta: opts.onDelta,
      log: opts.log,
    };
    const s = this.session;
    transport.on('datagram', (b) => {
      let id: number | null = null;
      try {
        id = s.handle(b);
      } catch (e) {
        this.#opts.log?.(`error handling a datagram: ${(e as Error).message}`);
      }
      if (id !== null && id >>> 8 === 0x2701) this.#lastData = mono();
    });
    transport.on('link', (state, msg) => {
      const prev = this.#link;
      this.#link = state;
      this.#message = msg;
      // A new session (not a recovery from 'lost') starts from scratch, like the app's decoder reset.
      if (state === 'searching' || state === 'offline' || (state === 'connecting' && prev !== 'lost')) {
        s.reset();
        this.#clearReadings();
      } else if (state === 'lost') {
        // The app blanks depth and water temperature when the connection drops (msg 11/12).
        this.#clearReadings();
      }
      this.#stateChanged(true);
    });
    s.on('warn', (m) => this.#opts.log?.(m));
    s.on('unit', () => this.#stateChanged());
    s.on('bottom', (cm) => { this.#depth(cm); this.#showDepth(cm); });
    s.on('temperature', (c) => { this.#temperature(c); this.#stateChanged(); });
    s.on('errorFlags', () => this.#stateChanged());
    s.on('systemStatus', () => this.#stateChanged());
    s.on('systemSettings', () => { this.#depth(s.bottomCm, true); this.#stateChanged(true); });
    s.on('channelSettings', () => this.#stateChanged(true));
    s.on('column', (c) => this.#column(c));
  }

  /** Start the stale-data watchdog and the transport; an Engine cannot be restarted after stop(). */
  start(): void {
    if (this.#running || this.#stopped) return; // listeners are gone after stop(); make a new Engine

    this.#running = true;
    this.#watchdog = setInterval(() => { this.#checkStale(); this.#resendPending(); }, 1000);
    this.transport.start();
  }

  /** Stop timers and the transport and remove every listener; the Engine is single-use. */
  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    this.#stopped = true;
    if (this.#holdTimer) clearTimeout(this.#holdTimer);
    this.#holdTimer = null;
    if (this.#watchdog) clearInterval(this.#watchdog);
    if (this.#stateTimer) clearTimeout(this.#stateTimer);
    this.#watchdog = this.#stateTimer = null;
    this.transport.stop();
    this.transport.removeAllListeners();
    this.session.removeAllListeners();
    this.removeAllListeners();
  }

  /** Link state last reported by the transport. */
  get link(): LinkState { return this.#link; }
  /** Human-readable status that came with the last link change. */
  get message(): string { return this.#message; }

  /** Backlog of recent columns for a channel, oldest first. */
  history(ch: ChannelName): readonly ColumnMessage[] {
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
        sonar: view(s.channelSettings(s.indexFor(0))),
        downvision: view(s.channelSettings(s.indexFor(1))),
      },
      active: { sonar: this.#n.sonar > 0, downvision: this.#n.downvision > 0 },
    };
  }

  /** Apply a settings change from the UI. Returns an error message, or null when sent. */
  setChannel(ch: ChannelName, patch: ChannelPatch): string | null {
    if (!this.transport.canSend) return 'Sonar settings cannot be changed in this mode';
    const code: ChannelId = ch === 'sonar' ? 0 : 1;
    const p = { ...patch };
    // Picking a Shallow or Deep preset turns Auto range off, as in the app.
    if ((p.rangeShallowCm !== undefined || p.rangeDeepCm !== undefined) && p.rangeAuto === undefined) p.rangeAuto = false;
    // Range goes to both channels: it must stay shallow < deep against what each one holds.
    for (const c of [0, 1] as const) {
      const held = this.session.channelSettings(this.session.indexFor(c));
      if (!held) continue;
      const shallow = p.rangeShallowCm ?? held.rangeShallowCm;
      const deep = p.rangeDeepCm ?? held.rangeDeepCm;
      if ((p.rangeShallowCm !== undefined || p.rangeDeepCm !== undefined) && shallow >= deep) {
        return 'Shallow must be less than Deep';
      }
    }
    const msgs = this.session.buildChannelCommands(code, p);
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

  /** Emit 'state' immediately when `now`, else coalesce changes into one emit within 250 ms. */
  #stateChanged(now = false): void {
    if (now) {
      if (this.#stateTimer) clearTimeout(this.#stateTimer);
      this.#stateTimer = null;
      this.emit('state', this.state());
      return;
    }
    if (this.#stateTimer) return;
    this.#stateTimer = setTimeout(() => {
      this.#stateTimer = null;
      this.emit('state', this.state());
    }, 250);
  }

  /** Send the values as one Signal K delta, if there are any. */
  #emitSk(values: PathValue[]): void {
    if (values.length) this.#opts.onDelta?.(toDelta(values));
  }

  /** Publish depth paths for `cm` (throttled unless `force`), sending null for paths that no longer apply. */
  #depth(cm: number | null, force = false): void {
    if (!this.#opts.emitDepth) return;
    if (cm === null && this.#depthPaths.size === 0) return; // nothing published yet, nothing to clear
    // The sonar applies its own offset to the depth it reports: use its confirmed value, not a pending change.
    const offset = this.session.deviceSystem?.transducerOffsetCm ?? 0;
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
    this.#emitSk([...gone, ...values.filter((v) => this.#throttles.depth.shouldEmit(v.path, v.value, now))]);
  }

  /** Publish water temperature in kelvin (throttled); null clears it only once a value was published. */
  #temperature(c: number | null): void {
    if (!this.#opts.emitTemperature) return;
    if (c === null && !this.#tempPublished) return; // nothing to clear yet
    this.#tempPublished = c !== null;
    const value = c === null ? null : centiCToK(c);
    if (this.#throttles.temp.shouldEmit(PATH.waterTemp, value, mono())) this.#emitSk([{ path: PATH.waterTemp, value }]);
  }

  /** Watchdog: clear readings once no sonar data has arrived for 5 s. */
  #checkStale(): void {
    const quiet = this.#lastData !== null && mono() - this.#lastData > 5000;
    if (quiet && !this.#stale) {
      this.#clearReadings();
      this.#stateChanged(true);
    }
    this.#stale = quiet;
  }

  /** Send settings changes the sonar has not confirmed yet again (UDP may have dropped them). */
  #resendPending(): void {
    if (!this.transport.canSend || !this.session.pending) return;
    for (const m of this.session.retryPending()) this.transport.send(m);
  }

  /** No trustworthy readings any more: publish null depth and temperature, blank the display. */
  #clearReadings(): void {
    const s = this.session;
    if (s.bottomCm !== null || this.#depthPaths.size) { s.bottomCm = null; this.#depth(null, true); }
    if (s.waterTempCentiC !== null) { s.waterTempCentiC = null; }
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
    const ch = NAMES[c.channel];
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
    const h = this.#history[ch];
    h.push(msg);
    if (h.length > this.#opts.historyColumns) h.splice(0, h.length - this.#opts.historyColumns);
    if (this.#n[ch] === 1) this.#stateChanged(true);
    this.emit('column', msg);
  }
}
