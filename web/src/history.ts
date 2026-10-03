// Echogram columns held by the browser, per channel.

import { MAX_HISTORY_COLUMNS, type ChannelName, type ColumnMessage } from '../../src/shared/api';

export interface Col {
  n: number;
  t: number;
  startCm: number;
  endCm: number;
  bottomCm: number | null;
  tempCentiC: number | null;
  samples: Uint8Array;
}

/** Base64 to bytes; null when the text is not base64. */
function decode(b64: string): Uint8Array | null {
  try {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export class ColumnStore {
  readonly cols: Col[] = [];
  /**
   * Columns kept per channel: the server's largest history (plugin option `historyColumns`,
   * at most MAX_HISTORY_COLUMNS), so a long server history is not cut short in the browser.
   */
  constructor(readonly channel: ChannelName, readonly max = MAX_HISTORY_COLUMNS) {}

  /** Number of the oldest held column, or 0 when empty. */
  get first(): number { return this.cols.length ? this.cols[0].n : 0; }
  /** Number of the newest held column, or 0 when empty. */
  get last(): number { return this.cols.length ? this.cols[this.cols.length - 1].n : 0; }

  /**
   * Append a column newer than the last held one and trim to `max` columns. Older numbers come from
   * a backlog replayed after a reconnect and are already held; a restart is handled by clear().
   * A column whose samples are not valid base64 is dropped. Returns true when the column was added.
   */
  add(m: ColumnMessage): boolean {
    const last = this.cols[this.cols.length - 1];
    if (last && m.n <= last.n) return false;
    const samples = decode(m.data);
    if (!samples) {
      console.warn(`wifish: dropped ${this.channel} column ${m.n}: bad sample data`);
      return false;
    }
    this.cols.push({
      n: m.n, t: m.t, startCm: m.startCm, endCm: m.endCm, bottomCm: m.bottomCm, tempCentiC: m.waterTempCentiC,
      samples,
    });
    if (this.cols.length > this.max) this.cols.splice(0, this.cols.length - this.max);
    return true;
  }

  /** Column numbered `n`, or undefined. */
  get(n: number): Col | undefined {
    if (!this.cols.length) return undefined;
    const i = n - this.cols[0].n;
    // Numbering is contiguous unless the server dropped columns; fall back to a search.
    const c = this.cols[i];
    if (c && c.n === n) return c;
    let lo = 0, hi = this.cols.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = this.cols[mid].n;
      if (v === n) return this.cols[mid];
      if (v < n) lo = mid + 1; else hi = mid - 1;
    }
    return undefined;
  }

  /** Held column whose time is nearest to `t` (Unix ms), or undefined when empty. Times are non-decreasing. */
  nearestByTime(t: number): Col | undefined {
    const cols = this.cols;
    if (!cols.length) return undefined;
    let lo = 0, hi = cols.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cols[mid].t < t) lo = mid + 1; else hi = mid;
    }
    // cols[lo] is the first column at or after t; the one before it may be closer.
    const after = cols[lo], before = cols[lo - 1];
    return before && t - before.t < after.t - t ? before : after;
  }

  /** Drop all held columns. */
  clear(): void { this.cols.length = 0; }
}
