import { SCROLL_HOLD_SLACK_PX } from '../../constants.js';

export interface ScrollRestoreState {
  stuck: boolean;
  anchorTop: number | null;
  rowOffsetTop: number | null;
  savedTop: number;
}

export interface ScrollSize {
  scrollHeight: number;
  clientHeight: number;
}

/** A list without layout is not being read. */
export function isHidden({
  clientHeight,
  isConnected,
}: {
  clientHeight: number;
  isConnected: boolean;
}): boolean {
  return clientHeight === 0 || !isConnected;
}

/** Put the reader back where it was before its list lost layout. */
export function restoreTop(
  { stuck, anchorTop, rowOffsetTop, savedTop }: ScrollRestoreState,
  { scrollHeight, clientHeight }: ScrollSize,
): number {
  if (stuck) return Math.max(0, scrollHeight - clientHeight);
  if (anchorTop !== null && rowOffsetTop !== null) return rowOffsetTop - anchorTop;
  return savedTop;
}

/** Paging belongs only to a visible reader after its place is restored. */
export function mayFetchOlder({
  hidden,
  restoring,
}: {
  hidden: boolean;
  restoring: boolean;
}): boolean {
  return !hidden && !restoring;
}

/** Where a list scrolled to `top` (`height` tall) must be once older rows made it `scrollHeight` tall:
 *  the rows the reader had keep their place. */
export function prependedTop(
  before: { height: number; top: number },
  scrollHeight: number,
): number {
  return before.top + scrollHeight - before.height;
}

/**
 * Put the list at `top` so it sticks. A phone ignores a scroll set while its momentum or a finger's
 * rubber band is under way (the list then settles on the top of what was just loaded); an overflow
 * `hidden` for the set ends that gesture first. A position already there is left alone.
 */
export function holdTop(el: HTMLElement, top: number): void {
  if (Math.abs(el.scrollTop - top) <= SCROLL_HOLD_SLACK_PX) return;
  const overflowY = el.style.overflowY;
  el.style.overflowY = 'hidden';
  el.scrollTop = top;
  void el.offsetHeight; // lay it out hidden before it is scrollable again
  el.style.overflowY = overflowY;
}
