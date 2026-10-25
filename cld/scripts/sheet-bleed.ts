/**
 * SHEET-IMPORT (owner 10-26 03:10): which cell of a generated sheet took most pixels that are not
 * its figure's under the old cut (straight splits, no untangling), and a before/after picture of
 * that cell's frame (before | after | what changed, in red). Writes <out>/bleed-before-after.png;
 * prints every sheet's numbers. The owner's sheets and the picture stay out of the repo.
 *
 *   npx tsx cld/scripts/sheet-bleed.ts <out dir> <sheet.png>...
 */
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import {
  convertSheet,
  cutSheet,
  IMPORT_FRAME_H,
  IMPORT_FRAME_W,
} from '../../server/src/cld/sheetImport.js';

const [out, ...files] = process.argv.slice(2);
if (!out || !files.length) {
  console.error('usage: sheet-bleed.ts <out dir> <sheet.png>...');
  process.exit(1);
}
const BG = [70, 70, 70];
let worst: {
  file: string;
  row: number;
  col: number;
  px: number;
  before: Uint8Array;
  after: Uint8Array;
} | null = null;
for (const file of files) {
  const src = PNG.sync.read(fs.readFileSync(file));
  const img = { width: src.width, height: src.height, data: new Uint8Array(src.data) };
  const old = cutSheet(img, { before: true });
  const now = cutSheet(img);
  if ('code' in old || 'code' in now) {
    console.log(path.basename(file), 'refused');
    continue;
  }
  const W = img.width;
  // per cell: source pixels the old cut gave that cell and the new one does not, or the reverse
  const cells = now.cells.map((row, r) =>
    row.map((f, c) => {
      const o = old.cells[r][c];
      let px = 0;
      for (let i = 0; i < W * img.height; i++)
        if ((old.label[i] === o.id) !== (now.label[i] === f.id)) px++;
      return px;
    }),
  );
  console.log(path.basename(file), JSON.stringify(cells), JSON.stringify(now.stats.bleed));
  const a = convertSheet(img, old);
  const b = convertSheet(img, now);
  cells.forEach((row, r) =>
    row.forEach((px, c) => {
      if (worst && px <= worst.px) return;
      const frame = (d: Uint8Array, w: number) => {
        const f = new Uint8Array(IMPORT_FRAME_W * IMPORT_FRAME_H * 4);
        for (let y = 0; y < IMPORT_FRAME_H; y++)
          f.set(
            d.subarray(
              ((r * IMPORT_FRAME_H + y) * w + c * IMPORT_FRAME_W) * 4,
              ((r * IMPORT_FRAME_H + y) * w + (c + 1) * IMPORT_FRAME_W) * 4,
            ),
            y * IMPORT_FRAME_W * 4,
          );
        return f;
      };
      worst = {
        file,
        row: r + 1,
        col: c + 1,
        px,
        before: frame(a.data, a.width),
        after: frame(b.data, b.width),
      };
    }),
  );
}
if (worst) {
  const w = worst as NonNullable<typeof worst>;
  const [FW, FH] = [IMPORT_FRAME_W, IMPORT_FRAME_H];
  const pic = new PNG({ width: FW * 3, height: FH });
  for (let y = 0; y < FH; y++)
    for (let x = 0; x < FW; x++) {
      const i = (y * FW + x) * 4;
      const put = (k: number, rgb: number[]) =>
        pic.data.set([...rgb, 255], (y * FW * 3 + k * FW + x) * 4);
      const over = (d: Uint8Array) =>
        [0, 1, 2].map((ch) => Math.round((d[i + ch] * d[i + 3] + BG[ch] * (255 - d[i + 3])) / 255));
      put(0, over(w.before));
      put(1, over(w.after));
      const diff = Math.abs(w.before[i + 3] - w.after[i + 3]) > 64;
      put(2, diff ? [255, 40, 40] : over(w.after).map((v) => Math.round(v * 0.4)));
    }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'bleed-before-after.png'), PNG.sync.write(pic));
  console.log(
    `worst: ${path.basename(w.file)} row ${w.row} cell ${w.col}: ${w.px} source px changed hands`,
  );
}
