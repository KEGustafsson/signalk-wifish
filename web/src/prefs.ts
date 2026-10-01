// Viewer preferences (per browser), like the app's SharedPreferences.

import { DEFAULT_PALETTE } from './palettes';
import type { TempUnit } from '../../src/shared/units';

export type ViewConfig = 'split' | 'sonar' | 'downvision';

export interface Prefs {
  paletteSonar: number;
  paletteDownvision: number;
  depthLines: boolean;
  aScope: boolean;
  /** null = follow the sonar's own depth unit. */
  depthUnit: 'ft' | 'm' | 'fa' | null;
  tempUnit: TempUnit;
  view: ViewConfig;
  /** Horizontal speed factor: screen px per ping column (1..5). */
  speed: number;
  settingsTab: number;
}

const KEY = 'signalk-wifish.prefs';
/** Prefs this browser has stored (picked by the user here), as opposed to defaults. */
export const storedKeys = new Set<string>();
/** Fresh default prefs; °F for US-style locales, °C otherwise. */
const defaults = (): Prefs => ({
  paletteSonar: DEFAULT_PALETTE.sonar,
  paletteDownvision: DEFAULT_PALETTE.downvision,
  depthLines: false,
  aScope: false,
  depthUnit: null,
  tempUnit: /^en-US|^en-LR|^my/.test(navigator.language) ? 'F' : 'C',
  view: 'split',
  speed: 1,
  settingsTab: 0,
});

/** Stored prefs over the defaults; defaults alone when storage is missing, unreadable or blocked. */
function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const stored = JSON.parse(raw);
      for (const k of Object.keys(stored)) storedKeys.add(k);
      return { ...defaults(), ...stored };
    }
  } catch { /* private window, blocked storage */ }
  return defaults();
}

export const prefs: Prefs = load();

/** Apply `patch` to the live prefs and persist them (best effort). */
export function savePrefs(patch: Partial<Prefs>): void {
  Object.assign(prefs, patch);
  for (const k of Object.keys(patch)) storedKeys.add(k);
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* not persisted */ }
}
