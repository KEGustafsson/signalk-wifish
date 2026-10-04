// Settings picked in the web app that the plugin keeps for every viewer, so every browser
// and device sees the same choice and it survives restarts: the display units (depth and
// temperature) and the vessel's waterline-to-transducer distance.

import fs from 'node:fs';
import path from 'node:path';
import type { DisplayPrefs, VesselSettings } from './shared/api';
import { DEPTH_UNIT_IDS, TEMP_UNITS, isDepthUnitId, isTempUnit, MAX_TRANSDUCER_OFFSET_CM } from './shared/units';
import { errorMessage } from './util';

/** Validated display patch, or an error string. */
export function parseDisplayPatch(body: unknown): DisplayPrefs | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'expected a JSON object';
  const b = body as Record<string, unknown>;
  const out: DisplayPrefs = {};
  for (const k of Object.keys(b)) {
    const v = b[k];
    if (k === 'depthUnit') {
      if (v !== null && !isDepthUnitId(v)) return `depthUnit must be ${DEPTH_UNIT_IDS.join(', ')} or null`;
      out.depthUnit = v;
    } else if (k === 'tempUnit') {
      if (!isTempUnit(v)) return `tempUnit must be ${TEMP_UNITS.join(' or ')}`;
      out.tempUnit = v;
    } else {
      return `unknown field ${k}`;
    }
  }
  return Object.keys(out).length ? out : 'empty patch';
}

/** Validated vessel settings patch, or an error string. */
export function parseVesselPatch(body: unknown): VesselSettings | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'expected a JSON object';
  const b = body as Record<string, unknown>;
  const out: VesselSettings = {};
  for (const k of Object.keys(b)) {
    if (k === 'surfaceToTransducerCm') {
      const v = b[k];
      // The same limit the sonar puts on its own offset.
      if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_TRANSDUCER_OFFSET_CM)) {
        return `surfaceToTransducerCm must be 0..${MAX_TRANSDUCER_OFFSET_CM} or null`;
      }
      out.surfaceToTransducerCm = v === null ? null : Math.round(v);
    } else {
      return `unknown field ${k}`;
    }
  }
  return Object.keys(out).length ? out : 'empty patch';
}

type LogFn = (msg: string) => void;
/**
 * Where a store reports: `error` for a file that cannot be read or saved (the setting
 * still applies in memory), `debug` for a file whose contents are ignored. A single
 * function is used for both.
 */
export interface StoreLog { debug?: LogFn; error?: LogFn }

/** One JSON file of settings, validated with `parse` on load. */
export class JsonStore<T extends object> {
  #parse: (body: unknown) => T | string;
  #file: () => string | undefined;
  #debug: LogFn;
  #error: LogFn;
  #prefs: T | null = null;

  /**
   * `file` names the JSON file and is resolved on first use (Signal K hands out the
   * plugin's data directory only after the plugin is constructed); undefined keeps the
   * choice in memory only.
   */
  constructor(parse: (body: unknown) => T | string, file: () => string | undefined = () => undefined, log: StoreLog | LogFn = {}) {
    this.#parse = parse;
    this.#file = file;
    const l = typeof log === 'function' ? { debug: log, error: log } : log;
    this.#debug = l.debug ?? (() => {});
    this.#error = l.error ?? this.#debug;
  }

  /** The settings picked so far, read from the file on first use. */
  get(): T {
    if (!this.#prefs) {
      this.#prefs = {} as T;
      const f = this.#path();
      if (f) {
        try {
          const p = this.#parse(JSON.parse(fs.readFileSync(f, 'utf8')));
          if (typeof p === 'string') this.#debug(`ignoring ${f}: ${p}`);
          else this.#prefs = p;
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ENOTDIR') this.#error(`cannot read ${f}: ${errorMessage(e)}`); // no file yet is normal
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
        this.#error(`cannot save ${f}: ${errorMessage(e)}`);
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
  constructor(file?: () => string | undefined, log?: StoreLog | LogFn) {
    super(parseDisplayPatch, file, log);
  }
}

/** Vessel settings the sonar does not hold (the waterline-to-transducer distance). */
export class VesselStore extends JsonStore<VesselSettings> {
  constructor(file?: () => string | undefined, log?: StoreLog | LogFn) {
    super(parseVesselPatch, file, log);
  }
}
