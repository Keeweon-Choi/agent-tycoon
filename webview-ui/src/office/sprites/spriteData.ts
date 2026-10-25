import type { ColorValue } from '../../components/ui/types.js';
import { CLASSIC_FIGURE_RISE, PALETTE_COUNT, THINKING_DOT_COLOR } from '../../constants.js';
import { adjustSprite } from '../colorize.js';
import type { Direction, SpriteData } from '../types.js';
import { Direction as Dir } from '../types.js';
import bubblePermissionData from './bubble-permission.json';
import bubblePetData from './bubble-pet.json';
import bubbleWaitingData from './bubble-waiting.json';
import { copyFor, deriveSmooth, markSmooth } from './smoothSprite.js';

// ── Speech Bubble Sprites ───────────────────────────────────────

interface BubbleSpriteJson {
  palette: Record<string, string>;
  pixels: string[][];
}

function resolveBubbleSprite(data: BubbleSpriteJson): SpriteData {
  return data.pixels.map((row) => row.map((key) => data.palette[key] ?? key));
}

/** Permission bubble: white square with "..." in amber, and a tail pointer (11x13) */
export const BUBBLE_PERMISSION_SPRITE: SpriteData = resolveBubbleSprite(bubblePermissionData);

/** Waiting bubble: white square with green checkmark, and a tail pointer (11x13) */
export const BUBBLE_WAITING_SPRITE: SpriteData = resolveBubbleSprite(bubbleWaitingData);

/** Heart bubble: pet petting feedback (11x13) */
export const BUBBLE_HEART_SPRITE: SpriteData = resolveBubbleSprite(bubblePetData);

/** The thinking bubble with `dots` dots (0..3): 2 px wider per dot, so it grows as the dots come (13 rows tall for every frame: the body is 7 rows low, so the tail tip stays where it was). */
export function thinkingBubbleSprite(dots: number): SpriteData {
  const width = 2 * dots + 5;
  const mid = Math.floor(width / 2); // the tail's column: the anchor
  return Array.from({ length: 13 }, (_, row) =>
    Array.from({ length: width }, (_, col) => {
      const edge = row === 3 || row === 9 || col === 0 || col === width - 1;
      if (row >= 3 && row <= 9 && edge) return '#555566';
      // The dots sit inside the body, so they come before the body fill.
      if (row === 6 && col >= 3 && (col - 3) % 2 === 0 && (col - 3) / 2 < dots)
        return THINKING_DOT_COLOR;
      if (row >= 3 && row <= 9) return '#EEEEFF';
      if (row === 10 && Math.abs(col - mid) <= 1) return '#555566';
      if (row === 11 && col === mid) return '#555566';
      return '';
    }),
  );
}

/** Thinking bubble frames: 0 → 1 → 2 → 3 dots, then round again (the messenger's loop). */
export const BUBBLE_THINKING_SPRITES: SpriteData[] = [0, 1, 2, 3].map(thinkingBubbleSprite);

// ════════════════════════════════════════════════════════════════
// Loaded character sprites (from PNG assets)
// ════════════════════════════════════════════════════════════════

export interface LoadedCharacterData {
  down: SpriteData[];
  up: SpriteData[];
  right: SpriteData[];
  /** HD (owner 10-25): sprite px per world px. Absent = 1 (16x32 frames); 2 = 32x64 frames
   *  drawn in the same 16x32 world rect at twice the detail; 4 = 64x128 (HD64, the master). */
  density?: 1 | 2 | 4;
  /** HD64: the same character at lower densities (32x64, 16x32), for what cannot draw it (the
   *  office draws the master itself at every zoom, SHEET-IMPORT). */
  lods?: LoadedCharacterData[];
  /** SHEET-IMPORT: the walk's four frames (indexes into a row; absent = 0, 1, 2, 1) and the
   *  standing frame (absent = the walk's second): an imported sheet stands on column 1. */
  walk?: readonly [number, number, number, number];
  stand?: number;
  /** SHEET-IMPORT: the density it draws at, when not `density` (a 64×128 person draws at 3:
   *  1.33 times its world size, owner 10-26 03:10). */
  drawDensity?: number;
}

let loadedCharacters: LoadedCharacterData[] | null = null;

/** SHEET-IMPORT: from this density a character draws one master at every zoom; a classic frame's
 *  world height. */
const CLASSIC_FRAME_H = 32;
const SMOOTH_DENSITY = 4;

/** SHEET-IMPORT: a preset's isometric sheet (palette) beside its top-view one, which the
 *  isometric view draws instead. */
const isoPalettes = new Map<number, number>();
export function setIsoPalette(topPalette: number, isoPalette: number): void {
  isoPalettes.set(topPalette, isoPalette);
}
export const isoPaletteOf = (palette: number): number => isoPalettes.get(palette) ?? palette;

// cld-gui (T-0017): preset sheets, drawn through the same cache as char_N under
// palette numbers above the built-ins, with an optional card portrait.
const customCharacters = new Map<
  number,
  { sheet: LoadedCharacterData; mugshot: SpriteData | null }
>();

export function setCustomCharacter(
  palette: number,
  sheet: LoadedCharacterData,
  mugshot: SpriteData | null,
): void {
  customCharacters.set(palette, { sheet, mugshot });
  for (const key of [...spriteCache.keys()])
    if (key.startsWith(`${palette}:`)) spriteCache.delete(key);
}

/** cld-gui (CH-4): a preset sheet as loaded, for the 꾸미기 preview. */
export const getCustomCharacter = (palette: number) => customCharacters.get(palette) ?? null;

export function getCustomMugshot(palette: number): SpriteData | null {
  return customCharacters.get(palette)?.mugshot ?? null;
}

/** Set pre-colored character sprites loaded from PNG assets. Call this when characterSpritesLoaded message arrives. */
export function setCharacterTemplates(data: LoadedCharacterData[]): void {
  loadedCharacters = data;
  // Clear cache so sprites are rebuilt from loaded data
  spriteCache.clear();
}

/** cld-gui (CH-2): the built-in sheets char_N as loaded (empty before they arrive). */
export function getCharacterTemplates(): readonly LoadedCharacterData[] {
  return loadedCharacters ?? [];
}

/** Return the number of loaded character palettes, or PALETTE_COUNT as fallback. */
export function getLoadedCharacterCount(): number {
  return loadedCharacters ? loadedCharacters.length : PALETTE_COUNT;
}

/** Flip a SpriteData horizontally (for generating left sprites from right) */
function flipSpriteHorizontal(sprite: SpriteData): SpriteData {
  return sprite.map((row) => [...row].reverse());
}

// ════════════════════════════════════════════════════════════════
// Sprite resolution + caching
// ════════════════════════════════════════════════════════════════

export interface CharacterSprites {
  walk: Record<Direction, [SpriteData, SpriteData, SpriteData, SpriteData]>;
  typing: Record<Direction, [SpriteData, SpriteData]>;
  reading: Record<Direction, [SpriteData, SpriteData]>;
  /** Sprite px per world px (LoadedCharacterData.density): draw at zoom / density. */
  density: number;
  /** HD64: the same sprites at lower densities (LoadedCharacterData.lods). */
  lods?: CharacterSprites[];
  /** SHEET-IMPORT: the standing frame per direction, when it is not the walk's second. */
  stand?: Record<Direction, SpriteData>;
}

/** The sprites to draw at `zoom`: the finest of the character's densities that divides the zoom
 *  into whole device pixels (HD64 at 4 and 8, its 32×64 at 2 and 6, its 16×32 at odd zooms); a
 *  zoom no density divides (a fractional one) takes the coarsest. A sheet without copies is
 *  itself, as before. */
export function spritesAtZoom(sprites: CharacterSprites, zoom: number): CharacterSprites {
  // SHEET-IMPORT (owner 10-26): a detailed character (density 4 and up) draws its one master at
  // every zoom (smoothSprite.ts), never a copy picked by the zoom
  if (!sprites.lods?.length || sprites.density >= SMOOTH_DENSITY) return sprites;
  const all = [sprites, ...sprites.lods].sort((a, b) => b.density - a.density);
  return all.find((s) => Number.isInteger(zoom / s.density)) ?? all[all.length - 1];
}

const spriteCache = new Map<string, CharacterSprites>();

/** Apply hue shift to every sprite in a CharacterSprites set */
function hueShiftSprites(sprites: CharacterSprites, hueShift: number): CharacterSprites {
  const color: ColorValue = { h: hueShift, s: 0, b: 0, c: 0 };
  const shift = (s: SpriteData) => {
    const out = copyFor(s) ?? adjustSprite(s, color);
    deriveSmooth(s, out, { adjust: color });
    return out;
  };
  const shiftWalk = (
    arr: [SpriteData, SpriteData, SpriteData, SpriteData],
  ): [SpriteData, SpriteData, SpriteData, SpriteData] => [
    shift(arr[0]),
    shift(arr[1]),
    shift(arr[2]),
    shift(arr[3]),
  ];
  const shiftPair = (arr: [SpriteData, SpriteData]): [SpriteData, SpriteData] => [
    shift(arr[0]),
    shift(arr[1]),
  ];
  return {
    walk: {
      [Dir.DOWN]: shiftWalk(sprites.walk[Dir.DOWN]),
      [Dir.UP]: shiftWalk(sprites.walk[Dir.UP]),
      [Dir.RIGHT]: shiftWalk(sprites.walk[Dir.RIGHT]),
      [Dir.LEFT]: shiftWalk(sprites.walk[Dir.LEFT]),
    } as Record<Direction, [SpriteData, SpriteData, SpriteData, SpriteData]>,
    typing: {
      [Dir.DOWN]: shiftPair(sprites.typing[Dir.DOWN]),
      [Dir.UP]: shiftPair(sprites.typing[Dir.UP]),
      [Dir.RIGHT]: shiftPair(sprites.typing[Dir.RIGHT]),
      [Dir.LEFT]: shiftPair(sprites.typing[Dir.LEFT]),
    } as Record<Direction, [SpriteData, SpriteData]>,
    reading: {
      [Dir.DOWN]: shiftPair(sprites.reading[Dir.DOWN]),
      [Dir.UP]: shiftPair(sprites.reading[Dir.UP]),
      [Dir.RIGHT]: shiftPair(sprites.reading[Dir.RIGHT]),
      [Dir.LEFT]: shiftPair(sprites.reading[Dir.LEFT]),
    } as Record<Direction, [SpriteData, SpriteData]>,
    density: sprites.density,
    ...(sprites.lods && { lods: sprites.lods.map((l) => hueShiftSprites(l, hueShift)) }),
    ...(sprites.stand && {
      stand: Object.fromEntries(
        Object.entries(sprites.stand).map(([d, f]) => [d, shift(f)]),
      ) as Record<Direction, SpriteData>,
    }),
  };
}

/** Create a transparent placeholder sprite of given dimensions */
function emptySprite(w: number, h: number): SpriteData {
  const rows: string[][] = [];
  for (let y = 0; y < h; y++) {
    rows.push(new Array(w).fill(''));
  }
  return rows;
}

/** A sheet's sprites (pre-coloured, no palette swap): walk 1-2-3-2, typing, reading, the left
 *  view mirrored from the right; its copies (HD64) the same way. */
function spritesOf(char: LoadedCharacterData): CharacterSprites {
  const d = char.down;
  const u = char.up;
  const rt = char.right;
  // SHEET-IMPORT: detailed frames draw their one master (smoothSprite.ts); a mirror keeps it
  if ((char.density ?? 1) >= SMOOTH_DENSITY) for (const f of [...d, ...u, ...rt]) markSmooth(f);
  const flips = new Map<SpriteData, SpriteData>();
  const flip = (f: SpriteData) => {
    let m = flips.get(f);
    if (!m) {
      m = flipSpriteHorizontal(f);
      deriveSmooth(f, m, { mirror: true });
      flips.set(f, m);
    }
    return m;
  };
  const [a, b, c, e] = char.walk ?? [0, 1, 2, 1];
  const stand = char.stand;
  return {
    walk: {
      [Dir.DOWN]: [d[a], d[b], d[c], d[e]],
      [Dir.UP]: [u[a], u[b], u[c], u[e]],
      [Dir.RIGHT]: [rt[a], rt[b], rt[c], rt[e]],
      [Dir.LEFT]: [flip(rt[a]), flip(rt[b]), flip(rt[c]), flip(rt[e])],
    },
    ...(stand !== undefined && {
      stand: {
        [Dir.DOWN]: d[stand],
        [Dir.UP]: u[stand],
        [Dir.RIGHT]: rt[stand],
        [Dir.LEFT]: flip(rt[stand]),
      } as Record<Direction, SpriteData>,
    }),
    typing: {
      [Dir.DOWN]: [d[3], d[4]],
      [Dir.UP]: [u[3], u[4]],
      [Dir.RIGHT]: [rt[3], rt[4]],
      [Dir.LEFT]: [flip(rt[3]), flip(rt[4])],
    },
    reading: {
      [Dir.DOWN]: [d[5], d[6]],
      [Dir.UP]: [u[5], u[6]],
      [Dir.RIGHT]: [rt[5], rt[6]],
      [Dir.LEFT]: [flip(rt[5]), flip(rt[6])],
    },
    density: char.drawDensity ?? char.density ?? 1,
    ...(char.lods?.length ? { lods: char.lods.map(spritesOf) } : {}),
  };
}

/** SHEET-IMPORT: how many world px a character's figure stands taller than a classic one (its
 *  standing front frame's head over its feet; 0 for classic and HD 32×64 characters): its
 *  labels, bubbles, head icons and hit box rise by it. */
const lifts = new WeakMap<CharacterSprites, number>();
export function characterLift(paletteIndex: number, hueShift = 0): number {
  const s = getCharacterSprites(paletteIndex, hueShift);
  let lift = lifts.get(s);
  if (lift === undefined) {
    const f = s.stand?.[Dir.DOWN] ?? s.walk[Dir.DOWN][1];
    const top = f.findIndex((row) => row.some(Boolean));
    // classic and HD (32×64) frames are 32 world px tall: they never lift
    const tall = f.length / s.density > CLASSIC_FRAME_H;
    lift =
      top < 0 || !tall ? 0 : Math.max(0, (f.length - top) / s.density - CLASSIC_FIGURE_RISE - 1);
    lifts.set(s, lift);
  }
  return lift;
}

export function getCharacterSprites(paletteIndex: number, hueShift = 0): CharacterSprites {
  const cacheKey = `${paletteIndex}:${hueShift}`;
  const cached = spriteCache.get(cacheKey);
  if (cached) return cached;

  let sprites: CharacterSprites;
  const char =
    customCharacters.get(paletteIndex)?.sheet ??
    loadedCharacters?.[paletteIndex % loadedCharacters.length];

  if (char) sprites = spritesOf(char);
  else {
    // Fallback: return transparent placeholder sprites (16×32)
    const e = emptySprite(16, 32);
    const walkSet: [SpriteData, SpriteData, SpriteData, SpriteData] = [e, e, e, e];
    const pairSet: [SpriteData, SpriteData] = [e, e];
    sprites = {
      walk: {
        [Dir.DOWN]: walkSet,
        [Dir.UP]: walkSet,
        [Dir.RIGHT]: walkSet,
        [Dir.LEFT]: walkSet,
      },
      typing: {
        [Dir.DOWN]: pairSet,
        [Dir.UP]: pairSet,
        [Dir.RIGHT]: pairSet,
        [Dir.LEFT]: pairSet,
      },
      reading: {
        [Dir.DOWN]: pairSet,
        [Dir.UP]: pairSet,
        [Dir.RIGHT]: pairSet,
        [Dir.LEFT]: pairSet,
      },
      density: 1,
    };
  }

  // Apply hue shift if non-zero
  if (hueShift !== 0) {
    sprites = hueShiftSprites(sprites, hueShift);
  }

  spriteCache.set(cacheKey, sprites);
  return sprites;
}
