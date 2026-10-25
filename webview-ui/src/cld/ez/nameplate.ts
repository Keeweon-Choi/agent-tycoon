/**
 * charpack v3 §6A: the RPG nameplate's rules, DOM-free. Row 1 is
 * [rank icon] [name] [level in an XP ring], row 2 the 피로도 bar. Nothing here
 * invents data: no rank, no icon; no level, no ring.
 */
import type { OfficeLevel } from '../../../../core/src/messages.js';
import type { CharacterKind } from '../kinds.js';
import { type RankId, rankOfLevel } from '../rank.js';
import { levelLook } from './level.js';

export type RankIcon = RankId | 'lead';

/**
 * The nameplate's icon: an orchestrator wears the lead's crown; anyone else the icon of
 * their level's rank (rank.ts), none without a level (never guessed). The model has no say.
 */
export function rankIcon(kind: CharacterKind, level: OfficeLevel | undefined): RankIcon | null {
  return kind === 'orchestrator' ? 'lead' : rankOfLevel(level?.level);
}

export interface Ring {
  level: number;
  /** 0..100: XP from this level's floor to the next (the server's numbers). */
  pct: number;
}

/** The ring for a level the daemon keeps; none without one (never estimated). */
export const ringOf = (level: OfficeLevel | undefined): Ring | null =>
  level ? { level: level.level, pct: levelLook(level).pct } : null;

/** stroke-dasharray of a ring of circumference `c` at `pct`: [filled, empty]. */
export function ringDash(pct: number, c: number): [number, number] {
  const filled = (Math.max(0, Math.min(100, pct)) / 100) * c;
  return [filled, c - filled];
}

/** The name's max width in CSS px (the 화면 크기 step's); none when the plate is opened (selected or hovered). */
export const nameMaxPx = (sizes: { nameMax: number }, opened: boolean): number | undefined =>
  opened ? undefined : sizes.nameMax;

export interface PlateRect {
  id: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The plates to dim: those that overlap another plate on screen, except the
 * focused ones (selected, hovered). A sweep over the left edges compares only
 * plates whose x ranges meet.
 * ponytail: pairs within one x range are still compared pairwise; fine for the
 * tens of plates an office has (measured with 30), a grid if it grows to hundreds.
 */
export function dimmedPlates(
  rects: readonly PlateRect[],
  focus: ReadonlySet<number>,
  /** Overlaps this deep or less (borders and padding meeting) do not count. */
  slop = 0,
): Set<number> {
  const over = new Set<number>();
  const open: PlateRect[] = [];
  for (const r of [...rects].sort((a, b) => a.left - b.left)) {
    for (let i = open.length - 1; i >= 0; i--) {
      const o = open[i];
      if (o.right - slop <= r.left) open.splice(i, 1);
      else if (o.top + slop < r.bottom && r.top + slop < o.bottom) {
        over.add(o.id);
        over.add(r.id);
      }
    }
    open.push(r);
  }
  for (const id of focus) over.delete(id);
  return over;
}

/**
 * An off character (gone home, a stopped Worker) is drawn at `alpha`, its plate
 * and its sprite, except while it is selected or hovered: then it is in full.
 */
export const offAlpha = (off: boolean, focused: boolean, alpha: number): number =>
  off && !focused ? alpha : 1;

/**
 * The opacity the pass gives a plate inside an overlay drawn at `base` (an off
 * character's 0.55): dimmed, the two together come to `dim` or `base`, whichever
 * is lower, never their product; undimmed, the plate keeps the overlay's look.
 */
export const plateOpacity = (dimmed: boolean, base: number, dim: number): number =>
  dimmed && base > 0 ? Math.min(1, dim / base) : 1;

/**
 * Where a plate (anchored bottom-centre at x, y) goes so that all of it stays
 * on screen: inside `bounds` by `margin`. Only a plate the edge cuts is pulled
 * in; one wholly off screen (its character is elsewhere) stays where it is, and
 * so does one wider than the screen.
 */
export function clampPlate(
  x: number,
  y: number,
  size: { w: number; h: number } | undefined,
  bounds: { width: number; height: number },
  margin: number,
): { x: number; y: number } {
  if (!size) return { x, y };
  const half0 = size.w / 2;
  if (x + half0 <= 0 || x - half0 >= bounds.width || y <= 0 || y - size.h >= bounds.height)
    return { x, y };
  const half = size.w / 2 + margin;
  const cx = bounds.width < 2 * half ? x : Math.min(Math.max(x, half), bounds.width - half);
  const cy = Math.min(Math.max(y, size.h + margin), bounds.height - margin);
  return { x: cx, y: cy };
}
