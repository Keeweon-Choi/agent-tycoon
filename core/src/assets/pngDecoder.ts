/**
 * Pure PNG decoding utilities — shared between the extension host, Vite build
 * scripts, and future standalone backend.
 *
 * No VS Code dependency. Only uses pngjs and shared constants.
 */

import { PNG } from 'pngjs';

import { rgbaToHex } from './colorUtils.js';
import {
  CARPET_GRID_COLS,
  CARPET_MARCHING_SQUARES_COUNT,
  CARPET_TILE_SIZE,
  CHAR_DIAG_FRAMES,
  CHAR_DIAG_ROWS,
  CHAR_FRAME_H,
  CHAR_FRAME_W,
  CHAR_FRAMES_PER_ROW,
  CHARACTER_DIRECTIONS,
  FLOOR_TILE_SIZE,
  WALL_BITMASK_COUNT,
  WALL_GRID_COLS,
  WALL_PIECE_HEIGHT,
  WALL_PIECE_WIDTH,
} from './constants.js';
import type { CharacterDirectionSprites } from './types.js';

// ── Sprite decoding ──────────────────────────────────────────

/**
 * Strip trailing bytes after the PNG IEND chunk.
 *
 * Aseprite-generated PNGs sometimes include trailing null bytes after IEND,
 * which causes `pngjs` to throw. The IEND chunk layout is:
 *   4 bytes length (0x00000000) + 4 bytes type ('IEND') + 4 bytes CRC = 12 bytes
 * Some encoders emit ≤4 bytes of trailing garbage, so we scan from `buf.length - 8`
 * (not `-12`) to find the IEND type marker.
 */
function sanitizePngBuffer(buf: Buffer): Buffer {
  // IEND type bytes: 0x49 0x45 0x4E 0x44 ('I' 'E' 'N' 'D')
  for (let i = buf.length - 8; i >= 8; i--) {
    if (buf[i] === 0x49 && buf[i + 1] === 0x45 && buf[i + 2] === 0x4e && buf[i + 3] === 0x44) {
      const endPos = i + 4 + 4; // past type bytes + 4-byte CRC
      if (buf.length > endPos) {
        return buf.subarray(0, endPos);
      }
      break;
    }
  }
  return buf;
}

/**
 * Convert a PNG buffer to SpriteData (2D array of hex color strings).
 * '' = transparent, '#RRGGBB' = opaque, '#RRGGBBAA' = semi-transparent.
 */
export function pngToSpriteData(pngBuffer: Buffer, width: number, height: number): string[][] {
  try {
    const png = PNG.sync.read(sanitizePngBuffer(pngBuffer));

    if (png.width !== width || png.height !== height) {
      console.warn(
        `PNG dimensions mismatch: expected ${width}×${height}, got ${png.width}×${png.height}`,
      );
    }

    const sprite: string[][] = [];
    const data = png.data;

    for (let y = 0; y < height; y++) {
      const row: string[] = [];
      for (let x = 0; x < width; x++) {
        const pixelIndex = (y * png.width + x) * 4;
        const r = data[pixelIndex];
        const g = data[pixelIndex + 1];
        const b = data[pixelIndex + 2];
        const a = data[pixelIndex + 3];
        row.push(rgbaToHex(r, g, b, a));
      }
      sprite.push(row);
    }

    return sprite;
  } catch (err) {
    console.warn(`Failed to parse PNG: ${err instanceof Error ? err.message : err}`);
    const sprite: string[][] = [];
    for (let y = 0; y < height; y++) {
      sprite.push(new Array(width).fill(''));
    }
    return sprite;
  }
}

/**
 * Parse a single wall PNG (64×128, 4×4 grid of 16×32 pieces) into 16 bitmask sprites.
 * Piece at bitmask M: col = M % 4, row = floor(M / 4).
 */
export function parseWallPng(pngBuffer: Buffer): string[][][] {
  const png = PNG.sync.read(sanitizePngBuffer(pngBuffer));
  const sprites: string[][][] = [];
  for (let mask = 0; mask < WALL_BITMASK_COUNT; mask++) {
    const ox = (mask % WALL_GRID_COLS) * WALL_PIECE_WIDTH;
    const oy = Math.floor(mask / WALL_GRID_COLS) * WALL_PIECE_HEIGHT;
    const sprite: string[][] = [];
    for (let r = 0; r < WALL_PIECE_HEIGHT; r++) {
      const row: string[] = [];
      for (let c = 0; c < WALL_PIECE_WIDTH; c++) {
        const idx = ((oy + r) * png.width + (ox + c)) * 4;
        const rv = png.data[idx];
        const gv = png.data[idx + 1];
        const bv = png.data[idx + 2];
        const av = png.data[idx + 3];
        row.push(rgbaToHex(rv, gv, bv, av));
      }
      sprite.push(row);
    }
    sprites.push(sprite);
  }
  return sprites;
}

/**
 * Parse a single carpet PNG (64×64, 4×4 grid of 16×16 pieces) into 16
 * marching-squares sprites. The piece at case N is located at
 * col = N % 4, row = floor(N / 4); piece 0 (empty junction) is included
 * but the renderer skips it.
 *
 * Returns sprites[msCase][row][col] of hex strings. Pixel encoding matches
 * the floor and wall convention: '' = transparent, '#RRGGBB' = opaque,
 * '#RRGGBBAA' = semi-transparent.
 */
export function parseCarpetPng(pngBuffer: Buffer): string[][][] {
  const png = PNG.sync.read(pngBuffer);
  const sprites: string[][][] = [];
  for (let msCase = 0; msCase < CARPET_MARCHING_SQUARES_COUNT; msCase++) {
    const ox = (msCase % CARPET_GRID_COLS) * CARPET_TILE_SIZE;
    const oy = Math.floor(msCase / CARPET_GRID_COLS) * CARPET_TILE_SIZE;
    const sprite: string[][] = [];
    for (let r = 0; r < CARPET_TILE_SIZE; r++) {
      const row: string[] = [];
      for (let c = 0; c < CARPET_TILE_SIZE; c++) {
        const idx = ((oy + r) * png.width + (ox + c)) * 4;
        const rv = png.data[idx];
        const gv = png.data[idx + 1];
        const bv = png.data[idx + 2];
        const av = png.data[idx + 3];
        row.push(rgbaToHex(rv, gv, bv, av));
      }
      sprite.push(row);
    }
    sprites.push(sprite);
  }
  return sprites;
}

/** Frame (`ox`, `oy`) of a decoded character sheet: CHAR_FRAME_W×CHAR_FRAME_H hex pixels. */
function characterFrame(png: PNG, ox: number, oy: number): string[][] {
  return Array.from({ length: CHAR_FRAME_H }, (_, y) =>
    Array.from({ length: CHAR_FRAME_W }, (_, x) => {
      const idx = ((oy + y) * png.width + (ox + x)) * 4;
      return rgbaToHex(png.data[idx], png.data[idx + 1], png.data[idx + 2], png.data[idx + 3]);
    }),
  );
}

/**
 * Decode a single character PNG (112×96) into direction-keyed frame arrays.
 * Each PNG has 3 direction rows (down, up, right) × 7 frames (16×32 each).
 */
export function decodeCharacterPng(pngBuffer: Buffer): CharacterDirectionSprites {
  const png = PNG.sync.read(sanitizePngBuffer(pngBuffer));
  const charData: CharacterDirectionSprites = { down: [], up: [], right: [] };
  CHARACTER_DIRECTIONS.forEach((dir, r) => {
    charData[dir] = Array.from({ length: CHAR_FRAMES_PER_ROW }, (_, f) =>
      characterFrame(png, f * CHAR_FRAME_W, r * CHAR_FRAME_H),
    );
  });
  return charData;
}

/** DIAG-1104: a character's three-quarter walk (`char_N_diag.png`, 48×64: rows facing lower right
 *  and upper right, columns walk1, stand, walk3). Throws on any other size. */
export function decodeCharacterDiagPng(
  pngBuffer: Buffer,
): Required<Pick<CharacterDirectionSprites, 'downRight' | 'upRight'>> {
  const png = PNG.sync.read(sanitizePngBuffer(pngBuffer));
  const [w, h] = [CHAR_FRAME_W * CHAR_DIAG_FRAMES, CHAR_FRAME_H * CHAR_DIAG_ROWS];
  if (png.width !== w || png.height !== h)
    throw new Error(`${png.width}×${png.height}, not ${w}×${h}`);
  const row = (r: number) =>
    Array.from({ length: CHAR_DIAG_FRAMES }, (_, f) =>
      characterFrame(png, f * CHAR_FRAME_W, r * CHAR_FRAME_H),
    );
  return { downRight: row(0), upRight: row(1) };
}

/**
 * Decode a single floor tile PNG (16×16 grayscale pattern).
 */
export function decodeFloorPng(pngBuffer: Buffer): string[][] {
  return pngToSpriteData(pngBuffer, FLOOR_TILE_SIZE, FLOOR_TILE_SIZE);
}
