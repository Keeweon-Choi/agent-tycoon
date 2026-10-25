/**
 * ISO-PILOT: which drawing of a character the isometric building uses.
 *
 * Facing (agreed with the owner 10-26): what faces the viewer uses the front row, what faces
 * away the back row, and the two diagonals of each are told apart by mirroring.
 *  - Today's 3-row sheets (front, back, right side; left = right mirrored): moving or sitting
 *    towards the lower right (+col, the world's RIGHT) draws the front row as it is, towards
 *    the lower left (+row, DOWN) the front row mirrored; towards the upper right (-row, UP)
 *    the back row as it is, towards the upper left (-col, LEFT) the back row mirrored. The
 *    side row is not used here.
 *  - Isometric-native 2-row sheets (three-quarter front facing the lower right, three-quarter
 *    back facing the upper right, the same 7 columns): the same rows, the same mirroring;
 *    they are simply drawn in their own three-quarter views. `sheetRows` tells the formats
 *    apart by the sheet's height.
 * The character system keeps its four world directions: only this module knows the camera.
 *
 * Density: the finest drawing that divides the zoom into whole device px, as the top-down
 * office draws; the character selected or followed (looked at) uses its sharpest drawing that
 * is not drawn smaller than its own pixels (owner 10-26: a custom character clicked, zoomed
 * or followed shows its sharpest sprite first).
 */
import type { CharacterSprites } from '../../office/sprites/spriteData.js';
import { spritesAtZoom } from '../../office/sprites/spriteData.js';
import type { Direction as DirectionVal, SpriteData } from '../../office/types.js';
import { Direction } from '../../office/types.js';

export function isoSprites(all: CharacterSprites, s: number, lookedAt: boolean): CharacterSprites {
  if (!lookedAt || !all.lods?.length) return spritesAtZoom(all, s);
  const byDensity = [all, ...all.lods].sort((a, b) => b.density - a.density);
  return byDensity.find((x) => x.density <= s) ?? byDensity[byDensity.length - 1];
}

/** The sheet row (0 front, 1 back) a world direction draws, and whether it is mirrored. */
export function isoFacing(dir: DirectionVal): { row: 0 | 1; mirror: boolean } {
  switch (dir) {
    case Direction.RIGHT:
      return { row: 0, mirror: false };
    case Direction.DOWN:
      return { row: 0, mirror: true };
    case Direction.UP:
      return { row: 1, mirror: false };
    default:
      return { row: 1, mirror: true };
  }
}

/** A sheet's format by its height: 2 rows (isometric three-quarter) or 3 (front, back, side). */
export function sheetRows(sheetHeight: number, frameHeight: number): 2 | 3 {
  return Math.round(sheetHeight / frameHeight) === 2 ? 2 : 3;
}

/** The top-down direction whose frames hold row `row` of either format (front: DOWN, back: UP). */
export const rowDirection = (row: 0 | 1): DirectionVal =>
  row === 0 ? Direction.DOWN : Direction.UP;

const flipped = new WeakMap<SpriteData, SpriteData>();
/** `sprite` mirrored left to right (cached per frame). */
export function mirrorSprite(sprite: SpriteData): SpriteData {
  let m = flipped.get(sprite);
  if (!m) {
    m = sprite.map((r) => [...r].reverse());
    flipped.set(sprite, m);
  }
  return m;
}

/** Frame `col` of a sheet given as rows of frames (2 or 3 rows), for a world direction. */
export function isoSheetFrame(rows: SpriteData[][], dir: DirectionVal, col: number): SpriteData {
  const f = isoFacing(dir);
  const frame = rows[f.row][col];
  return f.mirror ? mirrorSprite(frame) : frame;
}
