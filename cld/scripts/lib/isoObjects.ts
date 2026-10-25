/**
 * Processing of the owner's individual isometric objects (cld/scripts/gen-iso-objects.ts): one
 * object per image on a flat magenta or pink background. Pure functions over RGBA buffers, so
 * the tests can run them on synthetic pictures.
 *
 *  - `matte`: the background (read from the picture's border) and its blended halo removed;
 *    what is left is a 1-bit mask and, per pixel, whether its colour is clean (not tinted by the
 *    background), the object trimmed to its bounds, stray specks dropped.
 *  - `resample`: the object under an affine map, by area averaging (every output pixel is the
 *    mean of the clean source pixels under it, opaque when most of what is under it is): the
 *    owner's detail is kept, no palette is imposed, and the edge stays 1-bit and clean.
 *  - the footprint fits (`fitBase`, `fitWall`, `fitFloor`) measure where an object stands on
 *    the tile grid and give the map that puts it there, with the alignment error in px.
 *  - `mirror`, `lod`: the other facing, and the copies at coarser densities.
 */

export interface Raw {
  w: number;
  h: number;
  /** RGBA. */
  data: Uint8Array | Uint8ClampedArray;
}

/** An object cut out: opaque mask and colours at the source's resolution. */
export interface Cut {
  w: number;
  h: number;
  rgb: Uint8Array;
  /** 1 where the object is. */
  mask: Uint8Array;
  /** 1 where the colour is the object's own (not blended with the background). */
  clean: Uint8Array;
  /** The background colour that was removed. */
  bg: [number, number, number];
  /** Object pixels on the source picture's own border (the object runs off its picture). */
  border: number;
}

/** How magenta a colour is: the background is about #F80AF7, a blend of it with anything is
 *  between that and the object's own value. */
const magenta = (r: number, g: number, b: number) => Math.min(r, b) - g;
/** Source px a pixel may be from the background to be trusted as the object's own colour. */
const CLEAN_DEPTH = 3;
/** A speck smaller than this share of the object's biggest piece is not part of it. */
const SPECK_SHARE = 0.003;
/** Coarse cell (source px) the pieces are joined at: a chair's wheels stay with the chair. */
const JOIN_CELL = 4;
const JOIN_CELLS = 3;

const median = (v: number[]) => v.sort((a, b) => a - b)[v.length >> 1];

/** The background colour: the median of the picture's border. */
export function borderColour(img: Raw): [number, number, number] {
  const ch: number[][] = [[], [], []];
  const add = (x: number, y: number) => {
    const o = (y * img.w + x) * 4;
    for (let c = 0; c < 3; c++) ch[c].push(img.data[o + c]);
  };
  for (let x = 0; x < img.w; x++) (add(x, 0), add(x, img.h - 1));
  for (let y = 1; y < img.h - 1; y++) (add(0, y), add(img.w - 1, y));
  return [median(ch[0]), median(ch[1]), median(ch[2])];
}

/** The object in `img`, trimmed (its bounds are the Cut's size). */
export function matte(img: Raw): Cut {
  const bg = borderColour(img);
  const mBg = magenta(...bg);
  const n = img.w * img.h;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    // Halfway between the background's magenta and none: past that it is mostly background.
    mask[i] = magenta(img.data[o], img.data[o + 1], img.data[o + 2]) < mBg / 2 ? 1 : 0;
  }
  dropSpecks(mask, img.w, img.h);
  let border = 0;
  for (let x = 0; x < img.w; x++) border += mask[x] + mask[(img.h - 1) * img.w + x];
  for (let y = 1; y < img.h - 1; y++) border += mask[y * img.w] + mask[y * img.w + img.w - 1];
  // Trim.
  let [x0, y0, x1, y1] = [img.w, img.h, 0, 0];
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++)
      if (mask[y * img.w + x])
        [x0, y0, x1, y1] = [
          Math.min(x0, x),
          Math.min(y0, y),
          Math.max(x1, x + 1),
          Math.max(y1, y + 1),
        ];
  if (x1 <= x0) throw new Error('no object found');
  const w = x1 - x0;
  const h = y1 - y0;
  const out: Cut = {
    w,
    h,
    rgb: new Uint8Array(w * h * 3),
    mask: new Uint8Array(w * h),
    clean: new Uint8Array(w * h),
    bg,
    border,
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (y + y0) * img.w + x + x0;
      const d = y * w + x;
      out.mask[d] = mask[s];
      for (let c = 0; c < 3; c++) out.rgb[d * 3 + c] = img.data[s * 4 + c];
    }
  // Depth from the background: erode CLEAN_DEPTH times (4-neighbours).
  const depth = new Uint8Array(w * h);
  let frontier: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!out.mask[i]) continue;
    const x = i % w;
    const y = (i / w) | 0;
    if (
      x === 0 ||
      y === 0 ||
      x === w - 1 ||
      y === h - 1 ||
      !out.mask[i - 1] ||
      !out.mask[i + 1] ||
      !out.mask[i - w] ||
      !out.mask[i + w]
    ) {
      depth[i] = 1;
      frontier.push(i);
    }
  }
  for (let d = 1; d < CLEAN_DEPTH && frontier.length; d++) {
    const next: number[] = [];
    for (const i of frontier) {
      const x = i % w;
      const y = (i / w) | 0;
      for (const j of [
        x > 0 ? i - 1 : -1,
        x < w - 1 ? i + 1 : -1,
        y > 0 ? i - w : -1,
        y < h - 1 ? i + w : -1,
      ])
        if (j >= 0 && out.mask[j] && !depth[j]) {
          depth[j] = d + 1;
          next.push(j);
        }
    }
    frontier = next;
  }
  for (let i = 0; i < w * h; i++)
    if (out.mask[i]) {
      const m = magenta(out.rgb[i * 3], out.rgb[i * 3 + 1], out.rgb[i * 3 + 2]);
      out.clean[i] = depth[i] === 0 || m <= mBg / 24 ? 1 : 0;
    }
  return out;
}

/** Clear every connected piece (joined across small gaps) smaller than a speck of the biggest. */
function dropSpecks(mask: Uint8Array, w: number, h: number): void {
  const cw = Math.ceil(w / JOIN_CELL);
  const ch = Math.ceil(h / JOIN_CELL);
  const count = new Uint32Array(cw * ch);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (mask[y * w + x]) count[((y / JOIN_CELL) | 0) * cw + ((x / JOIN_CELL) | 0)]++;
  const lab = new Int32Array(cw * ch);
  const sizes: number[] = [0];
  for (let i = 0; i < cw * ch; i++) {
    if (!count[i] || lab[i]) continue;
    const id = sizes.length;
    let size = 0;
    const stack = [i];
    lab[i] = id;
    while (stack.length) {
      const j = stack.pop()!;
      size += count[j];
      const x = j % cw;
      const y = (j / cw) | 0;
      for (let dy = -JOIN_CELLS; dy <= JOIN_CELLS; dy++)
        for (let dx = -JOIN_CELLS; dx <= JOIN_CELLS; dx++) {
          const X = x + dx;
          const Y = y + dy;
          if (X < 0 || Y < 0 || X >= cw || Y >= ch) continue;
          const m = Y * cw + X;
          if (count[m] && !lab[m]) {
            lab[m] = id;
            stack.push(m);
          }
        }
    }
    sizes.push(size);
  }
  const biggest = Math.max(...sizes);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (
        mask[y * w + x] &&
        sizes[lab[((y / JOIN_CELL) | 0) * cw + ((x / JOIN_CELL) | 0)]] < biggest * SPECK_SHARE
      )
        mask[y * w + x] = 0;
}

// ── Resampling ───────────────────────────────────────────────

export interface Out {
  w: number;
  h: number;
  /** RGBA. */
  data: Uint8Array;
}

/** Where output pixel (x, y) (continuous, in the output's own frame) falls in the source. */
export type Map2 = (x: number, y: number) => [number, number];

/**
 * The object under `map`, by area averaging: output pixel (i, j) covers output-frame
 * [offX + i, offX + i + 1) × [offY + j, ...); its colour is the mean of the clean source pixels
 * under it (all opaque ones when none is clean), and it is opaque when most of the area under
 * it is the object. `k` is the output px per source px (it sets the sampling density).
 */
export function resample(
  cut: Cut,
  map: Map2,
  w: number,
  h: number,
  offX: number,
  offY: number,
  k: number,
): Out {
  const out: Out = { w, h, data: new Uint8Array(w * h * 4) };
  const n = Math.min(12, Math.max(2, Math.ceil(1 / k) + 1));
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      let cov = 0;
      let cw = 0;
      let aw = 0;
      const c = [0, 0, 0];
      const a = [0, 0, 0];
      for (let b = 0; b < n; b++)
        for (let s = 0; s < n; s++) {
          const [sx, sy] = map(offX + i + (s + 0.5) / n, offY + j + (b + 0.5) / n);
          const x = Math.floor(sx);
          const y = Math.floor(sy);
          if (x < 0 || y < 0 || x >= cut.w || y >= cut.h) continue;
          const p = y * cut.w + x;
          if (!cut.mask[p]) continue;
          cov++;
          aw++;
          for (let q = 0; q < 3; q++) a[q] += cut.rgb[p * 3 + q];
          if (cut.clean[p]) {
            cw++;
            for (let q = 0; q < 3; q++) c[q] += cut.rgb[p * 3 + q];
          }
        }
      if (cov * 2 < n * n) continue;
      const src = cw ? c : a;
      const d = cw || aw;
      const o = (j * w + i) * 4;
      for (let q = 0; q < 3; q++) out.data[o + q] = Math.round(src[q] / d);
      out.data[o + 3] = 255;
    }
  return out;
}

/** Uniform scale `k`, the source point (sx, sy) landing on output (ax, ay) (integers); the
 *  picture is as big as the object needs, the returned anchor is where (ax, ay) went. */
export function resampleUniform(
  cut: Cut,
  k: number,
  src: [number, number],
  at: [number, number],
): { out: Out; anchor: [number, number] } {
  const map: Map2 = (x, y) => [src[0] + (x - at[0]) / k, src[1] + (y - at[1]) / k];
  // Output-frame bounds of the whole object.
  const x0 = Math.floor(at[0] + (0 - src[0]) * k);
  const x1 = Math.ceil(at[0] + (cut.w - src[0]) * k);
  const y0 = Math.floor(at[1] + (0 - src[1]) * k);
  const y1 = Math.ceil(at[1] + (cut.h - src[1]) * k);
  const out = trimOut(resample(cut, map, x1 - x0, y1 - y0, x0, y0, k));
  return { out: out.img, anchor: [at[0] - x0 - out.x, at[1] - y0 - out.y] };
}

/** The opaque bounds of `o`, and the picture cut to them. */
export function trimOut(o: Out): { img: Out; x: number; y: number } {
  let [x0, y0, x1, y1] = [o.w, o.h, 0, 0];
  for (let y = 0; y < o.h; y++)
    for (let x = 0; x < o.w; x++)
      if (o.data[(y * o.w + x) * 4 + 3])
        [x0, y0, x1, y1] = [
          Math.min(x0, x),
          Math.min(y0, y),
          Math.max(x1, x + 1),
          Math.max(y1, y + 1),
        ];
  if (x1 <= x0) return { img: { w: 1, h: 1, data: new Uint8Array(4) }, x: 0, y: 0 };
  return { img: cropOut(o, x0, y0, x1, y1), x: x0, y: y0 };
}

export function cropOut(o: Out, x0: number, y0: number, x1: number, y1: number): Out {
  const w = x1 - x0;
  const h = y1 - y0;
  const r: Out = { w, h, data: new Uint8Array(w * h * 4) };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = x + x0;
      const sy = y + y0;
      if (sx < 0 || sy < 0 || sx >= o.w || sy >= o.h) continue;
      r.data.set(o.data.subarray((sy * o.w + sx) * 4, (sy * o.w + sx) * 4 + 4), (y * w + x) * 4);
    }
  return r;
}

/** The picture flipped left to right. */
export function mirrorOut(o: Out): Out {
  const r: Out = { w: o.w, h: o.h, data: new Uint8Array(o.data.length) };
  for (let y = 0; y < o.h; y++)
    for (let x = 0; x < o.w; x++)
      r.data.set(
        o.data.subarray((y * o.w + x) * 4, (y * o.w + x) * 4 + 4),
        (y * o.w + (o.w - 1 - x)) * 4,
      );
  return r;
}

/** The cut flipped left to right (a wall that runs the other way is fitted as one that runs
 *  down to the right). */
export function mirrorCut(c: Cut): Cut {
  const r: Cut = {
    ...c,
    rgb: new Uint8Array(c.rgb.length),
    mask: new Uint8Array(c.mask.length),
    clean: new Uint8Array(c.clean.length),
  };
  for (let y = 0; y < c.h; y++)
    for (let x = 0; x < c.w; x++) {
      const s = y * c.w + x;
      const d = y * c.w + (c.w - 1 - x);
      r.mask[d] = c.mask[s];
      r.clean[d] = c.clean[s];
      for (let q = 0; q < 3; q++) r.rgb[d * 3 + q] = c.rgb[s * 3 + q];
    }
  return r;
}

// ── Fits to the tile grid ────────────────────────────────────

/** Half a tile diamond at the master density (ISO_HALF_W, ISO_HALF_H × density). */
export const ISO_DENSITY = 12;
export const HW = 8 * ISO_DENSITY;
export const HH = 4 * ISO_DENSITY;

const rowRange = (c: Cut, y: number): [number, number] | null => {
  let a = -1;
  let b = -1;
  for (let x = 0; x < c.w; x++)
    if (c.mask[y * c.w + x]) {
      if (a < 0) a = x;
      b = x;
    }
  return a < 0 ? null : [a, b];
};

/** Each column's lowest and highest opaque row (-1 where empty). */
export function contours(c: Cut): { bot: Int32Array; top: Int32Array } {
  const bot = new Int32Array(c.w).fill(-1);
  const top = new Int32Array(c.w).fill(-1);
  for (let x = 0; x < c.w; x++)
    for (let y = 0; y < c.h; y++)
      if (c.mask[y * c.w + x]) {
        if (top[x] < 0) top[x] = y;
        bot[x] = y;
      }
  return { bot, top };
}

export interface Base {
  /** Centre of the object's base on the floor (source px): where its footprint's centre is. */
  cx: number;
  cy: number;
  /** Width of the base (source px): a diamond of this width stands under the object. */
  w: number;
}

/**
 * Where an object stands: its base is the lowest quarter-width of it (a diamond of width W is W/4
 * high from its corner to its middle, so the object's lowest W/4 rows hold the base's front half),
 * its centre the middle of that band's width, `W/4` above the lowest point.
 */
export function baseOf(c: Cut): Base {
  let ymax = 0;
  for (let y = c.h - 1; y >= 0; y--)
    if (rowRange(c, y)) {
      ymax = y;
      break;
    }
  const band = Math.round(c.w / 4);
  let [xmin, xmax] = [c.w, 0];
  for (let y = Math.max(0, ymax - band); y <= ymax; y++) {
    const r = rowRange(c, y);
    if (r) [xmin, xmax] = [Math.min(xmin, r[0]), Math.max(xmax, r[1] + 1)];
  }
  const w = xmax - xmin;
  return { cx: (xmin + xmax) / 2, cy: ymax + 1 - w / 4, w };
}

export interface WallFit {
  /** First column of the face's run (source px), and the row below its base there. */
  start: [number, number];
  /** Run in source px, the base's slope (rows per column) and its worst deviation from a line. */
  run: number;
  slope: number;
  dev: number;
  /** Vertical extent of the wall (cap to baseboard) in source px. */
  height: number;
}

/**
 * A wall that runs down to the right on its base: the run from the object's left edge to its
 * lowest point (past it only the end face's thickness), the base's slope fitted over the middle
 * of the run, and the height of the wall away from its ends.
 */
export function fitWall(c: Cut): WallFit {
  const { bot, top } = contours(c);
  let a = 0;
  while (a < c.w && bot[a] < 0) a++;
  let v = a;
  for (let x = a; x < c.w; x++) if (bot[x] > bot[v]) v = x;
  const run = v - a + 1;
  const lo = a + Math.round(run * 0.1);
  const hi = a + Math.round(run * 0.9);
  // The base line: least squares of the lowest row over the middle of the run, refitted without
  // the worst fifth (a doorway or a step in the baseboard is not the base's slope).
  const cols: number[] = [];
  for (let x = lo; x <= hi; x++) cols.push(x);
  const fit = (xs: number[]) => {
    let [sx, sy, sxx, sxy] = [0, 0, 0, 0];
    for (const x of xs) {
      sx += x;
      sy += bot[x];
      sxx += x * x;
      sxy += x * bot[x];
    }
    const m = (xs.length * sxy - sx * sy) / (xs.length * sxx - sx * sx);
    return { slope: m, b0: (sy - m * sx) / xs.length };
  };
  let { slope, b0 } = fit(cols);
  for (let pass = 0; pass < 2; pass++) {
    const keep = [...cols].sort(
      (p, q) => Math.abs(bot[p] - (b0 + slope * p)) - Math.abs(bot[q] - (b0 + slope * q)),
    );
    ({ slope, b0 } = fit(keep.slice(0, Math.round(cols.length * 0.8))));
  }
  const res = cols.map((x) => Math.abs(bot[x] - (b0 + slope * x))).sort((p, q) => p - q);
  const dev = res[Math.min(res.length - 1, Math.floor(res.length * 0.95))];
  const heights: number[] = [];
  for (const x of cols) heights.push(bot[x] - top[x] + 1);
  heights.sort((p, q) => p - q);
  return { start: [a, b0 + slope * a + 1], run, slope, dev, height: heights[heights.length >> 1] };
}

/**
 * A wall fitted to the grid: `n` tiles of run, its base on the exact 1:2 slope from the start
 * (so its strips of one tile tile seamlessly), `height` output px between cap and baseboard.
 * Anisotropic: the run and the height are each scaled to what the game asks of them.
 */
export function resampleWall(
  c: Cut,
  f: WallFit,
  kx: number,
  ky: number,
): { out: Out; anchor: [number, number] } {
  const height = f.height * ky;
  const n = (f.run * kx) / HW;
  // Output frame: x from the run's start, y with the base's start at 0 (it falls HH per tile).
  const map: Map2 = (X, Y) => {
    const x = f.start[0] + X / kx;
    return [x, f.start[1] + f.slope * (x - f.start[0]) + (Y - (X * HH) / HW) / ky];
  };
  const x0 = Math.floor(-(f.start[0] * kx));
  const x1 = Math.ceil((c.w - f.start[0]) * kx);
  const y0 = Math.floor(-height - 2 * HH - 4);
  const y1 = Math.ceil(n * HH + 4 * HH);
  const res = trimOut(resample(c, map, x1 - x0, y1 - y0, x0, y0, Math.min(kx, ky)));
  // Where the run's start (x = 0, base y = 0) went.
  return { out: res.img, anchor: [-x0 - res.x, -y0 - res.y] };
}

/** The 1×1 diamond (2·HW × 2·HH) of a flat square tile (an exact diamond picture): its top face
 *  mapped on the diamond, an inset of `inset` of the face dropped (its dark rim). */
export function fitFloor(
  c: Cut,
  inset: number,
): { out: Out; err: { ratio: number; skew: number } } {
  let L: [number, number] = [c.w, 0];
  let R: [number, number] = [-1, 0];
  let T: [number, number] = [0, c.h];
  for (let y = 0; y < c.h; y++)
    for (let x = 0; x < c.w; x++) {
      if (!c.mask[y * c.w + x]) continue;
      if (x < L[0]) L = [x, y];
      if (x > R[0]) R = [x, y];
      if (y < T[1]) T = [x, y];
    }
  const width = R[0] - L[0] + 1;
  const k = (2 * HW) / width;
  const w = 2 * HW;
  const h = 2 * HH;
  const out: Out = { w, h, data: new Uint8Array(w * h * 4) };
  // Per output pixel: inside the diamond by its centre, its colour from the source under its
  // whole preimage (the diamond mapped affinely onto the face).
  const O = [T[0] + 0.5, T[1]];
  const du = [R[0] + 1 - O[0], R[1] + 0.5 - O[1]];
  const dv = [L[0] - O[0], L[1] + 0.5 - O[1]];
  const map: Map2 = (X, Y) => {
    const a = (X - HW) / HW;
    const b = Y / HH;
    const u = inset + ((a + b) / 2) * (1 - 2 * inset);
    const v = inset + ((b - a) / 2) * (1 - 2 * inset);
    return [O[0] + u * du[0] + v * dv[0], O[1] + u * du[1] + v * dv[1]];
  };
  const full = resample(c, map, w, h, 0, 0, k);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const a = (x + 0.5 - HW) / HW;
      const b = (y + 0.5) / HH;
      if ((a + b) / 2 < 0 || (b - a) / 2 < 0 || (a + b) / 2 > 1 || (b - a) / 2 > 1) continue;
      const o = (y * w + x) * 4;
      // The diamond's pixels the sampling missed (an edge pixel half off the source) take the
      // nearest opaque neighbour's colour below.
      out.data.set(full.data.subarray(o, o + 4), o);
    }
  fillHoles(out);
  const B = [L[0] + R[0] - T[0], L[1] + R[1] - T[1]];
  return {
    out,
    err: {
      ratio: Math.abs(B[1] - T[1] - width / 2) * k,
      skew: Math.abs(T[0] - (L[0] + R[0]) / 2) * k,
    },
  };
}

/** Transparent pixels of the 1×1 diamond that the picture left: filled from a neighbour. */
function fillHoles(o: Out): void {
  const inDiamond = (x: number, y: number) => {
    const a = (x + 0.5 - HW) / HW;
    const b = (y + 0.5) / HH;
    return (a + b) / 2 > 0 && (b - a) / 2 > 0 && (a + b) / 2 < 1 && (b - a) / 2 < 1;
  };
  for (let pass = 0; pass < 3; pass++)
    for (let y = 0; y < o.h; y++)
      for (let x = 0; x < o.w; x++) {
        const i = (y * o.w + x) * 4;
        if (o.data[i + 3] || !inDiamond(x, y)) continue;
        for (const [dx, dy] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ]) {
          const X = x + dx;
          const Y = y + dy;
          if (X < 0 || Y < 0 || X >= o.w || Y >= o.h) continue;
          const j = (Y * o.w + X) * 4;
          if (o.data[j + 3]) {
            o.data.set(o.data.subarray(j, j + 4), i);
            break;
          }
        }
      }
}

/** Leftover background in an output picture, and halo: rim pixels tinted towards the backdrop
 *  (more magenta than the object just inside them by a clear margin). */
export function check(o: Out): { magenta: number; halo: number; rim: number } {
  let magentaN = 0;
  let halo = 0;
  let rim = 0;
  const op = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < o.w && y < o.h && o.data[(y * o.w + x) * 4 + 3] > 0;
  const mg = (x: number, y: number) => {
    const i = (y * o.w + x) * 4;
    return Math.min(o.data[i], o.data[i + 2]) - o.data[i + 1];
  };
  for (let y = 0; y < o.h; y++)
    for (let x = 0; x < o.w; x++) {
      if (!op(x, y)) continue;
      const i = (y * o.w + x) * 4;
      const [r, g, b] = [o.data[i], o.data[i + 1], o.data[i + 2]];
      if (r > 170 && b > 170 && Math.abs(r - b) < 60 && Math.min(r, b) - g > 60) magentaN++;
      if (op(x - 1, y) && op(x + 1, y) && op(x, y - 1) && op(x, y + 1)) continue;
      rim++;
      let sum = 0;
      let n = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const X = x + dx;
          const Y = y + dy;
          if (!op(X, Y) || (dx === 0 && dy === 0)) continue;
          sum += mg(X, Y);
          n++;
        }
      if (n && mg(x, y) >= HALO_TINT && mg(x, y) - sum / n > HALO_MARGIN) halo++;
    }
  return { magenta: magentaN, halo, rim };
}

/** How much more magenta than what is just inside it a rim pixel may be before it is a halo. */
const HALO_MARGIN = 28;
/** and at least this tinted (red and blue both above green): a brown or green edge never is. */
const HALO_TINT = 24;

/**
 * The last of the backdrop's tint: a rim pixel (opaque, with a transparent neighbour) that is
 * clearly more magenta than the opaque pixels around it loses the excess. Edges of
 * thin leaves and gaps the source's own blending reached are the only ones it ever touches.
 */
export function decontaminate(o: Out): number {
  return (
    despeckle(o) +
    decontaminatePass(o) +
    decontaminatePass(o) +
    decontaminatePass(o) +
    decontaminatePass(o)
  );
}

/** A lone backdrop-coloured pixel inside the picture (the source's own noise) takes the mean of
 *  the opaque pixels around it. */
function despeckle(o: Out): number {
  const op = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < o.w && y < o.h && o.data[(y * o.w + x) * 4 + 3] > 0;
  const fix: Array<[number, number, number[]]> = [];
  for (let y = 0; y < o.h; y++)
    for (let x = 0; x < o.w; x++) {
      if (!op(x, y)) continue;
      const i = (y * o.w + x) * 4;
      const [r, g, b] = [o.data[i], o.data[i + 1], o.data[i + 2]];
      if (!(r > 170 && b > 170 && Math.abs(r - b) < 60 && Math.min(r, b) - g > 60)) continue;
      const sum = [0, 0, 0];
      let n = 0;
      let m = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          if (!op(x + dx, y + dy) || (dx === 0 && dy === 0)) continue;
          const j = ((y + dy) * o.w + x + dx) * 4;
          for (let q = 0; q < 3; q++) sum[q] += o.data[j + q];
          m += Math.min(o.data[j], o.data[j + 2]) - o.data[j + 1];
          n++;
        }
      if (n && Math.min(r, b) - g - m / n > 40) fix.push([x, y, sum.map((v) => Math.round(v / n))]);
    }
  for (const [x, y, c] of fix) o.data.set(c, (y * o.w + x) * 4);
  return fix.length;
}

function decontaminatePass(o: Out): number {
  const op = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < o.w && y < o.h && o.data[(y * o.w + x) * 4 + 3] > 0;
  const rim = (x: number, y: number) =>
    !op(x - 1, y) || !op(x + 1, y) || !op(x, y - 1) || !op(x, y + 1);
  const mg = (x: number, y: number) => {
    const i = (y * o.w + x) * 4;
    return Math.min(o.data[i], o.data[i + 2]) - o.data[i + 1];
  };
  // The backdrop adds the same to red and blue and nothing to green: take that excess off.
  const fix: Array<[number, number, number]> = [];
  for (let y = 0; y < o.h; y++)
    for (let x = 0; x < o.w; x++) {
      if (!op(x, y) || !rim(x, y)) continue;
      let m = 0;
      let n = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          if (!op(x + dx, y + dy) || (dx === 0 && dy === 0)) continue;
          m += mg(x + dx, y + dy);
          n++;
        }
      if (n && mg(x, y) >= HALO_TINT && mg(x, y) - m / n > HALO_MARGIN)
        fix.push([x, y, mg(x, y) - Math.max(0, m / n)]);
    }
  for (const [x, y, t] of fix) {
    const i = (y * o.w + x) * 4;
    o.data[i] = Math.max(0, o.data[i] - t);
    o.data[i + 2] = Math.max(0, o.data[i + 2] - t);
  }
  return fix.length;
}
