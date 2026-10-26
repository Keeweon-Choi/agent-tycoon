import { describe, expect, it } from 'vitest';

import { WALL_COLOR } from '../src/constants.js';
import { isSmooth } from '../src/office/sprites/smoothSprite.js';
import {
  characterLift,
  getCharacterSprites,
  setCustomCharacter,
  spritesAtZoom,
} from '../src/office/sprites/spriteData.js';
import { Direction } from '../src/office/types.js';

const frame = (w: number, h: number, c = WALL_COLOR) =>
  Array.from({ length: h }, () => new Array<string>(w).fill(c));
const sheet = (w: number, h: number) => {
  const row = Array.from({ length: 7 }, () => frame(w, h));
  return { down: row, up: row, right: row };
};

describe('character density (HD)', () => {
  it('carries a sheet density through, hue shift included; absent = 1', () => {
    setCustomCharacter(9001, sheet(16, 32), null);
    setCustomCharacter(9002, { ...sheet(32, 64), density: 2 }, null);
    expect(getCharacterSprites(9001).density).toBe(1);
    const hd = getCharacterSprites(9002);
    expect(hd.density).toBe(2);
    expect(hd.walk[Direction.DOWN][0][0].length).toBe(32);
    expect(hd.walk[Direction.LEFT][0].length).toBe(64);
    expect(getCharacterSprites(9002, 40).density).toBe(2);
  });

  it('one drawing at every zoom for a detailed character (64×128 and up); classic and HD as before', () => {
    setCustomCharacter(
      9003,
      { ...sheet(64, 128), density: 4, lods: [{ ...sheet(32, 64), density: 2 }, sheet(16, 32)] },
      null,
    );
    for (const z of [1, 1.5, 2, 3, 4, 5, 6, 8]) {
      expect(spritesAtZoom(getCharacterSprites(9003), z)).toBe(getCharacterSprites(9003));
      expect(spritesAtZoom(getCharacterSprites(9003, 40), z).density).toBe(4);
    }
    // classic and HD (density 2) characters: unchanged at every zoom
    for (const z of [1, 2, 3, 4]) {
      expect(spritesAtZoom(getCharacterSprites(9001), z)).toBe(getCharacterSprites(9001));
      expect(spritesAtZoom(getCharacterSprites(9002), z)).toBe(getCharacterSprites(9002));
    }
    // These retain spriteCache's established nearest/put-and-scale path, rather than the
    // imported/density-4 smooth-master path. This is deliberately an identity-level assertion:
    // changing the smooth threshold to 2 must fail this regression test.
    expect(isSmooth(getCharacterSprites(9001).walk[Direction.DOWN][0])).toBe(false);
    expect(isSmooth(getCharacterSprites(9002).walk[Direction.DOWN][0])).toBe(false);
  });

  it('SHEET-IMPORT: a sheet in the owner order walks left, together, right, together and stands on column 1', () => {
    const cols = Array.from({ length: 7 }, (_, c) => [[`c${c}`]]);
    setCustomCharacter(
      9004,
      { down: cols, up: cols, right: cols, walk: [1, 0, 2, 0], stand: 0 },
      null,
    );
    const s = getCharacterSprites(9004);
    expect(s.walk[Direction.DOWN].map((f) => f[0][0])).toEqual(['c1', 'c0', 'c2', 'c0']);
    expect(s.stand?.[Direction.UP][0][0]).toBe('c0');
    setCustomCharacter(
      9005,
      { down: cols, up: cols, right: cols, walk: [1, 2, 1, 2], stand: 0 },
      null,
    );
    expect(getCharacterSprites(9005).walk[Direction.LEFT].map((f) => f[0][0])).toEqual([
      'c1',
      'c2',
      'c1',
      'c2',
    ]);
    // an old sheet: 0, 1, 2, 1 and no standing frame of its own (the walk's second)
    expect(getCharacterSprites(9001).stand).toBeUndefined();
  });

  it('SHEET-IMPORT: a taller figure lifts what sits over its head by what it stands over a classic one', () => {
    // a 24×44 world frame (density 4) whose figure starts on row 18 of 176: its head 39.5 world px
    // over the frame's bottom, 8.5 over a classic head (30 px over the feet, one px over the bottom)
    const tall = Array.from({ length: 7 }, () =>
      Array.from({ length: 176 }, (_, y) => new Array<string>(96).fill(y >= 18 ? WALL_COLOR : '')),
    );
    setCustomCharacter(9006, { down: tall, up: tall, right: tall, density: 4 }, null);
    expect(characterLift(9006)).toBeCloseTo(8.5, 5);
    expect(characterLift(9001)).toBe(0);
    // a 64×128 person drawn at density 3 is 1.33 times its world size
    setCustomCharacter(9007, { ...sheet(64, 128), density: 4, drawDensity: 3 }, null);
    expect(getCharacterSprites(9007).density).toBe(3);
    expect(characterLift(9007)).toBeCloseTo(128 / 3 - 31, 5);
    // ACCEPT-4: drawn at density 3 with copies, it still draws its one master at every zoom (the
    // 32×64 copy had been picked at zoom 4, a classic-sized bunny)
    setCustomCharacter(
      9008,
      {
        ...sheet(64, 128),
        density: 4,
        drawDensity: 3,
        lods: [{ ...sheet(32, 64), density: 2 }, sheet(16, 32)],
      },
      null,
    );
    for (const z of [1, 2, 3, 4, 6, 8])
      expect(spritesAtZoom(getCharacterSprites(9008), z).density).toBe(3);
  });
});
