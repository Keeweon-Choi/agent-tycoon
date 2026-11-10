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
import { perfCache } from '../../agent-tycoon/perf.js';
import type { ColorValue } from '../../components/ui/types.js';
import {
  SHEET_MASTER_MIN_SCALE,
  SHEET_MASTER_SHRINK_MS,
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
  if (smooth.has(sprite)) return;
  smooth.set(sprite, rect ? { rect, mirror: false } : { rect, own: sprite, mirror: false });
  if (!rect) return;
  const sheet = sheetOfSrc.get(rect.src);
  if (sheet) sheet.rects.push(rect);
  else sheetOfSrc.set(rect.src, { rects: [rect], scale: 1, largeAt: -Infinity });
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

// ── PERF-WEBVIEW-MEMORY: a decoded sheet kept no denser than the office draws it ──

/**
 * The owner's desktop app held 1.3 GB (11-06 20:19); each worn imported sheet's masters were a
 * ~19 MB canvas at the closest zoom's density (IMPORT_MASTER_DENSITY), while zoom 5 and under only
 * ever read their first mip level (half that density) or smaller. So a sheet drawn at half its
 * density or less, and not larger for SHEET_MASTER_SHRINK_MS (a close zoom, the camera's framing at
 * the start), is halved in place, once (SHEET_MASTER_MIN_SCALE: the same
 * exactly-half bilinear levelFor makes per frame, over the whole sheet: the same pixels, a quarter
 * of the memory), and decoded again at full density (`redecode`, looks.ts) the first time the
 * office draws it larger than that (a zoom past 5). Only a sheet that can be decoded again is
 * ever halved.
 */
interface SheetMasters {
  /** Every frame's rect in the sheet (they all move with it). */
  rects: MasterRect[];
  /** The share of the decoded master kept now: 1, 1/2, 1/4... */
  scale: number;
  /** When the office last drew it larger than SHEET_MASTER_MIN_SCALE (a close zoom). */
  largeAt: number;
  /** The master again at full density (set by the loader; none: never halved). */
  redecode?: () => Promise<HTMLCanvasElement>;
  /** A redecode is on its way. */
  densifying?: boolean;
}
const sheetOfSrc = new WeakMap<HTMLCanvasElement, SheetMasters>();
/** The sheets halve() made (levelFor copies their frames out before scaling them). */
const halved = new WeakSet<CanvasImageSource>();

/** The loader can decode `sprite`'s sheet again at full density: it may be kept halved meanwhile. */
export function markRedecode(sprite: SpriteData, redecode: () => Promise<HTMLCanvasElement>): void {
  const src = smooth.get(sprite)?.rect?.src;
  const sheet = src && sheetOfSrc.get(src);
  if (sheet) sheet.redecode = redecode;
}

/** Every rect of `sheet` moves to `next` (scaled by `f`); the mip chains cut from the old one go. */
function retarget(sheet: SheetMasters, next: HTMLCanvasElement, f: number): void {
  const old = sheet.rects[0].src;
  for (const r of sheet.rects) {
    [r.src, r.x, r.y, r.w, r.h] = [next, r.x * f, r.y * f, r.w * f, r.h * f];
    chains.delete(r);
  }
  for (const [levels, from] of chainSrc)
    if (from === old) {
      forgetPicture(levels);
      chainSrc.delete(levels);
    }
  sheetOfSrc.delete(old);
  sheetOfSrc.set(next, sheet);
  old.width = old.height = 0; // its memory back now
}

const even = (n: number) => n % 2 === 0;
/** Halving keeps every frame on whole pixels, as levelFor's own halving does. */
const halvable = (sheet: SheetMasters) =>
  sheet.rects.every((r) => even(r.x) && even(r.y) && even(r.w) && even(r.h)) &&
  even(sheet.rects[0].src.width) &&
  even(sheet.rects[0].src.height);

function halve(sheet: SheetMasters): void {
  const old = sheet.rects[0].src;
  const half = canvas(old.width / 2, old.height / 2);
  const ctx = half.getContext('2d')!;
  // exactly half: bilinear is the 2×2 average, levelFor's first level of every frame at once
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  ctx.drawImage(old, 0, 0, half.width, half.height);
  halved.add(half);
  retarget(sheet, half, 1 / 2);
  sheet.scale /= 2;
}

function densify(sheet: SheetMasters): void {
  if (sheet.densifying || !sheet.redecode) return;
  sheet.densifying = true;
  sheet.redecode().then(
    (full) => {
      sheet.densifying = false;
      const now = sheet.rects[0].src;
      if (released.has(now)) {
        full.width = full.height = 0;
        return;
      }
      retarget(sheet, full, 1 / sheet.scale);
      sheet.scale = 1;
    },
    (err: unknown) => console.warn('[Webview] a character sheet could not be decoded again', err),
  );
}

/** `m` is about to be drawn `w` device px wide: its sheet is halved while it is drawn at half or
 *  less, or decoded again when drawn larger than kept. false while it is too coarse for `w` (its
 *  full copy on the way): nothing built from it then is kept. */
function masterFits(m: Smooth, w: number): boolean {
  const sheet = m.rect && sheetOfSrc.get(m.rect.src);
  if (!sheet?.redecode) return true;
  const share = (w / m.rect!.w) * sheet.scale;
  const now = performance.now();
  if (share > SHEET_MASTER_MIN_SCALE) sheet.largeAt = now;
  if (share > sheet.scale) {
    densify(sheet);
    return false;
  }
  if (sheet.scale === 1 && now - sheet.largeAt > SHEET_MASTER_SHRINK_MS && halvable(sheet))
    halve(sheet);
  return true;
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
  // PERF-WEBVIEW-MEMORY: a frame of a halved sheet is copied out first, as its first level was
  // made on its own before: a scaled draw from part of a sheet skips the mipmap a whole picture
  // gets, which drew zoom 3 with other pixels.
  if (levels.length === 1 && halved.has(levels[0].img) && w < levels[0].w) {
    const from = levels[0];
    const c = bakePicture(from.w, from.h, (ctx) => {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(from.img, from.x, from.y, from.w, from.h, 0, 0, from.w, from.h);
    });
    levels.push({ img: c, x: 0, y: 0, w: c.width, h: c.height });
    grew = true;
  }
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
  sheetOfSrc.delete(src);
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
  const [W, H] = smoothSize(sprite, zoom);
  const fits = masterFits(m, W);
  const levels = chainOf(sprite, m);
  const l = levelFor(levels, W, H);
  const up = W >= levels[0].w;
  ctx.save();
  ctx.imageSmoothingEnabled = !up;
  if (!up) ctx.imageSmoothingQuality = 'medium';
  if (m.mirror) ctx.setTransform(-1, 0, 0, 1, x + W, y);
  ctx.drawImage(l.img, l.x, l.y, l.w, l.h, m.mirror ? 0 : x, m.mirror ? 0 : y, W, H);
  ctx.restore();
  if (!fits) return; // its full copy is on the way: built then
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
  const fits = masterFits(m, W);
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
  if (!fits) return pic; // drawn from a coarser master than it needs: not kept
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
