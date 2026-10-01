// Echogram columns held by the browser, per channel.

import type { ChannelName, ColumnMessage } from '../../src/shared/api';

export interface Col {
  n: number;
  t: number;
  startCm: number;
  endCm: number;
  bottomCm: number | null;
  tempCentiC: number | null;
  samples: Uint8Array;
}

/** Base64 to bytes. */
function decode(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export class ColumnStore {
  readonly cols: Col[] = [];
  /** The app keeps 40 × 256 columns per channel (z.b). */
  constructor(readonly channel: ChannelName, readonly max = 10_240) {}

  /** Number of the oldest held column, or 0 when empty. */
  get first(): number { return this.cols.length ? this.cols[0].n : 0; }
  /** Number of the newest held column, or 0 when empty. */
  get last(): number { return this.cols.length ? this.cols[this.cols.length - 1].n : 0; }

  /**
   * Append a column newer than the last held one and trim to `max` columns. Older numbers come from
   * a backlog replayed after a reconnect and are already held; a restart is handled by clear().
   */
  add(m: ColumnMessage): void {
    const last = this.cols[this.cols.length - 1];
    if (last && m.n <= last.n) return;
    this.cols.push({
      n: m.n, t: m.t, startCm: m.startCm, endCm: m.endCm, bottomCm: m.bottomCm, tempCentiC: m.waterTempCentiC,
      samples: decode(m.data),
    });
    if (this.cols.length > this.max) this.cols.splice(0, this.cols.length - this.max);
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

  /** Drop all held columns. */
  clear(): void { this.cols.length = 0; }
}
