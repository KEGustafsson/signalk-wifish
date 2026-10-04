// Raw capture format written by wifish-probe --log and read by dump-raw / replay:
//   record = [u64 LE unix ms][u8 channel 0=discovery 1=data][u32 LE length][bytes]

export const RECORD_HEADER = 13;
export const CHANNEL = Object.freeze({ DISCOVERY: 0, DATA: 1 });

export type RawRecord = { ts: number; channel: number; msg: Buffer };
export type Truncated = { truncated: { offset: number; missing: number } };

/** One complete record as a single buffer, so a crash can't leave a header without its body. */
export function encodeRecord(channel: number, msg: Uint8Array, nowMs = Date.now()): Buffer {
  const r = Buffer.alloc(RECORD_HEADER + msg.length);
  r.writeBigUInt64LE(BigInt(nowMs), 0);
  r.writeUInt8(channel, 8);
  r.writeUInt32LE(msg.length, 9);
  r.set(msg, RECORD_HEADER);
  return r;
}

/** The complete record at offset `o` (the caller knows it is complete, e.g. from readRawLog). */
export function recordAt(buf: Buffer, o: number): RawRecord {
  return { ts: Number(buf.readBigUInt64LE(o)), channel: buf[o + 8], msg: buf.subarray(o + RECORD_HEADER, o + RECORD_HEADER + buf.readUInt32LE(o + 9)) };
}

/**
 * Iterate records in a capture. Stops at a truncated record and yields
 * `{ truncated: { offset, missing } }` as the last item instead of a short message.
 */
export function* readRawLog(buf: Buffer): Generator<RawRecord | Truncated> {
  let o = 0;
  while (o < buf.length) {
    if (o + RECORD_HEADER > buf.length) {
      yield { truncated: { offset: o, missing: o + RECORD_HEADER - buf.length } };
      return;
    }
    const len = buf.readUInt32LE(o + 9);
    const end = o + RECORD_HEADER + len;
    if (end > buf.length) {
      yield { truncated: { offset: o, missing: end - buf.length } };
      return;
    }
    yield recordAt(buf, o);
    o = end;
  }
}
