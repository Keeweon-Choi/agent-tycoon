import { describe, expect, it } from 'vitest';

import type { Rgba } from './assetSnap.js';
import { convertSheet, cutSheet } from './sheetImport.js';

const CELL_W = 60;
const CELL_H = 80;
const MAGENTA = [250, 6, 248, 255];
const SKIN = [230, 190, 170, 255];

/** A sheet of `rows` × 7 cells on magenta; `figure(r, c)` false leaves a cell empty. */
function sheet(rows: number, figure: (r: number, c: number) => boolean = () => true): Rgba {
  const W = CELL_W * 7;
  const H = CELL_H * rows;
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) data.set(MAGENTA, i * 4);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < 7; c++)
      if (figure(r, c))
        fill({ width: W, height: H, data }, c * CELL_W + 20, r * CELL_H + 8, 20, 64);
  return { width: W, height: H, data };
}

function fill(img: Rgba, x0: number, y0: number, w: number, h: number, rgba = SKIN) {
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) img.data.set(rgba, (y * img.width + x) * 4);
}

describe('cutSheet', () => {
  it('finds a 2×7 sheet as isometric and a 3×7 one as top view, cells left to right', () => {
    const iso = cutSheet(sheet(2));
    if ('code' in iso) throw new Error(iso.code);
    expect(iso.format).toBe('iso');
    expect(iso.cells.map((r) => r.length)).toEqual([7, 7]);
    expect(iso.cells[1][3].box).toEqual([
      3 * CELL_W + 20,
      CELL_H + 8,
      3 * CELL_W + 40,
      CELL_H + 72,
    ]);
    const top = cutSheet(sheet(3));
    if ('code' in top) throw new Error(top.code);
    expect(top.format).toBe('top');
    expect(top.cells.map((r) => r.length)).toEqual([7, 7, 7]);
  });

  it('names the empty cell of a row (row and column from 1) and how many figures it found', () => {
    expect(cutSheet(sheet(2, (r, c) => !(r === 1 && c === 4)))).toEqual({
      code: 'sheet_import_missing',
      vars: { found: 13, row: 2, col: 5, count: 6 },
    });
  });

  it('refuses one row or four, and a sheet that is not on magenta', () => {
    expect(cutSheet(sheet(1))).toMatchObject({ code: 'sheet_import_rows', vars: { rows: 1 } });
    expect(cutSheet(sheet(4))).toMatchObject({ code: 'sheet_import_rows', vars: { rows: 4 } });
    const grey = sheet(2);
    fill(grey, 0, 0, grey.width, grey.height, [128, 128, 128, 255]);
    expect(cutSheet(grey)).toMatchObject({ code: 'sheet_import_background' });
  });

  it('drops a stray speck far from every figure and keeps a strand next to one', () => {
    const img = sheet(2);
    fill(img, 2, CELL_H - 6, 3, 3); // a speck between the rows, far from all
    fill(img, CELL_W + 42, 20, 2, 6); // a strand 2 px right of figure (1, 2)
    const cut = cutSheet(img);
    if ('code' in cut) throw new Error(cut.code);
    expect(cut.stats.specks).toBe(1);
    expect(cut.cells[0][1].box[2]).toBe(CELL_W + 44);
  });

  it('counts a big stray blob in a row as one figure too many', () => {
    const img = sheet(2);
    fill(img, 3 * CELL_W + 48, 30, 10, 30);
    expect(cutSheet(img)).toMatchObject({ code: 'sheet_import_extra', vars: { row: 1, count: 8 } });
  });

  it('splits a touching pair where it is thinnest', () => {
    const img = sheet(2);
    // figures 3 and 4 drawn wide (50 px), their hair a 2 px bridge across the gap between them
    fill(img, 2 * CELL_W + 5, 8, 50, 64);
    fill(img, 3 * CELL_W + 5, 8, 50, 64);
    fill(img, 2 * CELL_W + 55, 20, 10, 2);
    const cut = cutSheet(img);
    if ('code' in cut) throw new Error(cut.code);
    expect(cut.stats.split).toBe(1);
    const row = cut.cells[0];
    expect(row.map((f) => f.box[0])).toEqual([20, 80, 125, expect.any(Number), 260, 320, 380]);
    // the cut falls on the bridge, between the two bodies
    expect(row[2].box[2]).toBeGreaterThanOrEqual(2 * CELL_W + 55);
    expect(row[3].box[0]).toBeLessThanOrEqual(3 * CELL_W + 5);
    expect(row[3].box[2]).toBe(3 * CELL_W + 55);
  });

  it('takes the magenta halo around a figure as background, not a lilac inside it', () => {
    const img = sheet(2);
    fill(img, 19, 8, 1, 64, [240, 90, 235, 255]); // a blend of skin and magenta on the edge
    fill(img, 28, 30, 4, 4, [200, 150, 230, 255]); // a lilac ribbon inside
    const cut = cutSheet(img);
    if ('code' in cut) throw new Error(cut.code);
    expect(cut.cells[0][0].box[0]).toBe(20);
    expect(cut.label[31 * img.width + 29]).toBe(cut.cells[0][0].id);
  });
});

describe('convertSheet', () => {
  /** A 2×7 sheet of 240×460 cells: each figure a head (60×60) over a body whose left edge moves
   *  per column (the head stays), the walk frames `stand` tall, the seated 330. */
  function figures(stand = 400): Rgba {
    const [CW, CH] = [240, 460];
    const W = CW * 7;
    const H = CH * 2;
    const img: Rgba = { width: W, height: H, data: new Uint8Array(W * H * 4) };
    fill(img, 0, 0, W, H, MAGENTA);
    for (let r = 0; r < 2; r++)
      for (let c = 0; c < 7; c++) {
        const tall = c < 3 ? stand : 330;
        const [x, y] = [c * CW + 90, r * CH + 440 - tall];
        fill(img, x, y, 60, 60, [240, 200, 180, 255]);
        fill(img, x - 20 - c * 4, y + 60, 100 + c * 4, tall - 60, [40, 60, 160, 255]);
        fill(img, x + 20, y + 25, 6, 6, [90, 40, 160, 255]); // an eye
      }
    return img;
  }

  it('makes 288×528 frames (24×44 world px at density 12) at one scale, feet on the floor, the head held still', () => {
    const img = figures();
    const cut = cutSheet(img);
    if ('code' in cut) throw new Error(cut.code);
    const out = convertSheet(img, cut);
    expect([out.width, out.height]).toEqual([288 * 7, 528 * 2]);
    expect(out.report.density).toBe(12);
    // the standing figure (400 px) stands 1.3 classic figures tall (1.3 × 29.5 × 12 px)
    expect(out.report.scale).toBeCloseTo(460.2 / 400, 2);
    expect(out.report.fit).toBeNull();
    const alpha = (r: number, c: number, x: number, y: number) =>
      out.data[((r * 528 + y) * out.width + c * 288 + x) * 4 + 3];
    const rowsOf = (r: number, c: number) =>
      Array.from({ length: 528 }, (_, y) => y).filter((y) =>
        Array.from({ length: 288 }, (_, x) => x).some((x) => alpha(r, c, x, y) >= 128),
      );
    // the feet end one world px over the frame's bottom, as char_N's
    for (const c of [0, 1, 2, 6]) expect(rowsOf(1, c).at(-1)).toBe(515);
    expect(out.report.footJitter).toBe(0);
    expect(out.report.headJitter.walk.x).toBeLessThanOrEqual(1);
    expect(out.report.headJitter.seated).toEqual({ x: expect.any(Number), y: 0 });
    expect(out.report.headJitter.seated.x).toBeLessThanOrEqual(1);
    expect([out.report.magenta, out.report.halo]).toEqual([0, 0]);
    // area averaging: the edges are partly transparent; the eye keeps its colour
    const edge = out.data.filter((_, i) => i % 4 === 3 && out.data[i] > 0 && out.data[i] < 255);
    expect(edge.length).toBeGreaterThan(0);
    const near = convertSheet(img, cut, { nearest: true });
    expect(
      near.data.filter((_, i) => i % 4 === 3 && near.data[i] > 0 && near.data[i] < 255).length,
    ).toBe(0);
  });

  it('never clips a figure too wide for its frame: the sheet shrinks and the report says which', () => {
    const img = figures(300);
    fill(img, 3 * 240 + 10, 200, 220, 30, [40, 60, 160, 255]); // seated legs stretched out wide
    const cut = cutSheet(img);
    if ('code' in cut) throw new Error(cut.code);
    const out = convertSheet(img, cut);
    expect(out.report.scale).toBeLessThan(460.2 / 300);
    expect(out.report.fit).toEqual({ row: expect.any(Number), col: 4, shrink: expect.any(Number) });
    expect(out.report.fit!.shrink).toBeLessThan(1);
    for (let y = 0; y < 528; y++) {
      expect(out.data[(y * out.width + 3 * 288) * 4 + 3]).toBe(0);
      expect(out.data[(y * out.width + 4 * 288 - 1) * 4 + 3]).toBe(0);
    }
  });
});
