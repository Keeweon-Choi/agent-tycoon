import { describe, expect, it } from 'vitest';

import { BOOT_STEPS } from '../../constants.js';
import { type BootStepId, bootView, skippable, type StepReport } from './bootSteps.js';

const all = (r: StepReport): Record<BootStepId, StepReport> =>
  Object.fromEntries(BOOT_STEPS.map((s) => [s.id, r])) as Record<BootStepId, StepReport>;
const total = BOOT_STEPS.reduce((n, s) => n + s.weight, 0);

describe('bootView', () => {
  it('is 100 and done only when every step is done', () => {
    expect(bootView(all({ done: true }))).toMatchObject({ pct: 100, done: true, current: null });
    expect(bootView(all({ done: false }))).toMatchObject({
      pct: 0,
      done: false,
      current: 'connect',
    });
  });

  it('a step nobody reported waits (a forgotten step never lets the lobby through)', () => {
    const r: Partial<Record<BootStepId, StepReport>> = all({ done: true });
    delete r.warm;
    const v = bootView(r);
    expect(v.done).toBe(false);
    expect(v.current).toBe('warm');
    expect(v.pct).toBeLessThan(100);
  });

  it('stays under 100 while the last step is all but finished', () => {
    const r = { ...all({ done: true }), frame: { done: false, part: [99, 100] as const } };
    expect(bootView(r).pct).toBe(99);
  });

  it('counts the weights done plus the current step share', () => {
    const r = {
      ...all({ done: false }),
      connect: { done: true },
      office: { done: true },
      warm: { done: false, part: [1, 2] as const },
    };
    const v = bootView(r);
    const warm = BOOT_STEPS.find((s) => s.id === 'warm')!.weight;
    expect(v.pct).toBe(Math.floor(((1 + 2 + warm / 2) / total) * 100));
    // the first step still waiting is the one shown, with its own count
    expect(v.current).toBe('fonts');
    expect(v.part).toBeUndefined();
  });

  it('leaves out a step not needed here, from the bar too', () => {
    const r = { ...all({ done: true }), iso: null, frame: { done: false } };
    const iso = BOOT_STEPS.find((s) => s.id === 'iso')!.weight;
    expect(bootView(r).pct).toBe(Math.floor(((total - iso - 1) / (total - iso)) * 100));
    expect(bootView({ ...r, frame: { done: true } }).done).toBe(true);
  });

  it('skips a step that waited too long, and names it', () => {
    const r = { ...all({ done: true }), looks: { done: false, part: [1, 3] as const } };
    expect(bootView(r, new Set(['looks']))).toMatchObject({ done: true, skipped: ['looks'] });
  });

  it('never gives up the daemon steps', () => {
    expect(skippable('connect')).toBe(false);
    expect(skippable('office')).toBe(false);
    expect(skippable('warm')).toBe(true);
  });
});

describe('bootView states', () => {
  it('marks each step: done, the current one, waiting, skipped; a step not needed is absent', () => {
    const r = {
      ...all({ done: false }),
      connect: { done: true },
      fonts: { done: true },
      iso: null,
    };
    expect(bootView(r, new Set(['frame'])).states).toEqual({
      connect: 'done',
      office: 'now',
      fonts: 'done',
      lobby: 'wait',
      looks: 'wait',
      warm: 'wait',
      frame: 'skip',
    });
  });
});
