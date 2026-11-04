import type { FurnitureVisual } from './manifestUtils.js';

/**
 * Asset pipeline types — shared between the extension host, Vite build
 * scripts, browser mock, and future standalone backends.
 */

export interface CharacterDirectionSprites {
  down: string[][][];
  up: string[][][];
  right: string[][][];
  /** DIAG-1104: the three-quarter walk (walk1, stand, walk3) facing lower right and upper right,
   *  when the sheet has a `char_N_diag.png`; left is the right mirrored. */
  downRight?: string[][][];
  upRight?: string[][][];
}

export interface AssetIndex {
  floors: string[];
  walls: string[];
  characters: string[];
  defaultLayout: string | null;
}

export interface CatalogEntry {
  id: string;
  name: string;
  label: string;
  category: string;
  file: string;
  furniturePath: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  canPlaceOnWalls: boolean;
  canPlaceOnSurfaces?: boolean;
  backgroundTiles?: number;
  groupId?: string;
  orientation?: string;
  state?: string;
  mirrorSide?: boolean;
  rotationScheme?: string;
  animationGroup?: string;
  frame?: number;
  /** GFX: optional 2.5D placement and depth (manifestUtils FurnitureVisual). */
  visual?: FurnitureVisual;
}
