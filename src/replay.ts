// Plays a raw capture (wifish-probe --log) back as if it came from the device, in a loop.

import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { readRawLog, type RawRecord } from './rawlog';
import type { Transport, TransportEvents } from './transport';

export class ReplayTransport extends EventEmitter<TransportEvents> implements Transport {
  readonly kind = 'replay' as const;
  readonly canSend = false;
  #file: string;
  #records: RawRecord[] = [];
  #i = 0;
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #speed: number;

  /** Replay `file`; `speed` > 1 plays faster than recorded (non-positive values mean 1). */
  constructor(file: string, { speed = 1 } = {}) {
    super();
    this.#file = file;
    this.#speed = speed > 0 ? speed : 1;
  }

  /** Load the whole capture (up to any truncated record) and start looping it; reports failure as link 'offline'. */
  start(): void {
    if (this.#running) return;
    try {
      this.#records = [];
      for (const r of readRawLog(fs.readFileSync(this.#file))) {
        if ('truncated' in r) break;
        this.#records.push(r);
      }
    } catch (e) {
      this.emit('link', 'offline', `Cannot read ${this.#file}: ${(e as Error).message}`);
      return;
    }
    if (!this.#records.length) {
      this.emit('link', 'offline', `${this.#file} has no records`);
      return;
    }
    this.#running = true;
    this.#i = 0;
    this.emit('link', 'connected', `Replaying ${this.#file}`);
    this.#next();
  }

  /** Stop playback and report the link as offline. */
  stop(): void {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.emit('link', 'offline', 'stopped');
  }

  /** No-op: `canSend` is false for a replay. */
  send(): void { /* a capture can't take commands */ }

  /** Emit the current record and schedule the next after its recorded gap (scaled by speed, 1 s at loop end). */
  #next(): void {
    if (!this.#running) return;
    const r = this.#records[this.#i];
    this.emit('datagram', r.msg);
    this.#i = (this.#i + 1) % this.#records.length;
    const nxt = this.#records[this.#i];
    // Loop gap 1 s; cap long pauses in the capture at 2 s.
    const gap = this.#i === 0 ? 1000 : Math.min(2000, Math.max(0, nxt.ts - r.ts));
    this.#timer = setTimeout(() => this.#next(), gap / this.#speed);
  }
}
