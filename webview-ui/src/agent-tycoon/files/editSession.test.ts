/**
 * The edit session: what a save leaves clean (U1.5), the text a rebuilt view starts from (U1.3). The webview has no DOM test library, so `react`'s
 * hooks run on a minimal stand-in (as in messenger/draftHooks.test.ts): state and refs by call order,
 * effects after each render, cleanups on unmount.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  at: 0,
  effects: [] as Array<() => void>,
  cleanups: new Map<number, () => void>(),
}));
vi.mock('react', async (real) => ({
  ...(await real<typeof import('react')>()),
  useState: (init: unknown) => {
    const k = hooks.at++;
    if (!(k in hooks.slots)) hooks.slots[k] = typeof init === 'function' ? (init as () => unknown)() : init;
    const set = (v: unknown) => {
      hooks.slots[k] = typeof v === 'function' ? (v as (p: unknown) => unknown)(hooks.slots[k]) : v;
    };
    return [hooks.slots[k], set];
  },
  useRef: (init: unknown) => {
    const k = hooks.at++;
    if (!(k in hooks.slots)) hooks.slots[k] = { current: init };
    return hooks.slots[k];
  },
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
    const k = hooks.at++;
    const prev = hooks.slots[k] as { deps?: unknown[] } | undefined;
    if (prev?.deps && deps?.every((d, j) => Object.is(d, prev.deps![j]))) return;
    hooks.slots[k] = { deps };
    hooks.effects.push(() => {
      hooks.cleanups.get(k)?.();
      const cleanup = fn();
      if (cleanup) hooks.cleanups.set(k, cleanup);
      else hooks.cleanups.delete(k);
    });
  },
}));
const disk = vi.hoisted(() => ({
  save: null as null | ((hash: string) => void),
}));
vi.mock('./filesStore.js', () => ({
  readEditText: async () => ({ hash: 'h1', text: 'one\n' }),
  readEditHash: async () => 'h1',
  saveEditText: () =>
    new Promise<string>((resolve) => {
      disk.save = resolve;
    }),
}));

import { useEditSession } from './editSession.js';
import type { FileRoot } from './filesStore.js';

const root: FileRoot = { kind: 'project', project: 'p' };
function run<T>(hook: () => T): T {
  hooks.at = 0;
  const out = hook();
  for (const effect of hooks.effects.splice(0)) effect();
  return out;
}
const render = () => run(() => useEditSession(root, 'a.ts'));
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  render();
  await flush();
});
afterEach(() => {
  for (const cleanup of hooks.cleanups.values()) cleanup();
  hooks.slots = [];
  hooks.cleanups.clear();
  disk.save = null;
});

it('U1.5: letters typed while a save is on its way stay unsaved', async () => {
  const session = render();
  expect(session.doc).toBe('one\n');
  session.edit('two\n');
  const saving = render().save();
  session.edit('two\nmore'); // typed before the answer came
  disk.save!('h2');
  await saving;
  const after = render();
  expect(after.dirty).toBe(true);
  expect(after.saved).toBe(false);
});

it('a save with nothing typed meanwhile is clean and saved', async () => {
  render().edit('two\n');
  const saving = render().save();
  disk.save!('h2');
  await saving;
  const after = render();
  expect(after.dirty).toBe(false);
  expect(after.saved).toBe(true);
});

it('U1.3: the text a rebuilt editor view starts from is the draft, not the text last loaded', () => {
  render().edit('one\ntwo\n'); // then a language or width change builds the view again from `doc`
  const after = render();
  expect(after.doc).toBe('one\ntwo\n');
  expect(after.dirty).toBe(true);
});
