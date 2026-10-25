/** cld-gui (T-0025): the office draws at most this often. A 120/144 Hz screen
 *  would otherwise draw it, and re-render the DOM overlays above it, 2-2.4x as
 *  often for nothing a pixel-art office can show. */
export const FRAME_RATE = 60;
/** A rAF stamp may land this far before the vsync it belongs to. */
const FRAME_SLACK_MS = 1;

/** A frame gate for requestAnimationFrame loops: whether the frame stamped
 *  `ts` is drawn. Every callback of one frame gets the same stamp, and the
 *  answer is kept per stamp, so the loops that share a gate (the canvas and
 *  the overlays positioned from it) always draw on the same frames. `fps` may
 *  be a function, asked each time a frame is accepted; `reset()` makes the
 *  next stamp due at once (the rate just went up). */
export function createFramePacer(
  fps: number | (() => number) = FRAME_RATE,
): ((ts: number) => boolean) & { reset: () => void } {
  let next = -Infinity;
  let lastTs = NaN;
  let lastDue = false;
  const pacer = (ts: number) => {
    if (ts !== lastTs) {
      lastTs = ts;
      lastDue = ts >= next - FRAME_SLACK_MS;
      // Hold the cadence; after a stall (a hidden tab) start over from now.
      if (lastDue) {
        const interval = 1000 / (typeof fps === 'function' ? fps() : fps);
        next = Math.max(next + interval, ts + interval / 2);
      }
    }
    return lastDue;
  };
  return Object.assign(pacer, {
    reset: () => {
      next = -Infinity;
    },
  });
}
