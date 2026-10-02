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
