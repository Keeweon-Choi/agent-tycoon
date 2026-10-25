/**
 * 2.5D PILOT: off, furniture is placed as before; on, a mapped type wears its picture on the
 * same footprint (blocking unchanged), a PC on a 2.5D desk is drawn by the desk (off) or lights
 * its screen (on), chairs keep the seated character's depth rule, and the walls get a cap and a
 * face (taller and glazed outside, a lamp and its light pool inside).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { WALL_25D, WALL_COLOR } from '../../constants.js';
import { buildDynamicCatalog } from '../../office/layout/furnitureCatalog.js';
import { getBlockedTiles, layoutToFurnitureInstances } from '../../office/layout/layoutSerializer.js';
import { TILE_SIZE, TileType } from '../../office/types.js';
import { setOffice25d } from './office25d.js';
import { overlaySprite, setArt25d } from './skins.js';
import { walls25d } from './walls25d.js';

/** Test colours, one per piece: '#000001', '#000002', ... (a see-through one has alpha 80). */
const hex = (n: number, alpha = '') => `#${n.toString(16).padStart(6, '0')}${alpha}`;
const C = {
  desk: hex(1),
  lamp: hex(2),
  pool: hex(3, '80'),
  screen: hex(4),
  stool: hex(5),
  plant: hex(6),
  sky: hex(7),
  wood: hex(8),
  under: hex(9),
  glass: hex(10, '80'),
};
const sprite = (w: number, h: number, c = WALL_COLOR) =>
  Array.from({ length: h }, () => new Array<string>(w).fill(c));
const asset = (id: string, w: number, h: number, extra: object = {}) => ({
  id,
  label: id,
  category: 'decor',
  width: w,
  height: h,
  footprintW: Math.ceil(w / TILE_SIZE),
  footprintH: Math.ceil(h / TILE_SIZE),
  isDesk: false,
  ...extra,
});
buildDynamicCatalog({
  catalog: [
    asset('DESK_FRONT', 48, 32, { category: 'desks', isDesk: true }),
    asset('PC_FRONT_OFF', 16, 32, { category: 'electronics', canPlaceOnSurfaces: true }),
    asset('PC_FRONT_ON_1', 16, 32, { category: 'electronics', canPlaceOnSurfaces: true }),
    asset('CUSHIONED_BENCH', 16, 16, { category: 'chairs' }),
    asset('PLANT', 16, 32, { backgroundTiles: 1 }),
    asset('SMALL_TABLE_FRONT', 32, 32, { category: 'desks', isDesk: true }),
  ],
  sprites: {
    DESK_FRONT: sprite(48, 32),
    PC_FRONT_OFF: sprite(16, 32),
    PC_FRONT_ON_1: sprite(16, 32),
    CUSHIONED_BENCH: sprite(16, 16),
    PLANT: sprite(16, 32),
    SMALL_TABLE_FRONT: sprite(32, 32),
  },
});
setArt25d(
  new Map([
    ['reception-desk-monitor', sprite(43, 22, C.desk)],
    ['desk-lamp-gold', sprite(9, 13, C.lamp)],
    ['light-pool-a', sprite(19, 9, C.pool)],
    ['tv-dashboard', sprite(20, 13, C.screen)],
    ['stool-round-wood', sprite(10, 11, C.stool)],
    ['plant-monstera', sprite(11, 23, C.plant)],
    ['skyline-panel-night-a', sprite(41, 18, C.sky)],
    ['wall-wood-lit-narrow', sprite(8, 18, C.wood)],
  ]),
);

const office = [
  { uid: 'd', type: 'DESK_FRONT', col: 2, row: 3 },
  { uid: 'p', type: 'PC_FRONT_OFF', col: 3, row: 3 },
  { uid: 's', type: 'CUSHIONED_BENCH', col: 3, row: 5 },
  { uid: 'g', type: 'PLANT', col: 8, row: 3 },
  { uid: 't', type: 'SMALL_TABLE_FRONT', col: 10, row: 3 },
  { uid: 'q', type: 'PC_FRONT_OFF', col: 10, row: 3 },
];

afterEach(() => setOffice25d(false));

describe('2.5D pilot furniture', () => {
  it('off: every item as before', () => {
    const off = layoutToFurnitureInstances(office);
    expect(off).toHaveLength(office.length);
    expect(off[0]).toMatchObject({ x: 2 * TILE_SIZE, y: 3 * TILE_SIZE, zY: 5 * TILE_SIZE });
    expect(off.every((f) => f.sprite[0][0] === WALL_COLOR)).toBe(true);
  });

  it('on: the converted pictures on the same footprints, nothing else blocked', () => {
    const blocked = [...getBlockedTiles(office)].sort();
    setOffice25d(true);
    const on = layoutToFurnitureInstances(office);
    expect([...getBlockedTiles(office)].sort()).toEqual(blocked);
    // Desk, stool, plant, the plain table and the PC on it: the PC on the 2.5D desk is the desk's.
    expect(on).toHaveLength(office.length - 1);
    const [desk, stool, plant, table, pcOnTable] = on;
    const footX = 2 * TILE_SIZE + 24;
    const footY = 5 * TILE_SIZE;
    expect(desk).toMatchObject({ x: footX - 21, y: footY - 22, zY: footY });
    expect(desk.sprite[2][34]).toBe(C.lamp); // the lamp on the desk (at art px 34, 2)
    expect(desk.sprite[21][0]).toBe(C.desk);
    expect(desk.ground).toMatchObject({ kind: 'light', x: footX, y: footY });
    // Chairs keep their rule: a seated character (row 5) sorts after its stool.
    expect(stool.zY).toBe(6 * TILE_SIZE);
    expect(stool.sprite[0][0]).toBe(C.stool);
    // The plant stands on its foot; its top rises into the walkable row behind.
    expect(plant).toMatchObject({ y: 5 * TILE_SIZE - 23, zY: 5 * TILE_SIZE });
    expect(plant.ground).toMatchObject({ kind: 'shadow' });
    // No 2.5D picture for the small table: it, and the PC on it, stay as they were.
    expect(table.sprite[0][0]).toBe(WALL_COLOR);
    expect(pcOnTable.sprite[0][0]).toBe(WALL_COLOR);
  });

  it('on: a working PC lights the desk monitor, in front of the desk', () => {
    setOffice25d(true);
    const on = layoutToFurnitureInstances([office[0], { uid: 'p', type: 'PC_FRONT_ON_1', col: 3, row: 3 }]);
    const [desk, screen] = on;
    expect(screen.sprite).toHaveLength(5);
    expect(screen.sprite[0]).toHaveLength(8);
    expect(screen.x).toBe(desk.x + 25);
    expect(screen.y).toBe(desk.y + 7);
    expect(screen.zY).toBeGreaterThan(desk.zY);
  });

  it('overlays only over see-through px with see-through ones', () => {
    const out = overlaySprite([[C.under, '']], [[C.glass, C.glass]], 0, 0);
    expect(out).toEqual([[C.under, C.glass]]);
  });
});

describe('2.5D pilot walls', () => {
  const V = TileType.VOID;
  const W = TileType.WALL;
  const F = TileType.FLOOR_1;
  // An outside wall on top, an inside wall below the room, floor under it.
  const map = [
    [W, W, W, W, W, W, W],
    [W, F, F, F, F, F, W],
    [W, W, W, W, W, W, W],
    [V, F, F, F, F, F, V],
  ];
  const art = {
    skyline: sprite(41, 18, C.sky),
    lamp: sprite(8, 18, C.wood),
    pool: sprite(19, 9, C.pool),
  };
  const { walls, pools } = walls25d(map, art);
  const at = (c: number, r: number) => walls.find((w) => w.x === c * TILE_SIZE && w.zY === (r + 1) * TILE_SIZE)!;

  it('keeps the depth key and the bottom of every wall tile', () => {
    expect(walls).toHaveLength(map.flat().filter((t) => t === W).length);
    for (const w of walls) expect(w.y + w.sprite.length).toBe(w.zY);
  });

  it('stands an outside wall taller, glazed with the skyline; an inside one as tall as today', () => {
    const top = at(3, 0);
    expect(top.sprite).toHaveLength(WALL_25D.capPx + WALL_25D.outsideFacePx);
    expect(top.sprite.some((row) => row.includes(C.sky))).toBe(true);
    const inner = at(1, 2);
    expect(inner.sprite).toHaveLength(WALL_25D.capPx + WALL_25D.insideFacePx);
    expect(inner.sprite.some((row) => row.includes(C.sky))).toBe(false);
  });

  it('hangs a lamp on an inside wall with a light pool on the floor below it', () => {
    const lamp = at(2, 2);
    expect(lamp.sprite.some((row) => row.includes(C.wood))).toBe(true);
    expect(pools).toHaveLength(1);
    expect(pools[0].ground).toMatchObject({ x: 2 * TILE_SIZE + 8, sprite: art.pool });
    expect(pools[0].ground.y).toBeGreaterThan(3 * TILE_SIZE);
  });

  it('builds once per map', () => {
    expect(walls25d(map, art)).toBe(walls25d(map, art));
  });
});
