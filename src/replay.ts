// Plays a raw capture (wifish-probe --log) back as if it came from the device, in a loop.

import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { readRawLog, type RawRecord } from './rawlog';
import type { Transport, TransportEvents } from './transport';
import { errorMessage } from './util';

/** Largest capture that is replayed (it is held in memory). */
export const MAX_REPLAY_BYTES = 256 * 1024 * 1024;
/** Pause between the last record and the first one again, recorded time. */
export const LOOP_GAP_MS = 1000;
/** Long pauses in the capture are cut to this, recorded time. */
export const MAX_GAP_MS = 2000;

export class ReplayTransport extends EventEmitter<TransportEvents> implements Transport {
  readonly kind = 'replay' as const;
  readonly canSend = false;
  #file: string;
  #records: RawRecord[] = [];
  #i = 0;
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  /** Bumped by start() and stop(), so a load that finishes after a stop() is dropped. */
  #gen = 0;
  #speed: number;

  /** Replay `file`; `speed` > 1 plays faster than recorded (non-positive values mean 1). */
  constructor(file: string, { speed = 1 } = {}) {
    super();
    this.#file = file;
    this.#speed = speed > 0 ? speed : 1;
  }

  /**
   * Load the capture (in the background, up to any truncated record) and loop it. The link is
   * 'connecting' while it loads, then 'connected', or 'offline' with the reason it cannot be played.
   */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    const gen = ++this.#gen;
    this.emit('link', 'connecting', `Loading ${this.#file}`);
    this.#load(gen).catch((e) => this.#fail(gen, `Cannot replay ${this.#file}: ${errorMessage(e)}`));
  }

  /** Stop playback (or the load) and report the link as offline. */
  stop(): void {
    this.#running = false;
    this.#gen++;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.emit('link', 'offline', 'stopped');
  }

  /** No-op: `canSend` is false for a replay. */
  send(): void { /* a capture can't take commands */ }

  /** Read and parse the file; start playing unless stopped meanwhile. */
  async #load(gen: number): Promise<void> {
    const st = await fs.promises.stat(this.#file);
    if (!st.isFile()) throw new Error('not a file');
    if (st.size > MAX_REPLAY_BYTES) throw new Error(`${st.size} bytes is over the ${MAX_REPLAY_BYTES / 1024 / 1024} MiB limit`);
    const buf = await fs.promises.readFile(this.#file);
    if (gen !== this.#gen) return; // stopped (or restarted) while reading
    const records: RawRecord[] = [];
    for (const r of readRawLog(buf)) {
      if ('truncated' in r) break;
      records.push(r);
    }
    if (!records.length) return this.#fail(gen, `${this.#file} has no records`);
    this.#records = records;
    this.#i = 0;
    this.emit('link', 'connected', `Replaying ${this.#file}`);
    this.#next();
  }

  /** The capture cannot be played: report 'offline' with `why`, unless stopped meanwhile. */
  #fail(gen: number, why: string): void {
    if (gen !== this.#gen) return;
    this.#running = false;
    this.emit('link', 'offline', why);
  }

  /**
   * Emit the current record and schedule the next after its recorded gap (scaled by speed).
   * A pass ends with a LOOP_GAP_MS pause and a 'connecting' / 'connected' pair: a new session,
   * so the engine forgets the previous pass's settings sequence numbers and accepts the
   * capture's early settings again.
   */
  #next(): void {
    if (!this.#running) return;
    const r = this.#records[this.#i];
    this.emit('datagram', r.msg);
    this.#i = (this.#i + 1) % this.#records.length;
    const nxt = this.#records[this.#i];
    const wrap = this.#i === 0;
    const gap = wrap ? LOOP_GAP_MS : Math.min(MAX_GAP_MS, Math.max(0, nxt.ts - r.ts));
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (!this.#running) return;
      if (wrap) {
        this.emit('link', 'connecting', `Replaying ${this.#file} again`);
        if (!this.#running) return; // a link listener may have stopped us
        this.emit('link', 'connected', `Replaying ${this.#file}`);
      }
      this.#next();
    }, gap / this.#speed);
  }
}
