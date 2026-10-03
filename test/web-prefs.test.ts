import { test, expect, beforeEach, afterEach, vi } from 'vitest';

/** Minimal localStorage stub; `throwing` simulates a blocked store. */
function fakeStorage(init: Record<string, string> = {}, throwing = false) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => { if (throwing) throw new Error('blocked'); return m.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (throwing) throw new Error('blocked'); m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
    map: m,
  };
}

let storage: ReturnType<typeof fakeStorage>;
/** Load a fresh prefs module against `storage` and locale `language`. */
async function loadPrefs(language = 'en-US') {
  vi.resetModules();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('navigator', { language });
  return import('../web/src/prefs');
}

beforeEach(() => { storage = fakeStorage(); });
afterEach(() => { vi.unstubAllGlobals(); });

test('a fresh browser gets locale defaults and no key counts as picked', async () => {
  const us = await loadPrefs('en-US');
  expect(us.prefs.tempUnit).toBe('F');
  expect(us.prefs.depthUnit).toBeNull();
  expect(us.storedKeys.size).toBe(0);
  const se = await loadPrefs('sv-SE');
  expect(se.prefs.tempUnit).toBe('C');
  expect(se.prefs.speed).toBe(1);
  expect(se.prefs.view).toBe('split');
});

test('defaults tolerate a missing navigator', async () => {
  vi.resetModules();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('navigator', undefined);
  const p = await import('../web/src/prefs');
  expect(p.prefs.tempUnit).toBe('C');
});

test('only keys passed to savePrefs are picked, and the picked list survives a reload', async () => {
  const a = await loadPrefs('en-US');
  a.savePrefs({ depthUnit: 'ft' });
  expect([...a.storedKeys]).toEqual(['depthUnit']);
  // the whole prefs object is stored, but that must not make tempUnit (a locale default) a pick
  expect(JSON.parse(storage.map.get('signalk-wifish.prefs')!).tempUnit).toBe('F');
  const b = await loadPrefs('en-US');
  expect(b.prefs.depthUnit).toBe('ft');
  expect(b.storedKeys.has('depthUnit')).toBe(true);
  expect(b.storedKeys.has('tempUnit')).toBe(false);
  b.savePrefs({ tempUnit: 'C' });
  const c = await loadPrefs('en-US');
  expect([...c.storedKeys].sort()).toEqual(['depthUnit', 'tempUnit']);
  expect(c.prefs.tempUnit).toBe('C');
});

test('a legacy store without a picked list restores the values but picks nothing', async () => {
  storage = fakeStorage({ 'signalk-wifish.prefs': JSON.stringify({ tempUnit: 'F', depthUnit: 'fa', speed: 3 }) });
  const p = await loadPrefs('de-DE');
  expect(p.prefs.tempUnit).toBe('F');
  expect(p.prefs.depthUnit).toBe('fa');
  expect(p.prefs.speed).toBe(3);
  expect(p.storedKeys.size).toBe(0);
});

test('invalid stored values fall back to defaults; numbers are clamped', async () => {
  storage = fakeStorage({
    'signalk-wifish.prefs': JSON.stringify({
      paletteSonar: 0, paletteDownvision: 99, depthLines: 'yes', aScope: 1, depthUnit: 'yards', tempUnit: 'K',
      view: 'map', speed: 42, settingsTab: 7.9, extra: true,
    }),
    'signalk-wifish.prefs.picked': JSON.stringify(['depthUnit', 'extra', 42, null]),
  });
  const p = await loadPrefs('en-GB');
  expect(p.prefs).toEqual({ ...p.defaults(), speed: 5, settingsTab: 2 });
  expect([...p.storedKeys]).toEqual(['depthUnit']);
  expect('extra' in p.prefs).toBe(false);
});

test('non-finite numbers, wrong types and corrupt JSON are ignored', async () => {
  storage = fakeStorage({ 'signalk-wifish.prefs': JSON.stringify({ speed: null, settingsTab: '1', paletteSonar: 4.5, depthUnit: null }) });
  const p = await loadPrefs('en-GB');
  expect(p.prefs.speed).toBe(1);
  expect(p.prefs.settingsTab).toBe(0);
  expect(p.prefs.paletteSonar).toBe(4);
  expect(p.prefs.depthUnit).toBeNull();
  storage = fakeStorage({ 'signalk-wifish.prefs': '{not json', 'signalk-wifish.prefs.picked': '"x"' });
  const q = await loadPrefs('en-GB');
  expect(q.prefs).toEqual(q.defaults());
  expect(q.storedKeys.size).toBe(0);
  storage = fakeStorage({ 'signalk-wifish.prefs': JSON.stringify([1, 2]) });
  const r = await loadPrefs('en-GB');
  expect(r.prefs).toEqual(r.defaults());
});

test('sanitize validates every key', async () => {
  const p = await loadPrefs('en-GB');
  const base = p.defaults();
  expect(p.sanitize({ speed: 0.5 }, base).speed).toBe(1);
  expect(p.sanitize({ speed: 2.5 }, base).speed).toBe(2.5);
  expect(p.sanitize({ speed: Infinity }, base).speed).toBe(1);
  expect(p.sanitize({ settingsTab: -3 }, base).settingsTab).toBe(0);
  expect(p.sanitize({ view: 'sonar' }, base).view).toBe('sonar');
  expect(p.sanitize({ paletteSonar: 8, paletteDownvision: 3 }, base)).toMatchObject({ paletteSonar: 8, paletteDownvision: 3 });
  expect(p.sanitize({ paletteSonar: 1 }, base).paletteSonar).toBe(base.paletteSonar); // a DownVision palette id
  expect(p.sanitize(null, base)).toEqual(base);
  expect(p.sanitize('x', base)).toEqual(base);
});

test('blocked storage: defaults load and savePrefs still updates the live prefs', async () => {
  storage = fakeStorage({}, true);
  const p = await loadPrefs('en-US');
  expect(p.prefs.tempUnit).toBe('F');
  p.savePrefs({ depthLines: true });
  expect(p.prefs.depthLines).toBe(true);
  expect(p.storedKeys.has('depthLines')).toBe(true);
});
