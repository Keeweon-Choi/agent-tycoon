const SWIPE_DISMISS_PX = 40;
const QUICK_SWIPE_PX = 12;
const QUICK_SWIPE_MS = 180;

/** True when an upward drag is far enough, or fast enough, to dismiss a toast. */
export function swipeDismiss(dy: number, ms: number): boolean {
  return dy <= -SWIPE_DISMISS_PX || (dy <= -QUICK_SWIPE_PX && ms <= QUICK_SWIPE_MS);
}
