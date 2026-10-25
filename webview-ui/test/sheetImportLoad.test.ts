import { afterEach, describe, expect, it } from 'vitest';

import { importedSheet } from '../src/cld/characters/importedSheet.js';
import { getCachedSprite } from '../src/office/sprites/spriteCache.js';

const originalDocument = globalThis.document;
afterEach(() => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
});

describe('SHEET-IMPORT: an imported sheet as the office loads it', () => {
  it('cuts 288×528 frames (24×44 world px) into 96×176 proxies drawn from the sheet; an isometric sheet stands in for the top view', () => {
    const draws: unknown[][] = [];
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createElement: () => {
          const context = {
            putImageData: () => undefined,
            drawImage: (...a: unknown[]) => draws.push(a),
            setTransform: () => undefined,
          };
          return { width: 0, height: 0, getContext: () => context };
        },
      },
    });
    const [W, H] = [288 * 7, 528 * 2];
    const data = new Uint8ClampedArray(W * H * 4);
    // column c of row r: a 30×60 block of grey (r * 7 + c) at the frame's foot
    for (let r = 0; r < 2; r++)
      for (let c = 0; c < 7; c++)
        for (let y = 528 - 60; y < 528; y++)
          for (let x = 129; x < 159; x++)
            data.set([r * 7 + c, r * 7 + c, r * 7 + c, 255], ((r * 528 + y) * W + c * 288 + x) * 4);
    const sheet = importedSheet({ width: W, height: H, data } as ImageData, {
      iso: true,
      standFirst: true,
      twoStep: false,
    });
    expect(sheet.density).toBe(4);
    expect(sheet.down[0].length).toBe(176);
    expect(sheet.down[0][0].length).toBe(96);
    // the 3×3 average: x 129..158 -> proxy columns 43..52 drawn (half covered or more)
    const row = sheet.down[2][175];
    expect(row.findIndex(Boolean)).toBe(43);
    // the colour is the average of the block: column 2's grey 2, row 2 column 4's grey 10
    expect(parseInt(row[46].slice(1), 16)).toBe(0x020202);
    expect(parseInt(sheet.up[3][175][46].slice(1), 16)).toBe(0x0a0a0a);
    // the isometric front row is also the side; the owner's column order walks 2, 1, 3, 1
    expect(sheet.right).toBe(sheet.down);
    expect([sheet.walk, sheet.stand]).toEqual([[1, 0, 2, 0], 0]);
    // the proxy draws its 288×528 rect of the decoded sheet
    getCachedSprite(sheet.up[3], 3);
    expect(draws.at(-1)!.slice(1, 5)).toEqual([3 * 288, 528, 288, 528]);
    expect(() =>
      importedSheet({ width: W, height: 500, data } as ImageData, {
        iso: true,
        standFirst: true,
        twoStep: false,
      }),
    ).toThrow();
  });
});
