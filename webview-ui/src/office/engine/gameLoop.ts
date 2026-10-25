import {
  MAX_DELTA_TIME_SEC,
  OFFICE_IDLE_FPS,
  OFFICE_INPUT_GRACE_MS,
  OFFICE_VISIBLE_RATIO,
  WARM_SLICE_MS,
} from '../../constants.js';
import { pumpWarm, warmPending } from '../sprites/smoothSprite.js';
import { createFramePacer, FRAME_RATE } from './framePacer.js';

/** @internal */
export interface GameLoopCallbacks {
  update: (dt: number) => void;
  render: (ctx: CanvasRenderingContext2D) => void;
  /** Each frame, after the update: does the office need smooth motion (a
   *  walker, a spawn effect, a camera on the move)? false lets it draw at
   *  OFFICE_IDLE_FPS. */
  busy?: () => boolean;
}

// cld-gui (T-0075): one source of truth for "should the office draw now".
let onScreen = true; // the canvas intersects the viewport
let busy = true; // something on the office needs smooth motion
let fastUntil = 0; // input keeps the full rate until this time

const pacer = createFramePacer(() =>
  busy || performance.now() < fastUntil ? FRAME_RATE : OFFICE_IDLE_FPS,
);

/** The gate the office canvas and its DOM overlays share: false while the
 *  office is off screen, at the idle rate while nothing moves. */
export const frameDue = (ts: number): boolean => onScreen && pacer(ts);

/** Whether the office canvas is on screen (the nameplates' overlap pass waits for it). */
export const officeOnScreen = (): boolean => onScreen;
const shownListeners = new Set<() => void>();
/** Runs `fn` each time the office comes back on screen; returns the unsubscribe. */
export function onOfficeShown(fn: () => void): () => void {
  shownListeners.add(fn);
  return () => shownListeners.delete(fn);
}

/** Input on the office: draw at the full rate from the next frame on. */
export function wakeOffice(): void {
  const now = performance.now();
  // Only a rate that goes up resets the cadence: a reset on every pointer
  // move would draw on every vsync of a fast screen (past the 60 fps cap).
  if (!busy && now >= fastUntil) pacer.reset();
  fastUntil = now + OFFICE_INPUT_GRACE_MS;
}

function setBusy(b: boolean): void {
  if (b && !busy) pacer.reset();
  busy = b;
}

const isEditable = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable ||
    t.tagName === 'INPUT' ||
    t.tagName === 'TEXTAREA' ||
    t.tagName === 'SELECT');

export function startGameLoop(canvas: HTMLCanvasElement, callbacks: GameLoopCallbacks): () => void {
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  let lastTime = 0;
  let rafId = 0;
  let stopped = false;

  const frame = (time: number) => {
    rafId = 0;
    // Hidden window or tab: no frames at all until it shows again.
    if (stopped || document.hidden) return;
    // The world steps every frame (the cheap part), so motion starts on its
    // own frame with a one-frame dt, not one idle interval's jump, and it
    // keeps time off screen (the cards' temps come from it). Only drawing is
    // paced, and off screen there is none.
    const dt = lastTime === 0 ? 0 : Math.min((time - lastTime) / 1000, MAX_DELTA_TIME_SEC);
    lastTime = time;
    callbacks.update(dt);
    // Warming is deliberately outside the drawing that needs the pictures: it may use the full
    // cadence briefly, then this becomes false and the office returns to its normal idle rate.
    setBusy((callbacks.busy?.() ?? true) || warmPending() > 0);
    if (frameDue(time)) {
      ctx.imageSmoothingEnabled = false;
      const drawn = performance.now();
      callbacks.render(ctx);
      // SHEET-IMPORT: build queued character pictures for this zoom (never mid-stride), in what
      // the frame's drawing left of its slice
      pumpWarm(WARM_SLICE_MS - (performance.now() - drawn));
    }
    rafId = requestAnimationFrame(frame);
  };

  const resume = () => {
    if (stopped || document.hidden || rafId) return;
    lastTime = 0; // the time away is not one long frame
    wakeOffice();
    rafId = requestAnimationFrame(frame);
  };
  document.addEventListener('visibilitychange', resume);

  // Off screen (the phone shell's terminal page in front, a covered pane
  // scrolled away): nothing drawn until it intersects again, then at once.
  const io =
    typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver(
          (entries) => {
            // Not isIntersecting: a canvas whose edge only touches the viewport
            // (the phone shell's office page slid fully out) still reports true.
            const was = onScreen;
            onScreen = entries[entries.length - 1].intersectionRatio >= OFFICE_VISIBLE_RATIO;
            if (onScreen && !was) {
              wakeOffice();
              for (const fn of shownListeners) fn();
            }
          },
          { threshold: OFFICE_VISIBLE_RATIO },
        );
  io?.observe(canvas);

  // Input on the office, or a drag that began on it, takes the full rate.
  const region = canvas.parentElement ?? canvas;
  let pressed = false;
  const onPointer = (e: Event) => {
    const inside = region.contains(e.target as Node);
    if (e.type === 'pointerdown') pressed = inside;
    if (inside || pressed) wakeOffice();
    if (e.type === 'pointerup' || e.type === 'pointercancel') pressed = false;
  };
  const onKey = (e: KeyboardEvent) => {
    if (!isEditable(e.target)) wakeOffice();
  };
  const POINTER_EVENTS = [
    'pointerdown',
    'pointermove',
    'pointerup',
    'pointercancel',
    'wheel',
    'touchstart',
    'touchmove',
    'touchend',
  ];
  const listen = { capture: true, passive: true } as const;
  for (const t of POINTER_EVENTS) window.addEventListener(t, onPointer, listen);
  window.addEventListener('keydown', onKey, listen);
  window.addEventListener('keyup', onKey, listen);

  rafId = requestAnimationFrame(frame);

  return () => {
    stopped = true;
    cancelAnimationFrame(rafId);
    document.removeEventListener('visibilitychange', resume);
    io?.disconnect();
    for (const t of POINTER_EVENTS) window.removeEventListener(t, onPointer, listen);
    window.removeEventListener('keydown', onKey, listen);
    window.removeEventListener('keyup', onKey, listen);
  };
}
