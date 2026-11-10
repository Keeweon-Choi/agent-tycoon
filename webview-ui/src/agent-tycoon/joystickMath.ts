/**
 * JOYSTICK: the phone's walking pad, pure (the Node runner tests it). It only turns a drag into
 * the direction keys the keyboard already walks (or pans) with (walk.ts / useGameControls), one
 * or two of them for 8 directions; the movement itself is the keys' path, there is no second one.
 */
import { JOYSTICK_DEAD_ZONE } from '../constants.js';
import type { CameraKey, Vec } from './camera.js';

/** The knob's offset from the pad's centre: the drag, held inside the pad's radius. */
export function knobOffset(dx: number, dy: number, radius: number): Vec {
  const len = Math.hypot(dx, dy);
  return len <= radius || len === 0
    ? { x: dx, y: dy }
    : { x: (dx / len) * radius, y: (dy / len) * radius };
}

/** A drag's share along an axis from which it counts: the 8 directions are 45-degree sectors. */
const SECTOR_EDGE = Math.sin(Math.PI / 8);

/**
 * The direction keys a drag holds (screen px from the pad's centre), one or two (a diagonal),
 * none inside the dead zone. They are screen directions, as the keys are: what they walk (the
 * isometric view turns them, walk.ts walkStepOf) or pan is the keys' business.
 */
export function joystickKeys(dx: number, dy: number, radius: number): CameraKey[] {
  const len = Math.hypot(dx, dy);
  if (len < radius * JOYSTICK_DEAD_ZONE) return [];
  const edge = len * SECTOR_EDGE;
  const keys: CameraKey[] = [];
  if (dy < -edge) keys.push('up');
  if (dy > edge) keys.push('down');
  if (dx < -edge) keys.push('left');
  if (dx > edge) keys.push('right');
  return keys;
}

/**
 * Awake while used, faded after `delayMs` of rest. `hold` keeps it awake (a finger is down),
 * `wake` wakes it and starts the countdown again.
 */
export function createIdleFade(delayMs: number, onChange: (awake: boolean) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hold = () => {
    clearTimeout(timer);
    onChange(true);
  };
  const wake = () => {
    hold();
    timer = setTimeout(() => onChange(false), delayMs);
  };
  return { hold, wake, dispose: () => clearTimeout(timer) };
}
