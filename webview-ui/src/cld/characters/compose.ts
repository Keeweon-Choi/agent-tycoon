/**
 * CH-2: the looks compositor. Any look (a v1 palette + hue, a v2 humanoid, a v2 mascot, a custom
 * sheet) becomes today's sheet (rows down/up/right × 7 frames of 16×32) for setCustomCharacter,
 * with its card portrait and the anchors the office draws around it. Pure and DOM-free.
 *
 * Never invisible (design §3.5): a look that cannot be drawn falls back to the provider's
 * mascot, then to built-in person 0.
 */
import { rgbaToHex } from '../../../../core/src/assets/colorUtils.js';
import {
  HUMANOID_ACCESSORIES,
  type MascotExpression,
  mascotOfProvider,
} from '../../../../core/src/cld/looks.js';
import { downsampleHd } from '../../../../core/src/cld/partData.js';
import { MIN_FRAME_PIXELS } from '../../../../core/src/cld/sheetCheck.js';
import type {
  CharacterAccessory,
  CharacterChoice,
  MascotGear,
  MascotSpecies,
} from '../../../../core/src/messages.js';
import {
  MUGSHOT_CROP_LEFT_COL,
  MUGSHOT_CROP_SIDE_PX,
  MUGSHOT_CROP_TOP_ROW,
} from '../../constants.js';
import { adjustSprite } from '../../office/colorize.js';
import type { LoadedCharacterData } from '../../office/sprites/spriteData.js';
import type { SpriteData } from '../../office/types.js';
import accessoriesJson from './accessories.json';
import { chroma, hue, lchToRgb, parseHex, rgbToLab } from './color.js';
import byteJson from './mascots/byte.json';
import coralJson from './mascots/coral.json';
import gearJson from './mascots/gear.json';
import puffJson from './mascots/puff.json';
import toriJson from './mascots/tori.json';
import type { PartData } from './parts.js';
import { composePerson } from './parts.js';
import type { Region } from './template.js';
import { recolourSheet, templateColor, TEMPLATES } from './template.js';

export const FRAME_W = 16;
export const FRAME_H = 32;
export const FRAMES = 7;
export const VIEWS = ['down', 'up', 'right'] as const;
export type View = (typeof VIEWS)[number];
/** A custom sheet frame needs at least this many opaque pixels (design §4.3). */
export { MIN_FRAME_PIXELS } from '../../../../core/src/cld/sheetCheck.js';
/** Where a person's mouth is in the standing front frame (char_N): the rest prop's anchor. */
export const HUMAN_SIP: readonly [number, number] = [8, 17];

export interface MascotAnchor {
  face: number[] | null;
  /** [x, y, width] of the head box. */
  head: number[];
  /** The topmost head row (antenna, ears, cap stem included). */
  top: number;
}

/** One species' colour-indexed sheet (`mascots/<species>.json`, from gen-mascots.ts). */
export interface MascotData {
  species: string;
  palette: Record<string, string>;
  /** The slots (hi, mid, sh, dk) the look's colour recolours. */
  body: string;
  /** The default body colour (the mid slot). */
  color: string;
  frames: Record<View, string[][]>;
  anchors: Record<View, MascotAnchor[]>;
  faces: Record<string, Partial<Record<View, Array<Array<number | string>>>>>;
  mug: number[];
  sip: number[];
}

export const MASCOTS: Readonly<Record<MascotSpecies, MascotData>> = {
  coral: coralJson as MascotData,
  byte: byteJson as MascotData,
  puff: puffJson as MascotData,
  tori: toriJson as MascotData,
};

/** CHAR-FACTORY: a sheet with its density (sprite pixels per world pixel; absent = 1). An HD sheet
 *  (density 2) has 32×64 frames in the same order and rows, its anchors in world pixels. The
 *  office's LoadedCharacterData gains the same optional field on the renderer's side. */
export type DenseSheet = LoadedCharacterData & { density?: 1 | 2 };
export const densityOf = (sheet: DenseSheet): 1 | 2 => sheet.density ?? 1;

/** The classic copy of an HD sheet (2×2, a one-pixel HD outline kept) for what cannot draw HD. */
export function classicOf(sheet: DenseSheet): LoadedCharacterData {
  if (densityOf(sheet) === 1) return sheet;
  const frame = (f: SpriteData): SpriteData => {
    const at = downsampleHd((x, y) => (f[y]?.[x] ? f[y][x].slice(1, 7).toLowerCase() : ''));
    return Array.from({ length: FRAME_H }, (_, y) =>
      Array.from({ length: FRAME_W }, (_, x) => {
        const c = at(x, y);
        return c ? `#${c.toUpperCase()}` : '';
      }),
    );
  };
  return { down: sheet.down.map(frame), up: sheet.up.map(frame), right: sheet.right.map(frame) };
}

/** The card portrait of a sheet: the classic crop (MUGSHOT_CROP_*) of the standing-front frame at
 *  the sheet's own density, so an HD sheet's portrait keeps its detail. */
export function portraitOf(sheet: DenseSheet): SpriteData {
  const d = densityOf(sheet);
  const f = sheet.down[0];
  const side = MUGSHOT_CROP_SIDE_PX * d;
  return Array.from({ length: side }, (_, y) =>
    Array.from(
      { length: side },
      (_, x) => f[y + MUGSHOT_CROP_TOP_ROW * d]?.[x + MUGSHOT_CROP_LEFT_COL * d] ?? '',
    ),
  );
}

export interface ComposedLook {
  sheet: DenseSheet;
  /** 16×16 card face, or null: the card crops the sheet's head as for a person. */
  mugshot: SpriteData | null;
  /** First opaque row of the standing front frame. */
  headTop: number;
  /** The mouth in the standing front frame: where the rest drink goes. */
  sip: readonly [number, number];
  /** Overlay pixels (gear, faces, their outline) that fell outside a frame: 0 for good data. */
  clipped: number;
  /** Why the asked look was not drawn (the fallback was), or null. */
  fellBack: string | null;
}

export interface ComposeContext {
  /** The built-in sheets char_0..5. */
  templates: readonly LoadedCharacterData[];
  /** A custom look's decoded sheet, when it loaded (null: it failed). */
  custom?: { sheet: LoadedCharacterData; mugshot: SpriteData | null } | null;
  /** The character's provider ('claude', 'codex', ...): the mascot a broken look falls back to. */
  provider?: string | null;
  /** The mascot sheets (tests swap a broken one in). */
  mascots?: Readonly<Record<MascotSpecies, MascotData>>;
  /** The owner's parts (CHAR-HUMAN), over the built-in ones. */
  parts?: readonly PartData[];
}

export type MascotLook = Pick<CharacterChoice, 'species' | 'color' | 'expr' | 'gear'>;

const isMascot = (look: CharacterChoice) => look.kind === 'mascot';

/** The cache key: equal for looks that draw the same (defaults filled in). Null = no look. */
export function lookKey(
  look: CharacterChoice | undefined,
  provider?: string | null,
): string | null {
  if (!look) return null;
  if (look.preset !== undefined) return `c:${look.preset}`;
  if (look.palette !== undefined) return `p:${look.palette}:${look.hueShift ?? 0}`;
  if (look.kind === 'humanoid') {
    const colors = Object.entries(look.colors ?? {})
      .map(([part, c]) => `${part}=${c.toLowerCase()}`)
      .sort()
      .join(',');
    const acc = HUMANOID_ACCESSORIES.filter((a) => look.acc?.includes(a)).join(',');
    return `h:${look.base ?? 0}:${colors || (look.hue ?? 0)}:${acc}`;
  }
  if (isMascot(look)) {
    const m = normalizeMascot(look, provider);
    return `m:${m.species}:${m.color}:${m.expr}:${m.gear ?? '-'}`;
  }
  if (look.kind === 'person') {
    // part ids are never reused for other pixels (an import gets a new id), so ids are enough
    const sorted = (o: object = {}) => JSON.stringify(Object.entries(o).sort());
    return `P:${look.gender ?? ''}:${look.body ?? ''}:${look.expr ?? ''}:${sorted(look.parts)}:${sorted(look.colors).toLowerCase()}`;
  }
  return null;
}

function normalizeMascot(look: MascotLook, provider?: string | null) {
  const species = look.species ?? mascotOfProvider(provider);
  return {
    species,
    color: (look.color ?? MASCOTS[species].color).toLowerCase(),
    expr: look.expr ?? ('smile' as MascotExpression),
    gear: look.gear,
  };
}

/** The look, or the fallback chain when it cannot be drawn. Never throws, never invisible. */
export function compose(look: CharacterChoice, ctx: ComposeContext): ComposedLook {
  try {
    return { ...composeExact(look, ctx), fellBack: null };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    try {
      const species = mascotOfProvider(ctx.provider);
      return { ...composeMascot({ species }, (ctx.mascots ?? MASCOTS)[species]), fellBack: why };
    } catch {
      return { ...builtIn(0, 0, ctx), fellBack: why };
    }
  }
}

function composeExact(look: CharacterChoice, ctx: ComposeContext): ComposedLook {
  if (look.preset !== undefined) {
    if (!ctx.custom) throw new Error(`sheet ${look.preset} did not load`);
    const problem = sheetProblem(ctx.custom.sheet);
    if (problem) throw new Error(problem);
    return finish(ctx.custom.sheet, ctx.custom.mugshot, HUMAN_SIP, 0);
  }
  if (look.palette !== undefined) return builtIn(look.palette, look.hueShift ?? 0, ctx);
  if (look.kind === 'humanoid') return composeHumanoid(look, ctx);
  if (look.kind === 'person')
    return finish(composePerson(look, ctx.parts).sheet, null, HUMAN_SIP, 0);
  if (isMascot(look)) {
    const m = normalizeMascot(look, ctx.provider);
    return composeMascot(m, (ctx.mascots ?? MASCOTS)[m.species]);
  }
  throw new Error('not a look');
}

/** A built-in sheet with its hue, exactly as getCharacterSprites draws `palette:hueShift`. */
function builtIn(palette: number, hueShift: number, ctx: ComposeContext): ComposedLook {
  if (!ctx.templates.length) throw new Error('no built-in sheets loaded');
  const base = ctx.templates[palette % ctx.templates.length];
  const shift = (s: SpriteData) =>
    hueShift ? adjustSprite(s, { h: hueShift, s: 0, b: 0, c: 0 }) : s;
  const sheet = {
    down: base.down.map(shift),
    up: base.up.map(shift),
    right: base.right.map(shift),
  };
  return finish(sheet, null, HUMAN_SIP, 0);
}

// ── people (CH-5) ───────────────────────────────────────────────────────────

interface AccLayer {
  at: 'top' | 'eye';
  y: number;
  rows: string[];
  from?: number;
}
interface Accessories {
  palette: Record<string, string>;
  pieces: Record<CharacterAccessory, Partial<Record<View, AccLayer[]>>>;
}
export const ACCESSORIES = accessoriesJson as Accessories;

/** Where a body's pieces hang on one frame: its head's first row of 4+ pixels, its eyes' row. */
export interface HeadAnchor {
  top: number;
  eye: number;
}

/** A sheet from a template's RGBA (char_N.png layout). */
function sheetOfRgba(rgba: ArrayLike<number>, width: number): LoadedCharacterData {
  const frame = (row: number, f: number): SpriteData =>
    Array.from({ length: FRAME_H }, (_, y) =>
      Array.from({ length: FRAME_W }, (_, x) => {
        const i = ((row * FRAME_H + y) * width + f * FRAME_W + x) * 4;
        return rgbaToHex(rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]);
      }),
    );
  const row = (r: number) => Array.from({ length: FRAMES }, (_, f) => frame(r, f));
  return { down: row(0), up: row(1), right: row(2) };
}

const anchorCache = new Map<number, Record<View, HeadAnchor[]>>();
/** Every frame's head anchors on built-in body \`base\`, read off its own sheet (walk bob, seated
 *  and reading frames); the back view takes its eyes from the front frame's distance to the top. */
export function headAnchors(base: number): Record<View, HeadAnchor[]> {
  const hit = anchorCache.get(base);
  if (hit) return hit;
  const t = TEMPLATES[base];
  const px = (view: number, f: number, x: number, y: number) =>
    templateColor(t, (view * FRAME_H + y) * t.width + f * FRAME_W + x);
  const frame = (view: number, f: number): HeadAnchor => {
    let top = -1;
    let eye = -1;
    for (let y = 0; y < FRAME_H; y++) {
      let n = 0;
      for (let x = 0; x < FRAME_W; x++) {
        const c = px(view, f, x, y);
        if (c) n++;
        // the eyes (and the built-in reading glasses on their row) are the only black up here
        if (c === '000000' && eye < 0 && y < EYES_MAX_ROW) eye = y;
      }
      if (n >= HEAD_MIN_PIXELS && top < 0) top = y;
    }
    return { top, eye };
  };
  const all = (view: number) => Array.from({ length: FRAMES }, (_, f) => frame(view, f));
  const down = all(0);
  const up = all(1).map((a, f) => ({ top: a.top, eye: a.top + down[f].eye - down[f].top }));
  const anchors = { down, up, right: all(2) };
  anchorCache.set(base, anchors);
  return anchors;
}
const HEAD_MIN_PIXELS = 4;
const EYES_MAX_ROW = 24;
/** The built-in reading frames (read1, read2) and the frame their head is drawn from (type1). */
const READ_FRAMES = [5, 6];
const TYPE_FRAME = 3;

// eslint-disable-next-line pixel-agents/no-inline-colors -- a sprite pixel: the built-ins' eye and glasses black
const isBlack = (c: string) => c.slice(0, 7) === '#000000';

/**
 * A person: a built-in body (\`base\`) with its own colours, the \`hue\` turn, or part \`colors\`
 * painted over its region map (shading steps kept); then the accessories on each frame's head.
 */
function composeHumanoid(look: CharacterChoice, ctx: ComposeContext): ComposedLook {
  const base = look.base ?? 0;
  if (!TEMPLATES[base]) throw new Error(`no body ${base}`);
  const colors = look.colors && Object.keys(look.colors).length ? look.colors : null;
  const sheet: LoadedCharacterData = colors
    ? sheetOfRgba(
        recolourSheet(
          Object.fromEntries(
            Object.entries(colors).map(([part, c]) => [part, parseHex(c)]),
          ) as Partial<Record<Region, [number, number, number]>>,
          TEMPLATES[base],
        ),
        TEMPLATES[base].width,
      )
    : ctx.templates.length
      ? builtIn(base, look.hue ?? 0, ctx).sheet
      : // ponytail: Node scripts without the PNGs draw the hue-less body from its template
        sheetOfRgba(recolourSheet({}, TEMPLATES[base]), TEMPLATES[base].width);
  const acc = HUMANOID_ACCESSORIES.filter((a) => look.acc?.includes(a));
  if (!acc.length) return finish(sheet, null, HUMAN_SIP, 0);
  const anchors = headAnchors(base);
  let clipped = 0;
  const out = {} as LoadedCharacterData;
  for (const view of VIEWS) {
    out[view] = sheet[view].map((f) => f.map((row) => [...row]));
    if (acc.includes('glasses') && view !== 'up')
      // only our glasses: the reading frames get the typing frame's eyes back
      for (const f of READ_FRAMES) {
        const a = anchors[view][f];
        const src = sheet[view][TYPE_FRAME];
        const dy = a.eye - anchors[view][TYPE_FRAME].eye;
        for (let y = a.eye; y <= a.eye + 2; y++)
          for (let x = 0; x < FRAME_W; x++) {
            const s = src[y - dy]?.[x] ?? '';
            const d = out[view][f][y][x];
            if (s !== d && (s || isBlack(d))) out[view][f][y][x] = s;
          }
      }
    out[view].forEach((f, i) => {
      const a = anchors[view][i];
      for (const name of acc)
        for (const layer of ACCESSORIES.pieces[name][view] ?? []) {
          const y0 = (layer.at === 'top' ? a.top : a.eye) + layer.y;
          layer.rows.forEach((row, dy) =>
            [...row].forEach((k, x) => {
              if (k === '.') return;
              const y = y0 + dy;
              if (layer.from !== undefined && y < a.top + layer.from) return;
              if (y < 0 || y >= FRAME_H) clipped++;
              else f[y][x] = ACCESSORIES.palette[k];
            }),
          );
        }
    });
  }
  return finish(out, null, HUMAN_SIP, clipped);
}

function finish(
  sheet: DenseSheet,
  mugshot: SpriteData | null,
  sip: readonly [number, number],
  clipped: number,
): ComposedLook {
  const front = sheet.down[1];
  // world pixels: an HD sheet's row counts half
  const headTop = Math.max(
    0,
    Math.floor(front.findIndex((row) => row.some(Boolean)) / densityOf(sheet)),
  );
  // an HD look's card portrait keeps its detail (the office's crop is the classic one)
  const portrait = mugshot ?? (densityOf(sheet) === 2 ? portraitOf(sheet) : null);
  return { sheet, mugshot: portrait, headTop, sip, clipped, fellBack: null };
}

/** Why a sheet cannot be drawn (wrong size, an empty frame), or null. */
export function sheetProblem(sheet: DenseSheet): string | null {
  const d = densityOf(sheet);
  for (const view of VIEWS) {
    const frames = sheet[view];
    if (frames?.length !== FRAMES) return `${view}: ${frames?.length ?? 0} frames, not ${FRAMES}`;
    for (let i = 0; i < FRAMES; i++) {
      const f = frames[i];
      if (f.length !== FRAME_H * d || f.some((row) => row.length !== FRAME_W * d))
        return `${view} ${i + 1}: not ${FRAME_W * d}×${FRAME_H * d}`;
      if (f.flat().filter(Boolean).length < MIN_FRAME_PIXELS) return `${view} ${i + 1}: empty`;
    }
  }
  return null;
}

// ── mascots ─────────────────────────────────────────────────────────────────

const hex = (rgb: readonly number[]) =>
  '#' +
  rgb
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();

const recolours = new Map<string, Record<string, string>>();
/**
 * The species' palette with its body slots moved to `color`: each slot keeps its designed
 * lightness step, chroma ratio and hue turn from the default mid colour (OKLab/OKLCh).
 */
export function mascotPalette(data: MascotData, color: string): Record<string, string> {
  const key = `${data.species}:${color}`;
  const hit = recolours.get(key);
  if (hit) return hit;
  const palette: Record<string, string> = {};
  for (const [k, v] of Object.entries(data.palette)) palette[k] = v.toUpperCase();
  const mid = rgbToLab(parseHex(data.color));
  const want = rgbToLab(parseHex(color));
  for (const slot of data.body) {
    const was = rgbToLab(parseHex(data.palette[slot]));
    const ratio = chroma(mid) > 1e-6 ? chroma(was) / chroma(mid) : 1;
    palette[slot] = hex(
      lchToRgb(want.L + was.L - mid.L, chroma(want) * ratio, hue(want) + hue(was) - hue(mid)),
    );
  }
  palette[data.body[1]] = color.toUpperCase();
  recolours.set(key, palette);
  return palette;
}

type Px = [number, number, string];

/** Headgear pixels on one frame's head box (gear.json slots), before its outline. */
function gearPixels(gear: MascotGear, a: MascotAnchor, view: View): Px[] {
  const [x, y, w] = a.head;
  const out: Px[] = [];
  const c = x + Math.floor(w / 2);
  switch (gear) {
    case 'headset': {
      for (let X = x; X < x + w; X++) out.push([X, y - 1, 'k']);
      const cups = view === 'right' ? [c - 1] : [x, x + w - 2];
      for (const cx of cups)
        for (let Y = y + 2; Y <= y + 5; Y++)
          for (const X of [cx, cx + 1]) out.push([X, Y, Y === y + 2 || Y === y + 5 ? 'k' : 'r']);
      if (view !== 'right') for (const X of [x, x + w - 1]) out.push([X, y, 'k'], [X, y + 1, 'k']);
      else out.push([c - 1, y, 'k'], [c - 1, y + 1, 'k']);
      return out;
    }
    case 'beanie': {
      for (let Y = y - 3; Y <= y + 1; Y++) {
        const inset = Y === y - 3 ? 3 : Y === y - 2 ? 1 : 0;
        for (let X = x + inset; X <= x + w - 1 - inset; X++)
          out.push([X, Y, Y === y + 1 ? 'P' : (X + Y) % 2 ? 'p' : 'q']);
      }
      out.push([c - 1, y - 4, 'w'], [c, y - 4, 'w']);
      return out;
    }
    case 'sprout': {
      const t = a.top;
      out.push([c, t - 1, 's'], [c, t - 2, 's'], [c - 1, t - 3, 'g'], [c - 2, t - 3, 'G']);
      out.push([c + 1, t - 3, 'g'], [c + 1, t - 4, 'G']);
      return out;
    }
    case 'crown': {
      const t = a.top;
      for (let X = c - 2; X <= c + 2; X++) out.push([X, t - 1, 'y']);
      out.push([c - 2, t - 2, 'y'], [c, t - 2, 'y'], [c + 2, t - 2, 'y'], [c, t - 3, 'j']);
      return out;
    }
  }
}

/** One mascot look's sheet: recolour, face, headgear (pure; equal looks give equal sheets). */
export function composeMascot(look: MascotLook, data: MascotData): ComposedLook {
  const species = (look.species ?? data.species) as MascotSpecies;
  const color = (look.color ?? data.color).toLowerCase();
  const expr = look.expr ?? 'smile';
  if (!data.faces[expr]) throw new Error(`${species}: no face ${expr}`);
  const palette = mascotPalette(data, color);
  const gearPalette = gearJson.palette as Record<string, string>;
  let clipped = 0;
  const sheet = {} as LoadedCharacterData;
  for (const view of VIEWS) {
    const frames = data.frames[view];
    if (frames?.length !== FRAMES) throw new Error(`${species}: ${view} has no ${FRAMES} frames`);
    sheet[view] = frames.map((rows, i) => {
      const f: SpriteData = rows.map((row) => [...row].map((k) => (k === '.' ? '' : palette[k])));
      if (
        f.length !== FRAME_H ||
        f.some((r) => r.length !== FRAME_W || r.includes(undefined as never))
      )
        throw new Error(`${species}: ${view} ${i + 1} is not a ${FRAME_W}×${FRAME_H} frame`);
      const a = data.anchors[view][i];
      const put = (px: number, py: number, c: string) => {
        if (px < 0 || py < 0 || px >= FRAME_W || py >= FRAME_H) clipped++;
        else f[py][px] = c;
      };
      const face = a.face && data.faces[expr][view];
      if (a.face && face)
        for (const [u, v, k] of face)
          put(a.face[0] + Number(u), a.face[1] + Number(v), palette[String(k)]);
      if (look.gear) {
        const pixels = gearPixels(look.gear, a, view);
        const mine = new Set(pixels.map(([px, py]) => `${px},${py}`));
        for (const [px, py, k] of pixels) put(px, py, gearPalette[k]);
        // the gear's own outline, only where nothing is drawn yet
        for (const [px, py] of pixels)
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ]) {
            const nx = px + dx;
            const ny = py + dy;
            if (mine.has(`${nx},${ny}`)) continue;
            if (nx < 0 || ny < 0 || nx >= FRAME_W || ny >= FRAME_H) clipped++;
            else if (!f[ny][nx]) f[ny][nx] = gearPalette.o;
          }
      }
      return f;
    });
  }
  const [mx, my] = data.mug;
  const mugshot = sheet.down[1].slice(my, my + 16).map((row) => row.slice(mx, mx + 16));
  return finish(sheet, mugshot, [data.sip[0], data.sip[1]], clipped);
}
