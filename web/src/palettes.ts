// Echogram colour palettes, as gradient stops every 16 levels (17 stops, last = 255).
// Index order and names follow the app: 0–3 are offered for DownVision, 4–8 for CHIRP sonar.

export interface Palette { id: number; name: string; stops: string }

export const PALETTES: readonly Palette[] = [
  { id: 0, name: 'Copper', stops: '000000 140d08 281910 3c2618 503220 643f28 784b30 8d5838 a16440 b57148 c97d50 dd8a62 f19782 ffa3a2 ffc2c2 ffe2e2 ffffff' },
  { id: 1, name: 'Inverse Copper', stops: 'ffffff ffe0e0 ffc0c0 ffa2a0 ef9680 db8960 c77c4f b37047 9f633f 8b5737 774a2f 633e27 4f311f 3b2517 27180f 130c07 000000' },
  { id: 2, name: 'Slate Gray', stops: '000008 0b0e17 161c27 212a36 2c3846 374655 425465 4d6274 587084 627d93 6d8ba2 7899b2 83a7c1 98b5d1 bac3e0 ddddf0 fdfdfe' },
  { id: 3, name: 'Inverse Slate Gray', stops: 'fdfdfe dbdbef b8c2df 96b4d0 83a6c0 7898b1 6d8ba1 627d92 576f83 4c6173 415364 364554 2b3745 202935 151b26 0a0d16 000008' },
  { id: 4, name: 'Classic Blue', stops: '000087 0000c7 0008ff 0048ff 008bff 00cbff 08fff7 48ffb7 8bff74 cbff34 fffb00 ffbb00 ff7800 ff3800 f70000 b70000 800000' },
  { id: 5, name: 'Classic Black', stops: '000000 00009c 0000de 0021ff 0063ff 00a5ff 00e6ff 29ffd6 6bff94 adff52 efff10 ffce00 ff8c00 ff4a00 ff0800 c50000 460000' },
  { id: 6, name: 'Classic White', stops: 'ffffff 7d7dff 0008ff 0048ff 0088ff 00c8ff 08fff8 48ffb8 88ff78 c8ff38 fff800 ffb800 ff7800 ff3800 f80000 b80000 800000' },
  { id: 7, name: 'Sunburst', stops: 'ffffff ffffcb ffff96 ffff62 ffff2e fffb00 ffd700 ffb300 ff8f00 ff6b00 ff4800 ff2400 ff0000 db0000 b70000 940000 3a0000' },
  { id: 8, name: 'Nightvision', stops: '000000 021002 032003 053005 064006 085008 0a600a 0b700b 0d810d 0e910e 10a110 12b112 13c113 15d115 16e116 18f118 1aff1a' },
];

export const DOWNVISION_PALETTES = [0, 1, 2, 3];
export const SONAR_PALETTES = [4, 5, 6, 7, 8];
export const DEFAULT_PALETTE = { sonar: 4, downvision: 0 } as const;

const cache = new Map<number, Uint32Array>();
const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** 256 packed RGBA colours (ImageData byte order) for palette `id`. */
export function lut(id: number): Uint32Array {
  let l = cache.get(id);
  if (l) return l;
  const p = PALETTES[id] ?? PALETTES[4];
  const stops = p.stops.split(' ').map((h) => [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16)));
  /** Level of gradient stop `i` (every 16, the last one at 255). */
  const at = (i: number) => (i < 16 ? i * 16 : 255);
  l = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const j = Math.min(15, Math.floor(i / 16));
    const t = (i - at(j)) / (at(j + 1) - at(j));
    const [r, g, b] = [0, 1, 2].map((k) => Math.round(stops[j][k] + (stops[j + 1][k] - stops[j][k]) * t));
    l[i] = littleEndian ? (255 << 24) | (b << 16) | (g << 8) | r : (r << 24) | (g << 16) | (b << 8) | 255;
  }
  cache.set(id, l);
  return l;
}

/** CSS colour of level `v` in palette `id` (for the palette preview). */
export function cssColour(id: number, v: number): string {
  const c = lut(id)[v];
  const r = littleEndian ? c & 255 : c >>> 24;
  const g = littleEndian ? (c >>> 8) & 255 : (c >>> 16) & 255;
  const b = littleEndian ? (c >>> 16) & 255 : (c >>> 8) & 255;
  return `rgb(${r},${g},${b})`;
}
