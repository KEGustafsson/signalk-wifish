// Connection to the plugin: SSE for state and columns, fetch for settings.

import {
  API_BASE, type ChannelName, type ChannelPatch, type ColumnMessage, type DisplayPrefs, type SystemPatch, type VesselSettings,
  type WifishState,
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

export class PluginStream {
  #es: EventSource | null = null;
  /** `h` receives the stream's events. */
  constructor(private h: StreamHandlers) {}

  /** (Re)connect the SSE stream and route its events to the handlers. */
  open(): void {
    this.close();
    const es = new EventSource(`${API_BASE}/stream`);
    this.#es = es;
    es.addEventListener('open', () => this.h.connection(true));
    es.addEventListener('error', () => this.h.connection(false));
    es.addEventListener('display', (e) => this.h.display(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('vessel', (e) => this.h.vessel(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('state', (e) => this.h.state(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('col', (e) => this.h.column(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('reset', () => this.h.reset());
    es.addEventListener('live', () => this.h.live());
  }

  /** Close the SSE stream, if open. */
  close(): void {
    this.#es?.close();
    this.#es = null;
  }
}

/** POST JSON to the plugin API; resolves to its JSON reply or throws with the server's error message. */
async function post<T = WifishState>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j as T;
}

/** Change settings of one channel; resolves to the resulting plugin state. */
export const setChannel = (ch: ChannelName, patch: ChannelPatch) => post(`/channel/${ch}`, patch);
/** Change sonar system settings; resolves to the resulting plugin state. */
export const setSystem = (patch: SystemPatch) => post('/system', patch);
/** Save display units on the plugin for every viewer; resolves to the units now kept. */
export const setDisplay = (patch: DisplayPrefs) => post<DisplayPrefs>('/display', patch);
/** Save vessel settings on the plugin; resolves to the settings now kept. */
export const setVessel = (patch: VesselSettings) => post<VesselSettings>('/vessel', patch);
