// Pure echogram geometry shared by TraceView and its tests: no canvas, no DOM.
// Columns are laid out in *device* pixels of the echo canvas (colW device px each,
// newest at the right edge); the depth window is in cm below the transducer.

import { depthLinesFor, snapToPreset, type DepthUnit } from '../../src/shared/units';

/** Share of the width taken by the zoom box (when zoomed) and the A-scope (sonar only). */
export const ZOOM_BOX = 0.15;
export const ASCOPE = 0.08;
/** Smallest zoom window, cm, and largest zoom factor relative to the full range. */
export const MIN_WINDOW_CM = 50;
export const MAX_ZOOM = 20;
/** Where the tracked bottom is kept while zoomed (fraction of the height). */
export const BOTTOM_AT = 0.75;
/** How far the bottom may drift from where it was placed before the view follows it again, CSS px. */
export const RETRACK_PX = 40;
/** Window shown without data, cm. */
export const DEFAULT_RANGE_CM = 1000;

export interface Window { top: number; bottom: number }
export interface Layout { main: number; zoomBox: number; aScope: number }

/** Clamp a speed (CSS px per column as the user picks it) to 1..5. */
export const clampSpeed = (s: number): number => (Number.isFinite(s) ? Math.max(1, Math.min(5, s)) : 1);

/**
 * Device px per column: the speed scaled by the echo canvas ratio and rounded to whole pixels,
 * so scrolling by one column shifts the picture by a whole number of pixels (incremental redraw).
 */
export const columnWidth = (speed: number, rs: number): number => Math.max(1, Math.round(speed * rs));

/** CSS px widths of the echogram area, zoom box and A-scope for an element `cssW` wide. */
export function layout(cssW: number, zoomed: boolean, aScope: boolean): Layout {
  const zoomBox = zoomed ? Math.round(cssW * ZOOM_BOX) : 0;
  const a = aScope ? Math.round(cssW * ASCOPE) : 0;
  return { main: Math.max(10, cssW - zoomBox - a), zoomBox, aScope: a };
}

/** Columns that fit (even partly) in `mainDev` device px at `colW` device px each. */
export const visibleColumns = (mainDev: number, colW: number): number => Math.max(1, Math.ceil(mainDev / colW));

/** Column number drawn at device px `x` when column `right` ends at `x1` (exclusive) with `colW` px per column. */
export const columnAt = (right: number, x1: number, x: number, colW: number): number =>
  right - Math.floor((x1 - 1 - x) / colW);

/** Device px span [x0, x1) that column `n` covers when column `right` ends at `x1`. */
export function columnSpan(right: number, x1: number, n: number, colW: number): { x0: number; x1: number } {
  return { x0: x1 - (right - n + 1) * colW, x1: x1 - (right - n) * colW };
}

/** Oldest right-edge column that still fills `vis` columns (or shows all of a shorter history). */
export const minRight = (first: number, last: number, vis: number): number =>
  first + Math.min(vis, last - first + 1) - 1;

/**
 * Right-edge column after scrolling `right` by `cols` (positive = newer) through columns
 * first..last with `vis` visible: null when it reaches the newest column (live again).
 */
export function scrollTarget(right: number, cols: number, first: number, last: number, vis: number): number | null {
  const next = Math.max(minRight(first, last, vis), Math.round(right + cols));
  return next >= last ? null : next;
}

/** Right-edge column `n` re-clamped after the store trimmed: never before the oldest filling position. */
export function clampRight(n: number | null, first: number, last: number, vis: number): number | null {
  if (n === null) return null;
  const m = Math.max(minRight(first, last, vis), n);
  return m >= last ? null : m;
}

/**
 * Unzoomed window, cm below the transducer, for a reference column: its range snapped to the
 * unit's presets, taken as *displayed* depths like the app so the ruler starts at 0 and the
 * echoes shift by the transducer offset. Without a column: 0..10 m displayed.
 */
export function fullWindow(col: { startCm: number; endCm: number } | undefined, unit: DepthUnit, offsetCm: number): Window {
  if (!col) return { top: 0 - offsetCm, bottom: DEFAULT_RANGE_CM - offsetCm };
  const top = snapToPreset(unit, col.startCm);
  const bottom = snapToPreset(unit, col.endCm);
  const w = bottom > top ? { top, bottom } : { top: col.startCm, bottom: col.endCm };
  return { top: w.top - offsetCm, bottom: w.bottom - offsetCm };
}

/** Fit a zoom window in the full range within the zoom limits; null when it is (nearly) the full range. */
export function clampZoom(w: Window, full: Window): Window | null {
  const fullH = full.bottom - full.top;
  let h = w.bottom - w.top;
  if (h >= fullH * 0.98) return null;
  h = Math.max(h, Math.max(MIN_WINDOW_CM, fullH / MAX_ZOOM));
  let top = Math.max(full.top, Math.min(w.top, full.bottom - h));
  if (!Number.isFinite(top)) top = full.top;
  return { top, bottom: top + h };
}

/**
 * Window `w` zoomed by `factor` (> 1 = closer), before clamping: anchored at fraction `anchor`
 * of the height, or around the tracked bottom (kept at BOTTOM_AT) when `bottomCm` is given and
 * inside the window.
 */
export function zoomWindow(w: Window, factor: number, anchor: number | undefined, bottomCm: number | null): Window {
  const h = w.bottom - w.top;
  const newH = h / factor;
  let top: number;
  if (anchor === undefined && bottomCm !== null && bottomCm > w.top && bottomCm < w.bottom) {
    top = bottomCm - BOTTOM_AT * newH;
  } else {
    const fy = anchor ?? 0.5;
    const z = w.top + fy * h;
    top = z - fy * newH;
  }
  return { top, bottom: top + newH };
}

/** Depth (cm) at fraction `fy` of the height in window `w`. */
export const depthAt = (w: Window, fy: number): number => w.top + fy * (w.bottom - w.top);

/** Decimals needed to show multiples of `step` exactly (1, 0.5, 0.25 ...). */
export function decimals(step: number): number {
  for (let d = 0; d < 3; d++) if (Math.abs(step * 10 ** d - Math.round(step * 10 ** d)) < 1e-6) return d;
  return 2;
}

export interface Ruler { topU: number; bottomU: number; step: number; dec: number; marks: number[] }

/**
 * Depth ruler for window `w` (cm below the transducer) in unit `u`, with the transducer offset
 * added: a preset range from the surface gets the app's line count, anything else a "nice" step.
 * `marks` are the displayed depths (in units) strictly inside the window.
 */
export function ruler(w: Window, u: DepthUnit, offsetCm: number): Ruler | null {
  const spanCm = w.bottom - w.top;
  if (!(spanCm > 0)) return null;
  const topU = (w.top + offsetCm) / u.cm;
  const bottomU = (w.bottom + offsetCm) / u.cm;
  const spanU = bottomU - topU;
  const lines = w.top + offsetCm === 0 ? depthLinesFor(u, Math.round(spanCm)) : -1;
  let step: number;
  if (lines > 0) step = spanU / (lines + 1);
  else {
    const raw = spanU / 4.5;
    const p = 10 ** Math.floor(Math.log10(raw));
    step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p;
  }
  const marks: number[] = [];
  const first = Math.ceil(topU / step - 1e-6) + 0; // + 0: never -0 from a window top at the surface
  for (let i = first; i * step < bottomU - 1e-6; i++) marks.push(i * step);
  return { topU, bottomU, step, dec: decimals(step), marks };
}
