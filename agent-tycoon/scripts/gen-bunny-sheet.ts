/**
 * BUNNY-SHEET: the built-in bunny's iso8 sheet (agent-tycoon/packs/hd-bunny/sheets/builtin-bunny.png and
 * .json): 9 columns × 5 rows of 288×528 cells (density 12), each a 64×128 frame enlarged 4× nearest
 * at (16, 16), so the feet of a standing frame end on row 511 and she stands 464 rows tall.
 *
 *  - rows 3-5 (front, back, right side): today's office bunny, pixel for pixel (her pack parts
 *    composed as the app does, gen-hd64-sample's BUNNY_LOOK);
 *  - rows 1-2 (three-quarter front facing the lower right, three-quarter back facing the upper
 *    right): the generator's new drawings A (standing), B and C (a step on either foot), their
 *    typing and reading copied from the front and back rows;
 *  - column 8 the standing frame, column 9 too, except the side row: 8 the near foot's passing
 *    pose, 9 the far foot's (walk 2, 8, 3, 9).
 * A new drawing is only cut from its background and resampled (hdSheet.ts, as gen-hd64-sample's
 * poses(): density 4, the side mirrored, interiorDarkShare 0.5): A stands 116 rows tall, B and C at
 * A's scale, each step moved sideways so its head stands where the standing frame's does.
 *
 *   npx tsx agent-tycoon/scripts/gen-bunny-sheet.ts <ref dir> [out dir] [--b1 <png>] [--c1 <png>]
 * <ref dir>: a1-idle.png b1-step.png c1-step.png a2-idle.png b2-step.png c2-step.png
 * a3-pass-near.png b3-pass-far.png (magenta or transparent background, the side ones facing left);
 * --b1 / --c1 another drawing for the three-quarter front's steps (row 1 columns 2 and 3).
 * Prints each cell's top row, feet row, height and head centre.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseArgs } from 'util';

import { figureFrame, figureOf, fitSize, magentaish } from '../../server/src/agent-tycoon/hdSheet.js';
import {
  blank,
  BUNNY_LOOK,
  D,
  FH,
  FW,
  type Img,
  on,
  over,
  PACK_DIR,
  read,
  sheetImage,
  writePng,
} from './gen-hd64-sample.js';

const COLS = 9;
const ROWS = 5;
const SCALE = 4;
const CELL_W = 288;
const CELL_H = 528;
const PAD = 16;
const FIGURE_ROWS = 116;
/** The head band the steps are aligned on: this many rows from the top (ears and hair). */
const HEAD_ROWS = 44;
const FIT_TRIES = 10;
const FIT_STEP = 1.003;

/** A new drawing as a 64×128 frame; `size`: source pixels per pixel (else it stands 116 tall). */
function frameOf(file: string, mirror: boolean, size?: number): { img: Img; size: number } {
  const src = read(file);
  const fig = figureOf(src, [0, 0, src.width - 1, src.height - 1], magentaish, true);
  if (!fig) throw new Error(`${file}: no figure`);
  const at = (s: number): Img => {
    const one = figureFrame(src, fig, s, { density: D, mirror, interiorDarkShare: 0.5 });
    if ('error' in one) throw new Error(`${file}: ${one.error}`);
    return { w: one.w, h: one.h, data: one.data };
  };
  if (size) return { img: at(size), size };
  // the grid's phase can add a row: a little coarser until she stands exactly 116 tall
  let s = Math.max(fitSize(fig, D), (fig[3] - fig[1]) / FIGURE_ROWS);
  let img = at(s);
  for (let k = 0; k < FIT_TRIES && measure(img).height > FIGURE_ROWS; k++)
    img = at((s *= FIT_STEP));
  return { img, size: s };
}

/** Top row, lowest row and the head band's mean column of a frame. */
function measure(a: Img) {
  let [top, feet] = [-1, -1];
  for (let y = 0; y < a.h; y++)
    for (let x = 0; x < a.w; x++)
      if (on(a, x, y)) {
        if (top < 0) top = y;
        feet = y;
      }
  let [sx, n] = [0, 0];
  for (let y = top; y < top + HEAD_ROWS; y++)
    for (let x = 0; x < a.w; x++) if (on(a, x, y)) [sx, n] = [sx + x, n + 1];
  return { top, feet, height: feet - top + 1, head: sx / n };
}

/** `a` moved `dx` columns (what leaves the frame is dropped). */
function shifted(a: Img, dx: number): Img {
  const out = blank(a.w, a.h);
  over(out, a, dx, 0);
  return out;
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { b1: { type: 'string' }, c1: { type: 'string' } },
  });
  const [refDir, outArg] = positionals;
  if (!refDir)
    throw new Error('usage: gen-bunny-sheet.ts <ref dir> [out dir] [--b1 <png>] [--c1 <png>]');
  const out = outArg ?? path.join(PACK_DIR, 'sheets');
  const given: Record<string, string | undefined> = { 'b1-step': values.b1, 'c1-step': values.c1 };
  const ref = (n: string) => path.resolve(given[n] ?? path.join(refDir, `${n}.png`));

  // today's bunny: her parts composed as the office does (rows down, up, right; 7 frames each,
  // walk1, stand, walk3, type ×2, read ×2)
  const { loadPack } = await import('../../server/src/agent-tycoon/packs.js');
  const { composePerson } = await import('../../webview-ui/src/agent-tycoon/characters/parts.js');
  const pack = loadPack(PACK_DIR, true);
  if ('error' in pack) throw new Error(pack.error);
  const composed = sheetImage(composePerson(BUNNY_LOOK as never, pack.parts).sheet);
  const today = (row: number, f: number): Img => {
    const o = blank();
    over(o, composed, -f * FW, -row * FH);
    return o;
  };
  /** A row of today's sheet in the iso8 column order: stand first, the steps, type, read. */
  const todayRow = (row: number) => [1, 0, 2, 3, 4, 5, 6].map((f) => today(row, f));

  /** A new row: stand, two steps (aligned on the stand's head), type and read of row `copyOf`. */
  const newRow = (a: string, b: string, c: string, copyOf: Img[]) => {
    const A = frameOf(ref(a), false);
    const head = measure(A.img).head;
    const step = (n: string) => {
      const f = frameOf(ref(n), false, A.size).img;
      return shifted(f, Math.round(head - measure(f).head));
    };
    return [A.img, step(b), step(c), ...copyOf.slice(3, 7)];
  };
  const front = todayRow(0);
  const back = todayRow(1);
  const side = todayRow(2);
  const passes = ['a3-pass-near', 'b3-pass-far'].map((n) => {
    const f = frameOf(ref(n), true).img;
    return shifted(f, Math.round(measure(side[0]).head - measure(f).head));
  });
  const rows: Img[][] = [
    newRow('a1-idle', 'b1-step', 'c1-step', front),
    newRow('a2-idle', 'b2-step', 'c2-step', back),
    front,
    back,
    side,
  ].map((r, i) => [...r, ...(i === 4 ? passes : [r[0], r[0]])]);

  const sheet = blank(CELL_W * COLS, CELL_H * ROWS);
  rows.forEach((r, ri) =>
    r.forEach((f, ci) => {
      for (let y = 0; y < f.h * SCALE; y++)
        for (let x = 0; x < f.w * SCALE; x++) {
          const o = (Math.floor(y / SCALE) * f.w + Math.floor(x / SCALE)) * 4;
          if (!f.data[o + 3]) continue;
          const t = ((ri * CELL_H + PAD + y) * sheet.w + ci * CELL_W + PAD + x) * 4;
          sheet.data.set(f.data.subarray(o, o + 4), t);
        }
    }),
  );
  writePng(path.join(out, 'builtin-bunny.png'), sheet);
  fs.writeFileSync(
    path.join(out, 'builtin-bunny.json'),
    JSON.stringify({ label: 'Bunny', columns: 'standFirst', walk: 'steps' }) + '\n',
  );

  // the numbers, in sheet rows (×4 + 16): top, feet, height, head centre per cell
  const names = ['3/4 front', '3/4 back', 'front', 'back', 'side'];
  rows.forEach((r, ri) => {
    const cells = r.map((f) => {
      const m = measure(f);
      return `${PAD + m.top * SCALE}-${PAD + m.feet * SCALE + SCALE - 1} h${m.height * SCALE} x${Math.round(PAD + m.head * SCALE)}`;
    });
    console.log(`${names[ri].padEnd(9)} ${cells.join(' | ')}`);
  });
  console.log(`${path.join(out, 'builtin-bunny.png')} ${sheet.w}×${sheet.h}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
