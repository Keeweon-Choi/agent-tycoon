/**
 * iso-prep-1104: how much smaller than its master each isometric picture is shipped. A master
 * (density 12 or 20) is finer than anything ever drawn from it, so the build (vite.config.ts,
 * `isoShipPlugin`) sends it shrunk by a whole factor k (k×k pixels averaged into one: the copy's
 * pixels stay on the master's grid), and art.ts reads its coordinates divided by k.
 *  - floors, back walls and rugs are only ever drawn into the floor cache, at most at the finest
 *    pilot density (art.ts DENSITIES, 4): a density-12 master ships at 4 (k = 3);
 *  - everything drawn live is drawn at up to ZOOM_MAX device px per world px: a density-20
 *    machine ships at 10 (k = 2), a density-12 piece as it is (12 → 10 is no whole factor).
 * Pure (no images): vite.config.ts runs it on the owner's manifest, art.ts on the merged one.
 */
import { ISO_GROUND_MAX_DENSITY, ISO_MASTER_DENSITY, ZOOM_MAX } from '../../constants.js';
import type { IsoManifest } from './art.js';

/** File → k (only the files shipped smaller than their master). */
export function shipScales(
  m: Pick<IsoManifest, 'floors' | 'walls' | 'pieces'>,
): Map<string, number> {
  const ground = new Set([
    ...Object.values(m.floors),
    m.walls.row.piece,
    m.walls.col.piece,
    m.walls.window.piece,
    m.walls.corner,
  ]);
  const out = new Map<string, number>();
  for (const [name, p] of Object.entries(m.pieces)) {
    if (p.density < ISO_MASTER_DENSITY) continue;
    const need = ground.has(name) || p.flat ? ISO_GROUND_MAX_DENSITY : ZOOM_MAX;
    const k = Math.max(1, Math.floor(p.density / need));
    // A file two pieces share ships fine enough for both.
    for (const f of p.frames ?? [p.file]) out.set(f, Math.min(k, out.get(f) ?? k));
  }
  for (const [f, k] of out) if (k === 1) out.delete(f);
  return out;
}
