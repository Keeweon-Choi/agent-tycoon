/**
 * The text-zoom pinch (editor, preview, diff) counts the fingers that began inside its element: a thumb
 * resting on a bar elsewhere on the screen is in `e.touches` too and must not become the second finger.
 */
import assert from 'node:assert/strict';

import { test, vi } from 'vitest';

const inside = { id: 'inside' };
const outside = { id: 'outside' };
const host = {
  addEventListener: (n: string, f: (e: unknown) => void) => listeners.set(n, f),
  removeEventListener: () => {},
  contains: (node: unknown) => node === inside,
};
const listeners = new Map<string, (e: unknown) => void>();
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: () => [host, () => {}],
  useEffect: (fn: () => void) => fn(),
  useCallback: (fn: unknown) => fn,
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
}));
vi.stubGlobal('localStorage', undefined);

import { TEXT_ZOOM_DEFAULT } from '../constants.js';
import { useTextZoom, useZoomHost } from './zoomStore.js';

const touch = (identifier: number, clientX: number, target: unknown) => ({
  identifier,
  clientX,
  clientY: 0,
  target,
});
const fire = (type: string, touches: unknown[]) =>
  listeners.get(type)!({ touches, preventDefault: () => {} });

/* eslint-disable react-hooks/rules-of-hooks -- plain functions standing in for components */
const readZoom = () => useTextZoom('editor').zoom;
test('one finger in the text and a thumb elsewhere is not a pinch', () => {
  useZoomHost('editor');
  const finger = touch(1, 100, inside);
  const thumb = touch(2, 300, outside);
  fire('touchstart', [finger, thumb]);
  fire('touchmove', [touch(1, 100, inside), touch(2, 600, outside)]);
  assert.equal(readZoom(), TEXT_ZOOM_DEFAULT);
});

test('two fingers that both began in the text still pinch', () => {
  useZoomHost('editor');
  fire('touchstart', [touch(1, 100, inside), touch(2, 200, inside)]);
  fire('touchmove', [touch(1, 100, inside), touch(2, 400, inside)]);
  assert.notEqual(readZoom(), TEXT_ZOOM_DEFAULT);
});
/* eslint-enable react-hooks/rules-of-hooks */
