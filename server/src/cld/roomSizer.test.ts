import { describe, expect, it } from 'vitest';

import { generateLayout, MAX_ROWS, seatUid, spareKey } from './layout.js';
import {
  nextSpare,
  PEAK_WINDOW_MS,
  RESIZE_EVERY_MS,
  RoomSizer,
  SPARE_MAX,
  SPARE_MIN,
} from './roomSizer.js';

const MIN = 60_000;

describe('spare desks for temps (T-0041)', () => {
  it('at least two, up to the peak, capped, in steps of two with hysteresis', () => {
    expect(nextSpare(SPARE_MIN, 0)).toBe(2);
    expect(nextSpare(2, 2)).toBe(2);
    expect(nextSpare(2, 3)).toBe(4); // crossed: grow a full step
    expect(nextSpare(4, 4)).toBe(4);
    expect(nextSpare(4, 3)).toBe(4); // one below: stay (no pulsing)
    expect(nextSpare(4, 2)).toBe(2); // a full step below: shrink
    expect(nextSpare(4, 5)).toBe(6);
    expect(nextSpare(6, 40)).toBe(SPARE_MAX);
  });

  it("resizes on the last hour's peak, at most once every few minutes", () => {
    const sizer = new RoomSizer();
    const t0 = 1_000_000_000;
    sizer.note(new Map([['dev', 1]]), t0);
    expect(sizer.resize(t0)).toBe(false); // nothing to change
    expect(sizer.spareFor('dev')).toBe(2);
    sizer.note(new Map([['dev', 5]]), t0 + MIN);
    expect(sizer.resize(t0 + MIN)).toBe(true);
    expect(sizer.spareFor('dev')).toBe(6);
    // The temps went home, but the hour's peak holds the desks.
    sizer.note(new Map(), t0 + 10 * MIN);
    expect(sizer.resize(t0 + 10 * MIN)).toBe(false);
    expect(sizer.spareFor('dev')).toBe(6);
    // An hour later the peak is gone; a resize waits its turn.
    const later = t0 + MIN + PEAK_WINDOW_MS + MIN;
    sizer.note(new Map(), later);
    expect(sizer.resize(later)).toBe(true);
    expect(sizer.spareFor('dev')).toBe(2);
    sizer.note(new Map([['dev', 3]]), later + MIN);
    expect(sizer.resize(later + MIN)).toBe(false); // too soon after the last one
    expect(sizer.resize(later + RESIZE_EVERY_MS)).toBe(true);
    expect(sizer.spareFor('dev')).toBe(4);
  });
});

describe('room sizes (T-0041)', () => {
  const room = (n: number, spare: number) => ({
    label: 'dev',
    members: Array.from({ length: n }, (_, k) => `engine:o${k}`),
    spare,
  });
  const size = (n: number, spare: number) => {
    const { layout } = generateLayout([room(n, spare)]);
    const tiles = layout.areaTiles.filter((t) => t === 'dev').length;
    return { tiles, layout };
  };

  it('grows with its orchestrators and spare desks', () => {
    expect(size(6, 2).tiles).toBeGreaterThan(size(2, 2).tiles);
    expect(size(2, 6).tiles).toBeGreaterThan(size(2, 2).tiles);
  });

  it('spare desks are chairs whose ids stay the same across a resize', () => {
    const small = generateLayout([room(2, 2)]).layout.furniture.map((f) => f.uid);
    const big = generateLayout([room(2, 4)]).layout.furniture.map((f) => f.uid);
    for (const k of [0, 1]) {
      expect(small).toContain(seatUid(spareKey('dev', k)));
      expect(big).toContain(seatUid(spareKey('dev', k)));
    }
    expect(big).toContain(seatUid(spareKey('dev', 3)));
    // Orchestrators keep their seats, and spare desks seat nobody by name.
    const { seats } = generateLayout([room(2, 4)]);
    expect(Object.keys(seats)).toEqual(['engine:o0', 'engine:o1']);
  });

  it('has room to walk: two tiles of floor between the walls and the desks', () => {
    const { layout } = size(2, 2);
    const desk = layout.furniture.find((f) => f.type === 'DESK_FRONT')!;
    const at = (c: number, r: number) => layout.tiles[r * layout.cols + c];
    // The room's wall is three tiles above and left of its first desk.
    expect(at(desk.col - 3, desk.row)).toBe(0);
    expect(at(desk.col - 2, desk.row)).not.toBe(0);
    expect(at(desk.col - 1, desk.row)).not.toBe(0);
    expect(at(desk.col, desk.row - 3)).toBe(0);
    expect(at(desk.col, desk.row - 2)).not.toBe(0);
  });

  it('spills rooms that would pass 64 rows instead of shrinking them', () => {
    const many = Array.from({ length: 12 }, (_, k) => ({
      label: `r${k}`,
      members: Array.from({ length: 8 }, (_, j) => `engine:r${k}o${j}`),
      spare: 6,
    }));
    const { layout, overflow } = generateLayout(many);
    expect(layout.rows).toBeLessThanOrEqual(MAX_ROWS);
    expect(overflow.length).toBeGreaterThan(0);
    expect(overflow).toEqual(many.slice(many.length - overflow.length).map((r) => r.label));
    // Everyone left on the floor still has a desk.
    const placed = many.filter((r) => !overflow.includes(r.label));
    const desks = layout.furniture.filter((f) => f.type === 'DESK_FRONT').length;
    expect(desks).toBe(placed.length * 14);
  });
});
