// Display units chosen in the web app (depth and temperature), kept by the plugin so
// every browser and device shows the same units and the choice survives restarts.

import fs from 'node:fs';
import path from 'node:path';
import type { DisplayPrefs } from './shared/api';

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

export class DisplayStore {
  #file: () => string | undefined;
  #log: (m: string) => void;
  #prefs: DisplayPrefs | null = null;

  /**
   * `file` names the JSON file and is resolved on first use (Signal K hands out the
   * plugin's data directory only after the plugin is constructed); undefined keeps the
   * choice in memory only.
   */
  constructor(file: () => string | undefined = () => undefined, log: (m: string) => void = () => {}) {
    this.#file = file;
    this.#log = log;
  }

  /** The units picked so far, read from the file on first use. */
  get(): DisplayPrefs {
    if (!this.#prefs) {
      this.#prefs = {};
      const f = this.#path();
      if (f) {
        try {
          const p = parseDisplayPatch(JSON.parse(fs.readFileSync(f, 'utf8')));
          if (typeof p === 'string') this.#log(`ignoring ${f}: ${p}`);
          else this.#prefs = p;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.#log(`cannot read ${f}: ${(e as Error).message}`);
        }
      }
    }
    return { ...this.#prefs };
  }

  /** Merge `patch` into the units and save them (failures are logged; the choice still applies until restart). */
  set(patch: DisplayPrefs): DisplayPrefs {
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
