/**
 * BACKGROUND fog ring (building-a-1104, owner 11-04 17:51): instead of a horizon, the ground runs
 * on until a ring of cloud puffs and plain fog covers it, round the building's plot. Our own
 * drawing (pixel discs), only the feel of a town game's cloudy map edge.
 *
 * Cost: painted once per building size and palette into one picture (BG_FOG.texel iso px a
 * picture px, under 1 MB), then each frame one nearest-neighbour blit and up to four plain
 * rectangles past its edges. No filter, no gradient made per frame.
 */
import { BG_FOG } from '../../../constants.js';
import { hash } from './layout.js';
import { PALETTE, rgb } from './paint.js';

interface Fog {
  key: string;
  canvas: HTMLCanvasElement;
  /** Iso px of the picture's top-left. */
  x0: number;
  y0: number;
}
let fog: Fog | null = null;

/** The ring's clear radius (iso px, the 2:1 squash undone) for a plate of `cols` x `rows`. */
export const fogRadius = (cols: number, rows: number): number => (cols + rows) * 4 + BG_FOG.margin;

/** The fog's picture round ground point `g` (iso px), clear inside `r0`. */
function paintFog(g: { x: number; y: number }, r0: number, night: boolean): Fog {
  const P = (night ? PALETTE.night : PALETTE.day).fog;
  const T = BG_FOG.texel;
  const ext = (r0 + BG_FOG.solid) * BG_FOG.extent;
  const tw = Math.ceil((2 * ext) / T);
  const th = Math.ceil(ext / T);
  const canvas = document.createElement('canvas');
  canvas.width = tw;
  canvas.height = th;
  const c = canvas.getContext('2d')!;
  // Plain fog past the puffs.
  const img = c.createImageData(tw, th);
  const [br, bg, bb] = rgb(P.body);
  const solid = r0 + BG_FOG.solid;
  for (let j = 0; j < th; j++)
    for (let i = 0; i < tw; i++) {
      const x = (i + 0.5) * T - ext;
      const y = ((j + 0.5) * T - ext / 2) * 2;
      if (Math.hypot(x, y) < solid) continue;
      const k = (j * tw + i) * 4;
      img.data[k] = br;
      img.data[k + 1] = bg;
      img.data[k + 2] = bb;
      img.data[k + 3] = 255;
    }
  c.putImageData(img, 0, 0);
  // Puffs on two rings, the far ones first: a shaded disc, the body, a lit cap up and left.
  const disc = (cx: number, cy: number, r: number, fill: string) => {
    c.fillStyle = fill;
    for (let dy = -r; dy <= r; dy++) {
      const hw = Math.floor(Math.sqrt(r * r - dy * dy));
      c.fillRect(Math.round(cx - hw), Math.round(cy + dy), hw * 2 + 1, 1);
    }
  };
  const puffs: Array<{ x: number; y: number; r: number }> = [];
  BG_FOG.rings.forEach((ring, ri) => {
    const R0 = r0 + ring.out;
    const n = Math.round((2 * Math.PI * R0) / ring.gap);
    for (let i = 0; i < n; i++) {
      const a = ((i + hash(i, ri, 7) * 0.6) / n) * 2 * Math.PI;
      const R = R0 + (hash(i, ri, 8) - 0.5) * BG_FOG.jitter;
      puffs.push({
        x: (R * Math.cos(a) + ext) / T,
        y: ((R * Math.sin(a)) / 2 + ext / 2) / T,
        r: Math.round((ring.r * (0.75 + 0.5 * hash(i, ri, 9))) / T),
      });
    }
  });
  puffs.sort((p, q) => p.y - q.y);
  for (const p of puffs) {
    disc(p.x + p.r * 0.12, p.y + p.r * 0.22, p.r, P.shade);
    disc(p.x, p.y, p.r, P.body);
    disc(p.x - p.r * 0.28, p.y - p.r * 0.3, Math.round(p.r * 0.55), P.lit);
  }
  return { key: '', canvas, x0: g.x - ext, y0: g.y - ext / 2 };
}

/**
 * Draw the fog over the ground (under the building): `o` the device px of iso (0, 0), `zoom`
 * device px per iso px, `g` the ground point it is round, `r0` its clear radius.
 */
export function drawFog(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  o: { x: number; y: number },
  zoom: number,
  g: { x: number; y: number },
  r0: number,
  night: boolean,
): void {
  const key = `${g.x},${g.y},${r0},${night}`;
  if (fog?.key !== key) fog = { ...paintFog(g, r0, night), key };
  const T = BG_FOG.texel;
  const x0 = Math.round(o.x + fog.x0 * zoom);
  const y0 = Math.round(o.y + fog.y0 * zoom);
  const x1 = Math.round(o.x + (fog.x0 + fog.canvas.width * T) * zoom);
  const y1 = Math.round(o.y + (fog.y0 + fog.canvas.height * T) * zoom);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(fog.canvas, x0, y0, x1 - x0, y1 - y0);
  ctx.fillStyle = (night ? PALETTE.night : PALETTE.day).fog.body;
  const top = Math.max(0, y0);
  const bottom = Math.min(h, y1);
  if (y0 > 0) ctx.fillRect(0, 0, w, y0);
  if (y1 < h) ctx.fillRect(0, y1, w, h - y1);
  if (x0 > 0 && bottom > top) ctx.fillRect(0, top, x0, bottom - top);
  if (x1 < w && bottom > top) ctx.fillRect(x1, top, w - x1, bottom - top);
}
