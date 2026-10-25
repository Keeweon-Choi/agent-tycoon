import { describe, expect, it } from 'vitest';

import { createFramePacer } from '../src/office/engine/framePacer.js';

/** Count the frames a pacer accepts over `ms` of 60 Hz vsyncs. */
function accepted(pacer: (ts: number) => boolean, from: number, ms: number): number {
  let n = 0;
  for (let t = from; t < from + ms; t += 1000 / 60) if (pacer(t)) n++;
  return n;
}

describe('createFramePacer (T-0075)', () => {
  it('draws at the asked rate, and a slower rate draws fewer frames', () => {
    expect(accepted(createFramePacer(60), 0, 1000)).toBeGreaterThanOrEqual(59);
    const idle = accepted(createFramePacer(10), 0, 1000);
    expect(idle).toBeGreaterThanOrEqual(9);
    expect(idle).toBeLessThanOrEqual(11);
  });

  it('reset() makes the very next stamp due, even mid-interval', () => {
    const pacer = createFramePacer(10);
    expect(pacer(0)).toBe(true);
    expect(pacer(17)).toBe(false);
    pacer.reset();
    expect(pacer(33)).toBe(true);
  });

  it('follows a rate function: switching to the fast rate takes effect', () => {
    let fps = 10;
    const pacer = createFramePacer(() => fps);
    expect(accepted(pacer, 0, 1000)).toBeLessThanOrEqual(11);
    fps = 60;
    pacer.reset();
    expect(accepted(pacer, 1000, 1000)).toBeGreaterThanOrEqual(58);
  });

  it('answers the same for every caller of one stamp', () => {
    const pacer = createFramePacer(10);
    expect(pacer(0)).toBe(true);
    expect(pacer(0)).toBe(true);
    expect(pacer(17)).toBe(false);
    expect(pacer(17)).toBe(false);
  });
});
