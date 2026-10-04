// Builders and fakes shared by the tests.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { vi } from 'vitest';
import { VERSION, MsgId, CHAN_SETTINGS_LEN, SYS_SETTINGS_LEN, CS, SS } from '../src/sonar4';
import { encodeRecord } from '../src/rawlog';
import type { ColumnMessage } from '../src/shared/api';

/** A Sonar4 message: 16-byte header + caller-filled payload. */
export function msg(id: number, len: number, fill: (b: Buffer) => void = () => {}): Buffer {
  const b = Buffer.alloc(len);
  b.writeUInt32LE(id, 0); b.writeUInt32LE(len, 4); b.writeUInt32LE(VERSION, 8); b.writeUInt32LE(7, 12);
  fill(b);
  return b;
}

/** Bottom record with depth `cm` (-0x80000000 = no bottom lock). */
export const bottomMsg = (cm: number): Buffer => msg(MsgId.BOTTOM, 22, (b) => b.writeInt32LE(cm, 17));
/** Environment record with the water temperature in hundredths of °C (-0x8000 = invalid). */
export const envMsg = (centiC: number): Buffer => msg(MsgId.ENV, 68, (b) => b.writeInt16LE(centiC, 28));

/** Discovery msg 1, the unit message: unit type, serial and name. */
export function unitMsg(type = 63, name = '', serial = 0): Buffer {
  const b = Buffer.alloc(52);
  b.writeUInt32LE(MsgId.UNIT, 0); b.writeUInt32LE(type, 4); b.writeUInt32LE(serial, 8); b.write(name, 20, 'latin1');
  return b;
}

/** Discovery msg 0, a service announcement (sonar service 39 unless given), `len` bytes long. */
export function announceMsg(group: string, port: number, device: string, ctrlPort: number, { service = 39, len = 40 } = {}): Buffer {
  const b = Buffer.alloc(len);
  b.writeUInt32LE(MsgId.ANNOUNCE, 0); b.writeUInt32LE(service, 8);
  b.set(group.split('.').map(Number), 20); b.writeUInt32LE(port, 24);
  b.set(device.split('.').map(Number), 28); b.writeUInt32LE(ctrlPort, 32);
  return b;
}

export function segment({ seq, seg, count, total, offset, data, error = 0, setting = 5 }:
  { seq: number; seg: number; count: number; total: number; offset: number; data: number[]; error?: number; setting?: number }): Buffer {
  return msg(MsgId.PING_DATA, 37 + data.length, (b) => {
    b.writeUInt32LE(error, 16); b.writeUInt32LE(offset, 20); b.writeUInt32LE(total, 24);
    b[32] = 2; b[33] = seq; b[34] = seg; b[35] = count; b[36] = setting;
    Buffer.from(data).copy(b, 37);
  });
}

export function results(seq: number, channel: number, startCm: number, endCm: number): Buffer {
  return msg(MsgId.PING_RESULTS, 130, (b) => { b[16] = seq; b[95] = channel; b.writeInt32LE(startCm, 104); b.writeInt32LE(endCm, 108); });
}

export function channelSettings(index: number, seq: number, o: Partial<{ enabled: number; rangeAuto: number; shallow: number; deep: number; gain: number; gainAuto: number }> = {}): Buffer {
  return msg(MsgId.CHAN_SETTINGS, CHAN_SETTINGS_LEN, (b) => {
    b.writeInt32LE(seq, CS.SEQ);
    b[CS.INDEX] = index;
    b.write('CHIRP', CS.NAME, 'latin1');
    b[CS.ENABLED] = o.enabled ?? 1;
    b[CS.RANGE_AUTO] = o.rangeAuto ?? 1;
    b.writeInt32LE(o.shallow ?? 0, CS.RANGE_SHALLOW);
    b.writeInt32LE(o.deep ?? 2000, CS.RANGE_DEEP);
    b[CS.GAIN_AUTO] = o.gainAuto ?? 1;
    b[CS.GAIN] = o.gain ?? 50;
    b[73] = 0xab; // unknown byte that must survive read-modify-write
  });
}

export function systemSettings(seq: number, offsetCm = 0, unit = 1): Buffer {
  return msg(MsgId.SYS_SETTINGS, SYS_SETTINGS_LEN, (b) => {
    b.writeInt32LE(seq, SS.SEQ);
    b.write('Demo', SS.NAME, 'latin1');
    b.writeInt32LE(offsetCm, SS.TRANSDUCER_OFFSET);
    b[SS.DEPTH_UNIT] = unit;
    b[200] = 0x5a; // unknown byte that must survive read-modify-write
  });
}

/** Fake timers for the engine's clock: timers, Date and performance.now (not setImmediate or I/O). */
export const FAKE_CLOCK: Parameters<typeof vi.useFakeTimers>[0] = {
  toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date', 'performance'],
};

/** A fresh temporary directory. */
export const tempDir = (prefix = 'wifish-'): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** A raw capture of `msgs` on the data channel at times `ts` (ms), written to a new temp file; returns its path. */
export function captureFile(msgs: Uint8Array[], ts: number[] = msgs.map((_, i) => i * 100), tail: Buffer = Buffer.alloc(0)): string {
  const file = path.join(tempDir(), 'capture.bin');
  fs.writeFileSync(file, Buffer.concat([...msgs.map((m, i) => encodeRecord(1, m, ts[i])), tail]));
  return file;
}

/** `s` with every regular-expression metacharacter escaped. */
export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Poll until `cond` holds; reject after `ms`. */
export async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await sleep(10);
  }
}

/** A request: an emitter, GET with no headers unless overridden. */
export type FakeReq = EventEmitter & { method: string; headers: Record<string, string> } & Record<string, unknown>;
export const req = (o: Record<string, unknown> = {}): FakeReq => Object.assign(new EventEmitter(), { method: 'GET', headers: {}, ...o }) as FakeReq;

/** A ServerResponse stand-in that records what is written. */
export class FakeRes extends EventEmitter {
  statusCode = 0;
  headersSent = false;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  body = '';
  writableLength = 0;
  writableEnded = false;
  destroyed = false;
  /** When true, write() reports a full buffer (the caller must wait for 'drain'). */
  full = false;
  setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; }
  flushHeaders() { this.headersSent = true; }
  write(c: string) { this.headersSent = true; this.chunks.push(c); this.writableLength += c.length; return !this.full; }
  end(c?: string) { if (c) this.body = c; this.writableEnded = true; this.emit('close'); }
  destroy() { this.destroyed = true; this.emit('close'); }
  get json() { return JSON.parse(this.body); }
  /** SSE event names, one per chunk. */
  get events() { return this.chunks.map((c) => /^event: (\w+)/.exec(c)?.[1]).filter((e): e is string => !!e); }
  get cols(): ColumnMessage[] { return this.chunks.filter((c) => c.startsWith('event: col\n')).map((c) => JSON.parse(c.slice('event: col\ndata: '.length))); }
}
