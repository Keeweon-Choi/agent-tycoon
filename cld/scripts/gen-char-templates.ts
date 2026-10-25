/**
 * CHAR-HUMAN Phase A: the bald base body `basic` (char_0's silhouette in all 21 frames, skin only),
 * the reading paper the app draws on top, the head anchors, and the owner's drawing templates
 * (green mannequin on magenta, see cld/docs/design/char-parts.md). Re-run after changing char_0.png
 * or the head drawings below:
 *
 *   npx tsx cld/scripts/gen-char-templates.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import { parseHex, rgbToLab } from '../../webview-ui/src/cld/characters/color.js';
import type { TemplateData } from '../../webview-ui/src/cld/characters/template.js';
import { templateColor, TEMPLATES } from '../../webview-ui/src/cld/characters/template.js';

const root = path.resolve(__dirname, '../..');
const W = 112;
const H = 96;
const FW = 16;
const FH = 32;
const FRAMES = 7;
const ROWS = 3; // down, up, right
const STANDING = 1; // walk2 is the standing pose
const READ_FRAMES = [5, 6];
const TYPE_FRAME = 3;
/** The mannequin's direction marks (standing frame): eye columns front and side, their rows. */
const EYE_HINTS = { front: [6, 9], side: [12], rows: [15, 16] };
/** The standing frame's eye rows and colours (char_0): the male face. */
const FACE_ROWS = [14, 16];
const EYE_COLOURS = new Set(['000000', 'ffffff', '4f4f4f', '191919', '595959']);
/** A built-in clothing part with fewer pixels is not there (barefoot, a dress). */
const MIN_PART_PIXELS = 20;
/** Head rows in the standing frame end at the chin (the collar starts below). */
const CHIN_ROW = 17;
/** The head-part canvas reaches this standing row (shoulder-length hair and a little more). */
const HEAD_BOX_BOTTOM = 24;

/** The gap between the legs is near-black (OKLab L below RIDGE_MAX_L) and darker than both neighbours by RIDGE_DL. */
const RIDGE_DL = 0.15;
const RIDGE_MAX_L = 0.3;
/** Front and back views: the torso's outline columns at the waist, where the arm lines go, from
 *  this many rows below the chin; the legs' middle columns from LEG_ROW (standing frame) down. */
const TORSO_COLS = [4, 11];
const ARM_FROM = 3;
const LEG_COLS = [7, 8];
const LEG_ROW = 26;

const OUTLINE = '493e38';
const SKIN = 'e9a384';
const LINE = 'c5896e';
const SHADE = 'e29878';
const PAPER_BORDER = '391624';
const PAPER_COLOURS = new Set([PAPER_BORDER, 'ffffff', 'e1e3e9', 'a2aaaf']);

/** Bald heads, standing-frame rows 5..CHIN_ROW, char_0's skin ramp:
 *  # outline, h highlight, l light, s main, d shade, D dark shade. */
const HEAD_TOP = 5;
const SKIN_CODES: Record<string, string> = {
  '#': OUTLINE,
  h: 'ffd8b2',
  l: 'fbbf97',
  s: SKIN,
  d: 'e29878',
  D: LINE,
};
const HEADS: Record<'down' | 'up' | 'right', string[]> = {
  down: [
    '.....######.....',
    '...##lhllss##...',
    '..#lhhlsssssd#..',
    '..#lhlssssssd#..',
    '..#llsssssssd#..',
    '..#lssssssssd#..',
    '.##sssssssssd##.',
    '.#dsssssssssdd#.',
    '.#DsssssssssdD#.',
    '..#sssssssssd#..',
    '...#sssssssd#...',
    '...#sssssssd#...',
    '....#dssssd#....',
  ],
  up: [],
  right: [
    '......######....',
    '....##lhlsss##..',
    '...#lhhlssssd#..',
    '...#lhlsssssd#..',
    '...#llssssssd#..',
    '...#lsssssssd#..',
    '...#ssssssssd#..',
    '...#ssDdssssd#..',
    '...#ssDdssssd#..',
    '....#sDsssssss#.',
    '.....#dsssssss#.',
    '......#dssssss#.',
    '.......#sssss#..',
  ],
};
HEADS.up = HEADS.down;

const out = path.join(root, 'cld/artifacts/char-parts/templates');
const previews = path.join(root, 'cld/artifacts/char-parts');
fs.mkdirSync(out, { recursive: true });

const t = TEMPLATES[0];
const at = (x: number, y: number) => y * W + x;
const L = (hex: string) => rgbToLab(parseHex(`#${hex}`)).L;
const view = (r: number) => (['down', 'up', 'right'] as const)[r];

// 1. Head anchors: each frame's hair is the standing hair moved by (dx, dy) (per built-in sheet).
function anchorsOf(tt: TemplateData): { dx: number; dy: number }[] {
  const hairAt = (f: number, r: number, x: number, y: number) =>
    x >= 0 && y >= 0 && x < FW && y < FH && tt.regions[at(f * FW + x, r * FH + y)] === 'h';
  const found: { dx: number; dy: number }[] = [];
  for (let r = 0; r < ROWS; r++)
    for (let f = 0; f < FRAMES; f++) {
      let best = { dx: 0, dy: 0, score: -Infinity };
      for (let dy = -4; dy <= 6; dy++)
        for (let dx = -3; dx <= 3; dx++) {
          let score = 0;
          for (let y = 0; y < FH; y++)
            for (let x = 0; x < FW; x++)
              if (hairAt(STANDING, r, x, y)) score += hairAt(f, r, x + dx, y + dy) ? 1 : -1;
          if (score > best.score) best = { dx, dy, score };
        }
      found[r * FRAMES + f] = { dx: best.dx, dy: best.dy };
    }
  return found;
}
const anchors = anchorsOf(t);
const minDy = Math.min(...anchors.map((a) => a.dy));
const maxDy = Math.max(...anchors.map((a) => a.dy));
const headBox = { x: 0, y: -minDy, w: FW, h: HEAD_BOX_BOTTOM + minDy + 1 };
if (headBox.y + headBox.h + maxDy > FH) throw new Error('head box leaves the frame');

// 2. The paper: char_0's paper colours inside the bounding box of its border in the read frames.
const paper = new Set<number>();
for (const r of [0, 2])
  for (const f of READ_FRAMES) {
    const cells: [number, number][] = [];
    for (let y = 0; y < FH; y++)
      for (let x = 0; x < FW; x++)
        if (templateColor(t, at(f * FW + x, r * FH + y)) === PAPER_BORDER) cells.push([x, y]);
    const [x0, x1] = [Math.min(...cells.map((c) => c[0])), Math.max(...cells.map((c) => c[0]))];
    const [y0, y1] = [Math.min(...cells.map((c) => c[1])), Math.max(...cells.map((c) => c[1]))];
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = at(f * FW + x, r * FH + y);
        if (PAPER_COLOURS.has(templateColor(t, i))) paper.add(i);
      }
  }

// The built-ins' reading glasses: black in the read frames where the typing frame (moved like the
// head) has none, above the chin.
const glasses = new Set<number>();
for (const r of [0, 2])
  for (const f of READ_FRAMES) {
    const shift = anchors[r * FRAMES + f].dy - anchors[r * FRAMES + TYPE_FRAME].dy;
    for (let y = 0; y <= CHIN_ROW + anchors[r * FRAMES + f].dy; y++)
      for (let x = 0; x < FW; x++) {
        const i = at(f * FW + x, r * FH + y);
        const typed =
          y - shift >= 0 ? templateColor(t, at(TYPE_FRAME * FW + x, r * FH + y - shift)) : '';
        if (templateColor(t, i) === '000000' && typed !== '000000') glasses.add(i);
      }
  }

// 3. The base body: char_0 without its head, clothes turned to skin, a bald head at the anchor.
const body: string[] = new Array(W * H).fill('');
const lines = new Set<number>(); // the limb lines, dark green on the mannequin
for (let r = 0; r < ROWS; r++)
  for (let f = 0; f < FRAMES; f++) {
    const { dx, dy } = anchors[r * FRAMES + f];
    const ox = f * FW;
    const oy = r * FH;
    const inFrame = (x: number, y: number) => x >= 0 && y >= 0 && x < FW && y < FH;
    const orig = (x: number, y: number) =>
      inFrame(x, y) ? templateColor(t, at(ox + x, oy + y)) : '';
    // The old head: everything the standing frame has down to the chin, moved to this frame.
    const oldHead = new Set<number>();
    for (let y = 0; y <= CHIN_ROW; y++)
      for (let x = 0; x < FW; x++)
        if (templateColor(t, at(STANDING * FW + x, oy + y)) && inFrame(x + dx, y + dy))
          oldHead.add(at(ox + x + dx, oy + y + dy));
    const front = r === 0;
    const solid = (x: number, y: number) => {
      if (!inFrame(x, y)) return false;
      const i = at(ox + x, oy + y);
      if (oldHead.has(i)) return false;
      if (paper.has(i)) return front; // the front paper covers the torso; the side one is held out
      return orig(x, y) !== '';
    };
    for (let y = 0; y < FH; y++)
      for (let x = 0; x < FW; x++) {
        if (!solid(x, y)) continue;
        const i = at(ox + x, oy + y);
        const hex = orig(x, y);
        const edge = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].some(([ex, ey]) => !solid(x + ex, y + ey) && !oldHead.has(at(ox + x + ex, oy + y + ey)));
        if (edge) {
          body[i] = OUTLINE;
          continue;
        }
        if (paper.has(i)) {
          body[i] = SKIN;
          continue;
        }
        if (t.regions[i] === 's') {
          body[i] = L(hex) < L(LINE) ? SHADE : hex; // hands and neck keep char_0's skin shading
          continue;
        }
        // Front and back: a line where each arm meets the torso (the torso's waist columns, from
        // below the shoulders while an arm is outside them) and char_0's dark gap between the legs.
        // Every other dark stroke of the suit is clothing. ponytail: the side view has no arm line.
        const l = L(hex);
        const lit = (xx: number, yy: number) =>
          solid(xx, yy) && orig(xx, yy) ? L(orig(xx, yy)) : -1;
        const ridge = (a: number, b: number) => a - l > RIDGE_DL && b - l > RIDGE_DL;
        const side = x < FW / 2 ? -1 : 1;
        const arm = TORSO_COLS.includes(x) && y >= CHIN_ROW + ARM_FROM + dy && solid(x + side, y);
        const legs =
          LEG_COLS.includes(x) &&
          y >= LEG_ROW + dy &&
          l < RIDGE_MAX_L &&
          (ridge(lit(x - 1, y), lit(x + 1, y)) ||
            ridge(lit(x - 1, y), lit(x + 2, y)) ||
            ridge(lit(x - 2, y), lit(x + 1, y)));
        const line = r !== 2 && (arm || legs);
        body[i] = line ? LINE : SKIN;
        if (line) lines.add(i);
      }
    // The bald head.
    const rows = HEADS[view(r)];
    rows.forEach((row, hy) => {
      if (row.length !== FW) throw new Error(`${view(r)} head row ${hy} is ${row.length} wide`);
      [...row].forEach((code, hx) => {
        const x = hx + dx;
        const y = HEAD_TOP + hy + dy;
        if (code === '.' || !inFrame(x, y)) return;
        body[at(ox + x, oy + y)] = SKIN_CODES[code];
      });
    });
    // The bald head's chin outline meets the neck: neck pixels the old head covered become skin.
  }

// A line pixel with no line above or below it is a stray: back to skin.
for (const i of [...lines])
  if (!lines.has(i - W) && !lines.has(i + W)) {
    lines.delete(i);
    body[i] = SKIN;
  }

// 4. Images.
type Px = [number, number, number, number];
function png(w: number, h: number, px: (x: number, y: number) => Px | null, bg: Px | null = null) {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = px(x, y) ?? bg ?? [0, 0, 0, 0];
      p.data.set(c, (y * w + x) * 4);
    }
  return p;
}
const rgba = (hex: string): Px => [...parseHex(`#${hex}`), 255] as Px;
const write = (file: string, p: PNG) => {
  fs.writeFileSync(file, PNG.sync.write(p));
  console.log(path.relative(root, file), `${p.width}x${p.height}`);
};

const GREEN: Px = [0, 255, 0, 255];
const DARK_GREEN: Px = [0, 160, 0, 255];
const MAGENTA: Px = [255, 0, 255, 255];
const GREY: Px = [128, 128, 128, 255];

/** The mannequin: green body, dark green outline and limb lines, eye dots and a side eye. */
function mannequin(i: number): Px | null {
  const hex = body[i];
  if (!hex) return null;
  if (hex === OUTLINE || lines.has(i)) return DARK_GREEN;
  return GREEN;
}
const hints = new Set<number>();
for (let r = 0; r < ROWS; r++)
  for (let f = 0; f < FRAMES; f++) {
    const { dx, dy } = anchors[r * FRAMES + f];
    const eyes = r === 0 ? EYE_HINTS.front : r === 2 ? EYE_HINTS.side : [];
    for (const ex of eyes)
      for (const ey of EYE_HINTS.rows) hints.add(at(f * FW + ex + dx, r * FH + ey + dy));
  }
const mannequinAt = (i: number) => (hints.has(i) && body[i] ? DARK_GREEN : mannequin(i));

write(
  path.join(previews, 'body-basic.png'),
  png(W, H, (x, y) => (body[at(x, y)] ? rgba(body[at(x, y)]) : null)),
);
write(
  path.join(previews, 'paper.png'),
  png(W, H, (x, y) => (paper.has(at(x, y)) ? rgba(templateColor(t, at(x, y))) : null)),
);
write(
  path.join(out, 'body-1x.png'),
  png(W, H, (x, y) => mannequinAt(at(x, y))),
);
write(
  path.join(out, 'body-1x-magenta.png'),
  png(W, H, (x, y) => mannequinAt(at(x, y)), MAGENTA),
);

/** Big-block sheet: cells of cw x ch pixels, `block` px each (BLOCK classic; HD_BLOCK for the HD
 *  templates, twice the pixels in the same image), cells one classic block apart, a two-block
 *  margin, a thin grey line half a classic block outside every cell: the HD and classic templates
 *  share their frame lines, so the importer reads both the same way. */
const BLOCK = 20;
const HD_BLOCK = 10;
const MARGIN = 2;
const LINE_PX = 2;
function bigSheet(
  cells: number,
  cw: number,
  ch: number,
  cell: (c: number, x: number, y: number) => Px | null,
  block = BLOCK,
) {
  const pitch = cw * block + BLOCK;
  const w = MARGIN * 2 * BLOCK + cells * pitch - BLOCK;
  const h = MARGIN * 2 * BLOCK + ch * block;
  const px: Px[] = new Array(w * h).fill(MAGENTA);
  const put = (x: number, y: number, c: Px) => (px[y * w + x] = c);
  for (let c = 0; c < cells; c++) {
    const ox = MARGIN * BLOCK + c * pitch;
    const oy = MARGIN * BLOCK;
    const [l, r, tp, b] = [
      ox - BLOCK / 2,
      ox + cw * block + BLOCK / 2 - LINE_PX,
      oy - BLOCK / 2,
      oy + ch * block + BLOCK / 2 - LINE_PX,
    ];
    for (let d = 0; d < LINE_PX; d++) {
      for (let x = l; x < r + LINE_PX; x++) (put(x, tp + d, GREY), put(x, b + d, GREY));
      for (let y = tp; y < b + LINE_PX; y++) (put(l + d, y, GREY), put(r + d, y, GREY));
    }
    for (let y = 0; y < ch * block; y++)
      for (let x = 0; x < cw * block; x++) {
        const v = cell(c, Math.floor(x / block), Math.floor(y / block));
        if (v) put(ox + x, oy + y, v);
      }
  }
  return png(w, h, (x, y) => px[y * w + x]);
}

(['down', 'up', 'right'] as const).forEach((name, r) =>
  write(
    path.join(out, `body-${name}-x20.png`),
    bigSheet(FRAMES, FW, FH, (f, x, y) => {
      const i = at(f * FW + x, r * FH + y);
      return paper.has(i) ? rgba(templateColor(t, i)) : mannequinAt(i);
    }),
  ),
);

// Head canvas: the standing frame's box (bald head and the shoulders below it for reference).
const headAt = (v: number, x: number, y: number, mark: (i: number) => Px | null) =>
  mark(at(STANDING * FW + headBox.x + x, v * FH + headBox.y + y));
write(
  path.join(out, 'head-1x.png'),
  png(headBox.w * 3, headBox.h, (x, y) =>
    headAt(Math.floor(x / headBox.w), x % headBox.w, y, mannequinAt),
  ),
);
write(
  path.join(out, 'head-x20.png'),
  bigSheet(3, headBox.w, headBox.h, (v, x, y) => headAt(v, x, y, mannequinAt)),
);
write(
  path.join(out, 'mascot-x20.png'),
  bigSheet(3, FW, FH, () => null),
);

// HD templates (CHAR-FACTORY): 32×64 frames and a 32×48 head canvas, the mannequin the same
// silhouette at twice the pixels with a one-pixel outline, its limb lines and eye dots, the paper.
const HFW = FW * 2;
const HFH = FH * 2;
/** Frame (r, f)'s HD mannequin pixel (X, Y), or null. */
function mannequinHd(r: number, f: number, X: number, Y: number): Px | null {
  const on = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < HFW && y < HFH && !!body[at(f * FW + (x >> 1), r * FH + (y >> 1))];
  if (!on(X, Y)) return null;
  const i = at(f * FW + (X >> 1), r * FH + (Y >> 1));
  if (paper.has(i)) return rgba(templateColor(t, i));
  if (!on(X - 1, Y) || !on(X + 1, Y) || !on(X, Y - 1) || !on(X, Y + 1)) return DARK_GREEN;
  if (hints.has(i) || (lines.has(i) && X % 2 === 0)) return DARK_GREEN;
  return GREEN;
}
const paperHd = (r: number, f: number, X: number, Y: number): Px | null => {
  const i = at(f * FW + (X >> 1), r * FH + (Y >> 1));
  return paper.has(i) ? rgba(templateColor(t, i)) : mannequinHd(r, f, X, Y);
};
const sheetHd = (x: number, y: number) =>
  mannequinHd(Math.floor(y / HFH), Math.floor(x / HFW), x % HFW, y % HFH);
write(path.join(out, 'body-hd-1x.png'), png(W * 2, H * 2, sheetHd));
write(path.join(out, 'body-hd-1x-magenta.png'), png(W * 2, H * 2, sheetHd, MAGENTA));
(['down', 'up', 'right'] as const).forEach((name, r) =>
  write(
    path.join(out, `body-${name}-hd-x10.png`),
    bigSheet(FRAMES, HFW, HFH, (f, x, y) => paperHd(r, f, x, y), HD_BLOCK),
  ),
);
const headHd = (v: number, x: number, y: number) =>
  mannequinHd(v, STANDING, headBox.x * 2 + x, headBox.y * 2 + y);
write(
  path.join(out, 'head-hd-1x.png'),
  png(headBox.w * 6, headBox.h * 2, (x, y) =>
    headHd(Math.floor(x / (headBox.w * 2)), x % (headBox.w * 2), y),
  ),
);
write(
  path.join(out, 'head-hd-x10.png'),
  bigSheet(3, headBox.w * 2, headBox.h * 2, (v, x, y) => headHd(v, x, y), HD_BLOCK),
);

// RES-STUDY templates (48×96 and 64×128, densities 3 and 4): the same mannequin at D times the
// pixels (a one-pixel outline, limb lines and eye dots one pixel wide), in the HD templates' layout
// with blocks of about 20 / D px (so the sheet stays the classic template's size), and a page of
// the three standing views with bigger blocks, the size a generator can hold.
const STUDY_BLOCK: Record<number, number> = { 3: 7, 4: 5 };
const STAND_BLOCK: Record<number, number> = { 3: 10, 4: 8 };
function mannequinD(D: number, r: number, f: number, X: number, Y: number): Px | null {
  const on = (x: number, y: number) =>
    x >= 0 &&
    y >= 0 &&
    x < FW * D &&
    y < FH * D &&
    !!body[at(f * FW + Math.floor(x / D), r * FH + Math.floor(y / D))];
  if (!on(X, Y)) return null;
  const i = at(f * FW + Math.floor(X / D), r * FH + Math.floor(Y / D));
  if (paper.has(i)) return rgba(templateColor(t, i));
  if (!on(X - 1, Y) || !on(X + 1, Y) || !on(X, Y - 1) || !on(X, Y + 1)) return DARK_GREEN;
  // the eye dots fill their classic pixel (as in HD); a limb line is one pixel wide, in the middle
  if (hints.has(i)) return DARK_GREEN;
  if (lines.has(i) && X % D === Math.floor(D / 2)) return DARK_GREEN;
  return GREEN;
}
for (const D of [3, 4]) {
  const [fw, fh] = [FW * D, FH * D];
  const sheetD = (x: number, y: number) =>
    mannequinD(D, Math.floor(y / fh), Math.floor(x / fw), x % fw, y % fh);
  write(path.join(out, `body-d${D}-1x.png`), png(W * D, H * D, sheetD));
  write(path.join(out, `body-d${D}-1x-magenta.png`), png(W * D, H * D, sheetD, MAGENTA));
  (['down', 'up', 'right'] as const).forEach((name, r) =>
    write(
      path.join(out, `body-${name}-d${D}-x${STUDY_BLOCK[D]}.png`),
      bigSheet(FRAMES, fw, fh, (f, x, y) => mannequinD(D, r, f, x, y), STUDY_BLOCK[D]),
    ),
  );
  const headD = (v: number, x: number, y: number) =>
    mannequinD(D, v, STANDING, headBox.x * D + x, headBox.y * D + y);
  write(
    path.join(out, `head-d${D}-1x.png`),
    png(headBox.w * D * 3, headBox.h * D, (x, y) =>
      headD(Math.floor(x / (headBox.w * D)), x % (headBox.w * D), y),
    ),
  );
  write(
    path.join(out, `head-d${D}-x${STUDY_BLOCK[D]}.png`),
    bigSheet(3, headBox.w * D, headBox.h * D, (v, x, y) => headD(v, x, y), STUDY_BLOCK[D]),
  );
  write(
    path.join(out, `stand-d${D}-x${STAND_BLOCK[D]}.png`),
    bigSheet(3, fw, fh, (v, x, y) => mannequinD(D, v, STANDING, x, y), STAND_BLOCK[D]),
  );
}

// 5. Built-in parts and what the compositor needs (parts.generated.json).
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** w x h pixels (rrggbb or '') as a palette and one character per pixel ('.' transparent). */
function encode(w: number, h: number, get: (x: number, y: number) => string) {
  const palette: string[] = [];
  let pixels = '';
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = get(x, y);
      if (!c) {
        pixels += '.';
        continue;
      }
      let k = palette.indexOf(c);
      if (k < 0) k = palette.push(c) - 1;
      if (k >= ALPHABET.length) throw new Error('too many colours');
      pixels += ALPHABET[k];
    }
  return { palette, pixels };
}
interface Part {
  id: string;
  slot: string;
  kind: 'sheet' | 'head';
  gender?: 'm' | 'f';
  /** The colours a picked colour replaces (shading kept); the rest stay. */
  ramp: string[];
  palette: string[];
  pixels: string;
}
const HW = headBox.w * ROWS; // head canvas: three views side by side
const part = (
  id: string,
  slot: string,
  kind: Part['kind'],
  get: (x: number, y: number) => string,
  ramp: Set<string>,
  gender?: Part['gender'],
): Part => {
  const e = kind === 'sheet' ? encode(W, H, get) : encode(HW, headBox.h, get);
  return {
    id,
    slot,
    kind,
    ...(gender && { gender }),
    ramp: e.palette.filter((c) => ramp.has(c)),
    ...e,
  };
};
const parts: Part[] = [];
parts.push(
  part(
    'basic',
    'body',
    'sheet',
    (x, y) => body[at(x, y)],
    new Set(body.filter((c) => c && c !== OUTLINE)),
  ),
);

// Faces on the head canvas (front and side; no back): char_0's eyes, and a female one with lashes and lips.
const BLACK = '000000';
const LIPS = 'd0606a';
const eyesOf = (v: number, cx: number, cy: number) => {
  if (v === 1) return '';
  const c = templateColor(t, at(STANDING * FW + headBox.x + cx, v * FH + headBox.y + cy));
  const y = headBox.y + cy;
  return y >= FACE_ROWS[0] && y <= FACE_ROWS[1] && EYE_COLOURS.has(c) ? c : '';
};
const faceF: Record<string, string> = {
  // front: a lash at each eye's outer top corner, lips under the nose
  '0,4,14': BLACK,
  '0,11,14': BLACK,
  '0,7,17': LIPS,
  '0,8,17': LIPS,
  // side: a lash in front of the eye's top, lips at the front of the chin
  '2,13,14': BLACK,
  '2,12,17': LIPS,
};
const canvasGet = (f: (v: number, cx: number, cy: number) => string) => (x: number, y: number) =>
  f(Math.floor(x / headBox.w), x % headBox.w, y);
parts.push(part('face-basic-m', 'face', 'head', canvasGet(eyesOf), new Set(), 'm'));
parts.push(
  part(
    'face-basic-f',
    'face',
    'head',
    canvasGet(
      (v, cx, cy) => faceF[`${v},${headBox.x + cx},${headBox.y + cy}`] ?? eyesOf(v, cx, cy),
    ),
    new Set(),
    'f',
  ),
);

// The six built-ins split by their region maps: hair (standing frames) and clothes (every frame).
const DARK_L = 0.4;
TEMPLATES.forEach((tt, k) => {
  const col = (i: number) => templateColor(tt, i);
  const inSheet = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H;
  const edgeAt = (x: number, y: number) =>
    [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ].some(([dx, dy]) => {
      const fx = (x % FW) + dx;
      const fy = (y % FH) + dy;
      return fx < 0 || fy < 0 || fx >= FW || fy >= FH || !col(at(x + dx, y + dy));
    });
  const near = (x: number, y: number, codes: string) => {
    const votes: Record<string, number> = {};
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const fx = (x % FW) + dx;
        const fy = (y % FH) + dy;
        if ((!dx && !dy) || fx < 0 || fy < 0 || fx >= FW || fy >= FH || !inSheet(x + dx, y + dy))
          continue;
        const code = tt.regions[at(x + dx, y + dy)];
        if (codes.includes(code)) votes[code] = (votes[code] ?? 0) + 1;
      }
    return Object.entries(votes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  };
  const gender = k === 1 ? ('f' as const) : undefined; // char_1: long hair and a dress
  // hair: 'h' pixels and the dark outline around them, from the standing frame of each view
  const hair = (v: number, cx: number, cy: number) => {
    const x = STANDING * FW + headBox.x + cx;
    const y = v * FH + headBox.y + cy;
    const i = at(x, y);
    const code = tt.regions[i];
    if (code === 'h') return col(i);
    if (code === '.' && col(i) && edgeAt(x, y) && L(col(i)) < DARK_L && near(x, y, 'h'))
      return col(i);
    return '';
  };
  const hairRamp = new Set<string>();
  for (let i = 0; i < W * H; i++) if (tt.regions[i] === 'h') hairRamp.add(col(i));
  parts.push(part(`hair-${k}`, 'hair', 'head', canvasGet(hair), hairRamp, gender));
  // clothes: t/b/f pixels, and the fixed pixels (outline, shirt, cuffs) beside them
  const own = anchorsOf(tt);
  const slotOf: Record<string, string> = { t: 'top', b: 'bottom', f: 'shoes' };
  const clothes = new Map<string, string[]>(
    Object.values(slotOf).map((sl) => [sl, new Array(W * H).fill('')]),
  );
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = at(x, y);
      const c = col(i);
      if (!c || paper.has(i) || glasses.has(i)) continue;
      const code = tt.regions[i];
      let sl = slotOf[code];
      if (!sl && code === '.') {
        const frame = Math.floor(y / FH) * FRAMES + Math.floor(x / FW);
        if (y % FH <= CHIN_ROW + own[frame].dy) continue; // the head: eyes, the face outline
        const by = near(x, y, 'tbf');
        if (by) sl = slotOf[by];
        else if (!(edgeAt(x, y) && L(c) < DARK_L)) sl = 'top';
      }
      if (sl) clothes.get(sl)![i] = c;
    }
  for (const [sl, px] of clothes) {
    if (px.filter(Boolean).length < MIN_PART_PIXELS) continue; // barefoot, or a dress and no trousers
    const ramp = new Set<string>();
    for (let i = 0; i < W * H; i++) if (slotOf[tt.regions[i]] === sl && px[i]) ramp.add(px[i]);
    parts.push(
      part(
        `${sl}-${k}`,
        sl,
        'sheet',
        (x, y) => px[at(x, y)],
        ramp,
        sl === 'top' ? gender : undefined,
      ),
    );
  }
});

const meta = {
  headBox,
  /** Per frame (row-major: down 0-6, up 7-13, right 14-20), the head canvas's top-left in the frame. */
  headAnchors: anchors.map((a) => [headBox.x + a.dx, headBox.y + a.dy]),
  /** The templates' eye dots (standing frame): which way a drawing faces. */
  eyeHints: EYE_HINTS,
  /** Drawn over every person in the reading frames; the glasses only without glasses of their own. */
  paper: encode(W, H, (x, y) => (paper.has(at(x, y)) ? templateColor(t, at(x, y)) : '')),
  glasses: encode(W, H, (x, y) => (glasses.has(at(x, y)) ? templateColor(t, at(x, y)) : '')),
  parts,
};
const metaFile = path.join(root, 'core/src/cld/parts.generated.ts');
// A .ts file (not .json): core and the daemon's tsc do not resolve JSON imports.
fs.writeFileSync(
  metaFile,
  `// Generated by cld/scripts/gen-char-templates.ts: do not edit.\n` +
    `import type { PartsMeta } from './partData.js';\n\n` +
    `export const PARTS_GENERATED: PartsMeta = JSON.parse(${JSON.stringify(JSON.stringify(meta))});\n`,
);
console.log(
  path.relative(root, metaFile),
  JSON.stringify(meta.headBox),
  parts.map((p) => p.id).join(' '),
);
