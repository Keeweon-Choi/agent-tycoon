import { describe, expect, it } from 'vitest';

import { Direction, type PlacedFurniture, type Seat, TILE_SIZE } from '../../office/types.js';
import { isoAt } from './projection.js';
import { isoSeatPoint } from './seatPoint.js';
import { isoSeat } from './seats.js';

const catalog = (type: string) => {
  if (type === 'SOFA_SIDE') return { footprintW: 1, footprintH: 2 };
  if (type === 'DESK_FRONT') return { footprintW: 2, footprintH: 1 };
  if (type.startsWith('CUSHIONED_CHAIR')) return { footprintW: 1, footprintH: 1 };
  return undefined;
};

const character = (col: number, row: number, dir: Direction) => ({
  seatId: 'seat',
  dir,
  x: (col + 0.5) * TILE_SIZE,
  y: (row + 0.5) * TILE_SIZE,
});

const expected = (
  item: PlacedFurniture,
  footprint: { footprintW: number; footprintH: number },
  col: number,
  row: number,
  group: string,
  dir: Direction,
  index = 0,
) => {
  const point = isoSeat(group, dir, index)!;
  const anchor = isoAt(item.col + footprint.footprintW, item.row + footprint.footprintH, 0, 0);
  const feet = isoAt(col + 0.5, row + 0.5, 0, 0);
  return { x: anchor.x - feet.x + point.x, y: anchor.y - feet.y + point.y };
};

describe('isometric seat points', () => {
  it('uses the manifest chair cushion for each facing, translated from its front anchor', () => {
    const item = { uid: 'chair', type: 'CUSHIONED_CHAIR_FRONT', col: 4, row: 7 };
    const seat: Seat = {
      uid: 'seat',
      seatCol: 4,
      seatRow: 7,
      facingDir: Direction.DOWN,
      assigned: true,
    };

    for (const dir of [Direction.DOWN, Direction.RIGHT, Direction.UP, Direction.LEFT]) {
      expect(isoSeatPoint(character(4, 7, dir), seat, [item], catalog)).toEqual(
        expected(item, { footprintW: 1, footprintH: 1 }, 4, 7, 'chair', dir),
      );
    }
  });

  it('uses the matching sofa seat index and facing from the manifest', () => {
    const item = { uid: 'sofa', type: 'SOFA_SIDE', col: 8, row: 3 };
    const seat: Seat = {
      uid: 'seat',
      seatCol: 8,
      seatRow: 4,
      facingDir: Direction.RIGHT,
      assigned: true,
    };

    expect(isoSeatPoint(character(8, 4, Direction.RIGHT), seat, [item], catalog)).toEqual(
      expected(item, { footprintW: 1, footprintH: 2 }, 8, 4, 'sofa', Direction.RIGHT, 1),
    );
  });

  it('keeps the default renderer lift when the seat tile has no manifest seating piece', () => {
    const item = { uid: 'desk', type: 'DESK_FRONT', col: 1, row: 2 };
    const seat: Seat = {
      uid: 'seat',
      seatCol: 1,
      seatRow: 2,
      facingDir: Direction.DOWN,
      assigned: true,
    };

    expect(isoSeatPoint(character(1, 2, Direction.DOWN), seat, [item], catalog)).toBeNull();
  });
});
