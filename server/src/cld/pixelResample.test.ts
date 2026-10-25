import { describe, expect, it } from 'vitest';

import type { Rgba } from './assetSnap.js';
import { cleanup, detectGrid, resample, spriteStats } from './pixelResample.js';

const MAGENTA = [255, 0, 255];
const isBg = (r: number, g: number, b: number, a: number) =>
  a < 128 || Math.hypot(r - 255, g, b - 255) < 100 || (r - g > 40 && b - g > 40);

/** A 20×36 test figure: an outlined body, a one-pixel dark seam, single detail pixels. */
function figure(): (number[] | null)[][] {
  const W = 20;
  const H = 36;
  const inside = (x: number, y: number) => ((x - 9.5) / 8.5) ** 2 + ((y - 17.5) / 16.5) ** 2 <= 1;
  return Array.from({ length: H }, (_, y) =>
    Array.from({ length: W }, (_, x) => {
      if (!inside(x, y)) return null;
      const edge = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].some(([dx, dy]) => !inside(x + dx, y + dy));
      if (edge) return [24, 20, 30];
      if (x === 10 && y > 8 && y < 28) return [40, 30, 40]; // a seam
      if ((x * 7 + y * 3) % 23 === 0) return [230, 200, 60]; // buttons, studs
      return y < 14 ? [200, 200, 210] : [60, 90, 160];
    }),
  );
}

/** The figure drawn at `size` px per pixel from (px, py), softened by a 3×3 blur: what a
 *  generator returns. */
function render(art: (number[] | null)[][], size: number, px: number, py: number): Rgba {
  const w = Math.ceil(art[0].length * size + px * 2 + 20);
  const h = Math.ceil(art.length * size + py * 2 + 20);
  const sharp = new Float64Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const u = Math.floor((x + 0.5 - px) / size);
      const v = Math.floor((y + 0.5 - py) / size);
      const c = art[v]?.[u] ?? MAGENTA;
      sharp.set(c, (y * w + x) * 3);
    }
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sum = [0, 0, 0];
      let n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          for (let k = 0; k < 3; k++) sum[k] += sharp[(yy * w + xx) * 3 + k];
          n++;
        }
      data.set([...sum.map((v) => Math.round(v / n)), 255], (y * w + x) * 4);
    }
  return { width: w, height: h, data };
}

describe('pixel resampling (HD-CONVERT)', () => {
  it('finds a soft drawing’s own grid and gives back exactly the drawn pixels', () => {
    const art = figure();
    for (const [size, px, py] of [
      [6.3, 2.2, 3.7],
      [4.7, 1.1, 0.4],
      [9, 5, 2],
    ]) {
      const img = render(art, size, px, py);
      const grid = detectGrid(img, [0, 0, img.width, img.height], isBg, { min: 3, max: 12 });
      expect(Math.abs(grid.size - size) / size, `size ${size}`).toBeLessThan(0.015);
      // the phase found may be a whole pixel off: start one pixel early and look for the figure
      const r = resample(
        img,
        grid,
        { x: grid.ox, y: grid.oy },
        Math.ceil(img.width / grid.size),
        Math.ceil(img.height / grid.size),
        isBg,
      );
      cleanup(r);
      let [bx, by] = [Infinity, Infinity];
      for (let y = 0; y < r.rows; y++)
        for (let x = 0; x < r.cols; x++)
          if (r.data[(y * r.cols + x) * 4 + 3]) [bx, by] = [Math.min(bx, x), Math.min(by, y)];
      // the art's own top-left drawn pixel lands on the result's
      const ax = Math.min(...art.map((row) => row.findIndex(Boolean)).filter((i) => i >= 0));
      const ay = art.findIndex((row) => row.some(Boolean));
      let wrong = 0;
      art.forEach((row, y) =>
        row.forEach((c, x) => {
          const o = ((by + y - ay) * r.cols + bx + x - ax) * 4;
          const got = r.data[o + 3] ? [r.data[o], r.data[o + 1], r.data[o + 2]] : null;
          const same = !c
            ? !got
            : !!got && Math.hypot(got[0] - c[0], got[1] - c[1], got[2] - c[2]) < 24;
          if (!same) wrong++;
        }),
      );
      expect(wrong, `size ${size}: wrong pixels`).toBe(0);
    }
  });

  it('negative control: an image with no grid has a weak comb', () => {
    const w = 120;
    const h = 120;
    const data = new Uint8Array(w * h * 4);
    let seed = 3;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < w * h; i++) data.set([Math.floor(rand() * 200), 60, 90, 255], i * 4);
    const noise = detectGrid({ width: w, height: h, data }, [0, 0, w, h], isBg);
    const clean = render(figure(), 6.3, 2.2, 3.7);
    const real = detectGrid(clean, [0, 0, clean.width, clean.height], isBg);
    expect(real.confidence).toBeGreaterThan(noise.confidence * 3);
  });

  it('cleanup fills one-pixel holes, drops strays, closes the outline; the stats count them', () => {
    const cols = 8;
    const rows = 8;
    const data = new Uint8Array(cols * rows * 4);
    const put = (x: number, y: number, c: number[]) => data.set([...c, 255], (y * cols + x) * 4);
    for (let y = 1; y <= 5; y++) for (let x = 1; x <= 5; x++) put(x, y, [200, 200, 200]);
    data[(3 * cols + 3) * 4 + 3] = 0; // a hole
    put(7, 7, [10, 10, 10]); // a stray
    const dark: (number[] | null)[] = new Array(cols * rows).fill(null);
    dark[1 * cols + 2] = [20, 20, 20]; // the source had a dark edge here
    const before = spriteStats(data, cols, [0, 0, cols, rows]);
    expect(before).toMatchObject({ holes: 1, isolated: 1 });
    const fixes = cleanup({ cols, rows, data, cover: new Float32Array(cols * rows), dark });
    expect(fixes).toEqual({ holes: 1, strays: 1, outline: 1 });
    const after = spriteStats(
      data,
      cols,
      [0, 0, cols, rows],
      (x, y) => x >= 1 && x <= 5 && y >= 1 && y <= 5,
    );
    expect(after).toMatchObject({ holes: 0, isolated: 0, iou: 1 });
    expect([...data.subarray((1 * cols + 2) * 4, (1 * cols + 2) * 4 + 3)]).toEqual([20, 20, 20]);
    // the edge pixels that are still light are outline breaks
    expect(after.outlineBreaks).toBe(15);
  });
});
