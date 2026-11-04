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
 * CHAR-8DIR: a character with both kinds of sheet faces 8 screen directions (characterView).
 * DIAG-1104: so do the built-in people and the mascots, whose three-quarter walk only walks and
 * stands (drawnView).
 *
 * Density: as the top-down office draws (spritesAtZoom): a detailed character (64×128 and up)
 * draws its one master at every zoom, so clicked, zoomed or followed it is always at its
 * sharpest (owner 10-26).
 */
import { deriveSmooth } from '../../office/sprites/smoothSprite.js';
import { isoPaletteOf } from '../../office/sprites/spriteData.js';
import type { Character, Direction as DirectionVal, SpriteData } from '../../office/types.js';
import { CharacterState, Direction } from '../../office/types.js';

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

/**
 * CHAR-8DIR: what a character draws in either view: the palette (its top view's, or `isoPalette`,
 * the isometric sheet's), the direction whose frames, mirrored or not. A character with both kinds
 * of sheet (a 5-row sheet, or a top view with an isometric sheet beside it: `isoPalette` is not its
 * own) faces 8 screen directions: a screen diagonal draws the three-quarter rows (isoFacing: lower
 * right the front, lower left it mirrored, upper right the back, upper left it mirrored), straight
 * down, up, right and left the top view's front, back, side and mirrored side. It faces its last
 * step when that was diagonal (standing it keeps that; seated it faces its seat), else `dir`; the
 * isometric camera turns the world an eighth (a world step right is the screen's lower right).
 * Any other character keeps its four views: `dir` in the top-down view, isoFacing in the isometric.
 */
export function characterView(
  ch: Pick<Character, 'dir' | 'state' | 'palette' | 'cldDiagRow'>,
  iso: boolean,
  isoPalette: number,
): { palette: number; dir: DirectionVal; mirror: boolean } {
  const threeQuarter = (dir: DirectionVal) => {
    const f = isoFacing(dir);
    return { palette: isoPalette, dir: rowDirection(f.row), mirror: f.mirror };
  };
  if (isoPalette === ch.palette)
    return iso ? threeQuarter(ch.dir) : { palette: ch.palette, dir: ch.dir, mirror: false };
  // its world step (column, row); seated it faces its seat, never a diagonal
  const across = ch.dir === Direction.RIGHT ? 1 : ch.dir === Direction.LEFT ? -1 : 0;
  const dr = across
    ? ch.state === CharacterState.TYPE
      ? 0
      : (ch.cldDiagRow ?? 0)
    : ch.dir === Direction.DOWN
      ? 1
      : -1;
  const [sx, sy] = iso ? [Math.sign(across - dr), Math.sign(across + dr)] : [across, dr];
  if (sx && sy)
    return threeQuarter(
      sy > 0 ? (sx > 0 ? Direction.RIGHT : Direction.DOWN) : sx > 0 ? Direction.UP : Direction.LEFT,
    );
  const dir =
    sy > 0 ? Direction.DOWN : sy < 0 ? Direction.UP : sx > 0 ? Direction.RIGHT : Direction.LEFT;
  return { palette: ch.palette, dir, mirror: false };
}

/** What the office draws `ch` in (both views and the test hooks): characterView with the sheet
 *  beside its own; DIAG-1104: a walk-only one (a built-in person's or a mascot's three-quarter
 *  walk) only while it walks or stands, seated or `drinking` it keeps its four views. */
export const drawnView = (
  ch: Pick<Character, 'dir' | 'state' | 'palette' | 'cldDiagRow'>,
  iso: boolean,
  drinking: boolean,
) => characterView(ch, iso, isoPaletteOf(ch.palette, ch.state === CharacterState.TYPE || drinking));

const flipped = new WeakMap<SpriteData, SpriteData>();
/** `sprite` mirrored left to right (cached per frame). */
export function mirrorSprite(sprite: SpriteData): SpriteData {
  let m = flipped.get(sprite);
  if (!m) {
    m = sprite.map((r) => [...r].reverse());
    deriveSmooth(sprite, m, { mirror: true });
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
