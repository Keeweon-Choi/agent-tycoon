import { perfCache } from '../../cld/perf.js';
import type { SpriteData } from '../types.js';

const zoomCaches = new Map<number, WeakMap<SpriteData, HTMLCanvasElement>>();

// ── Outline sprite generation ─────────────────────────────────

const outlineCache = new WeakMap<SpriteData, SpriteData>();

/** Generate a 1px white outline SpriteData (2px larger in each dimension) */
export function getOutlineSprite(sprite: SpriteData): SpriteData {
  const cached = outlineCache.get(sprite);
  if (cached) return cached;

  const rows = sprite.length;
  const cols = sprite[0].length;
  // Expanded grid: +2 in each dimension for 1px border
  const outline: string[][] = [];
  for (let r = 0; r < rows + 2; r++) {
    outline.push(new Array<string>(cols + 2).fill(''));
  }

  // For each opaque pixel, mark its 4 cardinal neighbors as white
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (sprite[r][c] === '') continue;
      const er = r + 1;
      const ec = c + 1;
      if (outline[er - 1][ec] === '') outline[er - 1][ec] = '#FFFFFF';
      if (outline[er + 1][ec] === '') outline[er + 1][ec] = '#FFFFFF';
      if (outline[er][ec - 1] === '') outline[er][ec - 1] = '#FFFFFF';
      if (outline[er][ec + 1] === '') outline[er][ec + 1] = '#FFFFFF';
    }
  }

  // Clear pixels that overlap with original opaque pixels
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (sprite[r][c] !== '') {
        outline[r + 1][c + 1] = '';
      }
    }
  }

  outlineCache.set(sprite, outline);
  return outline;
}

/** `sprite` drawn at `zoom` device px per sprite px. A fractional zoom (an HD character, two
 *  sprite px per world px, at an odd world zoom) is nearest-neighbour: each sprite px covers the
 *  device px between its rounded edges, so the pixels are 2 or 3 wide at 2.5, never blended.
 *  A whole zoom draws exactly as before. */
export function getCachedSprite(sprite: SpriteData, zoom: number): HTMLCanvasElement {
  let cache = zoomCaches.get(zoom);
  if (!cache) {
    cache = new WeakMap();
    zoomCaches.set(zoom, cache);
  }

  const cached = cache.get(sprite);
  if (cached) return cached;

  const rows = sprite.length;
  const cols = sprite[0].length;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(cols * zoom);
  canvas.height = Math.round(rows * zoom);
  const edge = (i: number) => Math.round(i * zoom);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  // HD64-SAMPLE: a large sprite (an HD character frame) at a whole zoom is put once at its own
  // size and drawn scaled, nearest: the same pixels as a fill per sprite pixel, a fraction of the
  // calls (a 64×128 frame is 8192 fills). Classic sprites keep the fills.
  if (rows >= HD_SPRITE_ROWS && Number.isInteger(zoom) && putScaled(ctx, sprite, zoom)) {
    cache.set(sprite, canvas);
    perfCache(canvas.width * canvas.height * 4);
    return canvas;
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const color = sprite[r][c];
      if (color === '') continue;
      ctx.fillStyle = color;
      const x = edge(c);
      const y = edge(r);
      ctx.fillRect(x, y, edge(c + 1) - x, edge(r + 1) - y);
    }
  }

  cache.set(sprite, canvas);
  perfCache(canvas.width * canvas.height * 4);
  return canvas;
}

/** Sprites this tall or taller (HD 32×64 and up) are cached by putScaled. */
const HD_SPRITE_ROWS = 64;
const HEX = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i;
/** The sprite's pixels as image data, drawn `zoom` times larger (nearest) onto `ctx`; false when
 *  a colour is not #RRGGBB(AA) (the caller then fills as before). */
function putScaled(ctx: CanvasRenderingContext2D, sprite: SpriteData, zoom: number): boolean {
  const rows = sprite.length;
  const cols = sprite[0].length;
  const src = document.createElement('canvas');
  src.width = cols;
  src.height = rows;
  const sctx = src.getContext('2d');
  if (!sctx) return false;
  const img = sctx.createImageData(cols, rows);
  const seen = new Map<string, number[]>();
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const color = sprite[r][c];
      if (color === '') continue;
      let rgba = seen.get(color);
      if (!rgba) {
        const m = HEX.exec(color);
        if (!m) return false;
        const v = parseInt(m[1], 16);
        rgba = [v >> 16, (v >> 8) & 255, v & 255, m[2] ? parseInt(m[2], 16) : 255];
        seen.set(color, rgba);
      }
      img.data.set(rgba, (r * cols + c) * 4);
    }
  sctx.putImageData(img, 0, 0);
  ctx.drawImage(src, 0, 0, cols * zoom, rows * zoom);
  return true;
}
