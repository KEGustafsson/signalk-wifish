// Dialogs and popovers, modelled on the app's DialogFragments.

import { PALETTES, SONAR_PALETTES, DOWNVISION_PALETTES, cssColour } from './palettes';
import { prefs, savePrefs } from './prefs';
import { TILES } from './icons';
import { DEPTH_UNITS, presetCm, type DepthUnit } from '../../src/shared/units';
import type { ChannelName, ChannelPatch, ChannelSettingsView, DisplayPrefs, SystemPatch, WifishState } from '../../src/shared/api';
import type { ViewConfig } from './prefs';

/**
 * Create an element with attributes (`class`, `html` = innerHTML, true = empty attribute,
 * false/undefined = omitted) and children.
 */
export const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string | boolean | number | undefined> = {}, ...kids: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') e.className = String(v);
    else if (k === 'html') e.innerHTML = String(v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids) if (k !== null && k !== undefined) e.append(k);
  return e;
};

// ------------------------------------------------------------------ framework

export interface DialogHandle { el: HTMLElement; close(): void; readonly open: boolean }
let stack: DialogHandle[] = [];

export interface DialogOptions {
  title?: string;
  className?: string;
  /** Show as a popover below this element (with an arrow), like the app's anchored dialogs. */
  anchor?: HTMLElement | null;
  /** Modal dialogs dim the page; popovers don't. */
  modal?: boolean;
  dismissable?: boolean;
  onClose?: () => void;
}

let dialogIds = 0;
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Show `content` in a dialog or anchored popover; handles focus, Tab trapping,
 * outside-click dismiss and the Escape stack.
 */
export function openDialog(content: Node, opts: DialogOptions = {}): DialogHandle {
  const layer = h('div', { class: `dialog-layer${opts.modal ? ' modal' : ''}` });
  const box = h('div', { class: `dialog ${opts.className ?? ''}`, role: 'dialog', 'aria-modal': opts.modal ? 'true' : undefined, tabindex: -1 });
  if (opts.title) {
    const id = `dialog-title-${++dialogIds}`;
    box.append(h('div', { class: 'dialog-title', id }, opts.title));
    box.setAttribute('aria-labelledby', id);
  }
  box.append(content);
  layer.append(box);
  document.body.append(layer);
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let open = true;
  /** Visible, enabled focusable elements inside the dialog. */
  const focusables = () => [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => e.offsetParent !== null);
  /** Keep Tab inside a modal dialog: wrap focus between its first and last focusable elements. */
  const trap = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !opts.modal || stack[stack.length - 1] !== handle) return;
    const f = focusables();
    if (!f.length) { e.preventDefault(); box.focus(); return; }
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === box)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', trap);
  /** Re-position an anchored popover when the window size changes. */
  const onResize = () => place?.();
  const handle: DialogHandle = {
    el: box,
    /** False once the dialog has been closed. */
    get open() { return open; },
    /** Remove the dialog and its listeners, call `onClose`, and return focus to where it was; idempotent. */
    close() {
      if (!open) return;
      open = false;
      layer.remove();
      document.removeEventListener('keydown', trap);
      window.removeEventListener('resize', onResize);
      stack = stack.filter((d) => d !== handle);
      opts.onClose?.();
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    },
  };
  if (opts.dismissable !== false) {
    layer.addEventListener('pointerdown', (e) => { if (e.target === layer) handle.close(); });
  }
  let place: (() => void) | null = null;
  if (opts.anchor) {
    const anchor = opts.anchor;
    box.classList.add('anchored');
    place = () => {
      const r = anchor.getBoundingClientRect();
      const bw = box.offsetWidth;
      const left = Math.max(8, Math.min(window.innerWidth - bw - 8, r.left + r.width / 2 - 34));
      const top = Math.min(r.bottom + 10, Math.max(8, window.innerHeight - 120));
      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
      // Short screens (phone in landscape): scroll inside the popover rather than run off the screen.
      box.style.maxHeight = `${Math.max(100, window.innerHeight - top - 8)}px`;
      box.style.setProperty('--arrow-x', `${Math.max(14, Math.min(bw - 14, r.left + r.width / 2 - left))}px`);
    };
    window.addEventListener('resize', onResize);
    requestAnimationFrame(() => place?.());
    place();
  }
  stack.push(handle);
  // Move focus into the dialog so keyboard and screen-reader users land in it.
  requestAnimationFrame(() => { if (open) (focusables()[0] ?? box).focus({ preventScroll: true }); });
  return handle;
}

/** Close every open dialog and popover. */
export function closeAll(): void {
  for (const d of [...stack]) d.close();
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && stack.length) stack[stack.length - 1].close();
});

/** A simple message box (app: MessageDialog / warnings). */
export function messageBox(title: string, text: string, buttons: { label: string; action?: () => void }[] = [{ label: 'OK' }], opts: DialogOptions = {}): DialogHandle {
  const bar = h('div', { class: 'dialog-buttons' });
  const d = openDialog(h('div', {}, h('p', { class: 'dialog-text' }, text), bar), { title, modal: true, className: 'message', ...opts });
  for (const b of buttons) {
    const btn = h('button', { class: 'text-btn' }, b.label);
    btn.addEventListener('click', () => { d.close(); b.action?.(); });
    bar.append(btn);
  }
  return d;
}

// ------------------------------------------------------------------ form widgets

const VALUE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);

/** 0..100 range input; `onStart` fires when the user starts adjusting it (pointer or a value-changing key). */
function slider(value: number, onInput: (v: number) => void, onStart: () => void): HTMLInputElement {
  const s = h('input', { type: 'range', min: 0, max: 100, step: 1, value, class: 'slider' });
  s.addEventListener('pointerdown', onStart);
  // Only keys that change the value count as adjusting it (Tab or Escape must not turn Auto off).
  s.addEventListener('keydown', (e) => { if (VALUE_KEYS.has(e.key)) onStart(); });
  s.addEventListener('input', () => onInput(Number(s.value)));
  return s;
}

/** Labelled checkbox that reports changes to `onChange`. */
function checkbox(checked: boolean, onChange: (v: boolean) => void, label: string): HTMLInputElement {
  const c = h('input', { type: 'checkbox', class: 'check', 'aria-label': label });
  c.checked = checked;
  c.addEventListener('change', () => onChange(c.checked));
  return c;
}

/** On/off switch (a checkbox with role=switch, styled as a track and thumb). */
export function toggle(checked: boolean, onChange: (v: boolean) => void, label: string): HTMLLabelElement {
  const input = h('input', { type: 'checkbox', role: 'switch', 'aria-label': label });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'switch' }, input, h('span', { class: 'track' }, h('span', { class: 'thumb' })));
}

/** Labelled `<select>` with `options`, preselected to `value`, reporting changes to `onChange`. */
function select(options: { value: string; label: string }[], value: string, onChange: (v: string) => void, label: string): HTMLSelectElement {
  const s = h('select', { class: 'select', 'aria-label': label });
  for (const o of options) s.append(h('option', { value: o.value }, o.label));
  s.value = value;
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

/** Debounced sender so slider drags don't flood the sonar (the app sends every step). */
function debounce<T>(fn: (v: T) => void, ms: number): (v: T) => void {
  let t: number | undefined;
  let last: T;
  return (v: T) => {
    last = v;
    if (t === undefined) {
      fn(v);
      t = window.setTimeout(() => { t = undefined; }, ms);
      return;
    }
    window.clearTimeout(t);
    t = window.setTimeout(() => { t = undefined; fn(last); }, ms);
  };
}

// ------------------------------------------------------------------ app dialogs

export interface Ctx {
  state(): WifishState | null;
  depthUnit(): DepthUnit;
  sendChannel(ch: ChannelName, patch: ChannelPatch): Promise<void>;
  sendSystem(patch: SystemPatch): Promise<void>;
  applyPrefs(): void;
  /** Use these display units here and save them on the plugin for every viewer. */
  setUnits(patch: DisplayPrefs): void;
  onState(cb: (s: WifishState | null) => void): () => void;
}

const TABS = ['Sensitivity', 'Range', 'Options'];

/** Sonar / DownVision settings popover: Sensitivity, Range, Options tabs (app: SonarSettingsFragment). */
export function sonarSettings(ctx: Ctx, ch: ChannelName, anchor: HTMLElement | null, onClose: () => void): DialogHandle {
  const title = ch === 'sonar' ? 'Sonar' : 'DownVision';
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const panels = h('div', { class: 'panels' });
  const root = h('div', { class: 'sonar-settings' }, tabs, panels);

  let dragging: string | null = null;
  /** Send a channel settings patch; failures are ignored (the next state update shows the real values). */
  const send = (patch: ChannelPatch) => { ctx.sendChannel(ch, patch).catch(() => {}); };
  /** True when the plugin accepts commands and holds this channel's settings. */
  const controlsEnabled = () => !!ctx.state()?.canControl && !!ctx.state()?.channels[ch];

  // --- Sensitivity
  type SKey = 'gain' | 'contrast' | 'noiseFilter';
  const rows: { key: SKey; label: string; slider: HTMLInputElement; auto: HTMLInputElement; value: HTMLSpanElement }[] = [];
  const sens = h('div', { class: 'panel grid3' }, h('span'), h('span'), h('span', { class: 'col-label' }, 'Auto'));
  for (const [key, label] of [['gain', 'Gain'], ['contrast', 'Contrast'], ['noiseFilter', 'Noise filter']] as [SKey, string][]) {
    const autoKey = `${key}Auto` as const;
    const value = h('span', { class: 'value' });
    const sendLater = debounce<ChannelPatch>(send, 180); // one per slider, so a quick move on another one can't swallow this value
    const sl = slider(0, (v) => {
      value.textContent = String(v);
      sendLater({ [key]: v });
    }, () => {
      dragging = key;
      if (auto.checked) { auto.checked = false; sl.classList.remove('auto'); send({ [autoKey]: false }); }
    });
    sl.addEventListener('change', () => { dragging = null; });
    sl.addEventListener('pointerup', () => { dragging = null; });
    const auto = checkbox(false, (v) => { sl.classList.toggle('auto', v); send({ [autoKey]: v }); }, `${label} auto`);
    sens.append(h('label', { class: 'label' }, label, value), sl, auto);
    rows.push({ key, label, slider: sl, auto, value });
  }

  // --- Range
  const unitLabelA = h('span', { class: 'unit' });
  const unitLabelB = h('span', { class: 'unit' });
  const rangeAuto = checkbox(true, (v) => send({ rangeAuto: v }), 'Range auto');
  const shallow = h('select', { class: 'select', 'aria-label': 'Shallow' });
  const deep = h('select', { class: 'select', 'aria-label': 'Deep' });
  shallow.addEventListener('change', () => {
    rangeAuto.checked = false;
    send({ rangeAuto: false, rangeShallowCm: Number(shallow.value) });
    fillRange(Number(shallow.value), Number(deep.value), 'deep'); // Deep may only offer presets below the new Shallow
  });
  deep.addEventListener('change', () => {
    rangeAuto.checked = false;
    send({ rangeAuto: false, rangeDeepCm: Number(deep.value) });
    fillRange(Number(shallow.value), Number(deep.value), 'shallow');
  });
  const range = h('div', { class: 'panel grid-range' },
    h('span', { class: 'label' }, 'Auto'), rangeAuto, h('span'),
    h('span', { class: 'label' }, 'Shallow'), shallow, unitLabelA,
    h('span', { class: 'label' }, 'Deep'), deep, unitLabelB);

  /** Rebuild the preset lists; `only` limits it to one list (the other one may be open or focused). */
  function fillRange(shallowCm: number, deepCm: number, only?: 'shallow' | 'deep'): void {
    const u = ctx.depthUnit();
    unitLabelA.textContent = unitLabelB.textContent = u.symbol;
    const presets = u.ranges.map((r, i) => ({ cm: presetCm(u, i), label: String(r) }));
    /** `<option>`s for `list`, with the preset nearest `sel` cm selected. */
    const opt = (list: typeof presets, sel: number) => {
      if (!list.length) return [];
      const near = list.reduce((a, b) => (Math.abs(b.cm - sel) < Math.abs(a.cm - sel) ? b : a), list[0]);
      return list.map((p) => { const o = h('option', { value: p.cm }, p.label); if (p === near) o.selected = true; return o; });
    };
    // Shallow offers presets below Deep, Deep presets above Shallow (app: g0.a).
    if (only !== 'deep') shallow.replaceChildren(...opt(presets.filter((p) => p.cm < deepCm), shallowCm));
    if (only !== 'shallow') deep.replaceChildren(...opt(presets.filter((p) => p.cm > shallowCm), deepCm));
  }

  // --- Options
  const palIds = ch === 'sonar' ? SONAR_PALETTES : DOWNVISION_PALETTES;
  const palKey = ch === 'sonar' ? 'paletteSonar' : 'paletteDownvision';
  const swatch = h('span', { class: 'swatch' });
  /** Show a gradient preview of palette `id` next to the palette selector. */
  const paintSwatch = (id: number) => {
    swatch.style.background = `linear-gradient(90deg, ${[0, 64, 128, 192, 255].map((v) => cssColour(id, v)).join(',')})`;
  };
  const palSel = select(palIds.map((id) => ({ value: String(id), label: PALETTES[id].name })), String(prefs[palKey]), (v) => {
    savePrefs({ [palKey]: Number(v) });
    paintSwatch(Number(v));
    ctx.applyPrefs();
  }, 'Palette');
  paintSwatch(prefs[palKey]);
  const options = h('div', { class: 'panel grid2' },
    h('span', { class: 'label' }, 'Palette'), h('div', { class: 'pal' }, palSel, swatch),
    h('span', { class: 'label' }, 'Depth lines'), toggle(prefs.depthLines, (v) => { savePrefs({ depthLines: v }); ctx.applyPrefs(); }, 'Depth lines'));
  if (ch === 'sonar') {
    options.append(h('span', { class: 'label' }, 'A-Scope'), toggle(prefs.aScope, (v) => { savePrefs({ aScope: v }); ctx.applyPrefs(); }, 'A-Scope'));
  }

  const panelEls = [sens, range, options];
  panels.append(...panelEls);
  const uid = `ss-${ch}`;
  panelEls.forEach((p, i) => { p.id = `${uid}-panel-${i}`; p.setAttribute('role', 'tabpanel'); p.setAttribute('aria-labelledby', `${uid}-tab-${i}`); });
  const tabEls = TABS.map((t, i) => {
    const b = h('button', { class: 'tab', role: 'tab', id: `${uid}-tab-${i}`, 'aria-controls': `${uid}-panel-${i}` }, t);
    b.addEventListener('click', () => select_(i));
    // Arrow keys move between tabs (WAI-ARIA tabs pattern).
    b.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const next = (i + d + TABS.length) % TABS.length;
      select_(next);
      tabEls[next].focus();
    });
    tabs.append(b);
    return b;
  });
  /** Show tab `i` and remember it as the preferred settings tab. */
  const select_ = (i: number) => {
    savePrefs({ settingsTab: i });
    tabEls.forEach((b, k) => {
      b.classList.toggle('selected', k === i);
      b.setAttribute('aria-selected', String(k === i));
      b.tabIndex = k === i ? 0 : -1;
    });
    panelEls.forEach((p, k) => { p.hidden = k !== i; });
  };
  select_(Math.max(0, Math.min(2, prefs.settingsTab)));

  const note = h('div', { class: 'settings-note' });
  root.append(note);

  /** Sync the controls with plugin state (a slider being dragged keeps its value) and enable/disable them. */
  const refresh = (s: WifishState | null) => {
    const cs = s?.channels[ch] ?? null;
    const enabled = controlsEnabled();
    root.classList.toggle('disabled', !enabled);
    note.textContent = !s ? 'Not connected' : !s.canControl ? 'Read only: settings cannot be sent in this mode' : !cs ? `Waiting for ${title} settings from the sonar…` : '';
    for (const el of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('.panel:not(:last-child) input, .panel:not(:last-child) select')) el.disabled = !enabled;
    if (!cs) return;
    for (const r of rows) {
      const auto = cs[`${r.key}Auto`];
      if (dragging !== r.key) {
        r.slider.value = String(cs[r.key]);
        r.value.textContent = String(cs[r.key]);
      }
      r.auto.checked = auto;
      r.slider.classList.toggle('auto', auto);
    }
    rangeAuto.checked = cs.rangeAuto;
    // Leave a list alone while it has focus (its popup may be open), but keep the other one in step.
    const focused = document.activeElement === shallow ? 'shallow' : document.activeElement === deep ? 'deep' : null;
    fillRange(cs.rangeShallowCm, cs.rangeDeepCm, focused === 'shallow' ? 'deep' : focused === 'deep' ? 'shallow' : undefined);
  };
  refresh(ctx.state());
  const unsub = ctx.onState(refresh);

  return openDialog(root, { anchor, className: `settings-popover ${ch}`, onClose: () => { unsub(); onClose(); }, title: undefined });
}

/** View switcher grid (app: ViewSwitcherFragment). Map, camera and waypoint views are not part of this web app. */
export function viewSwitcher(anchor: HTMLElement, current: ViewConfig, available: ChannelName[], onPick: (v: ViewConfig) => void): DialogHandle {
  const grid = h('div', { class: 'view-grid' });
  const items: { v: ViewConfig; label: string; art: string }[] = [
    { v: 'split', label: 'Sonar + DownVision', art: TILES.split },
    { v: 'sonar', label: 'Sonar', art: TILES.sonar },
    { v: 'downvision', label: 'DownVision', art: TILES.downvision },
  ];
  const d = openDialog(grid, { anchor, className: 'view-switcher' });
  for (const it of items) {
    const ok = it.v === 'split' ? available.length === 2 : available.includes(it.v as ChannelName);
    const b = h('button', { class: `view-tile${it.v === current ? ' selected' : ''}`, title: it.label, 'aria-label': it.label, disabled: !ok, html: it.art });
    b.addEventListener('click', () => { d.close(); onPick(it.v); });
    grid.append(b);
  }
  return d;
}

/** Overflow menu (app: sonar_trace menu). */
export function overflowMenu(anchor: HTMLElement, items: { label: string; action: () => void }[]): DialogHandle {
  const list = h('div', { class: 'menu', role: 'menu' });
  const d = openDialog(list, { anchor, className: 'menu-popover' });
  for (const it of items) {
    const b = h('button', { class: 'menu-item', role: 'menuitem' }, it.label);
    b.addEventListener('click', () => { d.close(); it.action(); });
    list.append(b);
  }
  // Right-align under the anchor.
  requestAnimationFrame(() => {
    const r = anchor.getBoundingClientRect();
    d.el.style.left = `${Math.max(8, r.right - d.el.offsetWidth)}px`;
    d.el.style.setProperty('--arrow-x', `${d.el.offsetWidth - r.width / 2}px`);
  });
  return d;
}

/** Transducer offset magnitude for display: feet and inches, or one decimal in metres/fathoms. */
function formatOffset(cm: number, u: DepthUnit): string {
  const a = Math.abs(cm);
  if (u.id === 'ft') {
    const inches = Math.round(a / 2.54);
    return `${Math.floor(inches / 12)}' ${inches % 12}"`;
  }
  return `${(a / u.cm).toFixed(1)} ${u.symbol}`;
}

/** Main settings (app: MainSettingsFragment). */
export function mainSettings(ctx: Ctx): DialogHandle {
  const table = h('div', { class: 'main-settings' });
  const s = ctx.state();
  const depthValue = h('button', { class: 'link-btn' });
  /** Update the transducer depth button text and its enabled state from current state. */
  const paintDepth = () => {
    const st = ctx.state();
    const off = st?.system?.transducerOffsetCm ?? 0;
    depthValue.textContent = st?.system ? `${formatOffset(off, ctx.depthUnit())} ${off < 0 ? 'above keel' : 'below waterline'}` : '--';
    depthValue.disabled = !st?.system || !st.canControl;
  };
  paintDepth();
  depthValue.addEventListener('click', () => transducerDepth(ctx, paintDepth));

  const devUnit = s?.system ? DEPTH_UNITS.find((u) => u.code === s.system!.depthUnit) : undefined;
  const unitSel = select(
    [{ value: '', label: `Sonar setting${devUnit ? ` (${devUnit.label})` : ''}` }, ...DEPTH_UNITS.map((u) => ({ value: u.id, label: u.label }))],
    prefs.depthUnit ?? '', (v) => { ctx.setUnits({ depthUnit: (v || null) as DisplayPrefs['depthUnit'] }); paintDepth(); }, 'Depth units');
  const tempSel = select([{ value: 'F', label: '°F' }, { value: 'C', label: '°C' }], prefs.tempUnit, (v) => ctx.setUnits({ tempUnit: v as 'C' | 'F' }), 'Temperature units');

  /** Append a labelled settings row to the table. */
  const row = (label: string, el: HTMLElement) => table.append(h('div', { class: 'row' }, h('span', { class: 'label' }, label), el));
  row('Transducer depth', depthValue);
  row('Depth units', unitSel);
  row('Temperature units', tempSel);
  // Like the app, the simulator switch is offered for the Wi-Fish only (MainSettingsFragment.h()).
  if (s?.system && s.unit?.wifish) {
    row('Simulator', toggle(s.system.simulator, (v) => { ctx.sendSystem({ simulator: v }).catch(() => {}); }, 'Simulator'));
  }
  // Another viewer may change the shared units while this dialog is open.
  const unsub = ctx.onState(() => { paintDepth(); unitSel.value = prefs.depthUnit ?? ''; tempSel.value = prefs.tempUnit; });
  return openDialog(table, { title: 'Settings', modal: true, className: 'main', onClose: unsub });
}

/** Transducer depth (app: TransducerDepthFragment). Applied when the dialog closes. */
export function transducerDepth(ctx: Ctx, onDone: () => void): DialogHandle {
  const u = ctx.depthUnit();
  const off = ctx.state()?.system?.transducerOffsetCm ?? 0;
  const a = Math.abs(off);
  const body = h('div', { class: 'transducer' });
  const row = h('div', { class: 'td-row' });
  let read: () => number;
  if (u.id === 'ft') {
    const inches = Math.round(a / 2.54);
    const ft = select([...Array(10).keys()].map((i) => ({ value: String(i), label: String(i) })), String(Math.min(9, Math.floor(inches / 12))), () => {}, 'Feet');
    const inch = select([...Array(12).keys()].map((i) => ({ value: String(i), label: String(i) })), String(inches % 12), () => {}, 'Inches');
    row.append(ft, h('span', { class: 'unit' }, 'ft'), inch, h('span', { class: 'unit' }, 'in'));
    read = () => Math.trunc(Number(ft.value) * u.cm + Number(inch.value) * 2.54);
  } else {
    const max = u.id === 'm' ? 30 : 16;
    const tenth = select([...Array(max + 1).keys()].map((i) => ({ value: String(i), label: (i / 10).toFixed(1) })), String(Math.min(max, Math.round((a / u.cm) * 10))), () => {}, 'Depth');
    row.append(tenth, h('span', { class: 'unit' }, u.symbol));
    read = () => (u.id === 'm' ? Number(tenth.value) * 10 : Math.trunc(Number(tenth.value) * 0.1 * u.cm));
  }
  const below = h('input', { type: 'radio', name: 'td', id: 'td-below' });
  const above = h('input', { type: 'radio', name: 'td', id: 'td-above' });
  (off < 0 ? above : below).checked = true;
  // Only a change the user made is sent: the lists round the stored offset to their steps,
  // and writing that back on a plain open/close would move it.
  let touched = false;
  body.addEventListener('change', () => { touched = true; });
  body.append(row, h('div', { class: 'radios' },
    h('label', { for: 'td-below' }, below, ' Below waterline'),
    h('label', { for: 'td-above' }, above, ' Above keel')));
  return openDialog(body, {
    title: 'Transducer depth', modal: true, className: 'transducer-dialog',
    onClose: () => {
      if (!touched) return;
      const cm = Math.min(300, read());
      const value = above.checked ? -cm : cm;
      if (value !== off) ctx.sendSystem({ transducerOffsetCm: value }).then(onDone, () => {});
    },
  });
}

/** Help dialog explaining the echogram gestures and controls. */
export function helpDialog(): DialogHandle {
  const items: [string, string][] = [
    ['Scrolling image', 'New sonar pings enter on the right and scroll to the left.'],
    ['History', 'Drag the image sideways to look back through the sonar history. Tap ⏩ (or drag to the right end) to return to the live picture.'],
    ['Zoom', 'Pinch vertically or use the mouse wheel to zoom into the water column. The zoom box on the right shows where you are; double-tap to zoom out.'],
    ['Speed', 'Pinch horizontally, or Ctrl + wheel, to stretch or compress the scrolling image.'],
    ['Adjustments', 'Tap a Sonar or DownVision trace, then its ⚙ button, to change sensitivity, range and palette.'],
    ['Toolbar', 'Switch views, pause the image or save a snapshot from the toolbar. ⋯ opens settings.'],
    ['Details', 'Press and hold on the image to see the depth and time at that point.'],
  ];
  const list = h('div', { class: 'help' });
  for (const [t, d] of items) list.append(h('h3', {}, t), h('p', {}, d));
  return openDialog(list, { title: 'Help', modal: true, className: 'help-dialog' });
}

/** About dialog: web app version, data source, sonar model, serial, software and status. */
export function aboutDialog(s: WifishState | null, version: string): DialogHandle {
  const rows: [string, string][] = [
    ['Web app', version],
    ['Data source', s ? { device: 'Sonar over Wi-Fi', demo: 'Built-in demo', replay: 'Capture replay' }[s.source] : '--'],
    ['Sonar', s?.unit ? `${s.unit.model}${s.unit.name ? ` (${s.unit.name})` : ''}` : '--'],
    ['Serial', s?.unit?.serial ?? '--'],
    ['Sonar software', s?.softwareVersion ?? '--'],
    ['Status', s?.message ?? '--'],
  ];
  const t = h('div', { class: 'about' });
  for (const [k, v] of rows) t.append(h('span', { class: 'label' }, k), h('span', {}, v));
  t.append(h('p', { class: 'legal' }, 'Independent open-source project, not affiliated with or endorsed by Raymarine. Wi-Fish and Dragonfly are trademarks of their respective owners.'));
  return openDialog(t, { title: 'About', modal: true, className: 'about-dialog' });
}
