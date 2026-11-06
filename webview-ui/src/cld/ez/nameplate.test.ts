import { describe, expect, it } from 'vitest';

import {
  NAMEPLATE_OVERLAP_OPACITY,
  NAMEPLATE_SIZES,
} from '../../constants.js';
import {
  clampPlate,
  type CrowdItem,
  crowdPlates,
  dimmedPlates,
  offAlpha,
  plateAt,
  plateLook,
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

describe('the plate width and the name (T-67)', () => {
  it('is one width per screen style and size step, cut at rest, whole when focused, free when opened', () => {
    for (const sizes of Object.values(NAMEPLATE_SIZES))
      for (const px of Object.values(sizes.card)) {
        expect(plateLook(px, false, false)).toEqual({ width: px, name: 'cut' });
        // Hovered or selected: the same width, the name wraps whole inside it.
        expect(plateLook(px, true, false)).toEqual({ width: px, name: 'whole' });
        expect(plateLook(px, true, true)).toEqual({ width: undefined, name: 'whole' });
      }
  });

  it('finds the topmost plate under a point', () => {
    const rs = [rect(1, 0, 0), rect(2, 50, 10)];
    expect(plateAt(rs, 60, 20)).toBe(2);
    expect(plateAt(rs, 10, 5)).toBe(1);
    expect(plateAt(rs, 500, 5)).toBeNull();
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

describe('crowdPlates', () => {
  const box = (left: number, top: number, w: number, h: number) => ({ left, top, right: left + w, bottom: top + h });
  const item = (key: string, rect: ReturnType<typeof box>, low: boolean, more: Partial<CrowdItem> = {}): CrowdItem => ({
    key,
    rect,
    low,
    ...more,
  });

  it('keeps everything that overlaps nothing', () => {
    const fates = crowdPlates([item('a', box(0, 0, 50, 40), true), item('b', box(100, 0, 50, 40), false)], 4, 2);
    expect(fates.get('a')).toEqual({ crowd: false, dy: 0 });
  });

  it('shrinks a low plate off a working one, and rises only when the name still sits on it', () => {
    const work = item('work', box(0, 0, 60, 40), false);
    // The low plate's lower half is under the working one: shrunk to 20 high it clears it at once.
    const clear = crowdPlates([work, item('rest', box(0, 30, 60, 60), true, { small: { w: 40, h: 20 } })], 4, 2);
    expect(clear.get('rest')).toEqual({ crowd: true, dy: 0 });
    const stuck = crowdPlates([work, item('rest', box(0, 10, 60, 25), true, { small: { w: 40, h: 20 } })], 4, 2);
    // Name box 15..35 rises to end 2 px above the working plate's top (0): dy = -37.
    expect(stuck.get('rest')).toEqual({ crowd: true, dy: -37 });
  });

  it('stacks two low plates apart, the lower one keeping its place', () => {
    const fates = crowdPlates(
      [item('up', box(0, 20, 60, 30), true), item('down', box(0, 30, 60, 30), true)],
      4,
      2,
    );
    expect(fates.get('down')).toEqual({ crowd: false, dy: 0 });
    // 'up' (20..50) rises to end at 28: dy = -22.
    expect(fates.get('up')).toEqual({ crowd: true, dy: -22 });
  });

  it('hides a feet badge that sits on a plate or another badge, never moves it', () => {
    const fates = crowdPlates(
      [
        item('plate', box(0, 0, 60, 40), false),
        item('feet-1', box(10, 30, 30, 10), true, { fixed: true }),
        item('feet-2', box(100, 30, 30, 10), true, { fixed: true }),
        item('feet-3', box(110, 32, 30, 10), true, { fixed: true }),
      ],
      4,
      2,
    );
    expect(fates.get('feet-1')).toEqual({ crowd: true, dy: 0 });
    // The lower row (feet-3) is placed first, so feet-2 is the one on top of it.
    expect(fates.get('feet-3')?.crowd).toBe(false);
    expect(fates.get('feet-2')).toEqual({ crowd: true, dy: 0 });
  });

  // T-67: the lounge at every zoom. Plates are one width (W); a rested agent's full plate is H high, its name
  // alone NAME high. Rows of seats a zoom-scaled step apart, one working plate beside them.
  const W = NAMEPLATE_SIZES.medium.card.modern;
  const H = 40;
  const NAME = 22;
  const lounge = (zoom: number, noise: (key: string) => number): CrowdItem[] => {
    const items: CrowdItem[] = [item('work', box(100, 100 - H, W, H), false)];
    for (let i = 0; i < 8; i++) {
      const left = 100 + (i % 4) * 9.37 * zoom - W / 2;
      const bottom = 100 + Math.floor(i / 4) * 6.61 * zoom + 0.37 + noise(`r${i}`);
      items.push(item(`r${i}`, { left, right: left + W, top: bottom - H, bottom }, true, { small: { w: W, h: NAME } }));
    }
    return items;
  };
  const ZOOMS = Array.from({ length: 37 }, (_, i) => 1 + i / 4); // 1..10, the whole steps and between

  it('places the same inputs the same way every frame, at every zoom', () => {
    for (const z of ZOOMS) expect(crowdPlates(lounge(z, () => 0), 4, 2)).toEqual(crowdPlates(lounge(z, () => 0), 4, 2));
  });

  it("is stable fed its own output: the bottoms read back with a rise's sub-pixel noise", () => {
    // A margin is laid out in 1/64 px, so a nudged plate's un-nudged bottom reads back a hair off; two
    // plates on one sofa row used to swap places on every pass at some zooms (neus and cex, 11-06).
    for (const z of ZOOMS) {
      const first = crowdPlates(lounge(z, () => 0), 4, 2);
      let fates = first;
      for (let frame = 1; frame <= 4; frame++) {
        const sign = frame % 2 ? 1 : -1;
        const prev = fates;
        const items = lounge(z, (k) => (prev.get(k)?.dy ? sign / 64 : 0)).map((i) =>
          prev.get(i.key)?.crowd ? { ...i, was: prev.get(i.key)!.dy } : i,
        );
        fates = crowdPlates(items, 4, 2);
        expect(fates, `zoom ${z} frame ${frame}`).toEqual(first);
      }
    }
  });

  it('keeps a rise less than a px off the one it has, takes a new one a px or more away', () => {
    const work = item('work', box(0, 0, 60, 40), false);
    const rest = (was?: number) => item('rest', box(0, 10, 60, 25), true, { small: { w: 60, h: 20 }, was });
    expect(crowdPlates([work, rest(-37)], 4, 2).get('rest')?.dy).toBe(-37);
    expect(crowdPlates([work, rest(-36.5)], 4, 2).get('rest')?.dy).toBe(-36.5);
    expect(crowdPlates([work, rest(-30)], 4, 2).get('rest')?.dy).toBe(-37);
  });

  it('rises by whole px, never into the gap', () => {
    for (const z of ZOOMS)
      for (const fate of crowdPlates(lounge(z, () => 0), 4, 2).values()) expect(Number.isInteger(fate.dy)).toBe(true);
  });
});
