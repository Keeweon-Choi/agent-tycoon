import { afterEach, describe, expect, it, vi } from 'vitest';

import { markRedecode, markSmooth, peekSmooth } from '../src/office/sprites/smoothSprite.js';
import { getCachedSprite } from '../src/office/sprites/spriteCache.js';
import type { SpriteData } from '../src/office/types.js';

const originalDocument = globalThis.document;
afterEach(() => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
});

type Fake = { width: number; height: number; getContext: () => unknown };

describe('PERF-WEBVIEW-MEMORY: a decoded sheet is kept no denser than the office draws it', () => {
  it('halves the masters while drawn at half or less, decodes them again when drawn larger, and keeps nothing built too coarse', async () => {
    const draws: unknown[][] = [];
    const made: Fake[] = [];
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createElement: () => {
          const c: Fake = {
            width: 0,
            height: 0,
            getContext: () => ({
              drawImage: (...a: unknown[]) => draws.push(a),
              setTransform: () => undefined,
            }),
          };
          made.push(c);
          return c;
        },
      },
    });
    // two 240×440 frames side by side (density 10), each with a 96×176 proxy (density 4)
    const sheet = Object.assign(document.createElement('canvas'), { width: 480, height: 440 });
    const proxy = (): SpriteData => Array.from({ length: 176 }, () => Array<string>(96).fill(''));
    const [a, b] = [proxy(), proxy()];
    const rects = [0, 240].map((x) => ({
      src: sheet as HTMLCanvasElement,
      x,
      y: 0,
      w: 240,
      h: 440,
    }));
    markSmooth(a, rects[0]);
    markSmooth(b, rects[1]);
    const full = { width: 480, height: 440, getContext: () => ({}) };
    let asked = 0;
    let decoded: () => void = () => undefined;
    markRedecode(a, () => {
      asked++;
      return new Promise(
        (resolve) => (decoded = () => resolve(full as unknown as HTMLCanvasElement)),
      );
    });

    // zoom 2 then 4 (0.2, 0.4 of the master): halved once, never further, both frames move with it
    getCachedSprite(a, 0.5);
    getCachedSprite(a, 1);
    const half = rects[0].src as unknown as Fake;
    expect(half).not.toBe(sheet);
    expect([half.width, half.height, sheet.width]).toEqual([240, 220, 0]);
    expect(rects[1]).toMatchObject({ src: half, x: 120, w: 120, h: 220 });
    // the frame is copied out of the halved sheet before it is scaled (the same pixels as before)
    expect(draws.some((d) => d[0] === half && d[3] === 120 && d[7] === 120)).toBe(true);
    expect(peekSmooth(a, 1)).not.toBeNull();

    // zoom 8 (0.8): too coarse; it asks for the full sheet once and keeps nothing built meanwhile
    getCachedSprite(b, 2);
    getCachedSprite(b, 2);
    expect(asked).toBe(1);
    expect(peekSmooth(b, 2)).toBeNull();
    decoded();
    await Promise.resolve();
    await Promise.resolve();
    expect(rects[1]).toMatchObject({ src: full, x: 240, w: 240, h: 440 });
    expect(half.width).toBe(0);
    getCachedSprite(b, 2);
    expect(peekSmooth(b, 2)).not.toBeNull();
    // drawn close a moment ago, a small draw keeps it full; a minute later one halves it again
    getCachedSprite(b, 1);
    expect(rects[0].src).toBe(full);
    const now = performance.now();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(now + 61_000);
    getCachedSprite(b, 0.75);
    clock.mockRestore();
    expect(rects[0]).toMatchObject({ w: 120, h: 220 });
    expect(full.width).toBe(0);
  });

  it('negative control: a sheet nobody can decode again is never halved', () => {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createElement: () => ({
          width: 0,
          height: 0,
          getContext: () => ({ drawImage: () => undefined }),
        }),
      },
    });
    const sheet = Object.assign(document.createElement('canvas'), { width: 240, height: 440 });
    const p: SpriteData = Array.from({ length: 176 }, () => Array<string>(96).fill(''));
    const rect = { src: sheet as HTMLCanvasElement, x: 0, y: 0, w: 240, h: 440 };
    markSmooth(p, rect);
    getCachedSprite(p, 1);
    expect(rect.src).toBe(sheet);
    expect(sheet.width).toBe(240);
  });
});
