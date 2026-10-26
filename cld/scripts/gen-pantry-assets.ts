/**
 * LOUNGE art: the owner's pantry pictures (10-25 23:38, `specs/owner-art-1025/`: generated pixel art
 * on a flat navy background, several screen px per art px) become game assets:
 *   - COFFEE_MACHINE (4 states), VENDING_MACHINE (4 states) in webview-ui/public/assets/furniture/<ID>/
 *     with a manifest (state group: the idle picture, and the three states as an animation the
 *     pantry plays while somebody gets a drink) so a later art swap needs no code;
 *   - WATER_COOLER: the owner's converted cooler (out/ref-assets/furniture/water-cooler.png, 8x23),
 *     centred in a 16x32 picture (no 4-state art for it: it only fills a cup);
 *   - the drink props (a can, a mug, hiss lines, steam, a paper cup) in webview-ui/src/cld/ez/pantryProps.json
 *     (palette-keyed rows, as props.json). DRAWN here, colours read from the owner's two 7-frame
 *     drinking references: a cut-out would be 4-8 px with the hand and shirt around it (see PROP_ROWS).
 * Each picture: the background removed by a flood fill from the border, the figure cut out, then
 * shrunk to office size with pixelResample (the generator's blocks are far smaller than a game
 * pixel, so every game pixel takes the block's dominant colour, dark where the source has an outline).
 * The 1x2-tile machines are about a character's height; the coffee machine stands on a 1-tile
 * counter drawn here (a counter is not in the owner's art).
 *
 *   npx tsx cld/scripts/gen-pantry-assets.ts [--src <owner-art-1025>] [--refs <ref-assets>] [--report]
 */
import * as fs from 'fs';
import * as path from 'path';

import type { Rgba } from '../../server/src/cld/assetSnap.js';
import { resample } from '../../server/src/cld/pixelResample.js';
import { Img } from './lib/img.js';

const ROOT = path.resolve(__dirname, '../..');
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const SRC = arg('--src', path.resolve(ROOT, '../specs/owner-art-1025'));
const REFS = arg('--refs', path.resolve(ROOT, '../out/ref-assets'));
const FURNITURE = path.join(ROOT, 'webview-ui/public/assets/furniture');
const PROPS_OUT = path.join(ROOT, 'webview-ui/src/cld/ez/pantryProps.json');

/** Colour distance (sum of channels) from the border colour that still counts as background. */
const BG_TOLERANCE = 36;
/** A piece smaller than this many source px is a speck, not a figure. */
const MIN_FIGURE_PX = 4000;

/** Inside the silhouette a game pixel takes the dark outline colour only from this share of dark
 *  up (resample's interiorDarkShare): the screen, the cans and the cup keep their colour. */
const INTERIOR_DARK = 0.6;
const TILE = 16;

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The picture's background mask: a flood fill from every border pixel over colours near the border's. */
function background(img: Img, tolerance = BG_TOLERANCE): Uint8Array {
  const at = (x: number, y: number) => (y * img.w + x) * 4;
  const ref = [0, 1, 2].map((c) => img.data[at(2, 2) + c]);
  const near = (x: number, y: number) => {
    const o = at(x, y);
    return (
      Math.abs(img.data[o] - ref[0]) +
        Math.abs(img.data[o + 1] - ref[1]) +
        Math.abs(img.data[o + 2] - ref[2]) <=
      tolerance
    );
  };
  const bg = new Uint8Array(img.w * img.h);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= img.w || y >= img.h || bg[y * img.w + x] || !near(x, y)) return;
    bg[y * img.w + x] = 1;
    stack.push(x, y);
  };
  for (let x = 0; x < img.w; x++) (push(x, 0), push(x, img.h - 1));
  for (let y = 0; y < img.h; y++) (push(0, y), push(img.w - 1, y));
  while (stack.length) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }
  return bg;
}

/** The connected figures (8-connected, joined over small gaps) as boxes, left to right. */
function figures(img: Img, bg: Uint8Array): Box[] {
  const seen = new Uint8Array(img.w * img.h);
  const out: Array<Box & { n: number }> = [];
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++) {
      if (bg[y * img.w + x] || seen[y * img.w + x]) continue;
      const box = { x0: x, y0: y, x1: x + 1, y1: y + 1, n: 0 };
      const stack = [x, y];
      seen[y * img.w + x] = 1;
      while (stack.length) {
        const cy = stack.pop()!;
        const cx = stack.pop()!;
        box.n++;
        box.x0 = Math.min(box.x0, cx);
        box.x1 = Math.max(box.x1, cx + 1);
        box.y0 = Math.min(box.y0, cy);
        box.y1 = Math.max(box.y1, cy + 1);
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= img.w || ny >= img.h) continue;
            const k = ny * img.w + nx;
            if (bg[k] || seen[k]) continue;
            seen[k] = 1;
            stack.push(nx, ny);
          }
      }
      if (box.n >= MIN_FIGURE_PX) out.push(box);
    }
  return out.sort((a, b) => a.x0 - b.x0);
}

/** `box` of `img` shrunk to `cols` x `rows` game pixels (cols/rows from the box's own aspect, one
 *  scale), background (and anything outside `keep`) transparent. */
function shrink(img: Img, bg: Uint8Array, box: Box, cols: number, rows: number): Img {
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const size = Math.max(w / cols, h / rows);
  const rgba: Rgba = { width: img.w, height: img.h, data: img.data };
  const isBg = (_r: number, _g: number, _b: number, a: number) => a === 0;
  // The source with the background made transparent, so the resampler's cover counts the figure only.
  const data = new Uint8Array(img.data);
  for (let i = 0; i < bg.length; i++) if (bg[i]) data[i * 4 + 3] = 0;
  const out = resample(
    { ...rgba, data },
    { size, ox: 0, oy: 0, confidence: 1 },
    { x: box.x0 - (cols * size - w) / 2, y: box.y0 - (rows * size - h) },
    cols,
    rows,
    isBg,
    { interiorDarkShare: INTERIOR_DARK },
  );
  const o = new Img(cols, rows);
  o.data.set(out.data);
  return o;
}

function paste(dst: Img, src: Img, ox: number, oy: number): void {
  for (let y = 0; y < src.h; y++)
    for (let x = 0; x < src.w; x++) {
      const c = src.get(x, y);
      if (c) dst.set(ox + x, oy + y, c);
    }
}

function save(id: string, frames: Img[], manifest: object): void {
  const dir = path.join(FURNITURE, id);
  fs.mkdirSync(dir, { recursive: true });
  frames.forEach((f, k) => f.write(path.join(dir, k === 0 ? `${id}.png` : `${id}_${k}.png`)));
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${id}: ${frames.length} pictures, ${frames[0].w}x${frames[0].h}`);
}

/** The manifest of a machine: the idle picture and its three states as an animation group. */
function machineManifest(id: string, name: string, w: number, h: number) {
  const asset = (file: string, aid: string, extra: object = {}) => ({
    type: 'asset',
    id: aid,
    file,
    width: w,
    height: h,
    footprintW: 1,
    footprintH: h / TILE,
    ...extra,
  });
  return {
    id,
    name,
    category: 'misc',
    type: 'group',
    groupType: 'state',
    canPlaceOnWalls: false,
    canPlaceOnSurfaces: false,
    backgroundTiles: 0,
    members: [
      {
        type: 'group',
        groupType: 'animation',
        state: 'on',
        members: [1, 2, 3].map((k) => asset(`${id}_${k}.png`, `${id}_${k}`, { frame: k - 1 })),
      },
      asset(`${id}.png`, id, { state: 'off' }),
    ],
  };
}

// ── The machines ─────────────────────────────────────────────

function machines(report: boolean): void {
  // Vending machine: 1x2 tiles, 14 px wide and 30 high (a character's height), 4 states.
  {
    const img = Img.read(path.join(SRC, 'vending-machine-4f.png'));
    const bg = background(img);
    const figs = figures(img, bg);
    if (report) console.log('vending figures', figs);
    if (figs.length !== 4) throw new Error(`vending machine: ${figs.length} figures, wanted 4`);
    const h = Math.max(...figs.map((f) => f.y1 - f.y0));
    const frames = figs.map((f) => {
      // the same box height for all four, so the machine does not breathe between states
      const box = { ...f, y1: f.y0 + h };
      const pic = shrink(img, bg, box, 14, 30);
      const out = new Img(TILE, 2 * TILE);
      paste(out, pic, 1, 2 * TILE - pic.h);
      return out;
    });
    save(
      'VENDING_MACHINE',
      frames,
      machineManifest('VENDING_MACHINE', 'Vending Machine', TILE, 2 * TILE),
    );
  }
  // Coffee machine on a one-tile counter: 16x32 (machine on top, counter below).
  {
    const img = Img.read(path.join(SRC, 'coffee-machine-4f.png'));
    const bg = background(img);
    const figs = figures(img, bg);
    if (report) console.log('coffee figures', figs);
    if (figs.length !== 4) throw new Error(`coffee machine: ${figs.length} figures, wanted 4`);
    const h = Math.max(...figs.map((f) => f.y1 - f.y0));
    const COUNTER_H = 11;
    const frames = figs.map((f) => {
      const box = { ...f, y1: f.y0 + h };
      const pic = shrink(img, bg, box, 14, 20);
      const out = new Img(TILE, 2 * TILE);
      counter(out, 2 * TILE - COUNTER_H);
      paste(out, pic, 1, 2 * TILE - COUNTER_H - pic.h + 1);
      return out;
    });
    save(
      'COFFEE_MACHINE',
      frames,
      machineManifest('COFFEE_MACHINE', 'Coffee Machine', TILE, 2 * TILE),
    );
  }
}

/** A plain one-tile counter (wood top, dark front), its top edge at row `top`. */
function counter(out: Img, top: number): void {
  const edge: Rgba = [42, 33, 49, 255];
  const wood: Rgba = [216, 168, 104, 255];
  const woodDark: Rgba = [154, 106, 64, 255];
  const front: Rgba = [111, 74, 42, 255];
  for (let x = 0; x < TILE; x++) {
    out.set(x, top, edge);
    out.set(x, top + 1, wood);
    out.set(x, top + 2, woodDark);
    for (let y = top + 3; y < top + 10; y++) out.set(x, y, front);
    out.set(x, top + 10, edge);
  }
  for (let y = top; y <= top + 10; y++) (out.set(0, y, edge), out.set(TILE - 1, y, edge));
}

/** The owner's converted water cooler (8x23), centred on the bottom of a 16x32 picture. */
function waterCooler(): void {
  const src = Img.read(path.join(REFS, 'furniture/water-cooler.png'));
  const out = new Img(TILE, 2 * TILE);
  paste(out, src, Math.floor((TILE - src.w) / 2), 2 * TILE - src.h);
  save('WATER_COOLER', [out], {
    id: 'WATER_COOLER',
    name: 'Water Cooler',
    category: 'misc',
    type: 'asset',
    canPlaceOnWalls: false,
    canPlaceOnSurfaces: false,
    backgroundTiles: 0,
    width: TILE,
    height: 2 * TILE,
    footprintW: 1,
    footprintH: 2,
  });
}

// ── The drink props ──────────────────────────────────────────

/**
 * The props of the drinking sequence, drawn here: a cut-out of the owner's references would be
 * 4-8 game pixels wide with the hand, the shirt and the hair all around it (two tries by colour
 * kept the shirt and lost the mug), so each is drawn after the references, with the colours read
 * from them (the can's blues and silver rim, the mug's cream and coffee, the white steam and
 * hiss ticks). Keys are props.json's palette plus the can's three blues.
 */
// Asset data, not UI styling.
/* eslint-disable pixel-agents/no-inline-colors */
const PROP_COLOURS = {
  u: '#2a58e8',
  U: '#1a36d9',
  v: '#4a8cff',
  c: '#6f4a2a',
  p: '#f6efdc',
  P: '#d8ccb0',
};
/* eslint-enable pixel-agents/no-inline-colors */
const PROP_ROWS: Record<string, string[][]> = {
  // upright, held at the hand (5x7): silver top, blue body with the white logo, dark base
  can: [['.ooo.', 'ogwgo', 'ouvuo', 'ouwuo', 'ouvuo', 'oUUUo', '.ooo.']],
  // tilted at the mouth, silver end first (8x5)
  canTilt: [['.oooooo.', 'ouvvuggo', 'ouwuuggo', 'oUUuuggo', '.oooooo.']],
  // the hiss when it opens (4x4)
  hiss: [['..w.', '.w..', 'w...', '..w.']],
  // a mug of coffee, handle on the right (6x5)
  mug: [['.oooo.', 'occcco', 'opppoo', 'oPppo.', '.oooo.']],
  // steam over the cup, three frames drifting (3x7)
  steam: [
    ['.w.', '..w', '.w.', 'w..', '.w.', '..w', '...'],
    ['..w', '.w.', 'w..', '.w.', '..w', '.w.', '...'],
    ['.w.', 'w..', '.w.', '..w', '.w.', 'w..', '...'],
  ],
  // a paper cup of water (4x5)
  paperCup: [['oooo', 'owwo', 'obbo', '.ww.', '.oo.']],
};

function props(): void {
  const json = {
    description:
      "LOUNGE: the drinking sequence's props, drawn by gen-pantry-assets.ts after the owner's references; rows keyed by the palette (props.json's, then this file's `palette`).",
    palette: PROP_COLOURS,
    props: Object.fromEntries(Object.entries(PROP_ROWS).map(([id, frames]) => [id, { frames }])),
  };
  fs.writeFileSync(PROPS_OUT, `${JSON.stringify(json, null, 1)}\n`);
  console.log(`pantry props: ${Object.keys(PROP_ROWS).join(', ')}`);
}

/** A review sheet: every picture of the pantry at x`zoom` on a grey checker. */
function preview(file: string, ids: string[], zoom = 8): void {
  const pics = ids.flatMap((id) =>
    fs
      .readdirSync(path.join(FURNITURE, id))
      .filter((f) => f.endsWith('.png'))
      .sort()
      .map((f) => Img.read(path.join(FURNITURE, id, f))),
  );
  const gap = 2 * zoom;
  const w = pics.reduce((a, p) => a + p.w * zoom + gap, gap);
  const h = Math.max(...pics.map((p) => p.h)) * zoom + 2 * gap;
  const sheet = new Img(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      sheet.set(x, y, ((x >> 3) + (y >> 3)) & 1 ? [84, 84, 92, 255] : [70, 70, 78, 255]);
  let ox = gap;
  for (const p of pics) {
    for (let y = 0; y < p.h * zoom; y++)
      for (let x = 0; x < p.w * zoom; x++) {
        const c = p.get(Math.floor(x / zoom), Math.floor(y / zoom));
        if (c) sheet.set(ox + x, gap + y, c);
      }
    ox += p.w * zoom + gap;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  sheet.write(file);
}

if (require.main === module) {
  const report = process.argv.includes('--report');
  machines(report);
  waterCooler();
  const sheet = arg('--preview', '');
  if (sheet) preview(sheet, ['VENDING_MACHINE', 'COFFEE_MACHINE', 'WATER_COOLER']);
  props();
}
