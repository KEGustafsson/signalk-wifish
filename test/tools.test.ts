// Smoke test for the CLI tools in tools/: they run against the compiled dist/, so the
// suite builds it once when it is missing and then drives the tools as child processes.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DUMP = path.join(ROOT, 'tools', 'dump-raw.mjs');
const PROBE = path.join(ROOT, 'tools', 'wifish-probe.mjs');
const BOTTOM_ID = 0x270108;

/** Run a tool with node and return its exit code and output. */
function run(tool: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [tool, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 10_000 });
  if (r.error) throw r.error;
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** A 22-byte bottom message (0x270108): header, quality at 16, i32 depth (cm) at 17, channel at 21. */
function bottom(depthCm: number, quality = 3, channel = 1): Buffer {
  const b = Buffer.alloc(22);
  b.writeUInt32LE(BOTTOM_ID, 0);
  b.writeUInt32LE(22, 4);
  b.writeUInt32LE(116, 8);
  b.writeUInt32LE(0xc7c035c5, 12);
  b[16] = quality;
  b.writeInt32LE(depthCm, 17);
  b[21] = channel;
  return b;
}

let dir: string;
let capture: string;

beforeAll(async () => {
  // Same as `npx tsc -p tsconfig.json`, without depending on npx or a shell (CI runs on Windows too).
  if (!fs.existsSync(path.join(ROOT, 'dist', 'sonar4.js')) || !fs.existsSync(path.join(ROOT, 'dist', 'rawlog.js'))) {
    const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    const r = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    if (r.status !== 0) throw new Error(`tsc failed (${r.status}):\n${r.stdout}${r.stderr}`);
  }
  const { encodeRecord, CHANNEL } = await import(path.join(ROOT, 'dist', 'rawlog.js'));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wifish-tools-'));
  capture = path.join(dir, 'capture.bin');
  fs.writeFileSync(capture, Buffer.concat([
    encodeRecord(CHANNEL.DATA, bottom(230), 1_700_000_000_000),
    encodeRecord(CHANNEL.DATA, bottom(231), 1_700_000_001_000),
  ]));
}, 60_000);

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('dump-raw.mjs', () => {
  it('--help exits 0 with the usage', () => {
    const r = run(DUMP, '--help');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage: dump-raw');
  });

  it('lists the messages of a given id and counts them', () => {
    const r = run(DUMP, capture, '--id', '0x270108');
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    const listed = r.out.split('\n').filter((l) => l.includes('id=0x270108'));
    expect(listed).toHaveLength(2);
    expect(listed[0]).toContain('ch=1');
    expect(listed[0]).toContain('len=22');
    expect(r.out).toMatch(/0x270108: 2/);
  });

  it('counts without listing when no --id or --hex is given', () => {
    const r = run(DUMP, capture);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('id=0x270108');
    expect(r.out).toMatch(/0x270108: 2/);
  });

  it('rejects an empty --id with a usage error', () => {
    expect(run(DUMP, '--id', '').code).toBe(2);
    const r = run(DUMP, capture, '--id', '');
    expect(r.code).toBe(2);
    expect(r.err).toContain('--id');
    expect(r.err).toContain('Usage: dump-raw');
  });

  it('rejects a non-numeric --id and a missing file', () => {
    expect(run(DUMP, capture, '--id', 'bottom').code).toBe(2);
    const r = run(DUMP, path.join(dir, 'missing.bin'));
    expect(r.code).toBe(1);
    expect(r.err).not.toMatch(/^\s+at /m);
  });
});

describe('wifish-probe.mjs', () => {
  it('--help exits 0 with the usage', () => {
    const r = run(PROBE, '--help');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage: wifish-probe');
  });

  it('reports a missing --replay file in one line, without a stack trace', () => {
    const r = run(PROBE, '--replay', '/nonexistent.bin');
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err.trim().split('\n')).toHaveLength(1);
    expect(r.err).toContain('--replay');
    expect(r.err).not.toMatch(/^\s+at /m);
  });

  it('reports an unwritable --log path in one line', () => {
    const r = run(PROBE, '--log', path.join(dir, 'no-such-dir', 'raw.bin'), '--replay', capture);
    expect(r.code).toBe(1);
    expect(r.err.trim().split('\n')).toHaveLength(1);
    expect(r.err).toContain('--log');
  });

  it('decodes a capture with --replay and exits 0', () => {
    const r = run(PROBE, '--replay', capture);
    expect(r.code).toBe(0);
    expect(r.out).toContain('[depth] 2.30 m');
    expect(r.out).toContain('[depth] 2.31 m');
    expect(r.out).toMatch(/BOTTOM: 2/);
  });
});
