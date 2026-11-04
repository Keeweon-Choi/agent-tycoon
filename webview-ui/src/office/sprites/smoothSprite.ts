/**
 * SHEET-IMPORT (owner 10-26 02:04, 02:09): one drawing at every zoom for detailed characters
 * (density 4 and up: the 64×128 bunny pack, imported sheets at density 12). Their frames are not
 * redrawn per pixel at each zoom, nor swapped for 32×64 / 16×32 copies: each frame has one master
 * (the imported sheet's own pixels, or the frame's pixels put once), a mip chain built once per
 * master by halving with smoothing, and a zoom's picture is one drawImage from the level just
 * above the display size (smoothing high), or nearest past 1:1. Those pictures, and the mip levels,
 * live in the picture budget's LRU (pictureBudget.ts, PAGE-MEM), so zooming back and forth does not
 * rebuild them while they fit, and a warm queue
 * builds a visible character's frames for the current zoom between frames (never mid-stride).
 *
 * A frame's SpriteData (what hit tests, outlines and the spawn effect read) stays as it is; for an
 * imported sheet it is a 64×128 proxy whose master is the sheet's 192×384 rect. A mirrored or
 * dimmed copy of a frame (`deriveSmooth`) keeps its master, mirrored or adjusted.
 */
import { perfCache } from '../../cld/perf.js';
import type { ColorValue } from '../../components/ui/types.js';
import {
  WARM_FORCE_EVERY,
  WARM_IDLE_SPARE_MS,
  WARM_SLICE_MS,
} from '../../constants.js';
import { adjustHex } from '../colorize.js';
import type { SpriteData } from '../types.js';
import {
  bakePicture,
  forgetPicture,
  keepPicture,
  type Picture,
  type PictureContext,
  pictureCost,
  touchPicture,
} from './pictureBudget.js';

/** A frame's pixels in a decoded sheet. */
export interface MasterRect {
  src: HTMLCanvasElement;
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Smooth {
  /** Its master in a decoded sheet, or null: then `own`'s pixels are (the frame it came from). */
  rect: MasterRect | null;
  own?: SpriteData;
  mirror: boolean;
  adjust?: ColorValue;
}
const smooth = new WeakMap<SpriteData, Smooth>();

export const isSmooth = (sprite: SpriteData): boolean => smooth.has(sprite);

/** Draw `sprite` the smooth way from now on (`rect`: its master in a sheet; null: itself). */
export function markSmooth(sprite: SpriteData, rect: MasterRect | null = null): void {
  if (!smooth.has(sprite))
    smooth.set(sprite, rect ? { rect, mirror: false } : { rect, own: sprite, mirror: false });
}

/** `to` is `from` mirrored and/or adjusted: it draws smooth too, from `from`'s master with the
 *  same change. A master-backed `to` needs no adjusted pixels of its own (`copyFor`). */
export function deriveSmooth(
  from: SpriteData,
  to: SpriteData,
  change: { mirror?: boolean; adjust?: ColorValue },
): void {
  const m = smooth.get(from);
  if (!m || smooth.has(to)) return;
  // the same master (a sheet's rect, or the first frame's own pixels), mirrored or adjusted when
  // drawn: a dimmed or mirrored copy never needs pixels of its own
  smooth.set(to, {
    ...m,
    mirror: m.mirror !== !!change.mirror,
    adjust: change.adjust ?? m.adjust,
  });
}

interface Level {
  img: CanvasImageSource;
  x: number;
  y: number;
  w: number;
  h: number;
}

const canvas = (w: number, h: number) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

/** A sprite's own pixels on a canvas (once). */
const own = new WeakMap<SpriteData, HTMLCanvasElement>();
function ownCanvas(sprite: SpriteData): HTMLCanvasElement {
  let c = own.get(sprite);
  if (c) return c;
  const [w, h] = [sprite[0]?.length ?? 0, sprite.length];
  c = canvas(w, h);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = sprite[y][x];
      if (!p) continue;
      const v = parseInt(p.slice(1, 7), 16);
      img.data.set(
        [v >> 16, (v >> 8) & 255, v & 255, p.length > 7 ? parseInt(p.slice(7, 9), 16) : 255],
        (y * w + x) * 4,
      );
    }
  ctx.putImageData(img, 0, 0);
  own.set(sprite, c);
  perfCache(w * h * 4);
  return c;
}

/** The mip chain of a master (level 0 the master itself), built as deep as a zoom asks
 *  (`levelFor`); the levels past 0 are one entry of the picture budget, let go together. */
const chains = new WeakMap<object, Level[]>();
/** Chains with levels past 0, by their master's source (releaseMaster lets them go). */
const chainSrc = new Map<Level[], CanvasImageSource>();
function chainOf(sprite: SpriteData, m: Smooth): Level[] {
  const owner: object = m.rect ?? m.own ?? sprite;
  const have = chains.get(owner);
  if (have) return have;
  const base: Level = m.rect
    ? { img: m.rect.src, x: m.rect.x, y: m.rect.y, w: m.rect.w, h: m.rect.h }
    : {
        img: ownCanvas(m.own ?? sprite),
        x: 0,
        y: 0,
        w: (m.own ?? sprite)[0]?.length ?? 0,
        h: (m.own ?? sprite).length,
      };
  const levels = [base];
  chains.set(owner, levels);
  return levels;
}

/** The smallest level of `levels` still at least `w`×`h`, halving further first when the last
 *  one is still twice that (each halving an average of 2×2 pixels: bilinear at exactly half). */
function levelFor(levels: Level[], w: number, h: number): Level {
  let grew = false;
  for (let l = levels[levels.length - 1]; l.w >= w * 2 && l.h >= h * 2;) {
    const from = l;
    const c = bakePicture(Math.round(l.w / 2), Math.round(l.h / 2), (ctx) => {
      // exactly half: bilinear is the 2×2 average (PAGE-MEM: 'medium' had the canvas also keep a
      // mipmap of the whole source sheet)
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'low';
      ctx.drawImage(from.img, from.x, from.y, from.w, from.h, 0, 0, c0(from.w), c0(from.h));
    });
    perfCache(c.width * c.height * 4);
    l = { img: c, x: 0, y: 0, w: c.width, h: c.height };
    levels.push(l);
    grew = true;
  }
  if (grew) {
    chainSrc.set(levels, levels[0].img);
    let bytes = 0;
    for (const l of levels.slice(1)) bytes += pictureCost(l.img as Picture);
    keepPicture(levels, bytes, () => {
      levels.length = 1;
      chainSrc.delete(levels);
    });
  } else if (levels.length > 1) touchPicture(levels);
  let pick = levels[0];
  for (const next of levels) if (next.w >= w && next.h >= h) pick = next;
  return pick;
}

/** Half a level's side, as levelFor makes it. */
const c0 = (side: number) => Math.round(side / 2);

/** A picture's pixels adjusted as adjustSprite would (the idle dim), in place: at the display
 *  size, so it costs what is drawn, not the master. */
function adjustPicture(ctx: PictureContext, w: number, h: number, color: ColorValue) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const seen = new Map<number, number>();
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    let v = seen.get(k);
    if (v === undefined) {
      v = parseInt(adjustHex(d[i], d[i + 1], d[i + 2], color).slice(1), 16);
      seen.set(k, v);
    }
    [d[i], d[i + 1], d[i + 2]] = [v >> 16, (v >> 8) & 255, v & 255];
  }
  ctx.putImageData(img, 0, 0);
}

/** A copy of a master-backed frame to adjust (its rows shared: what hit tests read is the same;
 *  the picture is adjusted when drawn), or null when its pixels must be adjusted themselves. */
export const copyFor = (sprite: SpriteData): SpriteData | null =>
  smooth.has(sprite) ? sprite.slice() : null;

// ── each zoom's pictures (their bytes are the picture budget's) ──

const byZoom = new Map<number, Map<SpriteData, Picture>>();

/** LOOKS-MEM: the decoded sheet `sprite`'s master is in, let go (no character wears it): every
 *  picture cut from it leaves the zoom LRU and the canvas gives its memory back now (width 0;
 *  Safari frees a canvas only when it is collected). A frame of it drawn later draws nothing. */
const released = new WeakSet<HTMLCanvasElement>();
const isReleased = (m: Smooth) => !!m.rect && released.has(m.rect.src);
export function releaseMaster(sprite: SpriteData): void {
  const src = smooth.get(sprite)?.rect?.src;
  if (!src) return;
  released.add(src);
  for (const pics of byZoom.values())
    for (const [s, pic] of pics) {
      if (smooth.get(s)?.rect?.src !== src) continue;
      pics.delete(s);
      forgetPicture(pic);
    }
  for (const [levels, from] of chainSrc)
    if (from === src) {
      forgetPicture(levels);
      levels.length = 1;
      chainSrc.delete(levels);
    }
  src.width = src.height = 0;
}

/** The size `sprite` draws at `zoom` (device px). */
export const smoothSize = (sprite: SpriteData, zoom: number): [number, number] => [
  Math.max(1, Math.round((sprite[0]?.length ?? 0) * zoom)),
  Math.max(1, Math.round(sprite.length * zoom)),
];

/** `sprite`'s picture at `zoom` when built, else null (nothing is built). */
export function peekSmooth(sprite: SpriteData, zoom: number): Picture | null {
  return byZoom.get(zoom)?.get(sprite) ?? null;
}

/** When the office last drew at each zoom (a missed picture of a zoom it left is not built). */
const zoomSeen = new Map<number, number>();
const MISSED_STALE_MS = 1000;
/** Pictures the office drew before they were built: queued once each. */
const missed = { owner: {} as object, keys: new Set<string>(), jobs: [] as Array<() => void> };
let missedId = 0;
const missIds = new WeakMap<SpriteData, number>();

/**
 * The office's draw of a detailed frame (SHEET-IMPORT, owner 10-26: no build mid-stride, no
 * burst on a zoom step): its built picture, or, while that is not built, its master's nearest
 * level drawn straight to the size (one scaled drawImage; an idle dim shows a moment late) with
 * the picture queued for the warm queue.
 */
export function drawSmooth(
  ctx: CanvasRenderingContext2D,
  sprite: SpriteData,
  zoom: number,
  x: number,
  y: number,
): void {
  const pic = peekSmooth(sprite, zoom);
  if (pic) {
    touchPicture(pic);
    ctx.drawImage(pic, x, y);
    return;
  }
  const m = smooth.get(sprite)!;
  if (isReleased(m)) return; // its sheet was let go (releaseMaster)
  const levels = chainOf(sprite, m);
  const [W, H] = smoothSize(sprite, zoom);
  const l = levelFor(levels, W, H);
  const up = W >= levels[0].w;
  ctx.save();
  ctx.imageSmoothingEnabled = !up;
  if (!up) ctx.imageSmoothingQuality = 'medium';
  if (m.mirror) ctx.setTransform(-1, 0, 0, 1, x + W, y);
  ctx.drawImage(l.img, l.x, l.y, l.w, l.h, m.mirror ? 0 : x, m.mirror ? 0 : y, W, H);
  ctx.restore();
  zoomSeen.set(zoom, performance.now());
  let id = missIds.get(sprite);
  if (id === undefined) missIds.set(sprite, (id = missedId++));
  const key = `${id}@${zoom}`;
  if (missed.keys.has(key)) return;
  missed.keys.add(key);
  queueMissed(() => {
    missed.keys.delete(key);
    // a zoom the office has left (a zoom sweep's steps): not built
    if (performance.now() - (zoomSeen.get(zoom) ?? 0) <= MISSED_STALE_MS)
      smoothPicture(sprite, zoom);
  });
}

/** `sprite` (marked smooth) drawn `zoom` device px per sprite px: cached per zoom (the picture
 *  budget's LRU). */
export function smoothPicture(sprite: SpriteData, zoom: number): Picture {
  let pics = byZoom.get(zoom);
  if (!pics) byZoom.set(zoom, (pics = new Map()));
  const have = pics.get(sprite);
  if (have) {
    touchPicture(have);
    return have;
  }
  const m = smooth.get(sprite)!;
  const W = Math.max(1, Math.round((sprite[0]?.length ?? 0) * zoom));
  const H = Math.max(1, Math.round(sprite.length * zoom));
  if (isReleased(m)) return canvas(W, H); // its sheet was let go: blank, not kept
  const levels = chainOf(sprite, m);
  // the smallest level still at least the display size (past the master: the master, nearest)
  const l = levelFor(levels, W, H);
  const up = W >= levels[0].w;
  const pic = bakePicture(W, H, (ctx) => {
    ctx.imageSmoothingEnabled = !up;
    // under 2:1 from the level above: bilinear is all of it (high asks a software canvas a lot)
    if (!up) ctx.imageSmoothingQuality = 'medium';
    if (m.mirror) ctx.setTransform(-1, 0, 0, 1, W, 0);
    ctx.drawImage(l.img, l.x, l.y, l.w, l.h, 0, 0, W, H);
    if (m.adjust) adjustPicture(ctx, W, H, m.adjust);
  });
  pics.set(sprite, pic);
  const zoomPics = pics;
  keepPicture(pic, pictureCost(pic), () => {
    zoomPics.delete(sprite);
    if (!zoomPics.size && byZoom.get(zoom) === zoomPics) byZoom.delete(zoom);
  });
  perfCache(W * H * 4);
  return pic;
}

// ── warming ──────────────────────────────────────────────────

/** Pictures to build between frames, per owner (a character, a warm-up batch), oldest owner
 *  first. An owner queued again for another zoom replaces its jobs: a zoom sweep never piles up
 *  builds for zooms already left. */
const queue = new Map<object, Array<() => void>>();
const warmed = new WeakMap<object, number>();
let pending = 0;
/** Builds run so far (BOOT-LOAD: the queue runs oldest owner first, so once this has grown by what
 *  was pending at some moment, everything queued by then is built). */
let ran = 0;
let idleAsked = false;

function clearQueuedWarm(owner: object): void {
  pending -= queue.get(owner)?.length ?? 0;
  queue.delete(owner);
}

/** Drop an owner that left the office or changed sheets, including its no-longer-useful jobs. */
export function forgetWarm(owner: object): void {
  clearQueuedWarm(owner);
  warmed.delete(owner);
}

/** Queue `builds()` for `owner` at `zoom` once (a character's frames, built a slice at a time). */
export function warmOnce(owner: object, zoom: number, builds: () => Array<() => void>): void {
  if (warmed.get(owner) === zoom) return;
  warmed.set(owner, zoom);
  clearQueuedWarm(owner);
  const jobs = builds();
  if (!jobs.length) return;
  queue.set(owner, jobs);
  pending += jobs.length;
  askIdle();
}

/** One queued build (false: none left). */
function runOne(): boolean {
  for (const [owner, jobs] of queue) {
    const job = jobs.shift();
    if (!jobs.length) queue.delete(owner);
    if (!job) continue;
    pending--;
    ran++;
    job();
    return true;
  }
  return false;
}

/** Run queued builds while `budgetMs` lasts (the game loop gives what its frame left over); on a
 *  frame that left nothing over, one build every WARM_FORCE_EVERY frames: a slow device still
 *  gets its pictures (the queue drains instead of standing) without a build in every frame. */
let starved = 0;
export function pumpWarm(budgetMs = WARM_SLICE_MS): number {
  const t0 = performance.now();
  let done = 0;
  const force = budgetMs <= 0 && ++starved >= WARM_FORCE_EVERY;
  if (force) starved = 0;
  while ((force ? done === 0 : performance.now() - t0 < budgetMs) && runOne()) done++;
  return done;
}

function queueMissed(job: () => void): void {
  const jobs = queue.get(missed.owner);
  if (jobs) jobs.push(job);
  else queue.set(missed.owner, [job]);
  pending++;
  askIdle();
}

export const warmPending = (): number => pending;
export const warmRan = (): number => ran;

function askIdle(): void {
  if (idleAsked || typeof requestIdleCallback !== 'function') return;
  idleAsked = true;
  requestIdleCallback((deadline) => {
    idleAsked = false;
    const t0 = performance.now();
    while (
      deadline.timeRemaining() > WARM_IDLE_SPARE_MS &&
      performance.now() - t0 < WARM_SLICE_MS &&
      runOne()
    );
    if (pending) askIdle();
  });
}
