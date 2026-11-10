/**
 * BACKGROUND in the isometric view: the world is painted (paint.ts) in square pieces of BG_CHUNK
 * iso px, each only when it first comes into view, kept (per seed, surroundings, palette and
 * building) and blitted every frame at the camera's zoom, nearest-neighbour, like every other
 * piece. A pan paints the pieces it uncovers, nothing else; an idle view and the clock cost
 * nothing until the clock turns day or night. Round it all, the fog ring (fog.ts).
 */
import type { BackgroundSettings } from '../../../../../core/src/agent-tycoon/background.js';
import { BG_CHUNK, BG_CHUNKS_KEPT, ISO_HALF_H, ISO_HALF_W } from '../../../constants.js';
import type { IsoStack, Pt } from '../../iso/projection.js';
import { isNight } from './clock.js';
import { drawFog,fogRadius } from './fog.js';
import type { Footprint } from './layout.js';
import { edgeColour, paintBackground } from './paint.js';

/** Counters for the runner: pieces painted and the time they took. */
export const bgStats = { paints: 0, ms: 0 };

let cache: { key: string; pieces: Map<string, HTMLCanvasElement> } = { key: '', pieces: new Map() };

/** Whether the sky is night now, by the setting and the host's clock. */
export const skyIsNight = (s: BackgroundSettings, nowMs: number, offsetMin: number): boolean =>
  isNight(s.time, nowMs, offsetMin);

/**
 * Draw the background under the building. `o` is the device px of iso (0, 0), `zoom` the device
 * px per iso px. What no piece covers is the fog's colour; the fog ring goes over the ground.
 */
export function drawIsoBackground(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  o: Pt,
  zoom: number,
  stack: IsoStack,
  s: BackgroundSettings,
  night: boolean,
): void {
  const fp: Footprint = { cols: stack.cols, rows: stack.floors[0]?.rows ?? stack.depth };
  const { box } = stack;
  const key = [s.seed, s.mix, night, fp.cols, fp.rows, box.x0, box.x1, box.y0, box.y1].join('|');
  if (cache.key !== key) cache = { key, pieces: new Map() };
  ctx.fillStyle = edgeColour(night);
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = false;
  const cx0 = Math.floor(-o.x / zoom / BG_CHUNK);
  const cx1 = Math.floor((w - o.x) / zoom / BG_CHUNK);
  const cy0 = Math.floor(-o.y / zoom / BG_CHUNK);
  const cy1 = Math.floor((h - o.y) / zoom / BG_CHUNK);
  for (let cy = cy0; cy <= cy1; cy++)
    for (let cx = cx0; cx <= cx1; cx++) {
      const id = `${cx},${cy}`;
      let piece = cache.pieces.get(id);
      if (piece) {
        cache.pieces.delete(id); // most recently shown last
      } else {
        const started = performance.now();
        piece = paintBackground({
          seed: s.seed,
          mix: s.mix,
          night,
          fp,
          avoid: box,
          region: { x0: cx * BG_CHUNK, y0: cy * BG_CHUNK, x1: (cx + 1) * BG_CHUNK, y1: (cy + 1) * BG_CHUNK },
        });
        bgStats.paints++;
        bgStats.ms += performance.now() - started;
      }
      cache.pieces.set(id, piece);
      // Whole device px on both edges, so neighbours meet at any zoom.
      const x0 = Math.round(o.x + cx * BG_CHUNK * zoom);
      const y0 = Math.round(o.y + cy * BG_CHUNK * zoom);
      const x1 = Math.round(o.x + (cx + 1) * BG_CHUNK * zoom);
      const y1 = Math.round(o.y + (cy + 1) * BG_CHUNK * zoom);
      ctx.drawImage(piece, x0, y0, x1 - x0, y1 - y0);
    }
  const g = { x: ((fp.cols - fp.rows) * ISO_HALF_W) / 2, y: ((fp.cols + fp.rows) * ISO_HALF_H) / 2 };
  drawFog(ctx, w, h, o, zoom, g, fogRadius(fp.cols, fp.rows), night);
  // Drop the least recently shown (the map keeps insertion order, shown pieces were re-added last).
  while (cache.pieces.size > BG_CHUNKS_KEPT) cache.pieces.delete(cache.pieces.keys().next().value!);
}
