// Depth units and range tables, as used by the Android app (e0.a in v0.7.1).
// Shared by the plugin and the web app.

/** Depth unit ids, as stored in display prefs and viewer prefs. */
export const DEPTH_UNIT_IDS = ['ft', 'm', 'fa'] as const;
export type DepthUnitId = (typeof DEPTH_UNIT_IDS)[number];
/** True for one of DEPTH_UNIT_IDS. */
export const isDepthUnitId = (v: unknown): v is DepthUnitId => (DEPTH_UNIT_IDS as readonly unknown[]).includes(v);

/**
 * Transducer offset limit the app enforces, cm; also the limit on the waterline-to-transducer
 * distance the plugin keeps (system settings off 60, PROTOCOL.md §6).
 */
export const MAX_TRANSDUCER_OFFSET_CM = 300;
/** Deepest range the unit accepts, cm (its settings-limit message advertises 40000, PROTOCOL.md §5). */
export const MAX_RANGE_CM = 40_000;
/** Smallest Deep − Shallow window accepted from the web app, cm (the app's smallest preset window is 5 ft). */
export const MIN_RANGE_WINDOW_CM = 100;

export interface DepthUnit {
  /** Code used in system settings off 79. */
  code: number;
  id: DepthUnitId;
  label: string;
  symbol: string;
  /** Centimetres per unit. */
  cm: number;
  /** Range presets offered by the Shallow/Deep selectors, in units. */
  ranges: readonly number[];
  /** Number of depth lines drawn for the range preset at the same index. */
  lines: readonly number[];
}

export const DEPTH_UNITS: readonly DepthUnit[] = Object.freeze([
  {
    code: 0, id: 'ft', label: 'Feet', symbol: 'ft', cm: 30.48,
    ranges: [0, 5, 6, 8, 10, 12, 15, 18, 20, 24, 30, 35, 40, 50, 60, 80, 100, 120, 150, 180, 240, 300, 350, 400, 500, 600, 800, 1000, 1200],
    lines: [0, 4, 2, 3, 4, 3, 2, 2, 3, 3, 2, 4, 3, 4, 3, 3, 3, 3, 2, 2, 3, 4, 4, 4, 4, 4, 3, 4, 3],
  },
  {
    code: 1, id: 'm', label: 'Meters', symbol: 'm', cm: 100,
    ranges: [0, 2, 3, 4, 5, 6, 8, 10, 12, 15, 18, 20, 24, 30, 35, 40, 50, 60, 80, 100, 120, 150, 180, 240, 300, 360],
    lines: [0, 1, 2, 3, 4, 2, 3, 4, 3, 2, 2, 3, 3, 4, 4, 3, 4, 4, 3, 4, 3, 4, 3, 3, 4, 4],
  },
  {
    code: 2, id: 'fa', label: 'Fathoms', symbol: 'Fa', cm: 182.88,
    ranges: [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 18, 20, 24, 30, 35, 40, 50, 60, 80, 100, 125, 150, 180, 200],
    lines: [0, 1, 1, 2, 3, 4, 4, 3, 3, 4, 3, 4, 3, 3, 4, 4, 4, 3, 4, 4, 3, 4, 4, 2, 3],
  },
]);

/** Depth unit with this id ('ft', 'm', 'fa'); metres if unknown. */
export function unitById(id: string): DepthUnit {
  return DEPTH_UNITS.find((u) => u.id === id) ?? DEPTH_UNITS[1];
}
/** Depth unit for a system settings unit code; metres if unknown. */
export function unitByCode(code: number): DepthUnit {
  return DEPTH_UNITS.find((u) => u.code === code) ?? DEPTH_UNITS[1];
}

/** Range preset `i` of `u` in whole cm, as the app sends it. */
export const presetCm = (u: DepthUnit, i: number): number => Math.trunc(u.ranges[i] * u.cm);

/** Snap a depth in cm to the nearest preset of `u` (the app does this when the unit changes). */
export function snapToPreset(u: DepthUnit, cm: number): number {
  const top = presetCm(u, u.ranges.length - 1);
  if (cm > top) return top;
  for (let i = 1; i < u.ranges.length; i++) {
    const a = presetCm(u, i - 1), b = presetCm(u, i);
    if (cm >= a && cm <= b) return cm - a < b - cm ? a : b;
  }
  return 0;
}

/** Depth lines for a view whose height is exactly a preset; -1 when it isn't one. */
export function depthLinesFor(u: DepthUnit, rangeCm: number): number {
  const i = u.ranges.findIndex((_, k) => presetCm(u, k) === rangeCm);
  return i < 0 ? -1 : u.lines[i];
}

export const TEMP_UNITS = ['C', 'F'] as const;
export type TempUnit = (typeof TEMP_UNITS)[number];
/** True for 'C' or 'F'. */
export const isTempUnit = (v: unknown): v is TempUnit => (TEMP_UNITS as readonly unknown[]).includes(v);

/**
 * Water temperature as the app shows it (SonarTraceActivity.d()): °C tenths are
 * truncated, and °F is computed from that truncated °C and rounded to tenths.
 */
export function formatTemp(centiC: number | null, unit: TempUnit): { whole: string; frac: string; symbol: string } {
  const symbol = unit === 'C' ? '°C' : '°F';
  if (centiC === null || !Number.isFinite(centiC)) return { whole: '--', frac: '-', symbol: '--' };
  const tenthsC = Math.trunc(centiC / 10); // e.g. 1299 -> 129 (12.9 °C)
  const tenths = unit === 'C' ? tenthsC : Math.round(((tenthsC / 10) * 9 / 5 + 32) * 10);
  const sign = tenths < 0 ? '-' : '';
  const a = Math.abs(tenths);
  return { whole: sign + Math.floor(a / 10), frac: String(a % 10), symbol };
}

/** Depth with one decimal, truncated like the app ("%d.%d"); negative depths show as 0.0 like the app. */
export function formatDepth(cm: number | null, u: DepthUnit): { whole: string; frac: string; symbol: string } {
  if (cm === null || !Number.isFinite(cm)) return { whole: '--', frac: '-', symbol: u.symbol };
  // One division, then one truncation to tenths: (230 / 100) * 100 is 229.999…, which would show 2.30 m as 2.2.
  const tenths = Math.trunc((Math.max(0, cm) / u.cm) * 10);
  return { whole: String(Math.trunc(tenths / 10)), frac: String(tenths % 10), symbol: u.symbol };
}
