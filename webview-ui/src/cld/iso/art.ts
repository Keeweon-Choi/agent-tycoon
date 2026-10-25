/// <reference types="vite/client" />
/**
 * ISO-PILOT: the isometric pieces (./art, made by cld/scripts/gen-iso-art.ts from the owner's
 * starter pack) and their manifest. Each piece is a PNG at density 4 (source px per world px,
 * the density of the 64×128 HD characters) with copies at densities 2 and 1
 * (`name@2.png`, `name@1.png`); the manifest says its footprint, the pixel on the footprint's
 * front corner, which way it faces, and which piece each furniture type wears, so the owner's
 * art replaces a piece without code. Loaded the first time the view is on (inlined by Vite);
 * until then nothing isometric is drawn.
 */
import manifest from './art/manifest.json';

export type Facing = '+row' | '+col' | '-row' | '-col' | 'none';

export interface PieceDef {
  file: string;
  /** Source px per world px of `file`. */
  density: number;
  footprint: [number, number];
  /** The pixel (of `file`) at the footprint's front corner on the floor. */
  anchor: [number, number];
  faces: Facing;
  /** What stands on it is lifted this many px of `file`. */
  surface?: number;
}

export interface IsoManifest {
  floors: Record<string, string>;
  walls: {
    row: string;
    col: string;
    rowWindows: string[];
    colWindows: string[];
    corner: string;
    low: string;
  };
  lift: { doors: string; doorsOpen: string; shaft: string; car: string };
  pieces: Record<string, PieceDef>;
  /** `none`: the type is not drawn (its look is part of another piece). */
  types: Record<string, { piece: string; mirror?: boolean }>;
}

export const ISO_MANIFEST = manifest as unknown as IsoManifest;

/** A loaded picture: drawable as is or flipped, with its opaque pixels for hit tests. */
export interface IsoImage {
  w: number;
  h: number;
  plain: CanvasImageSource;
  flipped: CanvasImageSource;
  /** Whether pixel (x, y) of the picture (unflipped) is opaque. */
  opaque(x: number, y: number): boolean;
}

/** A piece at one density: its picture and its anchor in that picture's px. */
export interface IsoArt {
  img: IsoImage;
  /** Picture px per world px. */
  d: number;
  ax: number;
  ay: number;
}

/** The densities a piece comes in, finest first. */
const DENSITIES = [4, 2, 1];

/** The density to draw at device px per world px `s`: the finest that divides it into whole
 *  device px (as the HD characters do), else the coarsest. */
export function artDensity(s: number): number {
  return DENSITIES.find((d) => Number.isInteger(s / d)) ?? DENSITIES[DENSITIES.length - 1];
}

/** Piece `name` at density `d` (null: unknown, or not loaded). */
export function isoArt(images: Map<string, IsoImage>, name: string, d: number): IsoArt | null {
  const piece = ISO_MANIFEST.pieces[name];
  if (!piece) return null;
  const k = piece.density / d;
  const file = k === 1 ? piece.file : piece.file.replace(/\.png$/, `@${d}.png`);
  const img = images.get(file);
  if (!img) return null;
  // The copies' blocks are aligned on the anchor (gen-iso-art.ts lod()).
  return { img, d, ax: Math.ceil(piece.anchor[0] / k), ay: Math.ceil(piece.anchor[1] / k) };
}

const URLS = Object.fromEntries(
  Object.entries(import.meta.glob<string>('./art/*.png', { eager: true, import: 'default' })).map(
    ([path, url]) => [path.slice('./art/'.length), url],
  ),
);

let images: Map<string, IsoImage> | null = null;
let loading: Promise<void> | null = null;
const ready = new Set<() => void>();

/** Piece pictures by file name, or null while loading (then `onIsoArt` fires once). */
export function isoImages(): Map<string, IsoImage> | null {
  if (!images && !loading) loading = load();
  return images;
}
export function onIsoArt(fn: () => void): () => void {
  ready.add(fn);
  return () => ready.delete(fn);
}

async function load(): Promise<void> {
  const out = new Map<string, IsoImage>();
  await Promise.all(
    Object.entries(URLS).map(async ([file, url]) => {
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const plain = document.createElement('canvas');
        plain.width = img.width;
        plain.height = img.height;
        const pctx = plain.getContext('2d')!;
        pctx.drawImage(img, 0, 0);
        const alpha = pctx.getImageData(0, 0, img.width, img.height).data;
        const flipped = document.createElement('canvas');
        flipped.width = img.width;
        flipped.height = img.height;
        const fctx = flipped.getContext('2d')!;
        fctx.translate(img.width, 0);
        fctx.scale(-1, 1);
        fctx.drawImage(img, 0, 0);
        out.set(file, {
          w: img.width,
          h: img.height,
          plain,
          flipped,
          opaque: (x, y) =>
            x >= 0 &&
            y >= 0 &&
            x < img.width &&
            y < img.height &&
            alpha[(y * img.width + x) * 4 + 3] > 0,
        });
      } catch (err) {
        console.warn('[Webview] iso piece failed to load', file, err);
      }
    }),
  );
  images = out;
  for (const fn of ready) fn();
}
