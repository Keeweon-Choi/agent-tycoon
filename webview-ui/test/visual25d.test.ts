/**
 * GFX 2.5D foundation: furniture visual metadata. Old entries are placed and sorted exactly as
 * before; an entry with `visual` stands its picture on the footprint's bottom centre, sorts by
 * that foot line (or after everything, 'foreground'), and the footprint alone still decides
 * blocking. The character depth formula is the renderer's (renderScene).
 */
import { describe, expect, it } from 'vitest';

import { sanitizeVisual } from '../../core/src/assets/manifestUtils.js';
import { CHARACTER_Z_SORT_OFFSET, FOREGROUND_Z, WALL_COLOR } from '../src/constants.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import {
  getBlockedTiles,
  layoutToFurnitureInstances,
  visualPlacement,
} from '../src/office/layout/layoutSerializer.js';
import { TILE_SIZE } from '../src/office/types.js';

const sprite = (w: number, h: number) =>
  Array.from({ length: h }, () => new Array<string>(w).fill(WALL_COLOR));
const asset = (id: string, w: number, h: number, extra: object = {}) => ({
  id,
  label: id,
  category: 'decor',
  width: w,
  height: h,
  footprintW: 1,
  footprintH: 1,
  isDesk: false,
  ...extra,
});
buildDynamicCatalog({
  catalog: [
    asset('PLANT_OLD', 16, 32, { footprintH: 2, backgroundTiles: 1 }),
    asset('TALL', 11, 23, { visual: { shadowPreset: 'ground' } }),
    asset('PENDANT', 10, 16, {
      backgroundTiles: 1,
      visual: { elevation: 32, occlusionMode: 'foreground', lightingPreset: 'warm-pool' },
    }),
  ],
  sprites: { PLANT_OLD: sprite(16, 32), TALL: sprite(11, 23), PENDANT: sprite(10, 16) },
});
/** The renderer's depth key of a character standing on tile (col,row). */
const charZ = (row: number) =>
  row * TILE_SIZE + TILE_SIZE / 2 + TILE_SIZE / 2 + CHARACTER_Z_SORT_OFFSET;

describe('2.5D visual metadata', () => {
  it('leaves an entry without it exactly as before', () => {
    const [old] = layoutToFurnitureInstances([{ uid: 'a', type: 'PLANT_OLD', col: 3, row: 4 }]);
    expect(old).toMatchObject({ x: 3 * TILE_SIZE, y: 4 * TILE_SIZE, zY: 4 * TILE_SIZE + 32 });
    expect(old.ground).toBeUndefined();
  });

  it('stands a taller picture on a one-tile footprint, with a shadow at its feet', () => {
    const [tall] = layoutToFurnitureInstances([{ uid: 'b', type: 'TALL', col: 3, row: 4 }]);
    const footY = 5 * TILE_SIZE;
    expect(tall.y + 23).toBe(footY); // the picture's bottom on the footprint's bottom
    expect(tall.y).toBeLessThan(4 * TILE_SIZE); // overhangs the tile above
    expect(tall.zY).toBe(footY);
    expect(tall.ground).toMatchObject({ kind: 'shadow', preset: 'ground', y: footY });
    // Someone on the tile above is behind it, someone on the tile below in front.
    expect(charZ(3)).toBeLessThan(tall.zY);
    expect(charZ(5)).toBeGreaterThan(tall.zY);
    // Only the footprint blocks: the tile above stays walkable.
    const blocked = getBlockedTiles([{ uid: 'b', type: 'TALL', col: 3, row: 4 }]);
    expect([...blocked]).toEqual(['3,4']);
  });

  it('hangs a foreground lamp over whoever stands under it, light pool on the floor', () => {
    const [lamp] = layoutToFurnitureInstances([{ uid: 'c', type: 'PENDANT', col: 3, row: 4 }]);
    expect(lamp.y + 16).toBe(5 * TILE_SIZE - 32);
    expect(lamp.zY).toBeGreaterThanOrEqual(FOREGROUND_Z);
    expect(lamp.zY).toBeGreaterThan(charZ(4));
    expect(lamp.ground).toMatchObject({ kind: 'light', preset: 'warm-pool' });
    expect(getBlockedTiles([{ uid: 'c', type: 'PENDANT', col: 3, row: 4 }]).size).toBe(0);
    expect(
      visualPlacement(
        {
          type: 'X',
          label: 'X',
          footprintW: 1,
          footprintH: 1,
          sprite: sprite(1, 1),
          isDesk: false,
        },
        0,
        0,
      ),
    ).toBeNull();
  });

  it('keeps only valid metadata from a manifest', () => {
    expect(sanitizeVisual(undefined)).toBeUndefined();
    expect(
      sanitizeVisual({ elevation: 'high', occlusionMode: 'top', shadowPreset: '<x>' }),
    ).toBeUndefined();
    expect(
      sanitizeVisual({
        footAnchor: { x: 5, y: 1e9 },
        elevation: 12,
        depthOffset: -4,
        lightingPreset: 'warm-pool',
      }),
    ).toEqual({ elevation: 12, depthOffset: -4, lightingPreset: 'warm-pool' });
    expect(sanitizeVisual({ footAnchor: { x: 5, y: 22 }, occlusionMode: 'foreground' })).toEqual({
      footAnchor: { x: 5, y: 22 },
      occlusionMode: 'foreground',
    });
  });
});
