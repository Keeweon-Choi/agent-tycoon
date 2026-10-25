/// <reference types="vite/client" />
/**
 * ISO-PILOT / ISO-2: the isometric pieces (./art) and their manifests. Two sets:
 *  - the owner's individual objects (gen-iso-objects.ts, `o-*.png`, owner-manifest.json): one
 *    master PNG each at density 12 (picture px per world px; a 16 px tile is a 192×96
 *    diamond), drawn at every zoom from that master (smooth when it is shrunk);
 *  - what the pilot still draws from its starter pack or its script (gen-iso-art.ts,
 *    manifest.json): density 4 with copies at 2 and 1 (`name@2.png`, `name@1.png`), nearest.
 * The manifests are merged: a piece says its footprint (and the slot the game blocks), the
 * pixel on the footprint's front corner (its anchor), which way it faces, its seat points, and
 * which piece each furniture type wears, so the owner's art replaces a piece without code.
 * Loaded the first time the view is on; until then nothing isometric is drawn. Only the
 * owner's pieces the manifest uses are decoded.
 */
import { ISO_MASTER_DENSITY } from '../../constants.js';
import pilot from './art/manifest.json';
import owner from './art/owner-manifest.json';

export type Facing = '+row' | '+col' | '-row' | '-col' | 'none';

export interface PieceDef {
  file: string;
  /** Source px per world px of `file`. */
  density: number;
  footprint: [number, number];
  /** What the game blocks, when the object stands in only part of it. */
  slot?: [number, number];
  /** The pixel (of `file`) at the footprint's (slot's) front corner on the floor. */
  anchor: [number, number];
  faces: Facing;
  /** What stands on it is lifted this many px of `file`. */
  surface?: number;
  /** Seat points (iso px from the anchor) for the picture as drawn, one per seat. */
  seats?: Array<[number, number]>;
  /** A wall piece, stored running down to the right: its run in tiles and where its base
   *  starts (px of `file`); strips of one tile are cut from there. */
  wall?: { along: 'row' | 'col'; n: number; start: [number, number]; role: string };
  /** Stands on the floor even on a wall tile (a mobile whiteboard hangs on nothing). */
  stands?: boolean;
}

/** A wall piece in use: `mirror` draws it flipped (a wall running the other way). */
export interface WallUse {
  piece: string;
  mirror?: boolean;
}

export interface IsoManifest {
  floors: Record<string, string>;
  walls: {
    row: WallUse;
    col: WallUse;
    /** Windows in a back wall: this wall piece's strips in turn, then `gap` plain tiles. */
    window: { piece: string; gap: number };
    corner: string;
    low: string;
  };
  lift: { doors: string; doorsOpen: string };
  pieces: Record<string, PieceDef>;
  /** `none`: the type is not drawn (its look is part of another piece). */
  types: Record<string, { piece: string; mirror?: boolean }>;
  /** Seating by the way the sitter faces: the piece (mirrored or not) that shows it. */
  facings: Record<string, Partial<Record<Facing, { piece: string; mirror?: boolean }>>>;
}

type Part = Partial<IsoManifest>;
const [a, b] = [pilot as unknown as Part, owner as unknown as Part];
export const ISO_MANIFEST: IsoManifest = {
  floors: { ...a.floors, ...b.floors },
  walls: (b.walls ?? a.walls)!,
  lift: { ...a.lift, ...b.lift } as IsoManifest['lift'],
  pieces: { ...a.pieces, ...b.pieces },
  types: { ...a.types, ...b.types },
  facings: { ...a.facings, ...b.facings },
};

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
  if (piece.density === ISO_MASTER_DENSITY) {
    // One master for every zoom: drawn scaled by device px per picture px (art.ts callers).
    const img = images.get(piece.file);
    return img ? { img, d: piece.density, ax: piece.anchor[0], ay: piece.anchor[1] } : null;
  }
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

/** The files to decode: every pilot piece, and the owner's pieces something uses. */
export function neededFiles(m: IsoManifest = ISO_MANIFEST): Set<string> {
  const names = new Set<string>([
    ...Object.values(m.floors),
    m.walls.row.piece,
    m.walls.col.piece,
    m.walls.window.piece,
    m.walls.corner,
    m.walls.low,
    m.lift.doors,
    m.lift.doorsOpen,
    ...Object.values(m.types).map((t) => t.piece),
    ...Object.values(m.facings).flatMap((g) => Object.values(g).map((f) => f!.piece)),
  ]);
  const files = new Set<string>();
  for (const [name, p] of Object.entries(m.pieces)) {
    if (p.density !== ISO_MASTER_DENSITY) {
      for (const f of [
        p.file,
        p.file.replace(/\.png$/, '@2.png'),
        p.file.replace(/\.png$/, '@1.png'),
      ])
        files.add(f);
    } else if (names.has(name)) files.add(p.file);
  }
  return files;
}

async function load(): Promise<void> {
  const out = new Map<string, IsoImage>();
  const needed = neededFiles();
  await Promise.all(
    Object.entries(URLS)
      .filter(([file]) => needed.has(file))
      .map(async ([file, url]) => {
        try {
          const img = new Image();
          img.src = url;
          await img.decode();
          // Only the alpha is kept for hit tests (a master is big: one byte a pixel, not four),
          // read once through a scratch canvas that is dropped; the decoded image is what is drawn.
          const scratch = document.createElement('canvas');
          scratch.width = img.width;
          scratch.height = img.height;
          const sctx = scratch.getContext('2d', { willReadFrequently: true })!;
          sctx.drawImage(img, 0, 0);
          const rgba = sctx.getImageData(0, 0, img.width, img.height).data;
          const alpha = new Uint8Array(img.width * img.height);
          for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
          let flipped: HTMLCanvasElement | null = null;
          out.set(file, {
            w: img.width,
            h: img.height,
            plain: img,
            // The mirrored picture is made the first time something is drawn flipped.
            get flipped() {
              if (!flipped) {
                flipped = document.createElement('canvas');
                flipped.width = img.width;
                flipped.height = img.height;
                const fctx = flipped.getContext('2d')!;
                fctx.translate(img.width, 0);
                fctx.scale(-1, 1);
                fctx.drawImage(img, 0, 0);
              }
              return flipped;
            },
            opaque: (x, y) =>
              x >= 0 && y >= 0 && x < img.width && y < img.height && alpha[y * img.width + x] > 0,
          });
        } catch (err) {
          console.warn('[Webview] iso piece failed to load', file, err);
        }
      }),
  );
  images = out;
  for (const fn of ready) fn();
}
