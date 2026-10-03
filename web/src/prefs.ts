// Viewer preferences (per browser), like the app's SharedPreferences.

import { DEFAULT_PALETTE, DOWNVISION_PALETTES, SONAR_PALETTES } from './palettes';
import { isDepthUnitId, isTempUnit, type DepthUnitId, type TempUnit } from '../../src/shared/units';

export type ViewConfig = 'split' | 'sonar' | 'downvision';
const VIEWS: readonly ViewConfig[] = ['split', 'sonar', 'downvision'];
/** True for one of the view configurations. */
export const isViewConfig = (v: unknown): v is ViewConfig => (VIEWS as readonly unknown[]).includes(v);

export interface Prefs {
  paletteSonar: number;
  paletteDownvision: number;
  depthLines: boolean;
  aScope: boolean;
  /** null = follow the sonar's own depth unit. */
  depthUnit: DepthUnitId | null;
  tempUnit: TempUnit;
  view: ViewConfig;
  /** Horizontal speed factor: screen px per ping column (1..5). */
  speed: number;
  settingsTab: number;
}
export type PrefKey = keyof Prefs;

const KEY = 'signalk-wifish.prefs';
/** Keys the user picked in this browser (as opposed to defaults that only happen to be stored). */
const PICKED_KEY = 'signalk-wifish.prefs.picked';
export const MIN_SPEED = 1;
export const MAX_SPEED = 5;
export const SETTINGS_TABS = 3;

/**
 * Prefs the user picked in this browser, as opposed to defaults. Only these are ever offered
 * to the server as the shared display units; a locale default (°F) is not a pick.
 */
export const storedKeys = new Set<PrefKey>();

/** Fresh default prefs; °F for US-style locales, °C otherwise. */
export const defaults = (): Prefs => ({
  paletteSonar: DEFAULT_PALETTE.sonar,
  paletteDownvision: DEFAULT_PALETTE.downvision,
  depthLines: false,
  aScope: false,
  depthUnit: null,
  tempUnit: /^en-US|^en-LR|^my/.test(typeof navigator !== 'undefined' ? navigator.language ?? '' : '') ? 'F' : 'C',
  view: 'split',
  speed: 1,
  settingsTab: 0,
});

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * `stored` values that are valid, over the defaults. Each key is checked for type and range;
 * anything else (an old format, a hand-edited value, another app's key) falls back to the default.
 */
export function sanitize(stored: unknown, base: Prefs = defaults()): Prefs {
  const p: Prefs = { ...base };
  if (typeof stored !== 'object' || stored === null) return p;
  const s = stored as Record<string, unknown>;
  if (isNum(s.paletteSonar) && SONAR_PALETTES.includes(s.paletteSonar)) p.paletteSonar = s.paletteSonar;
  if (isNum(s.paletteDownvision) && DOWNVISION_PALETTES.includes(s.paletteDownvision)) p.paletteDownvision = s.paletteDownvision;
  if (isBool(s.depthLines)) p.depthLines = s.depthLines;
  if (isBool(s.aScope)) p.aScope = s.aScope;
  if (s.depthUnit === null || isDepthUnitId(s.depthUnit)) p.depthUnit = s.depthUnit;
  if (isTempUnit(s.tempUnit)) p.tempUnit = s.tempUnit;
  if (isViewConfig(s.view)) p.view = s.view;
  if (isNum(s.speed)) p.speed = Math.max(MIN_SPEED, Math.min(MAX_SPEED, s.speed));
  if (isNum(s.settingsTab)) p.settingsTab = Math.max(0, Math.min(SETTINGS_TABS - 1, Math.trunc(s.settingsTab)));
  return p;
}

/** Read and parse a localStorage key; undefined when missing, unreadable or blocked. */
function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined; // private window, blocked storage, corrupt JSON
  }
}

/** Stored prefs over the defaults, and the keys the user picked here; defaults alone without storage. */
function load(): Prefs {
  const base = defaults();
  const stored = readJson(KEY);
  const p = sanitize(stored, base);
  const picked = readJson(PICKED_KEY);
  // Only keys from the picked list count as the user's choice: a stored value that merely
  // equals the default (or predates the list) says nothing about who chose it.
  if (Array.isArray(picked)) {
    for (const k of picked) if (typeof k === 'string' && k in base) storedKeys.add(k as PrefKey);
  }
  return p;
}

export const prefs: Prefs = load();

/** Apply `patch` (the user's picks) to the live prefs and persist them and the picked keys (best effort). */
export function savePrefs(patch: Partial<Prefs>): void {
  Object.assign(prefs, patch);
  for (const k of Object.keys(patch)) storedKeys.add(k as PrefKey);
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
    localStorage.setItem(PICKED_KEY, JSON.stringify([...storedKeys]));
  } catch { /* not persisted */ }
}
