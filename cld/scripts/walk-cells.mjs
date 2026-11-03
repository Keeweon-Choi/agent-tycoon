#!/usr/bin/env node
/**
 * WALK-FIX: edit the walk cells of an iso8 character sheet (2304×3168: 6 rows × 8 columns of
 * 288×528; columns 1 idle, 2 and 3 the steps, 8 the walking neutral).
 *
 *   node cld/scripts/walk-cells.mjs <in.png> <out.png> [--neutral 1,2,5] [--cell R,C=<png>[@i]]...
 *
 *   --neutral rows   column 8 of each listed row (1-based) becomes its column 1: the idle
 *                    (feet together, arms down) is the walking neutral, as the office drew
 *                    before the 8th column existed. For a sheet whose column 8 is a third stride,
 *                    floats, or is another figure (cld/scripts/walk-audit.mjs finds those).
 *   --cell R,C=f@i   cell (row R, column C, 1-based) becomes the i-th 288×528 cell (0-based,
 *                    default 0) of the PNG f (a frame or a strip of frames at the sheet's scale).
 *
 * The sheets themselves stay out of git (packs-private/).
 */
import fs from 'node:fs';
import { PNG } from 'pngjs';

const CW = 288;
const CH = 528;
const COLS = 8;
const ROWS = 6;
const NEUTRAL_COL = 8;

const [input, output, ...rest] = process.argv.slice(2);
if (!input || !output) {
  console.error(
    'usage: walk-cells.mjs <in.png> <out.png> [--neutral rows] [--cell R,C=png[@i]]...',
  );
  process.exit(2);
}
const sheet = PNG.sync.read(fs.readFileSync(input));
if (sheet.width !== CW * COLS || sheet.height !== CH * ROWS)
  throw new Error(`${input}: ${sheet.width}×${sheet.height}, not ${CW * COLS}×${CH * ROWS}`);

/** Copy a 288×528 cell between PNGs (1-based row and column in the sheet). */
const copy = (src, sx, sy, dst, row, col) =>
  PNG.bitblt(src, dst, sx, sy, CW, CH, (col - 1) * CW, (row - 1) * CH);

for (let i = 0; i < rest.length; i += 2) {
  const [flag, value] = [rest[i], rest[i + 1]];
  if (flag === '--neutral') {
    for (const r of value.split(',').map(Number)) {
      copy(sheet, 0, (r - 1) * CH, sheet, r, NEUTRAL_COL);
      console.log(`row ${r}: column ${NEUTRAL_COL} <- column 1 (the idle as the neutral)`);
    }
  } else if (flag === '--cell') {
    const m = /^(\d+),(\d+)=(.+?)(?:@(\d+))?$/.exec(value);
    if (!m) throw new Error(`--cell ${value}: expected R,C=file[@index]`);
    const [row, col, file, index] = [Number(m[1]), Number(m[2]), m[3], Number(m[4] ?? 0)];
    const src = PNG.sync.read(fs.readFileSync(file));
    const sx = index * CW;
    if (src.height < CH || src.width < sx + CW)
      throw new Error(`${file}: no ${CW}×${CH} cell at index ${index}`);
    copy(src, sx, 0, sheet, row, col);
    console.log(`row ${row}, column ${col} <- ${file}@${index}`);
  } else throw new Error(`unknown option ${flag}`);
}
fs.writeFileSync(output, PNG.sync.write(sheet));
console.log(`wrote ${output}`);
