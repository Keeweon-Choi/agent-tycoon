import { describe, expect, it } from 'vitest';

import { Direction } from '../../office/types.js';
import { type Facing, ISO_MANIFEST, type IsoManifest } from './art.js';
import { facingOf, isoSeat, MIRRORED, seatAnchor, seatPieceFor } from './seats.js';

const piece = (faces: Facing, seats: Array<[number, number]>) => ({
  file: 'x.png',
  density: 12,
  footprint: [1, 1] as [number, number],
  anchor: [0, 0] as [number, number],
  faces,
  seats,
});
const m = {
  pieces: { a: piece('+row', [[3, -10]]), b: piece('-row', [[-2, -8]]) },
  facings: {
    chair: { '+row': { piece: 'a' }, '+col': { piece: 'a', mirror: true }, '-row': { piece: 'b' } },
  },
} as unknown as IsoManifest;

describe('seat anchors', () => {
  it('names the way a sitter faces by world direction', () => {
    expect([Direction.DOWN, Direction.RIGHT, Direction.UP, Direction.LEFT].map(facingOf)).toEqual([
      '+row',
      '+col',
      '-row',
      '-col',
    ]);
    for (const f of ['+row', '+col', '-row', '-col'] as Facing[])
      expect(MIRRORED[MIRRORED[f]]).toBe(f);
  });

  it('gives the seat of the piece for the way it faces, mirrored with x negated', () => {
    expect(seatAnchor(m, 'a', '+row')).toEqual({ x: 3, y: -10 });
    // Flipped, the picture faces the other lower way and its seat is on the other side.
    expect(seatAnchor(m, 'a', '+col', 0, true)).toEqual({ x: -3, y: -10 });
    expect(seatAnchor(m, 'a', '+col')).toBeNull(); // not drawn that way, not flipped
    expect(seatAnchor(m, 'a', '+row', 1)).toBeNull(); // one seat only
    expect(seatAnchor(m, 'nope', '+row')).toBeNull();
  });

  it('picks the piece drawn for a facing, else the same side, else any, and says which', () => {
    expect(seatPieceFor(m, 'chair', '+col')).toEqual({ name: 'a', mirror: true, exact: true });
    expect(seatPieceFor(m, 'chair', '-row')).toEqual({ name: 'b', mirror: false, exact: true });
    // Nothing faces the upper left: the other upper facing stands in, marked not exact.
    expect(seatPieceFor(m, 'chair', '-col')).toEqual({ name: 'b', mirror: false, exact: false });
    expect(seatPieceFor(m, 'sofa', '+row')).toBeNull();
  });
});

describe("the owner's seating", () => {
  it('has a chair for each of the four ways a sitter faces, with a seat on the cushion', () => {
    for (const [dir, expected] of [
      [Direction.UP, 'o-chair-up'],
      [Direction.LEFT, 'o-chair-left'],
      [Direction.RIGHT, 'o-chair-right'],
      [Direction.DOWN, 'o-chair-down'],
    ] as const) {
      const s = isoSeat('chair', dir);
      expect(s?.piece).toBe(expected);
      expect(s?.mirror).toBe(false);
      // Over its footprint (within a tile of the anchor) and up from the floor, not at the feet.
      expect(Math.abs(s!.x)).toBeLessThanOrEqual(8);
      expect(s!.y).toBeLessThan(-8);
      expect(s!.y).toBeGreaterThan(-24);
    }
  });

  it('gives sofas two seats along their length and armchairs one, the mirror for the other lower facing', () => {
    const sofa = ISO_MANIFEST.pieces['o-sofa-a'];
    expect(sofa.seats).toHaveLength(2);
    // Along the long axis: one tile apart there (8 px across, 4 down per tile), the sofa's width.
    const [p, q] = sofa.seats!;
    expect(q[0] - p[0]).toBeCloseTo(8, 0);
    expect(q[1] - p[1]).toBeCloseTo(4, 0);
    expect(ISO_MANIFEST.pieces['o-armchair-a'].seats).toHaveLength(1);
    // Facing the other way down is the same piece flipped (the owner drew both: native wins).
    expect(seatPieceFor(ISO_MANIFEST, 'sofa', '+col')).toMatchObject({
      name: 'o-sofa-b',
      exact: true,
    });
    // No sofa seen from behind yet: the nearest stands in and is marked.
    expect(seatPieceFor(ISO_MANIFEST, 'sofa', '-row')?.exact).toBe(false);
  });
});
