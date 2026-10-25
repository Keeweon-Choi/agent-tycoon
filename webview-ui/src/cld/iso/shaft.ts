/**
 * ISO-2: the building's one elevator shaft, pure geometry (the Node runner tests it).
 *
 * Every floor's elevator stands on the same tile (elevator.ts `findElevators`: the building's
 * core), so its doors line up on screen, `lifts[k+1] - lifts[k]` apart, and one glass shaft
 * joins them: from the wall top above the doors of a floor to the base of the doors of the floor
 * above, the car riding inside it. Where the floors' elevators are not on one tile (no tile
 * suits them all) the bands slant between the doors and the car follows them.
 */
import { ISO_HALF_H, ISO_HALF_W, ISO_WALL_H } from '../../constants.js';
import type { IsoFloor, IsoStack, Pt } from './projection.js';
import { isoAt } from './projection.js';

/** Tiles an elevator's doors are wide (the elevator takes two wall tiles). */
export const LIFT_TILES = 2;
/** A wall's height at a column, cap to base (iso px): what the wall pieces are made to. */
export const WALL_COLUMN_H = ISO_WALL_H + 2 * ISO_HALF_H;

/** Where an elevator's doors end on its floor's base on the right: the front corner of the
 *  doors' two tiles (the wall's front edge, row + 1). */
export function doorFront(stack: IsoStack, floor: IsoFloor, e: { col: number; row: number }): Pt {
  return isoAt(e.col + LIFT_TILES, e.row - floor.row + 1, floor.level, stack.lifts);
}

/** Each level's doors' front (null: that floor has no elevator). */
export function doorFronts(
  stack: IsoStack,
  elevators: ReadonlyArray<{ floor: string; col: number; row: number }>,
): Array<Pt | null> {
  return stack.floors.map((f) => {
    const e = elevators.find((x) => x.floor === f.id);
    return e ? doorFront(stack, f, e) : null;
  });
}

/**
 * The glass between each pair of neighbouring floors that both have doors: a parallelogram (iso
 * px, clockwise from the lower right) from the wall top over the lower doors to the base of
 * the upper ones. Its sides are vertical when the doors line up.
 */
export function shaftBands(fronts: ReadonlyArray<Pt | null>): Array<[Pt, Pt, Pt, Pt]> {
  const w = LIFT_TILES * ISO_HALF_W;
  const h = LIFT_TILES * ISO_HALF_H;
  const bands: Array<[Pt, Pt, Pt, Pt]> = [];
  for (let k = 0; k + 1 < fronts.length; k++) {
    const a = fronts[k];
    const b = fronts[k + 1];
    if (!a || !b) continue;
    bands.push([
      { x: a.x, y: a.y - WALL_COLUMN_H },
      { x: a.x - w, y: a.y - h - WALL_COLUMN_H },
      { x: b.x - w, y: b.y - h },
      { x: b.x, y: b.y },
    ]);
  }
  return bands;
}

/** Where the doors' front is at a fractional level (the car between two floors), or null when
 *  a floor on either side has no elevator. */
export function frontAt(fronts: ReadonlyArray<Pt | null>, level: number): Pt | null {
  const lo = Math.floor(level);
  const hi = Math.ceil(level);
  const a = fronts[lo];
  const b = fronts[hi];
  if (!a || !b) return null;
  const k = level - lo;
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}
