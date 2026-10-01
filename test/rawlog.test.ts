import { test, expect } from 'vitest';
import { encodeRecord, readRawLog } from '../src/rawlog';

test('encodeRecord / readRawLog round trip', () => {
  const buf = Buffer.concat([encodeRecord(0, Buffer.from([1, 2, 3]), 1000), encodeRecord(1, Buffer.alloc(0), 2000)]);
  const recs = [...readRawLog(buf)] as { ts: number; channel: number; msg: Buffer }[];
  expect(recs.length).toBe(2);
  expect({ ...recs[0], msg: [...recs[0].msg] }).toEqual({ ts: 1000, channel: 0, msg: [1, 2, 3] });
  expect(recs[1].ts).toBe(2000);
  expect(recs[1].channel).toBe(1);
  expect(recs[1].msg.length).toBe(0);
});

test('readRawLog reports a truncated body instead of yielding a short message', () => {
  const full = encodeRecord(1, Buffer.alloc(68), 5);
  const recs = [...readRawLog(Buffer.concat([encodeRecord(0, Buffer.from([9]), 1), full.subarray(0, 20)]))];
  expect(recs.length).toBe(2);
  expect(recs[1]).toEqual({ truncated: { offset: 14, missing: 61 } });
});

test('readRawLog reports a partial header', () => {
  expect([...readRawLog(Buffer.alloc(5))]).toEqual([{ truncated: { offset: 0, missing: 8 } }]);
});
