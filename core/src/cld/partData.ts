/**
 * CHAR-HUMAN: the part format shared by the webview's compositor and the daemon's importer, and the
 * generated geometry (head canvas, head anchors, reading paper, built-in parts) from
 * `npx tsx cld/scripts/gen-char-templates.ts`. Pure, no I/O.
 */
import type { CharacterPart } from '../messages.js';
import type { PartSlot } from './looks.js';
import { PARTS_GENERATED } from './parts.generated.js';

export type PartData = CharacterPart;

export interface PartsMeta {
  headBox: { x: number; y: number; w: number; h: number };
  /** Per frame (down 0-6, up 7-13, right 14-20): the head canvas's top-left in the frame. */
  headAnchors: number[][];
  /** The templates' eye dots in the standing frame: front columns, side columns, rows. */
  eyeHints: { front: number[]; side: number[]; rows: number[] };
  paper: { palette: string[]; pixels: string };
  glasses: { palette: string[]; pixels: string };
  parts: PartData[];
}
export const PARTS_META = PARTS_GENERATED;

/** Pixel codes: '.' transparent, else an index into the palette. */
export const PART_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const SHEET_W = 112;
export const SHEET_H = 96;
export const PART_FRAME_W = 16;
export const PART_FRAME_H = 32;
export const PART_FRAMES = 7;
export const PART_VIEWS = ['down', 'up', 'right'] as const;
export const HEAD_W = PARTS_META.headBox.w * PART_VIEWS.length;
export const HEAD_H = PARTS_META.headBox.h;
/** CHAR-FACTORY HD: twice the detail in the same world size (density 2). */
export const HD = 2;
/** HD64-SAMPLE: the master spec, four times the detail (64×128 frames). */
export const HD64 = 4;
/** The density of a part's detailed art (absent = HD). */
export const hdDensity = (hd: { density?: number }): number => hd.density ?? HD;

/** Colours (rrggbb, '' transparent) at twice the detail -> the classic copy: a pixel is drawn
 *  when at least two of its four are, in their most common colour; a tie (or four different
 *  colours) takes the one nearest their average, so neither the outline nor the fill always wins.
 *  `get` reads the HD picture. */
export function downsampleHd(get: (x: number, y: number) => string) {
  const rgb = (c: string) => [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16));
  return (x: number, y: number): string => {
    const four = [
      get(2 * x, 2 * y),
      get(2 * x + 1, 2 * y),
      get(2 * x, 2 * y + 1),
      get(2 * x + 1, 2 * y + 1),
    ].filter(Boolean);
    if (four.length < 2) return '';
    const counts = new Map<string, number>();
    for (const c of four) counts.set(c, (counts.get(c) ?? 0) + 1);
    const top = Math.max(...counts.values());
    const best = [...counts.keys()].filter((c) => counts.get(c) === top);
    if (best.length === 1) return best[0];
    const mean = [0, 1, 2].map((k) => four.reduce((t, c) => t + rgb(c)[k], 0) / four.length);
    const off = (c: string) => rgb(c).reduce((t, v, k) => t + (v - mean[k]) ** 2, 0);
    return best.sort((a, b) => off(a) - off(b) || (a < b ? -1 : 1))[0];
  };
}

/** w×h colours (rrggbb, '' transparent) as a palette and a pixel string; null past 62 colours. */
export function encodePixels(
  w: number,
  h: number,
  get: (x: number, y: number) => string,
): { palette: string[]; pixels: string } | null {
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
      if (k >= PART_ALPHABET.length) return null;
      pixels += PART_ALPHABET[k];
    }
  return { palette, pixels };
}

/** Why a part cannot be drawn (wrong size, a pixel outside its palette), or null. */
export function partProblem(p: PartData): string | null {
  const want = p.kind === 'sheet' ? SHEET_W * SHEET_H : HEAD_W * HEAD_H;
  if (typeof p.pixels !== 'string' || p.pixels.length !== want)
    return `${p.id}: ${p.pixels?.length ?? 0} pixels, not ${want}`;
  if (!Array.isArray(p.palette) || p.palette.length > PART_ALPHABET.length)
    return `${p.id}: bad palette`;
  if (!p.palette.every((c) => /^[0-9a-f]{6}$/.test(c))) return `${p.id}: bad colour`;
  const bad = (q: { palette: string[]; pixels: string }) => {
    for (const k of q.pixels)
      if (
        k !== '.' &&
        !(PART_ALPHABET.indexOf(k) >= 0 && PART_ALPHABET.indexOf(k) < q.palette.length)
      )
        return true;
    return false;
  };
  if (bad(p)) return `${p.id}: bad pixel`;
  // the detailed art of the part, of its expressions and of its other bodies
  for (const art of [
    p,
    ...Object.values(p.expressions ?? {}),
    ...Object.values(p.variants ?? {}),
  ]) {
    const hd = art.hd;
    if (!hd) continue;
    const d = hdDensity(hd);
    if (d !== HD && d !== HD64) return `${p.id}: bad HD density`;
    if (typeof hd.pixels !== 'string' || hd.pixels.length !== want * d * d)
      return `${p.id}: bad HD size`;
    if (
      !Array.isArray(hd.palette) ||
      hd.palette.length > PART_ALPHABET.length ||
      !hd.palette.every((c) => /^[0-9a-f]{6}$/.test(c))
    )
      return `${p.id}: bad HD palette`;
    if (bad(hd)) return `${p.id}: bad HD pixel`;
  }
  return null;
}

/** `slot-name[-f|-m][-down|-up|-right].png` -> what it is; null when the slot is not one. */
export function parsePartFileName(file: string): {
  slot: PartSlot;
  name: string;
  gender?: 'm' | 'f';
  view: (typeof PART_VIEWS)[number] | null;
} | null {
  const m =
    /^(back|body|face|legwear|bottom|shoes|top|fullbody|outer|neck|wrist|hair|acc)-([a-z0-9]+(?:-[a-z0-9]+)*?)(?:-(f|m))?(?:-(down|up|right))?\.png$/i.exec(
      file.split(/[\\/]/).pop() ?? '',
    );
  if (!m) return null;
  return {
    slot: m[1].toLowerCase() as PartSlot,
    name: m[2].toLowerCase(),
    ...(m[3] && { gender: m[3].toLowerCase() as 'm' | 'f' }),
    view: (m[4]?.toLowerCase() as (typeof PART_VIEWS)[number] | undefined) ?? null,
  };
}
