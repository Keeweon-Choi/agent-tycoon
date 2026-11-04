/**
 * Server-side asset decoders — shared between Vite plugin, extension host,
 * and future standalone backends.
 *
 * Reads PNG files from an assets directory and decodes them into SpriteData
 * format using the shared pngDecoder module.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  decodeCharacterDiagPng,
  decodeCharacterPng,
  decodeFloorPng,
  parseCarpetPng,
  parseWallPng,
  pngToSpriteData,
} from './pngDecoder.js';
import type { CatalogEntry, CharacterDirectionSprites } from './types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function listSortedPngs(dir: string, pattern: RegExp): { index: number; filename: string }[] {
  if (!fs.existsSync(dir)) return [];
  const files: { index: number; filename: string }[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const match = pattern.exec(entry);
    if (match) {
      files.push({ index: parseInt(match[1], 10), filename: entry });
    }
  }
  return files.sort((a, b) => a.index - b.index);
}

// ── Decoders ─────────────────────────────────────────────────────────────────

/** DIAG-1104: `sprites` with the three-quarter walk of `char_<index>_diag.png` beside it, when it
 *  is there and draws; else as it is (its four views stand in). */
export function withCharacterDiag(
  sprites: CharacterDirectionSprites,
  charDir: string,
  index: number,
): CharacterDirectionSprites {
  const file = path.join(charDir, `char_${index}_diag.png`);
  if (!fs.existsSync(file)) return sprites;
  try {
    return { ...sprites, ...decodeCharacterDiagPng(fs.readFileSync(file)) };
  } catch (err) {
    console.warn(`[AssetLoader] ${file}: ${err instanceof Error ? err.message : err}, skipped`);
    return sprites;
  }
}

export function decodeAllCharacters(assetsDir: string): CharacterDirectionSprites[] {
  const charDir = path.join(assetsDir, 'characters');
  const files = listSortedPngs(charDir, /^char_(\d+)\.png$/i);
  return files.map(({ index, filename }) => {
    const pngBuffer = fs.readFileSync(path.join(charDir, filename));
    return withCharacterDiag(decodeCharacterPng(pngBuffer), charDir, index);
  });
}

export function decodeAllFloors(assetsDir: string): string[][][] {
  const floorsDir = path.join(assetsDir, 'floors');
  const files = listSortedPngs(floorsDir, /^floor_(\d+)\.png$/i);
  return files.map(({ filename }) => {
    const pngBuffer = fs.readFileSync(path.join(floorsDir, filename));
    return decodeFloorPng(pngBuffer);
  });
}

export function decodeAllWalls(assetsDir: string): string[][][][] {
  const wallsDir = path.join(assetsDir, 'walls');
  const files = listSortedPngs(wallsDir, /^wall_(\d+)\.png$/i);
  return files.map(({ filename }) => {
    const pngBuffer = fs.readFileSync(path.join(wallsDir, filename));
    return parseWallPng(pngBuffer);
  });
}

export function decodeAllCarpets(assetsDir: string): string[][][][] {
  const carpetsDir = path.join(assetsDir, 'carpets');
  const files = listSortedPngs(carpetsDir, /^carpet_(\d+)\.png$/i);
  return files.map(({ filename }) => {
    const pngBuffer = fs.readFileSync(path.join(carpetsDir, filename));
    return parseCarpetPng(pngBuffer);
  });
}

export function decodeAllFurniture(
  assetsDir: string,
  catalog: CatalogEntry[],
): Record<string, string[][]> {
  const sprites: Record<string, string[][]> = {};
  for (const entry of catalog) {
    try {
      const filePath = path.join(assetsDir, entry.furniturePath);
      if (!fs.existsSync(filePath)) continue;
      const pngBuffer = fs.readFileSync(filePath);
      sprites[entry.id] = pngToSpriteData(pngBuffer, entry.width, entry.height);
    } catch (err) {
      console.warn(`[decodeAssets] Failed to decode ${entry.id}:`, err);
    }
  }
  return sprites;
}
