/**
 * Shared constants — used by the extension host, Vite build scripts,
 * and future standalone backend.
 *
 * No VS Code dependency. Only asset parsing and layout-related values.
 */

// ── PNG / Asset Parsing ─────────────────────────────────────
export const PNG_ALPHA_THRESHOLD = 2;
/** Distinct colours rgbaToHex keeps one string for (colorUtils.ts). */
export const HEX_CACHE_MAX = 4096;
export const WALL_PIECE_WIDTH = 16;
export const WALL_PIECE_HEIGHT = 32;
export const WALL_GRID_COLS = 4;
export const WALL_BITMASK_COUNT = 16;
export const FLOOR_TILE_SIZE = 16;
export const CHARACTER_DIRECTIONS = ['down', 'up', 'right'] as const;
export const CHAR_FRAME_W = 16;
export const CHAR_FRAME_H = 32;
export const CHAR_FRAMES_PER_ROW = 7;
/** DIAG-1104: a character's three-quarter walk `char_N_diag.png`: 2 rows (facing lower right,
 *  upper right) × walk1, stand, walk3. */
export const CHAR_DIAG_FRAMES = 3;
export const CHAR_DIAG_ROWS = 2;
/** Built-in character sheets `char_0.png` .. `char_{CHAR_COUNT-1}.png`: the one count every layer reads. */
export const CHAR_COUNT = 23;

// ── Carpet auto-tile parsing ────────────────────────────────
export const CARPET_TILE_SIZE = 16;
export const CARPET_GRID_COLS = 4;
export const CARPET_MARCHING_SQUARES_COUNT = 16;
