// Smoke test for the CLI tools in tools/: they run against the compiled dist/, so the
// suite builds it when it is missing or older than the sources, then drives the tools as
// child processes, concurrently.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MsgId } from '../src/sonar4';
import { captureFile, msg } from './helpers';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DUMP = path.join(ROOT, 'tools', 'dump-raw.mjs');
const PROBE = path.join(ROOT, 'tools', 'wifish-probe.mjs');

/** Run a tool with node; resolves with its exit code and output. */
function run(tool: string, ...args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [tool, ...args], { cwd: ROOT, timeout: 10_000 });
    let out = '', err = '';
    p.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
    p.stderr.setEncoding('utf8').on('data', (d: string) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

/** A bottom message: quality 3, depth (cm), channel 1. */
const bottom = (depthCm: number) => msg(MsgId.BOTTOM, 22, (b) => { b[16] = 3; b.writeInt32LE(depthCm, 17); b[21] = 1; });

/** Newest modification time of the files under `dir` with extension `ext`, ms (0 when there are none). */
function newest(dir: string, ext: string): number {
  if (!fs.existsSync(dir)) return 0;
  return Math.max(0, ...fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith(ext)).map((f) => fs.statSync(path.join(dir, f)).mtimeMs));
}
/** The dist modules the tools import. */
const TOOL_DEPS = ['sonar4', 'rawlog', 'signalk', 'device'].map((m) => path.join(ROOT, 'dist', `${m}.js`));

let capture: string;

beforeAll(() => {
  const stale = TOOL_DEPS.some((f) => !fs.existsSync(f) || fs.statSync(f).mtimeMs < newest(path.join(ROOT, 'src'), '.ts'));
  if (stale) {
    // Same as `npx tsc -p tsconfig.json`, without depending on npx or a shell (CI runs on Windows too).
    const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    const r = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    if (r.status !== 0) throw new Error(`tsc failed (${r.status}):\n${r.stdout}${r.stderr}`);
  }
  capture = captureFile([bottom(230), bottom(231)], [1_700_000_000_000, 1_700_000_001_000]);
}, 60_000);

afterAll(() => {
  if (capture) fs.rmSync(path.dirname(capture), { recursive: true, force: true });
});

describe.concurrent('dump-raw.mjs', () => {
  it('--help exits 0 with the usage', async () => {
    const r = await run(DUMP, '--help');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage: dump-raw');
  });

  it('lists the messages of a given id and counts them', async () => {
    const r = await run(DUMP, capture, '--id', '0x270108');
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    const listed = r.out.split('\n').filter((l) => l.includes('id=0x270108'));
    expect(listed).toHaveLength(2);
    expect(listed[0]).toContain('ch=1');
    expect(listed[0]).toContain('len=22');
    expect(r.out).toMatch(/0x270108: 2/);
  });

  it('counts without listing when no --id or --hex is given', async () => {
    const r = await run(DUMP, capture);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('id=0x270108');
    expect(r.out).toMatch(/0x270108: 2/);
  });

  it('rejects an empty --id with a usage error', async () => {
    expect((await run(DUMP, '--id', '')).code).toBe(2);
    const r = await run(DUMP, capture, '--id', '');
    expect(r.code).toBe(2);
    expect(r.err).toContain('--id');
    expect(r.err).toContain('Usage: dump-raw');
  });

  it('rejects a non-numeric --id and a missing file', async () => {
    expect((await run(DUMP, capture, '--id', 'bottom')).code).toBe(2);
    const r = await run(DUMP, path.join(path.dirname(capture), 'missing.bin'));
    expect(r.code).toBe(1);
    expect(r.err).not.toMatch(/^\s+at /m);
  });
});

describe.concurrent('wifish-probe.mjs', () => {
  it('--help exits 0 with the usage', async () => {
    const r = await run(PROBE, '--help');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage: wifish-probe');
  });

  it('reports a missing --replay file in one line, without a stack trace', async () => {
    const r = await run(PROBE, '--replay', '/nonexistent.bin');
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err.trim().split('\n')).toHaveLength(1);
    expect(r.err).toContain('--replay');
    expect(r.err).not.toMatch(/^\s+at /m);
  });

  it('reports an unwritable --log path in one line', async () => {
    const r = await run(PROBE, '--log', path.join(path.dirname(capture), 'no-such-dir', 'raw.bin'), '--replay', capture);
    expect(r.code).toBe(1);
    expect(r.err.trim().split('\n')).toHaveLength(1);
    expect(r.err).toContain('--log');
  });

  it('decodes a capture with --replay and exits 0', async () => {
    const r = await run(PROBE, '--replay', capture);
    expect(r.code).toBe(0);
    expect(r.out).toContain('[depth] 2.30 m');
    expect(r.out).toContain('[depth] 2.31 m');
    expect(r.out).toMatch(/BOTTOM: 2/);
  });
});
