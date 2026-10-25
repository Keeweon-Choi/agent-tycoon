/**
 * CHAR-HUMAN: people made of parts (cld/docs/design/char-parts.md). A part is a slot, a kind
 * (`sheet`: 21 frames on the body grid; `head`: front/back/side views on the head canvas, placed on
 * every frame at the body's head anchor), a gender tag and its pixels. The built-in parts (the bald
 * body, two faces, the six built-ins split by their region maps) come from parts.generated.json
 * (`npx tsx cld/scripts/gen-char-templates.ts`). Pure and DOM-free.
 */
import { rgbaToHex } from '../../../../core/src/assets/colorUtils.js';
import type { PartSlot } from '../../../../core/src/cld/looks.js';
import { HUMANOID_SWATCHES, PART_SLOTS } from '../../../../core/src/cld/looks.js';
import {
  HD64,
  hdDensity,
  HEAD_H,
  HEAD_W,
  PART_ALPHABET as ALPHABET,
  PART_FRAME_H as FRAME_H,
  PART_FRAME_W as FRAME_W,
  PART_FRAMES as FRAMES,
  PART_VIEWS as VIEWS,
  type PartData,
  partProblem,
  PARTS_META,
  SHEET_H,
  SHEET_W,
} from '../../../../core/src/cld/partData.js';
import {
  BODY_FITS_STANDARD,
  LAYER_ORDER,
  SLOT_REGISTRY,
} from '../../../../core/src/cld/partRegistry.js';
import type {
  CharacterChoice,
  CharacterColors,
  CharacterGender,
} from '../../../../core/src/messages.js';
import { parseHex } from './color.js';
import type { DenseSheet } from './compose.js';
import { rampColours } from './template.js';

export { HEAD_H, HEAD_W, PART_SLOTS, partProblem, PARTS_META, SHEET_H, SHEET_W };
export type { PartData, PartSlot };
export type PartGender = CharacterGender;
/** Slots every person has (an unknown or missing id falls back to a built-in). */
export const REQUIRED_SLOTS: readonly PartSlot[] = PART_SLOTS.filter(
  (s) => SLOT_REGISTRY[s].required,
);
export const BUILT_IN_PARTS: readonly PartData[] = PARTS_META.parts;

/** A person look (v3, `kind: 'person'`): only these fields are read. */
export type PersonLook = Pick<CharacterChoice, 'gender' | 'parts' | 'colors' | 'body' | 'expr'>;
type PersonColors = CharacterColors;

/** The colour a slot's ramp takes (the face keeps its own): the registry's. */
export const COLOR_OF_SLOT: Readonly<Record<PartSlot, keyof PersonColors | null>> =
  Object.fromEntries(PART_SLOTS.map((s) => [s, SLOT_REGISTRY[s].color])) as Record<
    PartSlot,
    keyof PersonColors | null
  >;

const { headBox, headAnchors } = PARTS_META;

/** The built-in a required slot falls back to. */
export function defaultPart(slot: PartSlot, gender?: PartGender): string | null {
  switch (slot) {
    case 'body':
      return 'basic';
    case 'face':
      return gender === 'f' ? 'face-basic-f' : 'face-basic-m';
    case 'top':
      return gender === 'f' ? 'top-1' : 'top-0';
    case 'bottom':
      return 'bottom-0';
    default:
      return null;
  }
}

/** id -> part: the built-ins, then `custom` (the owner's) over them. */
export function partIndex(custom: readonly PartData[] = []): Map<string, PartData> {
  const index = new Map<string, PartData>();
  for (const p of [...BUILT_IN_PARTS, ...custom]) if (!partProblem(p)) index.set(p.id, p);
  return index;
}

/** One drawing of a part: the part's own, an expression of a face, the part for another body. */
type Art = { palette: string[]; pixels: string; ramp?: string[]; hd?: PartData['hd'] };

/** The drawing a look shows of a part: the face's expression (else neutral), the part drawn for
 *  the look's body (a standard drawing only where that body fits inside standard's silhouette),
 *  or null: not drawn for this body (never stretched). The body slot always has its art. */
export function artFor(p: PartData, look: PersonLook): Art | null {
  if (p.slot === 'face') return (look.expr && p.expressions?.[look.expr]) || p;
  const body = look.body ?? 'standard';
  if (p.kind !== 'sheet') return p;
  const own = p.bodies ?? ['standard'];
  if (p.variants?.[body]) return p.variants[body];
  if (own.includes(body) || (BODY_FITS_STANDARD[body] && own.includes('standard'))) return p;
  return null;
}

/** The parts a look wears per slot, each unknown id dropped or replaced by its slot's built-in, a
 *  full-body suit clearing top and bottom; `missing`: ids not found; `unavailable`: parts not drawn
 *  for the look's body. */
export function resolveParts(
  look: PersonLook,
  index: ReadonlyMap<string, PartData>,
): { layers: { part: PartData; art: Art }[]; missing: string[]; unavailable: string[] } {
  const missing: string[] = [];
  const unavailable: string[] = [];
  const chosen = new Map<PartSlot, PartData[]>();
  const find = (slot: PartSlot, id: string | undefined): PartData | null => {
    const p = id === undefined ? undefined : index.get(id);
    if (p && p.slot === slot) return p;
    if (id !== undefined) missing.push(id);
    const fallback = SLOT_REGISTRY[slot].required ? defaultPart(slot, look.gender) : null;
    return fallback ? (index.get(fallback) ?? null) : null;
  };
  const worn = look.parts ?? {};
  // only a suit that is drawn clears: an unknown one (its pack off or gone) or one not drawn for
  // this body leaves the built-in top and bottom, never a person in underwear
  const cleared = new Set(
    PART_SLOTS.filter((s) => {
      const p = s === 'acc' ? undefined : index.get(worn[s as Exclude<PartSlot, 'acc'>] ?? '');
      return p?.slot === s && !!artFor(p, look);
    }).flatMap((s) => SLOT_REGISTRY[s].clears ?? []),
  );
  for (const slot of PART_SLOTS) {
    if (cleared.has(slot)) continue;
    const many = SLOT_REGISTRY[slot].many;
    const ids: (string | undefined)[] =
      slot === 'acc' ? (worn.acc ?? []).slice(0, many) : [worn[slot as Exclude<PartSlot, 'acc'>]];
    const parts = ids.map((id) => find(slot, id)).filter((p): p is PartData => !!p);
    chosen.set(slot, parts);
  }
  const layers: { part: PartData; art: Art }[] = [];
  for (const slot of PART_SLOTS)
    for (const part of chosen.get(slot) ?? []) {
      let art = artFor(part, look);
      let shown = part;
      if (!art && slot === 'body') {
        // the body for the look's body variant (a pack's curvy body), else the chosen one as drawn:
        // a person is never invisible
        const other = [...index.values()].find((q) => q.slot === 'body' && artFor(q, look));
        [shown, art] = other ? [other, artFor(other, look)!] : [part, part];
        if (!other) unavailable.push(part.id);
      }
      if (art) layers.push({ part: shown, art });
      else unavailable.push(part.id);
    }
  return { layers, missing, unavailable };
}

/** A part's colours after the look's pick for its slot (rrggbb -> #RRGGBB): its HD art's when it
 *  has HD and the sheet is HD, else its classic art's. */
function partColours(
  p: { palette: string[]; pixels: string; ramp: string[] },
  target: string | undefined,
): string[] {
  const out = p.palette.map((c) => `#${c.toUpperCase()}`);
  if (!target || !p.ramp.length) return out;
  const counts = new Map<string, number>();
  for (const k of p.pixels) {
    if (k === '.') continue;
    const c = p.palette[ALPHABET.indexOf(k)];
    if (p.ramp.includes(c)) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const moved = rampColours(counts, parseHex(target));
  return p.palette.map((c, i) => {
    const rgb = moved.get(c);
    return rgb ? rgbaToHex(rgb[0], rgb[1], rgb[2], 255) : out[i];
  });
}

/** Paint art `p` of density `from` (recoloured) onto the sheet of density `d` (#RRGGBB / ''): a
 *  classic part on an HD sheet is drawn ×2 nearest, never the reverse. */
function paint(
  sheet: string[],
  p: { palette: string[]; pixels: string },
  colours: string[],
  kind: PartData['kind'],
  d: number,
  from: number,
  only?: number,
) {
  const w = SHEET_W * d;
  const scale = from / d;
  const rowH = FRAME_H * d;
  if (kind === 'sheet') {
    const [y0, y1] = only === undefined ? [0, SHEET_H * d] : [only * rowH, (only + 1) * rowH];
    for (let y = y0; y < y1; y++)
      for (let x = 0; x < w; x++) {
        const k = p.pixels[Math.floor(y * scale) * SHEET_W * from + Math.floor(x * scale)];
        if (k !== '.') sheet[y * w + x] = colours[ALPHABET.indexOf(k)];
      }
    return;
  }
  const [bw, bh] = [headBox.w * d, headBox.h * d];
  for (let v = 0; v < VIEWS.length; v++)
    for (let f = 0; f < FRAMES; f++) {
      if (only !== undefined && v !== only) continue;
      const [ax, ay] = headAnchors[v * FRAMES + f];
      for (let cy = 0; cy < bh; cy++)
        for (let cx = 0; cx < bw; cx++) {
          const sx = v * headBox.w * from + Math.floor(cx * scale);
          const k = p.pixels[Math.floor(cy * scale) * HEAD_W * from + sx];
          if (k === '.') continue;
          const x = ax * d + cx;
          const y = ay * d + cy;
          if (x < 0 || y < 0 || x >= FRAME_W * d || y >= FRAME_H * d) continue;
          sheet[(v * FRAME_H * d + y) * w + f * FRAME_W * d + x] = colours[ALPHABET.indexOf(k)];
        }
    }
}

/** ponytail: glasses-type accessories are told by their id (`acc-roundglasses`); a tag on the
 *  part if the owner names one otherwise. */
export const isGlasses = (id: string) => /glass/i.test(id);

/** A person's sheet: every part in layer order, recoloured, the reading paper (and the built-in
 *  reading glasses, unless the person wears glasses) on top. Never invisible: the body is always a
 *  built-in when the asked one is unknown. */
export function composePerson(
  look: PersonLook,
  custom: readonly PartData[] = [],
  opts: { classic?: boolean } = {},
): { sheet: DenseSheet; missing: string[]; unavailable: string[] } {
  const { layers, missing, unavailable } = resolveParts(look, partIndex(custom));
  // the finest density a shown drawing has (the others drawn ×2 or ×4 nearest); classic when
  // there is none, or when asked (HD64-SAMPLE: the 16×32 copy from each part's own classic art)
  const d = opts.classic
    ? 1
    : (Math.max(1, ...layers.map((l) => (l.art.hd ? hdDensity(l.art.hd) : 1))) as 1 | 2 | 4);
  const flat: string[] = new Array(SHEET_W * SHEET_H * d * d).fill('');
  VIEWS.forEach((view, v) => {
    // each view's own order (the back slot is behind the body from the front, over it from behind)
    for (const slot of LAYER_ORDER[view])
      for (const { part, art } of layers) {
        if (part.slot !== slot) continue;
        const slotColor = COLOR_OF_SLOT[part.slot];
        const target = slotColor ? look.colors?.[slotColor] : undefined;
        const ramp = art.ramp ?? part.ramp;
        const draw = d > 1 && art.hd ? art.hd : { palette: art.palette, pixels: art.pixels, ramp };
        const from = draw === art.hd ? hdDensity(art.hd) : 1;
        paint(flat, draw, partColours(draw, target), part.kind, d, from, v);
      }
  });
  const fixed = (o: { palette: string[] }) => o.palette.map((c) => `#${c.toUpperCase()}`);
  // the built-in reading glasses are classic art: ×4 they would be a black bar (HD64 waits for
  // a pair drawn at 64×128; ponytail: none on density 4 until then)
  if (d < HD64 && !layers.some((l) => l.part.slot === 'acc' && isGlasses(l.part.id)))
    paint(flat, PARTS_META.glasses, fixed(PARTS_META.glasses), 'sheet', d, 1);
  paint(flat, PARTS_META.paper, fixed(PARTS_META.paper), 'sheet', d, 1);
  const frame = (v: number, f: number) =>
    Array.from({ length: FRAME_H * d }, (_, y) =>
      Array.from(
        { length: FRAME_W * d },
        (_, x) => flat[(v * FRAME_H * d + y) * SHEET_W * d + f * FRAME_W * d + x],
      ),
    );
  const row = (v: number) => Array.from({ length: FRAMES }, (_, f) => frame(v, f));
  const sheet: DenseSheet = { down: row(0), up: row(1), right: row(2) };
  if (d > 1) sheet.density = d;
  return { sheet, missing, unavailable };
}

/** Parts of a slot, the gender's own first, then the shared ones, then the other gender's. */
export function partsForSlot(
  slot: PartSlot,
  gender: PartGender | undefined,
  custom: readonly PartData[] = [],
): PartData[] {
  const rank = (p: PartData) => (!gender || p.gender === gender ? 0 : p.gender ? 2 : 1);
  return [...partIndex(custom).values()]
    .filter((p) => p.slot === slot)
    .sort((a, b) => rank(a) - rank(b));
}

/** Chance an optional slot is worn by a random person. */
const WEAR_CHANCE: Partial<Record<PartSlot, number>> = {
  shoes: 0.8,
  outer: 0.3,
  hair: 0.9,
  acc: 0.3,
  fullbody: 0.15,
  legwear: 0.2,
  neck: 0.15,
  wrist: 0.1,
  back: 0.05,
};

/** 무작위 within a gender: a part per slot from that gender's and the shared ones (never the other
 *  gender's), drawn for the look's body; a swatch per colour. Keeps the body. Always a look the
 *  daemon stores as it is. */
export function randomPerson(
  gender: PartGender | undefined,
  custom: readonly PartData[] = [],
  rand: () => number = Math.random,
  keep: Pick<CharacterChoice, 'body'> = {},
): CharacterChoice {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.min(list.length - 1, Math.floor(rand() * list.length))];
  const fits = (p: PartData) => (!gender || !p.gender || p.gender === gender) && !!artFor(p, keep);
  const parts: NonNullable<CharacterChoice['parts']> = {};
  for (const slot of PART_SLOTS) {
    if (parts.fullbody && SLOT_REGISTRY.fullbody.clears?.includes(slot)) continue;
    const options = partsForSlot(slot, gender, custom).filter(fits);
    if (!options.length) continue;
    const chance = WEAR_CHANCE[slot];
    if (chance !== undefined && rand() >= chance) continue;
    if (slot === 'acc') parts.acc = [pick(options).id];
    else parts[slot] = pick(options).id;
    for (const cleared of SLOT_REGISTRY[slot].clears ?? []) delete parts[cleared as 'top'];
  }
  const swatch = (k: keyof CharacterColors) =>
    pick(k === 'skin' || k === 'hair' ? HUMANOID_SWATCHES[k] : HUMANOID_SWATCHES.clothes);
  const colors: CharacterColors = { skin: swatch('skin'), hair: swatch('hair') };
  for (const slot of PART_SLOTS) {
    const key = COLOR_OF_SLOT[slot];
    if (key && key !== 'skin' && key !== 'hair' && key !== 'acc' && parts[slot as 'top'])
      colors[key] = swatch(key);
  }
  if (!parts.top && !parts.fullbody) colors.top = swatch('top');
  if (!parts.bottom && !parts.fullbody) colors.bottom = swatch('bottom');
  return {
    v: 3,
    kind: 'person',
    ...(gender && { gender }),
    ...(keep.body && keep.body !== 'standard' && { body: keep.body }),
    parts,
    colors,
  };
}
