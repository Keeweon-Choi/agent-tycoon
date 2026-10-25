import { describe, expect, it } from 'vitest';

import { WALL_COLOR } from '../src/constants.js';
import {
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

  it('HD64: each zoom draws the finest copy it divides, never a fractional fill; a sheet without copies is itself', () => {
    setCustomCharacter(
      9003,
      { ...sheet(64, 128), density: 4, lods: [{ ...sheet(32, 64), density: 2 }, sheet(16, 32)] },
      null,
    );
    const picked = (zoom: number, hue = 0) =>
      spritesAtZoom(getCharacterSprites(9003, hue), zoom).density;
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((z) => picked(z))).toEqual([1, 2, 1, 4, 1, 2, 1, 4]);
    expect(picked(1.5)).toBe(1);
    // the copies are drawn at their own size, and keep a hue turn
    expect(spritesAtZoom(getCharacterSprites(9003), 2).walk[Direction.DOWN][0][0].length).toBe(32);
    expect(picked(2, 40)).toBe(2);
    // classic and HD (density 2) characters: unchanged at every zoom
    for (const z of [1, 2, 3, 4]) {
      expect(spritesAtZoom(getCharacterSprites(9001), z)).toBe(getCharacterSprites(9001));
      expect(spritesAtZoom(getCharacterSprites(9002), z)).toBe(getCharacterSprites(9002));
    }
  });
});
