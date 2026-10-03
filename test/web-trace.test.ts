import { test, expect, describe } from 'vitest';
import {
  MAX_ZOOM, MIN_WINDOW_CM, DEFAULT_RANGE_CM, clampRight, clampSpeed, clampZoom, columnAt, columnSpan, columnWidth, decimals,
  depthAt, fullWindow, layout, minRight, ruler, scrollTarget, visibleColumns, zoomWindow,
} from '../web/src/geometry';
import { ColumnStore } from '../web/src/history';
import { unitById } from '../src/shared/units';
import type { ColumnMessage } from '../src/shared/api';

const m = unitById('m'), ft = unitById('ft');

describe('column layout', () => {
  test('column width is a whole number of device px for every speed and ratio', () => {
    for (const rs of [1, 1.25, 1.5]) for (const speed of [1, 1.5, 2, 2.7, 3, 4.2, 5]) {
      const w = columnWidth(speed, rs);
      expect(Number.isInteger(w)).toBe(true);
      expect(w).toBeGreaterThanOrEqual(1);
      expect(Math.abs(w - speed * rs)).toBeLessThanOrEqual(0.5);
    }
  });

  test('forward mapping (columnSpan) and inverse (columnAt) round-trip for every pixel', () => {
    for (const colW of [1, 2, 3, 5, 7]) {
      const right = 1000, x1 = 301;
      for (let x = 0; x < x1; x++) {
        const n = columnAt(right, x1, x, colW);
        const span = columnSpan(right, x1, n, colW);
        expect(x).toBeGreaterThanOrEqual(span.x0);
        expect(x).toBeLessThan(span.x1);
        expect(span.x1 - span.x0).toBe(colW);
      }
      // the newest column ends exactly at the right edge
      expect(columnAt(right, x1, x1 - 1, colW)).toBe(right);
      expect(columnSpan(right, x1, right, colW).x1).toBe(x1);
    }
  });

  test('visibleColumns counts partly visible columns and agrees with columnAt at the left edge', () => {
    expect(visibleColumns(300, 3)).toBe(100);
    expect(visibleColumns(301, 3)).toBe(101);
    expect(visibleColumns(0, 3)).toBe(1);
    for (const [mainW, colW] of [[300, 3], [301, 3], [299, 2], [640, 7]] as const) {
      const vis = visibleColumns(mainW, colW);
      const oldest = columnAt(500, mainW, 0, colW);
      expect(500 - oldest + 1).toBe(vis);
    }
  });

  test('layout reserves the zoom box and A-scope and keeps a minimum echogram width', () => {
    expect(layout(1000, false, false)).toEqual({ main: 1000, zoomBox: 0, aScope: 0 });
    expect(layout(1000, true, true)).toEqual({ main: 770, zoomBox: 150, aScope: 80 });
    expect(layout(10, true, true).main).toBe(10);
  });
});

describe('scrolling', () => {
  test('scroll bounds: never before the oldest filling position, live at or past the newest', () => {
    // columns 100..199, 30 visible
    expect(minRight(100, 199, 30)).toBe(129);
    expect(scrollTarget(150, -100, 100, 199, 30)).toBe(129);
    expect(scrollTarget(150, -5, 100, 199, 30)).toBe(145);
    expect(scrollTarget(150, 49, 100, 199, 30)).toBeNull(); // reaches 199: live
    expect(scrollTarget(150, 48, 100, 199, 30)).toBe(198);
    expect(scrollTarget(150, 1000, 100, 199, 30)).toBeNull();
    // a short history (fewer columns than fit) scrolls nowhere
    expect(minRight(1, 5, 30)).toBe(5);
    expect(scrollTarget(5, -3, 1, 5, 30)).toBeNull(); // 2 < minRight 5 but 5 >= last: live
  });

  test('fractional scroll amounts are rounded', () => {
    expect(scrollTarget(150, -0.4, 100, 199, 30)).toBe(150);
    expect(scrollTarget(150, -0.6, 100, 199, 30)).toBe(149);
  });

  test('clampRight re-clamps a paused position after the store trimmed', () => {
    expect(clampRight(null, 100, 199, 30)).toBeNull();
    expect(clampRight(110, 100, 199, 30)).toBe(129); // older than what fills the screen
    expect(clampRight(150, 100, 199, 30)).toBe(150);
    expect(clampRight(199, 100, 199, 30)).toBeNull(); // at the newest column: live
    expect(clampRight(10, 100, 199, 30)).toBe(129);
  });

  test('scrollbar mapping reaches the oldest column and resumes live only at the newest', () => {
    const first = 100, last = 199, vis = 30, total = last - first + 1;
    const target = (frac: number) => Math.round(first + vis - 1 + frac * (total - vis));
    expect(target(0)).toBe(minRight(first, last, vis));
    expect(target(1)).toBe(last);
    expect(clampRight(target(1), first, last, vis)).toBeNull(); // far right: live
    expect(clampRight(target(0.99), first, last, vis)).toBe(198); // just short of it: still history
  });

  test('nearestByTime aligns traces with different ping rates', () => {
    const s = new ColumnStore('downvision', 100);
    const col = (n: number, t: number): ColumnMessage => ({ ch: 'downvision', n, t, startCm: 0, endCm: 1000, bottomCm: null, waterTempCentiC: null, data: '' });
    expect(s.nearestByTime(5)).toBeUndefined();
    for (let n = 1; n <= 10; n++) s.add(col(n, n * 1000));
    expect(s.nearestByTime(0)!.n).toBe(1);
    expect(s.nearestByTime(5400)!.n).toBe(5);
    expect(s.nearestByTime(5600)!.n).toBe(6);
    expect(s.nearestByTime(5000)!.n).toBe(5);
    expect(s.nearestByTime(99_999)!.n).toBe(10);
  });

  test('a column with bad base64 is dropped, not thrown', () => {
    const s = new ColumnStore('sonar', 10);
    expect(s.add({ ch: 'sonar', n: 1, t: 1, startCm: 0, endCm: 100, bottomCm: null, waterTempCentiC: null, data: '%%%not base64' })).toBe(false);
    expect(s.cols).toHaveLength(0);
    expect(s.add({ ch: 'sonar', n: 1, t: 1, startCm: 0, endCm: 100, bottomCm: null, waterTempCentiC: null, data: 'AQI=' })).toBe(true);
    expect([...s.cols[0].samples]).toEqual([1, 2]);
  });
});

describe('depth window', () => {
  test('fullWindow snaps the ping range to the unit presets and shifts by the transducer offset', () => {
    expect(fullWindow(undefined, m, 0)).toEqual({ top: 0, bottom: DEFAULT_RANGE_CM });
    expect(fullWindow(undefined, m, 50)).toEqual({ top: -50, bottom: 950 });
    expect(fullWindow({ startCm: 0, endCm: 1010 }, m, 0)).toEqual({ top: 0, bottom: 1000 });
    expect(fullWindow({ startCm: 0, endCm: 1010 }, m, 30)).toEqual({ top: -30, bottom: 970 });
    // feet presets: 1010 cm is nearest 30 ft (914 cm) or 35 ft (1066 cm)? 1066 is nearer
    expect(fullWindow({ startCm: 0, endCm: 1010 }, ft, 0)).toEqual({ top: 0, bottom: 1066 });
    // a range that snaps to nothing sensible keeps the ping's own
    expect(fullWindow({ startCm: 10, endCm: 20 }, m, 0)).toEqual({ top: 10, bottom: 20 });
  });

  test('clampZoom: nearly full = no zoom, limited by MIN_WINDOW_CM / MAX_ZOOM, kept inside the range', () => {
    const full = { top: 0, bottom: 1000 };
    expect(clampZoom({ top: 0, bottom: 990 }, full)).toBeNull();
    expect(clampZoom({ top: 100, bottom: 110 }, full)).toEqual({ top: 100, bottom: 100 + Math.max(MIN_WINDOW_CM, 1000 / MAX_ZOOM) });
    expect(clampZoom({ top: -100, bottom: 100 }, full)).toEqual({ top: 0, bottom: 200 });
    expect(clampZoom({ top: 900, bottom: 1100 }, full)).toEqual({ top: 800, bottom: 1000 });
    expect(clampZoom({ top: NaN, bottom: NaN }, full)!.top).toBe(0);
    const deep = { top: 0, bottom: 40_000 };
    expect(clampZoom({ top: 0, bottom: 100 }, deep)).toEqual({ top: 0, bottom: 2000 }); // 1/20 of the range
  });

  test('zoomWindow keeps the anchor depth under the pointer, or the bottom at 75 %', () => {
    const w = { top: 0, bottom: 1000 };
    const z = zoomWindow(w, 2, 0.25, null);
    expect(depthAt(z, 0.25)).toBeCloseTo(250);
    expect(z.bottom - z.top).toBeCloseTo(500);
    const b = zoomWindow(w, 2, undefined, 600);
    expect(depthAt(b, 0.75)).toBeCloseTo(600);
    // bottom outside the window: zoom around the middle
    const c = zoomWindow(w, 2, undefined, 2000);
    expect(depthAt(c, 0.5)).toBeCloseTo(500);
    // an explicit anchor wins over the bottom (mouse wheel while tracking)
    const d = zoomWindow(w, 2, 0.1, 600);
    expect(depthAt(d, 0.1)).toBeCloseTo(100);
  });

  test('clampSpeed keeps 1..5 and rejects NaN', () => {
    expect(clampSpeed(0)).toBe(1);
    expect(clampSpeed(2.5)).toBe(2.5);
    expect(clampSpeed(9)).toBe(5);
    expect(clampSpeed(NaN)).toBe(1);
  });
});

describe('ruler', () => {
  test('a preset range from the surface uses the app line count', () => {
    const r = ruler({ top: 0, bottom: 1000 }, m, 0)!; // 10 m: 4 lines -> step 2
    expect(r.step).toBe(2);
    expect(r.dec).toBe(0);
    expect(r.marks).toEqual([0, 2, 4, 6, 8]);
    expect(r.bottomU).toBe(10);
  });

  test('the transducer offset shifts the marks onto round displayed depths', () => {
    const r = ruler({ top: -50, bottom: 950 }, m, 50)!;
    expect(r.topU).toBe(0);
    expect(r.marks).toEqual([0, 2, 4, 6, 8]);
  });

  test('other windows get a nice step with as many decimals as it needs', () => {
    const r = ruler({ top: 300, bottom: 420 }, m, 0)!; // 1.2 m: raw 0.267 -> 0.5
    expect(r.step).toBe(0.5);
    expect(r.dec).toBe(1);
    expect(r.marks).toEqual([3, 3.5, 4]);
    expect(decimals(1)).toBe(0);
    expect(decimals(0.25)).toBe(2);
    expect(decimals(1 / 3)).toBe(2);
    expect(ruler({ top: 10, bottom: 10 }, m, 0)).toBeNull();
  });
});
