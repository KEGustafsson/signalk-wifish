// Settings picked in the web app that the plugin keeps for every viewer, so every browser
// and device sees the same choice and it survives restarts: the display units (depth and
// temperature) and the vessel's waterline-to-transducer distance.

import fs from 'node:fs';
import path from 'node:path';
import type { DisplayPrefs, VesselSettings } from './shared/api';

const DEPTH_UNIT_IDS: readonly unknown[] = ['ft', 'm', 'fa'];

/** Validated display patch, or an error string. */
export function parseDisplayPatch(body: unknown): DisplayPrefs | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'expected a JSON object';
  const b = body as Record<string, unknown>;
  const out: DisplayPrefs = {};
  for (const k of Object.keys(b)) {
    if (k === 'depthUnit') {
      if (b[k] !== null && !DEPTH_UNIT_IDS.includes(b[k])) return 'depthUnit must be ft, m, fa or null';
      out.depthUnit = b[k] as DisplayPrefs['depthUnit'];
    } else if (k === 'tempUnit') {
      if (b[k] !== 'C' && b[k] !== 'F') return 'tempUnit must be C or F';
      out.tempUnit = b[k] as DisplayPrefs['tempUnit'];
    } else {
      return `unknown field ${k}`;
    }
  }
  return Object.keys(out).length ? out : 'empty patch';
}

/** Largest waterline-to-transducer distance, cm: the same limit the sonar puts on its own offset. */
export const MAX_SURFACE_TO_TRANSDUCER_CM = 300;

/** Validated vessel settings patch, or an error string. */
export function parseVesselPatch(body: unknown): VesselSettings | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'expected a JSON object';
  const b = body as Record<string, unknown>;
  const out: VesselSettings = {};
  for (const k of Object.keys(b)) {
    if (k === 'surfaceToTransducerCm') {
      const v = b[k];
      if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_SURFACE_TO_TRANSDUCER_CM)) {
        return `surfaceToTransducerCm must be 0..${MAX_SURFACE_TO_TRANSDUCER_CM} or null`;
      }
      out.surfaceToTransducerCm = v === null ? null : Math.round(v);
    } else {
      return `unknown field ${k}`;
    }
  }
  return Object.keys(out).length ? out : 'empty patch';
}

/** One JSON file of settings, validated with `parse` on load. */
export class JsonStore<T extends object> {
  #parse: (body: unknown) => T | string;
  #file: () => string | undefined;
  #log: (m: string) => void;
  #prefs: T | null = null;

  /**
   * `file` names the JSON file and is resolved on first use (Signal K hands out the
   * plugin's data directory only after the plugin is constructed); undefined keeps the
   * choice in memory only.
   */
  constructor(parse: (body: unknown) => T | string, file: () => string | undefined = () => undefined, log: (m: string) => void = () => {}) {
    this.#parse = parse;
    this.#file = file;
    this.#log = log;
  }

  /** The settings picked so far, read from the file on first use. */
  get(): T {
    if (!this.#prefs) {
      this.#prefs = {} as T;
      const f = this.#path();
      if (f) {
        try {
          const p = this.#parse(JSON.parse(fs.readFileSync(f, 'utf8')));
          if (typeof p === 'string') this.#log(`ignoring ${f}: ${p}`);
          else this.#prefs = p;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.#log(`cannot read ${f}: ${(e as Error).message}`);
        }
      }
    }
    return { ...this.#prefs };
  }

  /** Merge `patch` into the settings and save them (failures are logged; the choice still applies until restart). */
  set(patch: T): T {
    const next = { ...this.get(), ...patch };
    this.#prefs = next;
    const f = this.#path();
    if (f) {
      try {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        const tmp = `${f}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(next));
        fs.renameSync(tmp, f); // never leave a half-written file behind
      } catch (e) {
        this.#log(`cannot save ${f}: ${(e as Error).message}`);
      }
    }
    return { ...next };
  }

  /** The file path, or undefined when there is none (or resolving it failed). */
  #path(): string | undefined {
    try { return this.#file(); } catch { return undefined; }
  }
}

/** The web app's display units. */
export class DisplayStore extends JsonStore<DisplayPrefs> {
  constructor(file?: () => string | undefined, log?: (m: string) => void) {
    super(parseDisplayPatch, file, log);
  }
}

/** Vessel settings the sonar does not hold (the waterline-to-transducer distance). */
export class VesselStore extends JsonStore<VesselSettings> {
  constructor(file?: () => string | undefined, log?: (m: string) => void) {
    super(parseVesselPatch, file, log);
  }
}
