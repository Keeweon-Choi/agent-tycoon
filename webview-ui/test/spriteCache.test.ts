import { afterEach, describe, expect, it } from 'vitest';

import { WALL_COLOR } from '../src/constants.js';
import { getCachedSprite } from '../src/office/sprites/spriteCache.js';

const frame = (width: number, height: number) =>
  Array.from({ length: height }, () => new Array<string>(width).fill(WALL_COLOR));

const originalDocument = globalThis.document;

afterEach(() => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
});

function installCanvas(calls: { fills: number; draws: number }) {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => {
        const context = {
          imageSmoothingEnabled: false,
          fillStyle: '',
          fillRect: () => calls.fills++,
          drawImage: () => calls.draws++,
          createImageData: (width: number, height: number) => ({
            data: new Uint8ClampedArray(width * height * 4),
          }),
          putImageData: () => undefined,
        };
        return { width: 0, height: 0, getContext: () => context };
      },
    },
  });
}

describe('sprite cache paths', () => {
  it('keeps classic frames on the fill path, and only whole-scale 64-row frames use put-and-scale', () => {
    const classic = { fills: 0, draws: 0 };
    installCanvas(classic);
    getCachedSprite(frame(16, 32), 2);
    expect(classic).toEqual({ fills: 16 * 32, draws: 0 });

    const hd = { fills: 0, draws: 0 };
    installCanvas(hd);
    getCachedSprite(frame(32, 64), 1);
    expect(hd).toEqual({ fills: 0, draws: 1 });

    const fractional = { fills: 0, draws: 0 };
    installCanvas(fractional);
    getCachedSprite(frame(32, 64), 0.5);
    expect(fractional).toEqual({ fills: 32 * 64, draws: 0 });
  });
});
