import { describe, expect, it } from 'vitest';

import { ISO_LOW_WALL_ITEM_DROP, WALL_COLOR } from '../../constants.js';
import { TileType } from '../../office/types.js';
import type { IsoManifest } from './art.js';
import { isoStack } from './projection.js';
import { buildScene, type CatalogInfo } from './scene.js';

const W = TileType.WALL;
const F = TileType.FLOOR_1;
const V = TileType.VOID;
const sprite = [[WALL_COLOR]];
const catalog: Record<string, CatalogInfo> = {
  DESK_FRONT: { footprintW: 3, footprintH: 2, backgroundTiles: 1, sprite },
  PC_FRONT_OFF: {
    footprintW: 1,
    footprintH: 2,
    backgroundTiles: 1,
    canPlaceOnSurfaces: true,
    sprite,
  },
  COFFEE: { footprintW: 1, footprintH: 1, canPlaceOnSurfaces: true, sprite },
  SMALL_TABLE_FRONT: { footprintW: 2, footprintH: 2, backgroundTiles: 1, sprite },
  WHITEBOARD: { footprintW: 2, footprintH: 2, canPlaceOnWalls: true, sprite },
  STATUE: { footprintW: 1, footprintH: 1, sprite },
};
const piece = (fw: number, fh: number, surface?: number) => ({
  file: 'x.png',
  density: 4,
  footprint: [fw, fh] as [number, number],
  anchor: [0, 0] as [number, number],
  faces: 'none' as const,
  ...(surface !== undefined && { surface }),
});
const manifest: IsoManifest = {
  floors: { default: 'floor-a', '1': 'floor-b' },
  walls: {
    row: { piece: '' },
    col: { piece: '' },
    window: { piece: '', gap: 0 },
    corner: '',
    low: '',
  },
  lift: { doors: '', doorsOpen: '' },
  pieces: {
    desk: piece(3, 1, 48),
    counter: piece(2, 1, 52),
    board: piece(2, 1),
    machine: piece(1, 1),
  },
  types: {
    DESK_FRONT: { piece: 'desk' },
    PC_FRONT_OFF: { piece: 'none' },
    SMALL_TABLE_FRONT: { piece: 'counter' },
    COFFEE: { piece: 'machine' },
    WHITEBOARD: { piece: 'board' },
  },
  facings: {},
};

// Two floors of a 7-column office, two void rows between them:
//   floor 1 rows 0-4: a back wall, a room, a cut wall across it, its front wall
//   floor 2 rows 7-10
const map = [
  [W, W, W, W, W, W, W],
  [W, F, F, F, F, F, W],
  [W, F, F, F, F, F, W],
  [W, W, W, W, F, F, W],
  [W, F, F, F, F, F, W],
  [V, V, V, V, V, V, V],
  [V, V, V, V, V, V, V],
  [W, W, W, W, W, W, W],
  [W, F, F, F, F, F, W],
  [W, F, F, F, F, F, W],
  [W, W, W, W, W, W, W],
];
const layout = {
  cols: 7,
  rows: 11,
  cldFloors: [
    { id: '1', row: 0, rows: 5, cols: 7 },
    { id: '2', row: 7, rows: 4, cols: 7 },
  ],
};

describe('iso scene', () => {
  const stack = isoStack(layout);
  const scenes = buildScene(
    stack,
    map,
    [
      { uid: 'desk', type: 'DESK_FRONT', col: 1, row: 0 },
      { uid: 'pc', type: 'PC_FRONT_OFF', col: 2, row: 0 },
      { uid: 'counter', type: 'SMALL_TABLE_FRONT', col: 2, row: 7 },
      { uid: 'machine', type: 'COFFEE', col: 3, row: 8 },
      { uid: 'wb-high', type: 'WHITEBOARD', col: 2, row: -1 },
      { uid: 'wb-low', type: 'WHITEBOARD', col: 1, row: 2 },
      { uid: 'statue', type: 'STATUE', col: 4, row: 9 },
    ],
    (t) => catalog[t],
    manifest,
  );
  const item = (uid: string) => scenes.flatMap((s) => s.items).find((i) => i.uid === uid);

  it("puts furniture on the floor its blocked rows are on, in that floor's own rows", () => {
    expect(scenes[0].items.map((i) => i.uid)).toContain('desk');
    expect(scenes[1].items.map((i) => i.uid)).toEqual(['counter', 'machine', 'statue']);
    // The desk's top row is where its picture rises over the wall: it blocks row 1 only.
    expect(item('desk')).toMatchObject({ c0: 1, r0: 1, c1: 4, r1: 2 });
    expect(item('counter')).toMatchObject({ r0: 1, r1: 2 }); // local to floor 2
  });

  it('leaves out what another piece draws, lifts what stands on a surface, stands in the rest', () => {
    expect(item('pc')).toBeUndefined(); // the desk piece has its monitor
    expect(item('machine')?.lift).toBe(52 / 4); // on the counter, in iso px
    expect(item('statue')?.piece).toBeNull(); // no piece yet: its top-down sprite stands in
  });

  it('hangs a board on a tall back wall, and rests it on a cut-away wall', () => {
    expect(item('wb-high')).toMatchObject({ onWall: true, r0: 0, drop: 0 });
    expect(item('wb-low')).toMatchObject({ onWall: true, r0: 3, drop: ISO_LOW_WALL_ITEM_DROP });
  });

  it('gives every floor tile its material and keeps walls apart', () => {
    expect(scenes[0].tiles).toHaveLength(5 + 5 + 2 + 5);
    expect(new Set(scenes[0].tiles.map((t) => t.piece))).toEqual(new Set(['floor-b']));
    expect(scenes[0].walls.filter((w) => w.tall).map((w) => `${w.col},${w.row}`)).toContain('3,0');
  });
});
