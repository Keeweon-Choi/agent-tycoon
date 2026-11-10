import type { OfficeState } from '../office/engine/officeState.js';
import { renderFrame } from '../office/engine/renderer.js';
import type { OfficeLayout } from '../office/types.js';
import { TileType } from '../office/types.js';
import {
  currentRect,
  floorClip,
  floorRects,
  floorsSnapshot,
  floorView,
  stackShifts,
} from './floors.js';

/** Other floors' opacity in the stacked view. */
export const OTHER_FLOOR_ALPHA = 0.4;
/** Other floors are refreshed at 2 fps while the camera is still. */
export const OTHER_FLOOR_REFRESH_MS = 500;
/** Read-only test hook counters for redraw cost. */
export const otherFloorStats = { renders: 0, ms: 0 };

let layer: HTMLCanvasElement | null = null;
let lastKey = '';
let lastLayout: OfficeLayout | null = null;
let lastTileMap: OfficeState['tileMap'] | null = null;
let lastAt = -Infinity;

/** Draw all floors except the current one as one cached, translucent layer. */
export function drawOtherFloors(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  zoom: number,
  pan: { x: number; y: number },
  layout: OfficeLayout,
  officeState: OfficeState,
  showAreas: boolean,
  now: number,
): void {
  if (!floorsSnapshot().stacked) {
    // 한 층만: give the cached layer's pixels back (about 12 MB on a 3x phone).
    if (layer) layer = null;
    lastKey = '';
    return;
  }
  const rects = floorRects(layout);
  const current = currentRect(layout);
  if (!rects || !current) return;
  const currentIndex = rects.indexOf(current);
  const shifts = stackShifts(rects, currentIndex);
  if (!layer) layer = document.createElement('canvas');
  const key = `${w}x${h}|${zoom}|${Math.round(pan.x)},${Math.round(pan.y)}|${current.id}`;
  if (
    key !== lastKey ||
    layout !== lastLayout ||
    officeState.tileMap !== lastTileMap ||
    now - lastAt >= OTHER_FLOOR_REFRESH_MS
  ) {
    const started = performance.now();
    if (layer.width !== w) layer.width = w;
    if (layer.height !== h) layer.height = h;
    const lctx = layer.getContext('2d');
    if (!lctx) return;
    lctx.imageSmoothingEnabled = false;
    lctx.clearRect(0, 0, w, h);
    for (let k = 0; k < rects.length; k++) {
      if (k === currentIndex) continue;
      const p = { x: pan.x, y: pan.y + shifts[k] * zoom };
      const view = floorView(officeState.tileMap, layout.areaTiles, rects[k], TileType.VOID);
      const clip = floorClip(rects[k], layout, { w, h }, zoom, p)!;
      lctx.save();
      lctx.beginPath();
      lctx.rect(clip.x, clip.y, clip.w, clip.h);
      lctx.clip();
      renderFrame(
        lctx,
        w,
        h,
        view.tileMap,
        officeState.furniture,
        officeState.getCharacters(),
        zoom,
        p.x,
        p.y,
        undefined,
        undefined,
        layout.tileColors,
        layout.cols,
        layout.rows,
        layout.carpetTiles,
        layout.areas,
        view.areaTiles,
        showAreas,
        null,
        officeState.pets,
      );
      lctx.restore();
    }
    lastKey = key;
    lastLayout = layout;
    lastTileMap = officeState.tileMap;
    lastAt = now;
    otherFloorStats.renders++;
    otherFloorStats.ms += performance.now() - started;
  }
  // ponytail: following a walking character redraws this layer each frame.
  // Shift the stale layer by the pan delta and refresh at the usual rate to improve that case.
  ctx.globalAlpha = OTHER_FLOOR_ALPHA;
  for (let k = 0; k < rects.length; k++) {
    if (k === currentIndex) continue;
    const p = { x: pan.x, y: pan.y + shifts[k] * zoom };
    const clip = floorClip(rects[k], layout, { w, h }, zoom, p)!;
    const x = Math.max(0, Math.ceil(clip.x));
    const y = Math.max(0, Math.ceil(clip.y));
    const right = Math.min(w, Math.floor(clip.x + clip.w));
    const bottom = Math.min(h, Math.floor(clip.y + clip.h));
    if (right > x && bottom > y)
      ctx.drawImage(layer, x, y, right - x, bottom - y, x, y, right - x, bottom - y);
  }
  ctx.globalAlpha = 1;
}
