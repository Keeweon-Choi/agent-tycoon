/**
 * Unit tests for the pure layout-editor rules in editorActions.ts that the e2e
 * specs can only reach through a real VS Code window.
 *
 * The catalog is a hand-built slice of the bundled assets with the same
 * footprints, background rows and rotation groups: DESK is 2-way (front 3x2 ↔
 * side 1x4), PC rotates front → side, COFFEE and WOODEN_CHAIR_FRONT don't.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { beforeAll, describe, test } from 'vitest';

import { expandForTile, rotateFurniture } from '../src/office/editor/editorActions.js';
import type { LoadedAssetData } from '../src/office/layout/furnitureCatalog.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { OfficeLayout, PlacedFurniture } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

type CatalogAsset = LoadedAssetData['catalog'][number];

function asset(
  id: string,
  footprintW: number,
  footprintH: number,
  extra: Partial<CatalogAsset> = {},
): CatalogAsset {
  return {
    id,
    label: id,
    category: 'misc',
    width: footprintW * 16,
    height: footprintH * 16,
    footprintW,
    footprintH,
    isDesk: false,
    ...extra,
  };
}

beforeAll(() => {
  const catalog = [
    asset('DESK_FRONT', 3, 2, {
      isDesk: true,
      groupId: 'DESK',
      orientation: 'front',
      rotationScheme: '2-way',
      backgroundTiles: 1,
    }),
    asset('DESK_SIDE', 1, 4, {
      isDesk: true,
      groupId: 'DESK',
      orientation: 'side',
      rotationScheme: '2-way',
      backgroundTiles: 1,
    }),
    asset('PC_FRONT_OFF', 1, 2, {
      groupId: 'PC',
      orientation: 'front',
      canPlaceOnSurfaces: true,
      backgroundTiles: 1,
    }),
    asset('PC_SIDE', 1, 2, {
      groupId: 'PC',
      orientation: 'side',
      canPlaceOnSurfaces: true,
      backgroundTiles: 1,
    }),
    asset('COFFEE', 1, 1, { canPlaceOnSurfaces: true }),
    asset('WOODEN_CHAIR_FRONT', 1, 2, { backgroundTiles: 1 }),
  ];
  const sprites = Object.fromEntries(catalog.map((a) => [a.id, [['']]]));
  assert.ok(buildDynamicCatalog({ catalog, sprites }));
});

function floorLayout(cols: number, rows: number, furniture: PlacedFurniture[]): OfficeLayout {
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array(cols * rows).fill(TileType.FLOOR_1),
    furniture,
  };
}

describe('rotateFurniture validates the whole desk group', () => {
  test('a desk with a PC on it rotates both when the group fits', () => {
    const layout = floorLayout(12, 12, [
      { uid: 'desk', type: 'DESK_FRONT', col: 3, row: 3 },
      { uid: 'pc', type: 'PC_FRONT_OFF', col: 4, row: 3 },
    ]);
    const rotated = rotateFurniture(layout, 'desk', 'cw');
    assert.notEqual(rotated, layout);
    assert.deepEqual(
      rotated.furniture.map((f) => `${f.uid}:${f.type}@${f.col},${f.row}`),
      ['desk:DESK_SIDE@3,3', 'pc:PC_SIDE@3,4'],
    );
  });

  test('refused when a rider would land on another item, though the desk fits', () => {
    // The side desk's top row is a background row, so it may share (3,3) with
    // the chair's solid row; the coffee swung onto (3,3) may not.
    const layout = floorLayout(12, 12, [
      { uid: 'desk', type: 'DESK_FRONT', col: 3, row: 3 },
      { uid: 'coffee', type: 'COFFEE', col: 5, row: 3 },
      { uid: 'chair', type: 'WOODEN_CHAIR_FRONT', col: 3, row: 2 },
    ]);
    assert.equal(rotateFurniture(layout, 'desk', 'cw'), layout);
  });

  test('the same desk without the coffee rotates — only the rider was in the way', () => {
    const layout = floorLayout(12, 12, [
      { uid: 'desk', type: 'DESK_FRONT', col: 3, row: 3 },
      { uid: 'chair', type: 'WOODEN_CHAIR_FRONT', col: 3, row: 2 },
    ]);
    const rotated = rotateFurniture(layout, 'desk', 'cw');
    assert.equal(rotated.furniture.find((f) => f.uid === 'desk')?.type, 'DESK_SIDE');
  });

  test('refused when the rotated group would leave the grid', () => {
    // A 1x4 side desk at row 10 of a 12-row grid covers rows 10-13.
    const layout = floorLayout(12, 12, [
      { uid: 'desk', type: 'DESK_FRONT', col: 3, row: 10 },
      { uid: 'pc', type: 'PC_FRONT_OFF', col: 4, row: 10 },
    ]);
    assert.equal(rotateFurniture(layout, 'desk', 'cw'), layout);
  });
});

describe('expandForTile grows the grid from a ghost-border click', () => {
  test('a click left of and above the grid grows it and shifts what was there', () => {
    const layout = floorLayout(4, 3, []);
    const grown = expandForTile(layout, -1, -1);
    assert.ok(grown);
    assert.deepEqual([grown.layout.cols, grown.layout.rows], [5, 4]);
    assert.deepEqual([grown.col, grown.row, grown.shift.col, grown.shift.row], [0, 0, 1, 1]);
  });

  test('a click inside the grid needs no growth', () => {
    assert.equal(expandForTile(floorLayout(4, 3, []), 2, 1), null);
  });

  test('a generated agty office never grows: its decor has no place for tiles outside the rooms', () => {
    const layout: OfficeLayout = { ...floorLayout(4, 3, []), agtyBase: 'stamp-1' };
    assert.equal(expandForTile(layout, -1, 0), null);
    assert.equal(expandForTile(layout, 4, 0), null);
    assert.equal(expandForTile(layout, 0, 3), null);
  });
});
