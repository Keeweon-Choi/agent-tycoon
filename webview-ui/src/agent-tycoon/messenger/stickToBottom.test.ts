/**
 * T-128: the wiring between the stick-to-bottom hook, the store's older window and the
 * jump-newest button (Conversation shows it on `away || missed > 0`). The webview has no DOM
 * test library, so `react`'s hooks run on a minimal stand-in (state and refs by call order,
 * effects never run), as in draftHooks.test.ts.
 */
import { beforeEach, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], at: 0, sent: [] as unknown[] }));
vi.mock('react', async (real) => ({
  ...(await real<typeof import('react')>()),
  useState: (init: unknown) => {
    const k = hooks.at++;
    if (!(k in hooks.slots)) hooks.slots[k] = init;
    return [hooks.slots[k], (v: unknown) => (hooks.slots[k] = v)];
  },
  useRef: (init: unknown) => {
    const k = hooks.at++;
    if (!(k in hooks.slots)) hooks.slots[k] = { current: init };
    return hooks.slots[k];
  },
  useLayoutEffect: () => undefined,
}));
vi.mock('../../transport/index.js', () => ({
  transport: { send: (m: unknown) => hooks.sent.push(m) },
}));

import type { ChatItem } from '../../../../core/src/messages.js';
import { agtyHandleMessage } from '../officeStore.js';
import { useStickToBottom } from './conversation/useStickToBottom.js';
import {
  MAX_ITEMS,
  messengerGetSnapshot as snap,
  messengerResetForTests,
  requestHistory,
  setJumpLoading,
} from './messengerStore.js';

const T0 = 1_700_000_000_000;
const item = (kind: ChatItem['kind'], text: string, s: number): ChatItem => ({
  kind,
  text,
  id: `${T0 + s * 1000}-x${s}-0`,
  at: T0 + s * 1000,
});

const useRender = () => {
  hooks.at = 0;
  const scrollTo = vi.fn();
  const list = { current: { scrollTo, scrollHeight: 100 } as unknown as HTMLDivElement };
  const ref = <T>(current: T) => ({ current });
  const out = useStickToBottom({
    agentId: 1,
    m: snap(),
    items: snap().items[1],
    pending: [],
    typing: false,
    list,
    readerAnchor: ref(null),
    restoring: ref(false),
    savedTop: ref(0),
    stuck: ref(false),
    setAway: () => undefined,
  });
  return { out, scrollTo };
};

/** The reader jumped to a quote far back: the list holds an older window, not the tail. */
const jumpBack = () => {
  const tail = Array.from({ length: MAX_ITEMS }, (_, i) => item('assistant', `t${i}`, 100 + i));
  agtyHandleMessage({ type: 'chatTranscript', agentId: 1, items: tail, canSend: true });
  setJumpLoading(1, true);
  requestHistory(1, 'old');
  const older = Array.from({ length: 50 }, (_, i) => item('user', `o${i}`, i));
  agtyHandleMessage({ type: 'chatHistoryResult', agentId: 1, requestId: 'old', items: older, done: false });
};

beforeEach(() => {
  messengerResetForTests();
  hooks.slots = [];
  hooks.sent = [];
});

it('counts a reply an older window did not take in for the jump-newest button, and the jump reloads the tail', () => {
  jumpBack();
  expect(snap().historyWindowed[1]).toBe(true);
  expect(useRender().out.missed).toBe(0);
  agtyHandleMessage({
    type: 'chatTranscript',
    agentId: 1,
    items: [item('assistant', 'live', 99_999)],
    canSend: true,
    append: true,
  });
  // Conversation shows the button on `missed > 0`, with this count on it.
  expect(useRender().out.missed).toBe(1);
  const { out, scrollTo } = useRender();
  out.jump();
  expect(hooks.sent).toEqual([{ type: 'chatView', agentId: 1, on: true }]);
  expect(scrollTo).not.toHaveBeenCalled();
});

it('counts nothing and scrolls (no reload) at the tail', () => {
  const tail = [item('assistant', 'a', 1)];
  agtyHandleMessage({ type: 'chatTranscript', agentId: 1, items: tail, canSend: true });
  const { out, scrollTo } = useRender();
  expect(out.missed).toBe(0);
  out.jump();
  expect(hooks.sent).toEqual([]);
  expect(scrollTo).toHaveBeenCalledTimes(1);
});
