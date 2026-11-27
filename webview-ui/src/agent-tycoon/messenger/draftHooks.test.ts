/**
 * T-128: the composers' drafts across a held message's edit and an unmount. The webview has no
 * DOM test library, so `react`'s hooks run on a minimal stand-in: state and refs by call order,
 * effects after each render (cleanups on unmount).
 */
import { beforeEach, expect, it, vi } from 'vitest';

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
vi.mock('../../transport/index.js', () => ({ transport: { send: () => undefined } }));
vi.mock('./draftFiles.js', () => ({ useDraftFiles: () => undefined }));
vi.mock('./parts.js', () => ({ NO_CHIPS: [] }));

import { agtyHandleMessage } from '../officeStore.js';
import { useDraft } from './conversation/useDraft.js';
import {
  draftKey,
  loadDraft,
  messengerEditEnter,
  messengerEditSave,
  messengerGetSnapshot as snap,
  messengerResetForTests,
} from './messengerStore.js';
import { useRoomDraft } from './rooms/useRoomDraft.js';

function render<T>(hook: () => T): T {
  hooks.at = 0;
  const out = hook();
  for (const run of hooks.effects.splice(0)) run();
  return out;
}
function unmount(): void {
  for (const cleanup of hooks.cleanups.values()) cleanup();
  hooks.slots = [];
  hooks.cleanups.clear();
}

const KEY = draftKey('claude', 'alpha');
const draftHook = () =>
  render(() =>
    useDraft({
      agentId: 1,
      m: snap(),
      row: undefined,
      name: 'alpha',
      pending: snap().pending[1] ?? [],
      openQuote: () => undefined,
      box: { current: null },
    }),
  );
/** Conversation's 고치기 on the queued bubble: the draft parks, the queued words fill the composer. */
const enterEdit = () => {
  const d = draftHook();
  d.editRestore.current = d.text;
  expect(messengerEditEnter(() => undefined, 1, 'alpha', 'q:1-e.json')).toBe(true);
  d.parkReply();
  d.setText('orig');
  draftHook().edit('orig v2');
};

beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => stored.set(k, v),
  });
  messengerResetForTests();
  unmount();
  agtyHandleMessage({
    type: 'chatTranscript',
    agentId: 1,
    items: [],
    canSend: true,
    queued: [{ id: '1-e.json', text: 'orig', at: Date.now() }],
  });
  draftHook().edit('D');
});

it('B6.3: an edit of a held message left by unmounting keeps the unsent draft', () => {
  enterEdit();
  unmount(); // another tab, the phone's back, a reload
  expect(loadDraft(KEY)).toBe('D');
  expect(draftHook().text).toBe('D');
});

it('B6.3: a saved edit gives the composer the unsent draft back', () => {
  enterEdit();
  expect(messengerEditSave(() => undefined, 'orig v2')).toBe(true);
  draftHook().restoreDraft(); // Conversation's submit after a saved edit
  expect(draftHook().text).toBe('D');
  expect(loadDraft(KEY)).toBe('D');
});

it('B6.3: a lost edit taken back to the composer joins the unsent draft', () => {
  enterEdit();
  // The held message went in meanwhile (the queue no longer lists it): the save becomes editLost.
  agtyHandleMessage({ type: 'chatTranscript', agentId: 1, items: [], canSend: true, queued: [] });
  expect(messengerEditSave(() => undefined, 'orig v2')).toBe(true);
  draftHook().restoreDraft();
  draftHook().takeBack(snap().editLost!.text);
  expect(draftHook().text).toBe('D\norig v2');
  expect(loadDraft(KEY)).toBe('D\norig v2');
});

it('B6.6: a room composer keeps its unsent text and reply across leaving the room', () => {
  const reply = { id: 'p1', sender: 'alpha', text: 'ship it?' };
  unmount(); // the chat's hook from beforeEach
  const room = () => render(() => useRoomDraft('room:release'));
  room().setText('@alpha long message');
  room().setReply(reply);
  unmount(); // a DM tab, the phone's back
  expect(room()).toMatchObject({ text: '@alpha long message', reply });
  // Another room (its screen is keyed by room id, so it mounts afresh) has its own draft.
  unmount();
  const other = () => render(() => useRoomDraft('room:ops'));
  expect(other()).toMatchObject({ text: '', reply: null });
  other().setText('ops note');
  unmount();
  expect(room()).toMatchObject({ text: '@alpha long message', reply });
  // Posted: the next visit starts empty.
  room().setText('');
  room().setReply(null);
  unmount();
  expect(room()).toMatchObject({ text: '', reply: null });
});
