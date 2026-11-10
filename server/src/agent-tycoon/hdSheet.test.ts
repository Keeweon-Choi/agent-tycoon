import { describe, expect, it } from 'vitest';

import type { Rgba } from './assetSnap.js';
import { figureFrame, fitSize, frameAt } from './hdSheet.js';

describe('figureFrame at a density', () => {
  it('stands a figure on the floor of a 48×96 frame (density 3), centred', () => {
    // a 90×177 light block on magenta: 2 source pixels per pixel at density 3
    const W = 120;
    const H = 200;
    const img: Rgba = { width: W, height: H, data: new Uint8Array(W * H * 4) };
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const on = x >= 10 && x < 100 && y >= 10 && y < 187;
        img.data.set(on ? [200, 200, 210, 255] : [255, 0, 255, 255], (y * W + x) * 4);
      }
    const fig = [10, 10, 100, 187];
    expect(fitSize(fig, 3)).toBe(2);
    const f = figureFrame(img, fig, fitSize(fig, 3), { density: 3 });
    if ('error' in f) throw new Error(f.error);
    expect([f.w, f.h]).toEqual([48, 96]);
    const drawn = (x: number, y: number) => f.data[(y * f.w + x) * 4 + 3] > 0;
    const rows = Array.from({ length: f.h }, (_, y) => y).filter((y) => drawn(24, y));
    expect(rows[rows.length - 1]).toBe(frameAt(3).floor);
    expect(frameAt(3).floor).toBe(92);
    const cols = Array.from({ length: f.w }, (_, x) => x).filter((x) => drawn(x, 50));
    expect(cols[0] + cols[cols.length - 1]).toBeGreaterThanOrEqual(46);
    expect(cols[0] + cols[cols.length - 1]).toBeLessThanOrEqual(48);
  });
});
