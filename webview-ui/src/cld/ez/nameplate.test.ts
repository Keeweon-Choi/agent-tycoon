import { describe, expect, it } from 'vitest';

import {
  NAMEPLATE_OVERLAP_OPACITY,
  NAMEPLATE_SIZES,
} from '../../constants.js';
import {
  clampPlate,
  dimmedPlates,
  nameMaxPx,
  offAlpha,
  plateOpacity,
  type PlateRect,
  rankIcon,
  ringDash,
  ringOf,
} from './nameplate.js';

const lv = (level: number, xp: number, floor: number, next: number, rebirths = 0) => ({
  level,
  xp,
  floor,
  next,
  rebirths,
});

describe('the XP ring', () => {
  it('fills the share of the way to the next level', () => {
    expect(ringOf(lv(1, 0, 0, 100))).toEqual({ level: 1, pct: 0 });
    expect(ringOf(lv(1, 37, 0, 100))).toEqual({ level: 1, pct: 37 });
    expect(ringOf(lv(7, 2175, 2100, 2800))).toEqual({ level: 7, pct: 10 });
    expect(ringOf(lv(3, 525, 300, 600))).toEqual({ level: 3, pct: 75 });
    expect(ringOf(lv(2, 300, 100, 300))).toEqual({ level: 2, pct: 100 }); // stale, at the next floor
  });

  it('starts empty after a level-up and counts no rebirth into the ring', () => {
    expect(ringOf(lv(3, 300, 300, 600))?.pct).toBe(0);
    expect(ringOf(lv(1, 0, 0, 100, 4))).toEqual({ level: 1, pct: 0 });
    expect(ringOf(lv(2, 150, 100, 300, 2))).toEqual(ringOf(lv(2, 150, 100, 300, 0)));
  });

  it('has no ring without a kept level', () => {
    expect(ringOf(undefined)).toBeNull();
  });

  it('draws the filled and empty arcs', () => {
    const c = 100;
    expect(ringDash(0, c)).toEqual([0, 100]);
    expect(ringDash(37, c)).toEqual([37, 63]);
    expect(ringDash(75, c)).toEqual([75, 25]);
    expect(ringDash(100, c)).toEqual([100, 0]);
    expect(ringDash(140, c)).toEqual([100, 0]);
    expect(ringDash(-5, c)).toEqual([0, 100]);
  });
});

describe('the rank icon', () => {
  it('is the level\'s rank for everyone, the lead\'s crown for an orchestrator', () => {
    expect(rankIcon('codex', lv(15, 0, 0, 1))).toBe('staff');
    expect(rankIcon('subagent', lv(1, 0, 0, 1))).toBe('intern');
    expect(rankIcon('teammate', lv(71, 0, 0, 1))).toBe('director');
    expect(rankIcon('orchestrator', lv(71, 0, 0, 1))).toBe('lead');
    expect(rankIcon('orchestrator', undefined)).toBe('lead');
  });

  it('is none without a level', () => {
    expect(rankIcon('codex', undefined)).toBeNull();
    expect(rankIcon('teammate', undefined)).toBeNull();
    expect(rankIcon('visitor', undefined)).toBeNull();
  });
});

describe('the name', () => {
  it("ends in an ellipsis at the size step's max width, in full when opened", () => {
    expect(nameMaxPx(NAMEPLATE_SIZES.large, false)).toBe(150);
    expect(nameMaxPx(NAMEPLATE_SIZES.medium, false)).toBe(104);
    expect(nameMaxPx(NAMEPLATE_SIZES.small, true)).toBeUndefined();
  });
});

const rect = (id: number, left: number, top: number, w = 100, h = 30): PlateRect => ({
  id,
  left,
  top,
  right: left + w,
  bottom: top + h,
});
const none = new Set<number>();

describe('the overlap pass', () => {
  it('dims two overlapping plates, not the selected or hovered one', () => {
    const two = [rect(1, 0, 0), rect(2, 50, 10)];
    expect([...dimmedPlates(two, none)].sort()).toEqual([1, 2]);
    expect([...dimmedPlates(two, new Set([2]))]).toEqual([1]);
  });

  it('leaves separated plates at 100 %, touching edges included', () => {
    expect(dimmedPlates([rect(1, 0, 0), rect(2, 200, 0)], none).size).toBe(0);
    expect(dimmedPlates([rect(1, 0, 0), rect(2, 100, 0)], none).size).toBe(0);
    expect(dimmedPlates([rect(1, 0, 0), rect(2, 50, 30)], none).size).toBe(0); // stacked rows
  });

  it('lets plates whose edges only meet by the slop be', () => {
    const two = [rect(1, 0, 0), rect(2, 97, 0)];
    expect(dimmedPlates(two, none, 4).size).toBe(0);
    expect(dimmedPlates(two, none, 2).size).toBe(2);
    expect(dimmedPlates([rect(1, 0, 0), rect(2, 50, 27)], none, 4).size).toBe(0);
  });

  it('dims all three of a three-way overlap, and only them', () => {
    const rects = [rect(1, 0, 0), rect(2, 40, 5), rect(3, 80, 10), rect(4, 400, 0)];
    expect([...dimmedPlates(rects, none)].sort()).toEqual([1, 2, 3]);
  });

  it('gives the same answer whatever the order of the plates', () => {
    const rects = [rect(5, 300, 0), rect(1, 0, 0), rect(3, 80, 10), rect(2, 40, 5), rect(4, 1000, 0)];
    const want = [...dimmedPlates(rects, none)].sort();
    expect([...dimmedPlates([...rects].reverse(), none)].sort()).toEqual(want);
    expect(want).toEqual([1, 2, 3]);
  });

  it('agrees with the all-pairs rule on 30 random plates', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 600;
    const rects = Array.from({ length: 30 }, (_, i) => rect(i, rnd(), rnd() / 3));
    const brute = new Set<number>();
    for (const a of rects)
      for (const b of rects)
        if (a !== b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)
          brute.add(a.id);
    expect([...dimmedPlates(rects, none)].sort((x, y) => x - y)).toEqual(
      [...brute].sort((x, y) => x - y),
    );
  });
});

describe('an off character', () => {
  it('is dimmed, but in full while selected or hovered', () => {
    expect(offAlpha(true, false, 0.55)).toBe(0.55);
    expect(offAlpha(true, true, 0.55)).toBe(1);
    expect(offAlpha(false, false, 0.55)).toBe(1);
    expect(offAlpha(false, true, 0.55)).toBe(1);
  });
  it('focused, its plate is never dimmed by the overlap pass either', () => {
    // CharacterLabel: overlay at offAlpha; the pass leaves a focused plate alone.
    const base = offAlpha(true, true, 0.55);
    expect(base * plateOpacity(false, base, NAMEPLATE_OVERLAP_OPACITY)).toBe(1);
    expect(dimmedPlates([rect(1, 0, 0), rect(2, 10, 0)], new Set([1])).has(1)).toBe(false);
  });
});

describe('the composed opacity', () => {
  const DIM = NAMEPLATE_OVERLAP_OPACITY;
  const OFF = 0.55; // an off character's overlay (CharacterLabel)
  const seen = (dimmed: boolean, base: number) => base * plateOpacity(dimmed, base, DIM);
  it('keeps a dimmed plate in the 55-65 % band, an off one too', () => {
    for (const base of [1, OFF]) {
      expect(seen(true, base)).toBeGreaterThanOrEqual(0.55);
      expect(seen(true, base)).toBeLessThanOrEqual(0.65);
    }
    expect(seen(true, 1)).toBeCloseTo(DIM);
    expect(seen(true, OFF)).toBeCloseTo(OFF); // not 0.55 x 0.6
  });
  it('leaves an undimmed plate as its overlay draws it', () => {
    expect(seen(false, 1)).toBe(1);
    expect(seen(false, OFF)).toBe(OFF);
  });
});

describe('edge clamping', () => {
  const bounds = { width: 400, height: 300 };
  const size = { w: 100, h: 40 };
  it('keeps a plate on screen', () => {
    expect(clampPlate(200, 150, size, bounds, 2)).toEqual({ x: 200, y: 150 });
    expect(clampPlate(10, 150, size, bounds, 2)).toEqual({ x: 52, y: 150 });
    expect(clampPlate(395, 10, size, bounds, 2)).toEqual({ x: 348, y: 42 });
  });
  it('leaves a plate wholly off screen where it is', () => {
    expect(clampPlate(-60, 150, size, bounds, 2)).toEqual({ x: -60, y: 150 });
    expect(clampPlate(200, 360, size, bounds, 2)).toEqual({ x: 200, y: 360 });
    expect(clampPlate(200, -1, size, bounds, 2)).toEqual({ x: 200, y: -1 });
  });
  it('leaves an unmeasured plate, or one wider than the screen, where it is', () => {
    expect(clampPlate(10, 5, undefined, bounds, 2)).toEqual({ x: 10, y: 5 });
    expect(clampPlate(10, 150, { w: 500, h: 40 }, bounds, 2)).toEqual({ x: 10, y: 150 });
  });
});
