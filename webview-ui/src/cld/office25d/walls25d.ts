/**
 * 2.5D PILOT walls: every wall tile drawn with a top (the cap, as wide as the tile) and, where
 * the floor is in front of it (no wall to the south), a front face that rises from the tile's
 * bottom edge. An outside wall (nothing walkable north of it: void or the map's edge) stands
 * taller and is glazed with the owner's night skyline; an inside wall keeps today's height
 * (it would otherwise hide whoever stands in the room behind it) and carries a lit wood panel
 * with a lamp every few columns, each lamp casting a light pool on the floor below.
 *
 * Same tiles, same depth key as today's walls ((row + 1) * 16): only the pictures differ, and
 * they ignore the floor's wall colour (the art has its own navy). Built once per tile map and
 * kept (a WeakMap on the map), so a frame costs what it did.
 */
import { WALL_25D, WALL_LAMP_POOL_DY } from '../../constants.js';
import type { FurnitureInstance, GroundDecal, SpriteData, TileType as TileTypeVal } from '../../office/types.js';
import { TILE_SIZE, TileType } from '../../office/types.js';

export interface WallArt {
  /** Seen through the outside windows, tiled across the wall (art px). */
  skyline: SpriteData;
  /** An inside wall's lit wood panel with its lamp. */
  lamp: SpriteData;
  /** The light pool under a lamp. */
  pool: SpriteData;
}

export interface Walls25d {
  walls: FurnitureInstance[];
  pools: Array<{ ground: GroundDecal }>;
}

const N = 1;
const E = 2;
const S = 4;
const W = 8;

const fill = (h: number, color: string): string[][] =>
  Array.from({ length: h }, () => new Array<string>(TILE_SIZE).fill(color));

/** The top of a wall, `h` rows: an edge line on each side with no wall beside it. */
function cap(h: number, mask: number): string[][] {
  const rows = fill(h, WALL_25D.cap);
  if (!(mask & N)) rows[0].fill(WALL_25D.capEdge);
  for (const row of rows) {
    if (!(mask & W)) row[0] = WALL_25D.capEdge;
    if (!(mask & E)) row[TILE_SIZE - 1] = WALL_25D.capEdge;
  }
  return rows;
}

/** An inside face: a lip under the cap, a panel seam on the tile's left, a shadow at the floor. */
function insideFace(mask: number, lamp: SpriteData | null): string[][] {
  const h = WALL_25D.insideFacePx;
  const rows = fill(h, WALL_25D.face);
  rows[0].fill(WALL_25D.lip);
  rows[1].fill(WALL_25D.lip2);
  for (let y = 2; y < h - 1; y++) rows[y][0] = WALL_25D.seam;
  rows[h - 1].fill(WALL_25D.shadow);
  if (lamp) {
    // The panel's own frame and lamp, under our lip (its first rows are a lip of their own).
    const skip = Math.max(0, lamp.length - (h - 1));
    const x0 = Math.floor((TILE_SIZE - (lamp[0]?.length ?? 0)) / 2);
    for (let y = 1; y < h; y++)
      lamp[y - 1 + skip]?.forEach((c, x) => {
        if (c) rows[y][x0 + x] = c;
      });
  }
  sides(rows, mask);
  return rows;
}

/** An outside face: a window of the skyline (sampled at the wall's world x, so it runs on across
 *  tiles), a mullion at each tile's left, a sill and a short wall under it. */
function outsideFace(mask: number, col: number, skyline: SpriteData): string[][] {
  const h = WALL_25D.outsideFacePx;
  const rows = fill(h, WALL_25D.face);
  rows[0].fill(WALL_25D.lip);
  rows[1].fill(WALL_25D.lip2);
  rows[2].fill(WALL_25D.frame);
  const glassTop = 3;
  const glassBottom = h - 9; // exclusive: then frame, sill, lip, wall, shadow
  const sh = skyline.length;
  const sw = skyline[0]?.length ?? 1;
  for (let y = glassTop; y < glassBottom; y++) {
    // The skyline's bottom on the sill; above its top, its top row (the sky) continues.
    const sy = Math.max(0, sh - (glassBottom - y));
    for (let x = 1; x < TILE_SIZE; x++)
      rows[y][x] = skyline[sy][(col * TILE_SIZE + x) % sw] || WALL_25D.frame;
    rows[y][0] = WALL_25D.frame;
  }
  rows[glassBottom].fill(WALL_25D.frame);
  rows[glassBottom + 1].fill(WALL_25D.lip);
  rows[glassBottom + 2].fill(WALL_25D.lip2);
  rows[h - 1].fill(WALL_25D.shadow);
  sides(rows, mask);
  return rows;
}

/** A dark edge down a face where it ends (a door gap or a corner beside it). */
function sides(rows: string[][], mask: number): void {
  for (const row of rows) {
    if (!(mask & W)) row[0] = WALL_25D.shadow;
    if (!(mask & E)) row[TILE_SIZE - 1] = WALL_25D.shadow;
  }
}

const sprites = new Map<string, SpriteData>();
const memo = (key: string, make: () => SpriteData): SpriteData => {
  let s = sprites.get(key);
  if (!s) {
    s = make();
    sprites.set(key, s);
  }
  return s;
};

const built = new WeakMap<object, Map<WallArt, Walls25d>>();

/** The 2.5D wall instances and lamp pools of `tileMap` (cached per map and art). */
export function walls25d(tileMap: TileTypeVal[][], art: WallArt): Walls25d {
  let byArt = built.get(tileMap);
  if (!byArt) {
    byArt = new Map();
    built.set(tileMap, byArt);
  }
  let out = byArt.get(art);
  if (!out) {
    out = build(tileMap, art);
    byArt.set(art, out);
  }
  return out;
}

function build(tileMap: TileTypeVal[][], art: WallArt): Walls25d {
  const rows = tileMap.length;
  const cols = rows > 0 ? tileMap[0].length : 0;
  const at = (c: number, r: number): number | undefined =>
    r < 0 || r >= rows || c < 0 || c >= cols ? undefined : tileMap[r][c];
  const wall = (c: number, r: number) => at(c, r) === TileType.WALL;
  const outside = (c: number, r: number) => {
    const t = at(c, r - 1);
    return t === undefined || t === TileType.VOID;
  };
  const front = (c: number, r: number) => wall(c, r) && !wall(c, r + 1);
  const floor = (c: number, r: number) => {
    const t = at(c, r);
    return t !== undefined && t !== TileType.WALL && t !== TileType.VOID;
  };
  const out: Walls25d = { walls: [], pools: [] };
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      if (!wall(c, r)) continue;
      const mask =
        (wall(c, r - 1) ? N : 0) | (wall(c + 1, r) ? E : 0) | (wall(c, r + 1) ? S : 0) | (wall(c - 1, r) ? W : 0);
      const tall = outside(c, r);
      const facePx = tall ? WALL_25D.outsideFacePx : WALL_25D.insideFacePx;
      let sprite: SpriteData;
      if (mask & S) {
        // A run going south: all top, lifted like the faces beside it.
        sprite = memo(`cap:${facePx}:${mask}`, () => cap(WALL_25D.capPx + facePx, mask));
      } else if (tall) {
        const k = (c * TILE_SIZE) % (art.skyline[0]?.length || 1);
        sprite = memo(`out:${mask}:${k}`, () => [...cap(WALL_25D.capPx, mask), ...outsideFace(mask, c, art.skyline)]);
      } else {
        const lamp =
          c % WALL_25D.lampEvery === 2 && front(c - 1, r) && front(c + 1, r) && floor(c, r + 1);
        sprite = memo(`in:${mask}:${lamp ? 1 : 0}`, () => [
          ...cap(WALL_25D.capPx, mask),
          ...insideFace(mask, lamp ? art.lamp : null),
        ]);
        if (lamp)
          out.pools.push({
            ground: {
              kind: 'light',
              preset: 'wall-lamp',
              sprite: art.pool,
              x: c * TILE_SIZE + TILE_SIZE / 2,
              y: (r + 1) * TILE_SIZE + WALL_LAMP_POOL_DY,
              w: TILE_SIZE,
            },
          });
      }
      out.walls.push({
        sprite,
        x: c * TILE_SIZE,
        y: (r + 1) * TILE_SIZE - sprite.length,
        zY: (r + 1) * TILE_SIZE,
      });
    }
  return out;
}
