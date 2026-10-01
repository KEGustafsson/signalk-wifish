import { test, expect } from 'vitest';
import { DEPTH_UNITS, unitById, unitByCode, presetCm, snapToPreset, depthLinesFor, formatDepth, formatTemp } from '../src/shared/units';

test('range tables line up with their depth-line counts', () => {
  for (const u of DEPTH_UNITS) expect(u.lines.length).toBe(u.ranges.length);
});

test('unit lookup and presets', () => {
  expect(unitById('ft').cm).toBe(30.48);
  expect(unitByCode(2).symbol).toBe('Fa');
  expect(unitByCode(9).id).toBe('m');
  expect(presetCm(unitById('ft'), 1)).toBe(152); // 5 ft, truncated like the app
  expect(snapToPreset(unitById('m'), 1320)).toBe(1200);
  expect(snapToPreset(unitById('m'), 99_999)).toBe(36_000);
  expect(depthLinesFor(unitById('m'), 1000)).toBe(4);
  expect(depthLinesFor(unitById('m'), 1234)).toBe(-1);
});

test('depth and temperature formatting', () => {
  expect(formatDepth(1234, unitById('m'))).toEqual({ whole: '12', frac: '3', symbol: 'm' });
  expect(formatDepth(null, unitById('ft'))).toEqual({ whole: '--', frac: '-', symbol: 'ft' });
  expect(formatDepth(3048, unitById('ft'))).toMatchObject({ whole: '100', frac: '0' });
  expect(formatTemp(1234, 'C')).toEqual({ whole: '12', frac: '3', symbol: '°C' });
  expect(formatTemp(1000, 'F')).toEqual({ whole: '50', frac: '0', symbol: '°F' });
  expect(formatTemp(-150, 'C')).toEqual({ whole: '-1', frac: '5', symbol: '°C' });
  expect(formatTemp(null, 'C').whole).toBe('--');
});
