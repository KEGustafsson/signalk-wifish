import { test, expect } from 'vitest';
import { centiCToK, cmToM, toDelta, depthValues, Throttle, PATH } from '../src/signalk';

test('centiCToK has no float noise across -40..+60 degC', () => {
  for (let c = -4000; c <= 6000; c++) {
    const k = centiCToK(c);
    expect(k).toBe(Number(k.toFixed(2)));
  }
  expect(centiCToK(1234)).toBe(285.49);
});

test('cmToM', () => expect(cmToM(1234)).toBe(12.34));

test('toDelta is a well-formed v1 delta, null allowed', () => {
  expect(toDelta([{ path: PATH.depth, value: null }]))
    .toEqual({ context: 'vessels.self', updates: [{ values: [{ path: 'environment.depth.belowTransducer', value: null }] }] });
});

test('depthValues applies the transducer offset convention', () => {
  expect(depthValues(1000, 0)).toEqual([{ path: PATH.depth, value: 10 }]);
  expect(depthValues(1050, 50)).toEqual([{ path: PATH.depth, value: 10 }, { path: PATH.depthBelowSurface, value: 10.5 }]);
  expect(depthValues(960, -40)).toEqual([{ path: PATH.depth, value: 10 }, { path: PATH.depthBelowKeel, value: 9.6 }]);
  expect(depthValues(null, 50)).toEqual([{ path: PATH.depth, value: null }, { path: PATH.depthBelowSurface, value: null }]);
});

test('Throttle: change, heartbeat, rate limit, null edge', () => {
  const t = new Throttle({ minIntervalMs: 200, heartbeatMs: 10_000 });
  expect(t.shouldEmit('p', 1, 0)).toBe(true);
  expect(t.shouldEmit('p', 2, 100)).toBe(false);
  expect(t.shouldEmit('p', 2, 300)).toBe(true);
  expect(t.shouldEmit('p', 2, 5_000)).toBe(false);
  expect(t.shouldEmit('p', 2, 10_300)).toBe(true);
  expect(t.shouldEmit('p', null, 10_301)).toBe(true);
  expect(t.shouldEmit('p', null, 10_400)).toBe(false);
  expect(t.shouldEmit('p', 3, 10_401)).toBe(true);
});
