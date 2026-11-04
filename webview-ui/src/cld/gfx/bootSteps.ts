/**
 * BOOT-LOAD (owner 11-04 21:08): what the loading screen in front of the lobby shows, from what each
 * step reports (BootScreen.tsx reads the real sources). Pure: the bar is the weights of the steps
 * done plus the current one's share of its own count; it is 100 only when every step is done, and
 * a step nobody reported counts as waiting (a forgotten step holds the lobby, never lets it through).
 */
import { BOOT_STEPS } from '../../constants.js';

export type BootStepId = (typeof BOOT_STEPS)[number]['id'];

/** A step's report: done, or waiting with `part` = [done, total] of its own; null = not needed here
 *  (the isometric pictures in the top-down view). */
export type StepReport = { done: boolean; part?: readonly [number, number] } | null;

export type StepState = 'done' | 'now' | 'wait' | 'skip';

export interface BootView {
  pct: number;
  /** Every step done or skipped: the lobby may show. */
  done: boolean;
  /** The first step still waiting (its name and count are shown). */
  current: BootStepId | null;
  part?: readonly [number, number];
  skipped: BootStepId[];
  /** Each step needed here (a step not needed is left out). */
  states: Partial<Record<BootStepId, StepState>>;
}

/** `giveUp`: steps that waited too long and are skipped (they go on behind the lobby). */
export function bootView(
  reports: Partial<Record<BootStepId, StepReport>>,
  giveUp: ReadonlySet<BootStepId> = new Set(),
): BootView {
  let total = 0;
  let got = 0;
  let current: BootStepId | null = null;
  let part: readonly [number, number] | undefined;
  const skipped: BootStepId[] = [];
  const states: Partial<Record<BootStepId, StepState>> = {};
  for (const { id, weight } of BOOT_STEPS) {
    const r = reports[id];
    if (r === null) continue;
    total += weight;
    if (r?.done) {
      got += weight;
      states[id] = 'done';
      continue;
    }
    if (giveUp.has(id)) {
      skipped.push(id);
      got += weight;
      states[id] = 'skip';
      continue;
    }
    const [n, of] = r?.part ?? [0, 0];
    const share = of > 0 ? Math.min(1, Math.max(0, n / of)) : 0;
    got += weight * share;
    states[id] = current === null ? 'now' : 'wait';
    if (current === null) {
      current = id;
      part = r?.part;
    }
  }
  const done = current === null;
  const pct = done ? 100 : Math.min(99, Math.floor((got / Math.max(1, total)) * 100));
  return { pct, done, current, ...(part && { part }), skipped, states };
}

/** Steps that may be given up after BOOT_GIVE_UP_MS: all but the daemon's (without it there is
 *  no office; the retry panel shows instead). */
export const skippable = (id: BootStepId): boolean => id !== 'connect' && id !== 'office';
