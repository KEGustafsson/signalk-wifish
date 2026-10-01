import { test, expect } from 'vitest';
import { ColumnStore } from '../web/src/history';
import { PALETTES, SONAR_PALETTES, DOWNVISION_PALETTES, lut, cssColour } from '../web/src/palettes';
import type { ColumnMessage } from '../src/shared/api';

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
