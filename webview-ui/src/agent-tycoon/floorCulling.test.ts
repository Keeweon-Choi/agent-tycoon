import { describe, expect, it } from 'vitest';

import { renderTileGrid } from '../office/engine/renderer.js';
import { TileType } from '../office/types.js';

describe('floor tiles', () => {
  it('draws only the tiles on the canvas (SHEET-IMPORT FPS), the same ones as before there', () => {
    const fills: Array<[number, number]> = [];
    const ctx = {
      canvas: { width: 40, height: 20 },
      fillStyle: '',
      fillRect: (x: number, y: number) => fills.push([x, y]),
      drawImage: () => undefined,
    } as unknown as CanvasRenderingContext2D;
    const map = Array.from({ length: 10 }, () => new Array(10).fill(TileType.WALL));
    // panned so the map starts 8 px left of the canvas: columns 0-2 and rows 0-1 show, not all 100 (16 px tiles)
    renderTileGrid(ctx, map, -8, 0, 1);
    expect(fills).toEqual([
      [-8, 0],
      [8, 0],
      [24, 0],
      [-8, 16],
      [8, 16],
      [24, 16],
    ]);
  });
});
