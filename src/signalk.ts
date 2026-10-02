// Sonar4 values -> Signal K v1 deltas. Pure; the transport (UDP, app.handleMessage) is the caller's.

/** Integer arithmetic first, one division last: avoids 285.48999999999995-style output. */
export const cmToM = (cm: number): number => cm / 100;
/** Hundredths of °C to kelvin (Signal K temperature unit). */
export const centiCToK = (c: number): number => (c + 27315) / 100;

export const PATH = Object.freeze({
  depth: 'environment.depth.belowTransducer',
  depthBelowSurface: 'environment.depth.belowSurface',
  depthBelowKeel: 'environment.depth.belowKeel',
  surfaceToTransducer: 'environment.depth.surfaceToTransducer',
  transducerToKeel: 'environment.depth.transducerToKeel',
  waterTemp: 'environment.water.temperature',
});

export interface PathValue { path: string; value: unknown }
export interface Delta { context: string; updates: { values: PathValue[] }[] }

/**
 * One delta, several values. `null` values are legal Signal K and mean "no data"
 * (e.g. bottom lock lost) so consumers stop showing a stale depth.
 * $source/timestamp are left out on purpose: the server sets $source to the
 * data-connection / plugin id and stamps receive time.
 */
export function toDelta(values: PathValue[]): Delta {
  return { context: 'vessels.self', updates: [{ values }] };
}

/**
 * Signal K depth paths for a bottom record. The device reports depth with the
 * transducer offset already applied (system settings off 60, PROTOCOL.md §6):
 * offset > 0 = transducer below waterline -> reported is below surface,
 * offset < 0 = offset to keel -> reported is below keel.
 *
 * The sonar holds one offset only. `surfaceToTransducerCm` (kept by the plugin, null =
 * not set) adds depth below surface when the offset is to the keel or 0; when the
 * offset is to the waterline, that offset is the distance and this one is not used.
 * The offsets are published too, as Signal K defines them (both positive downwards):
 * surfaceToTransducer and transducerToKeel, so belowSurface = belowTransducer +
 * surfaceToTransducer and belowKeel = belowTransducer - transducerToKeel.
 */
export function depthValues(reportedCm: number | null, offsetCm: number, surfaceToTransducerCm: number | null = null): PathValue[] {
  /** cm to metres, passing null (no bottom lock) through. */
  const m = (cm: number | null) => (cm === null ? null : cmToM(cm));
  const belowTransducer = reportedCm === null ? null : reportedCm - offsetCm;
  const out: PathValue[] = [{ path: PATH.depth, value: m(belowTransducer) }];
  const surface = offsetCm > 0 ? offsetCm : surfaceToTransducerCm;
  if (surface !== null) {
    out.push({ path: PATH.depthBelowSurface, value: m(belowTransducer === null ? null : belowTransducer + surface) });
    out.push({ path: PATH.surfaceToTransducer, value: m(surface) });
  }
  if (offsetCm < 0) {
    out.push({ path: PATH.depthBelowKeel, value: m(reportedCm) });
    out.push({ path: PATH.transducerToKeel, value: m(-offsetCm) });
  }
  return out;
}

/**
 * Emits a path when its value changed, or when `heartbeatMs` elapsed, but never
 * faster than `minIntervalMs`. A change to/from null always passes through.
 */
export class Throttle {
  #last = new Map<string, { value: unknown; t: number }>();
  readonly minIntervalMs: number;
  readonly heartbeatMs: number;
  /** Defaults: no rate limit, 10 s heartbeat. */
  constructor({ minIntervalMs = 0, heartbeatMs = 10_000 } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.heartbeatMs = heartbeatMs;
  }
  /** Whether to emit `value` for `path` at `now` (ms); records it as last sent when true. */
  shouldEmit(path: string, value: unknown, now: number): boolean {
    const l = this.#last.get(path);
    const nullEdge = l !== undefined && (l.value === null) !== (value === null);
    const due = !l || nullEdge
      || (now - l.t >= this.minIntervalMs && (value !== l.value || now - l.t >= this.heartbeatMs));
    if (due) this.#last.set(path, { value, t: now });
    return due;
  }
  /** Forget all last-sent values so the next value of every path is emitted. */
  reset(): void {
    this.#last.clear();
  }
}
