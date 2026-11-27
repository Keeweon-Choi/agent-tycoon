/**
 * The office canvas touch gestures with a thumb resting on the dock or a card bar: `e.touches` counts
 * every finger on the screen, so that thumb turned a tap into a pinch. The gesture must follow the
 * fingers that began on the canvas (`targetTouches`). Plain-object touch events on a fake canvas, with
 * React's two hooks stood in for.
 */
import assert from 'node:assert/strict';

import { test, vi } from 'vitest';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useRef: (init: unknown) => ({ current: init }),
  useEffect: (fn: () => void) => fn(),
}));
vi.mock('../notificationSound.js', () => ({ unlockAudio: () => {} }));
vi.stubGlobal('window', { devicePixelRatio: 1 });

import { TOUCH_TAP_MAX_MOVE_PX } from '../constants.js';
import { useCanvasTouchGestures } from '../office/components/useCanvasTouchGestures.js';

interface T {
  identifier: number;
  clientX: number;
  clientY: number;
}
const thumb: T = { identifier: 9, clientX: 300, clientY: 700 }; // on the dock: never begins on the canvas
const finger = (identifier: number, clientX: number, clientY: number): T => ({
  identifier,
  clientX,
  clientY,
});

function setup() {
  const listeners = new Map<string, (e: unknown) => void>();
  const canvas = {
    addEventListener: (n: string, f: (e: unknown) => void) => listeners.set(n, f),
    removeEventListener: () => {},
  };
  const onTap = vi.fn();
  const onZoomChange = vi.fn();
  const panRef = { current: { x: 0, y: 0 } };
  /* eslint-disable react-hooks/rules-of-hooks -- a plain function standing in for a component */
  useCanvasTouchGestures({
    canvasRef: { current: canvas as never },
    enabled: true,
    zoom: 4,
    onZoomChange,
    panRef,
    clampPan: (x, y) => ({ x, y }),
    onManualPan: () => {},
    onTap,
  });
  /* eslint-enable react-hooks/rules-of-hooks */
  // `all` is every finger on the screen, `own` the ones that began on the canvas, `changed` what this event moved or lifted.
  const fire = (type: string, all: T[], own: T[], changed: T[] = own) =>
    listeners.get(type)!({
      touches: all,
      targetTouches: own,
      changedTouches: changed,
      preventDefault: () => {},
    });
  return { fire, onTap, onZoomChange, panRef };
}

test('a tap on the canvas with a thumb resting on the dock is still a tap', () => {
  const { fire, onTap, onZoomChange } = setup();
  const tap = finger(1, 120, 80);
  fire('touchstart', [thumb, tap], [tap]);
  fire('touchend', [thumb], [], [tap]);
  assert.deepEqual(onTap.mock.calls, [[120, 80]]);
  assert.equal(onZoomChange.mock.calls.length, 0);
});

test('a canvas finger dragging past the slop pans although a thumb rests elsewhere, and never zooms', () => {
  const { fire, onZoomChange, panRef } = setup();
  const down = finger(1, 100, 100);
  fire('touchstart', [thumb, down], [down]);
  const moved = finger(1, 100 + TOUCH_TAP_MAX_MOVE_PX + 40, 100);
  fire('touchmove', [thumb, moved], [moved]);
  assert.equal(panRef.current.x, TOUCH_TAP_MAX_MOVE_PX + 40);
  assert.equal(onZoomChange.mock.calls.length, 0);
});

test('two fingers that both began on the canvas still pinch', () => {
  const { fire, onZoomChange } = setup();
  fire('touchstart', [finger(1, 100, 100)], [finger(1, 100, 100)]);
  const two = [finger(1, 100, 100), finger(2, 200, 100)];
  fire('touchstart', two, two);
  const apart = [finger(1, 100, 100), finger(2, 300, 100)];
  fire('touchmove', apart, apart);
  assert.deepEqual(onZoomChange.mock.calls, [[8]]);
});
