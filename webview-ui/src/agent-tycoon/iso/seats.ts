/**
 * ISO-2: where a character sits on a chair, armchair or sofa of the isometric building.
 *
 * Each seating piece (owner 10-26 03:10: "의자도 방향 맞추고 앉는 점 잘 정해주면") faces one of the
 * four diagonals and carries its seat points in the manifest: iso px from the piece's anchor
 * (the footprint's front corner on the floor; the unit `isoAt` returns, world px at zoom 1;
 * y up is negative) to the centre of the seat cushion, one per seat. The picture flipped faces
 * the mirrored way (the two lower ones swap, the two upper ones swap), with x negated.
 *
 * Pure: the manifest is passed in. The character drawing calls `seatAnchor` and adds the result
 * to the piece's anchor on screen (`isoAt(c1, r1, level, spacing)` of its blocked footprint).
 */
import { Direction, type Direction as DirectionVal } from '../../office/types.js';
import type { Facing, IsoManifest } from './art.js';
import { ISO_MANIFEST } from './art.js';

/** The world direction a sitter faces, as the isometric facing it is drawn with. */
export function facingOf(dir: DirectionVal): Facing {
  switch (dir) {
    case Direction.DOWN:
      return '+row';
    case Direction.RIGHT:
      return '+col';
    case Direction.UP:
      return '-row';
    default:
      return '-col';
  }
}

/** Where a picture flipped faces. */
export const MIRRORED: Record<Facing, Facing> = {
  '+row': '+col',
  '+col': '+row',
  '-row': '-col',
  '-col': '-row',
  none: 'none',
};

export interface SeatPiece {
  name: string;
  /** Draw it flipped. */
  mirror: boolean;
  /** The sitter's facing is the one it shows (else the nearest the owner has drawn). */
  exact: boolean;
}

/** The piece of seating `group` ('chair', 'armchair', 'sofa') for a sitter facing `facing`:
 *  the one drawn that way, else the other facing of the same side (towards or away from the
 *  viewer), else any of the group (not exact), null for an unknown group. */
export function seatPieceFor(
  manifest: IsoManifest,
  group: string,
  facing: Facing,
): SeatPiece | null {
  const by = manifest.facings[group];
  if (!by) return null;
  const hit = (f: Facing, exact: boolean): SeatPiece | null => {
    const e = by[f];
    return e ? { name: e.piece, mirror: !!e.mirror, exact } : null;
  };
  const towards = facing === '+row' || facing === '+col';
  const sameSide: Facing[] = towards ? ['+row', '+col'] : ['-row', '-col'];
  return (
    hit(facing, true) ??
    sameSide.map((f) => hit(f, false)).find(Boolean) ??
    (Object.keys(by) as Facing[]).map((f) => hit(f, false)).find(Boolean) ??
    null
  );
}

/**
 * The seat of `pieceId` for a sitter facing `facing`, in iso px from the piece's anchor, as the
 * piece is drawn (`mirror`: flipped). Null when the piece has no seats, or `facing` is not the
 * way it (as drawn) faces. `index`: which seat of a sofa (0 the one at the back of its run).
 */
export function seatAnchor(
  manifest: IsoManifest,
  pieceId: string,
  facing: Facing,
  index = 0,
  mirror = false,
): { x: number; y: number } | null {
  const p = manifest.pieces[pieceId];
  const seat = p?.seats?.[index];
  if (!p || !seat) return null;
  const drawn = mirror ? MIRRORED[p.faces] : p.faces;
  if (drawn !== facing) return null;
  return { x: mirror ? -seat[0] : seat[0], y: seat[1] };
}

/** `seatAnchor` on the building's own manifest, for a sitter's world direction: the seat of the
 *  piece the isometric view draws for (group, direction). Null while the group has none. */
export function isoSeat(
  group: string,
  dir: DirectionVal,
  index = 0,
): { piece: string; mirror: boolean; x: number; y: number } | null {
  const facing = facingOf(dir);
  const found = seatPieceFor(ISO_MANIFEST, group, facing);
  if (!found) return null;
  const drawnFacing = found.mirror
    ? MIRRORED[ISO_MANIFEST.pieces[found.name].faces]
    : ISO_MANIFEST.pieces[found.name].faces;
  const at = seatAnchor(ISO_MANIFEST, found.name, drawnFacing, index, found.mirror);
  return at && { piece: found.name, mirror: found.mirror, ...at };
}
