import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the asset loaders so we can assert WHICH loader runs for root vs external
// dirs (the load-vs-loadExternal asymmetry) without needing real PNG fixtures.
vi.mock('../src/assetLoader.js', () => ({
  loadFurnitureAssets: vi.fn((dir: string) =>
    Promise.resolve({ catalog: [{ id: `furn:${dir}` }], sprites: new Map([[`s:${dir}`, []]]) }),
  ),
  loadCharacterSprites: vi.fn((dir: string) =>
    Promise.resolve({ characters: [`char-root:${dir}`] }),
  ),
  loadExternalCharacterSprites: vi.fn((dir: string) =>
    Promise.resolve({ characters: [`char-ext:${dir}`] }),
  ),
  loadFloorTiles: vi.fn((dir: string) => Promise.resolve({ sprites: [[`floor:${dir}`]] })),
  loadWallTiles: vi.fn((dir: string) => Promise.resolve({ sets: [[`wall:${dir}`]] })),
  loadCarpetTiles: vi.fn((dir: string) => Promise.resolve({ sets: [[`carpet:${dir}`]] })),
  loadDefaultLayout: vi.fn((dir: string) => ({ version: 1, marker: dir })),
  mergeLoadedAssets: vi.fn((a, b) => ({
    catalog: [...a.catalog, ...b.catalog],
    sprites: new Map([...a.sprites, ...b.sprites]),
  })),
  mergeCharacterSprites: vi.fn((a, b) => ({ characters: [...a.characters, ...b.characters] })),
}));

import * as assetLoader from '../src/assetLoader.js';
import { buildAssetCache, loadAllCharacters, loadAllFurniture } from '../src/assetReload.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('assetReload helpers', () => {
  it('loadAllCharacters uses the bundled loader for root and the external loader for extras (asymmetry)', async () => {
    const result = await loadAllCharacters('root', ['e1', 'e2']);

    expect(result?.characters).toEqual(['char-root:root', 'char-ext:e1', 'char-ext:e2']);
    // Root → loadCharacterSprites only; externals → loadExternalCharacterSprites only.
    expect(vi.mocked(assetLoader.loadCharacterSprites).mock.calls.map((c) => c[0])).toEqual([
      'root',
    ]);
    expect(vi.mocked(assetLoader.loadExternalCharacterSprites).mock.calls.map((c) => c[0])).toEqual(
      ['e1', 'e2'],
    );
  });

  it('loadAllFurniture uses the same loader for root and externals, merged', async () => {
    const result = await loadAllFurniture('root', ['e1', 'e2']);

    expect(result?.catalog).toEqual([{ id: 'furn:root' }, { id: 'furn:e1' }, { id: 'furn:e2' }]);
    // Furniture: loadFurnitureAssets for BOTH root and externals (no separate external loader).
    expect(vi.mocked(assetLoader.loadFurnitureAssets).mock.calls.map((c) => c[0])).toEqual([
      'root',
      'e1',
      'e2',
    ]);
  });

  it('loadAll* with no external dirs returns the bundled result without merging', async () => {
    const result = await loadAllCharacters('root', []);
    expect(result?.characters).toEqual(['char-root:root']);
    expect(vi.mocked(assetLoader.mergeCharacterSprites)).not.toHaveBeenCalled();
    expect(vi.mocked(assetLoader.loadExternalCharacterSprites)).not.toHaveBeenCalled();
  });

  it('buildAssetCache reproduces the wrap/unwrap asymmetry', async () => {
    const cache = await buildAssetCache('dist', []);

    // Wrapped: characters/furniture keep their wrapper objects.
    expect(cache.characters).toEqual({ characters: ['char-root:dist'] });
    expect(cache.furniture?.catalog).toEqual([{ id: 'furn:dist' }]);
    // Unwrapped: floor/wall/carpet store the inner array, not the wrapper.
    expect(cache.floorTiles).toEqual([['floor:dist']]);
    expect(cache.wallTiles).toEqual([['wall:dist']]);
    expect(cache.carpetTiles).toEqual([['carpet:dist']]);
    expect(cache.defaultLayout).toEqual({ version: 1, marker: 'dist' });
  });

  it('buildAssetCache merges external dirs into characters/furniture at startup', async () => {
    const cache = await buildAssetCache('dist', ['ext']);

    expect(cache.characters?.characters).toEqual(['char-root:dist', 'char-ext:ext']);
    expect(cache.furniture?.catalog).toEqual([{ id: 'furn:dist' }, { id: 'furn:ext' }]);
    // Floor/wall/carpet are bundled-only: loaded from dist, never from the external dir.
    expect(vi.mocked(assetLoader.loadFloorTiles).mock.calls.map((c) => c[0])).toEqual(['dist']);
  });
});
