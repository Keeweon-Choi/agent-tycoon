/**
 * GFX 2.5D: preset floor decals (a soft shadow, a light pool) under furniture with visual
 * metadata. Each preset is a stepped pixel-art ellipse built once as SpriteData and baked per
 * zoom by getCachedSprite like any sprite: no gradients, no per-frame work beyond one
 * drawImage, nothing drawn when no item asks for one. Unknown preset ids draw nothing.
 */
import { LIGHT_WARM_POOL, SHADOW_GROUND } from '../../constants.js';
import { getCachedSprite } from '../sprites/spriteCache.js';
import type { FurnitureInstance, GroundDecal, SpriteData } from '../types.js';

/** A filled ellipse of `rx` x `ry` world px, each pixel the colour of the innermost ring it
 *  falls in (`rings`: fraction of the radius, outermost first). */
export function ellipseSprite(
  rx: number,
  ry: number,
  rings: ReadonlyArray<{ at: number; color: string }>,
): SpriteData {
  const w = Math.max(1, Math.round(rx * 2));
  const h = Math.max(1, Math.round(ry * 2));
  return Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => {
      const dx = (x + 0.5 - w / 2) / (w / 2);
      const dy = (y + 0.5 - h / 2) / (h / 2);
      const d = Math.hypot(dx, dy);
      let color = '';
      for (const r of rings) if (d <= r.at) color = r.color;
      return color;
    }),
  );
}

const made = new Map<string, SpriteData | null>();
function decalSprite(d: GroundDecal): SpriteData | null {
  if (d.sprite) return d.sprite;
  const key = `${d.kind}:${d.preset}:${d.w}`;
  let s = made.get(key);
  if (s === undefined) {
    s =
      d.kind === 'shadow' && d.preset === 'ground'
        ? ellipseSprite((d.w - SHADOW_GROUND.insetPx) / 2, SHADOW_GROUND.heightPx / 2, [
            { at: 1, color: SHADOW_GROUND.color },
          ])
        : d.kind === 'light' && d.preset === 'warm-pool'
          ? ellipseSprite(LIGHT_WARM_POOL.rx, LIGHT_WARM_POOL.ry, LIGHT_WARM_POOL.rings)
          : null;
    made.set(key, s);
  }
  return s;
}

/** The decals of `furniture`, centred on their foot points: after the floor, before walls. */
export function renderGroundDecals(
  ctx: CanvasRenderingContext2D,
  furniture: ReadonlyArray<Pick<FurnitureInstance, 'ground'>>,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  for (const f of furniture) {
    if (!f.ground) continue;
    const sprite = decalSprite(f.ground);
    if (!sprite) continue;
    const img = getCachedSprite(sprite, zoom);
    ctx.drawImage(
      img,
      Math.round(offsetX + f.ground.x * zoom - img.width / 2),
      Math.round(offsetY + f.ground.y * zoom - img.height / 2),
    );
  }
}
