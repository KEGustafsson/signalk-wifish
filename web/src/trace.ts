// One echogram trace (CHIRP sonar or DownVision), drawn like the app's SonarTraceView:
// columns scroll in from the right, one ping per column, colour = palette[sample].
// Samples of a column span 0..endCm below the transducer; the default view
// window is the ping's [startCm, endCm] in displayed depth (transducer offset
// added), so the ruler starts at 0 and the echoes move with the offset.
// Pinch/wheel zooms vertically (a zoom box with the full range then appears on
// the right), the optional A-scope shows the latest ping as a centred bar graph.
// The geometry (column <-> pixel mapping, windows, rulers) lives in geometry.ts.

import { lut } from './palettes';
import type { ColumnStore, Col } from './history';
import { unitById, type DepthUnit } from '../../src/shared/units';
import type { ChannelName } from '../../src/shared/api';
import {
  BOTTOM_AT, RETRACK_PX, clampRight, clampSpeed, clampZoom, columnAt, columnWidth, depthAt, fullWindow, layout, minRight,
  ruler, scrollTarget, visibleColumns, zoomWindow, type Layout, type Window,
} from './geometry';

export type { Window } from './geometry';

/** What a trace draws besides its columns; set together through `configure()`. */
export interface TraceLook {
  unit: DepthUnit;
  /** Transducer offset, cm: displayed depth = depth below transducer + offsetCm. */
  offsetCm: number;
  palette: number;
  depthLines: boolean;
  aScope: boolean;
  /** Horizontal speed: CSS px per column as the user picks it (1..5). */
  speed: number;
}

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
  unit: DepthUnit = unitById('m');
  /** Transducer offset, cm: displayed depth = depth below transducer + offsetCm. */
  offsetCm = 0;
  depthLines = false;
  aScope = false;
  /** Speed as picked (CSS px per column, 1..5); the drawn column width is `columnWidth(speed, rs)` device px. */
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
  /** Device px per column as drawn (whole pixels, so incremental scrolling can shift the picture). */
  get colW(): number { return columnWidth(this.speed, this.#rs); }
  /** CSS px per column as drawn; what a drag of that many px scrolls by one column. */
  get cssPerColumn(): number { return this.colW / this.#rs; }

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
  layout(): Layout {
    return layout(this.#cssW, this.zoomed, this.aScope && this.channel === 'sonar');
  }

  /** Device px widths of the echogram area and the zoom box (what the columns are laid out in). */
  #devLayout(): { mainW: number; zbW: number } {
    const L = this.layout();
    return { mainW: Math.round(L.main * this.#rs), zbW: Math.round(L.zoomBox * this.#rs) };
  }

  /** Columns visible in the main area. */
  visibleColumns(): number {
    return visibleColumns(this.#devLayout().mainW, this.colW);
  }

  /** Oldest right-edge column that still fills the screen (or shows all of a short history). */
  minRight(): number {
    return minRight(this.store.first, this.store.last, this.visibleColumns());
  }

  /** Column that defines the full range (the right-most one shown). */
  refColumn(): Col | undefined {
    return this.store.get(this.right) ?? this.store.cols[this.store.cols.length - 1];
  }

  /** Unzoomed window, cm below the transducer (see geometry.fullWindow). */
  fullWindow(): Window {
    return fullWindow(this.refColumn(), this.unit, this.offsetCm);
  }

  /** Window shown in the main area: the zoom, or else the full range. */
  window(): Window {
    return this.zoom ?? this.fullWindow();
  }

  /**
   * Column number under CSS x, and depth (cm below transducer) under CSS y, using the same
   * device-pixel column layout as the drawing so hit-testing and picture agree.
   */
  pick(x: number, y: number): { col: Col | undefined; depthCm: number } {
    const { mainW, zbW } = this.#devLayout();
    const xd = Math.floor(x * this.#rs);
    const inMain = xd < mainW;
    // The zoom box (1 device px per column) and the A-scope show the full range.
    const n = inMain
      ? columnAt(this.right, mainW, xd, this.colW)
      : xd < mainW + zbW ? columnAt(this.right, mainW + zbW, xd, 1) : this.right;
    const w = inMain ? this.window() : this.fullWindow();
    return { col: this.store.get(n), depthCm: depthAt(w, this.#cssH > 0 ? y / this.#cssH : 0) };
  }

  // ---------------------------------------------------------------- view changes

  /** Set the right-edge column (null = live), marking the trace dirty only when it changed. */
  #setRight(n: number | null): void {
    if (n === this.endN) return;
    this.endN = n;
    this.#dirty = true;
  }

  /** Scroll history by `cols` columns (positive = newer); reaching the newest column resumes live. */
  scrollBy(cols: number): void {
    if (!this.store.cols.length) return; // nothing to scroll through yet
    this.#setRight(scrollTarget(this.right, cols, this.store.first, this.store.last, this.visibleColumns()));
  }

  /** Put column `n` at the right edge; null or the newest column resumes live. */
  scrollTo(n: number | null): void {
    this.#setRight(n === null ? null : clampRight(Math.round(n), this.store.first, this.store.last, this.visibleColumns()));
  }

  /**
   * Put the column nearest in time to `t` (Unix ms) at the right edge, so two traces whose
   * channels ping at different rates show the same moment; no columns = left alone.
   */
  scrollToTime(t: number): void {
    const c = this.store.nearestByTime(t);
    if (c) this.scrollTo(c.n);
  }

  /** Freeze at the newest column (true) or follow new pings again (false). */
  pause(p: boolean): void {
    this.#setRight(p && this.store.cols.length ? this.store.last : null);
  }

  /** Set the speed (CSS px per column as picked), clamped to 1..5. */
  setSpeed(s: number): void {
    const v = clampSpeed(s);
    if (v === this.speed) return;
    this.speed = v;
    this.#dirty = true;
  }

  /** Take a new look; only a change in what is drawn marks the trace for redraw. */
  configure(look: TraceLook): void {
    let changed = false;
    if (look.unit.id !== this.unit.id) { this.unit = look.unit; changed = true; }
    if (look.offsetCm !== this.offsetCm) { this.offsetCm = look.offsetCm; changed = true; }
    if (look.palette !== this.palette) { this.palette = look.palette; changed = true; }
    if (look.depthLines !== this.depthLines) { this.depthLines = look.depthLines; changed = true; }
    if (look.aScope !== this.aScope) { this.aScope = look.aScope; changed = true; }
    const speed = clampSpeed(look.speed);
    if (speed !== this.speed) { this.speed = speed; changed = true; }
    if (changed) this.#dirty = true;
  }

  /** Fit a zoom window in the full range within the zoom limits; null when it is (nearly) the full range. */
  #clamp(w: Window): Window | null {
    return clampZoom(w, this.fullWindow());
  }

  /** Replace the zoom window, marking the trace dirty only when it differs. */
  #setZoom(z: Window | null): void {
    const a = this.zoom;
    if (a === z || (a && z && a.top === z.top && a.bottom === z.bottom)) return;
    this.zoom = z;
    this.#dirty = true;
  }

  /**
   * Vertical zoom by `factor` (> 1 = closer), anchored at CSS y; without an anchor around the
   * tracked bottom when it is in view, else around the middle.
   */
  zoomBy(factor: number, anchorY?: number): void {
    const w = this.window();
    const bottom = this.trackBottom ? (this.refColumn()?.bottomCm ?? null) : null;
    const fy = anchorY === undefined ? undefined : this.#cssH > 0 ? anchorY / this.#cssH : 0.5;
    this.#anim = null;
    this.#setZoom(this.#clamp(zoomWindow(w, factor, fy, bottom)));
    this.#afterManualMove();
  }

  /** Pan the zoom window with a vertical drag of `dyCss` px; stops following the bottom. */
  panBy(dyCss: number): void {
    if (!this.zoom || !dyCss) return;
    const w = this.zoom;
    const cmPerPx = (w.bottom - w.top) / Math.max(1, this.#cssH);
    this.#anim = null;
    this.#setZoom(this.#clamp({ top: w.top - dyCss * cmPerPx, bottom: w.bottom - dyCss * cmPerPx }));
    this.trackBottom = false;
  }

  /** After a gesture: keep following the bottom if it is still in view (app: b()). */
  endGesture(): void {
    this.#afterManualMove();
  }

  /** Back to the full range, following the bottom again. */
  resetZoom(): void {
    this.#setZoom(null);
    this.#anim = null;
    this.trackBottom = true;
  }

  /** Follow the bottom only if it is inside the window now, and remember where it is drawn (nothing to redraw). */
  #afterManualMove(): void {
    const b = this.refColumn()?.bottomCm ?? null;
    const w = this.window();
    this.trackBottom = b !== null && b > w.top && b < w.bottom;
    this.#lastTrackY = b === null ? -1e9 : ((b - w.top) / (w.bottom - w.top)) * this.#cssH;
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
    // The store trims old columns while paused: never point before the oldest filling position
    // (a pause at the newest column stays a pause, so this only ever moves the view forward).
    if (this.endN !== null && this.store.cols.length) {
      const m = this.minRight();
      if (this.endN < m) this.#setRight(m);
    }
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
    const L = this.layout();
    const { mainW, zbW } = this.#devLayout();
    const colW = this.colW;
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
    if (zbW > 0) this.#columns(pix, W, H, mainW, mainW + zbW, 1, right, this.fullWindow(), pal);
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
      const n = columnAt(right, x1, x, colW);
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
    const r = ruler(w, this.unit, this.offsetCm);
    if (!r) return;
    const { topU, bottomU, dec, marks } = r;
    const spanU = bottomU - topU;
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
    for (const v of marks) {
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
}
