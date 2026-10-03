import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DisplayStore, VesselStore, parseDisplayPatch, parseVesselPatch } from '../src/store';

describe('display units', () => {
  test('patch validation', () => {
    expect(parseDisplayPatch({ depthUnit: 'fa', tempUnit: 'C' })).toEqual({ depthUnit: 'fa', tempUnit: 'C' });
    expect(parseDisplayPatch({ depthUnit: null })).toEqual({ depthUnit: null });
    expect(parseDisplayPatch({ depthUnit: 'yd' })).toMatch(/ft, m, fa/);
    expect(parseDisplayPatch({ tempUnit: 'K' })).toMatch(/C or F/);
    expect(parseDisplayPatch({ palette: 1 })).toMatch(/unknown/);
    expect(parseDisplayPatch({})).toMatch(/empty/);
    expect(parseDisplayPatch('m')).toMatch(/object/);
  });

  test('store keeps the units in a file, merges patches and ignores a damaged file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wifish-'));
    const file = path.join(dir, 'sub', 'display.json');
    const logs: string[] = [];
    const a = new DisplayStore(() => file, (m) => logs.push(m));
    expect(a.get()).toEqual({});
    a.set({ tempUnit: 'C' });
    expect(a.set({ depthUnit: 'm' })).toEqual({ tempUnit: 'C', depthUnit: 'm' });
    expect(new DisplayStore(() => file).get()).toEqual({ tempUnit: 'C', depthUnit: 'm' });
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);

    fs.writeFileSync(file, '{"tempUnit":');
    expect(new DisplayStore(() => file, (m) => logs.push(m)).get()).toEqual({});
    expect(logs.some((l) => l.includes('cannot read'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('vessel patch validation and store', () => {
    expect(parseVesselPatch({ surfaceToTransducerCm: 42.4 })).toEqual({ surfaceToTransducerCm: 42 });
    expect(parseVesselPatch({ surfaceToTransducerCm: null })).toEqual({ surfaceToTransducerCm: null });
    expect(parseVesselPatch({ surfaceToTransducerCm: 301 })).toMatch(/0..300/);
    expect(parseVesselPatch({ surfaceToTransducerCm: -1 })).toMatch(/0..300/);
    expect(parseVesselPatch({ surfaceToTransducerCm: '40' })).toMatch(/0..300/);
    expect(parseVesselPatch({ draft: 1 })).toMatch(/unknown/);
    expect(parseVesselPatch({})).toMatch(/empty/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wifish-'));
    const file = path.join(dir, 'vessel.json');
    new VesselStore(() => file).set({ surfaceToTransducerCm: 40 });
    expect(new VesselStore(() => file).get()).toEqual({ surfaceToTransducerCm: 40 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('without a data directory the units live in memory', () => {
    const s = new DisplayStore(() => { throw new Error('no data dir yet'); });
    expect(s.set({ tempUnit: 'F' })).toEqual({ tempUnit: 'F' });
    expect(s.get()).toEqual({ tempUnit: 'F' });
  });
});

describe('store logging', () => {
  test('a save failure keeps the value in memory and goes to the error logger', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wifish-'));
    fs.writeFileSync(path.join(dir, 'blocker'), 'a file where a directory is needed');
    const file = path.join(dir, 'blocker', 'display.json');
    const debugs: string[] = [], errors: string[] = [];
    const s = new DisplayStore(() => file, { debug: (m) => debugs.push(m), error: (m) => errors.push(m) });
    expect(s.set({ tempUnit: 'F' })).toEqual({ tempUnit: 'F' });
    expect(s.get()).toEqual({ tempUnit: 'F' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(new RegExp(`^cannot save ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `));
    expect(debugs).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('unreadable JSON is an error, valid JSON with bad contents is only debug', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wifish-'));
    const file = path.join(dir, 'display.json');
    const debugs: string[] = [], errors: string[] = [];
    const log = { debug: (m: string) => debugs.push(m), error: (m: string) => errors.push(m) };
    fs.writeFileSync(file, '{"tempUnit":"K"}');
    expect(new DisplayStore(() => file, log).get()).toEqual({});
    expect(debugs).toEqual([`ignoring ${file}: tempUnit must be C or F`]);
    expect(errors).toEqual([]);
    fs.writeFileSync(file, '{"tempUnit":');
    expect(new DisplayStore(() => file, log).get()).toEqual({});
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^cannot read /);
    // A missing file is neither.
    fs.rmSync(file);
    debugs.length = errors.length = 0;
    expect(new DisplayStore(() => file, log).get()).toEqual({});
    expect(debugs).toEqual([]);
    expect(errors).toEqual([]);
    // One function serves both levels.
    const both: string[] = [];
    fs.writeFileSync(file, '{"tempUnit":"K"}');
    new VesselStore(() => file, (m) => both.push(m)).get();
    expect(both).toEqual([`ignoring ${file}: unknown field tempUnit`]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
