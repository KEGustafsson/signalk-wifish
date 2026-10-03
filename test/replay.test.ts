import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReplayTransport, MAX_REPLAY_BYTES } from '../src/replay';
import { encodeRecord } from '../src/rawlog';
import { MsgId } from '../src/sonar4';
import { msg } from './helpers';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wifish-replay-')); });
afterEach(() => { vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }); });

/** Capture file of bottom records at the given timestamps (depth = index). */
function capture(name: string, ts: number[], tail: Buffer = Buffer.alloc(0)): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.concat([...ts.map((t, i) => encodeRecord(1, msg(MsgId.BOTTOM, 22, (b) => b.writeInt32LE(i, 17)), t)), tail]));
  return file;
}

/** Record link changes and datagrams; `connected` resolves at the first 'connected'. */
function watch(t: ReplayTransport) {
  const links: [string, string][] = [];
  const depths: number[] = [];
  const connected = new Promise<void>((r) => t.on('link', (s) => { if (s === 'connected') r(); }));
  const offline = new Promise<string>((r) => t.on('link', (s, m) => { if (s === 'offline') r(m); }));
  t.on('link', (s, m) => links.push([s, m]));
  t.on('datagram', (b) => depths.push(Buffer.from(b).readInt32LE(17)));
  return { links, depths, connected, offline };
}

describe('ReplayTransport', () => {
  test('plays records at their recorded gaps, caps long pauses at 2 s and loops after 1 s with a new session', async () => {
    vi.useFakeTimers();
    const file = capture('c.bin', [1000, 1500, 9000]);
    const t = new ReplayTransport(file);
    const w = watch(t);
    t.start();
    expect(w.links).toEqual([['connecting', `Loading ${file}`]]);
    await w.connected;
    expect(w.links.at(-1)).toEqual(['connected', `Replaying ${file}`]);
    expect(w.depths).toEqual([0]);
    vi.advanceTimersByTime(499);
    expect(w.depths).toEqual([0]);
    vi.advanceTimersByTime(1);
    expect(w.depths).toEqual([0, 1]);
    vi.advanceTimersByTime(1999); // recorded gap 7.5 s, capped at 2 s
    expect(w.depths).toEqual([0, 1]);
    vi.advanceTimersByTime(1);
    expect(w.depths).toEqual([0, 1, 2]);
    w.links.length = 0;
    vi.advanceTimersByTime(999); // loop gap 1 s
    expect(w.depths).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(w.links).toEqual([['connecting', `Replaying ${file} again`], ['connected', `Replaying ${file}`]]);
    expect(w.depths).toEqual([0, 1, 2, 0]);
    t.stop();
    expect(w.links.at(-1)).toEqual(['offline', 'stopped']);
    vi.advanceTimersByTime(10_000);
    expect(w.depths).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('speed scales every gap, the loop gap too', async () => {
    vi.useFakeTimers();
    const file = capture('c.bin', [0, 1000]);
    const t = new ReplayTransport(file, { speed: 4 });
    const w = watch(t);
    t.start();
    await w.connected;
    vi.advanceTimersByTime(249);
    expect(w.depths).toEqual([0]);
    vi.advanceTimersByTime(1);
    expect(w.depths).toEqual([0, 1]);
    vi.advanceTimersByTime(250); // 1 s loop gap / 4
    expect(w.depths).toEqual([0, 1, 0]);
    t.stop();
    expect(new ReplayTransport(file, { speed: 0 })).toBeTruthy(); // non-positive means 1 (no throw)
  });

  test('stops at a truncated tail record', async () => {
    vi.useFakeTimers();
    const whole = encodeRecord(1, msg(MsgId.BOTTOM, 22, (b) => b.writeInt32LE(99, 17)), 300);
    const file = capture('c.bin', [0, 100], whole.subarray(0, 20));
    const t = new ReplayTransport(file);
    const w = watch(t);
    t.start();
    await w.connected;
    vi.advanceTimersByTime(100);
    expect(w.depths).toEqual([0, 1]);
    vi.advanceTimersByTime(1000);
    expect(w.depths).toEqual([0, 1, 0]); // looped: the partial record was never played
    t.stop();
  });

  test('an empty file, a missing file, a directory and an oversized file go offline with a reason', async () => {
    const empty = capture('empty.bin', []);
    let t = new ReplayTransport(empty);
    let w = watch(t);
    t.start();
    expect(await w.offline).toBe(`${empty} has no records`);

    const missing = path.join(dir, 'missing.bin');
    t = new ReplayTransport(missing);
    w = watch(t);
    t.start();
    expect(await w.offline).toMatch(new RegExp(`^Cannot replay ${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: .*ENOENT`));

    t = new ReplayTransport(dir);
    w = watch(t);
    t.start();
    expect(await w.offline).toMatch(/not a file/);

    const huge = path.join(dir, 'huge.bin');
    fs.writeFileSync(huge, '');
    fs.truncateSync(huge, MAX_REPLAY_BYTES + 1); // sparse: no disk space needed
    t = new ReplayTransport(huge);
    w = watch(t);
    t.start();
    expect(await w.offline).toMatch(/over the 256 MiB limit/);
    for (const [s] of w.links) expect(s).not.toBe('connected');
    // After a failure stop() still reports 'stopped' and start() may try again.
    t.stop();
    expect(w.links.at(-1)).toEqual(['offline', 'stopped']);
  });

  test('stop() during the load wins: no connected, no datagrams, and a restart loads afresh', async () => {
    const file = capture('c.bin', [0, 100]);
    const t = new ReplayTransport(file);
    const w = watch(t);
    t.start();
    t.stop();
    expect(w.links).toEqual([['connecting', `Loading ${file}`], ['offline', 'stopped']]);
    await new Promise((r) => setTimeout(r, 50)); // the read finishes in the background
    expect(w.links).toHaveLength(2);
    expect(w.depths).toEqual([]);
    t.start();
    await w.connected;
    expect(w.depths).toEqual([0]);
    t.stop();
  });

  test('start() twice is one load; a stop from a link listener ends the loop', async () => {
    vi.useFakeTimers();
    const file = capture('c.bin', [0]);
    const t = new ReplayTransport(file);
    const w = watch(t);
    t.start();
    t.start();
    await w.connected;
    expect(w.links.filter(([s]) => s === 'connected')).toHaveLength(1);
    t.on('link', (s) => { if (s === 'connecting') t.stop(); });
    vi.advanceTimersByTime(1000); // wrap: 'connecting' stops us before 'connected'
    expect(w.links.slice(-2)).toEqual([['connecting', `Replaying ${file} again`], ['offline', 'stopped']]);
    expect(w.depths).toEqual([0]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
