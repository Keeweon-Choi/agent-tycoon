/**
 * A Home-Screen app on an iPhone can come up with a layout viewport shorter than the screen by
 * exactly the top inset (owner 11-01 02:19: the page ended 47 px above the bottom, a dead band under the
 * Dock). WebKit then paints nothing of the page past that viewport, only the document's background
 * (11-01 02:50: a #root stretched to the screen's bottom lost its last 47 px, the Dock's icons cut
 * in half and the messenger's composer left under the keyboard). So nothing is laid out past it:
 * useStandaloneViewport colours the band instead. The pure rule is here so it runs on the Node test runner.
 */
import { STANDALONE_VIEWPORT_TOLERANCE_PX } from '../constants.js';

/**
 * How many px of the screen lie below the layout viewport: the screen is taller by the top
 * inset (within a rounding tolerance), nothing else qualifies (a browser tab's toolbars, a keyboard,
 * a rotation, a phone with no inset all give 0).
 */
export function standaloneBottomShortfall(
  screenHeight: number,
  innerHeight: number,
  safeTop: number,
): number {
  const gap = screenHeight - innerHeight;
  if (safeTop <= 0 || gap <= 0) return 0;
  return Math.abs(gap - safeTop) <= STANDALONE_VIEWPORT_TOLERANCE_PX ? Math.round(gap) : 0;
}
