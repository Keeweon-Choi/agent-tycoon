/**
 * The H/W graphs' history (T-0046): a ring of the last samples, recorded by
 * the store on every hwSample (no polling of its own), and the line maths.
 * Apart from board.ts so the store can record without importing the board.
 */
import type { HwSample } from '../../../../core/src/messages.js';
import { BOARD_HISTORY_MS, BOARD_HISTORY_SAMPLES } from '../../constants.js';

/** A fixed-size ring: the oldest value goes when a new one comes. */
export class Ring<T> {
  private buf: T[] = [];
  private start = 0;
  readonly cap: number;

  constructor(cap: number) {
    this.cap = cap;
  }

  push(x: T): void {
    if (this.buf.length < this.cap) this.buf.push(x);
    else {
      this.buf[this.start] = x;
      this.start = (this.start + 1) % this.cap;
    }
  }

  /** Oldest first. */
  toArray(): T[] {
    return [...this.buf.slice(this.start), ...this.buf.slice(0, this.start)];
  }

  last(): T | undefined {
    return this.buf.length
      ? this.buf[(this.start + this.buf.length - 1) % this.buf.length]
      : undefined;
  }
}

/** One sample on the graphs: utilisations as fractions (0-1), null when unknown. */
export interface HwPoint {
  t: number;
  cpu: number | null;
  gpu: number | null;
}

/** Every hwSample since this page opened (the store records them, whether or not the board shows). */
export const hwHistory = new Ring<HwPoint>(BOARD_HISTORY_SAMPLES);

/** Record a sample; the same reading sent again (a reconnect's snapshot) counts once. */
export function recordHw(hw: HwSample, ring: Ring<HwPoint> = hwHistory): void {
  const t = hw.ts ? Date.parse(hw.ts) : NaN;
  if (!Number.isFinite(t) || t <= (ring.last()?.t ?? -Infinity)) return;
  ring.push({ t, cpu: hw.cpuUtil ?? null, gpu: hw.gpuUtil ?? null });
}

/**
 * A line over the last 60 s in a w x h box: x by time (the newest sample at
 * the right edge), y by value (0 at the bottom). A missing value breaks the
 * line, so it comes back as segments.
 */
export function lineSegments(
  points: readonly HwPoint[],
  key: 'cpu' | 'gpu',
  w: number,
  h: number,
): Array<Array<[number, number]>> {
  const end = points.at(-1)?.t ?? 0;
  const segments: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> | null = null;
  for (const p of points) {
    const v = p[key];
    if (v === null || end - p.t > BOARD_HISTORY_MS) {
      cur = null;
      continue;
    }
    const x = w - ((end - p.t) / BOARD_HISTORY_MS) * w;
    const y = h - Math.max(0, Math.min(1, v)) * h;
    if (!cur) segments.push((cur = []));
    cur.push([x, y]);
  }
  return segments;
}
