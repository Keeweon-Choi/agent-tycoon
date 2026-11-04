import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  BUBBLE_HEART_SPRITE,
  BUBBLE_PERMISSION_SPRITE,
  BUBBLE_WAITING_SPRITE,
} from '../src/office/sprites/spriteData.js';

// Pins our own bubble pictures (cld/scripts/gen-bubbles.cjs): a changed pixel must be a deliberate edit of both.
const sig = (s: string[][]) =>
  createHash('sha1').update(JSON.stringify(s)).digest('hex').slice(0, 12);

describe('speech bubble sprites', () => {
  it.each([
    ['permission', BUBBLE_PERMISSION_SPRITE, '78a1f9bb7ff7'],
    ['waiting', BUBBLE_WAITING_SPRITE, '2c18b784aea5'],
    ['heart', BUBBLE_HEART_SPRITE, '16562f220626'],
  ])('%s is 11x13 and unchanged', (_n, sprite, hash) => {
    expect(sprite.length).toBe(13);
    expect(sprite.every((r) => r.length === 11)).toBe(true);
    expect(sig(sprite)).toBe(hash);
  });
});
