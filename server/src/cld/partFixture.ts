/**
 * CHAR-HUMAN test fixture: an owner's drawing as an image generator returns it, built from the
 * ×20 row template (cld/scripts/gen-char-templates.ts) with a part drawn on the mannequin. Used by
 * partImport.test.ts and the cld/test/run-char-human.ts runner.
 */
import { PART_ALPHABET, PARTS_META, SHEET_W } from '../../../core/src/cld/partData.js';
import type { Rgba } from './assetSnap.js';

export const BLOCK = 20;
const MARGIN = 2;
const basic = PARTS_META.parts.find((p) => p.id === 'basic')!;
const top0 = PARTS_META.parts.find((p) => p.id === 'top-0')!;
export const px = (part: { palette: string[]; pixels: string }, x: number, y: number) => {
  const k = part.pixels[y * SHEET_W + x];
  return k === '.' ? '' : part.palette[PART_ALPHABET.indexOf(k)];
};
/** Well apart (no merge), no green, no magenta. */
export const COLOURS = [
  'c03028',
  '2850c0',
  'f0d020',
  '603010',
  'a0a0a0',
  '202020',
  'f08040',
  '80c0f0',
];
/** A source part: top-0's pixels in its own row `view`, each palette index a distinct colour. */
export const source = (view: number) => (x: number, y: number) => {
  const c = px(top0, x, view * 32 + y);
  return c ? COLOURS[top0.palette.indexOf(c) % COLOURS.length] : '';
};
export const rgb = (hex: string) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** Where the template has eye dots in frame `f` of row `view` (front row: two, side row: one). */
function eyeAt(view: number, f: number, x: number, y: number): boolean {
  const { eyeHints, headAnchors, headBox } = PARTS_META;
  const cols = view === 0 ? eyeHints.front : view === 2 ? eyeHints.side : [];
  const dy = headAnchors[view * 7 + f][1] - headBox.y;
  return cols.includes(x) && eyeHints.rows.some((r) => r + dy === y);
}

export interface BigRowOptions {
  /** The image's offset in source pixels. */
  shift?: number[];
  /** Draw the grey frame lines (half a block outside every cell, 2 px), as the template has. */
  lines?: boolean;
  /** The part at half-block detail (x, y in half blocks): finer than the template, as a generator
   *  draws it; its dominant colour per block should be `part`'s. */
  fine?: (x2: number, y2: number) => string;
  /** The row a frame's mannequin is drawn from (the front row's frame drawn as the back, ...). */
  mannequinRow?: (frame: number) => number;
}

/** The ×20 row template for `view` (as gen-char-templates draws it) with `part` drawn on top. */
export function bigRow(
  view: number,
  part: (x: number, y: number) => string,
  opts: BigRowOptions = {},
): Rgba {
  const shift = opts.shift ?? [0, 0];
  const w = (MARGIN * 2 + 7 * 17 - 1) * BLOCK;
  const h = (MARGIN * 2 + 32) * BLOCK;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const gx = Math.floor((x - shift[0]) / BLOCK) - MARGIN;
      const gy = Math.floor((y - shift[1]) / BLOCK) - MARGIN;
      const c = Math.floor(gx / 17);
      const fx = gx - c * 17;
      let colour = [255, 0, 255];
      if (opts.lines) {
        // lines at block 1.5 + 17c across and 1.5 / 34.5 down (2 px wide)
        const lx = (x - shift[0]) / BLOCK - MARGIN + 0.5;
        const ly = (y - shift[1]) / BLOCK - MARGIN + 0.5;
        const onV =
          ((lx % 17) + 17) % 17 < 2 / BLOCK &&
          lx > -0.5 &&
          lx < 7 * 17 + 0.5 &&
          ly >= 0 &&
          ly <= 33;
        const onH =
          (Math.abs(ly) < 2 / BLOCK || Math.abs(ly - 33) < 2 / BLOCK) && lx >= 0 && lx <= 7 * 17;
        if (onV || onH) colour = [128, 128, 128];
      }
      if (c >= 0 && c < 7 && fx < 16 && gy >= 0 && gy < 32) {
        const sx = c * 16 + fx;
        const mrow = opts.mannequinRow?.(c) ?? view;
        const body = px(basic, sx, mrow * 32 + gy);
        const paper = px(PARTS_META.paper, sx, view * 32 + gy);
        const x2 = Math.floor(((x - shift[0]) / BLOCK - MARGIN - c * 17) * 2);
        const y2 = Math.floor(((y - shift[1]) / BLOCK - MARGIN) * 2);
        const drawn = opts.fine ? opts.fine(c * 32 + x2, y2) : part(sx, gy);
        if (paper) colour = rgb(paper);
        else if (drawn) colour = rgb(drawn);
        else if (body)
          colour = body === '493e38' || eyeAt(mrow, c, fx, gy) ? [0, 160, 0] : [0, 255, 0];
      }
      data.set([...colour, 255], (y * w + x) * 4);
    }
  return { width: w, height: h, data };
}

/** Nearest-neighbour resize: a generator that changed the canvas size. */
export function resize(img: Rgba, w: number, h: number): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x * img.width) / w));
      const sy = Math.min(img.height - 1, Math.floor((y * img.height) / h));
      data.set(
        img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4),
        (y * w + x) * 4,
      );
    }
  return { width: w, height: h, data };
}
