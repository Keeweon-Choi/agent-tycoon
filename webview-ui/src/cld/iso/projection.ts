/**
 * ISO-PILOT: the isometric projection of the office world, pure (the Node runner tests it).
 *
 * The world stays the top-down one: the daemon's stacked layout, its tile grid, seats, paths
 * and characters' world px (16 px tiles). This module only maps it onto the screen: each floor
 * of the building (the layout's `cldFloors`, or the whole map for an office of one floor) is a
 * level, its tiles (col, row on that floor) become 2:1 diamonds, and the levels stack upwards
 * from floor 1. Nothing here knows a camera: the renderer adds the zoom and pan
 * (`isoOrigin`), so the characters' world never hardcodes a view.
 *
 * Each level is raised (`lifts`) so its slab sits directly on the wall tops of the level below
 * (owner 10-26 01:48: taller storeys, stacked flush): the upper floor's front-left edge runs
 * parallel above the lower floor's back walls and touches them, so the building reads as one
 * structure and the floors never cover each other (the other floors are dimmed, never hidden).
 * A floor's plate is as deep as its own rows, so a shallower floor above sits closer.
 */
import { ISO_FLOOR_GAP, ISO_HALF_H, ISO_HALF_W, ISO_SLAB_H, ISO_WALL_H } from '../../constants.js';
import { TileType } from '../../office/types.js';

export interface Pt {
  x: number;
  y: number;
}

/** A floor as a level of the building: its rows in the stacked layout. */
export interface IsoFloor {
  id: string;
  /** First layout row of the floor. */
  row: number;
  rows: number;
  /** 0 = floor 1, at the bottom. */
  level: number;
  /** First local row with anything in it: its back walls (the void rows above are no building). */
  top: number;
}

export interface IsoStack {
  floors: IsoFloor[];
  cols: number;
  /** The deepest floor's rows (the building's extent to the left). */
  depth: number;
  /** Iso px each level is raised above floor 1 (floor 1: 0). */
  lifts: number[];
  /** The building's bounds, iso px (walls and slabs included). */
  box: { x0: number; y0: number; x1: number; y1: number };
}

/** How a level is raised: `lifts[level]`, or `level × step` for a uniform step. */
export type Lift = number | readonly number[];
const liftOf = (lift: Lift, level: number) =>
  typeof lift === 'number' ? level * lift : (lift[level] ?? 0);

/** Iso px of the floor-plane point (col, row) (tiles, local to the floor) on `level`. */
export function isoAt(col: number, row: number, level: number, lift: Lift): Pt {
  return {
    x: (col - row) * ISO_HALF_W,
    y: (col + row) * ISO_HALF_H - liftOf(lift, level),
  };
}

/** The floor-plane point (tiles, local) on `level` under iso px (x, y): isoAt's inverse. */
export function isoInverse(
  x: number,
  y: number,
  level: number,
  lift: Lift,
): { col: number; row: number } {
  const a = x / ISO_HALF_W;
  const b = (y + liftOf(lift, level)) / ISO_HALF_H;
  return { col: (a + b) / 2, row: (b - a) / 2 };
}

/**
 * How far a floor of `rows` rows is raised above the floor below, whose back walls stand on
 * row `lowerTop` (its first row with anything): the upper floor's front-left edge (row `rows`,
 * and its slab) and the lower floor's back wall tops (a wall's base is two half diamonds down
 * from its row's back edge, its top ISO_WALL_H above the row line) run parallel; this puts them
 * together, `ISO_FLOOR_GAP` apart (none).
 */
export function levelRise(lowerTop: number, rows: number): number {
  return (rows - lowerTop) * 2 * ISO_HALF_H + ISO_WALL_H + ISO_SLAB_H + ISO_FLOOR_GAP;
}

/** The building for a layout: its floors as levels (one level for an office of one floor).
 *  `tileMap` (the layout's tile grid) tells each floor's first row with anything in it. */
export function isoStack(
  layout: { cols: number; rows: number; cldFloors?: unknown },
  tileMap?: ReadonlyArray<ReadonlyArray<number>>,
): IsoStack {
  const rects = Array.isArray(layout.cldFloors)
    ? (layout.cldFloors as Array<{ id: string; row: number; rows: number }>)
    : [];
  const rows: Array<{ id: string; row: number; rows: number }> =
    rects.length > 1 ? rects : [{ id: rects[0]?.id ?? '1', row: 0, rows: layout.rows }];
  const floors: IsoFloor[] = rows.map((r, level) => {
    let top = 0;
    if (tileMap)
      while (top < r.rows - 1 && !(tileMap[r.row + top] ?? []).some((t) => t !== TileType.VOID))
        top++;
    return { id: r.id, row: r.row, rows: r.rows, level, top };
  });
  const depth = Math.max(...floors.map((f) => f.rows));
  const lifts = [0];
  for (let k = 1; k < floors.length; k++)
    lifts.push(lifts[k - 1] + levelRise(floors[k - 1].top, floors[k].rows));
  const cols = layout.cols;
  const stack: IsoStack = {
    floors,
    cols,
    depth,
    lifts,
    box: { x0: 0, y0: 0, x1: 0, y1: 0 },
  };
  const boxes = floors.map((f) => floorBox(stack, f.level));
  stack.box = {
    x0: -depth * ISO_HALF_W,
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: cols * ISO_HALF_W,
    y1: Math.max(...boxes.map((b) => b.y1)),
  };
  return stack;
}

/** A floor's own bounds (iso px): its plate, its back walls and its slab. */
export function floorBox(stack: IsoStack, level: number): IsoStack['box'] {
  const lift = stack.lifts[level] ?? 0;
  const rows = stack.floors[level]?.rows ?? stack.depth;
  return {
    x0: -rows * ISO_HALF_W,
    x1: stack.cols * ISO_HALF_W,
    y0: -lift - ISO_WALL_H,
    y1: (stack.cols + rows) * ISO_HALF_H + ISO_SLAB_H - lift,
  };
}

/** The floor a layout row is on (null: between floors, or off the map). */
export function floorOfRow(stack: IsoStack, row: number): IsoFloor | null {
  return stack.floors.find((f) => row >= f.row && row < f.row + f.rows) ?? null;
}

/**
 * Device px of iso px (0, 0): the point `centre` (iso px) at the canvas centre at this zoom,
 * moved by the pan; whole device px, so every sprite lands on the pixel grid. The pan works
 * as the top-down camera's does (zoomAround keeps the point under the cursor).
 */
export function isoOrigin(canvas: { w: number; h: number }, centre: Pt, zoom: number, pan: Pt): Pt {
  return {
    x: Math.floor(canvas.w / 2) + Math.round(pan.x) - Math.round(centre.x * zoom),
    y: Math.floor(canvas.h / 2) + Math.round(pan.y) - Math.round(centre.y * zoom),
  };
}

/** The pan that puts iso px `target` at the canvas centre, for `isoOrigin` about `centre`. */
export function panTo(target: Pt, centre: Pt, zoom: number): Pt {
  return { x: (centre.x - target.x) * zoom, y: (centre.y - target.y) * zoom };
}

// ── Depth ────────────────────────────────────────────────────

/** What is sorted: a footprint on one floor (tiles, local; c1/r1 exclusive). */
export interface DepthBox {
  c0: number;
  r0: number;
  c1: number;
  r1: number;
  /** Height above the floor it stands at (a monitor on a desk): drawn after what it overlaps. */
  lift?: number;
}

/** Whether `a` is behind `b`: separated from it towards the back corner along an axis (and
 *  not in front of it along the other). The view looks along +col +row, so only a box
 *  further back can be covered by one further forward. */
export function behind(a: DepthBox, b: DepthBox): boolean {
  const aBack = a.c1 <= b.c0 || a.r1 <= b.r0;
  const bBack = b.c1 <= a.c0 || b.r1 <= a.r0;
  if (aBack !== bBack) return aBack;
  if (aBack) return false; // apart both ways: neither covers the other
  // Overlapping footprints (a monitor on its desk, someone on a chair): the higher one, then
  // the one whose centre is further forward.
  const la = a.lift ?? 0;
  const lb = b.lift ?? 0;
  if (la !== lb) return la < lb;
  return a.c0 + a.c1 + a.r0 + a.r1 < b.c0 + b.c1 + b.r0 + b.r1;
}

const key = (b: DepthBox) => b.c0 + b.c1 + b.r0 + b.r1 + (b.lift ?? 0) * 1e-3;

/**
 * Painter's order (back first) of footprints on one floor: a topological sort of `behind`,
 * ties and the rare cycle broken by the footprint's centre. O(n²): a floor holds a few
 * hundred pieces at most.
 */
export function depthOrder<T extends DepthBox>(items: readonly T[]): T[] {
  const n = items.length;
  const before: number[][] = Array.from({ length: n }, () => []); // j must come before i
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
  const done = new Array<boolean>(n).fill(false);
  const out: T[] = [];
  const keys = items.map(key);
  while (out.length < n) {
    let pick = -1;
    for (let i = 0; i < n; i++)
      if (!done[i] && waiting[i] === 0 && (pick < 0 || keys[i] < keys[pick])) pick = i;
    if (pick < 0)
      // A cycle: take the furthest back of what is left.
      for (let i = 0; i < n; i++) if (!done[i] && (pick < 0 || keys[i] < keys[pick])) pick = i;
    done[pick] = true;
    out.push(items[pick]);
    for (const j of before[pick]) waiting[j]--;
  }
  return out;
}

// ── Walls ────────────────────────────────────────────────────

/** A wall tile on a floor: tall when it is the building's back (nothing but void behind it
 *  towards the back corner along its column or its row), cut low otherwise so the rooms
 *  show. `faceRow`: it is a back wall running along the columns (its +row face is the room's
 *  side, where the windows go); `faceCol`: one running along the rows. */
export interface IsoWall {
  col: number;
  row: number;
  tall: boolean;
  faceRow: boolean;
  faceCol: boolean;
}

/** The wall tiles of `floor` (local coordinates), in rows then columns. */
export function floorWalls(
  tileMap: ReadonlyArray<ReadonlyArray<number>>,
  floor: IsoFloor,
): IsoWall[] {
  const cols = tileMap[0]?.length ?? 0;
  const at = (c: number, r: number) => tileMap[floor.row + r]?.[c] ?? TileType.VOID;
  const out: IsoWall[] = [];
  for (let r = 0; r < floor.rows; r++)
    for (let c = 0; c < cols; c++) {
      if (at(c, r) !== TileType.WALL) continue;
      let faceRow = true;
      for (let k = r - 1; k >= 0 && faceRow; k--) faceRow = at(c, k) === TileType.VOID;
      let faceCol = true;
      for (let k = c - 1; k >= 0 && faceCol; k--) faceCol = at(k, r) === TileType.VOID;
      out.push({ col: c, row: r, tall: faceRow || faceCol, faceRow, faceCol });
    }
  return out;
}
