/**
 * The recolour templates (T-0017, CH-5): each built-in sheet with region masks found by
 * comparing the six sheets pixel by pixel. A pixel is recolourable when the six
 * sheets disagree there; recolourable pixels are grouped by their colour in
 * their own sheet (REGIONS_BY_BASE). Pixels the six sheets agree on (eyes, the reading
 * glasses and clipboard) and char_0 colours outside the table (the white shirt
 * and cuffs) stay as they are. The result is shipped as template.generated.json;
 * regenerate it with `npx tsx cld/scripts/gen-character-template.ts`.
 */
import type { Rgb } from './color.js';
import { chroma, hue, lchToRgb, parseHex, rgbToLab } from './color.js';
import TEMPLATE_JSON from './template.generated.json';

/** One RGBA sheet (an ImageData or a decoded PNG). */
export interface Sheet {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

export type Region = 'hair' | 'skin' | 'top' | 'bottom' | 'shoes';
export const REGION_CODES: Record<string, Region> = {
  h: 'hair',
  s: 'skin',
  t: 'top',
  b: 'bottom',
  f: 'shoes',
};

/**
 * Colour (rrggbb) -> region code, one table per built-in sheet (CH-5). char_0's was read off the
 * per-colour class maps: the outlines of hair, face and suit are the darkest step of their region
 * (the built-ins recolour them too), #071c2e is both the trousers and the suit's outline, #040605
 * is the tie. The other five were read the same way off their own sheets (`grid` dumps of the
 * standing, seated and reading frames). Bodies 2, 4 and 6 are barefoot and body 2 wears a dress
 * (no trousers): a part a body does not have is simply not in its table.
 */
const REGIONS_BY_BASE: readonly Record<string, string>[] = [
  {
    // hair: outline, side lines, shade, lower shade, main, highlight
    '32191d': 'h',
    '341f20': 'h',
    '6d4726': 'h',
    '6f4a2a': 'h',
    '8f6439': 'h',
    b18649: 'h',
    // skin: outline, mouth, neck, shade, main, blush, highlight
    '493e38': 's',
    '84523a': 's',
    c5896e: 's',
    e29878: 's',
    e9a384: 's',
    fbbf97: 's',
    ffd8b2: 's',
    // top: tie, shade, main, highlight, collar back
    '040605': 't',
    '0f406a': 't',
    '114978': 't',
    '1164a9': 't',
    '352c27': 't',
    // bottom: trousers (and the suit outline)
    '071c2e': 'b',
    // shoes: outline, sole, main, highlight
    '000000': 'f',
    '1a1a1a': 'f',
    '353535': 'f',
    '595959': 'f',
  },
  {
    ...codes('h', '7e4b29 be7743 e39f5a f1c084'),
    ...codes('s', '493e38 e9a384 c5896e fbbf97 e29878 ffd8b2 bd8068 5e514c'),
    ...codes('t', '252525 101010 2b2b2b 1a1a1a'),
  },
  {
    ...codes('h', '181616 221e1e 1b1a19 282423 2b2827 252120'),
    ...codes('s', '5f4132 493227 593b2c 75503d 865e4c 352c27 84523a'),
    ...codes('t', 'f67d20 e1721d e8741b e87218 ff8b31 56110e 8b1a16 a91d18 741713 592700'),
    ...codes('b', '111528 343d5a 49557e 23294d'),
    ...codes('f', '120308 d0d0d0 595959 fff2ec'),
  },
  {
    ...codes('h', 'b0a6a3 daccc9 bfb6b3 f0e1de fff1ef e9d7d4'),
    ...codes('s', '423732 b67352 8c583f ac6847 e08d64 ffa77c 352c27 84523a'),
    ...codes('t', 'd4d4d4 4c4c4c eeeeee bdbdbd'),
    ...codes('b', '3c314f d2b48e 796064 ac9082'),
  },
  {
    ...codes('h', '432415 2f160f 57351a 69451b 421b19 442414'),
    ...codes('s', 'e9a384 493e38 c5896e e29878 fbbf97 ffd8b2 bd8068 352c27 5e514c'),
    ...codes('t', 'd4d4d4 4c4c4c eeeeee bdbdbd'),
    ...codes('b', '071c2e 114978 0f406a 0b100c'),
    ...codes('f', '000000 353535 595959 1a1a1a'),
  },
  {
    ...codes('h', '202020 0e0e0e 303030 373737 414141 282828 131313'),
    ...codes(
      's',
      'fcd6c4 e1aa91 cf9d86 ffede5 fff6f2 ffe0d2 ba917e b0886c c1a496 594b45 705e56 c4a68e b48d7c ad8572 cab3a9 564842 5f4f3f',
    ),
    ...codes('t', '640026 b24737 e16451 9f3f31'),
    ...codes('b', '0f0c13 332c23 2a2320 1d1718'),
  },
];

function codes(code: string, colors: string): Record<string, string> {
  return Object.fromEntries(colors.split(' ').map((c) => [c, code]));
}

/** Pixel-to-palette code: '.' is transparent, then one character per colour. */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export interface TemplateData {
  width: number;
  height: number;
  /** char_0's colours, rrggbb. */
  palette: string[];
  /** One ALPHABET character per pixel (index into palette), '.' = transparent. */
  pixels: string;
  /** One region code per pixel, '.' = keep char_0's colour. */
  regions: string;
}

function hexAt(sheet: Sheet, i: number): string {
  const d = sheet.data;
  if (d[i * 4 + 3] < 2) return '';
  return [0, 1, 2].map((c) => d[i * 4 + c].toString(16).padStart(2, '0')).join('');
}

const FRAME_W = 16;
const FRAME_H = 32;
/** Shoes are on frame rows from here down (CH-5: the reading glasses share their colours). */
const SHOES_MIN_ROW = 24;
/** Outline pixels are darker than this (OKLab lightness). */
const OUTLINE_MAX_L = 0.4;

/** On the silhouette's edge: a 4-neighbour in its 16×32 frame is transparent (or off the frame). */
function onEdge(sheet: Sheet, i: number): boolean {
  const x = i % sheet.width;
  const y = Math.floor(i / sheet.width);
  return [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ].some(([dx, dy]) => {
    const fx = (x % FRAME_W) + dx;
    const fy = (y % FRAME_H) + dy;
    if (fx < 0 || fy < 0 || fx >= FRAME_W || fy >= FRAME_H) return true;
    return sheet.data[((y + dy) * sheet.width + x + dx) * 4 + 3] < 2;
  });
}

/** Build sheet \`index\`'s template from the six built-in sheets (char_0 first). The
 *  outline -- dark pixels on the silhouette's edge -- stays like the eyes. */
export function computeTemplate(sheets: readonly Sheet[], index = 0): TemplateData {
  const base = sheets[index];
  const table = REGIONS_BY_BASE[index];
  const palette: string[] = [];
  let pixels = '';
  let regions = '';
  for (let i = 0; i < base.width * base.height; i++) {
    const hex = hexAt(base, i);
    if (!hex) {
      pixels += '.';
      regions += '.';
      continue;
    }
    let index = palette.indexOf(hex);
    if (index < 0) index = palette.push(hex) - 1;
    pixels += ALPHABET[index];
    const varies = sheets.some((sheet) => hexAt(sheet, i) !== hex);
    const outline = onEdge(base, i) && rgbToLab(parseHex(`#${hex}`)).L < OUTLINE_MAX_L;
    // Black or grey higher up than the feet is eyes or reading glasses, never shoes.
    const code =
      table[hex] === 'f' && Math.floor(i / base.width) % FRAME_H < SHOES_MIN_ROW ? '.' : table[hex];
    regions += varies && !outline ? (code ?? '.') : '.';
  }
  return { width: base.width, height: base.height, palette, pixels, regions };
}

/** Recolourable pixels per region code. */
export function regionCounts(t: TemplateData): Record<string, number> {
  const out: Record<string, number> = {};
  for (const code of t.regions) if (code !== '.') out[code] = (out[code] ?? 0) + 1;
  return out;
}

/** The shipped templates, one per built-in sheet (CH-5); char_0's is the photo converter's. */
export const TEMPLATES: readonly TemplateData[] = TEMPLATE_JSON;
export const TEMPLATE: TemplateData = TEMPLATES[0];

/** char_0's colour at pixel i as rrggbb, or '' when transparent. */
export function templateColor(t: TemplateData, i: number): string {
  const code = t.pixels[i];
  return code === '.' ? '' : t.palette[ALPHABET.indexOf(code)];
}

/** Lightness range region shading is squeezed into (OKLab L). */
export const L_MIN = 0.06;
const L_MAX = 0.96;

/** One colour ramp (rrggbb -> pixels) moved to \`target\`: the most used colour becomes it, every
 *  other step keeps its lightness offset and chroma ratio (squeezed into L_MIN..L_MAX). */
export function rampColours(colors: ReadonlyMap<string, number>, target: Rgb): Map<string, Rgb> {
  const out = new Map<string, Rgb>();
  if (!colors.size) return out;
  const main = [...colors].sort((a, b) => b[1] - a[1])[0][0];
  const mainLab = rgbToLab(parseHex(`#${main}`));
  const want = rgbToLab(target);
  const tL = Math.min(L_MAX, Math.max(L_MIN, want.L));
  const offsets = [...colors.keys()].map((hex) => {
    const lab = rgbToLab(parseHex(`#${hex}`));
    return {
      hex,
      dL: lab.L - mainLab.L,
      ratio: chroma(mainLab) > 1e-3 ? chroma(lab) / chroma(mainLab) : 1,
    };
  });
  const lo = Math.min(0, ...offsets.map((o) => o.dL));
  const hi = Math.max(0, ...offsets.map((o) => o.dL));
  let squeeze = 1;
  if (lo < 0) squeeze = Math.min(squeeze, (tL - L_MIN) / -lo);
  if (hi > 0) squeeze = Math.min(squeeze, (L_MAX - tL) / hi);
  for (const o of offsets)
    out.set(o.hex, lchToRgb(tL + squeeze * o.dL, Math.min(0.3, chroma(want) * o.ratio), hue(want)));
  return out;
}

/** A template recoloured (char_0 by default; CH-5: any built-in body): each region's steps keep
 *  their offset from the region's main colour. A part left out keeps its own colours. */
export function recolourSheet(
  looks: Partial<Record<Region, Rgb | null>>,
  t: TemplateData = TEMPLATE,
): Uint8ClampedArray<ArrayBuffer> {
  const n = t.width * t.height;
  const steps = new Map<string, Map<string, number>>(); // code -> colour -> pixels
  for (let i = 0; i < n; i++) {
    const code = t.regions[i];
    if (code === '.') continue;
    const colors = steps.get(code) ?? new Map<string, number>();
    const hex = templateColor(t, i);
    colors.set(hex, (colors.get(hex) ?? 0) + 1);
    steps.set(code, colors);
  }
  const mapped = new Map<string, Rgb>(); // code + colour -> new colour
  for (const [code, colors] of steps) {
    const target = looks[REGION_CODES[code]];
    if (!target) continue;
    for (const [hex, rgb] of rampColours(colors, target)) mapped.set(code + hex, rgb);
  }
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const hex = templateColor(t, i);
    if (!hex) continue;
    const rgb = mapped.get(t.regions[i] + hex) ?? parseHex(`#${hex}`);
    out.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  }
  return out;
}
