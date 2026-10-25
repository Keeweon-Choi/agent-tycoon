/**
 * Camera maths for the game-feel controls (T-0025): pure, no DOM, so the
 * webview's Node test runner covers it. Pan is in device pixels and is the
 * offset of the map's centre from the canvas centre (what panRef holds and
 * mapOffset() rounds to whole pixels, so sprites stay pixel-perfect however
 * the camera eases). Zoom is the integer device-pixels-per-sprite-pixel.
 */
import {
  FRAME_MAX_INSET_FRACTION,
  PAN_MARGIN_FRACTION,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_SCROLL_THRESHOLD,
} from '../constants.js';
import { TILE_SIZE } from '../office/types.js';

/** CSS px a pressed mouse may travel and still count as a click. */
export const DRAG_THRESHOLD_PX = 4;
/** Keyboard and edge-scroll pan speed, CSS px per second. */
export const PAN_SPEED_PX_S = 600;
/** How quickly that speed eases in and out (per second; ~0.2 s to full). */
export const PAN_EASE_PER_S = 14;
/** Width of the window-edge band that edge-scrolls, CSS px. */
export const EDGE_SCROLL_BAND_PX = 4;
/** Floor switch camera easing per second (mostly settled in about 0.25 s). */
export const FLOOR_GLIDE_PER_S = 10;
/** Wheel delta units per line / per page (deltaMode 1 / 2) — Firefox reports lines. */
const WHEEL_LINE_PX = 33;
const WHEEL_PAGE_PX = 800;

export interface Vec {
  x: number;
  y: number;
}
export interface Size {
  w: number;
  h: number;
}

export type CameraKey =
  'up' | 'down' | 'left' | 'right' | 'zoomIn' | 'zoomOut' | 'reset' | 'unfollow';

/** Symbols by the character they type (a layout puts + where it likes). */
const BY_KEY: Record<string, CameraKey> = {
  '+': 'zoomIn',
  '=': 'zoomIn',
  '-': 'zoomOut',
  _: 'zoomOut',
  '0': 'reset',
  Escape: 'unfollow',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};
/** Letters by position: WASD stays WASD under a Hangul IME (key 'ㅈ') or AZERTY. */
const BY_CODE: Record<string, CameraKey> = {
  KeyW: 'up',
  KeyS: 'down',
  KeyA: 'left',
  KeyD: 'right',
  NumpadAdd: 'zoomIn',
  NumpadSubtract: 'zoomOut',
  Numpad0: 'reset',
};

/** The camera action of a key press, or null. Chords are left alone: Ctrl+W,
 *  Ctrl+- and friends belong to the browser / the desktop app. */
export function cameraKey(e: {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): CameraKey | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  return BY_KEY[e.key] ?? BY_CODE[e.code] ?? null;
}

/** A press that moved this far is a drag (pan), not a click (select). */
export function isDrag(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) > DRAG_THRESHOLD_PX;
}

/** Integer zoom `steps` away, within the pixel-perfect range. */
export function stepZoom(zoom: number, steps: number): number {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(zoom) + steps));
}

/** The pan that keeps the world point under `anchor` (device px from the
 *  canvas centre) under it when zoom goes `from` → `to`. */
export function zoomAround(pan: Vec, anchor: Vec, from: number, to: number): Vec {
  const k = to / from;
  return { x: anchor.x - (anchor.x - pan.x) * k, y: anchor.y - (anchor.y - pan.y) * k };
}

/** Part of the map in tiles: a floor of the building (T-0027), from column 0. */
export interface MapPart {
  row: number;
  rows: number;
  cols: number;
}

/** The pan that puts the centre of `part` (the whole map by default) at the
 *  canvas centre. */
export function centerPan(
  map: { cols: number; rows: number },
  zoom: number,
  part?: MapPart | null,
): Vec {
  if (!part) return { x: 0, y: 0 };
  return {
    x: (map.cols / 2 - part.cols / 2) * TILE_SIZE * zoom,
    y: (map.rows / 2 - (part.row + part.rows / 2)) * TILE_SIZE * zoom,
  };
}

/** Shift `pan` right until a thing spanning device px [left, right] (where it
 *  is drawn at `pan`) starts at `minLeft`: its right end may then run past the
 *  canvas edge, but its start is never lost. A thing wider than the whole
 *  canvas (a phone) stays where it is. */
export function clearLeft(
  pan: Vec,
  span: { left: number; right: number },
  canvasW: number,
  minLeft: number,
): Vec {
  const dx = minLeft - span.left;
  return dx <= 0 || span.right - span.left > canvasW ? pan : { x: pan.x + dx, y: pan.y };
}

/** Keep the map (or the floor shown, `part`) from leaving the view: its edge
 *  stops PAN_MARGIN_FRACTION of the canvas inside the far side (upstream's
 *  rule, now shared and tested). */
export function clampPan(
  pan: Vec,
  canvas: Size,
  map: { cols: number; rows: number },
  zoom: number,
  part?: MapPart | null,
): Vec {
  const { cols, rows } = part ?? map;
  const c = centerPan(map, zoom, part);
  const maxX = (cols * TILE_SIZE * zoom) / 2 + canvas.w / 2 - canvas.w * PAN_MARGIN_FRACTION;
  const maxY = (rows * TILE_SIZE * zoom) / 2 + canvas.h / 2 - canvas.h * PAN_MARGIN_FRACTION;
  return {
    x: Math.max(c.x - maxX, Math.min(c.x + maxX, pan.x)),
    y: Math.max(c.y - maxY, Math.min(c.y + maxY, pan.y)),
  };
}

/** Wheel → whole zoom steps. Deltas build up (a trackpad sends many small
 *  ones, a mouse notch ~100) and each event zooms at most one step; a turn
 *  the other way starts over. Negative deltaY (wheel up / pinch out) zooms in. */
export function wheelZoom(
  acc: number,
  deltaY: number,
  deltaMode: number,
): { acc: number; steps: number } {
  const d = deltaY * (deltaMode === 1 ? WHEEL_LINE_PX : deltaMode === 2 ? WHEEL_PAGE_PX : 1);
  const sum = Math.sign(acc) === -Math.sign(d) ? d : acc + d;
  if (Math.abs(sum) < ZOOM_SCROLL_THRESHOLD) return { acc: sum, steps: 0 };
  return { acc: 0, steps: sum < 0 ? 1 : -1 };
}

/** Which way the held pan keys point (diagonals no faster than straight). */
export function keyDirection(held: ReadonlySet<CameraKey>): Vec {
  return unit({
    x: (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0),
    y: (held.has('down') ? 1 : 0) - (held.has('up') ? 1 : 0),
  });
}

/** Which way a pointer resting in the window's edge band scrolls. */
export function edgeDirection(p: Vec, view: Size): Vec {
  const axis = (v: number, size: number) =>
    v < EDGE_SCROLL_BAND_PX ? -1 : v >= size - EDGE_SCROLL_BAND_PX ? 1 : 0;
  return unit({ x: axis(p.x, view.w), y: axis(p.y, view.h) });
}

/** Ease the camera velocity toward `target`, frame-rate independent. */
export function easeVelocity(v: Vec, target: Vec, dt: number): Vec {
  const k = 1 - Math.exp(-PAN_EASE_PER_S * dt);
  const x = v.x + (target.x - v.x) * k;
  const y = v.y + (target.y - v.y) * k;
  // Settle instead of creeping on forever at sub-pixel speeds.
  return { x: Math.abs(x) < 1 ? 0 : x, y: Math.abs(y) < 1 ? 0 : y };
}

/** One frame toward the new floor centre, with an exact finish inside 1 px. */
export function glidePan(pan: Vec, target: Vec, dt: number): Vec {
  const k = 1 - Math.exp(-FLOOR_GLIDE_PER_S * dt);
  const x = pan.x + (target.x - pan.x) * k;
  const y = pan.y + (target.y - pan.y) * k;
  return {
    x: Math.abs(target.x - x) <= 1 ? target.x : x,
    y: Math.abs(target.y - y) <= 1 ? target.y : y,
  };
}

function unit(v: Vec): Vec {
  const len = Math.hypot(v.x, v.y);
  return len > 1 ? { x: v.x / len, y: v.y / len } : v;
}

// ── GFX camera modes: what Fit, Fill and Focus frame (pure) ──────────────

/** A rectangle: world px for the office, device px for the canvas view. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** Device px a HUD panel or safe area covers along each canvas side. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The part of the canvas no panel covers. Each side gives up at most
 *  FRAME_MAX_INSET_FRACTION, so a panel dragged across the middle never leaves no view. */
export function usableView(canvas: Size, insets: Insets): Box {
  const capW = canvas.w * FRAME_MAX_INSET_FRACTION;
  const capH = canvas.h * FRAME_MAX_INSET_FRACTION;
  const left = Math.min(Math.max(0, insets.left), capW);
  const right = Math.min(Math.max(0, insets.right), capW);
  const top = Math.min(Math.max(0, insets.top), capH);
  const bottom = Math.min(Math.max(0, insets.bottom), capH);
  return {
    x: left,
    y: top,
    w: Math.max(1, canvas.w - left - right),
    h: Math.max(1, canvas.h - top - bottom),
  };
}

/** Which side a panel covering device px `r` of canvas `c` hugs, and how far in it reaches. */
export function panelInset(c: Size, r: Box): { side: keyof Insets; px: number } | null {
  if (r.x >= c.w || r.y >= c.h || r.x + r.w <= 0 || r.y + r.h <= 0) return null;
  const reach: Array<[keyof Insets, number]> = [
    ['left', r.x + r.w],
    ['right', c.w - r.x],
    ['top', r.y + r.h],
    ['bottom', c.h - r.y],
  ];
  const [side, px] = reach.reduce((a, b) => (b[1] < a[1] ? b : a));
  return { side, px };
}

const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

/** Fit: the largest whole zoom at which all of `box` shows in `view` (never under ZOOM_MIN:
 *  a box too big even at 1 overflows and pans, it is never drawn blurred below one pixel). */
export function fitZoom(view: Size, box: Size, step = 1): number {
  const ratio = Math.min(view.w / box.w, view.h / box.h);
  // HD characters on screen (step 2): a zoom they divide into whole device px, when one fits.
  const whole = Math.floor(ratio / step) * step;
  return clampZoom(whole >= ZOOM_MIN ? whole : Math.floor(ratio));
}

/** Fill: the whole zoom nearest to the one where `box` just covers `view`, never less than
 *  Fit. Rounding (not ceil) keeps the crop at most half a step, so a box that covers at 2.1x
 *  is shown at 2 (a sliver of backdrop) rather than at 3 (a third cut off). */
export function fillZoom(view: Size, box: Size, step = 1): number {
  const cover = Math.max(view.w / box.w, view.h / box.h);
  const fit = fitZoom(view, box, step);
  const near = Math.max(step, Math.round(cover / step) * step);
  return Math.max(fit, near <= ZOOM_MAX ? near : clampZoom(Math.round(cover)));
}

/** The pan that frames `box` (world px) in `view` (device px of a `canvas`) at `zoom`: on an
 *  axis where the box fits it is centred; where it does not, `focus` (world px, the box's
 *  centre by default) is centred, but no further than keeps the box covering the view. */
export function framePan(
  map: { cols: number; rows: number },
  zoom: number,
  canvas: Size,
  view: Box,
  box: Box,
  focus?: Vec | null,
): Vec {
  const axis = (
    mapLen: number,
    canvasLen: number,
    v0: number,
    vLen: number,
    b0: number,
    bLen: number,
    f: number,
  ) => {
    const base = Math.floor((canvasLen - mapLen * TILE_SIZE * zoom) / 2); // projection.mapOffset at pan 0
    const size = bLen * zoom;
    let origin: number; // canvas px of world 0
    if (size <= vLen) origin = v0 + (vLen - size) / 2 - b0 * zoom;
    else {
      origin = v0 + vLen / 2 - f * zoom;
      origin = Math.min(v0 - b0 * zoom, Math.max(v0 + vLen - (b0 + bLen) * zoom, origin));
    }
    return Math.round(origin - base);
  };
  const fx = focus?.x ?? box.x + box.w / 2;
  const fy = focus?.y ?? box.y + box.h / 2;
  return {
    x: axis(map.cols, canvas.w, view.x, view.w, box.x, box.w, fx),
    y: axis(map.rows, canvas.h, view.y, view.h, box.y, box.h, fy),
  };
}

/** The office drawn on `rows` (world px): the columns and rows holding any tile, plus one
 *  tile above for the top row's wall tops. null when the rows are empty. */
export function officeBox<T>(tileMap: T[][], empty: T, rows?: MapPart | null): Box | null {
  const r0 = rows?.row ?? 0;
  const r1 = rows ? rows.row + rows.rows : tileMap.length;
  let minC = Infinity;
  let maxC = -1;
  let minR = Infinity;
  let maxR = -1;
  for (let r = Math.max(0, r0); r < Math.min(r1, tileMap.length); r++) {
    const row = tileMap[r];
    for (let c = 0; c < row.length; c++) {
      if (row[c] === empty) continue;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
      if (r < minR) minR = r;
      maxR = r;
    }
  }
  if (maxC < 0) return null;
  const top = Math.max(0, minR - 1);
  return {
    x: minC * TILE_SIZE,
    y: top * TILE_SIZE,
    w: (maxC - minC + 1) * TILE_SIZE,
    h: (maxR - top + 1) * TILE_SIZE,
  };
}
