import { afterEach, describe, expect, it } from 'vitest';

import { SMOOTH_CACHE_MAX_BYTES, WALL_COLOR } from '../src/constants.js';
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

describe('SHEET-IMPORT: one master at every zoom', () => {
  type Call = { args: unknown[]; smoothing: boolean; mirrored: boolean };
  function install() {
    const draws: Call[] = [];
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createElement: () => {
          let mirrored = false;
          const context = {
            imageSmoothingEnabled: false,
            imageSmoothingQuality: 'low',
            fillStyle: '',
            fillRect: () => {
              throw new Error('a detailed frame is never filled pixel by pixel');
            },
            drawImage: (...args: unknown[]) =>
              draws.push({ args, smoothing: context.imageSmoothingEnabled, mirrored }),
            setTransform: (a: number) => (mirrored = a < 0),
            createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
            getImageData: (_x: number, _y: number, w: number, h: number) => ({
              data: new Uint8ClampedArray(w * h * 4),
            }),
            putImageData: () => undefined,
            save: () => undefined,
            restore: () => undefined,
          };
          return { width: 0, height: 0, getContext: () => context };
        },
      },
    });
    return draws;
  }

  it('draws a 64×128 frame from its mip chain with one drawImage per zoom, smooth down and nearest up, kept per zoom', async () => {
    const draws = install();
    const { markSmooth } = await import('../src/office/sprites/smoothSprite.js');
    const f = frame(64, 128);
    markSmooth(f);
    const half = getCachedSprite(f, 0.5);
    expect([half.width, half.height]).toEqual([32, 64]);
    // the chain halved only as deep as the zoom asks (once, to 32×64), then the picture from it
    expect(draws.length).toBe(2);
    expect(draws.at(-1)!.smoothing).toBe(true);
    expect(draws.at(-1)!.args.slice(3, 5)).toEqual([32, 64]);
    getCachedSprite(f, 3);
    expect(draws.at(-1)!.smoothing).toBe(false); // past 1:1: nearest
    const n = draws.length;
    // zooming back and forth builds nothing again
    getCachedSprite(f, 0.5);
    getCachedSprite(f, 3);
    expect(draws.length).toBe(n);
  });

  it("an imported frame's proxy draws its master's rect; a mirrored copy draws it mirrored", async () => {
    const draws = install();
    const { deriveSmooth, markSmooth } = await import('../src/office/sprites/smoothSprite.js');
    const sheet = document.createElement('canvas');
    const proxy = frame(64, 128);
    markSmooth(proxy, { src: sheet, x: 192, y: 384, w: 192, h: 384 });
    const pic = getCachedSprite(proxy, 1);
    expect([pic.width, pic.height]).toEqual([64, 128]);
    // from the 96×192 level (the smallest not under the display size), smoothly
    expect(draws.at(-1)!.args.slice(3, 9)).toEqual([96, 192, 0, 0, 64, 128]);
    const big = getCachedSprite(proxy, 4);
    expect([big.width, big.height]).toEqual([256, 512]);
    expect(draws.at(-1)!.args.slice(0, 5)).toEqual([sheet, 192, 384, 192, 384]);
    const mirrored = proxy.map((r) => [...r].reverse());
    deriveSmooth(proxy, mirrored, { mirror: true });
    getCachedSprite(mirrored, 1);
    expect(draws.at(-1)!.mirrored).toBe(true);
  });

  it('keeps the current zoom within the 48 MB byte cap too', async () => {
    install();
    const { markSmooth, smoothCacheBytes } = await import('../src/office/sprites/smoothSprite.js');
    const f = frame(64, 128);
    markSmooth(f);
    // The mock canvas does not allocate its backing store, but this displayed picture would be
    // 128 MB. It must be returned for the current draw without being retained in the zoom LRU.
    getCachedSprite(f, 64);
    expect(smoothCacheBytes()).toBeLessThanOrEqual(SMOOTH_CACHE_MAX_BYTES);
  });

  it('the office never builds a picture in its frame: an unbuilt one draws from the master, queued, and the queue drains on a busy frame too', async () => {
    const draws = install();
    const { drawSmooth, markSmooth, peekSmooth, pumpWarm, warmPending } =
      await import('../src/office/sprites/smoothSprite.js');
    const f = frame(64, 128);
    markSmooth(f);
    const ctx = document
      .createElement('canvas')
      .getContext('2d') as unknown as CanvasRenderingContext2D;
    const before = draws.length;
    drawSmooth(ctx, f, 0.75, 10, 20);
    // one scaled draw from the master (64×128 → 48×96), no picture made
    expect(draws.length - before).toBe(1);
    expect(draws.at(-1)!.args.slice(5, 9)).toEqual([10, 20, 48, 96]);
    expect(peekSmooth(f, 0.75)).toBeNull();
    // drawn again before it is built: still not queued twice
    drawSmooth(ctx, f, 0.75, 10, 20);
    expect(warmPending()).toBeGreaterThanOrEqual(1);
    // a frame that left no time over still builds one queued picture
    for (let n = 0; warmPending() && n < 10_000; n++) pumpWarm(0);
    expect(peekSmooth(f, 0.75)).not.toBeNull();
    drawSmooth(ctx, f, 0.75, 10, 20);
    expect(draws.at(-1)!.args[0]).toBe(peekSmooth(f, 0.75));
  });
});
