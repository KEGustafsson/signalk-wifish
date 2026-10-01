// Wi-Fish Sonar web app: the Android app's sonar screen for a browser.

import { ColumnStore } from './history';
import { TraceView } from './trace';
import { PluginStream, setChannel, setDisplay, setSystem } from './stream';
import { prefs, savePrefs, storedKeys, type Prefs, type ViewConfig } from './prefs';
import { ICONS } from './icons';
import {
  aboutDialog, closeAll, helpDialog, mainSettings, messageBox, overflowMenu, sonarSettings, viewSwitcher,
  type Ctx, type DialogHandle,
} from './dialogs';
import { formatDepth, formatTemp, snapToPreset, unitByCode, unitById, type DepthUnit } from '../../src/shared/units';
import type { ChannelName, DisplayPrefs, WifishState } from '../../src/shared/api';

declare const __VERSION__: string;

/** Typed shorthand for document.getElementById. */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ------------------------------------------------------------------ model

let state: WifishState | null = null;
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
  const a = ORDER.filter((c) => state?.active[c]);
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

/** Show or hide the traces for the effective view and mark them for redraw. */
function applyView(): void {
  const v = effectiveView();
  tracesEl.className = `traces ${v}`;
  traces.sonar.el.hidden = v === 'downvision';
  traces.downvision.el.hidden = v === 'sonar';
  for (const t of Object.values(traces)) t.invalidate();
}

let appliedUnit: string | null = null;
/**
 * When the depth unit changes the app snaps the sonar's shallow/deep range to the new
 * unit's presets and sends it to both channels (SonarTraceActivity.i.a()).
 */
function unitChanged(u: DepthUnit): void {
  const prev = appliedUnit;
  appliedUnit = u.id;
  if (prev === null || prev === u.id || !state?.canControl) return;
  const ch: ChannelName = isWifish() ? 'downvision' : 'sonar';
  const cs = state.channels[ch];
  if (!cs) return;
  const shallow = snapToPreset(u, cs.rangeShallowCm);
  const deep = snapToPreset(u, cs.rangeDeepCm);
  if ((shallow === cs.rangeShallowCm && deep === cs.rangeDeepCm) || deep <= shallow) return;
  ctx.sendChannel(ch, { rangeAuto: cs.rangeAuto, rangeShallowCm: shallow, rangeDeepCm: deep }).catch(() => {});
}

/** Push the prefs (unit, palettes, offset, depth lines, A-scope, speed) to the traces and repaint the databox. */
function applyPrefs(): void {
  const u = depthUnit();
  if (state) unitChanged(u);
  const offset = state?.system?.transducerOffsetCm ?? 0;
  traces.sonar.palette = prefs.paletteSonar;
  traces.downvision.palette = prefs.paletteDownvision;
  for (const t of Object.values(traces)) {
    t.unit = u;
    t.offsetCm = offset;
    t.depthLines = prefs.depthLines;
    t.aScope = prefs.aScope;
    t.setSpeed(prefs.speed);
    t.invalidate();
  }
  paintDatabox();
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

/** Update the pause/play button; the fast-forward button and history scrollbar show only while paused. */
function paintPause(): void {
  const p = paused();
  btnPause.innerHTML = p ? ICONS.play : ICONS.pause;
  btnPause.title = p ? 'Resume' : 'Pause';
  btnPause.setAttribute('aria-label', btnPause.title);
  btnFF.hidden = !p;
  $('history-scroll').hidden = !p;
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

/** Same local y in every trace for a zoom centred at clientY (the app maps the focus once). */
function zoomAll(factor: number, clientX: number, clientY: number): void {
  const t = traceAt(clientX, clientY);
  const localY = t ? clientY - t.el.getBoundingClientRect().top : undefined;
  // While following the bottom the app zooms around it (scale to bottom), otherwise around the focus.
  for (const tr of shownTraces()) tr.zoomBy(factor, tr.trackBottom ? undefined : localY);
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
/** Traces not hidden by the current view. */
const shownTraces = () => Object.values(traces).filter((t) => !t.el.hidden);

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
    const speed = traces.sonar.speed;
    if (!hScroll) {
      // A live trace only starts scrolling on a clearly sideways move of 8+ columns (app: a.g()),
      // so a vertical pan with a little drift doesn't pause it.
      const ox = p.x - p.x0, oy = p.y - p.y0;
      hScroll = !paused() ? Math.abs(ox) >= 8 * speed && Math.abs(ox) > Math.abs(oy) : true;
      if (hScroll) colCarry = paused() ? 0 : -ox / speed;
    } else {
      colCarry += -dx / speed;
    }
    const whole = Math.trunc(colCarry);
    if (hScroll && whole) {
      colCarry -= whole;
      for (const t of Object.values(traces)) t.scrollBy(whole);
      paintPause();
    }
    if (Math.abs(dy) > 0) for (const t of shownTraces()) t.panBy(dy);
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
      const s = Math.max(1, Math.min(5, pinch0.speed * (sx / Math.max(1, pinch0.dx))));
      prefs.speed = s; // saved when the pinch ends
      for (const t of Object.values(traces)) t.setSpeed(s);
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

tracesEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey && !e.deltaX && Math.abs(e.deltaY) < 20 && !e.altKey) {
    // trackpad pinch arrives as ctrl+wheel with small deltas: zoom
    zoomAll(Math.exp(-e.deltaY / 100), e.clientX, e.clientY);
    return;
  }
  if (e.ctrlKey || e.altKey) {
    const s = Math.max(1, Math.min(5, prefs.speed * Math.exp(-e.deltaY / 400)));
    savePrefs({ speed: s });
    for (const tr of Object.values(traces)) tr.setSpeed(s);
    return;
  }
  const horiz = e.shiftKey ? e.deltaY : e.deltaX;
  if (Math.abs(horiz) > Math.abs(e.shiftKey ? 0 : e.deltaY)) {
    // Keep the fraction, so slow trackpad scrolling still moves.
    wheelCarry += horiz / traces.sonar.speed;
    const whole = Math.trunc(wheelCarry);
    if (whole) {
      wheelCarry -= whole;
      for (const tr of Object.values(traces)) tr.scrollBy(whole);
      paintPause();
    }
    return;
  }
  zoomAll(Math.exp(-e.deltaY / 500), e.clientX, e.clientY);
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
const thumb = scrollEl.querySelector<HTMLDivElement>('.thumb')!;
/** Trace the history scrollbar follows (the first one shown). */
function primary(): TraceView {
  return shownTraces()[0] ?? traces.downvision;
}
/** Size and place the scrollbar thumb for the visible part of the primary trace's history. */
function paintScrollbar(): void {
  if (scrollEl.hidden) return;
  const t = primary();
  const first = t.store.first, last = t.store.last;
  const total = Math.max(1, last - first + 1);
  const vis = Math.min(total, t.visibleColumns());
  const w = scrollEl.clientWidth;
  const tw = Math.max(24, (vis / total) * w);
  const x = ((t.right - first + 1 - vis) / Math.max(1, total - vis)) * (w - tw);
  thumb.style.width = `${tw}px`;
  thumb.style.transform = `translateX(${Math.max(0, Math.min(w - tw, x || 0))}px)`;
}
scrollEl.addEventListener('pointerdown', (e) => {
  scrollEl.setPointerCapture(e.pointerId);
  /** Scroll all traces so the thumb lands under the pointer. */
  const move = (ev: PointerEvent) => {
    const t = primary();
    const r = scrollEl.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    const target = t.store.first + t.visibleColumns() + frac * (t.store.last - t.store.first - t.visibleColumns());
    const delta = Math.round(target - t.right);
    for (const tr of Object.values(traces)) tr.scrollBy(delta);
    paintPause();
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

// ------------------------------------------------------------------ snapshot

btnSnapshot.addEventListener('click', () => {
  const shown = shownTraces();
  const rect = tracesEl.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const c = document.createElement('canvas');
  c.width = Math.round(rect.width * dpr);
  c.height = Math.round(rect.height * dpr);
  const g = c.getContext('2d')!;
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
/** Update the water temperature readout, and the depth at most once per second. */
function paintDatabox(): void {
  // The app refreshes the depth readout at most once per second.
  const now = performance.now();
  const wait = 1000 - (now - depthShownAt);
  if (wait > 0) {
    if (depthTimer === undefined) depthTimer = window.setTimeout(() => { depthTimer = undefined; paintDatabox(); }, wait);
  } else {
    depthShownAt = now;
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
  state = s;
  btnSettings.hidden = !isWifish();
  btnViews.hidden = isWifish();
  if (prevWifish !== isWifish()) hideGears();
  applyView();
  applyPrefs();
  paintConnection();
  for (const l of listeners) l(s);
}

// ------------------------------------------------------------------ plugin connection

const ctx: Ctx = {
  state: () => state,
  depthUnit,
  /** Change a channel's settings on the plugin and take the returned state; errors are toasted and rethrown. */
  async sendChannel(ch, patch) {
    try { onState(await setChannel(ch, patch)); } catch (e) { toast((e as Error).message); throw e; }
  },
  /** Change system settings on the plugin and take the returned state; errors are toasted and rethrown. */
  async sendSystem(patch) {
    try { onState(await setSystem(patch)); } catch (e) { toast((e as Error).message); throw e; }
  },
  applyPrefs: () => { applyPrefs(); applyView(); },
  /** Use the units here at once, then save them on the plugin so every viewer and later visit gets them. */
  setUnits(patch) {
    useUnits(patch);
    setDisplay(patch).catch((e) => toast(`Units not saved on the server: ${(e as Error).message}`));
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
 * yet, offer the one picked earlier in this browser so it is not lost.
 */
function onDisplay(d: DisplayPrefs): void {
  useUnits(d);
  const offer: DisplayPrefs = {};
  if (d.depthUnit === undefined && storedKeys.has('depthUnit')) offer.depthUnit = prefs.depthUnit;
  if (d.tempUnit === undefined && storedKeys.has('tempUnit')) offer.tempUnit = prefs.tempUnit;
  if (Object.keys(offer).length) setDisplay(offer).catch(() => { /* kept in this browser */ });
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
  toastTimer = window.setTimeout(() => el!.classList.remove('shown'), 3500);
}

const stream = new PluginStream({
  state: onState,
  display: onDisplay,
  /** Store an incoming ping column and redraw its trace if it is live or zoomed. */
  column(c) {
    stores[c.ch].add(c);
    const t = traces[c.ch];
    if (t.live || t.zoomed) t.invalidate();
    if (backlogDone && stores[c.ch].cols.length === 1) paintConnection();
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
