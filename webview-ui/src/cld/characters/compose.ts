/**
 * CH-2: the looks compositor. Any look (a v1 palette + hue, a v2 mascot, a v3 person, a custom
 * sheet) becomes today's sheet (rows down/up/right × 7 frames of 16×32) for setCustomCharacter,
 * with its card portrait and the anchors the office draws around it. Pure and DOM-free.
 *
 * Never invisible (design §3.5): a look that cannot be drawn falls back to the provider's
 * mascot, then to built-in person 0.
 */
import { type MascotExpression, mascotOfProvider } from '../../../../core/src/cld/looks.js';
import { downsampleHd } from '../../../../core/src/cld/partData.js';
import { MIN_FRAME_PIXELS } from '../../../../core/src/cld/sheetCheck.js';
import type {
  CharacterChoice,
  MascotGear,
  MascotSpecies,
  OfficeSnapshot,
} from '../../../../core/src/messages.js';
import {
  HD64_DRAW_DENSITY,
  IMPORT_WORLD_H,
  IMPORT_WORLD_W,
  MUGSHOT_CROP_LEFT_COL,
  MUGSHOT_CROP_SIDE_PX,
  MUGSHOT_CROP_TOP_ROW,
} from '../../constants.js';
import { adjustSprite } from '../../office/colorize.js';
import type { LoadedCharacterData } from '../../office/sprites/spriteData.js';
import type { SpriteData } from '../../office/types.js';
import { chroma, hue, lchToRgb, parseHex, rgbToLab } from './color.js';
import boo from './mascots/boo.json';
import bugi from './mascots/bugi.json';
import byteJson from './mascots/byte.json';
import coralJson from './mascots/coral.json';
import gasi from './mascots/gasi.json';
import gearJson from './mascots/gear.json';
import kwak from './mascots/kwak.json';
import moka from './mascots/moka.json';
import mora from './mascots/mora.json';
import mungge from './mascots/mungge.json';
import puffJson from './mascots/puff.json';
import shoo from './mascots/shoo.json';
import toriJson from './mascots/tori.json';
import type { PartData } from './parts.js';
import { composePerson } from './parts.js';

export const FRAME_W = 16;
export const FRAME_H = 32;
export const FRAMES = 7;
/** An imported sheet's column counts: 7; CHAR-ISO-1: 8 (the walking neutral); BUNNY-9COL: 9 (the
 *  other foot's passing pose). */
export const IMPORTED_COLUMNS: readonly number[] = [FRAMES, FRAMES + 1, FRAMES + 2];
export const VIEWS = ['down', 'up', 'right'] as const;
export type View = (typeof VIEWS)[number];
/** A custom sheet frame needs at least this many opaque pixels (design §4.3). */
export { MIN_FRAME_PIXELS } from '../../../../core/src/cld/sheetCheck.js';
/** Where a person's mouth is in the standing front frame (the old char_N body, which the person
 *  parts and imported sheets keep): the rest prop's anchor. */
export const HUMAN_SIP: readonly [number, number] = [8, 17];
/** CHARS-1104: the built-in people's mouth (`sip` in the sheets' index.json; ponytail: one value for
 *  all 23, a per-sheet table when one differs). */
export const BUILT_IN_SIP: readonly [number, number] = [8, 14];

/** The provider a name's character runs on, when the screen knows it (the fallback mascot). */
export function providerOf(
  office: Pick<OfficeSnapshot, 'orchestrators'>,
  name: string,
): string | null {
  if (name.startsWith('emp:')) return null; // set by the caller from the execution
  return office.orchestrators.find((o) => o.name === name)?.provider === 'claude' ? 'claude' : null;
}

/** CHARS-1104: the provider a sub-agent with no employee yet takes its mascot from: its lead's when
 *  the screen knows it, else Claude Code, the only provider whose tools make sub-agents
 *  (claude.ts subagentToolNames; an unnamed session or an engine Lead is not on the screen). */
export const subagentProvider = (
  office: Pick<OfficeSnapshot, 'orchestrators'>,
  lead: string | undefined,
): string => (lead === undefined ? null : providerOf(office, lead)) ?? 'claude';

/** CHARS-1104: the built-in people's groups in the people tab (index.json order: 10 nerds, 10 Silicon
 *  Valley, 3 Indian engineers; a sheet past them, an external char_N, joins the last group). */
const PEOPLE_GROUPS = [
  { key: 'nerd', from: 0 },
  { key: 'valley', from: 10 },
  { key: 'india', from: 20 },
] as const;
export type PeopleGroup = (typeof PEOPLE_GROUPS)[number]['key'];

/** The groups and their sheet numbers for \`count\` loaded sheets: only sheets that are there
 *  (none before they arrive), an empty group left out. */
export function peopleGroups(count: number): Array<{ key: PeopleGroup; people: number[] }> {
  return PEOPLE_GROUPS.flatMap((g, i) => {
    const to = Math.min(PEOPLE_GROUPS[i + 1]?.from ?? count, count);
    const people = [...Array(Math.max(0, to - g.from)).keys()].map((k) => g.from + k);
    return people.length ? [{ key: g.key, people }] : [];
  });
}

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
  /** DIAG-1104: the three-quarter walk (walk1, stand, walk3) facing lower right and upper right,
   *  with its own anchors and faces (a face only facing lower right). */
  diag?: {
    frames: Record<DiagView, string[][]>;
    anchors: Record<DiagView, MascotAnchor[]>;
    faces: Record<string, Partial<Record<DiagView, Array<Array<number | string>>>>>;
  };
}
type DiagView = 'downRight' | 'upRight';

export const MASCOTS: Readonly<Record<MascotSpecies, MascotData>> = {
  coral: coralJson as MascotData,
  byte: byteJson as MascotData,
  puff: puffJson as MascotData,
  tori: toriJson as MascotData,
  kwak: kwak as MascotData,
  bugi: bugi as MascotData,
  moka: moka as MascotData,
  mungge: mungge as MascotData,
  boo: boo as MascotData,
  gasi: gasi as MascotData,
  mora: mora as MascotData,
  shoo: shoo as MascotData,
};

/** CHAR-FACTORY: a sheet with its density (sprite pixels per world pixel; absent = 1). An HD sheet
 *  (density 2) has 32×64 frames in the same order and rows, its anchors in world pixels. The
 *  office's LoadedCharacterData gains the same optional field on the renderer's side. */
export type DenseSheet = LoadedCharacterData & { density?: 1 | 2 | 4 };
export const densityOf = (sheet: DenseSheet): 1 | 2 | 4 => sheet.density ?? 1;

/** A sheet at half its density: each pixel the colour most of its four share (outline kept,
 *  core downsampleHd); `clean` (HD64's 32×64 copy): then a one-pixel hole filled from its
 *  neighbours and a pixel with no neighbour dropped (the halving's own specks). */
export function halveSheet(sheet: DenseSheet, clean = densityOf(sheet) === 4): DenseSheet {
  const d = densityOf(sheet);
  const [w, h] = [(FRAME_W * d) / 2, (FRAME_H * d) / 2];
  const frame = (f: SpriteData): SpriteData => {
    const at = downsampleHd((x, y) => (f[y]?.[x] ? f[y][x].slice(1, 7).toLowerCase() : ''));
    const out = Array.from({ length: h }, (_, y) =>
      Array.from({ length: w }, (_, x) => {
        const c = at(x, y);
        return c ? `#${c.toUpperCase()}` : '';
      }),
    );
    const n4 = (x: number, y: number) =>
      [out[y - 1]?.[x], out[y + 1]?.[x], out[y]?.[x - 1], out[y]?.[x + 1]].filter(
        (c): c is string => !!c,
      );
    if (!clean) return out;
    const fix = out.map((row) => [...row]);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const around = n4(x, y);
        if (!out[y][x] && around.length === 4) {
          const counts = new Map<string, number>();
          for (const c of around) counts.set(c, (counts.get(c) ?? 0) + 1);
          fix[y][x] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        } else if (out[y][x] && !around.length) fix[y][x] = '';
      }
    return fix;
  };
  const half = {
    down: sheet.down.map(frame),
    up: sheet.up.map(frame),
    right: sheet.right.map(frame),
  };
  return d / 2 > 1 ? { ...half, density: (d / 2) as 2 } : half;
}

/** The classic copy of an HD sheet for what cannot draw HD: its own 16×32 copy when it carries one
 *  (HD64: drawn for legibility), else halved (2×2, a one-pixel HD outline kept). */
export function classicOf(sheet: DenseSheet): LoadedCharacterData {
  let s: DenseSheet = sheet;
  while (densityOf(s) > 1) s = s.lods?.find((l) => densityOf(l) === 1) ?? halveSheet(s);
  return { down: s.down, up: s.up, right: s.right };
}

/** HD64: a density-4 sheet with its copies for zooms 4 does not divide: the 32×64 (the master
 *  halved and cleaned) and the 16×32 (`classic`: the look composed from each part's own 16×32
 *  drawing; else the 32×64 halved again). */
export function withLods(sheet: DenseSheet, classic?: DenseSheet): DenseSheet {
  if (densityOf(sheet) !== 4) return sheet;
  const half = halveSheet(sheet);
  return { ...sheet, lods: [half, classic ?? halveSheet(half)] };
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
  /** The built-in sheets char_0..CHAR_COUNT-1. */
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
  // CHARS-1104: a v2 humanoid draws as its built-in person (its colours and accessories are gone)
  if (look.kind === 'humanoid') return `p:${look.base ?? 0}:${look.hue ?? 0}`;
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
  // CHARS-1104: an old v2 humanoid (stored before the 23 people) is its base person, colours and
  // accessories dropped (ponytail: read for one release, then the daemon's parser drops it)
  if (look.kind === 'humanoid') return builtIn(look.base ?? 0, look.hue ?? 0, ctx);
  if (look.kind === 'person') {
    const sheet = composePerson(look, ctx.parts).sheet;
    const classic =
      densityOf(sheet) === 4 ? composePerson(look, ctx.parts, { classic: true }).sheet : undefined;
    // SHEET-IMPORT (owner 10-26 03:10): a 64×128 person draws 1.33 times its classic size
    const sized =
      densityOf(sheet) === 4
        ? { ...withLods(sheet, classic), drawDensity: HD64_DRAW_DENSITY }
        : sheet;
    return finish(sized, null, HUMAN_SIP, 0);
  }
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
  return finish(sheet, null, BUILT_IN_SIP, 0);
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
  // an HD look's card portrait keeps its detail (the office's crop is the classic one); HD64's
  // from its 32×64 copy, the card's size
  const hd = densityOf(sheet) === 4 ? (sheet.lods?.[0] ?? halveSheet(sheet)) : sheet;
  const portrait = mugshot ?? (densityOf(hd) === 2 ? portraitOf(hd) : null);
  return { sheet, mugshot: portrait, headTop, sip, clipped, fellBack: null };
}

/** Why a sheet cannot be drawn (wrong size, an empty frame), or null. */
export function sheetProblem(sheet: DenseSheet): string | null {
  const d = densityOf(sheet);
  for (const view of VIEWS) {
    const frames = sheet[view];
    // CHAR-ISO-1, BUNNY-9COL: an imported sheet may carry an 8th and a 9th column
    if (!IMPORTED_COLUMNS.includes(frames?.length ?? 0))
      return `${view}: ${frames?.length ?? 0} frames, not ${FRAMES}`;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      // SHEET-IMPORT: an imported sheet's frames are 24×44 world px
      const [w, h] =
        d === 4 && f.length === IMPORT_WORLD_H * d
          ? [IMPORT_WORLD_W * d, IMPORT_WORLD_H * d]
          : [FRAME_W * d, FRAME_H * d];
      if (f.length !== h || f.some((row) => row.length !== w))
        return `${view} ${i + 1}: not ${w}×${h}`;
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

/** One mascot look's sheet: recolour, face, headgear (pure; equal looks give equal sheets).
 *  DIAG-1104: its three-quarter walk the same way, when the species has one that draws. */
export function composeMascot(look: MascotLook, data: MascotData): ComposedLook {
  const species = (look.species ?? data.species) as MascotSpecies;
  const color = (look.color ?? data.color).toLowerCase();
  const expr = look.expr ?? 'smile';
  if (!data.faces[expr]) throw new Error(`${species}: no face ${expr}`);
  const palette = mascotPalette(data, color);
  const gearPalette = gearJson.palette as Record<string, string>;
  let clipped = 0;
  /** One frame: its colour keys recoloured, the face at the anchor, the gear on the head box. */
  const draw = (
    rows: string[],
    a: MascotAnchor,
    face: Array<Array<number | string>> | undefined,
    gearView: View,
    what: string,
  ): SpriteData => {
    const f: SpriteData = rows.map((row) => [...row].map((k) => (k === '.' ? '' : palette[k])));
    if (
      f.length !== FRAME_H ||
      f.some((r) => r.length !== FRAME_W || r.includes(undefined as never))
    )
      throw new Error(`${species}: ${what} is not a ${FRAME_W}×${FRAME_H} frame`);
    const put = (px: number, py: number, c: string) => {
      if (px < 0 || py < 0 || px >= FRAME_W || py >= FRAME_H) clipped++;
      else f[py][px] = c;
    };
    if (a.face && face)
      for (const [u, v, k] of face)
        put(a.face[0] + Number(u), a.face[1] + Number(v), palette[String(k)]);
    if (look.gear) {
      const pixels = gearPixels(look.gear, a, gearView);
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
  };
  const sheet = {} as LoadedCharacterData;
  for (const view of VIEWS) {
    const frames = data.frames[view];
    if (frames?.length !== FRAMES) throw new Error(`${species}: ${view} has no ${FRAMES} frames`);
    sheet[view] = frames.map((rows, i) =>
      draw(rows, data.anchors[view][i], data.faces[expr][view], view, `${view} ${i + 1}`),
    );
  }
  const [mx, my] = data.mug;
  const mugshot = sheet.down[1].slice(my, my + 16).map((row) => row.slice(mx, mx + 16));
  const out = finish(sheet, mugshot, [data.sip[0], data.sip[1]], clipped);
  // a diagonal walk that does not draw is left out: the four views stand in (diagSheetOf)
  const diag = data.diag;
  if (diag)
    try {
      const walk = (view: DiagView, gearView: View) =>
        diag.frames[view].map((rows, i) =>
          draw(rows, diag.anchors[view][i], diag.faces[expr]?.[view], gearView, `${view} ${i + 1}`),
        );
      [sheet.downRight, sheet.upRight] = [walk('downRight', 'down'), walk('upRight', 'up')];
      out.clipped = clipped;
    } catch (err) {
      console.warn(`[cld] ${err instanceof Error ? err.message : String(err)}: no diagonal walk`);
    }
  return out;
}
