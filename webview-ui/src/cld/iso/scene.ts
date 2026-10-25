/**
 * ISO-PILOT: what each floor holds, as the isometric view draws it: its floor tiles, its walls
 * (tall at the building's back, cut low elsewhere), and its furniture with the blocked
 * footprint the walk grid already uses (a type's `backgroundTiles` top rows are where the
 * picture rises over the floor behind, not where it stands). Pure: built from the layout, the
 * tile grid, the furniture catalog and the art manifest, once per layout.
 */
import { ISO_LOW_WALL_ITEM_DROP } from '../../constants.js';
import type { SpriteData } from '../../office/types.js';
import { TileType } from '../../office/types.js';
import type { IsoManifest, PieceDef } from './art.js';
import type { DepthBox, IsoFloor, IsoStack, IsoWall } from './projection.js';
import { floorOfRow, floorWalls } from './projection.js';

/** What the scene needs to know of a furniture type (the catalog's entry). */
export interface CatalogInfo {
  footprintW: number;
  footprintH: number;
  backgroundTiles?: number;
  canPlaceOnWalls?: boolean;
  canPlaceOnSurfaces?: boolean;
  sprite: SpriteData;
}

/** A piece of furniture on a floor. Its box is the blocked footprint (local tiles). */
export interface IsoItem extends DepthBox {
  uid: string;
  type: string;
  /** Layout tile of its blocked footprint's back corner. */
  col: number;
  row: number;
  /** Its isometric piece (null: no piece yet, its top-down sprite stands in). */
  piece: PieceDef | null;
  mirror: boolean;
  /** Hung on a wall tile (drawn just in front of it). */
  onWall: boolean;
  /** Iso px it is drawn lower than it stands (a board on a cut-away wall). */
  drop: number;
  sprite: SpriteData;
}

export interface IsoFloorScene {
  floor: IsoFloor;
  /** Floor tiles (local) and the piece each wears. */
  tiles: Array<{ col: number; row: number; piece: string }>;
  walls: IsoWall[];
  items: IsoItem[];
}

/** The piece a furniture type wears (mirrored: footprint turned, picture flipped). */
export function pieceFor(
  manifest: IsoManifest,
  type: string,
): { name: string; piece: PieceDef; mirror: boolean } | null {
  const t = manifest.types[type];
  const piece = t && manifest.pieces[t.piece];
  return piece ? { name: t.piece, piece, mirror: !!t.mirror } : null;
}

const lowWall = (s: IsoFloorScene, col: number, row: number) =>
  s.walls.some((w) => w.col === col && w.row === row && !w.tall);

export function buildScene(
  stack: IsoStack,
  tileMap: ReadonlyArray<ReadonlyArray<number>>,
  furniture: ReadonlyArray<{ uid: string; type: string; col: number; row: number }>,
  catalog: (type: string) => CatalogInfo | undefined,
  manifest: IsoManifest,
): IsoFloorScene[] {
  const scenes: IsoFloorScene[] = stack.floors.map((floor) => {
    const tiles: IsoFloorScene['tiles'] = [];
    for (let r = 0; r < floor.rows; r++)
      for (let c = 0; c < stack.cols; c++) {
        const t = tileMap[floor.row + r]?.[c] ?? TileType.VOID;
        if (t === TileType.VOID || t === TileType.WALL) continue;
        tiles.push({
          col: c,
          row: r,
          piece: manifest.floors[String(t)] ?? manifest.floors.default,
        });
      }
    return { floor, tiles, walls: floorWalls(tileMap, floor), items: [] };
  });
  const isWall = (c: number, r: number) => tileMap[r]?.[c] === TileType.WALL;
  for (const f of furniture) {
    const entry = catalog(f.type);
    if (!entry) continue;
    const bg = Math.min(entry.backgroundTiles ?? 0, entry.footprintH - 1);
    // A wall item whose bottom row is in a wall hangs on it; anything else stands on the
    // rows it blocks.
    const bottom = f.row + entry.footprintH - 1;
    const onWall = !!entry.canPlaceOnWalls && isWall(f.col, bottom);
    const top = onWall ? bottom : f.row + bg;
    const floor = floorOfRow(stack, top);
    if (!floor) continue;
    if (manifest.types[f.type]?.piece === 'none') continue; // drawn as part of another piece
    const found = pieceFor(manifest, f.type);
    scenes[floor.level].items.push({
      uid: f.uid,
      type: f.type,
      col: f.col,
      row: top,
      c0: f.col,
      r0: top - floor.row,
      c1: f.col + entry.footprintW,
      r1: bottom + 1 - floor.row,
      lift: onWall ? 1 : 0,
      // On a cut-away wall it rests on the wall's top instead of hanging at eye height.
      drop:
        onWall && lowWall(scenes[floor.level], f.col, bottom - floor.row)
          ? ISO_LOW_WALL_ITEM_DROP
          : 0,
      piece: found?.piece ?? null,
      mirror: found?.mirror ?? false,
      onWall,
      sprite: entry.sprite,
    });
  }
  // What stands on a surface (a monitor on a desk, a machine on a counter) is lifted onto it.
  for (const s of scenes)
    for (const it of s.items) {
      if (!catalog(it.type)?.canPlaceOnSurfaces) continue;
      const under = s.items.find(
        (o) =>
          o !== it &&
          o.piece?.surface &&
          it.c0 >= o.c0 &&
          it.c1 <= o.c1 &&
          it.r0 >= o.r0 &&
          it.r1 <= o.r1,
      );
      if (under) it.lift = under.piece!.surface! / under.piece!.density;
    }
  return scenes;
}
