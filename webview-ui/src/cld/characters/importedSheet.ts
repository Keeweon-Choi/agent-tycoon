/**
 * SHEET-IMPORT: an imported sheet as the office draws it (looks.ts loads it).
 */
import {
  IMPORT_DENSITY,
  IMPORT_PROXY_DENSITY,
  IMPORT_WORLD_H,
  IMPORT_WORLD_W,
} from '../../constants.js';
import { markSmooth } from '../../office/sprites/smoothSprite.js';
import type { SpriteData } from '../../office/types.js';
import { type DenseSheet, FRAMES, withLods } from './compose.js';

/** SHEET-IMPORT: an imported sheet (density 12: 192×384 frames, 2 rows isometric or 3 top view)
 *  as frames: each a 64×128 proxy (the sheet's pixels averaged 3×3, for hit tests, outlines and
 *  the spawn effect) whose master is its rect of the decoded sheet (smoothSprite.ts). An
 *  isometric sheet stands in for the top view too: front ← its front row, back ← its back row,
 *  the sides from its front row. Columns in the owner's order walk left, together, right,
 *  together (or the two steps alone) and stand on column 1. */
export function importedSheet(
  img: ImageData,
  opts: { iso: boolean; standFirst: boolean; twoStep: boolean },
): DenseSheet {
  const [fw, fh] = [IMPORT_WORLD_W * IMPORT_DENSITY, IMPORT_WORLD_H * IMPORT_DENSITY];
  if (img.width !== fw * FRAMES || img.height !== fh * (opts.iso ? 2 : 3))
    throw new Error(`${img.width}×${img.height} is no imported sheet`);
  const src = document.createElement('canvas');
  [src.width, src.height] = [img.width, img.height];
  src.getContext('2d')!.putImageData(img, 0, 0);
  const k = IMPORT_DENSITY / IMPORT_PROXY_DENSITY;
  const hex = new Map<number, string>();
  const frame = (r: number, f: number): SpriteData => {
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
  const row = (r: number) => Array.from({ length: FRAMES }, (_, f) => frame(r, f));
  const [front, back] = [row(0), row(1)];
  const sheet: DenseSheet = {
    down: front,
    up: back,
    right: opts.iso ? front : row(2),
    density: IMPORT_PROXY_DENSITY,
    ...(opts.standFirst && {
      walk: opts.twoStep ? ([1, 2, 1, 2] as const) : ([1, 0, 2, 0] as const),
      stand: 0,
    }),
  };
  // the 32×64 copy compose's card portrait and the 꾸미기 thumbnails crop (never the office's)
  return withLods(sheet);
}
