import { MOBILE_HISTORY_EDGE_PX } from '../constants.js';

/**
 * MOBILE-SWIPE (owner 11-01 16:12): the phone's rules for the browser's Back and Forward, pure
 * (Node-tested); usePhoneTabs carries them out.
 *
 * The phone keeps ONE history entry of ours (`cldTab`) above the page's own entry at all times,
 * from load on. A Back (an edge swipe, Android's back gesture) pops it: one step inside the app,
 * then it goes back on top, which also drops every Forward entry, so a stray Forward has nowhere
 * to go and a stray Back never leaves the app. Overlays (the attachment viewer, the board's full
 * view) push their own `cld*` entry above it and close on the pop.
 */
export const GUARD = 'cldTab';

/** Where a popstate landed: our guard (an overlay above it was popped), a closed overlay's
 *  entry (only a Forward reaches one), or the page's own entry (a Back popped the guard). */
export type Landing = 'guard' | 'overlay' | 'page';

export function landing(state: unknown): Landing {
  const s = state !== null && typeof state === 'object' ? (state as Record<string, unknown>) : {};
  if (s[GUARD] === true) return 'guard';
  return Object.keys(s).some((k) => k.startsWith('cld') && s[k] === true) ? 'overlay' : 'page';
}

/** The interactive things a touch in an edge strip still reaches untouched (preventDefault on a
 *  touchstart also cancels its tap). */
export const EDGE_TAP_TARGETS =
  'button, a[href], input, textarea, select, label, summary, [role="button"], [contenteditable], [data-handle]';

/** A touch starting this close to a side edge is iOS's history swipe: its touchstart is cancelled,
 *  unless it starts on something tappable. */
export const blocksEdgeSwipe = (x: number, width: number, onTapTarget: boolean): boolean =>
  !onTapTarget && (x < MOBILE_HISTORY_EDGE_PX || x > width - MOBILE_HISTORY_EDGE_PX);
