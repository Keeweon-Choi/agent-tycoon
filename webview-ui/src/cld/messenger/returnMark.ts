import { RETURN_NEAR_RATIO } from '../../constants.js';

/** Where a jump left from: the row at the top of the view and how far down it sat (id null: the bottom). */
export interface ReturnMark {
  id: string | null;
  /** The row's time, from its id, to ask for it again when its page was dropped. */
  at: number;
  top: number;
}

/** The time an item id starts with (`<ms>-<uuid>`). */
export const idTime = (id: string): number => Number(id.slice(0, id.indexOf('-')));

/** The mark of a list now at `scrollTop`: its first row in view, or the bottom. */
export function markOf(
  rows: readonly { id: string; offsetTop: number; offsetHeight: number }[],
  scrollTop: number,
  bottom: boolean,
): ReturnMark | null {
  if (bottom) return { id: null, at: 0, top: 0 };
  const row = rows.find((r) => r.offsetTop + r.offsetHeight > scrollTop);
  return row ? { id: row.id, at: idTime(row.id), top: row.offsetTop - scrollTop } : null;
}

/** The reader has come back by hand to within part of a screen of the mark: it is no use any more. */
export const isNearMark = (offset: number, clientHeight: number): boolean =>
  Math.abs(offset) < clientHeight * RETURN_NEAR_RATIO;
