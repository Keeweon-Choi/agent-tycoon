/**
 * Builder for a seeded `~/.pixel-agents/layout.json`, written under the
 * isolated HOME before the standalone server starts, so the server reads it on startup.
 *
 * A seeded layout MUST carry a layoutRevision above the bundled default's (1),
 * or `loadLayout` resets it to the bundled default
 * (server/src/layoutPersistence.ts). SEED_LAYOUT_REVISION sits far above that.
 */

/** Far above the bundled default-layout revision so a seeded layout survives load. */
export const SEED_LAYOUT_REVISION = 9999;

/** Default floor TileType used to fill a seeded grid (FLOOR_1 = 1). */
const FLOOR_1 = 1;

export interface SeedAreaTile {
  col: number;
  row: number;
  label: string;
}

export interface SeedCarpetTile {
  col: number;
  row: number;
  variant: number;
}

export interface SeedLayoutOptions {
  cols?: number;
  rows?: number;
  /** TileType value to fill every tile with (default FLOOR_1). */
  floorTile?: number;
  areas?: Array<{ label: string; color: string }>;
  /** Sparse area-tile labels; expanded to a full parallel array. */
  areaTiles?: SeedAreaTile[];
  /** Sparse carpet tiles; expanded to a full parallel array (default colors). */
  carpetTiles?: SeedCarpetTile[];
}

/**
 * Build a minimal valid OfficeLayout (version 1, all-floor, no furniture) with
 * optional carpet/area data, suitable for `test.use({ seedLayout })`. No chairs
 * means no seats — use the bundled default layout (don't seed) for seat tests.
 */
export function buildSeedLayout(opts: SeedLayoutOptions = {}): Record<string, unknown> {
  const cols = opts.cols ?? 12;
  const rows = opts.rows ?? 12;
  const count = cols * rows;
  const tiles = new Array<number>(count).fill(opts.floorTile ?? FLOOR_1);

  const layout: Record<string, unknown> = {
    version: 1,
    cols,
    rows,
    tiles,
    furniture: [],
    layoutRevision: SEED_LAYOUT_REVISION,
  };

  if (opts.areas) {
    layout.areas = opts.areas;
  }
  if (opts.areaTiles) {
    const areaTiles = new Array<string | null>(count).fill(null);
    for (const t of opts.areaTiles) {
      areaTiles[t.row * cols + t.col] = t.label;
    }
    layout.areaTiles = areaTiles;
  }
  if (opts.carpetTiles) {
    const carpetTiles = new Array<{ variant: number } | null>(count).fill(null);
    for (const t of opts.carpetTiles) {
      carpetTiles[t.row * cols + t.col] = { variant: t.variant };
    }
    layout.carpetTiles = carpetTiles;
  }

  return layout;
}
