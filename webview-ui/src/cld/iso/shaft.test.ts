import { describe, expect, it } from 'vitest';

import { ISO_HALF_H, ISO_HALF_W } from '../../constants.js';
import { isoStack } from './projection.js';
import { doorFronts, frontAt, LIFT_TILES, shaftBands, WALL_COLUMN_H } from './shaft.js';

const stack = isoStack({
  cols: 30,
  rows: 80,
  cldFloors: [
    { id: '1', row: 0, rows: 30, cols: 30 },
    { id: '2', row: 32, rows: 26, cols: 30 },
    { id: '3', row: 60, rows: 20, cols: 30 },
  ],
});

describe('the one elevator shaft', () => {
  it('lines the doors of every floor up on one screen column when they share a tile', () => {
    // The same column and local row on each floor (the building core).
    const els = stack.floors.map((f) => ({ floor: f.id, col: 4, row: f.row + 1 }));
    const fronts = doorFronts(stack, els);
    expect(new Set(fronts.map((p) => p!.x)).size).toBe(1);
    // One level apart: the rise the stack gives (a shallower floor sits closer).
    expect(fronts[0]!.y - fronts[1]!.y).toBe(stack.lifts[1]);
    expect(fronts[1]!.y - fronts[2]!.y).toBe(stack.lifts[2] - stack.lifts[1]);
  });

  it('joins the doors with glass from the wall top over the lower ones to the base of the upper', () => {
    const els = stack.floors.map((f) => ({ floor: f.id, col: 4, row: f.row + 1 }));
    const fronts = doorFronts(stack, els);
    const bands = shaftBands(fronts);
    expect(bands).toHaveLength(2);
    for (const [k, band] of bands.entries()) {
      const [lr, ll, ul, ur] = band;
      // Vertical sides, as wide as the doors' two tiles.
      expect(lr.x).toBe(ur.x);
      expect(ll.x).toBe(ul.x);
      expect(lr.x - ll.x).toBe(LIFT_TILES * ISO_HALF_W);
      // The lower edge on the wall top over the doors below, the upper on the base of those above.
      expect(lr.y).toBe(fronts[k]!.y - WALL_COLUMN_H);
      expect(ur.y).toBe(fronts[k + 1]!.y);
      // Both edges slant 1:2 like the wall.
      expect(lr.y - ll.y).toBe(LIFT_TILES * ISO_HALF_H);
      expect(ur.y - ul.y).toBe(LIFT_TILES * ISO_HALF_H);
      // The glass is above the lower floor's doors, below the upper floor's.
      expect(lr.y).toBeGreaterThan(ur.y);
    }
  });

  it('skips a floor with no elevator, and slants where the doors do not line up', () => {
    const els = [
      { floor: '1', col: 4, row: 1 },
      { floor: '3', col: 9, row: stack.floors[2].row + 1 },
    ];
    const fronts = doorFronts(stack, els);
    expect(fronts[1]).toBeNull();
    expect(shaftBands(fronts)).toEqual([]);
    expect(frontAt(fronts, 0.5)).toBeNull();
    const two = doorFronts(stack, [
      { floor: '1', col: 4, row: 1 },
      { floor: '2', col: 7, row: stack.floors[1].row + 1 },
    ]);
    expect(shaftBands(two)[0][0].x).not.toBe(shaftBands(two)[0][3].x);
  });

  it('puts the car between two floors by the level it is at', () => {
    const els = stack.floors.map((f) => ({ floor: f.id, col: 4, row: f.row + 1 }));
    const fronts = doorFronts(stack, els);
    expect(frontAt(fronts, 1)).toEqual(fronts[1]);
    const mid = frontAt(fronts, 0.5)!;
    expect(mid.x).toBe(fronts[0]!.x);
    expect(mid.y).toBeCloseTo((fronts[0]!.y + fronts[1]!.y) / 2, 9);
  });
});
