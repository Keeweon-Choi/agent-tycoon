/**
 * SHEET-IMPORT: an imported sheet as the office draws it (looks.ts loads it).
 */
import {
  IMPORT_DENSITY,
  IMPORT_PROXY_DENSITY,
  IMPORT_WORLD_H,
  IMPORT_WORLD_W,
  ISO8_DRINK_CELLS,
  ISO8_DRINK_ROWS,
} from '../../constants.js';
import { markSmooth } from '../../office/sprites/smoothSprite.js';
import type { SpriteData } from '../../office/types.js';
import { type DenseSheet, FRAMES, IMPORTED_COLUMNS, withLods } from './compose.js';

/** SHEET-IMPORT: an imported sheet (density 12: 192×384 frames, 2 rows isometric or 3 top view)
 *  as frames: each a 64×128 proxy (the sheet's pixels averaged 3×3, for hit tests, outlines and
 *  the spawn effect) whose master is its rect of the decoded sheet (smoothSprite.ts). An
 *  isometric sheet stands in for the top view too: front ← its front row, back ← its back row,
 *  the sides from its front row. Columns in the owner's order walk left, together, right,
 *  together (or the two steps alone) and stand on column 1. CHAR-ISO-1: an 8th column is the
 *  walking neutral (arms down), the "together" of the walk; without it the idle stands in.
 *  BUNNY-9COL: a 9th is the other foot's passing pose, the second "together" (walk 2, 8, 3, 9). */
export function importedSheet(
  img: ImageData,
  opts: { iso: boolean; standFirst: boolean; twoStep: boolean },
  /** LOOKS-MEM: the canvas `img` was read from, kept as the masters (else a copy is made). */
  canvas?: HTMLCanvasElement,
): DenseSheet {
  const src = sourceOf(img, opts.iso ? 2 : 3, canvas);
  return sheetOf(img, src, opts.iso ? [0, 1, 0] : [0, 1, 2], opts);
}

/** CHAR-8DIR: a 5-row sheet (three-quarter front, three-quarter back, front, back, right side)
 *  as its two views from one decoded source: `iso` its three-quarter rows (as a 2-row sheet),
 *  `top` its front, back and side (as a 3-row sheet). C1: a 6th row holds the drinking poses
 *  (three-quarter front; columns 1-3 coffee lifted, sipping, sipping with eyes closed, 4-6 the
 *  same with a can, 7-8 empty): `drink`, those six cells. */
export function importedEight(
  img: ImageData,
  opts: { standFirst: boolean; twoStep: boolean },
  canvas?: HTMLCanvasElement,
): { iso: DenseSheet; top: DenseSheet; drink?: SpriteData[] } {
  const rows =
    img.height === IMPORT_WORLD_H * IMPORT_DENSITY * ISO8_DRINK_ROWS ? ISO8_DRINK_ROWS : 5;
  const src = sourceOf(img, rows, canvas);
  const cell = cellsOf(img, src);
  return {
    iso: sheetOf(img, src, [0, 1, 0], opts),
    top: sheetOf(img, src, [2, 3, 4], opts),
    ...(rows === ISO8_DRINK_ROWS && {
      drink: Array.from({ length: ISO8_DRINK_CELLS }, (_, f) => cell(ISO8_DRINK_ROWS - 1, f)),
    }),
  };
}

/** The decoded sheet on a canvas (the frames' masters), once its size is checked: `canvas` when
 *  it already holds the picture (LOOKS-MEM: one copy of a ~29 MB sheet, not two). */
function sourceOf(img: ImageData, rows: number, canvas?: HTMLCanvasElement): HTMLCanvasElement {
  const [fw, fh] = [IMPORT_WORLD_W * IMPORT_DENSITY, IMPORT_WORLD_H * IMPORT_DENSITY];
  const cols = img.width / fw;
  if (!IMPORTED_COLUMNS.includes(cols) || img.height !== fh * rows)
    throw new Error(`${img.width}×${img.height} is no imported sheet`);
  if (canvas) return canvas;
  const src = document.createElement('canvas');
  [src.width, src.height] = [img.width, img.height];
  src.getContext('2d')!.putImageData(img, 0, 0);
  return src;
}

/** The cell at row `r`, column `f` of the source: a proxy whose master is that rect of it. */
function cellsOf(img: ImageData, src: HTMLCanvasElement): (r: number, f: number) => SpriteData {
  const [fw, fh] = [IMPORT_WORLD_W * IMPORT_DENSITY, IMPORT_WORLD_H * IMPORT_DENSITY];
  const k = IMPORT_DENSITY / IMPORT_PROXY_DENSITY;
  const hex = new Map<number, string>();
  return (r: number, f: number): SpriteData => {
    const [x0, y0] = [f * fw, r * fh];
    const proxy = Array.from({ length: fh / k }, (_, y) =>
      Array.from({ length: fw / k }, (_, x) => {
        let [rs, gs, bs, as] = [0, 0, 0, 0];
        for (let dy = 0; dy < k; dy++)
          for (let dx = 0; dx < k; dx++) {
            const i = ((y0 + y * k + dy) * img.width + x0 + x * k + dx) * 4;
            const a = img.data[i + 3];
            [rs, gs, bs, as] = [
              rs + img.data[i] * a,
              gs + img.data[i + 1] * a,
              bs + img.data[i + 2] * a,
              as + a,
            ];
          }
        if (as < (k * k * 255) / 2) return '';
        const v = (Math.round(rs / as) << 16) | (Math.round(gs / as) << 8) | Math.round(bs / as);
        let h = hex.get(v);
        if (!h) hex.set(v, (h = `#${v.toString(16).padStart(6, '0').toUpperCase()}`));
        return h;
      }),
    );
    markSmooth(proxy, { src, x: x0, y: y0, w: fw, h: fh });
    return proxy;
  };
}

/** The sheet whose front, back and side are the source's rows `[front, back, side]`. */
function sheetOf(
  img: ImageData,
  src: HTMLCanvasElement,
  [down, up, right]: number[],
  opts: { standFirst: boolean; twoStep: boolean },
): DenseSheet {
  const cols = img.width / (IMPORT_WORLD_W * IMPORT_DENSITY);
  const frame = cellsOf(img, src);
  const row = (r: number) => Array.from({ length: cols }, (_, f) => frame(r, f));
  const front = row(down);
  const sheet: DenseSheet = {
    down: front,
    up: row(up),
    right: right === down ? front : row(right),
    density: IMPORT_PROXY_DENSITY,
    ...(opts.standFirst && {
      walk: walkOf(cols, opts.twoStep),
      stand: 0,
    }),
  };
  // the 32×64 copy compose's card portrait and the 꾸미기 thumbnails crop (never the office's)
  return withLods(sheet);
}

/** A standFirst sheet's walk (0-based columns) by its column count: left step, together, right
 *  step, together; "together" is the walking neutral (8th) when there is one, else the idle, and
 *  the second one the 9th column when there is one. */
export function walkOf(cols: number, twoStep: boolean): readonly [number, number, number, number] {
  if (twoStep) return [1, 2, 1, 2];
  const together = cols > FRAMES ? FRAMES : 0;
  return [1, together, 2, cols > FRAMES + 1 ? FRAMES + 1 : together];
}
