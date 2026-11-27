import assert from 'node:assert/strict';

import { beforeEach, test, vi } from 'vitest';

// Minimal React stand-in: hooks keyed by call order, effects run on mount and when deps change.
const slots: unknown[] = [];
let cursor = 0;
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (init: unknown) => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = typeof init === 'function' ? (init as () => unknown)() : init;
    return [slots[i], () => {}];
  },
  useRef: (init: unknown) => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = { current: init };
    return slots[i];
  },
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => void, deps?: unknown[]) => {
    const i = cursor++;
    const prev = slots[i] as unknown[] | undefined;
    if (prev && deps && deps.every((d, k) => Object.is(d, prev[k]))) return;
    slots[i] = deps;
    fn();
  },
}));
let handler: ((msg: unknown) => void) | undefined;
vi.mock('../transport/index.js', () => ({
  transport: {
    onMessage: (h: (msg: unknown) => void) => ((handler = h), () => {}),
    send: () => {},
  },
}));

import { useExtensionMessages } from '../hooks/useExtensionMessages.js';

const layout = { version: 1, cols: 1, rows: 1, tiles: [0], furniture: [] };
const fakeOffice = {
  characters: new Map(),
  rebuildFromLayout: vi.fn(),
  getLayout: () => layout,
  addAgent: vi.fn(),
};

beforeEach(() => {
  slots.length = 0;
  handler = undefined;
  fakeOffice.rebuildFromLayout.mockClear();
});

// One module-level getter, like App.tsx's getOfficeState: the effect subscribes once.
const getOfficeState = () => fakeOffice as never;
/* eslint-disable react-hooks/globals -- a test harness that stands in for React */
const useRender = (onLoaded: (l: unknown) => void, dirty: () => boolean) => {
  cursor = 0;
  useExtensionMessages(getOfficeState, onLoaded as never, dirty);
};
/* eslint-enable react-hooks/globals */

test('a layoutLoaded while the editor holds unsaved changes is skipped, even when the dirty flag turned true after the first render', () => {
  const loaded = vi.fn();
  useRender(loaded, () => false);
  handler!({ type: 'layoutLoaded', layout }); // the first layout: applies, layout is ready
  assert.equal(fakeOffice.rebuildFromLayout.mock.calls.length, 1);
  useRender(loaded, () => true); // the user edits: App re-renders with a fresh isEditDirty
  handler!({ type: 'layoutLoaded', layout }); // the save response / a broadcast
  assert.equal(fakeOffice.rebuildFromLayout.mock.calls.length, 1);
  assert.equal(loaded.mock.calls.length, 1);
});
