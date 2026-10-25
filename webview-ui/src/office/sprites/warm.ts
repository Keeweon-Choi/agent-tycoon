/**
 * SHEET-IMPORT (owner 10-26 02:09): a visible character's frames are built for the zoom they draw
 * at before they are needed, a slice at a time between frames (smoothSprite.ts's queue), so a walk
 * never builds a picture mid-stride. Classic characters take the same path (their fills are cheap,
 * but a first stride at a new zoom still built them in the frame).
 */
import type { SpriteData } from '../types.js';
import { forgetWarm, warmOnce } from './smoothSprite.js';
import { getCachedSprite } from './spriteCache.js';
import type { CharacterSprites } from './spriteData.js';

/** Every distinct frame a character's sprites draw (walk, typing, reading, standing; 4 ways). */
export function framesOf(sprites: CharacterSprites): SpriteData[] {
  const out = new Set<SpriteData>();
  for (const set of [sprites.walk, sprites.typing, sprites.reading])
    for (const frames of Object.values(set) as SpriteData[][]) for (const f of frames) out.add(f);
  if (sprites.stand) for (const f of Object.values(sprites.stand) as SpriteData[]) out.add(f);
  return [...out];
}

/** Queue character `id`'s frames (each with the `variants` it may draw as: mirrored, dimmed) at
 *  `scale` device px per sprite px, once per sprites and scale. */
/** A normal office admits at most 500 characters; keep a little room for the greeter and tests. */
export const MAX_WARM_CHARACTER_OWNERS = 512;
const owners = new Map<number, { sprites: CharacterSprites; key: object }>();
export const warmCharacterOwnerCount = (): number => owners.size;
export function warmCharacter(
  sprites: CharacterSprites,
  scale: number,
  variants: (f: SpriteData) => SpriteData[],
  id: number,
): void {
  let o = owners.get(id);
  if (o && o.sprites !== sprites) {
    forgetWarm(o.key);
    owners.delete(id);
    o = undefined;
  }
  if (!o) owners.set(id, (o = { sprites, key: {} }));
  else {
    // Map order is LRU order, so a character currently being drawn is never an old owner.
    owners.delete(id);
    owners.set(id, o);
  }
  while (owners.size > MAX_WARM_CHARACTER_OWNERS) {
    const [staleId, stale] = owners.entries().next().value!;
    owners.delete(staleId);
    forgetWarm(stale.key);
  }
  warmOnce(o.key, scale, () =>
    framesOf(sprites).map((f) => () => {
      for (const v of variants(f)) getCachedSprite(v, scale);
    }),
  );
}
