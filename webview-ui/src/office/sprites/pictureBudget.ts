/**
 * PAGE-MEM (owner 11-04 21:13, "원격 프로그램에서는 2기가 먹고 있는데?"): one byte budget for every
 * picture the office builds from sprites and can build again: each zoom's character and furniture
 * frames (spriteCache.ts), the detailed characters' pictures and mip levels (smoothSprite.ts), and
 * whatever else (the loading screen's warm-up) builds through them. Before, each zoom kept its own
 * set for good, so a minute of zooming and floor changes left thousands of canvases behind.
 *
 * One LRU (Map order: least recently used first) over all of them, bounded by
 * PICTURE_CACHE_MAX_BYTES, each picture counted with what it costs besides its pixels. A picture
 * used in the frame being drawn is never let go: when one frame needs more than the budget, the
 * rest go and the frame's own pictures stay until the next. A let-go picture is only forgotten
 * (whoever still holds it may draw it); the cache that owned it builds it again when asked.
 *
 * Pictures are ImageBitmaps where the browser makes them synchronously (OffscreenCanvas): a
 * quarter of a canvas's own cost; else canvases.
 */
import {
  PICTURE_BITMAP_OVERHEAD_BYTES,
  PICTURE_CACHE_MAX_BYTES,
  PICTURE_CANVAS_OVERHEAD_BYTES,
} from '../../constants.js';

export type Picture = HTMLCanvasElement | ImageBitmap;
export type PictureContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

interface Entry {
  bytes: number;
  frame: number;
  drop: () => void;
}
const lru = new Map<object, Entry>();
let total = 0;
let frame = 0;
let limit = PICTURE_CACHE_MAX_BYTES;
let evicted = 0;

/** What `pic` costs: its pixels and its own overhead. */
export const pictureCost = (pic: Picture): number =>
  pic.width * pic.height * 4 +
  (typeof ImageBitmap !== 'undefined' && pic instanceof ImageBitmap
    ? PICTURE_BITMAP_OVERHEAD_BYTES
    : PICTURE_CANVAS_OVERHEAD_BYTES);

/** The office starts drawing a frame: what it uses from now on is this frame's, and what the
 *  last one needed past the budget goes now. */
export function pictureFrame(): void {
  frame++;
  trim();
}

function trim(): void {
  for (const [key, e] of lru) {
    if (total <= limit || e.frame === frame) break; // the rest were used in this frame too
    lru.delete(key);
    total -= e.bytes;
    evicted++;
    e.drop();
  }
}

/** Count `key`'s picture (`bytes`); `drop` forgets it in the cache that holds it. */
export function keepPicture(key: object, bytes: number, drop: () => void): void {
  const had = lru.get(key);
  if (had) {
    lru.delete(key);
    total -= had.bytes;
  }
  lru.set(key, { bytes, frame, drop });
  total += bytes;
  trim();
}

/** `key`'s picture was just used: it is the most recent. */
export function touchPicture(key: object): void {
  const e = lru.get(key);
  if (!e || e.frame === frame) return;
  lru.delete(key);
  e.frame = frame;
  lru.set(key, e);
}

/** The cache let `key`'s picture go itself (a sheet let go): no longer counted. */
export function forgetPicture(key: object): void {
  const e = lru.get(key);
  if (!e) return;
  lru.delete(key);
  total -= e.bytes;
}

/** Let go of every picture the last frame did not use (the page went to the background). */
export function trimPictures(): void {
  for (const [key, e] of lru) {
    if (e.frame === frame) continue;
    lru.delete(key);
    total -= e.bytes;
    evicted++;
    e.drop();
  }
}

/** The budget now (the performance readout, the runners, the tests). */
export const pictureStats = () => ({ bytes: total, count: lru.size, limit, evicted });

/** Tests: another budget (no argument: the default). */
export function setPictureLimit(bytes = PICTURE_CACHE_MAX_BYTES): void {
  limit = bytes;
  trim();
}

let scratch: OffscreenCanvas | null | undefined;
/** A `w`×`h` picture `paint` draws: an ImageBitmap off one reused OffscreenCanvas where the
 *  browser has one, else a canvas of its own. */
export function bakePicture(w: number, h: number, paint: (ctx: PictureContext) => void): Picture {
  if (scratch === undefined)
    try {
      scratch =
        typeof OffscreenCanvas === 'function' &&
        typeof OffscreenCanvas.prototype.transferToImageBitmap === 'function'
          ? new OffscreenCanvas(1, 1)
          : null;
    } catch {
      scratch = null;
    }
  const ctx = scratch?.getContext('2d');
  if (scratch && ctx) {
    scratch.width = w; // also clears it and its state
    scratch.height = h;
    ctx.imageSmoothingEnabled = false;
    paint(ctx);
    return scratch.transferToImageBitmap();
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const cctx = c.getContext('2d')!;
  cctx.imageSmoothingEnabled = false;
  paint(cctx);
  return c;
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function')
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') trimPictures();
  });
