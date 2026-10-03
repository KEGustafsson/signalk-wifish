// Connection to the plugin: SSE for state and columns, fetch for settings.

import {
  API_BASE, isChannelName, type ChannelName, type ChannelPatch, type ColumnMessage, type DisplayPrefs, type SystemPatch,
  type VesselSettings, type WifishState,
} from '../../src/shared/api';

export interface StreamHandlers {
  state(s: WifishState | null): void;
  display(d: DisplayPrefs): void;
  vessel(v: VesselSettings): void;
  column(c: ColumnMessage): void;
  reset(): void;
  live(): void;
  connection(ok: boolean): void;
}

/** Reconnect delay after the browser gave up on the stream: 1 s doubling to 30 s. */
export const RECONNECT_MIN_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const numOrNull = (v: unknown): boolean => v === null || (typeof v === 'number' && Number.isFinite(v));

/** Shape check for a plugin state (null = plugin not running). */
export function isState(v: unknown): v is WifishState | null {
  if (v === null) return true;
  if (!isObj(v)) return false;
  return typeof v.epoch === 'string' && typeof v.link === 'string' && typeof v.source === 'string'
    && typeof v.message === 'string' && typeof v.canControl === 'boolean'
    && (v.unit === null || isObj(v.unit)) && (v.system === null || isObj(v.system))
    && isObj(v.channels) && isObj(v.active) && numOrNull(v.depthCm) && numOrNull(v.waterTempCentiC);
}

/** Shape check for an echogram column message. */
export function isColumn(v: unknown): v is ColumnMessage {
  return isObj(v) && isChannelName(v.ch) && typeof v.n === 'number' && Number.isFinite(v.n)
    && typeof v.t === 'number' && Number.isFinite(v.t)
    && typeof v.startCm === 'number' && typeof v.endCm === 'number' && Number.isFinite(v.endCm)
    && numOrNull(v.bottomCm) && numOrNull(v.waterTempCentiC) && typeof v.data === 'string';
}

export class PluginStream {
  #es: EventSource | null = null;
  #timer: number | undefined;
  #backoff = RECONNECT_MIN_MS;
  /** `h` receives the stream's events. */
  constructor(private h: StreamHandlers) {}

  /** (Re)connect the SSE stream and route its events to the handlers. */
  open(): void {
    this.close();
    const es = new EventSource(`${API_BASE}/stream`);
    this.#es = es;
    es.addEventListener('open', () => { this.#backoff = RECONNECT_MIN_MS; this.h.connection(true); });
    es.addEventListener('error', () => {
      this.h.connection(false);
      // The browser retries a dropped connection itself, but gives up for good on a non-200 or
      // non-SSE reply (the plugin's 503 "too many viewers", a proxy's 502/503 during a restart):
      // then reopen with capped exponential backoff.
      if (es.readyState === EventSource.CLOSED && this.#es === es) this.#scheduleReopen();
    });
    this.#on(es, 'display', isObj, (d) => this.h.display(d as DisplayPrefs));
    this.#on(es, 'vessel', isObj, (v) => this.h.vessel(v as VesselSettings));
    this.#on(es, 'state', isState, (s) => this.h.state(s));
    this.#on(es, 'col', isColumn, (c) => this.h.column(c));
    es.addEventListener('reset', () => this.#guard('reset', () => this.h.reset()));
    es.addEventListener('live', () => this.#guard('live', () => this.h.live()));
  }

  /** Route a JSON event to `fn` when it parses and passes `check`; anything else is logged and ignored. */
  #on<T>(es: EventSource, name: string, check: (v: unknown) => v is T, fn: (v: T) => void): void {
    es.addEventListener(name, (e) => {
      let v: unknown;
      try {
        v = JSON.parse((e as MessageEvent).data);
      } catch (err) {
        console.warn(`wifish: ignored "${name}" event with bad JSON`, err);
        return;
      }
      if (!check(v)) {
        console.warn(`wifish: ignored "${name}" event with unexpected shape`, v);
        return;
      }
      this.#guard(name, () => fn(v));
    });
  }

  /** Run a handler; an exception is logged and must not kill the stream. */
  #guard(name: string, fn: () => void): void {
    try { fn(); } catch (err) { console.warn(`wifish: error handling "${name}" event`, err); }
  }

  /** Reopen after the current backoff, then double it (up to the cap). */
  #scheduleReopen(): void {
    if (this.#timer !== undefined) return;
    const delay = this.#backoff;
    this.#backoff = Math.min(RECONNECT_MAX_MS, this.#backoff * 2);
    this.#timer = setTimeout(() => { this.#timer = undefined; this.open(); }, delay) as unknown as number;
  }

  /** Close the SSE stream, if open, and cancel a pending reconnect. */
  close(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#es?.close();
    this.#es = null;
  }
}

/**
 * POST JSON to the plugin API; resolves to its JSON reply (checked with `check`) or throws with the
 * server's error message. A 200 whose body is not the expected JSON (a proxy's HTML login page,
 * say) rejects too, so a fake state never reaches the app.
 */
async function post<T>(path: string, body: unknown, check: (v: unknown) => v is T): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  let j: unknown;
  try { j = await r.json(); } catch { j = undefined; }
  if (!r.ok) throw new Error(isObj(j) && typeof j.error === 'string' ? j.error : `HTTP ${r.status}`);
  if (!check(j)) throw new Error('Unexpected reply from the server (not the plugin API?)');
  return j;
}

/** Non-null plugin state (a settings reply). */
const isLiveState = (v: unknown): v is WifishState => v !== null && isState(v);

/** Change settings of one channel; resolves to the resulting plugin state. */
export const setChannel = (ch: ChannelName, patch: ChannelPatch) => post(`/channel/${ch}`, patch, isLiveState);
/** Change sonar system settings; resolves to the resulting plugin state. */
export const setSystem = (patch: SystemPatch) => post('/system', patch, isLiveState);
/** Save display units on the plugin for every viewer; resolves to the units now kept. */
export const setDisplay = (patch: DisplayPrefs) => post('/display', patch, (v): v is DisplayPrefs => isObj(v));
/** Save vessel settings on the plugin; resolves to the settings now kept. */
export const setVessel = (patch: VesselSettings) => post('/vessel', patch, (v): v is VesselSettings => isObj(v));
