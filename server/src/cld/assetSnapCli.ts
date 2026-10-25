/**
 * ASSET-SNAP command line. Run from the repo root:
 *
 *   nice -n 10 npx tsx server/src/cld/assetSnapCli.ts <outDir> <name>:<kind>[@size]=<file.png> ...
 *
 * kind: furniture | character | sign (all snapped and split into figures) or scene (only the block
 * grid is measured and a tile note printed; nothing is converted). Per sample it writes into outDir:
 *   <name>.png         the snapped image, 1 art pixel = 1 png pixel (trimmed when it is one figure)
 *   <name>-<n>.png     each figure, trimmed (only when the image holds more than one)
 *   <name>-sheet.png   the comparison sheet: original scaled down, next to the snapped result at an
 *                      integer zoom (transparent shows as a grey checker)
 * and prints a Markdown results table. Nothing here touches a game asset or the catalog.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import { FLOOR_TILE_SIZE } from '../../../core/src/assets/constants.js';
import {
  type Cells,
  findGrid,
  fitReport,
  type Grid,
  type Rgba,
  snap,
  WEAK_EVIDENCE,
} from './assetSnap.js';

const PANEL = 640;
const GAP = 24;
const WIDE_ASPECT = 1.6;
const BACKDROP = [58, 58, 64];
const CHECKER = [
  [84, 84, 92],
  [70, 70, 78],
];
const CHECKER_CELL = 8;
const OPAQUE = 255;
const KINDS = ['furniture', 'character', 'sign', 'scene'] as const;
type Kind = (typeof KINDS)[number];

function readPng(file: string): Rgba {
  const p = PNG.sync.read(fs.readFileSync(file));
  return { width: p.width, height: p.height, data: p.data };
}

function writePng(file: string, width: number, height: number, data: Uint8Array) {
  const p = new PNG({ width, height });
  p.data = Buffer.from(data);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(p));
}

function blend(dst: Uint8Array, o: number, r: number, g: number, b: number, a: number) {
  const k = a / OPAQUE;
  dst[o] = Math.round(r * k + dst[o] * (1 - k));
  dst[o + 1] = Math.round(g * k + dst[o + 1] * (1 - k));
  dst[o + 2] = Math.round(b * k + dst[o + 2] * (1 - k));
  dst[o + 3] = OPAQUE;
}

/** Box-filter shrink of the original so thin lines do not drop out. */
function paintScaled(dst: Rgba, img: Rgba, ox: number, oy: number, w: number, h: number) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor((x * img.width) / w);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * img.width) / w));
      const sy0 = Math.floor((y * img.height) / h);
      const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * img.height) / h));
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        n = 0;
      for (let sy = sy0; sy < sy1; sy++)
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * img.width + sx) * 4;
          r += img.data[i] * img.data[i + 3];
          g += img.data[i + 1] * img.data[i + 3];
          b += img.data[i + 2] * img.data[i + 3];
          a += img.data[i + 3];
          n++;
        }
      if (a > 0) blend(dst.data, ((oy + y) * dst.width + ox + x) * 4, r / a, g / a, b / a, a / n);
    }
  }
}

function paintZoomed(dst: Rgba, cells: Cells, ox: number, oy: number, z: number) {
  for (let y = 0; y < cells.rows * z; y++)
    for (let x = 0; x < cells.cols * z; x++) {
      const i = (((y / z) | 0) * cells.cols + ((x / z) | 0)) * 4;
      if (cells.data[i + 3])
        blend(
          dst.data,
          ((oy + y) * dst.width + ox + x) * 4,
          cells.data[i],
          cells.data[i + 1],
          cells.data[i + 2],
          OPAQUE,
        );
    }
}

function checker(dst: Rgba, ox: number, oy: number, w: number, h: number) {
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = CHECKER[(((x / CHECKER_CELL) | 0) + ((y / CHECKER_CELL) | 0)) & 1];
      const o = ((oy + y) * dst.width + ox + x) * 4;
      dst.data.set([c[0], c[1], c[2], OPAQUE], o);
    }
}

function comparisonSheet(img: Rgba, cells: Cells): Rgba {
  const f = Math.min(PANEL / img.width, PANEL / img.height, 1);
  const lw = Math.round(img.width * f);
  const lh = Math.round(img.height * f);
  const z = Math.max(1, Math.floor(Math.min(PANEL / cells.cols, PANEL / cells.rows)));
  const rw = cells.cols * z;
  const rh = cells.rows * z;
  const stacked = img.width / img.height > WIDE_ASPECT;
  const width = stacked ? Math.max(lw, rw) + 2 * GAP : lw + rw + 3 * GAP;
  const height = stacked ? lh + rh + 3 * GAP : Math.max(lh, rh) + 2 * GAP;
  const dst: Rgba = { width, height, data: new Uint8Array(width * height * 4) };
  for (let i = 0; i < dst.data.length; i += 4) dst.data.set([...BACKDROP, OPAQUE], i);
  const lx = GAP;
  const ly = GAP;
  const rx = stacked ? GAP : lw + 2 * GAP;
  const ry = stacked ? lh + 2 * GAP : GAP;
  checker(dst, lx, ly, lw, lh);
  paintScaled(dst, img, lx, ly, lw, lh);
  checker(dst, rx, ry, rw, rh);
  paintZoomed(dst, cells, rx, ry, z);
  return dst;
}

function run(outDir: string, specs: string[]) {
  const rows: string[] = [];
  for (const spec of specs) {
    const m = /^([\w-]+):(\w+)(?:@([\d.]+))?=(.+)$/.exec(spec);
    if (!m || !(KINDS as readonly string[]).includes(m[2])) {
      console.error(`bad spec "${spec}", want <name>:<${KINDS.join('|')}>[@size]=<file.png>`);
      process.exitCode = 1;
      continue;
    }
    const [, name, kindText, hint, file] = m;
    const kind = kindText as Kind;
    const img = readPng(file);
    const grid: Grid = findGrid(img, hint ? { size: Number(hint) } : {});
    const note = hint ? ` (hint ${hint})` : grid.evidence < WEAK_EVIDENCE ? ' WEAK' : '';
    const g = `${grid.x.size.toFixed(2)} x ${grid.y.size.toFixed(2)}${note}, evidence ${Number.isFinite(grid.evidence) ? grid.evidence.toFixed(0) : '-'}`;
    if (kind === 'scene') {
      const cols = Math.round(img.width / grid.x.size);
      const rowsN = Math.round(img.height / grid.y.size);
      rows.push(
        `| ${name} | ${img.width}x${img.height} | ${g} | ${cols}x${rowsN} (scene, not converted) | ` +
          `${(cols / FLOOR_TILE_SIZE).toFixed(1)}x${(rowsN / FLOOR_TILE_SIZE).toFixed(1)} tiles if 1 block = 1 game px |`,
      );
      continue;
    }
    const { cells, figures } = snap(img, grid);
    writePng(path.join(outDir, `${name}-sheet.png`), ...sheetArgs(comparisonSheet(img, cells)));
    // One figure: <name>.png is that figure, trimmed. Several: <name>.png is the whole sheet and each figure is <name>-<n>.png.
    const whole = figures.length === 1 ? figures[0].cells : cells;
    writePng(path.join(outDir, `${name}.png`), whole.cols, whole.rows, whole.data);
    const list = figures.map((f, i) => {
      if (figures.length > 1)
        writePng(
          path.join(outDir, `${name}-${i + 1}.png`),
          f.cells.cols,
          f.cells.rows,
          f.cells.data,
        );
      const fit = fitReport(f.cells.cols, f.cells.rows);
      return kind === 'character'
        ? `${fit.width}x${fit.height} (char frame 16x32 scale ${fit.charScale.toFixed(2)})`
        : `${fit.width}x${fit.height} = ${fit.tilesW}x${fit.tilesH} tiles (pad ${fit.padW}x${fit.padH})`;
    });
    rows.push(
      `| ${name} | ${img.width}x${img.height} | ${g} | ` +
        `${cells.cols}x${cells.rows} whole, ${figures.length} fig | ${list.join('; ')} |`,
    );
  }
  console.log(
    '| sample | source | detected block (x, y) | true size | figures: size, tile footprint |',
  );
  console.log('| --- | --- | --- | --- | --- |');
  rows.forEach((r) => console.log(r));
}

const sheetArgs = (s: Rgba): [number, number, Uint8Array] => [s.width, s.height, s.data];

const [outDir, ...specs] = process.argv.slice(2);
if (!outDir || !specs.length) {
  console.error('usage: assetSnapCli.ts <outDir> <name>:<kind>[@size]=<file.png> ...');
  process.exitCode = 1;
} else {
  run(outDir, specs);
}
