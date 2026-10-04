import { test, expect } from 'vitest';
import { ColumnStore, keptColumns } from '../web/src/history';
import { PALETTES, SONAR_PALETTES, DOWNVISION_PALETTES, lut, cssColour } from '../web/src/palettes';
import { DEFAULT_HISTORY_COLUMNS, MAX_HISTORY_COLUMNS, type ColumnMessage } from '../src/shared/api';

const col = (n: number, bytes: number[]): ColumnMessage => ({
  ch: 'sonar', n, t: n * 100, startCm: 0, endCm: 1000, bottomCm: 500, waterTempCentiC: 1500,
  data: Buffer.from(bytes).toString('base64'),
});

test('ColumnStore decodes, bounds and skips columns it already holds', () => {
  const s = new ColumnStore('sonar', 3);
  for (let n = 1; n <= 5; n++) s.add(col(n, [n, 2]));
  expect(s.cols.map((c) => c.n)).toEqual([3, 4, 5]);
  expect([...s.get(4)!.samples]).toEqual([4, 2]);
  expect(s.get(1)).toBeUndefined();
  s.add(col(5, [9])); // duplicate from a backlog
  expect(s.last).toBe(5);
  s.add(col(4, [7])); // older column from a backlog replayed after a reconnect
  expect(s.cols.map((c) => c.n)).toEqual([3, 4, 5]);
  expect([...s.get(4)!.samples]).toEqual([4, 2]);
  s.add(col(6, [6])); // newer column
  expect(s.cols.map((c) => c.n)).toEqual([4, 5, 6]);
  s.clear(); // restart (reset event or new epoch)
  s.add(col(1, [1]));
  expect(s.cols.map((c) => c.n)).toEqual([1]);
});

test('ColumnStore.resize trims to the new size and bounds later columns by it; clear() starts a new generation', () => {
  const s = new ColumnStore('sonar', 5);
  for (let n = 1; n <= 5; n++) s.add(col(n, [n]));
  s.resize(3);
  expect(s.max).toBe(3);
  expect(s.cols.map((c) => c.n)).toEqual([3, 4, 5]);
  s.add(col(6, [6]));
  expect(s.cols.map((c) => c.n)).toEqual([4, 5, 6]);
  s.resize(10); // growing keeps what is held
  for (let n = 7; n <= 9; n++) s.add(col(n, [n]));
  expect(s.cols.map((c) => c.n)).toEqual([4, 5, 6, 7, 8, 9]);
  const g = s.generation;
  s.clear();
  expect(s.generation).toBe(g + 1);
});

test('keptColumns follows the server history within DEFAULT..MAX_HISTORY_COLUMNS', () => {
  expect(keptColumns(0)).toBe(DEFAULT_HISTORY_COLUMNS);
  expect(keptColumns(DEFAULT_HISTORY_COLUMNS - 1)).toBe(DEFAULT_HISTORY_COLUMNS);
  expect(keptColumns(5000)).toBe(5000);
  expect(keptColumns(MAX_HISTORY_COLUMNS * 2)).toBe(MAX_HISTORY_COLUMNS);
  expect(new ColumnStore('sonar').max).toBe(MAX_HISTORY_COLUMNS); // until the server says
});

test('palettes: nine, split between channels like the app, 256 opaque colours', () => {
  expect(PALETTES).toHaveLength(9);
  expect([...SONAR_PALETTES, ...DOWNVISION_PALETTES].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  for (const p of PALETTES) {
    expect(p.stops.split(' ')).toHaveLength(17);
    const l = lut(p.id);
    expect(l).toHaveLength(256);
    expect(l.every((c) => c >>> 24 === 255 || (c & 255) === 255)).toBe(true);
  }
  expect(cssColour(0, 0)).toBe('rgb(0,0,0)');
  expect(cssColour(0, 255)).toBe('rgb(255,255,255)');
  expect(cssColour(4, 255)).toBe('rgb(128,0,0)');
});
