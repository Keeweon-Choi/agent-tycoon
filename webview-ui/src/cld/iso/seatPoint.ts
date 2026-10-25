/**
 * Translate a manifest seat point from its furniture anchor to a character's feet.
 * The renderer owns the final lift; this only supplies an iso-pixel offset for a seated agent.
 */
import type { Character, Direction, PlacedFurniture, Seat } from '../../office/types.js';
import { TILE_SIZE } from '../../office/types.js';
import { ISO_MANIFEST, type IsoManifest } from './art.js';
import { isoAt } from './projection.js';
import { isoSeat } from './seats.js';

type CatalogEntry = {
  footprintW: number;
  footprintH: number;
  backgroundTiles?: number;
};

type SeatCharacter = Pick<Character, 'dir' | 'seatId' | 'x' | 'y'>;

/** The manifest seating group associated with a catalog type, if it has one. */
function seatGroupFor(manifest: IsoManifest, type: string): string | null {
  const piece = manifest.types[type]?.piece;
  if (!piece || piece === 'none') return null;
  return (
    Object.entries(manifest.facings).find(([, facings]) =>
      Object.values(facings).some((facing) => facing?.piece === piece),
    )?.[0] ?? null
  );
}

/** The furniture that owns a generated seat tile, plus that tile's manifest seat index. */
function furnitureAtSeat(
  furniture: ReadonlyArray<PlacedFurniture>,
  seat: Seat,
  catalog: (type: string) => CatalogEntry | undefined,
  manifest: IsoManifest,
): { item: PlacedFurniture; entry: CatalogEntry; group: string; index: number } | null {
  for (const item of furniture) {
    const entry = catalog(item.type);
    const group = seatGroupFor(manifest, item.type);
    if (!entry || !group) continue;
    const firstSeatRow = item.row + (entry.backgroundTiles ?? 0);
    if (
      seat.seatCol < item.col ||
      seat.seatCol >= item.col + entry.footprintW ||
      seat.seatRow < firstSeatRow ||
      seat.seatRow >= item.row + entry.footprintH
    )
      continue;
    return {
      item,
      entry,
      group,
      index: (seat.seatRow - firstSeatRow) * entry.footprintW + (seat.seatCol - item.col),
    };
  }
  return null;
}

/**
 * Iso pixels from `ch`'s feet to its seating cushion, or null for ordinary/default seat lift.
 * A piece's manifest point starts at its footprint's front corner; character drawing starts at
 * its current tile-centre feet, so the projected anchor difference is applied here once.
 */
export function isoSeatPoint(
  ch: SeatCharacter,
  seat: Seat | undefined,
  furniture: ReadonlyArray<PlacedFurniture>,
  catalog: (type: string) => CatalogEntry | undefined,
  manifest: IsoManifest = ISO_MANIFEST,
): { x: number; y: number } | null {
  if (!ch.seatId || !seat) return null;
  const found = furnitureAtSeat(furniture, seat, catalog, manifest);
  if (!found) return null;
  const point = isoSeat(found.group, (ch.dir ?? seat.facingDir) as Direction, found.index);
  if (!point) return null;
  const anchor = isoAt(
    found.item.col + found.entry.footprintW,
    found.item.row + found.entry.footprintH,
    0,
    0,
  );
  const feet = isoAt(ch.x / TILE_SIZE, ch.y / TILE_SIZE, 0, 0);
  return { x: anchor.x - feet.x + point.x, y: anchor.y - feet.y + point.y };
}
