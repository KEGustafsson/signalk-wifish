// One echogram trace (CHIRP sonar or DownVision), drawn like the app's SonarTraceView:
// columns scroll in from the right, one ping per column, colour = palette[sample].
// Samples of a column span 0..endCm below the transducer; the default view
// window is the ping's [startCm, endCm] in displayed depth (transducer offset
// added), so the ruler starts at 0 and the echoes move with the offset.
// Pinch/wheel zooms vertically (a zoom box with the full range then appears on
// the right), the optional A-scope shows the latest ping as a centred bar graph.

import { lut } from './palettes';
import type { ColumnStore, Col } from './history';
import { depthLinesFor, snapToPreset, type DepthUnit } from '../../src/shared/units';
import type { ChannelName } from '../../src/shared/api';

const ZOOM_BOX = 0.15;
const ASCOPE = 0.08;
const MIN_WINDOW_CM = 50;
const MAX_ZOOM = 20;
const BOTTOM_AT = 0.75;
const RETRACK_PX = 40;

export interface Window { top: number; bottom: number }

export class TraceView {
  readonly el: HTMLDivElement;
  readonly gear: HTMLButtonElement;
  readonly channel: ChannelName;
  readonly store: ColumnStore;
  #img: HTMLCanvasElement;
  #ov: HTMLCanvasElement;
  #rs = 1;
  #dpr = 1;
  #cssW = 0;
  #cssH = 0;
  #image: ImageData | null = null;
  #pix: Uint32Array | null = null;
  #dirty = true;

  palette = 4;
  unit!: DepthUnit;
  /** Transducer offset, cm: displayed depth = depth below transducer + offsetCm. */
  offsetCm = 0;
  depthLines = false;
  aScope = false;
  /** Screen px per column. */
  speed = 1;
  /** Right-edge column when paused; null = live. */
  endN: number | null = null;
  /** Zoomed window (cm below transducer); null = the ping's own range. */
  zoom: Window | null = null;
  trackBottom = true;
  #anim: { from: Window; to: Window; t0: number } | null = null;
  #lastTrackY = -1e9;
  /** Full range last drawn; a change resets the zoom like the app (SonarTraceView.h()). */
  #lastFull = '';
  /** What the echo canvas currently shows, for incremental scrolling. */
  #shown: { W: number; H: number; mainW: number; zbW: number; colW: number; right: number; top: number; bottom: number; palette: number } | null = null;
  #colBuf = new Uint32Array(0);

  /** Build the trace element (echo and overlay canvases, settings gear) and track its size and pixel ratio. */
  constructor(channel: ChannelName, store: ColumnStore, label: string) {
    this.channel = channel;
    this.store = store;
    this.el = document.createElement('div');
    this.el.className = `trace trace-${channel}`;
    this.el.dataset.channel = channel;
    this.#img = document.createElement('canvas');
    this.#img.className = 'echo';
    this.#ov = document.createElement('canvas');
    this.#ov.className = 'overlay';
    this.gear = document.createElement('button');
    this.gear.className = 'trace-gear icon-btn';
    this.gear.title = `${label} settings`;
    this.gear.setAttribute('aria-label', `${label} settings`);
    this.el.append(this.#img, this.#ov, this.gear);
    new ResizeObserver(() => this.#resize()).observe(this.el);
    this.#watchDpr();
  }

  /** Re-render crisp text when the window moves to a screen with another pixel ratio. */
  #watchDpr(): void {
    const mq = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    mq?.addEventListener?.('change', () => { this.#resize(); this.#watchDpr(); }, { once: true });
  }

  /** True when the trace is laid out with a non-zero width. */
  get visible(): boolean { return this.el.offsetParent !== null && this.#cssW > 0; }
  /** True when following new pings (not paused or scrolled back). */
  get live(): boolean { return this.endN === null; }
  /** Column number at the right edge: the paused position or the newest column. */
  get right(): number { return this.endN ?? this.store.last; }
  /** True while a zoom window is set. */
  get zoomed(): boolean { return this.zoom !== null; }

  /** Mark the trace for redraw on the next frame. */
  invalidate(): void { this.#dirty = true; }

  /** Size the canvases to the element (echogram at up to 1.5x DPR, overlay at full DPR) and force a redraw. */
  #resize(): void {
    const r = this.el.getBoundingClientRect();
    this.#cssW = Math.round(r.width);
    this.#cssH = Math.round(r.height);
    this.#dpr = window.devicePixelRatio || 1;
    // The echogram needs no more than ~1.5 px per CSS px; text overlays get full DPR.
    this.#rs = Math.min(this.#dpr, 1.5);
    const w = Math.max(1, Math.round(this.#cssW * this.#rs));
    const h = Math.max(1, Math.round(this.#cssH * this.#rs));
    if (this.#img.width !== w || this.#img.height !== h) {
      this.#img.width = w;
      this.#img.height = h;
      this.#image = null;
    }
    this.#ov.width = Math.max(1, Math.round(this.#cssW * this.#dpr));
    this.#ov.height = Math.max(1, Math.round(this.#cssH * this.#dpr));
    this.#dirty = true;
  }

  // ---------------------------------------------------------------- geometry

  /** CSS px widths: echogram area, zoom box, A-scope. */
  layout(): { main: number; zoomBox: number; aScope: number } {
    const zoomBox = this.zoomed ? Math.round(this.#cssW * ZOOM_BOX) : 0;
    const aScope = this.aScope && this.channel === 'sonar' ? Math.round(this.#cssW * ASCOPE) : 0;
    return { main: Math.max(10, this.#cssW - zoomBox - aScope), zoomBox, aScope };
  }

  /** Columns visible in the main area. */
  visibleColumns(): number {
    return Math.ceil(this.layout().main / this.speed);
  }

  /** Column that defines the full range (the right-most one shown). */
  refColumn(): Col | undefined {
    return this.store.get(this.right) ?? this.store.cols[this.store.cols.length - 1];
  }

  /**
   * Unzoomed window, cm below the transducer: the reference ping's range snapped to
   * the unit's presets (0..10 m without data), taken as *displayed* depths like the
   * app, so it starts at 0 on the ruler and the echoes shift by the transducer offset.
   */
  fullWindow(): Window {
    const c = this.refColumn();
    const off = this.offsetCm;
    if (!c) return { top: -off, bottom: 1000 - off };
    // Like the app (z.b.h()), the window is the ping's range snapped to the unit's presets.
    const top = this.unit ? snapToPreset(this.unit, c.startCm) : c.startCm;
    const bottom = this.unit ? snapToPreset(this.unit, c.endCm) : c.endCm;
    const w = bottom > top ? { top, bottom } : { top: c.startCm, bottom: c.endCm };
    return { top: w.top - off, bottom: w.bottom - off };
  }

  /** Window shown in the main area: the zoom, or else the full range. */
  window(): Window {
    return this.zoom ?? this.fullWindow();
  }

  /** Column number under CSS x, and depth (cm below transducer) under CSS y. */
  pick(x: number, y: number): { col: Col | undefined; depthCm: number } {
    const L = this.layout();
    const inMain = x < L.main;
    // Zoom box (1 px per column) and A-scope show the full range.
    const n = inMain
      ? this.right - Math.floor((L.main - 1 - x) / this.speed)
      : x < L.main + L.zoomBox ? this.right - Math.floor(L.main + L.zoomBox - 1 - x) : this.right;
    const w = inMain ? this.window() : this.fullWindow();
    return { col: this.store.get(n), depthCm: w.top + (y / this.#cssH) * (w.bottom - w.top) };
  }

  // ---------------------------------------------------------------- view changes

  /** Scroll history by `cols` columns (positive = newer); reaching the newest column resumes live. */
  scrollBy(cols: number): void {
    if (!this.store.cols.length) return; // nothing to scroll through yet
    const first = this.store.first, last = this.store.last;
    // Oldest right edge that still fills the screen (or shows all of a short history).
    const minRight = first + Math.min(this.visibleColumns(), last - first + 1) - 1;
    const next = Math.round(this.right + cols);
    this.endN = next >= last ? null : Math.max(minRight, next);
    this.#dirty = true;
  }

  /** Put column `n` at the right edge; null or the newest column resumes live. */
  scrollTo(n: number | null): void {
    this.endN = n === null || n >= this.store.last ? null : Math.max(this.store.first, Math.round(n));
    this.#dirty = true;
  }

  /** Freeze at the newest column (true) or follow new pings again (false). */
  pause(p: boolean): void {
    this.endN = p && this.store.cols.length ? this.store.last : null;
    this.#dirty = true;
  }

  /** Set screen px per column, clamped to 1..5. */
  setSpeed(s: number): void {
    this.speed = Math.max(1, Math.min(5, s));
    this.#dirty = true;
  }

  /** Fit a zoom window in the full range within the zoom limits; null when it is (nearly) the full range. */
  #clamp(w: Window): Window | null {
    const full = this.fullWindow();
    const fullH = full.bottom - full.top;
    let h = w.bottom - w.top;
    if (h >= fullH * 0.98) return null;
    h = Math.max(h, Math.max(MIN_WINDOW_CM, fullH / MAX_ZOOM));
    let top = Math.max(full.top, Math.min(w.top, full.bottom - h));
    if (!Number.isFinite(top)) top = full.top;
    return { top, bottom: top + h };
  }

  /** Vertical zoom by `factor` (> 1 = closer), anchored at CSS y, or at the bottom when tracking it. */
  zoomBy(factor: number, anchorY?: number): void {
    const w = this.window();
    const h = w.bottom - w.top;
    const newH = h / factor;
    const bottom = this.refColumn()?.bottomCm ?? null;
    let top: number;
    if (this.trackBottom && bottom !== null && bottom > w.top && bottom < w.bottom && anchorY === undefined) {
      top = bottom - BOTTOM_AT * newH;
    } else {
      const fy = anchorY === undefined ? 0.5 : anchorY / this.#cssH;
      const z = w.top + fy * h;
      top = z - fy * newH;
    }
    this.#anim = null;
    this.zoom = this.#clamp({ top, bottom: top + newH });
    this.#afterManualMove();
  }

  /** Pan the zoom window with a vertical drag of `dyCss` px; stops following the bottom. */
  panBy(dyCss: number): void {
    if (!this.zoom) return;
    const w = this.zoom;
    const cmPerPx = (w.bottom - w.top) / this.#cssH;
    this.#anim = null;
    this.zoom = this.#clamp({ top: w.top - dyCss * cmPerPx, bottom: w.bottom - dyCss * cmPerPx });
    this.trackBottom = false;
    this.#dirty = true;
  }

  /** After a gesture: keep following the bottom if it is still in view (app: b()). */
  endGesture(): void {
    this.#afterManualMove();
  }

  /** Back to the full range, following the bottom again. */
  resetZoom(): void {
    this.zoom = null;
    this.#anim = null;
    this.trackBottom = true;
    this.#dirty = true;
  }

  /** Follow the bottom only if it is inside the window now, and remember where it is drawn. */
  #afterManualMove(): void {
    const b = this.refColumn()?.bottomCm ?? null;
    const w = this.window();
    this.trackBottom = b !== null && b > w.top && b < w.bottom;
    this.#lastTrackY = b === null ? -1e9 : ((b - w.top) / (w.bottom - w.top)) * this.#cssH;
    this.#dirty = true;
  }

  /** Keep the bottom near 75 % of the height while zoomed and live (app: t()). */
  #followBottom(now: number): void {
    if (!this.zoom || !this.live || !this.trackBottom) return;
    const b = this.refColumn()?.bottomCm ?? null;
    if (b === null) return;
    const w = this.#anim ? this.#anim.to : this.zoom;
    const h = w.bottom - w.top;
    const y = ((b - w.top) / h) * this.#cssH;
    if (Math.abs(y - this.#lastTrackY) <= RETRACK_PX && y > 0 && y < this.#cssH) return;
    const target = this.#clamp({ top: b - BOTTOM_AT * h, bottom: b - BOTTOM_AT * h + h });
    if (!target) return;
    const ty = ((b - target.top) / h) * this.#cssH;
    // The range limits keep the bottom out of view: stop following instead of retrying every frame.
    if (ty < 0 || ty > this.#cssH) { this.trackBottom = false; return; }
    this.#lastTrackY = ty;
    if (this.#anim && Math.abs(this.#anim.to.top - target.top) < 0.5) return; // already heading there
    this.#anim = { from: { ...this.zoom }, to: target, t0: now };
  }

  // ---------------------------------------------------------------- drawing

  /** Draw if something changed. Returns true when it drew. */
  draw(now: number): boolean {
    if (!this.visible) return false;
    const full = this.fullWindow();
    const fullKey = `${full.top}:${full.bottom}`;
    if (fullKey !== this.#lastFull) {
      if (this.#lastFull && this.zoom) this.resetZoom(); // new range: the old zoom may lie outside it
      this.#lastFull = fullKey;
      this.#dirty = true;
    }
    this.#followBottom(now);
    if (this.#anim) {
      const k = Math.min(1, (now - this.#anim.t0) / 500);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      const { from, to } = this.#anim;
      this.zoom = { top: from.top + (to.top - from.top) * e, bottom: from.bottom + (to.bottom - from.bottom) * e };
      if (k >= 1) this.#anim = null;
      this.#dirty = true;
    }
    if (!this.#dirty) return false;
    this.#dirty = false;
    this.#drawEcho();
    this.#drawOverlay();
    return true;
  }

  /** Render echogram, zoom box and A-scope; plain live scrolling only shifts the image and adds new pings. */
  #drawEcho(): void {
    const W = this.#img.width, H = this.#img.height;
    if (!this.#image || this.#image.width !== W || this.#image.height !== H) {
      this.#image = new ImageData(W, H);
      this.#pix = new Uint32Array(this.#image.data.buffer);
      this.#shown = null;
    }
    const pix = this.#pix!;
    const pal = lut(this.palette);
    const rs = this.#rs;
    const L = this.layout();
    const mainW = Math.round(L.main * rs);
    const zbW = Math.round(L.zoomBox * rs);
    const colW = this.speed * rs;
    const right = this.right;
    const w = this.window();
    const ctx = this.#img.getContext('2d')!;
    // Live scrolling with nothing else changed: move the picture left and draw only the new pings.
    const prev = this.#shown;
    const shift = prev ? (right - prev.right) * colW : 0;
    const incremental = !!prev && prev.W === W && prev.H === H && prev.mainW === mainW && prev.zbW === zbW
      && prev.colW === colW && prev.top === w.top && prev.bottom === w.bottom && prev.palette === this.palette
      && shift > 0 && shift < mainW && Number.isInteger(shift);
    const from = incremental ? mainW - shift : 0;
    if (incremental) ctx.drawImage(this.#img, shift, 0, mainW - shift, H, 0, 0, mainW - shift, H);
    this.#columns(pix, W, H, from, mainW, colW, right, w, pal);
    if (zbW > 0) this.#columns(pix, W, H, mainW, mainW + zbW, rs, right, this.fullWindow(), pal);
    if (L.aScope > 0) this.#aScope(pix, W, H, mainW + zbW, W, this.fullWindow(), pal);
    if (incremental) ctx.putImageData(this.#image, 0, 0, from, 0, W - from, H);
    else ctx.putImageData(this.#image, 0, 0);
    this.#shown = { W, H, mainW, zbW, colW, right, top: w.top, bottom: w.bottom, palette: this.palette };
  }

  /** Fill pixel columns [x0, x1) with pings ending at column `right` at x1, `colW` px each. */
  #columns(pix: Uint32Array, W: number, H: number, x0: number, x1: number, colW: number, right: number, win: Window, pal: Uint32Array): void {
    const bg = pal[0];
    if (this.#colBuf.length !== H) this.#colBuf = new Uint32Array(H);
    const buf = this.#colBuf;
    const span = win.bottom - win.top;
    let lastN = NaN;
    let have = false;
    for (let x = x1 - 1; x >= x0; x--) {
      const n = right - Math.floor((x1 - 1 - x) / colW);
      if (n !== lastN) {
        lastN = n;
        const c = this.store.get(n);
        have = !!c && c.endCm > 0;
        if (c && have) {
          const s = c.samples, len = s.length, k = len / c.endCm;
          for (let y = 0; y < H; y++) {
            const i = Math.floor((win.top + ((y + 0.5) / H) * span) * k);
            buf[y] = i >= 0 && i < len ? pal[s[i]] : bg;
          }
        }
      }
      if (have) for (let y = 0, o = x; y < H; y++, o += W) pix[o] = buf[y];
      else for (let y = 0, o = x; y < H; y++, o += W) pix[o] = bg;
    }
  }

  /** Draw the right-most shown ping in [x0, x1) as centred bars, width proportional to echo strength. */
  #aScope(pix: Uint32Array, W: number, H: number, x0: number, x1: number, win: Window, pal: Uint32Array): void {
    const c = this.store.get(this.right);
    const bg = pal[0];
    const width = x1 - x0;
    const span = win.bottom - win.top;
    for (let y = 0; y < H; y++) {
      let v = 0;
      if (c) {
        const i = Math.floor((win.top + ((y + 0.5) / H) * span) * (c.samples.length / c.endCm));
        if (i >= 0 && i < c.samples.length) v = c.samples[i];
      }
      const half = (v / 255) * width / 2;
      const mid = x0 + width / 2;
      const colr = pal[v];
      for (let x = x0, o = y * W + x0; x < x1; x++, o++) pix[o] = Math.abs(x + 0.5 - mid) <= half ? colr : bg;
    }
  }

  /** Decimals needed to show multiples of `step` exactly (1, 0.5, 0.25 ...). */
  static #decimals(step: number): number {
    for (let d = 0; d < 3; d++) if (Math.abs(step * 10 ** d - Math.round(step * 10 ** d)) < 1e-6) return d;
    return 2;
  }

  /** Draw the depth rulers and, when zoomed, the zoom box's window marker and its own ruler. */
  #drawOverlay(): void {
    const ctx = this.#ov.getContext('2d')!;
    const d = this.#dpr;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, this.#cssW, this.#cssH);
    const L = this.layout();
    const H = this.#cssH;
    this.#ruler(ctx, L.main, H, this.window(), true);
    if (L.zoomBox > 0) {
      const x0 = L.main, x1 = L.main + L.zoomBox;
      const full = this.fullWindow();
      const z = this.window();
      const y0 = ((z.top - full.top) / (full.bottom - full.top)) * H;
      const y1 = ((z.bottom - full.top) / (full.bottom - full.top)) * H;
      ctx.fillStyle = 'rgba(0, 196, 229, 0.30)';
      ctx.fillRect(x0 + 1, y0, x1 - x0 - 2, y1 - y0);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x0 + 0.75, y0, x1 - x0 - 1.5, y1 - y0);
      ctx.fillStyle = '#fff';
      const mid = (x0 + x1) / 2;
      for (const [y, dir] of [[y0, 1], [y1, -1]] as const) {
        ctx.beginPath();
        ctx.moveTo(mid - 7, y + dir * 1);
        ctx.lineTo(mid + 7, y + dir * 1);
        ctx.lineTo(mid, y + dir * 9);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillRect(x0, 0, 1, H);
      this.#ruler(ctx, x1, H, full, false);
    }
    if (L.aScope > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillRect(L.main + L.zoomBox, 0, 1, H);
    }
  }

  /**
   * Depth scale along the right edge `xr` for window `w` (app: DepthRulerView).
   * Marks sit on round *displayed* depths, i.e. with the transducer offset added.
   */
  #ruler(ctx: CanvasRenderingContext2D, xr: number, H: number, w: Window, main: boolean): void {
    const u = this.unit;
    const spanCm = w.bottom - w.top;
    if (!(spanCm > 0)) return;
    const off = this.offsetCm;
    const topU = (w.top + off) / u.cm;
    const bottomU = (w.bottom + off) / u.cm;
    const spanU = bottomU - topU;
    // A preset range from the surface gets the app's line count; anything else a "nice" step.
    const lines = w.top + off === 0 ? depthLinesFor(u, Math.round(spanCm)) : -1;
    let step: number;
    if (lines > 0) step = spanU / (lines + 1);
    else {
      const raw = spanU / 4.5;
      const p = 10 ** Math.floor(Math.log10(raw));
      step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p;
    }
    const dec = TraceView.#decimals(step);
    /** Canvas y of a displayed depth (in units). */
    const y = (vU: number) => ((vU - topU) / spanU) * H;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 2;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    ctx.textAlign = 'right';
    ctx.fillRect(xr - 2, 0, 2, H); // right edge line
    const small = 8, big = 14, pad = 4;
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const first = Math.ceil(topU / step - 1e-6);
    for (let i = first; i * step < bottomU - 1e-6; i++) {
      const v = i * step;
      const yy = y(v);
      if (yy < 18 || yy > H - 18) continue;
      ctx.fillRect(xr - small, Math.round(yy) - 1, small, 2);
      ctx.fillText(v.toFixed(dec), xr - small - pad, yy);
      if (main && this.depthLines) {
        ctx.save();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 0.55;
        ctx.setLineDash([8, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, Math.round(yy) + 0.5);
        ctx.lineTo(xr - small, Math.round(yy) + 0.5);
        ctx.stroke();
        ctx.restore();
      }
    }
    // Window top / bottom in the big font, with a decimal unless they are whole.
    /** Format a depth with one decimal, or none if it is (nearly) whole. */
    const edge = (v: number) => v.toFixed(Math.abs(v - Math.round(v)) < 0.05 ? 0 : 1);
    ctx.font = '700 16px system-ui, sans-serif';
    ctx.fillRect(xr - big, 0, big, 2);
    ctx.fillRect(xr - big, H - 2, big, 2);
    ctx.textBaseline = 'top';
    ctx.fillText(edge(topU), xr - big - pad, 3);
    ctx.textBaseline = 'bottom';
    ctx.fillText(edge(bottomU), xr - big - pad, H - 3);
    ctx.restore();
  }

  /** Echogram + overlays as one canvas at CSS size (for snapshots). */
  compose(target: CanvasRenderingContext2D, x: number, y: number): void {
    target.drawImage(this.#img, x, y, this.#cssW, this.#cssH);
    target.drawImage(this.#ov, x, y, this.#cssW, this.#cssH);
  }

  /** Element size in CSS px as last measured. */
  get cssSize(): { w: number; h: number } { return { w: this.#cssW, h: this.#cssH }; }
}
