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

/**
 * T-67: every plate is one width whatever its name (constants.ts NAMEPLATE_SIZES.*.card, per screen style
 * and 화면 크기 step); a name too long for it ends in an ellipsis, and the focused plate (hovered or selected)
 * wraps it whole inside the same width. The opened summary card (`opened`) keeps its own size.
 */
export const plateLook = (
  cardPx: number,
  focused: boolean,
  opened: boolean,
): { width: number | undefined; name: 'cut' | 'whole' } => ({
  width: opened ? undefined : cardPx,
  name: opened || focused ? 'whole' : 'cut',
});

/** The plate under a point (the topmost: the last drawn), so a pointer over a plate is over its character. */
export function plateAt(rects: readonly PlateRect[], x: number, y: number): number | null {
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i];
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return r.id;
  }
  return null;
}

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

export interface CrowdItem {
  key: string;
  /** The whole box where it would sit un-nudged, at full size. */
  rect: Omit<PlateRect, 'id'>;
  /** Off duty or asleep (and not focused): gives way. Anything else stays put. */
  low: boolean;
  /** A feet badge row: never moved, hidden instead. */
  fixed?: boolean;
  /** The size it takes shrunk to its name, once known (full size until then). */
  small?: { w: number; h: number };
  /** The rise it has now, when crowded: kept while the new one is less than a px away (hysteresis). */
  was?: number;
}

/** What a low item does: shrink to its name (hide, for a fixed one) and rise by `dy` (<= 0). */
export interface CrowdFate {
  crowd: boolean;
  dy: number;
}

const overlaps = (a: Omit<PlateRect, 'id'>, b: Omit<PlateRect, 'id'>, slop: number): boolean =>
  a.left + slop < b.right && b.left + slop < a.right && a.top + slop < b.bottom && b.top + slop < a.bottom;

/**
 * Who gives way where plates (and feet badges) pile up. Items that are not low stay put, and so does
 * a low one that overlaps nothing placed. A low plate that does overlap shrinks to its name and, if
 * that still sits on something, rises until it clears; a low feet badge row is hidden instead. The
 * lowest-on-screen low items go first, so the ones nearest the floor keep their place.
 * T-67: a pure function of the un-nudged boxes, so the same inputs place the same way every pass (two
 * plates on one sofa row used to swap their rises every pass at some zooms: their bottoms were read back
 * from the DOM a hair apart). The order compares bottoms in whole px with the key as the tie-break, a rise
 * is a whole number of px, and one less than a px from the rise it has (`was`) keeps that one.
 * ponytail: a rise is not clamped to the screen's top and the search is O(n^2); fine for an office's tens.
 */
export function crowdPlates(items: readonly CrowdItem[], slop: number, gap: number): Map<string, CrowdFate> {
  const placed = items.filter((i) => !i.low).map((i) => i.rect);
  const fates = new Map<string, CrowdFate>();
  const lows = items
    .filter((i) => i.low)
    .sort((a, b) => Math.round(b.rect.bottom) - Math.round(a.rect.bottom) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const item of lows) {
    const { rect } = item;
    if (!placed.some((p) => overlaps(rect, p, slop))) {
      fates.set(item.key, { crowd: false, dy: 0 });
      placed.push(rect);
      continue;
    }
    if (item.fixed) {
      fates.set(item.key, { crowd: true, dy: 0 });
      continue;
    }
    const w = item.small?.w ?? rect.right - rect.left;
    const h = item.small?.h ?? rect.bottom - rect.top;
    const cx = (rect.left + rect.right) / 2;
    let box = { left: cx - w / 2, right: cx + w / 2, top: rect.bottom - h, bottom: rect.bottom };
    let dy = 0;
    for (let i = 0; i <= placed.length; i++) {
      const hit = placed.find((p) => overlaps(box, p, slop));
      if (!hit) break;
      const step = hit.top - gap - box.bottom;
      dy += step;
      box = { ...box, top: box.top + step, bottom: box.bottom + step };
    }
    const whole = item.was !== undefined && Math.abs(dy - item.was) < 1 ? item.was : Math.floor(dy);
    box = { ...box, top: box.top + whole - dy, bottom: box.bottom + whole - dy };
    dy = whole;
    fates.set(item.key, { crowd: true, dy });
    placed.push(box);
  }
  return fates;
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
