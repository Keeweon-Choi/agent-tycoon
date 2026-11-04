import { describe, expect, it } from 'vitest';

import { ISO_HALF_H, ISO_HALF_W, ISO_ROOF_H, ISO_SLAB_H, ISO_STOREY_H, ISO_WALL_H } from '../../constants.js';
import { TileType } from '../../office/types.js';
import {
  behind,
  type DepthBox,
  depthOrder,
  floorBox,
  floorOfRow,
  floorWalls,
  isoAt,
  isoInverse,
  isoOrigin,
  isoStack,
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

  it('stacks every floor a storey above the one below: its slab on the lower wall tops', () => {
    // building-a-1104 (owner 11-04 17:51): same-size floors, stacked flush. A storey is a back
    // wall and the slab of the floor above; the upper plate's front edge is a storey up from the
    // lower one's at the same x, its slab's bottom exactly on the lower walls' top.
    expect(ISO_STOREY_H).toBe(ISO_WALL_H + ISO_SLAB_H);
    const stack = isoStack({
      cols: 35,
      rows: 74,
      cldFloors: [
        { id: '1', row: 0, rows: 24, cols: 35 },
        { id: '2', row: 27, rows: 22, cols: 35 },
        { id: '3', row: 52, rows: 20, cols: 35 },
      ],
    });
    expect(stack.lifts).toEqual([0, ISO_STOREY_H, 2 * ISO_STOREY_H]);
    for (const c of [0, 5, 17]) {
      const lower = isoAt(c, stack.depth, 0, stack.lifts);
      const upper = isoAt(c, stack.depth, 1, stack.lifts);
      expect(upper.x).toBe(lower.x);
      expect(upper.y + ISO_SLAB_H).toBe(lower.y - ISO_WALL_H);
    }
  });

  it('gives every floor the deepest plate and keeps each floor its own rows', () => {
    const stack = isoStack({
      cols: 35,
      rows: 74,
      cldFloors: [
        { id: '1', row: 0, rows: 24, cols: 35 },
        { id: '2', row: 27, rows: 22, cols: 35 },
        { id: '3', row: 52, rows: 22, cols: 35 },
      ],
    });
    expect(stack.floors.map((f) => [f.id, f.level, f.rows])).toEqual([
      ['1', 0, 24],
      ['2', 1, 22],
      ['3', 2, 22],
    ]);
    expect(stack.depth).toBe(24);
    // Same plate on every level: the boxes differ by the lift only.
    const [b1, b3] = [floorBox(stack, 0), floorBox(stack, 2)];
    expect([b3.x0, b3.x1]).toEqual([b1.x0, b1.x1]);
    expect(b1.x0).toBe(-24 * ISO_HALF_W);
    expect(b1.y0 - b3.y0).toBe(2 * ISO_STOREY_H);
    // The saved rows still say which floor a row is on (the extra plate rows are no floor's).
    expect(floorOfRow(stack, 30)?.id).toBe('2');
    expect(floorOfRow(stack, 49)).toBeNull(); // 2F is 22 rows: row 49 is between floors
    expect(floorOfRow(stack, 25)).toBeNull();
    // The building's top: the top storey's walls and the roof's parapet.
    expect(stack.box.y0).toBe(-stack.lifts[2] - ISO_WALL_H - ISO_ROOF_H);
    expect(stack.box.y1).toBe((35 + 24) * ISO_HALF_H + ISO_SLAB_H);
    const one = isoStack({ cols: 20, rows: 11 });
    expect(one.floors).toEqual([{ id: '1', row: 0, rows: 11, level: 0 }]);
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
  const walls = floorWalls(map, { id: '1', row: 0, rows: 5, level: 0 });
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

describe('depthOrder with fixed pieces (SMOOTH-1104)', () => {
  // The order before SMOOTH-1104: every pair compared, the smallest ready key scanned for.
  const reference = <T extends DepthBox>(items: readonly T[]): T[] => {
    const n = items.length;
    const before: number[][] = Array.from({ length: n }, () => []);
    const waiting = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        if (behind(items[i], items[j])) {
          before[i].push(j);
          waiting[j]++;
        } else if (behind(items[j], items[i])) {
          before[j].push(i);
          waiting[i]++;
        }
      }
    const key = (b: DepthBox) => b.c0 + b.c1 + b.r0 + b.r1 + (b.lift ?? 0) * 1e-3;
    const keys = items.map(key);
    const done = new Array<boolean>(n).fill(false);
    const out: T[] = [];
    while (out.length < n) {
      let pick = -1;
      for (let i = 0; i < n; i++) if (!done[i] && waiting[i] === 0 && (pick < 0 || keys[i] < keys[pick])) pick = i;
      if (pick < 0) for (let i = 0; i < n; i++) if (!done[i] && (pick < 0 || keys[i] < keys[pick])) pick = i;
      done[pick] = true;
      out.push(items[pick]);
      for (const j of before[pick]) waiting[j]--;
    }
    return out;
  };
  const box = (c0: number, r0: number, w: number, h: number, lift?: number): DepthBox => ({ c0, r0, c1: c0 + w, r1: r0 + h, lift });
  let seed = 7;
  const rnd = (k: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % k;
  };
  it('gives the same order as comparing everything, frame after frame, as characters move', () => {
    const pieces: DepthBox[] = [];
    for (let i = 0; i < 120; i++)
      pieces.push(box(rnd(20), rnd(14), 1 + rnd(3), 1 + rnd(2), rnd(4) === 0 ? 1 : undefined));
    for (let frame = 0; frame < 40; frame++) {
      // the pieces stay (new objects each frame, as the renderer builds them); a door may change
      const now = pieces.map((p) => ({ ...p }));
      if (frame === 20) now[3] = { ...now[3], lift: 2 };
      const chars = Array.from({ length: 18 }, () => {
        const c = rnd(200) / 10;
        const r = rnd(140) / 10;
        return { c0: c - 0.3, r0: r - 0.3, c1: c + 0.3, r1: r + 0.3, lift: 1 };
      });
      const all = [...now, ...chars];
      expect(depthOrder(all, now.length)).toEqual(reference(all));
      expect(depthOrder(all)).toEqual(reference(all));
    }
  });
});
