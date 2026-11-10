import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JOYSTICK_DEAD_ZONE } from '../constants.js';
import { createIdleFade, joystickKeys, knobOffset } from './joystickMath.js';

const R = 100;

describe('joystickKeys', () => {
  it('is no direction inside the dead zone', () => {
    const inside = R * JOYSTICK_DEAD_ZONE - 1;
    expect(joystickKeys(0, 0, R)).toEqual([]);
    expect(joystickKeys(inside, 0, R)).toEqual([]);
  });

  it('holds one key along an axis and two towards a diagonal (8 sectors)', () => {
    expect(joystickKeys(80, 10, R)).toEqual(['right']);
    expect(joystickKeys(-10, -80, R)).toEqual(['up']);
    expect(joystickKeys(60, 60, R)).toEqual(['down', 'right']);
    expect(joystickKeys(-60, -50, R)).toEqual(['up', 'left']);
  });
});

describe('knobOffset', () => {
  it('keeps the knob inside the pad', () => {
    expect(knobOffset(30, 40, R)).toEqual({ x: 30, y: 40 });
    const out = knobOffset(300, 400, R);
    expect(out.x).toBeCloseTo(60);
    expect(out.y).toBeCloseTo(80);
    expect(knobOffset(0, 0, R)).toEqual({ x: 0, y: 0 });
  });
});

describe('createIdleFade', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fades after the delay and wakes on touch', () => {
    const seen: boolean[] = [];
    const fade = createIdleFade(3000, (awake) => seen.push(awake));
    fade.wake();
    vi.advanceTimersByTime(2999);
    expect(seen.at(-1)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(seen.at(-1)).toBe(false);
    fade.hold();
    expect(seen.at(-1)).toBe(true);
    vi.advanceTimersByTime(60_000); // held: a finger is down
    expect(seen.at(-1)).toBe(true);
    fade.wake();
    vi.advanceTimersByTime(3000);
    expect(seen.at(-1)).toBe(false);
  });

  it('restarts the countdown on each wake and stops on dispose', () => {
    const seen: boolean[] = [];
    const fade = createIdleFade(1000, (awake) => seen.push(awake));
    fade.wake();
    vi.advanceTimersByTime(900);
    fade.wake();
    vi.advanceTimersByTime(900);
    expect(seen.at(-1)).toBe(true);
    fade.dispose();
    vi.advanceTimersByTime(5000);
    expect(seen.at(-1)).toBe(true);
  });
});
