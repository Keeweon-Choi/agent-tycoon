/// <reference types="vite/client" />
/**
 * 2.5D PILOT: which converted picture each furniture type wears when the switch is on, and how
 * it stands (the manifest `visual` fields: foot anchor, elevation, depth offset). The art is the
 * owner's, converted to true pixels (REF-ASSETS) and copied into ./art; every piece is drawn
 * 1:1 (one art px = one world px, 16 px tiles): sizes are fixed by choosing the piece and its
 * anchor here, never by resampling. A type not in the table keeps today's sprite.
 *
 * The art loads the first time the switch is on (a few KB, inlined by Vite); until it has,
 * everything draws as before.
 */
import { rgbaToHex } from '../../../../core/src/assets/colorUtils.js';
import type { FurnitureVisual } from '../../../../core/src/assets/manifestUtils.js';
import type { SpriteData, TileType as TileTypeVal } from '../../office/types.js';
import { office25dOn, onOffice25d } from './office25d.js';
import { type WallArt, type Walls25d, walls25d } from './walls25d.js';

/** name -> URL of every piece in ./art (Vite inlines these few-hundred-byte files). */
const URLS = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>('./art/*.png', { eager: true, import: 'default' }),
  ).map(([path, url]) => [path.slice('./art/'.length, -'.png'.length), url]),
);

/** One type's picture. `art: null` hides it (a PC on a 2.5D desk: the desk has its monitor). */
export interface SkinDef {
  art: string | null;
  /** A part of the art, art px: x, y, w, h. */
  crop?: readonly [number, number, number, number];
  visual?: FurnitureVisual;
  /** Only when it stands on a desk that has a 2.5D picture (else it keeps today's sprite). */
  onDesk?: true;
  /** A warm light pool (art name) on the floor under its foot point. */
  light?: string;
  /** Another piece drawn onto the picture at art px (x, y): a lamp on a desk. */
  overlay?: { art: string; x: number; y: number };
}

/** The desk's monitor screen, art px of reception-desk-monitor (43x22, drawn centred on a
 *  3-tile desk): a PC on it lights this 8x5 rect with a crop of the owner's dashboard screen. */
const SCREEN = { x: 25, y: 7, w: 8, h: 5 } as const;
const DESK_ART = { w: 43, h: 22 } as const;
/** The desk picture's left edge from its foot point (visualPlacement rounds the same way: a foot
 *  x is a whole number, and Math.round takes .5 up). */
const deskLeft = Math.round(-DESK_ART.w / 2);
const screenOn = (x: number, y: number): SkinDef => ({
  art: 'tv-dashboard',
  crop: [x, y, SCREEN.w, SCREEN.h],
  // The PC's foot is the desk's (both end on the desk's bottom row, centred on its middle tile).
  visual: { footAnchor: { x: -(deskLeft + SCREEN.x), y: DESK_ART.h - SCREEN.y } },
  onDesk: true,
});

export const SKINS_25D: Readonly<Record<string, SkinDef>> = {
  // Work desk (3x2): plant, papers, monitor; the seat below it is a round stool.
  DESK_FRONT: {
    art: 'reception-desk-monitor',
    overlay: { art: 'desk-lamp-gold', x: 34, y: 2 },
    light: 'light-pool-a',
  },
  PC_FRONT_OFF: { art: null, onDesk: true },
  PC_FRONT_ON_1: screenOn(2, 2),
  PC_FRONT_ON_2: screenOn(2, 4),
  PC_FRONT_ON_3: screenOn(10, 3),
  CUSHIONED_BENCH: { art: 'stool-round-wood' },
  // Lounge and lobby.
  SOFA_FRONT: { art: 'sofa-pink-2' },
  COFFEE_TABLE: { art: 'table-coffee-mug-plant', visual: { footAnchor: { x: 14, y: 23 } } },
  LOBBY_BENCH: { art: 'bench-wood', visual: { footAnchor: { x: 14, y: 12 } } },
  WHITEBOARD: { art: 'whiteboard-notes', visual: { elevation: 1 } },
  // Plants: about 0.7x the old ones, the leaves rising into the walkable row behind.
  PLANT: { art: 'plant-monstera', visual: { shadowPreset: 'ground' } },
  PLANT_2: { art: 'plant-rubber', visual: { shadowPreset: 'ground' } },
  LARGE_PLANT: { art: 'tree-big-pots', visual: { shadowPreset: 'ground' } },
  CACTUS: { art: 'plant-cactus', visual: { shadowPreset: 'ground' } },
  POT: { art: 'plant-small' },
  // Shelves: taller than they are deep, so whoever walks behind is hidden to the knees.
  BOOKSHELF: { art: 'bookshelf-combo' },
  DOUBLE_BOOKSHELF: { art: 'bookshelf-combo' },
  BIN: { art: 'bin-black' },
};

/** What layoutToFurnitureInstances draws for a type: its picture (null: nothing), placement
 *  metadata, whether it needs a 2.5D desk under it, and a light pool. */
export interface Skin {
  sprite: SpriteData | null;
  visual: FurnitureVisual;
  onDesk: boolean;
  light: SpriteData | null;
}

let art: Map<string, SpriteData> | null = null;
let wallArt: WallArt | null = null;
let loading = false;
const skins = new Map<string, Skin | null>();

/** The decoded art piece (null until loaded, or when missing). */
export function art25d(name: string): SpriteData | null {
  return art?.get(name) ?? null;
}

/** The 2.5D picture of `type`, or undefined when the switch is off, the art is still loading,
 *  or the type has none (then it draws as before). */
export function skin25d(type: string): Skin | undefined {
  if (!art || !office25dOn()) return undefined;
  let s = skins.get(type);
  if (s === undefined) {
    s = resolve(SKINS_25D[type]);
    skins.set(type, s);
  }
  return s ?? undefined;
}

/** The 2.5D walls of `tileMap`, or null when they draw as before (off, or the art not in). */
export function office25dWalls(tileMap: TileTypeVal[][]): Walls25d | null {
  return wallArt && office25dOn() ? walls25d(tileMap, wallArt) : null;
}

function resolve(def: SkinDef | undefined): Skin | null {
  if (!def) return null;
  let sprite: SpriteData | null = null;
  if (def.art) {
    const whole = art25d(def.art);
    if (!whole) return null; // a missing piece: today's sprite
    sprite = def.crop ? cropSprite(whole, ...def.crop) : whole;
    const over = def.overlay && art25d(def.overlay.art);
    if (def.overlay && over) sprite = overlaySprite(sprite, over, def.overlay.x, def.overlay.y);
  }
  return {
    sprite,
    visual: def.visual ?? {},
    onDesk: !!def.onDesk,
    light: def.light ? art25d(def.light) : null,
  };
}

/** `top` drawn over a copy of `base` at (x, y), clipped to `base`: an opaque px of `top`
 *  ('#RRGGBB') wins, a see-through one only shows where `base` is empty. */
export function overlaySprite(base: SpriteData, top: SpriteData, x: number, y: number): SpriteData {
  return base.map((row, r) =>
    row.map((under, k) => {
      const over = top[r - y]?.[k - x] ?? '';
      if (!over) return under;
      return over.length === '#RRGGBB'.length || !under ? over : under;
    }),
  );
}

export function cropSprite(s: SpriteData, x: number, y: number, w: number, h: number): SpriteData {
  return s.slice(y, y + h).map((row) => row.slice(x, x + w));
}

/** An <img> rather than fetch: the page's CSP lets images (data: too) in, not connections. */
async function decode(url: string): Promise<SpriteData> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => {
      const i = (y * width + x) * 4;
      return rgbaToHex(data[i], data[i + 1], data[i + 2], data[i + 3]);
    }),
  );
}

/** The decoded pieces by name (the loader's result): skins and walls draw from here on. */
export function setArt25d(pieces: Map<string, SpriteData>): void {
  art = pieces;
  skins.clear();
  const skyline = art.get('skyline-panel-night-a');
  const lamp = art.get('wall-wood-lit-narrow');
  const pool = art.get('light-pool-a');
  wallArt = skyline && lamp && pool ? { skyline, lamp, pool } : null;
}

/** Load the art once, the first time the switch is on. A failure leaves today's office. */
function load(): void {
  if (art || loading || !office25dOn() || typeof document === 'undefined') return;
  loading = true;
  Promise.all(Object.entries(URLS).map(async ([name, url]) => [name, await decode(url)] as const))
    .then((pieces) => setArt25d(new Map(pieces)))
    .catch((err: unknown) => console.warn('[Webview] 2.5D art failed to load', err))
    .finally(() => {
      loading = false;
    });
}
load();
onOffice25d(load);
