import { beforeAll, describe, expect, it } from 'vitest';

import { ELEVATOR_DOOR_WAIT_SEC } from '../constants.js';
import { OfficeState } from '../office/engine/officeState.js';
import type { LoadedAssetData } from '../office/layout/furnitureCatalog.js';
import { buildDynamicCatalog } from '../office/layout/furnitureCatalog.js';
import { findPath } from '../office/layout/tileMap.js';
import { type Character, type OfficeLayout, TILE_SIZE, TileType } from '../office/types.js';
import {
  elevatorFrames,
  elevatorLinks,
  elevatorState,
  findElevators,
  LOUNGE_SUFFIX,
  rideStep,
  visitFloor,
} from './elevator.js';
import { floorIndexAt, floorRects } from './walk.js';

beforeAll(() => {
  const chair: LoadedAssetData['catalog'][number] = {
    id: 'CHAIR',
    label: 'CHAIR',
    category: 'chairs',
    width: 16,
    height: 16,
    footprintW: 1,
    footprintH: 1,
    isDesk: false,
  };
  expect(buildDynamicCatalog({ catalog: [chair], sprites: { CHAIR: [['']] } })).toBe(true);
});

const COLS = 9;
const ROWS = 7;
/** A walled room (9x7) with a door in the bottom wall (col 4). */
const room = () =>
  Array.from({ length: COLS * ROWS }, (_, i) => {
    const c = i % COLS;
    const r = Math.floor(i / COLS);
    const edge = c === 0 || r === 0 || c === COLS - 1 || r === ROWS - 1;
    return edge && !(r === ROWS - 1 && c === 4) ? TileType.WALL : TileType.FLOOR_1;
  });

/** Two floors of room(), two void rows apart (the daemon's FLOOR_GAP); floor 1 on top. `top`:
 *  floor 1 is this many rows taller (its rows grow when a room moves in). */
function building(seats: Array<{ uid: string; col: number; row: number }>, top = 0): OfficeLayout {
  const gap = new Array(COLS * 2).fill(TileType.VOID);
  const extra = Array.from({ length: COLS * top }, () => TileType.FLOOR_1);
  const one = room();
  const first = [...one.slice(0, COLS), ...extra, ...one.slice(COLS)];
  const rows1 = ROWS + top;
  return {
    version: 1,
    cols: COLS,
    rows: rows1 + 2 + ROWS,
    tiles: [...first, ...gap, ...room()],
    furniture: seats.map((s) => ({ uid: s.uid, type: 'CHAIR', col: s.col, row: s.row })),
    cldFloors: [
      { id: '1', row: 0, rows: rows1, cols: COLS },
      { id: '2', row: rows1 + 2, rows: ROWS, cols: COLS },
    ],
  } as OfficeLayout;
}
const F2 = ROWS + 2; // floor 2's first row

const floorOf = (os: OfficeState, ch: Character) =>
  floorIndexAt(floorRects(os.getLayout())!, ch.tileRow);

/** Run the office `s` seconds; what each frame looked like. */
function run(os: OfficeState, id: number, s: number, untilWalked = false) {
  const seen = { hidden: false, doorsOpened: false, onVoid: false };
  for (let t = 0; t < s; t += 0.05) {
    const c = os.characters.get(id)!;
    // An idle one wanders off once there (anywhere: no wander hook here).
    if (untilWalked && seen.hidden && !c.cldRide && !c.path.length) break;
    os.update(0.05);
    const ch = os.characters.get(id)!;
    seen.hidden ||= !!ch.cldRide?.hidden;
    seen.doorsOpened ||= os.cldElevators!.some((e) => e.open >= 1);
    const drawn = !ch.cldRide?.hidden;
    const row = Math.floor(ch.y / TILE_SIZE);
    if (drawn && os.tileMap[row]?.[Math.floor(ch.x / TILE_SIZE)] === TileType.VOID)
      seen.onVoid = true;
  }
  return seen;
}

describe('the elevator (ELEVATOR)', () => {
  it('keeps an ordinary no-link path byte-for-byte as the four-way BFS returned it', () => {
    const layout = building([]);
    const os = new OfficeState(layout);
    os.rebuildFromLayout(layout);
    expect(findPath(2, 3, 6, 3, os.tileMap, os.blockedTiles)).toEqual([
      { col: 3, row: 3 },
      { col: 4, row: 3 },
      { col: 5, row: 3 },
      { col: 6, row: 3 },
    ]);
  });

  it('stands in the top wall of each floor, and only it links the floors for the pathfinder', () => {
    const layout = building([]);
    const os = new OfficeState(layout);
    os.rebuildFromLayout(layout);
    const els = os.cldElevators!;
    expect(els.map((e) => [e.floor, e.row, e.front.row])).toEqual([
      ['1', 0, 1],
      ['2', F2, F2 + 1],
    ]);
    // Without the links there is no way between floors; with them, one step is the ride.
    expect(findPath(2, 3, 2, F2 + 3, os.tileMap, os.blockedTiles)).toEqual([]);
    const path = findPath(2, 3, 2, F2 + 3, os.tileMap, os.blockedTiles, elevatorLinks(els));
    const jumps = path.filter(
      (t, i) =>
        Math.abs(t.col - (path[i - 1]?.col ?? 2)) + Math.abs(t.row - (path[i - 1]?.row ?? 3)) > 1,
    );
    expect(jumps).toEqual([els[1].front]);
    expect(path[path.indexOf(jumps[0]) - 1]).toEqual(els[0].front);
    // Every tile of the path but the ride is walkable floor: never through a wall or the void.
    expect(path.every((t) => os.tileMap[t.row][t.col] === TileType.FLOOR_1)).toBe(true);
  });

  it('a walk to another floor rides: doors open, the car hides it, it comes out upstairs and walks on', () => {
    const layout = building([]);
    const os = new OfficeState(layout);
    os.rebuildFromLayout(layout);
    os.addAgent(1, 0, 0, undefined, true);
    const ch = os.characters.get(1)!;
    Object.assign(ch, {
      tileCol: 2,
      tileRow: 3,
      x: 40,
      y: 56,
      isActive: false,
      currentTool: 'keep this task',
      palette: 3,
      hueShift: 45,
    });
    expect(os.walkToTile(1, 6, F2 + 4)).toBe(true);
    const seen = run(os, 1, 12, true);
    expect(seen).toEqual({ hidden: true, doorsOpened: true, onVoid: false });
    expect([ch.tileCol, ch.tileRow]).toEqual([6, F2 + 4]);
    expect(ch.cldRide).toBeUndefined();
    expect(os.cldElevators!.every((e) => e.open === 0)).toBe(true); // shut again
    expect(os.cldElevators![0].instance.sprite).toBe(elevatorFrames()[0]);
    expect(os.getCharacters().map((c) => c.id)).toEqual([1]);
    expect({
      active: ch.isActive,
      task: ch.currentTool,
      palette: ch.palette,
      hue: ch.hueShift,
    }).toEqual({
      active: false,
      task: 'keep this task',
      palette: 3,
      hue: 45,
    });
  });

  it('never traps a rider when a door does not open, preserving its task and look', () => {
    const layout = building([]);
    const os = new OfficeState(layout);
    os.rebuildFromLayout(layout);
    os.addAgent(1, 0, 0, undefined, true);
    const ch = os.characters.get(1)!;
    const [from, to] = os.cldElevators!;
    Object.assign(ch, {
      tileCol: from.front.col,
      tileRow: from.front.row,
      path: [{ ...to.front }],
      state: 'walk',
      currentTool: 'keep this task',
      palette: 3,
      hueShift: 45,
    });
    expect(rideStep(ch, ELEVATOR_DOOR_WAIT_SEC + 0.01, os.cldElevators)).toBe(false);
    expect({ ride: ch.cldRide, path: ch.path, at: [ch.tileCol, ch.tileRow] }).toEqual({
      ride: undefined,
      path: [],
      at: [from.front.col, from.front.row],
    });
    expect({ task: ch.currentTool, palette: ch.palette, hue: ch.hueShift }).toEqual({
      task: 'keep this task',
      palette: 3,
      hue: 45,
    });
  });

  it('makes a hidden rider visible again when its destination floor is removed', () => {
    const layout = building([{ uid: 'seat:a', col: 2, row: 4 }]);
    const os = new OfficeState(layout);
    os.rebuildFromLayout(layout);
    os.addAgent(1, 0, 0, 'seat:a', true);
    const ch = os.characters.get(1)!;
    os.setAgentActive(1, false);
    expect(os.walkToTile(1, 6, F2 + 4)).toBe(true);
    for (let t = 0; t < 10 && ch.cldRide?.phase !== 'travel'; t += 0.05) os.update(0.05);
    expect(ch.cldRide?.hidden).toBe(true);
    const oneFloor = {
      ...layout,
      rows: ROWS,
      tiles: layout.tiles.slice(0, COLS * ROWS),
      cldFloors: [{ id: '1', row: 0, rows: ROWS, cols: COLS }],
    };
    os.rebuildFromLayout(oneFloor);
    expect(ch.cldRide).toBeUndefined();
    expect(os.getCharacters().map((c) => c.id)).toEqual([1]);
    expect([ch.tileCol, ch.tileRow]).toEqual([2, 4]);
  });

  it('the same office sent again (or an office whose floors did not move) leaves a ride going', () => {
    const layout = building([]);
    const os = new OfficeState(layout);
    os.rebuildFromLayout(layout);
    os.addAgent(1, 0, 0, undefined, true);
    const ch = os.characters.get(1)!;
    Object.assign(ch, { tileCol: 2, tileRow: 3, x: 40, y: 56, isActive: false });
    expect(os.walkToTile(1, 6, F2 + 4)).toBe(true);
    for (let t = 0; t < 10 && !ch.cldRide?.hidden; t += 0.05) os.update(0.05);
    expect(ch.cldRide?.hidden).toBe(true);
    // What a renderer reads: the doors per floor, who is in the car and between which floors.
    expect(elevatorState(os)).toMatchObject({
      floors: [{ floor: '1' }, { floor: '2' }],
      riders: [{ id: 1, from: '1', to: '2', inside: true }],
    });
    os.rebuildFromLayout(layout); // e.g. the furniture catalog arrived
    os.rebuildFromLayout({ ...layout }); // or the daemon sent the office again
    expect(ch.cldRide?.hidden).toBe(true);
    // Until the walk ends (an idle one then wanders off, anywhere: no wander hook here).
    for (let t = 0; t < 10 && (ch.cldRide || ch.path.length); t += 0.05) os.update(0.05);
    expect([ch.tileCol, ch.tileRow]).toEqual([6, F2 + 4]);
  });

  it('nothing moves when nobody rides: the doors stay shut and the office asks for no frames', () => {
    const layout = building([]);
    const os = new OfficeState(layout);
    os.rebuildFromLayout(layout);
    os.update(0.05);
    expect(os.isAnimating()).toBe(false);
    expect(os.cldElevators!.every((e) => e.open === 0)).toBe(true);
  });

  it('a room moved to another floor: its character rides to the new seat, the others stay', () => {
    const before = building([
      { uid: 'seat:a', col: 2, row: 4 },
      { uid: 'seat:b', col: 6, row: 4 },
    ]);
    const os = new OfficeState(before);
    os.rebuildFromLayout(before);
    os.addAgent(1, 0, 0, 'seat:a', true);
    os.addAgent(2, 0, 0, 'seat:b', true);
    // Room a goes upstairs; floor 1 grows by a row (its rows moved floor 2 down).
    const after = building(
      [
        { uid: 'seat:a', col: 3, row: F2 + 1 + 4 },
        { uid: 'seat:b', col: 6, row: 5 },
      ],
      1,
    );
    os.rebuildFromLayout(after);
    const a = os.characters.get(1)!;
    const b = os.characters.get(2)!;
    expect(floorOf(os, a)).toBe(0); // not put there: it goes
    expect([b.tileCol, b.tileRow]).toEqual([6, 5]); // its own floor: seated at once
    const seen = run(os, 1, 15);
    expect(seen.hidden).toBe(true);
    expect(seen.onVoid).toBe(false);
    expect([a.tileCol, a.tileRow]).toEqual([3, F2 + 5]);
    expect(a.seatId).toBe('seat:a');
  });

  it('its floor shrank under it (its room left): it stays on its floor and rides up', () => {
    const before = building([{ uid: 'seat:a', col: 2, row: 8 }], 3); // floor 1 is 10 rows
    const os = new OfficeState(before);
    os.rebuildFromLayout(before);
    os.addAgent(1, 0, 0, 'seat:a', true);
    // Floor 1 back to 7 rows: row 8 is now in the gap, floor 2 starts at row 9.
    const after = building([{ uid: 'seat:a', col: 3, row: F2 + 4 }]);
    os.rebuildFromLayout(after);
    const a = os.characters.get(1)!;
    expect(floorOf(os, a)).toBe(0);
    expect(run(os, 1, 15).hidden).toBe(true);
    expect([a.tileCol, a.tileRow]).toEqual([3, F2 + 4]);
  });

  it('dropped on another floor it visits there, its seat kept, and its next work brings it home', () => {
    const layout = building([{ uid: 'seat:a', col: 2, row: 4 }]);
    const os = new OfficeState(layout);
    os.rebuildFromLayout(layout);
    os.addAgent(1, 0, 0, 'seat:a', true);
    os.setAgentActive(1, false);
    const ch = os.characters.get(1)!;
    expect(visitFloor(os, 1, '1')).toBe(false); // its own floor: as before
    expect(visitFloor(os, 1, '2')).toBe(true);
    run(os, 1, 40); // there, and it wanders there (no ride home for a rest)
    expect(floorOf(os, ch)).toBe(1);
    expect(ch.seatId).toBe('seat:a');
    expect(ch.cldVisit?.arrived).toBe(true);
    os.setAgentActive(1, true);
    run(os, 1, 15);
    expect(ch.cldVisit).toBeUndefined();
    expect([ch.tileCol, ch.tileRow]).toEqual([2, 4]);
  });

  it('a working character dropped on another floor sits at a free seat there, and is called back', () => {
    const layout = building([
      { uid: 'seat:a', col: 2, row: 4 },
      { uid: 'spare', col: 5, row: F2 + 4 },
    ]);
    const os = new OfficeState(layout);
    os.rebuildFromLayout(layout);
    os.addAgent(1, 0, 0, 'seat:a', true);
    const ch = os.characters.get(1)!;
    expect(visitFloor(os, 1, '2')).toBe(true);
    run(os, 1, 15);
    expect([ch.seatId, ch.tileCol, ch.tileRow]).toEqual(['spare', 5, F2 + 4]);
    // What the page saves for a reload is its own seat, not the borrowed one.
    expect(os.getPersistableSeats()[1].seatId).toBe('seat:a');
    expect(visitFloor(os, 1, '1')).toBe(true); // dropped back on its own floor
    run(os, 1, 15);
    expect([ch.seatId, ch.tileCol, ch.tileRow]).toEqual(['seat:a', 2, 4]);
    expect(os.seats.get('spare')!.assigned).toBe(false);
  });
});

describe('the building core: one elevator tile on every floor', () => {
  const W = TileType.WALL;
  const F = TileType.FLOOR_1;
  const V = TileType.VOID;
  /** Three floors of 12x6 (a void row on top, walls at row 1, free floor under them), a void
   *  row between. `lounge`: the columns of each floor's lounge (its own, as the generator
   *  puts it after the work rooms); `shut`: wall tiles of floor k's back wall that furniture
   *  blocks. */
  function stacked(lounges: number[], shut: Array<[number, number]> = []) {
    const cols = 12;
    const rows = 6;
    const gap = 1;
    const tileMap: TileType[][] = [];
    const areaTiles: Array<string | null> = [];
    const blocked = new Set<string>();
    const cldFloors = lounges.map((_, k) => ({
      id: String(k + 1),
      row: k * (rows + gap),
      rows,
      cols,
    }));
    lounges.forEach((l, k) => {
      for (let r = 0; r < rows; r++) {
        const row: TileType[] = [];
        for (let c = 0; c < cols; c++) {
          const edge = r === 1 || r === rows - 1 || c === 0 || c === cols - 1;
          row.push(r === 0 ? V : edge ? W : F);
          areaTiles.push(r > 1 && !edge && c >= l && c < l + 4 ? `${k}${LOUNGE_SUFFIX}` : null);
        }
        tileMap.push(row);
      }
      if (k < lounges.length - 1) {
        tileMap.push(new Array(cols).fill(V));
        for (let c = 0; c < cols; c++) areaTiles.push(null);
      }
    });
    for (const [k, c] of shut) blocked.add(`${c},${cldFloors[k].row + 1}`);
    return { layout: { cols, areaTiles, cldFloors }, tileMap, blocked, cldFloors };
  }

  it("puts every floor's elevator on the same column and local row, whatever its lounge", () => {
    const s = stacked([1, 6, 3]);
    const els = findElevators(s.layout, s.tileMap, s.blocked)!;
    expect(els).toHaveLength(3);
    expect(new Set(els.map((e) => e.col)).size).toBe(1);
    expect(new Set(els.map((e, k) => e.row - s.cldFloors[k].row)).size).toBe(1);
    // On the back wall (row 1 of the floor), its front a free tile below.
    expect(els[0].row).toBe(1);
    expect(els.map((e) => e.front.row - e.row)).toEqual([1, 1, 1]);
  });

  it("moves the core to a tile every floor has when one floor's wall is blocked there", () => {
    const first = stacked([1, 1, 1]);
    const col = findElevators(first.layout, first.tileMap, first.blocked)![0].col;
    const s = stacked(
      [1, 1, 1],
      [
        [1, col],
        [1, col + 1],
      ],
    );
    const els = findElevators(s.layout, s.tileMap, s.blocked)!;
    expect(new Set(els.map((e) => e.col)).size).toBe(1);
    // Not a pair that uses the blocked tiles of floor 2.
    expect(Math.abs(els[1].col - col)).toBeGreaterThan(1);
  });

  it("falls back to each floor's own best when no tile suits them all", () => {
    // Floor 2's whole back wall is blocked: it must use a row below; the others keep the back wall.
    const s = stacked(
      [1, 1],
      Array.from({ length: 12 }, (_, c) => [1, c] as [number, number]),
    );
    const els = findElevators(s.layout, s.tileMap, s.blocked)!;
    // Floor 2 has no wall pair free on row 1; the elevator is on its front wall row or none.
    expect(els[0].row - s.cldFloors[0].row).toBe(1);
    expect(els.length === 1 || els[1].row - s.cldFloors[1].row > 1).toBe(true);
  });
});
