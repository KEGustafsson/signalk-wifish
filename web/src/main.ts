// Wi-Fish Sonar web app: the Android app's sonar screen for a browser.

import { ColumnStore } from './history';
import { TraceView } from './trace';
import { PluginStream, setChannel, setDisplay, setSystem, setVessel } from './stream';
import { prefs, savePrefs, storedKeys, MAX_SPEED, MIN_SPEED, type Prefs, type ViewConfig } from './prefs';
import { ICONS } from './icons';
import {
  aboutDialog, closeAll, helpDialog, mainSettings, messageBox, overflowMenu, sonarSettings, viewSwitcher,
  type Ctx, type DialogHandle,
} from './dialogs';
import { formatDepth, formatTemp, snapToPreset, unitByCode, unitById, type DepthUnit } from '../../src/shared/units';
import { isChannelName, type ChannelName, type DisplayPrefs, type VesselSettings, type WifishState } from '../../src/shared/api';

declare const __VERSION__: string;

/** Typed shorthand for document.getElementById; throws when index.html lacks the element. */
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`wifish: index.html has no element with id "${id}"`);
  return el as T;
};

// ------------------------------------------------------------------ model

let state: WifishState | null = null;
/** Vessel settings kept by the plugin (waterline-to-transducer distance). */
let vessel: VesselSettings = {};
const listeners = new Set<(s: WifishState | null) => void>();
const stores: Record<ChannelName, ColumnStore> = {
  sonar: new ColumnStore('sonar'),
  downvision: new ColumnStore('downvision'),
};
const traces: Record<ChannelName, TraceView> = {
  sonar: new TraceView('sonar', stores.sonar, 'Sonar'),
  downvision: new TraceView('downvision', stores.downvision, 'DownVision'),
};
const ORDER: ChannelName[] = ['sonar', 'downvision'];
/** View forced while a settings popover is open (the app shows only that channel). */
let tempView: ViewConfig | null = null;
let backlogDone = false;
/** Epoch of the plugin run the stores hold columns from; null right after a reset. */
let epoch: string | null = null;

/** Depth unit in use: the user's preference, else the sounder's setting, else metres. */
function depthUnit(): DepthUnit {
  if (prefs.depthUnit) return unitById(prefs.depthUnit);
  return state?.system ? unitByCode(state.system.depthUnit) : unitById('m');
}

/** True when the connected unit is a Wi-Fish (DownVision only, settings button in the toolbar). */
function isWifish(): boolean {
  return !!state?.unit?.wifish;
}

/** Channels that can be shown: DownVision on a Wi-Fish, else the active ones (both if none is active). */
function availableChannels(): ChannelName[] {
  if (isWifish()) return ['downvision'];
  const a = ORDER.filter((c) => state?.active?.[c]);
  return a.length ? a : ORDER;
}

/** View actually shown: the temporary settings view, the only available channel, or the saved view. */
function effectiveView(): ViewConfig {
  if (tempView) return tempView;
  const avail = availableChannels();
  if (avail.length === 1) return avail[0];
  return prefs.view;
}

// ------------------------------------------------------------------ layout

const tracesEl = $<HTMLDivElement>('traces');
tracesEl.append(traces.sonar.el, Object.assign(document.createElement('div'), { className: 'separator' }), traces.downvision.el);

let appliedView: ViewConfig | null = null;
/** Show or hide the traces for the effective view; only an actual change marks them for redraw. */
function applyView(): void {
  const v = effectiveView();
  if (v === appliedView) return;
  appliedView = v;
  tracesEl.className = `traces ${v}`;
  traces.sonar.el.hidden = v === 'downvision';
  traces.downvision.el.hidden = v === 'sonar';
  for (const t of Object.values(traces)) t.invalidate();
}

/**
 * When the user changes the depth unit the app snaps the sonar's shallow/deep range to the new
 * unit's presets and sends it (SonarTraceActivity.i.a()). Only the viewer that made the change
 * sends it; the others merely receive the new unit from the server.
 */
function unitChanged(u: DepthUnit): void {
  if (!state?.canControl) return;
  const ch: ChannelName = isWifish() ? 'downvision' : 'sonar';
  const cs = state.channels?.[ch];
  if (!cs) return;
  const shallow = snapToPreset(u, cs.rangeShallowCm);
  const deep = snapToPreset(u, cs.rangeDeepCm);
  if ((shallow === cs.rangeShallowCm && deep === cs.rangeDeepCm) || deep <= shallow) return;
  void ctx.sendChannel(ch, { rangeAuto: cs.rangeAuto, rangeShallowCm: shallow, rangeDeepCm: deep });
}

let appliedUnit: string | null = null;
/** Push the prefs (unit, palettes, offset, depth lines, A-scope, speed) to the traces and repaint the databox. */
function applyPrefs(): void {
  const u = depthUnit();
  const offsetCm = state?.system?.transducerOffsetCm ?? 0;
  const unitChangedNow = appliedUnit !== u.id;
  appliedUnit = u.id;
  for (const ch of ORDER) {
    traces[ch].configure({
      unit: u, offsetCm, palette: ch === 'sonar' ? prefs.paletteSonar : prefs.paletteDownvision,
      depthLines: prefs.depthLines, aScope: prefs.aScope, speed: prefs.speed,
    });
  }
  // A new unit must show at once, not after the readout's 1 s throttle.
  paintDatabox(unitChangedNow);
}

// ------------------------------------------------------------------ toolbar

const btnSettings = $<HTMLButtonElement>('btn-settings');
const btnViews = $<HTMLButtonElement>('btn-views');
const btnPause = $<HTMLButtonElement>('btn-pause');
const btnSnapshot = $<HTMLButtonElement>('btn-snapshot');
const btnMore = $<HTMLButtonElement>('btn-more');
const btnFF = $<HTMLButtonElement>('btn-ff');
btnSettings.innerHTML = ICONS.sonar;
btnViews.innerHTML = ICONS.viewSwitcher;
btnSnapshot.innerHTML = ICONS.camera;
btnMore.innerHTML = ICONS.more;
btnFF.innerHTML = ICONS.fastForward;
for (const t of Object.values(traces)) t.gear.innerHTML = ICONS.gear;

/** True when any trace is held on history instead of following new pings. */
const paused = () => Object.values(traces).some((t) => !t.live);

let pausePainted: boolean | null = null;
/** Update the pause/play button; the fast-forward button and history scrollbar show only while paused. */
function paintPause(): void {
  const p = paused();
  if (p === pausePainted) return; // the icons are SVG markup: don't re-parse them on every column crossed
  pausePainted = p;
  btnPause.innerHTML = p ? ICONS.play : ICONS.pause;
  btnPause.title = p ? 'Resume' : 'Pause';
  btnPause.setAttribute('aria-label', btnPause.title);
  btnFF.hidden = !p;
  // Resuming hides the scrollbar: keep keyboard focus in the toolbar rather than losing it to the page.
  if (!p && scrollEl.contains(document.activeElement)) btnPause.focus();
  scrollEl.hidden = !p;
}

/** Pause or resume all traces together and update the toolbar. */
function setPaused(p: boolean): void {
  for (const t of Object.values(traces)) t.pause(p);
  paintPause();
}

btnPause.addEventListener('click', () => setPaused(!paused()));
btnFF.addEventListener('click', () => setPaused(false));

btnViews.addEventListener('click', () => {
  viewSwitcher(btnViews, effectiveView(), availableChannels(), (v) => { savePrefs({ view: v }); applyView(); });
});

let settingsDialog: DialogHandle | null = null;
/** Open a channel's sonar settings popover; in split view only that channel is shown while it is open. */
function openSonarSettings(ch: ChannelName, anchor: HTMLElement): void {
  settingsDialog?.close();
  hideGears();
  // Like the app: while adjusting, show only the channel being adjusted.
  if (effectiveView() === 'split') { tempView = ch; applyView(); }
  settingsDialog = sonarSettings(ctx, ch, anchor, () => { settingsDialog = null; tempView = null; applyView(); });
}
btnSettings.addEventListener('click', () => openSonarSettings('downvision', btnSettings));

btnMore.addEventListener('click', () => {
  overflowMenu(btnMore, [
    { label: 'Settings', action: () => mainSettings(ctx) },
    { label: 'Help', action: () => helpDialog() },
    { label: 'About', action: () => aboutDialog(state, __VERSION__) },
  ]);
});

// ------------------------------------------------------------------ settings gear on tap (app: GestureContainer)

let gearTimer: number | undefined;
/** Hide every trace's settings gear and cancel the auto-hide timer. */
function hideGears(): void {
  for (const t of Object.values(traces)) t.gear.classList.remove('shown');
  window.clearTimeout(gearTimer);
}
/** Toggle a trace's settings gear on tap; it hides again after 5 s (never shown on a Wi-Fish). */
function showGear(ch: ChannelName): void {
  if (isWifish()) return; // the Wi-Fish has its settings button in the toolbar
  const t = traces[ch];
  const shown = t.gear.classList.contains('shown');
  hideGears();
  if (shown) return;
  t.gear.classList.add('shown');
  gearTimer = window.setTimeout(hideGears, 5000);
}
for (const ch of ORDER) traces[ch].gear.addEventListener('click', (e) => { e.stopPropagation(); openSonarSettings(ch, traces[ch].gear); });

// ------------------------------------------------------------------ history scrolling (both traces together)

/** Traces not hidden by the current view. */
const shownTraces = () => Object.values(traces).filter((t) => !t.el.hidden);

/** Trace that leads history scrolling and the scrollbar: the first shown one with data. */
function lead(): TraceView {
  const shown = shownTraces();
  return shown.find((t) => t.store.cols.length > 0) ?? shown[0] ?? traces.downvision;
}

/**
 * Put the other traces at the same moment as the lead: channels ping at different rates, so
 * scrolling both by a column count would drift apart; they are aligned by column time instead.
 * When the lead is live, all resume live together.
 */
function followLead(l: TraceView): void {
  for (const t of Object.values(traces)) {
    if (t === l) continue;
    if (l.live) { t.scrollTo(null); continue; }
    const c = l.store.get(l.right);
    if (c) t.scrollToTime(c.t); else t.scrollTo(l.right);
  }
  paintPause();
}

/** Scroll history by `cols` columns of the lead trace (positive = newer); the others follow by time. */
function scrollHistory(cols: number): void {
  const l = lead();
  l.scrollBy(cols);
  followLead(l);
}

/** Put column `n` of the lead trace at the right edge (null = live); the others follow by time. */
function scrollHistoryTo(n: number | null): void {
  const l = lead();
  l.scrollTo(n);
  followLead(l);
}

// ------------------------------------------------------------------ gestures

interface P { id: number; x: number; y: number; x0: number; y0: number }
const pointers = new Map<number, P>();
let gesture: 'none' | 'tap' | 'drag' | 'pinch' = 'none';
let pinch0: { dx: number; dy: number; speed: number } | null = null;
let longPress: number | undefined;
let downAt = 0;
let lastTap = 0;
let colCarry = 0;
let wheelCarry = 0;
/** Sideways drag has started scrolling history (live traces need a clear sideways move first). */
let hScroll = false;

/**
 * Zoom every shown trace, each at the same local y as the one under the pointer (the app maps the
 * focus once). A pinch zooms around the tracked bottom while the trace follows it; a mouse wheel
 * (`atPointer`) always zooms around the pointer, like the app's wheel handling.
 */
function zoomAll(factor: number, clientX: number, clientY: number, atPointer = false): void {
  const t = traceAt(clientX, clientY);
  const localY = t ? clientY - t.el.getBoundingClientRect().top : undefined;
  for (const tr of shownTraces()) tr.zoomBy(factor, atPointer || !tr.trackBottom ? localY : undefined);
}

/** Visible trace under the given client point, if any. */
function traceAt(x: number, y: number): TraceView | null {
  for (const t of Object.values(traces)) {
    if (t.el.hidden) continue;
    const r = t.el.getBoundingClientRect();
    if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) return t;
  }
  return null;
}

/** Set the scrolling speed on every trace (1..5, saved by the caller). */
function useSpeed(s: number): void {
  prefs.speed = Math.max(MIN_SPEED, Math.min(MAX_SPEED, s));
  for (const t of Object.values(traces)) t.setSpeed(prefs.speed);
}

tracesEl.addEventListener('pointerdown', (e) => {
  if ((e.target as HTMLElement).closest('button')) return;
  tracesEl.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
  if (pointers.size === 1) {
    gesture = 'tap';
    downAt = performance.now();
    colCarry = 0;
    hScroll = false;
    window.clearTimeout(longPress);
    longPress = window.setTimeout(() => {
      if (gesture === 'tap') { gesture = 'none'; showDetails(e.clientX, e.clientY); }
    }, 650);
  } else if (pointers.size === 2) {
    window.clearTimeout(longPress);
    gesture = 'pinch';
    const [a, b] = [...pointers.values()];
    pinch0 = { dx: Math.abs(a.x - b.x), dy: Math.abs(a.y - b.y), speed: prefs.speed };
  }
});

tracesEl.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (gesture === 'tap' && Math.hypot(p.x - p.x0, p.y - p.y0) > 8) { gesture = 'drag'; window.clearTimeout(longPress); }
  if (gesture === 'drag') {
    // Horizontal: history (both traces together, like the app). Vertical: pan when zoomed.
    const pxPerCol = lead().cssPerColumn;
    if (!hScroll) {
      // A live trace only starts scrolling on a clearly sideways move of 8+ columns (app: a.g()),
      // so a vertical pan with a little drift doesn't pause it.
      const ox = p.x - p.x0, oy = p.y - p.y0;
      hScroll = !paused() ? Math.abs(ox) >= 8 * pxPerCol && Math.abs(ox) > Math.abs(oy) : true;
      if (hScroll) colCarry = paused() ? 0 : -ox / pxPerCol;
    } else {
      colCarry += -dx / pxPerCol;
    }
    const whole = Math.trunc(colCarry);
    if (hScroll && whole) {
      colCarry -= whole;
      scrollHistory(whole);
    }
    if (dy) for (const t of shownTraces()) t.panBy(dy);
  } else if (gesture === 'pinch' && pointers.size === 2 && pinch0) {
    const [a, b] = [...pointers.values()];
    const sx = Math.abs(a.x - b.x), sy = Math.abs(a.y - b.y);
    if (pinch0.dy > pinch0.dx) {
      // vertical pinch: zoom the water column
      const f = Math.max(0.2, sy) / Math.max(1, pinch0.dy);
      if (Math.abs(f - 1) > 0.02) {
        zoomAll(f, (a.x + b.x) / 2, (a.y + b.y) / 2);
        pinch0.dy = sy;
      }
    } else {
      useSpeed(pinch0.speed * (sx / Math.max(1, pinch0.dx))); // saved when the pinch ends
    }
  }
});

/**
 * Finish a pointer: a tap shows the gear, a double tap resets the zoom; when the last pointer lifts
 * the gesture ends and a pinched speed is saved.
 */
function pointerEnd(e: PointerEvent): void {
  const p = pointers.get(e.pointerId);
  pointers.delete(e.pointerId);
  window.clearTimeout(longPress);
  if (!p) return;
  if (gesture === 'tap' && performance.now() - downAt < 500) {
    const now = performance.now();
    const t = traceAt(p.x, p.y);
    if (now - lastTap < 320 && t) {
      for (const tr of shownTraces()) tr.resetZoom(); // double tap: back to full range
      hideGears();
    } else if (t) {
      showGear(t.channel);
    }
    lastTap = now;
  }
  if (pointers.size === 0) {
    for (const t of Object.values(traces)) t.endGesture();
    if (gesture === 'pinch') savePrefs({ speed: prefs.speed });
    gesture = 'none';
    pinch0 = null;
  }
}
tracesEl.addEventListener('pointerup', pointerEnd);
tracesEl.addEventListener('pointercancel', pointerEnd);

/**
 * Mouse wheel and trackpad. Ctrl + wheel or Alt + wheel: scroll speed; trackpad pinch (and plain
 * wheel): zoom; Shift + wheel or a sideways wheel: history. A trackpad pinch reaches the page as
 * Ctrl + wheel in pixel mode with small, usually fractional deltas; a mouse wheel with Ctrl held
 * comes in line mode or with whole-pixel notches.
 */
tracesEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  // Deltas in CSS px whatever the browser reports them in (lines, or pages of the trace area).
  const scale = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? Math.max(1, tracesEl.clientHeight) : 1;
  const dx = e.deltaX * scale, dy = e.deltaY * scale;
  const pinch = e.ctrlKey && !e.altKey && e.deltaMode === WheelEvent.DOM_DELTA_PIXEL && !e.deltaX
    && (Math.abs(e.deltaY) < 20 || !Number.isInteger(e.deltaY));
  if (pinch) {
    zoomAll(Math.exp(-dy / 100), e.clientX, e.clientY);
    for (const tr of shownTraces()) tr.endGesture();
    return;
  }
  if (e.ctrlKey || e.altKey) {
    useSpeed(prefs.speed * Math.exp(-dy / 400));
    savePrefs({ speed: prefs.speed });
    return;
  }
  const horiz = e.shiftKey ? dy : dx;
  if (Math.abs(horiz) > Math.abs(e.shiftKey ? 0 : dy)) {
    // Keep the fraction, so slow trackpad scrolling still moves.
    wheelCarry += horiz / lead().cssPerColumn;
    const whole = Math.trunc(wheelCarry);
    if (whole) {
      wheelCarry -= whole;
      scrollHistory(whole);
    }
    return;
  }
  zoomAll(Math.exp(-dy / 500), e.clientX, e.clientY, true);
  for (const tr of shownTraces()) tr.endGesture();
}, { passive: false });

tracesEl.addEventListener('contextmenu', (e) => e.preventDefault());

/** Long press: show depth, bottom, water temperature and time of the ping under the point, paused meanwhile. */
function showDetails(x: number, y: number): void {
  const t = traceAt(x, y);
  if (!t) return;
  const r = t.el.getBoundingClientRect();
  const { col, depthCm } = t.pick(x - r.left, y - r.top);
  if (!col) return;
  const u = depthUnit();
  const off = state?.system?.transducerOffsetCm ?? 0;
  const d = formatDepth(depthCm + off, u);
  const b = formatDepth(col.bottomCm === null ? null : col.bottomCm + off, u);
  const temp = formatTemp(col.tempCentiC, prefs.tempUnit);
  const ago = Math.max(0, Math.round((Date.now() - col.t) / 1000));
  const when = ago < 60 ? `${ago} s ago` : ago < 3600 ? `${Math.floor(ago / 60)} min ${ago % 60} s ago` : new Date(col.t).toLocaleTimeString();
  // Like the app's trace point details, the picture holds still while they are shown.
  const wasPaused = paused();
  if (!wasPaused) setPaused(true);
  messageBox(t.channel === 'sonar' ? 'Sonar' : 'DownVision',
    `Depth at point: ${d.whole}.${d.frac} ${d.symbol}\nBottom: ${b.whole}.${b.frac} ${b.symbol}\nWater: ${temp.whole}.${temp.frac} ${temp.symbol}\nTime: ${new Date(col.t).toLocaleTimeString()} (${when})`,
    [{ label: 'OK' }], { onClose: () => { if (!wasPaused) setPaused(false); } });
}

// ------------------------------------------------------------------ history scrollbar (app: HistoryScrollbarView)

const scrollEl = $<HTMLDivElement>('history-scroll');
const thumb = scrollEl.querySelector<HTMLDivElement>('.thumb') ?? (() => { throw new Error('wifish: index.html has no .thumb in #history-scroll'); })();
let scrollPainted = '';
/**
 * Size and place the scrollbar thumb for the visible part of the lead trace's history and expose
 * its position (0 = oldest, 100 = live) to assistive technology.
 */
function paintScrollbar(): void {
  if (scrollEl.hidden) return;
  const t = lead();
  const first = t.store.first, last = t.store.last;
  const total = Math.max(1, last - first + 1);
  const vis = Math.min(total, t.visibleColumns());
  const w = scrollEl.clientWidth;
  const tw = Math.max(24, (vis / total) * w);
  // Thumb at the left: the oldest column fills the screen (right = first + vis - 1); at the right: live.
  const frac = total > vis ? (t.right - (first + vis - 1)) / (total - vis) : 1;
  const x = Math.max(0, Math.min(w - tw, frac * (w - tw) || 0));
  const key = `${tw}:${x}`;
  if (key === scrollPainted) return;
  scrollPainted = key;
  thumb.style.width = `${tw}px`;
  thumb.style.transform = `translateX(${x}px)`;
  const pct = String(Math.round(Math.max(0, Math.min(1, frac)) * 100));
  if (scrollEl.getAttribute('aria-valuenow') !== pct) {
    scrollEl.setAttribute('aria-valuenow', pct);
    const c = t.store.get(t.right);
    scrollEl.setAttribute('aria-valuetext', t.live || !c ? 'Live' : `Pings from ${new Date(c.t).toLocaleTimeString()}`);
  }
}
/** Right-edge column of the lead trace for a thumb position `frac` (0 = oldest filling the screen, 1 = newest). */
function scrollbarTarget(frac: number): number {
  const t = lead();
  const first = t.store.first, last = t.store.last;
  const total = last - first + 1;
  const vis = Math.min(total, t.visibleColumns());
  // Oldest right edge that still fills the screen is first + vis - 1; the newest is last. A drag to
  // the far right lands exactly on `last`, which is what resumes live (scrollTo treats n >= last as
  // live); anywhere short of it stays on history, even one column away, so the picture doesn't jump
  // back to live from a thumb that is merely near the end.
  return Math.round(first + vis - 1 + frac * (total - vis));
}
scrollEl.addEventListener('pointerdown', (e) => {
  scrollEl.setPointerCapture(e.pointerId);
  /** Scroll all traces so the thumb lands under the pointer. */
  const move = (ev: PointerEvent) => {
    const r = scrollEl.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    scrollHistoryTo(scrollbarTarget(frac));
  };
  move(e);
  scrollEl.addEventListener('pointermove', move);
  // pointercancel (e.g. a system gesture) ends the drag too, or the listener would leak.
  /** Stop tracking the drag and remove its listeners. */
  const end = () => {
    scrollEl.removeEventListener('pointermove', move);
    scrollEl.removeEventListener('pointerup', end);
    scrollEl.removeEventListener('pointercancel', end);
  };
  scrollEl.addEventListener('pointerup', end);
  scrollEl.addEventListener('pointercancel', end);
});
// Keyboard: arrows step a tenth of a screen, Page keys a screen, Home the oldest pings, End live.
scrollEl.addEventListener('keydown', (e) => {
  const vis = lead().visibleColumns();
  const step = Math.max(1, Math.round(vis / 10));
  switch (e.key) {
    case 'ArrowLeft': case 'ArrowUp': scrollHistory(-step); break;
    case 'ArrowRight': case 'ArrowDown': scrollHistory(step); break;
    case 'PageUp': scrollHistory(-vis); break;
    case 'PageDown': scrollHistory(vis); break;
    case 'Home': scrollHistoryTo(scrollbarTarget(0)); break;
    case 'End': scrollHistoryTo(null); break;
    default: return;
  }
  e.preventDefault();
});

// ------------------------------------------------------------------ snapshot

btnSnapshot.addEventListener('click', () => {
  const shown = shownTraces();
  const rect = tracesEl.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const c = document.createElement('canvas');
  c.width = Math.round(rect.width * dpr);
  c.height = Math.round(rect.height * dpr);
  const g = c.getContext('2d');
  if (!g) { toast('Snapshot not available in this browser'); return; }
  g.scale(dpr, dpr);
  g.fillStyle = '#242328';
  g.fillRect(0, 0, rect.width, rect.height);
  for (const t of shown) {
    const r = t.el.getBoundingClientRect();
    t.compose(g, r.left - rect.left, r.top - rect.top);
  }
  // databox
  const db = $('databox');
  const dr = db.getBoundingClientRect();
  g.fillStyle = 'rgba(0,0,0,0.6)';
  g.fillRect(dr.left - rect.left, dr.top - rect.top, dr.width, dr.height);
  g.fillStyle = '#fff';
  g.font = '700 26px system-ui, sans-serif';
  g.textBaseline = 'top';
  const lines = [...db.querySelectorAll('.env')].map((e) => e.textContent?.replace(/(\d)([a-z°])/i, '$1 $2') ?? '');
  lines.forEach((l, i) => g.fillText(l, dr.left - rect.left + 12, dr.top - rect.top + 10 + i * 34));
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  a.download = `wifish-${ts}.png`;
  a.href = c.toDataURL('image/png');
  a.click();
  const flash = $('flash');
  flash.hidden = false;
  flash.classList.remove('go');
  void flash.offsetWidth;
  flash.classList.add('go');
  window.setTimeout(() => { flash.hidden = true; }, 450);
});

// ------------------------------------------------------------------ databox, status

let depthShownAt = 0;
let depthTimer: number | undefined;
/** Update the water temperature readout, and the depth at most once per second (`now` = at once, e.g. a new unit). */
function paintDatabox(now = false): void {
  // The app refreshes the depth readout at most once per second.
  const t0 = performance.now();
  const wait = 1000 - (t0 - depthShownAt);
  if (wait > 0 && !now) {
    if (depthTimer === undefined) depthTimer = window.setTimeout(() => { depthTimer = undefined; paintDatabox(); }, wait);
  } else {
    depthShownAt = t0;
    paintDepth();
  }
  const t = formatTemp(state?.waterTempCentiC ?? null, prefs.tempUnit);
  $('temp').textContent = `${t.whole}.`;
  $('temp-frac').textContent = t.frac;
  $('temp-unit').textContent = t.symbol;
}
/** Write the current depth into the databox. */
function paintDepth(): void {
  const d = formatDepth(state?.depthCm ?? null, depthUnit());
  $('depth').textContent = `${d.whole}.`;
  $('depth-frac').textContent = d.frac;
  $('depth-unit').textContent = d.symbol;
}

let lostDialog: DialogHandle | null = null;
let lowVoltDialog: DialogHandle | null = null;
let lowVoltShown = false;
/** "Lost connection" is shown once per episode, even if dismissed. */
let lostShown = false;
let offlineTimer: number | undefined;
let streamOk = true;

/** Update the connecting/offline screens, source label, and the lost-connection and low-voltage dialogs. */
function paintConnection(): void {
  const s = state;
  const anyData = stores.sonar.cols.length + stores.downvision.cols.length > 0;
  // Like the app returning to its connecting screen: shown whenever no sonar session runs,
  // even if old pictures are still in memory.
  const showConnecting = !s || !streamOk || s.link === 'searching' || s.link === 'offline' || (!anyData && s.link !== 'connected');
  const conn = $('connecting');
  conn.hidden = !showConnecting;
  $('connect-msg').textContent = !streamOk ? 'Connecting to Signal K…' : s ? s.message : 'Plugin not running';
  const offline = !s || !streamOk || s.link === 'offline' || s.link === 'searching';
  if (showConnecting && offline) {
    if (offlineTimer === undefined && $('offline').hidden) {
      offlineTimer = window.setTimeout(() => { offlineTimer = undefined; if (!$('connecting').hidden) $('offline').hidden = false; }, 6000);
    }
  } else {
    window.clearTimeout(offlineTimer);
    offlineTimer = undefined;
    $('offline').hidden = true;
  }
  $('offline-hint').textContent = !streamOk
    ? 'Cannot reach the Signal K server.'
    : !s ? 'The Wi-Fish plugin is not running. Enable it in the Signal K server’s plugin configuration.'
      : s.source === 'device'
        ? 'To view sonar, join this Signal K server to a Wi-Fish or Dragonfly Pro Wi-Fi access point.'
        : s.message;
  const ls = $('link-state');
  ls.textContent = s && s.source !== 'device' ? (s.source === 'demo' ? 'DEMO' : 'REPLAY') : '';

  // Lost connection (app: DisconnectFragment).
  if (s?.link === 'lost' && !lostShown) {
    lostShown = true;
    lostDialog = messageBox('Lost connection', 'Trying to restore connection to the sounder…', [{ label: 'Dismiss' }], { onClose: () => { lostDialog = null; } });
  } else if (s?.link !== 'lost') {
    lostShown = false;
    lostDialog?.close();
  }
  // Low voltage (app: LowVoltageFragment); shown once per episode.
  if (s?.lowVoltage && !lowVoltShown) {
    lowVoltShown = true;
    const name = s.unit?.model ?? 'Sonar';
    lowVoltDialog = messageBox(`${name} voltage warning`, `${name} supply voltage too low. Sounder may stop functioning.`, [{ label: 'OK' }], { onClose: () => { lowVoltDialog = null; } });
  } else if (!s?.lowVoltage) {
    lowVoltShown = false;
    lowVoltDialog?.close();
  }
}

$('btn-retry').addEventListener('click', () => {
  $('offline').hidden = true;
  stream.open();
});

// Simulated-data label blinks every 2 s (app: sim_blink, msg 108).
window.setInterval(() => {
  const el = $('sim-blink');
  if (state?.system?.simulator) el.hidden = !el.hidden;
  else el.hidden = true;
}, 2000);

/** Take a new plugin state: update toolbar, view, prefs and connection UI, then notify listeners. */
function onState(s: WifishState | null): void {
  // A new plugin run (e.g. server restart while the stream reconnected) numbers columns from 1 again.
  if (s && s.epoch !== epoch) {
    if (epoch !== null) resetHistory();
    epoch = s.epoch;
  }
  const prevWifish = isWifish();
  const prevSys = state?.system ?? null;
  state = s;
  const sys = s?.system ?? null;
  const wifish = isWifish();
  btnSettings.hidden = !wifish;
  btnViews.hidden = wifish;
  if (prevWifish !== wifish) {
    hideGears();
    for (const t of Object.values(traces)) t.gear.hidden = wifish; // its settings live in the toolbar
  }
  applyView();
  // The traces only care about the system settings (offset, the sonar's unit); the databox about every state.
  if (prevSys?.transducerOffsetCm !== sys?.transducerOffsetCm || prevSys?.depthUnit !== sys?.depthUnit) applyPrefs();
  else paintDatabox();
  paintConnection();
  for (const l of listeners) l(s);
}

// ------------------------------------------------------------------ plugin connection

const ctx: Ctx = {
  state: () => state,
  depthUnit,
  /** Change a channel's settings on the plugin and take the returned state; an error is toasted (never thrown). */
  async sendChannel(ch, patch) {
    try { onState(await setChannel(ch, patch)); } catch (e) { toast((e as Error).message); }
  },
  /** Change system settings on the plugin and take the returned state; an error is toasted (never thrown). */
  async sendSystem(patch) {
    try { onState(await setSystem(patch)); } catch (e) { toast((e as Error).message); }
  },
  applyPrefs: () => { applyPrefs(); applyView(); },
  /**
   * Use the units here at once, then save them on the plugin so every viewer and later visit gets
   * them. A changed depth unit also re-snaps the sonar's range, from this viewer only.
   */
  setUnits(patch) {
    const before = depthUnit();
    useUnits(patch);
    const after = depthUnit();
    if (after.id !== before.id) unitChanged(after);
    setDisplay(patch).catch((e) => toast(`Units not saved on the server: ${(e as Error).message}`));
  },
  vessel: () => vessel,
  /** Save vessel settings on the plugin; every viewer gets them back as a "vessel" event. */
  setVessel(patch) {
    setVessel(patch).then(onVessel, (e) => toast(`Not saved: ${(e as Error).message}`));
  },
  /** Subscribe to state changes; returns an unsubscribe function. */
  onState(cb) { listeners.add(cb); return () => listeners.delete(cb); },
};

/** Apply display units (kept in this browser too); repaint and tell open dialogs when they changed. */
function useUnits(d: DisplayPrefs): void {
  const patch: Partial<Prefs> = {};
  if (d.depthUnit !== undefined && d.depthUnit !== prefs.depthUnit) patch.depthUnit = d.depthUnit;
  if (d.tempUnit !== undefined && d.tempUnit !== prefs.tempUnit) patch.tempUnit = d.tempUnit;
  if (!Object.keys(patch).length) return;
  savePrefs(patch);
  applyPrefs();
  for (const l of listeners) l(state);
}

/**
 * Units the plugin keeps for all viewers: take those picked anywhere; for any not picked
 * yet, offer the one picked earlier in this browser (a pick, never a locale default) so it
 * is not lost.
 */
function onDisplay(d: DisplayPrefs): void {
  const offer: DisplayPrefs = {};
  if (d.depthUnit === undefined && storedKeys.has('depthUnit')) offer.depthUnit = prefs.depthUnit;
  if (d.tempUnit === undefined && storedKeys.has('tempUnit')) offer.tempUnit = prefs.tempUnit;
  useUnits(d);
  if (Object.keys(offer).length) setDisplay(offer).catch(() => { /* kept in this browser */ });
}

/** Take the vessel settings the plugin keeps and tell open dialogs. */
function onVessel(v: VesselSettings): void {
  vessel = v;
  for (const l of listeners) l(state);
}

/** Clear the stores and return the traces to live and unzoomed. */
function resetHistory(): void {
  for (const s of Object.values(stores)) s.clear();
  for (const t of Object.values(traces)) { t.scrollTo(null); t.resetZoom(); }
  paintPause();
}

let toastTimer: number | undefined;
/** Show a transient status message for 3.5 s (creating the toast element on first use). */
function toast(msg: string): void {
  let el = document.querySelector<HTMLDivElement>('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = msg;
  el.classList.add('shown');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('shown'), 3500);
}

const stream = new PluginStream({
  state: onState,
  display: onDisplay,
  vessel: onVessel,
  /** Store an incoming ping column and redraw its trace if it is live (a paused one shows nothing new). */
  column(c) {
    if (!isChannelName(c.ch)) return;
    const store = stores[c.ch];
    if (!store.add(c)) return;
    const t = traces[c.ch];
    if (t.live) t.invalidate();
    if (backlogDone && store.cols.length === 1) paintConnection();
  },
  /** Plugin history restarted: the next state's epoch is taken as the new run's. */
  reset() {
    resetHistory();
    epoch = null;
  },
  /** Backlog replay finished; repaint the connection state. */
  live() {
    backlogDone = true;
    paintConnection();
  },
  /** Stream connected or dropped; after a drop the backlog is replayed again. */
  connection(ok) {
    streamOk = ok;
    if (!ok) backlogDone = false;
    paintConnection();
  },
});

// ------------------------------------------------------------------ render loop

/** Animation frame: draw traces that changed and the scrollbar, then schedule the next frame. */
function frame(now: number): void {
  for (const t of Object.values(traces)) t.draw(now);
  paintScrollbar();
  requestAnimationFrame(frame);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) for (const t of Object.values(traces)) t.invalidate();
});

applyPrefs();
applyView();
paintPause();
paintConnection();
stream.open();
requestAnimationFrame(frame);
window.addEventListener('beforeunload', () => { closeAll(); stream.close(); });
