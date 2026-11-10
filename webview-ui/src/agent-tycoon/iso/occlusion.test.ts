import { describe, expect, it } from 'vitest';

import { fadesForCharacter } from './occlusion.js';

const character = { x: 20, y: 20, w: 10, h: 12 };

describe('isometric occlusion fade', () => {
  it('fades a front object whose screen box overlaps a character', () => {
    expect(fadesForCharacter(2, 3, character, { x: 25, y: 14, w: 12, h: 20 })).toBe(true);
  });

  it('keeps an object behind the character or apart from it opaque', () => {
    expect(fadesForCharacter(3, 2, character, { x: 25, y: 14, w: 12, h: 20 })).toBe(false);
    expect(fadesForCharacter(2, 3, character, { x: 31, y: 14, w: 12, h: 20 })).toBe(false);
  });
});
