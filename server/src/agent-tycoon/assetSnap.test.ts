import { describe, expect, it } from 'vitest';

import {
  type Cells,
  dropBorderBackground,
  extractFigures,
  findGrid,
  fitReport,
  lattice,
  mergePalette,
  type Rgba,
  sampleCells,
  snap,
  snapWithGrid,
} from './assetSnap.js';

const BLOCK = 27.4;
const PAD = 5.3;
const COLS = 12;
const ROWS = 9;
const BLUR = 3;
const PALETTE = [
  [200, 40, 40],
  [40, 160, 60],
  [50, 70, 210],
  [230, 200, 60],
  [120, 50, 160],
  [240, 240, 240],
];

/** Deterministic pseudo-random numbers (mulberry32), so the test image never changes. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Known sprite: random palette colours, no two neighbours alike, a few transparent holes. */
function knownSprite(): Cells {
  const next = rng(7);
  const data = new Uint8Array(COLS * ROWS * 4);
  const colour = new Int8Array(COLS * ROWS).fill(-1);
  for (let y = 0; y < ROWS; y++)
    for (let x = 0; x < COLS; x++) {
      const i = y * COLS + x;
      if (next() < 0.08 && x > 0 && y > 0 && x < COLS - 1 && y < ROWS - 1) continue;
      let c = Math.floor(next() * PALETTE.length);
      while (c === colour[i - 1] || c === colour[i - COLS]) c = (c + 1) % PALETTE.length;
      colour[i] = c;
      data.set([...PALETTE[c], 255], i * 4);
    }
  return { cols: COLS, rows: ROWS, data };
}

/** The sprite drawn as BLOCK-px blocks (non-integer), padded, then blurred (soft edges) with a little noise. */
function bigBlockImage(sprite: Cells): Rgba {
  const width = Math.round(PAD * 2 + sprite.cols * BLOCK);
  const height = Math.round(PAD * 2 + sprite.rows * BLOCK);
  const raw = new Float64Array(width * height * 4);
  const next = rng(99);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const cx = Math.floor((x - PAD) / BLOCK);
      const cy = Math.floor((y - PAD) / BLOCK);
      if (cx < 0 || cy < 0 || cx >= sprite.cols || cy >= sprite.rows) continue;
      const i = (cy * sprite.cols + cx) * 4;
      for (let k = 0; k < 4; k++) raw[(y * width + x) * 4 + k] = sprite.data[i + k];
    }
  // Box blur on premultiplied colour, horizontal then vertical.
  const blur = (src: Float64Array, horizontal: boolean) => {
    const out = new Float64Array(src.length);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        for (let k = 0; k < 4; k++) {
          let sum = 0;
          let n = 0;
          for (let d = -BLUR; d <= BLUR; d++) {
            const xx = horizontal ? x + d : x;
            const yy = horizontal ? y : y + d;
            if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
            const j = (yy * width + xx) * 4;
            sum += k === 3 ? src[j + 3] : (src[j + k] * src[j + 3]) / 255;
            n++;
          }
          out[(y * width + x) * 4 + k] = sum / n;
        }
    return out;
  };
  const soft = blur(blur(raw, true), false);
  const data = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const a = soft[p * 4 + 3];
    for (let k = 0; k < 3; k++)
      data[p * 4 + k] = Math.max(
        0,
        Math.min(255, a > 0 ? (soft[p * 4 + k] * 255) / a : 0 + (next() - 0.5) * 6),
      );
    data[p * 4 + 3] = Math.round(a);
  }
  return { width, height, data };
}

const sameCells = (a: Cells, b: Cells) =>
  a.cols === b.cols && a.rows === b.rows && a.data.every((v, i) => v === b.data[i]);

/** Number of cells whose colour or visibility differs. */
function diffCells(a: Cells, b: Cells): number {
  let n = Math.abs(a.cols * a.rows - b.cols * b.rows);
  for (let c = 0; c < Math.min(a.cols * a.rows, b.cols * b.rows); c++)
    for (let k = 0; k < 4; k++)
      if (a.data[c * 4 + k] !== b.data[c * 4 + k]) {
        n++;
        break;
      }
  return n;
}

describe('assetSnap', () => {
  const sprite = knownSprite();
  const img = bigBlockImage(sprite);

  it('finds a non-integer block size through blurred edges', () => {
    const g = findGrid(img);
    expect(g.x.size).toBeGreaterThan(BLOCK - 0.5);
    expect(g.x.size).toBeLessThan(BLOCK + 0.5);
    expect(g.y.size).toBeGreaterThan(BLOCK - 0.5);
    expect(g.y.size).toBeLessThan(BLOCK + 0.5);
    expect(g.evidence).toBeGreaterThan(0);
  });

  it('gives the known sprite back exactly (the one figure, trimmed)', () => {
    const { figures } = snap(img);
    expect(figures).toHaveLength(1);
    // The known sprite has an opaque first and last row and column, so it is its own bounding box.
    expect(sameCells(figures[0].cells, sprite)).toBe(true);
  });

  it('with a size hint, finds the same cells', () => {
    const cells = snapWithGrid(img, findGrid(img, { size: BLOCK }));
    expect(sameCells(extractFigures(cells)[0].cells, sprite)).toBe(true);
  });

  it('negative control: a wrong grid gives a visibly different result', () => {
    const wrongSize = snapWithGrid(img, {
      x: lattice(BLOCK * 0.8, PAD, img.width),
      y: lattice(BLOCK * 0.8, PAD, img.height),
      evidence: 0,
    });
    const halfShift = snapWithGrid(img, {
      x: lattice(BLOCK, PAD + BLOCK / 2, img.width),
      y: lattice(BLOCK, PAD + BLOCK / 2, img.height),
      evidence: 0,
    });
    const total = COLS * ROWS;
    for (const wrong of [wrongSize, halfShift]) {
      const fig = extractFigures(wrong)[0]?.cells ?? wrong;
      expect(diffCells(fig, sprite)).toBeGreaterThan(total * 0.4);
    }
  });

  it('samples the dominant colour, not the average', () => {
    // One block, 70% red 30% blue stripes inside its centre: the average is purple, the dominant is red.
    const w = 20;
    const data = new Uint8Array(w * w * 4);
    for (let y = 0; y < w; y++)
      for (let x = 0; x < w; x++)
        data.set(x < 14 ? [200, 0, 0, 255] : [0, 0, 200, 255], (y * w + x) * 4);
    const cells = sampleCells(
      { width: w, height: w, data },
      { x: lattice(w, 0, w), y: lattice(w, 0, w), evidence: 0 },
    );
    expect([...cells.data.slice(0, 4)]).toEqual([200, 0, 0, 255]);
  });

  it('merges near-identical colours and keeps distinct ones', () => {
    const cells: Cells = {
      cols: 3,
      rows: 1,
      data: new Uint8Array([100, 100, 100, 255, 104, 98, 101, 255, 200, 0, 0, 255]),
    };
    expect(mergePalette(cells)).toBe(2);
    expect([...cells.data.slice(4, 7)]).toEqual([100, 100, 100]);
    expect([...cells.data.slice(8, 11)]).toEqual([200, 0, 0]);
  });

  it('drops an opaque black border but not a dark block inside the sprite', () => {
    const cols = 5;
    const rows = 5;
    const data = new Uint8Array(cols * rows * 4);
    for (let c = 0; c < cols * rows; c++) data.set([0, 0, 0, 255], c * 4);
    const set = (x: number, y: number, rgb: number[]) =>
      data.set([...rgb, 255], (y * cols + x) * 4);
    for (const [x, y] of [
      [1, 1],
      [2, 1],
      [3, 1],
      [1, 2],
      [3, 2],
      [1, 3],
      [2, 3],
      [3, 3],
    ])
      set(x, y, [200, 60, 60]);
    set(2, 2, [0, 0, 0]); // an enclosed black block: part of the sprite
    const cells: Cells = { cols, rows, data };
    expect(dropBorderBackground(cells)).toBe(true);
    expect(cells.data[3]).toBe(0);
    expect(cells.data[(2 * cols + 2) * 4 + 3]).toBe(255);
  });

  it('splits a sheet into figures, keeping a detached speck with its figure', () => {
    const cols = 20;
    const rows = 6;
    const data = new Uint8Array(cols * rows * 4);
    const fill = (x0: number, x1: number, y0: number, y1: number) => {
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) data.set([9, 9, 9, 255], (y * cols + x) * 4);
    };
    fill(1, 5, 1, 5); // figure 1
    fill(6, 7, 2, 3); // its speck, one empty cell away
    fill(12, 17, 0, 6); // figure 2
    const figures = extractFigures({ cols, rows, data });
    expect(figures.map((f) => [f.x, f.cells.cols, f.cells.rows])).toEqual([
      [1, 6, 4],
      [12, 5, 6],
    ]);
  });

  it('reports tile footprint and the character frame scale', () => {
    expect(fitReport(33, 16)).toMatchObject({ tilesW: 3, tilesH: 1, padW: 15, padH: 0 });
    expect(fitReport(16, 32).charScale).toBe(1);
    expect(fitReport(32, 64).charScale).toBe(0.5);
  });
});
