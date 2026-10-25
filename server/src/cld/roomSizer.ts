/**
 * T-0041: spare desks for temps per room. A room keeps at least SPARE_MIN
 * spare desks, and as many as the most temps it had at once in the last hour
 * (capped). The office does not pulse with each sub-agent:
 * - needs move in steps of two, growing as soon as the step is crossed and
 *   shrinking only once the need is a full step below (hysteresis);
 * - a resize happens at most once every RESIZE_EVERY_MS, for all rooms at once.
 * Seats keep their ids across a resize (layout.ts spareKey), so everyone stays seated.
 */
export const SPARE_MIN = 2;
export const SPARE_MAX = 6;
export const PEAK_WINDOW_MS = 60 * 60_000;
export const RESIZE_EVERY_MS = 5 * 60_000;

/** The spare desks a room should have now, given what it has and its peak. */
export function nextSpare(current: number, peak: number): number {
  const want = Math.min(SPARE_MAX, Math.max(SPARE_MIN, peak));
  const step = Math.min(SPARE_MAX, want + (want % 2)); // 3 -> 4, 5 -> 6
  if (want > current) return step;
  if (want <= current - 2) return Math.max(SPARE_MIN, step);
  return current;
}

export class RoomSizer {
  /** Room -> its spare desks now. */
  private spare = new Map<string, number>();
  /** Room -> [ms, temps] samples of the last hour. */
  private samples = new Map<string, Array<[number, number]>>();
  private lastResize = -Infinity;

  spareFor(room: string): number {
    return this.spare.get(room) ?? SPARE_MIN;
  }

  /** The temps seen in each room now (rooms not named have none). */
  note(counts: Map<string, number>, now: number): void {
    for (const room of new Set([...counts.keys(), ...this.samples.keys()])) {
      const list = (this.samples.get(room) ?? []).filter(([t]) => now - t < PEAK_WINDOW_MS);
      list.push([now, counts.get(room) ?? 0]);
      this.samples.set(room, list);
    }
  }

  peak(room: string): number {
    return Math.max(0, ...(this.samples.get(room) ?? []).map(([, n]) => n));
  }

  /** Resize when it is time and some room's need crossed a step; true if anything changed. */
  resize(now: number): boolean {
    if (now - this.lastResize < RESIZE_EVERY_MS) return false;
    let changed = false;
    for (const room of this.samples.keys()) {
      const next = nextSpare(this.spareFor(room), this.peak(room));
      if (next !== this.spareFor(room)) {
        this.spare.set(room, next);
        changed = true;
      }
    }
    if (changed) this.lastResize = now;
    return changed;
  }
}
