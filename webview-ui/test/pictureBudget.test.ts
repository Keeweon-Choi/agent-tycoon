import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PICTURE_CACHE_MAX_BYTES,
  PICTURE_CANVAS_OVERHEAD_BYTES,
  WALL_COLOR,
} from '../src/constants.js';

/** PAGE-MEM: the one byte budget every rebuildable picture shares (pictureBudget.ts). */
const originalDocument = globalThis.document;

/** A document whose canvases are plain objects (no backing store): what was made is counted. */
function installCanvas() {
  const made = { canvases: 0 };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => {
        made.canvases++;
        const context = {
          imageSmoothingEnabled: false,
          fillStyle: '',
          fillRect: () => undefined,
          drawImage: () => undefined,
          createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
          putImageData: () => undefined,
        };
        return { width: 0, height: 0, getContext: () => context };
      },
    },
  });
  return made;
}

const frame = (w: number, h: number) =>
  Array.from({ length: h }, () => new Array<string>(w).fill(WALL_COLOR));

beforeEach(() => vi.resetModules());
afterEach(() => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
});

describe('the picture budget (PAGE-MEM)', () => {
  it('lets the least recently used go first, past the limit; a use makes one the most recent', async () => {
    const b = await import('../src/office/sprites/pictureBudget.js');
    b.setPictureLimit(300);
    const dropped: string[] = [];
    const [x, y, z] = [{}, {}, {}];
    b.keepPicture(x, 100, () => dropped.push('x'));
    b.pictureFrame();
    b.keepPicture(y, 100, () => dropped.push('y'));
    b.pictureFrame();
    b.keepPicture(z, 100, () => dropped.push('z'));
    b.pictureFrame();
    b.touchPicture(x); // x is now the most recent
    b.keepPicture({}, 100, () => dropped.push('w'));
    expect(dropped).toEqual(['y']);
    expect(b.pictureStats()).toMatchObject({ bytes: 300, count: 3, evicted: 1 });
  });

  it('never lets go of what the frame being drawn uses; what it needed past the limit goes at the next frame', async () => {
    const b = await import('../src/office/sprites/pictureBudget.js');
    b.setPictureLimit(100);
    const dropped: number[] = [];
    for (let i = 0; i < 5; i++) b.keepPicture({}, 100, () => dropped.push(i));
    expect(dropped).toEqual([]); // all five drawn in this frame
    expect(b.pictureStats().bytes).toBe(500);
    b.pictureFrame();
    expect(dropped).toEqual([0, 1, 2, 3]);
    expect(b.pictureStats().bytes).toBe(100);
  });

  it('the page hidden: everything but the last frame goes', async () => {
    const b = await import('../src/office/sprites/pictureBudget.js');
    const dropped: string[] = [];
    b.keepPicture({}, 10, () => dropped.push('old'));
    b.pictureFrame();
    const now = {};
    b.keepPicture(now, 10, () => dropped.push('now'));
    b.trimPictures();
    expect(dropped).toEqual(['old']);
    b.forgetPicture(now); // its cache let it go itself: no drop, no bytes
    expect(b.pictureStats()).toMatchObject({ bytes: 0, count: 0 });
  });

  it('a zoom sweep of classic characters stays within the budget, and a frame let go is built again', async () => {
    installCanvas();
    const b = await import('../src/office/sprites/pictureBudget.js');
    const { getCachedSprite } = await import('../src/office/sprites/spriteCache.js');
    // 30 characters × 36 frames × 2 facings, at every zoom of the wheel: ~200 MB of pictures
    const frames = Array.from({ length: 30 * 36 * 2 }, () => frame(16, 32));
    let built = 0;
    for (let zoom = 1; zoom <= 10; zoom++) {
      b.pictureFrame();
      for (const f of frames) getCachedSprite(f, zoom);
      built += frames.reduce((t, f) => t + f.length * f[0].length * zoom * zoom * 4, 0);
      built += frames.length * PICTURE_CANVAS_OVERHEAD_BYTES;
    }
    b.pictureFrame();
    expect(built).toBeGreaterThan(3 * PICTURE_CACHE_MAX_BYTES);
    expect(b.pictureStats().bytes).toBeLessThanOrEqual(PICTURE_CACHE_MAX_BYTES);
    // zoom 10 was the last drawn: its pictures stay; zoom 1's were let go and come back new
    const last = getCachedSprite(frames[0], 10);
    expect(getCachedSprite(frames[0], 10)).toBe(last);
    const first = getCachedSprite(frames[0], 1);
    expect([first.width, first.height]).toEqual([16, 32]);
  });

  it('negative control: without the budget the same sweep keeps every picture', async () => {
    installCanvas();
    const b = await import('../src/office/sprites/pictureBudget.js');
    b.setPictureLimit(Infinity);
    const { getCachedSprite } = await import('../src/office/sprites/spriteCache.js');
    const frames = Array.from({ length: 30 * 36 * 2 }, () => frame(16, 32));
    for (let zoom = 1; zoom <= 10; zoom++) {
      b.pictureFrame();
      for (const f of frames) getCachedSprite(f, zoom);
    }
    b.pictureFrame();
    // what the budget check above would have caught
    expect(b.pictureStats().bytes).toBeGreaterThan(PICTURE_CACHE_MAX_BYTES);
    expect(b.pictureStats().evicted).toBe(0);
  });
});
