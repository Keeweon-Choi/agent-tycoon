import { describe, expect, it } from 'vitest';

import { ISO_FLOOR_GAP, ISO_HALF_H, ISO_SLAB_H, ISO_WALL_H } from '../../constants.js';
import { TileType } from '../../office/types.js';
import {
  behind,
  type DepthBox,
  depthOrder,
  floorOfRow,
  floorWalls,
  isoAt,
  isoInverse,
  isoOrigin,
  isoStack,
  levelRise,
  panTo,
} from './projection.js';

const W = TileType.WALL;
const F = TileType.FLOOR_1;
const V = TileType.VOID;

describe('iso projection', () => {
  it('maps a tile to a 2:1 diamond and back, on every level', () => {
    const s = 70;
    expect(isoAt(0, 0, 0, s)).toEqual({ x: 0, y: 0 });
    expect(isoAt(1, 0, 0, s)).toEqual({ x: 8, y: 4 }); // +col: right and down, 2:1
    expect(isoAt(0, 1, 0, s)).toEqual({ x: -8, y: 4 }); // +row: left and down
    expect(isoAt(0, 0, 2, s).y).toBe(-2 * s); // levels stack upwards
    for (const [c, r, l] of [
      [0.5, 0.5, 0],
      [12.25, 3.75, 1],
      [33, 21.5, 2],
      [-1, 40, 4],
    ]) {
      const p = isoAt(c, r, l, s);
      const back = isoInverse(p.x, p.y, l, s);
      expect(back.col).toBeCloseTo(c, 9);
      expect(back.row).toBeCloseTo(r, 9);
    }
  });

  it('sits every floor flush on the wall tops of the one below, whatever its depth', () => {
    // Floor 1's back walls stand on its row `top`; the floor above is `rows` deep. Its front-left
    // edge (row = rows) and slab, and the lower back wall's top, meet at the same screen x.
    for (const [top, rows] of [
      [0, 24],
      [1, 22],
      [1, 30],
    ]) {
      const rise = levelRise(top, rows);
      expect(rise).toBe((rows - top) * 2 * ISO_HALF_H + ISO_WALL_H + ISO_SLAB_H + ISO_FLOOR_GAP);
      for (const c of [0, 5, 17]) {
        // A back wall tile (c, top) stands on its front edge, `ISO_WALL_H + two half diamonds` tall.
        const wallBase = isoAt(c + 1, top + 1, 0, [0, rise]);
        const wallTop = { x: wallBase.x, y: wallBase.y - ISO_WALL_H - 2 * ISO_HALF_H };
        // The upper floor's front-left edge at the same x: its slab's bottom is under it.
        const upper = isoAt(c + 1 - top - 1 + rows, rows, 1, [0, rise]);
        expect(upper.x).toBe(wallTop.x);
        expect(upper.y + ISO_SLAB_H - wallTop.y, `top ${top} rows ${rows} col ${c}`).toBe(
          ISO_FLOOR_GAP,
        );
      }
    }
  });

  it('stacks the daemon floors bottom up, one level for an office of one floor', () => {
    const stack = isoStack({
      cols: 35,
      rows: 74,
      cldFloors: [
        { id: '1', row: 0, rows: 24, cols: 35 },
        { id: '2', row: 27, rows: 22, cols: 35 },
        { id: '3', row: 52, rows: 22, cols: 35 },
      ],
    });
    expect(stack.floors.map((f) => [f.id, f.level])).toEqual([
      ['1', 0],
      ['2', 1],
      ['3', 2],
    ]);
    expect(stack.depth).toBe(24);
    // Each floor is raised by the rise over the one below, its own depth (a shallower floor
    // sits closer); no tile map: the back walls are taken on row 0.
    expect(stack.lifts).toEqual([0, levelRise(0, 22), levelRise(0, 22) * 2]);
    expect(floorOfRow(stack, 30)?.id).toBe('2');
    expect(floorOfRow(stack, 25)).toBeNull(); // the void rows between floors
    expect(stack.box.y0).toBe(-stack.lifts[2] - ISO_WALL_H);
    const one = isoStack({ cols: 20, rows: 11 });
    expect(one.floors).toEqual([{ id: '1', row: 0, rows: 11, level: 0, top: 0 }]);
    // With the tile grid, a floor's back walls are where its first non-void row is.
    const t = isoStack({ cols: 3, rows: 4 }, [
      [V, V, V],
      [W, W, W],
      [W, F, W],
      [W, W, W],
    ]);
    expect(t.floors[0].top).toBe(1);
  });

  it('places the origin on whole device px and pans like the top-down camera', () => {
    const centre = { x: 10.3, y: -40.6 };
    const o = isoOrigin({ w: 1001, h: 800 }, centre, 3, { x: 0.4, y: -0.6 });
    expect(Number.isInteger(o.x) && Number.isInteger(o.y)).toBe(true);
    // panTo puts a point at the canvas centre (to the rounding).
    const target = { x: 120, y: 64 };
    const p = panTo(target, centre, 2);
    const at = isoOrigin({ w: 1000, h: 800 }, centre, 2, p);
    expect(Math.abs(at.x + target.x * 2 - 500)).toBeLessThanOrEqual(1);
    expect(Math.abs(at.y + target.y * 2 - 400)).toBeLessThanOrEqual(1);
  });
});

describe('iso depth order', () => {
  const box = (c0: number, r0: number, w: number, h: number, lift = 0): DepthBox => ({
    c0,
    r0,
    c1: c0 + w,
    r1: r0 + h,
    lift,
  });
  /** A character's feet at tile (c, r). */
  const feet = (c: number, r: number): DepthBox => box(c + 0.2, r + 0.2, 0.6, 0.6);

  it('draws what is further back first, by feet and footprints', () => {
    const desk = box(3, 5, 3, 1);
    expect(behind(feet(4, 3), desk)).toBe(true); // behind the desk (smaller row)
    expect(behind(desk, feet(4, 6))).toBe(true); // on the chair in front of it
    expect(behind(desk, feet(6, 5))).toBe(true); // beside it, towards the viewer's right
    expect(behind(feet(2, 5), desk)).toBe(true); // beside it, at the back left
    // Apart both ways: neither covers the other, either order is right.
    expect(behind(feet(8, 1), feet(1, 8))).toBe(false);
    expect(behind(feet(1, 8), feet(8, 1))).toBe(false);
  });

  it('puts a long piece behind a character in front of its far end (centres alone would not)', () => {
    const board = box(5, 8, 28, 2); // the lobby board
    const ch = feet(30, 10); // in front of its right end
    // The character's centre sum is smaller than the board's far-right centre would suggest
    // wrongly with a centre sort the other way round; the separation decides.
    const order = depthOrder([ch, board]);
    expect(order).toEqual([board, ch]);
    const behindIt = feet(31, 6); // beyond its right end, further back
    expect(depthOrder([board, behindIt])).toEqual([behindIt, board]);
  });

  it('sorts a room: back wall, desk, monitor on it, the sitter, then a plant in front', () => {
    const wall = box(0, 0, 10, 1);
    const desk = box(3, 3, 3, 1);
    const monitor = box(4, 3, 1, 1, 10);
    const sitter = feet(4, 4);
    const plant = box(4, 6, 1, 1);
    const order = depthOrder([plant, sitter, monitor, desk, wall]);
    expect(order).toEqual([wall, desk, monitor, sitter, plant]);
  });

  it('is a valid painter order for a crowd: nothing is drawn before a piece behind it', () => {
    const items: DepthBox[] = [];
    for (let i = 0; i < 60; i++) {
      const c = (i * 7) % 23;
      const r = (i * 11) % 17;
      items.push(i % 3 ? feet(c, r) : box(c, r, 1 + (i % 4), 1 + (i % 2)));
    }
    const order = depthOrder(items);
    expect(order).toHaveLength(items.length);
    for (let i = 0; i < order.length; i++)
      for (let j = i + 1; j < order.length; j++) expect(behind(order[j], order[i])).toBe(false);
  });
});

describe('iso walls', () => {
  // A floor of two rooms side by side and a narrower room row behind on the right:
  //   . . . . . . .      (void row)
  //   # # # # . . .
  //   # . # # # # #
  //   # . . . . . #
  //   # # # # # # #
  const map = [
    [V, V, V, V, V, V, V],
    [W, W, W, W, V, V, V],
    [W, F, W, W, W, W, W],
    [W, F, F, F, F, F, W],
    [W, W, W, W, W, W, W],
  ];
  const walls = floorWalls(map, { id: '1', row: 0, rows: 5, level: 0, top: 1 });
  const at = (c: number, r: number) => walls.find((w) => w.col === c && w.row === r)!;

  it('stands the back walls tall and cuts every other wall low', () => {
    expect(at(1, 1)).toMatchObject({ tall: true, faceRow: true }); // the back wall
    expect(at(0, 3)).toMatchObject({ tall: true, faceCol: true }); // the left wall
    expect(at(0, 1)).toMatchObject({ tall: true, faceRow: true, faceCol: true }); // the corner
    expect(at(5, 2).tall).toBe(true); // the back wall of the deeper room, void behind it
    expect(at(2, 2).tall).toBe(false); // a partition between rooms
    expect(at(6, 3).tall).toBe(false); // the right wall, near the viewer
    expect(at(3, 4).tall).toBe(false); // the front wall
  });
});
