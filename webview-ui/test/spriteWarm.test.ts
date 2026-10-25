import { describe, expect, it, vi } from 'vitest';

import { WALL_COLOR } from '../src/constants.js';
import type { CharacterSprites } from '../src/office/sprites/spriteData.js';
import {
  MAX_WARM_CHARACTER_OWNERS,
  warmCharacter,
  warmCharacterOwnerCount,
} from '../src/office/sprites/warm.js';
import { Direction, type SpriteData } from '../src/office/types.js';

const frame: SpriteData = [[WALL_COLOR]];
const quartet: [SpriteData, SpriteData, SpriteData, SpriteData] = [frame, frame, frame, frame];
const pair: [SpriteData, SpriteData] = [frame, frame];
const sprites: CharacterSprites = {
  walk: {
    [Direction.DOWN]: quartet,
    [Direction.UP]: quartet,
    [Direction.RIGHT]: quartet,
    [Direction.LEFT]: quartet,
  },
  typing: {
    [Direction.DOWN]: pair,
    [Direction.UP]: pair,
    [Direction.RIGHT]: pair,
    [Direction.LEFT]: pair,
  },
  reading: {
    [Direction.DOWN]: pair,
    [Direction.UP]: pair,
    [Direction.RIGHT]: pair,
    [Direction.LEFT]: pair,
  },
  density: 1,
};

describe('sprite warming ownership', () => {
  it('does not retain owners as characters continually come and go', () => {
    for (let id = 0; id <= MAX_WARM_CHARACTER_OWNERS; id++)
      warmCharacter(sprites, 1, (f) => [f], id);
    expect(warmCharacterOwnerCount()).toBeLessThanOrEqual(MAX_WARM_CHARACTER_OWNERS);
  });

  it('a character walking frame after frame queues its frames once per zoom, and the queue drains', async () => {
    vi.resetModules(); // a queue of its own (the test above left jobs that need a canvas)
    const { pumpWarm, warmPending } = await import('../src/office/sprites/smoothSprite.js');
    const warm = await import('../src/office/sprites/warm.js');
    // (no variants: the jobs build nothing here, there is no canvas in this test)
    warm.warmCharacter(sprites, 2, () => [], 9999);
    const queued = warmPending();
    expect(queued).toBeGreaterThan(0);
    // the frames that follow (the walk goes on): nothing more queued
    for (let n = 0; n < 100; n++) warm.warmCharacter(sprites, 2, () => [], 9999);
    expect(warmPending()).toBe(queued);
    // frames that leave no time over still drain it
    for (let n = 0; warmPending() && n < 10_000; n++) pumpWarm(0);
    expect(warmPending()).toBe(0);
  });
});
