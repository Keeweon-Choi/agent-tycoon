import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatItem, ChatSend, MessengerContact } from '../../../../core/src/messages.js';
import { CHAT_REQUEST_TIMEOUT_MS, MSG_COMMAND_SETTLE_MS } from '../../constants.js';
import { setLanguage, t } from '../../i18n/index.js';
import { presenceOf, presenceWord } from '../officeHours.js';
import { agtyConnectionLost, agtyHandleMessage } from '../officeStore.js';
import { type AttachmentChip, composeAttachmentText } from './attachments.js';

const stepUp = vi.hoisted(() => ({ ok: true, asked: 0 }));
vi.mock('../auth/stepUp.js', () => ({
  requestStepUp: () => {
    stepUp.asked++;
    return Promise.resolve(stepUp.ok);
  },
}));
import {
  chatViewClosed,
  clearSearchAll,
  closeConversation,
  closeRoomTab,
  contactKey,
  conversationSections,
  dismissSend,
  dividerAfter,
  DRAFT_TTL_MS,
  draftKey,
  foldQuest,
  hasMessengerDraft,
  jumpStep,
  jumpTarget,
  leadPresence,
  leadState,
  loadDraft,
  loadDraftReply,
  MAX_ITEMS,
  MAX_OPEN,
  mergeItems,
  messengerAnswerPermission,
  messengerApproveHeld,
  messengerCancel,
  messengerEditEnter,
  messengerEditLeave,
  messengerEditPark,
  messengerEditSave,
  messengerGetSnapshot as snap,
  messengerPin,
  messengerResetForTests,
  messengerSend,
  messengerSendNow,
  onLeadReply,
  openConversation,
  openMessenger,
  openRoomAt,
  questLabel,
  requestHistory,
  requestSearch,
  requestSearchAll,
  saveDraft,
  saveDraftReply,
  setJumpLoading,
  settle,
  showConversation,
  showMessengerList,
  showRoom,
  sortConversations,
  startsEarlierSession,
  unreadCount,
} from './messengerStore.js';

/** An hour ago: the prompts of a send must not predate it by more than the skew. */
const T0 = Math.floor(Date.now() / 1000) * 1000 - 3_600_000;
const rid = (s: number) => `${T0 + s * 1000}-r${s}-0`;
const item = (kind: ChatItem['kind'], text: string, s: number): ChatItem => ({
  kind,
  text,
  id: `${T0 + s * 1000}-x${s}-0`,
  at: T0 + s * 1000,
});

it('prepends pages in order, dedupes ids, and accepts only the active request', () => {
  const newer = [item('user', 'third', 3), item('assistant', 'fourth', 4)];
  const older = [item('user', 'first', 1), item('assistant', 'second', 2)];
  expect(mergeItems([...older, newer[0]], newer).map((x) => x.text)).toEqual([
    'first',
    'second',
    'third',
    'fourth',
  ]);
  agtyHandleMessage({ type: 'chatTranscript', agentId: 1, items: newer, canSend: true });
  requestHistory(1, 'current');
  agtyHandleMessage({
    type: 'chatHistoryResult',
    agentId: 1,
    requestId: 'stale',
    items: older,
    done: true,
  });
  expect(snap().items[1]).toEqual(newer);
  agtyHandleMessage({
    type: 'chatHistoryResult',
    agentId: 1,
    requestId: 'current',
    items: [...older, newer[0]],
    done: true,
  });
  expect(snap().items[1].map((x) => x.text)).toEqual(['first', 'second', 'third', 'fourth']);
  expect(snap().historyDone[1]).toBe(true);
});

it('gives up on a history or search request the daemon never answers', () => {
  vi.useFakeTimers();
  try {
    requestHistory(1, 'h');
    requestSearch(1, 's');
    expect(snap().historyBusy[1]).toBe('h');
    vi.advanceTimersByTime(CHAT_REQUEST_TIMEOUT_MS);
    expect(snap().historyBusy[1]).toBeUndefined();
    expect(snap().historyError[1]).toContain('\ubd88\ub7ec\uc624\uc9c0 \ubabb\ud588\uc5b4\uc694');
    expect(snap().searchBusy[1]).toBeUndefined();
    expect(snap().searchResults[1].error).toBe('\uac80\uc0c9\ud558\uc9c0 \ubabb\ud588\uc5b4\uc694');
    requestHistory(1, 'again'); // a later request can be made
    expect(snap().historyBusy[1]).toBe('again');
  } finally {
    vi.useRealTimers();
  }
});

it('places a divider after an earlier session and chooses a jump target', () => {
  const rows = [
    { ...item('user', 'old', 1), session: 'prior', sessionStart: T0 },
    { ...item('assistant', 'old reply', 2), session: 'prior', sessionStart: T0 },
    item('user', 'new', 3),
  ];
  expect(dividerAfter(rows, 0)).toBeUndefined();
  expect(dividerAfter(rows, 1)).toBe(T0);
  expect(dividerAfter(rows, 2)).toBeUndefined();
  // The band that opens the earlier session: its first item; a cut-off first item only at the start.
  expect(startsEarlierSession(rows, 0, false)).toBe(false);
  expect(startsEarlierSession(rows, 0, true)).toBe(true);
  expect(startsEarlierSession(rows, 1, true)).toBe(false);
  expect(startsEarlierSession(rows, 2, true)).toBe(false);
  expect(jumpTarget(rows, T0 + 2_500)?.text).toBe('old reply');
  expect(jumpTarget(rows, T0 + 3_000, rows[0].id)?.text).toBe('old');
});

it('a notice without an id lands on the message, not on a tool line after it (owner 10-24)', () => {
  const rows = [
    item('user', 'do it', 1),
    item('assistant', 'done, here is the result', 2),
    item('tool', 'Bash: ls', 3),
    item('result', 'a b c', 4),
  ];
  // The notice came after the tool lines: the reply is still what it is about.
  expect(jumpTarget(rows, T0 + 5_000)?.text).toBe('done, here is the result');
  // A named id wins; with only tool lines before the time, those are all there is.
  expect(jumpTarget(rows, T0 + 5_000, rows[2].id)?.text).toBe('Bash: ls');
  expect(jumpTarget(rows.slice(2), T0 + 5_000)?.text).toBe('a b c');
});
describe('a notice jump never lands on a neighbour (NOTICE-JUMP)', () => {
  // The reply is the newest message; the list held is the stale one from an earlier visit.
  const stale = [item('user', 'go', 1), item('assistant', 'task notice', 2)];
  const reply = { ...item('assistant', 'the reply', 4), id: `${T0 + 4_000}-rep-0` };
  const live = { live: true, historyDone: false, waitedOut: false };
  const cold = { live: false, historyDone: false, waitedOut: false };

  it('names an item that has not arrived yet: wait, never the older neighbour', () => {
    expect(jumpStep(stale, { at: T0 + 5_000, id: reply.id }, live).step).toBe('wait');
    expect(jumpStep(stale, { at: T0 + 5_000, id: reply.id }, cold).step).toBe('wait');
  });
  it('names an item that is loaded: that item', () => {
    expect(jumpStep([...stale, reply], { at: T0 + 5_000, id: reply.id }, cold)).toEqual({
      step: 'found',
      item: reply,
    });
  });
  it('an item older than the loaded page: fetch older until history is done', () => {
    const old = { ...item('assistant', 'old', 0), id: `${T0 - 9_000}-old-0` };
    expect(jumpStep(stale, { at: T0 - 8_000, id: old.id }, live).step).toBe('older');
    expect(jumpStep(stale, { at: T0 - 8_000, id: old.id }, { ...live, historyDone: true }).step).toBe(
      'found',
    );
  });
  it('no id, a stale list and a newer time: wait for the fresh tail; a live list resolves', () => {
    expect(jumpStep(stale, { at: T0 + 5_000 }, cold).step).toBe('wait');
    expect(jumpStep(stale, { at: T0 + 5_000 }, live)).toEqual({ step: 'found', item: stale[1] });
    expect(jumpStep([...stale, reply], { at: T0 + 5_000 }, { ...cold, live: true })).toMatchObject({
      item: reply,
    });
  });
  it('a bounded wait that ran out falls back by time', () => {
    const out = { ...cold, waitedOut: true };
    expect(jumpStep(stale, { at: T0 + 5_000 }, out)).toEqual({ step: 'found', item: stale[1] });
    expect(jumpStep(stale, { at: T0 + 5_000, id: reply.id }, out)).toEqual({
      step: 'found',
      item: stale[1],
    });
  });
  it('a conversation never loaded waits', () => {
    expect(jumpStep([], { at: T0 + 5_000 }, cold).step).toBe('wait');
  });
  it('the tail flag follows the daemon: a transcript makes it live, closing the view stale', () => {
    agtyHandleMessage({ type: 'chatTranscript', agentId: 1, items: stale, canSend: true });
    expect(snap().tailLive[1]).toBe(true);
    chatViewClosed(1);
    expect(snap().tailLive[1]).toBe(false);
  });
  it('a conversation opened for a reply keeps its item id for the jump', () => {
    openMessenger(1, { at: T0 + 5_000, id: reply.id });
    expect(snap().pendingJump).toEqual({ agentId: 1, at: T0 + 5_000, id: reply.id });
  });
});
const contact = (
  name: string,
  agentId: number,
  replies: number[],
  lastAt = 0,
): MessengerContact => ({
  agentId,
  name,
  replies: replies.map(rid),
  lastAt,
  preview: `${name} says`,
});
const contacts = (list: MessengerContact[]) =>
  agtyHandleMessage({ type: 'messengerContacts', contacts: list });

let stored: Map<string, string>;
beforeEach(() => {
  setLanguage('ko');
  stored = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => stored.set(k, v),
  });
  messengerResetForTests();
});
const savedRead = () => JSON.parse(stored.get('agty.messenger.read') ?? '{}') as unknown;

it(`at most ${MAX_OPEN} conversations open: the oldest leaves for a new one`, () => {
  let open: number[] = [];
  for (const id of [1, 2, 3, 4]) open = openConversation(open, id);
  expect(open).toEqual([1, 2, 3, 4]);
  expect(openConversation(open, 3)).toBe(open); // already open: unchanged
  expect(openConversation(open, 5)).toEqual([2, 3, 4, 5]);
  for (const id of [6, 7, 8, 9, 10]) openMessenger(id);
  expect(snap().open).toEqual([7, 8, 9, 10]);
  expect(snap().active).toBe(10);
  closeConversation(10);
  expect(snap()).toMatchObject({ open: [7, 8, 9], active: 9 });
});

it('unread: replies after the last-read one, by position or (gone from the list) by time', () => {
  const replies = [1, 2, 3, 4].map(rid);
  expect(unreadCount(replies, undefined)).toBe(0); // no mark yet
  expect(unreadCount(replies, rid(2))).toBe(2);
  expect(unreadCount(replies, rid(4))).toBe(0);
  expect(unreadCount(replies, `${T0 + 2500}-gone-0`)).toBe(2); // not listed any more: by time
  expect(unreadCount(replies, rid(0))).toBe(4);
});

it('a room first seen with no counted update still shows its first replies as unread', () => {
  const room = (updates: string[]) => ({
    id: 'fresh',
    name: 'Fresh',
    members: ['alpha'],
    preview: '',
    lastAt: T0,
    updates,
  });
  agtyHandleMessage({ type: 'groupRooms', rooms: [room([])] });
  agtyHandleMessage({ type: 'groupRooms', rooms: [room([rid(1), rid(2)])] });
  expect(unreadCount(snap().rooms[0].updates!, snap().read['room:fresh'])).toBe(2);
});

describe('ROOM-UNREAD: a read room stays read when its ids come back in another order', () => {
  const room = (updates: string[]) => ({
    id: 'team',
    name: 'Team',
    members: ['alpha', 'beta'],
    preview: '',
    lastAt: T0,
    updates,
  });
  const unread = () => unreadCount(snap().rooms[0].updates!, snap().read['room:team']);
  // post p1, post p2, then alpha's reply to p1 (t5) and beta's (t3): live they arrive by time,
  // a rebuild lists them by post and member (the room view's order).
  const live = [rid(1), rid(3), rid(4), rid(5)];
  const rebuilt = [rid(1), rid(5), rid(3), rid(4)];

  it('reading a room whose list is not in time order marks its newest id, not its last', () => {
    agtyHandleMessage({ type: 'groupRooms', rooms: [room([rid(1)])] });
    openMessenger(1);
    showRoom('team');
    agtyHandleMessage({ type: 'groupRooms', rooms: [room(rebuilt)] });
    expect(snap().read['room:team']).toBe(rid(5));
    expect(unread()).toBe(0);
  });

  it('a daemon restart or reload that lists the same ids in another order brings no badge', () => {
    agtyHandleMessage({ type: 'groupRooms', rooms: [room([rid(1)])] });
    openMessenger(1);
    showRoom('team');
    agtyHandleMessage({ type: 'groupRooms', rooms: [room(live)] });
    showMessengerList();
    agtyHandleMessage({ type: 'groupRooms', rooms: [room(rebuilt)] });
    expect(unread()).toBe(0);
  });

  it('something actually newer still counts, listed anywhere', () => {
    agtyHandleMessage({ type: 'groupRooms', rooms: [room([rid(1)])] });
    openMessenger(1);
    showRoom('team');
    agtyHandleMessage({ type: 'groupRooms', rooms: [room(live)] });
    showMessengerList();
    agtyHandleMessage({ type: 'groupRooms', rooms: [room([...rebuilt, rid(6)])] });
    expect(unread()).toBe(1);
    agtyHandleMessage({ type: 'groupRooms', rooms: [room([rid(1), rid(6), ...rebuilt.slice(1)])] });
    expect(unread()).toBe(1);
  });
});

it('room rows keep a preview and unread activity, and room/back navigation is separate from DMs', () => {
  agtyHandleMessage({
    type: 'groupRooms',
    rooms: [
      {
        id: 'release',
        name: 'Release',
        members: ['alpha', 'beta'],
        preview: 'alpha: preparing',
        lastAt: T0 + 1_000,
        updates: [rid(1)],
      },
    ],
  });
  expect(snap().read['room:release']).toBe(rid(1)); // first sight is the baseline
  agtyHandleMessage({
    type: 'groupRooms',
    rooms: [
      {
        id: 'release',
        name: 'Release',
        members: ['alpha', 'beta'],
        preview: 'beta: done',
        lastAt: T0 + 3_000,
        updates: [rid(1), rid(2), rid(3)],
      },
    ],
  });
  expect(unreadCount(snap().rooms[0].updates!, snap().read['room:release'])).toBe(2);
  openMessenger(1);
  showRoom('release');
  expect(snap()).toMatchObject({ active: null, activeRoom: 'release' });
  expect(snap().read['room:release']).toBe(rid(3));
  showMessengerList();
  // MSG-UI2: leaving a room for the list keeps it as a tab; × closes it.
  expect(snap()).toMatchObject({ active: null, activeRoom: null, openRooms: ['release'] });
  showRoom('release');
  expect(snap().openRooms).toEqual(['release']); // no second tab for the same room
  closeRoomTab('release');
  expect(snap()).toMatchObject({ active: 1, activeRoom: null, openRooms: [] }); // the last open conversation comes up
  // A room deleted while its screen is open closes the screen and its tab.
  showRoom('release');
  agtyHandleMessage({ type: 'groupRooms', rooms: [] });
  expect(snap()).toMatchObject({ activeRoom: null, openRooms: [] });
});

it('a closed conversation counts new replies; opening it marks them read, per device', () => {
  contacts([contact('alpha', 1, [1]), contact('beta', 2, [1])]);
  expect(snap().read).toEqual({ alpha: rid(1), beta: rid(1) }); // first sight: the baseline
  const replies: string[] = [];
  const off = onLeadReply((r) => replies.push(`${r.name}: ${r.preview}`));
  contacts([contact('alpha', 1, [1, 2, 3], 3), contact('beta', 2, [1], 1)]);
  expect(unreadCount(snap().contacts[0].replies, snap().read.alpha)).toBe(2);
  expect(replies).toEqual(['alpha: alpha says']);
  expect(savedRead()).toEqual({ alpha: rid(1), beta: rid(1) });
  openMessenger(1);
  expect(snap().read.alpha).toBe(rid(3));
  expect(savedRead()).toEqual({ alpha: rid(3), beta: rid(1) });
  // While the boss reads it, a new reply is read at once and does not notify.
  contacts([contact('alpha', 1, [1, 2, 3, 4], 4), contact('beta', 2, [1], 1)]);
  expect(snap().read.alpha).toBe(rid(4));
  expect(replies).toHaveLength(1);
  // The phone's list: nothing on it is read.
  showConversation(null);
  contacts([contact('alpha', 1, [1, 2, 3, 4, 5], 5), contact('beta', 2, [1], 1)]);
  expect(unreadCount(snap().contacts[0].replies, snap().read.alpha)).toBe(1);
  off();
});

it('storage that throws (private mode, blocked site data) breaks nothing', () => {
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('SecurityError');
    },
    setItem: () => {
      throw new Error('SecurityError');
    },
  });
  messengerResetForTests();
  contacts([contact('alpha', 1, [1])]);
  openMessenger(1);
  expect(snap().read).toEqual({ alpha: rid(1) });
});

it('contacts: newest activity first, then by name; pinned ones stay on top (U-30)', () => {
  const list = [
    contact('a', 1, [1], 10),
    contact('b', 2, [1], 30),
    contact('c', 3, [1, 2], 5),
    contact('d', 4, [1], 30),
  ];
  const names = (pinned: string[]) =>
    sortConversations(list, contactKey, pinned).map((c) => c.name);
  expect(names([])).toEqual(['b', 'd', 'a', 'c']);
  expect(names(['c', 'a'])).toEqual(['a', 'c', 'b', 'd']);
});

it('two sections: direct chats and group rooms each sort pinned first, then newest (U-36)', () => {
  const room = (id: string, lastAt: number) => ({ id, name: id, members: [], lastAt });
  const { direct, groups } = conversationSections(
    [contact('a', 1, [1], 10), contact('b', 2, [1], 30)],
    [room('x', 5), room('y', 50), room('z', 20)],
    ['a', 'room:z'],
  );
  expect(direct.map((c) => c.name)).toEqual(['a', 'b']);
  expect(groups.map((r) => r.id)).toEqual(['z', 'y', 'x']);
  // a room pin is not a contact pin: pinning 'room:x' leaves the direct list alone
  expect(
    conversationSections(
      [contact('a', 1, [1], 10), contact('b', 2, [1], 30)],
      [],
      ['room:x'],
    ).direct.map((c) => c.name),
  ).toEqual(['b', 'a']);
});

it('D3: a project’s Workers sit under its chat (its Lead), not among the direct chats', () => {
  const worker = (name: string, project: string, lastAt: number) => ({
    ...contact(name, 9, [1], lastAt),
    project,
  });
  const { direct, workers } = conversationSections(
    [
      contact('alpha', 1, [1], 10),
      worker('alpha-a', 'alpha', 50),
      worker('alpha-b', 'alpha', 60),
      worker('ghost-a', 'ghost', 5), // its project has no chat here: stays visible
      contact('beta', 2, [1], 30),
    ],
    [],
    ['alpha-a'],
  );
  expect(direct.map((c) => c.name)).toEqual(['beta', 'alpha', 'ghost-a']);
  expect(
    Object.fromEntries(Object.entries(workers).map(([p, w]) => [p, w.map((c) => c.name)])),
  ).toEqual({
    alpha: ['alpha-a', 'alpha-b'],
  });
});

it('pinnedConversations fills the snapshot; a pin goes to the daemon as a command', () => {
  agtyHandleMessage({ type: 'pinnedConversations', keys: ['alpha', 'room:all'] });
  expect(snap().pinned).toEqual(['alpha', 'room:all']);
  const sent: unknown[] = [];
  messengerPin((m) => sent.push(m), 'beta', true);
  expect(sent).toEqual([{ type: 'setConversationPin', key: 'beta', pinned: true }]);
});

it('a send: its bubble, the daemon queues it, then the transcript has it (\ubc1b\uc74c)', () => {
  agtyHandleMessage({
    type: 'chatTranscript',
    agentId: 1,
    items: [item('user', '\ubc30\ud3ec\ud574 \uc918', 1), item('assistant', '\ub124', 2)],
    canSend: true,
  });
  const sent: Array<{ requestId: string }> = [];
  messengerSend((m) => sent.push(m as ChatSend), true, 1, 'alpha', '\ubc30\ud3ec\ud574 \uc918');
  expect(sent).toEqual([
    {
      type: 'chatSend',
      requestId: expect.any(String),
      name: 'alpha',
      text: '\ubc30\ud3ec\ud574 \uc918',
    },
  ]);
  expect(snap().pending[1]).toMatchObject([
    { text: '\ubc30\ud3ec\ud574 \uc918', state: 'sending' },
  ]);
  agtyHandleMessage({
    type: 'chatSendResult',
    requestId: sent[0].requestId,
    name: 'alpha',
    ok: true,
    delivered: 'queued',
  });
  expect(snap().pending[1][0].state).toBe('queued');
  // The same words said long ago do not settle it; the new prompt does.
  agtyHandleMessage({ type: 'chatTranscript', agentId: 1, items: snap().items[1], canSend: true });
  expect(snap().pending[1]).toHaveLength(1);
  const typed = { ...item('user', '\ubc30\ud3ec\ud574 \uc918', 3), at: Date.now() };
  agtyHandleMessage({
    type: 'chatTranscript',
    agentId: 1,
    items: [typed],
    canSend: true,
    append: true,
  });
  expect(snap().pending[1]).toEqual([]);
  expect(snap().received[1]).toEqual([typed.id]);
  expect(snap().items[1].map((i) => i.text)).toEqual([
    '\ubc30\ud3ec\ud574 \uc918',
    '\ub124',
    '\ubc30\ud3ec\ud574 \uc918',
  ]);
  // A full transcript (a reconnect) replaces what was held.
  agtyHandleMessage({ type: 'chatTranscript', agentId: 1, items: [typed], canSend: false });
  expect(snap().items[1]).toHaveLength(1);
  expect(snap().canSend[1]).toBe(false);
});

it('\uc989\uc2dc (now): the send carries it and the bubble says so', () => {
  const sent: unknown[] = [];
  messengerSend((m) => sent.push(m), true, 1, 'alpha', '\uc9c0\uae08', true);
  expect(sent).toEqual([
    {
      type: 'chatSend',
      requestId: expect.any(String),
      name: 'alpha',
      text: '\uc9c0\uae08',
      now: true,
    },
  ]);
  expect(snap().pending[1][0]).toMatchObject({ state: 'sending', now: true });
});

it('after a reload: the queued list becomes \ubcf4\ub0c4(\ub300\uae30 \uc911) bubbles; \uc9c0\uae08 \ubcf4\ub0b4\uae30 promotes one', () => {
  const queued = [
    { id: '1-a.json', text: '\uccab\uc9f8', at: T0 },
    { id: '2-b.json', text: '\ub458\uc9f8', at: T0, now: true },
  ];
  agtyHandleMessage({ type: 'chatTranscript', agentId: 1, items: [], canSend: true, queued });
  expect(snap().pending[1]).toMatchObject([
    { requestId: 'q:1-a.json', text: '\uccab\uc9f8', state: 'queued', queueId: '1-a.json' },
    { requestId: 'q:2-b.json', state: 'queued', now: true },
  ]);
  const sent: unknown[] = [];
  messengerSendNow((m) => sent.push(m), 1, 'alpha', 'q:1-a.json');
  messengerSendNow((m) => sent.push(m), 1, 'alpha', 'q:1-a.json'); // once
  expect(sent).toEqual([
    { type: 'chatSendNow', requestId: 'q:1-a.json', name: 'alpha', id: '1-a.json' },
  ]);
  agtyHandleMessage({
    type: 'chatSendResult',
    requestId: 'q:1-a.json',
    name: 'alpha',
    ok: true,
    delivered: 'queued',
    queueId: '1-a.json',
  });
  expect(snap().pending[1][0]).toMatchObject({ state: 'queued', now: true, promoting: false });
  // Typed in: the list drops it, and the bubble with it.
  agtyHandleMessage({
    type: 'chatTranscript',
    agentId: 1,
    items: [],
    canSend: true,
    append: true,
    queued: [queued[1]],
  });
  expect(snap().pending[1].map((p) => p.requestId)).toEqual(['q:2-b.json']);
});

it('edit mode enters from a queued bubble, saves to that id, or leaves without sending', () => {
  agtyHandleMessage({
    type: 'chatTranscript',
    agentId: 1,
    items: [],
    canSend: true,
    queued: [{ id: '1-edit.json', text: 'old words', at: T0 }],
  });
  const sent: unknown[] = [];
  const sendHold = (m: unknown) => sent.push(m);
  expect(messengerEditEnter(sendHold, 1, 'alpha', 'q:1-edit.json')).toBe(true);
  expect(snap().editing).toMatchObject({
    agentId: 1,
    name: 'alpha',
    queueId: '1-edit.json',
    text: 'old words',
  });
  expect(sent).toEqual([{ type: 'chatHold', name: 'alpha', id: '1-edit.json', on: true }]);
  messengerEditLeave(sendHold);
  expect(snap().editing).toBeNull();
  expect(sent).toEqual([
    { type: 'chatHold', name: 'alpha', id: '1-edit.json', on: true },
    { type: 'chatHold', name: 'alpha', id: '1-edit.json', on: false },
  ]);

  expect(messengerEditEnter(sendHold, 1, 'alpha', 'q:1-edit.json')).toBe(true);
  expect(messengerEditSave((m) => sent.push(m), 'new words')).toBe(true);
  expect(sent).toEqual([
    { type: 'chatHold', name: 'alpha', id: '1-edit.json', on: true },
    { type: 'chatHold', name: 'alpha', id: '1-edit.json', on: false },
    { type: 'chatHold', name: 'alpha', id: '1-edit.json', on: true },
    {
      type: 'chatEdit',
      requestId: expect.stringMatching(/^edit:1-edit\.json:/),
      name: 'alpha',
      id: '1-edit.json',
      text: 'new words',
    },
  ]);
  expect(snap().editing).toBeNull();
  expect(snap().pending[1][0]).toMatchObject({ editing: true, text: 'old words' });
  agtyHandleMessage({
    type: 'chatPendingResult',
    requestId: (sent[3] as { requestId: string }).requestId,
    name: 'alpha',
    id: '1-edit.json',
    ok: true,
  });
  expect(snap().pending[1][0]).toMatchObject({ text: 'new words', edited: true, editing: false });
  messengerCancel((m) => sent.push(m), 1, 'alpha', 'q:1-edit.json');
  expect(sent[4]).toMatchObject({ type: 'chatCancel', name: 'alpha', id: '1-edit.json' });
  agtyHandleMessage({
    type: 'chatPendingResult',
    requestId: (sent[4] as { requestId: string }).requestId,
    name: 'alpha',
    id: '1-edit.json',
    ok: true,
  });
  expect(snap().pending[1][0]).toMatchObject({ state: 'cancelled', cancelling: false });
});

// EDIT-ATTACH (owner 11-03): a held message's edit takes files like a new message: their attachment
// lines join the replacement text, and chatEdit carries it to the same queue id.
it('EDIT-ATTACH: an edit saved with an attached file sends the file line in chatEdit', () => {
  agtyHandleMessage({
    type: 'chatTranscript',
    agentId: 1,
    items: [],
    canSend: true,
    queued: [{ id: '1-att.json', text: 'old words', at: T0 }],
  });
  const sent: Array<{ type: string; text?: string; id?: string }> = [];
  expect(messengerEditEnter((m) => sent.push(m), 1, 'alpha', 'q:1-att.json')).toBe(true);
  const text = composeAttachmentText('new words', [
    {
      id: 'c1',
      name: 'a.png',
      size: 2048,
      type: 'image/png',
      path: '/p/.agty-inbox/a.png',
      state: 'ready',
      progress: 100,
    },
  ] as AttachmentChip[]);
  expect(messengerEditSave((m) => sent.push(m), text!)).toBe(true);
  expect(sent.at(-1)).toMatchObject({
    type: 'chatEdit',
    id: '1-att.json',
    text: 'new words\n[\ucca8\ubd80] /p/.agty-inbox/a.png (image/png, 2 KB)',
  });
});

// MSG-HOLD2 (owner 10-24 17:15): a reload finds the hold; three explicit decisions; an edit that
// lost the race to delivery is offered as a correction and never shown as an edit.
it('MSG-HOLD2: a reloaded page shows the held message with its choices; leaving the screen decides nothing', () => {
  agtyHandleMessage({
    type: 'chatTranscript',
    agentId: 1,
    items: [],
    canSend: true,
    queued: [{ id: '1-h.json', text: 'original', at: T0, held: true }],
  });
  expect(snap().pending[1][0]).toMatchObject({ requestId: 'q:1-h.json', state: 'queued', held: true });
  const sent: unknown[] = [];
  expect(messengerEditEnter((m) => sent.push(m), 1, 'alpha', 'q:1-h.json')).toBe(true);
  messengerEditPark(); // the conversation closed mid-edit
  expect(snap().editing).toBeNull();
  expect(sent).toEqual([{ type: 'chatHold', name: 'alpha', id: '1-h.json', on: true }]); // no release
  expect(snap().pending[1][0]).toMatchObject({ held: true });
  // 원래대로 보내기 ("send approved") from this or any page.
  messengerApproveHeld((m) => sent.push(m), 1, 'alpha', 'q:1-h.json');
  expect(sent.at(-1)).toEqual({ type: 'chatHold', name: 'alpha', id: '1-h.json', on: false });
  expect(snap().pending[1][0]).toMatchObject({ held: false, holdNote: 'approved' });
  // The server's list says it is no longer held: the bubble follows.
  agtyHandleMessage({ type: 'chatTranscript', agentId: 1, items: [], canSend: true, append: true, queued: [{ id: '1-h.json', text: 'original', at: T0 }] });
  expect(snap().pending[1][0]).toMatchObject({ held: false });
});

it('MSG-HOLD2: cancelling the edit is its own state (the original goes as it was)', () => {
  agtyHandleMessage({ type: 'chatTranscript', agentId: 1, items: [], canSend: true, queued: [{ id: '1-c.json', text: 'keep me', at: T0 }] });
  const sent: unknown[] = [];
  messengerEditEnter((m) => sent.push(m), 1, 'alpha', 'q:1-c.json');
  expect(snap().pending[1][0]).toMatchObject({ held: true });
  messengerEditLeave((m) => sent.push(m));
  expect(sent.at(-1)).toEqual({ type: 'chatHold', name: 'alpha', id: '1-c.json', on: false });
  expect(snap().pending[1][0]).toMatchObject({ held: false, holdNote: 'editCancelled', text: 'keep me' });
});

it('MSG-HOLD2: an edit that lost the race to delivery becomes a correction offer; the bubble is never "edited"', () => {
  agtyHandleMessage({ type: 'chatTranscript', agentId: 1, items: [], canSend: true, queued: [{ id: '1-r.json', text: 'went in', at: T0 }] });
  const sent: Array<{ type: string; requestId?: string }> = [];
  messengerEditEnter((m) => sent.push(m), 1, 'alpha', 'q:1-r.json');
  // The server refuses: it went in meanwhile.
  expect(messengerEditSave((m) => sent.push(m), 'fixed words')).toBe(true);
  const edit = sent.find((m) => m.type === 'chatEdit')!;
  agtyHandleMessage({ type: 'chatPendingResult', requestId: edit.requestId!, name: 'alpha', id: '1-r.json', ok: false, error: 'already in', gone: true });
  expect(snap().editLost).toEqual({ agentId: 1, name: 'alpha', text: 'fixed words' });
  expect(snap().pending[1][0]).toMatchObject({ text: 'went in', editing: false });
  expect(snap().pending[1][0].edited).toBeFalsy();
  expect(snap().pending[1][0].refusal).toBeUndefined();

  // The bubble left the queue while the composer was open: the save makes the same offer, no chatEdit.
  messengerResetForTests();
  agtyHandleMessage({ type: 'chatTranscript', agentId: 1, items: [], canSend: true, queued: [{ id: '2-r.json', text: 'gone', at: T0 }] });
  const sent2: Array<{ type: string }> = [];
  messengerEditEnter((m) => sent2.push(m), 1, 'alpha', 'q:2-r.json');
  agtyHandleMessage({ type: 'chatTranscript', agentId: 1, items: [], canSend: true, append: true, queued: [] });
  expect(messengerEditSave((m) => sent2.push(m), 'too late')).toBe(true);
  expect(sent2.map((m) => m.type)).toEqual(['chatHold']);
  expect(snap().editLost).toEqual({ agentId: 1, name: 'alpha', text: 'too late' });
});

it("T-81: a send whose command opened a picker marks the conversation until the next send's answer", () => {
  const sent: Array<{ requestId: string }> = [];
  const answer = (i: number, extra: Record<string, unknown> = {}) =>
    agtyHandleMessage({ type: 'chatSendResult', requestId: sent[i].requestId, name: 'alpha', ok: true, delivered: 'pane', ...extra });
  messengerSend((m) => sent.push(m as ChatSend), true, 1, 'alpha', '/model');
  answer(0, { screen: 'picker' });
  expect(snap().picker[1]).toBe(true);
  messengerSend((m) => sent.push(m as ChatSend), true, 1, 'alpha', '/compact');
  answer(1);
  expect(snap().picker[1]).toBeUndefined();
});

it('T-141: a message queued behind the open picker (held there) leaves the notice: only one that went in ends it', () => {
  const sent: Array<{ requestId: string }> = [];
  messengerSend((m) => sent.push(m as ChatSend), true, 1, 'alpha', '/model');
  agtyHandleMessage({ type: 'chatSendResult', requestId: sent[0].requestId, name: 'alpha', ok: true, delivered: 'pane', screen: 'picker' });
  messengerSend((m) => sent.push(m as ChatSend), true, 1, 'alpha', 'hold on');
  agtyHandleMessage({ type: 'chatSendResult', requestId: sent[1].requestId, name: 'alpha', ok: true, delivered: 'queued', queueId: '9-q.json' });
  expect(snap().picker[1]).toBe(true);
  messengerSend((m) => sent.push(m as ChatSend), true, 1, 'alpha', 'again');
  agtyHandleMessage({ type: 'chatSendResult', requestId: sent[2].requestId, name: 'alpha', ok: false, error: 'busy' });
  expect(snap().picker[1]).toBe(true);
});

it('T-81: the picker notice goes once the daemon no longer holds the lead (the picker was closed at the terminal)', () => {
  const sent: Array<{ requestId: string }> = [];
  const contacts = (held: boolean) =>
    agtyHandleMessage({ type: 'messengerContacts', contacts: [{ agentId: 1, name: 'alpha', replies: [], ...(held && { held }) }] });
  messengerSend((m) => sent.push(m as ChatSend), true, 1, 'alpha', '/model');
  agtyHandleMessage({ type: 'chatSendResult', requestId: sent[0].requestId, name: 'alpha', ok: true, delivered: 'pane', screen: 'picker' });
  contacts(true);
  expect(snap().picker[1]).toBe(true);
  contacts(false);
  expect(snap().picker[1]).toBeUndefined();
});

describe('T-169: a delivered / command never stays sent', () => {
  const sendCmd = (text: string) => {
    const sent: Array<{ requestId: string }> = [];
    messengerSend((m) => sent.push(m as ChatSend), true, 1, 'alpha', text);
    return sent[0].requestId;
  };
  const result = (requestId: string, extra: Record<string, unknown>) =>
    agtyHandleMessage({ type: 'chatSendResult', requestId, name: 'alpha', ok: true, ...extra });
  const held = (on: boolean, picker = false) =>
    agtyHandleMessage({ type: 'messengerContacts', contacts: [{ agentId: 1, name: 'alpha', replies: [], ...(on && { held: true }), ...(picker && { picker }) }] });
  const texts = () => (snap().pending[1] ?? []).map((p) => p.text);
  const later = () => vi.advanceTimersByTime(MSG_COMMAND_SETTLE_MS + 1);

  it('a dialog closed with nothing logged (display "skip"): the bubble goes once the picker is gone', () => {
    vi.useFakeTimers();
    try {
      result(sendCmd('/tasks'), { delivered: 'pane', screen: 'picker' });
      held(true);
      later();
      expect(texts()).toEqual(['/tasks']); // its picker is still up
      held(false);
      later();
      expect(texts()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a command queued behind a busy turn waits while queued, then goes after the picker the tick opened closes', () => {
    vi.useFakeTimers();
    try {
      result(sendCmd('/tasks'), { delivered: 'queued', queueId: '9-q.json' });
      const transcript = (queued: Array<{ id: string; text: string; at: number }>) =>
        agtyHandleMessage({ type: 'chatTranscript', agentId: 1, items: [], canSend: true, append: true, queued });
      transcript([{ id: '9-q.json', text: '/tasks', at: T0 }]);
      later();
      expect(texts()).toEqual(['/tasks']); // not delivered yet: as today
      transcript([]); // the tick typed it...
      held(true, true); // ...and it opened a picker
      later();
      expect(texts()).toEqual(['/tasks']);
      held(false);
      later();
      expect(texts()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a command with no picker goes after the grace; an ordinary message never does', () => {
    vi.useFakeTimers();
    try {
      result(sendCmd('hello'), { delivered: 'pane' });
      result(sendCmd('/compact'), { delivered: 'pane' });
      later();
      expect(texts()).toEqual(['hello']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a command the CLI logged shows once, whether its line comes before or after the grace', () => {
    vi.useFakeTimers();
    try {
      const line = (id: string): ChatItem => ({ id, kind: 'user', text: '/model', at: Date.now() });
      result(sendCmd('/model'), { delivered: 'pane', screen: 'picker' });
      held(false);
      agtyHandleMessage({ type: 'chatTranscript', agentId: 1, items: [line('a')], canSend: true, append: true });
      later();
      result(sendCmd('/model'), { delivered: 'pane' });
      later();
      agtyHandleMessage({ type: 'chatTranscript', agentId: 1, items: [line('b')], canSend: true, append: true });
      expect(texts()).toEqual([]);
      expect(snap().items[1].map((i) => i.text)).toEqual(['/model', '/model']);
      expect(snap().received[1]).toEqual(['a']);
    } finally {
      vi.useRealTimers();
    }
  });
});

it('T-141: a contact the daemon says is on a picker (a command it typed from the queue) shows the picker notice without any send result', () => {
  const contacts = (picker: boolean) =>
    agtyHandleMessage({ type: 'messengerContacts', contacts: [{ agentId: 1, name: 'alpha', replies: [], held: true, ...(picker && { picker }) }] });
  contacts(false);
  expect(snap().picker[1]).toBeUndefined();
  contacts(true);
  expect(snap().picker[1]).toBe(true);
});

it("a list that names this device's own send before its result: one bubble, not two", () => {
  const sent: Array<{ requestId: string }> = [];
  messengerSend((m) => sent.push(m as ChatSend), true, 1, 'alpha', '\ud558\ub098');
  agtyHandleMessage({
    type: 'chatTranscript',
    agentId: 1,
    items: [],
    canSend: true,
    queued: [{ id: '9-z.json', text: '\ud558\ub098', at: T0 }],
  });
  expect(snap().pending[1]).toHaveLength(2);
  agtyHandleMessage({
    type: 'chatSendResult',
    requestId: sent[0].requestId,
    name: 'alpha',
    ok: true,
    delivered: 'queued',
    queueId: '9-z.json',
  });
  expect(snap().pending[1]).toMatchObject([
    { requestId: sent[0].requestId, state: 'queued', queueId: '9-z.json' },
  ]);
});

it('offline sends fail at once; a lost connection fails the ones on their way', () => {
  const sent: unknown[] = [];
  messengerSend((m) => sent.push(m), false, 1, 'alpha', 'offline');
  expect(sent).toEqual([]);
  expect(snap().pending[1][0]).toMatchObject({
    state: 'failed',
    error: '\uc5f0\uacb0\uc774 \ub04a\uaca8 \ubcf4\ub0b4\uc9c0 \uc54a\uc558\uc5b4\uc694',
  });
  messengerSend((m) => sent.push(m), true, 1, 'alpha', 'lost');
  agtyConnectionLost();
  expect(snap().pending[1][1]).toMatchObject({ state: 'failed' });
  agtyHandleMessage({
    type: 'chatSendResult',
    requestId: 'nobody',
    name: 'alpha',
    ok: false,
    error: 'x',
  });
  expect(snap().pending[1]).toHaveLength(2);
});

it('drafts: per provider and lead, kept 24 h after the last edit, cleared by sending', () => {
  const t = 1_000_000_000_000;
  const office = draftKey('claude', 'alpha');
  const engine = draftKey('engine', 'alpha');
  saveDraft(office, '\ubc30\ud3ec \uc804\uc5d0', t);
  saveDraft(engine, '\ub2e4\ub978 alpha', t);
  expect(hasMessengerDraft(t + 1000)).toBe(true);
  expect(loadDraft(office, t + 1000)).toBe('\ubc30\ud3ec \uc804\uc5d0');
  expect(loadDraft(engine, t + 1000)).toBe('\ub2e4\ub978 alpha');
  saveDraft(office, '\ubc30\ud3ec \uc804\uc5d0 \ud14c\uc2a4\ud2b8', t + DRAFT_TTL_MS - 10); // an edit restarts the clock
  expect(loadDraft(office, t + DRAFT_TTL_MS + 1000)).toBe(
    '\ubc30\ud3ec \uc804\uc5d0 \ud14c\uc2a4\ud2b8',
  );
  expect(loadDraft(engine, t + DRAFT_TTL_MS)).toBe(''); // expired
  saveDraft(office, '', t + DRAFT_TTL_MS + 2000); // sent: cleared
  expect(loadDraft(office, t + DRAFT_TTL_MS + 3000)).toBe('');
  expect(hasMessengerDraft(t + DRAFT_TTL_MS + 3000)).toBe(false);
  expect(JSON.parse(stored.get('agty.messenger.drafts')!)).toEqual({}); // the expired one is gone too
});

it('MSG-ACTIONS: a reply is kept with the draft, survives a cleared text, and goes when cleared', () => {
  const t = 1_000_000_000_000;
  const key = draftKey('claude', 'alpha');
  const reply = { id: 'aaaa2222', sender: 'alpha', text: 'done' };
  saveDraft(key, 'again', t);
  saveDraftReply(key, reply, t);
  expect(loadDraftReply(key, t + 1)).toEqual(reply);
  saveDraft(key, 'again please', t + 2); // typing keeps the reply
  expect(loadDraftReply(key, t + 3)).toEqual(reply);
  saveDraft(key, '', t + 4); // the text emptied, the reply stays
  expect(loadDraftReply(key, t + 5)).toEqual(reply);
  expect(hasMessengerDraft(t + 5)).toBe(false); // a reply alone is no unsent text
  saveDraftReply(key, null, t + 6);
  expect(loadDraftReply(key, t + 7)).toBeNull();
  expect(JSON.parse(stored.get('agty.messenger.drafts')!)).toEqual({});
});

it('MSG-ACTIONS: a reply send carries replyTo on the wire and on its bubble', () => {
  const sent: unknown[] = [];
  const replyTo = { id: 'aaaa2222', text: 'mine' };
  messengerSend((m) => sent.push(m), true, 7, 'alpha', 'yes', false, replyTo);
  expect(sent).toEqual([expect.objectContaining({ type: 'chatSend', text: 'yes', replyTo })]);
  expect(snap().pending[7].at(-1)).toMatchObject({ text: 'yes', replyTo });
});

it('the state dot: tool activity > waiting > thinking (busy) > idle; off', () => {
  const on = (busy: boolean | null) => ({ state: 'running', busy });
  expect(leadState(on(true), 'working')).toBe('working');
  expect(leadState(on(true), 'attention')).toBe('waiting');
  expect(leadState(on(true), 'idle')).toBe('thinking');
  expect(leadState(on(true), null)).toBe('thinking');
  expect(leadState(on(false), 'idle')).toBe('resting');
  expect(leadState({ state: 'off', busy: null }, 'working')).toBe('off');
  expect(leadState(undefined, null)).toBe('off');
  // Held on its terminal (claude agents: blocked): waiting, whatever else it does.
  expect(leadState(on(false), 'idle', true)).toBe('waiting');
  expect(leadState({ state: 'off', busy: null }, null, true)).toBe('off');
});

it('C2: two identical sends settle by message id, each with its own prompt; no id falls back to the text', () => {
  const now = Date.now();
  const p = (requestId: string, messageId?: string) => ({
    requestId,
    text: 'the same words',
    state: 'sent' as const,
    sentAt: now,
    ...(messageId && { messageId }),
  });
  const prompt = (id: string, messageId?: string): ChatItem => ({
    kind: 'user',
    text: 'the same words',
    id,
    at: now,
    ...(messageId && { messageId }),
  });
  // The second message's prompt arrives first: it settles the second bubble, not the first.
  const one = settle([p('r1', 'aaaa2222'), p('r2', 'bbbb3333')], [prompt('i2', 'bbbb3333')], []);
  expect(one.pending.map((x) => x.requestId)).toEqual(['r1']);
  // A marked prompt never takes a bubble that knows another id.
  expect(settle([p('r1', 'aaaa2222')], [prompt('i3', 'cccc4444')], []).pending).toHaveLength(1);
  // A bubble still waiting for its id, and an unmarked prompt (a history before C2): by text.
  expect(settle([p('r1')], [prompt('i4', 'dddd5555')], []).pending).toEqual([]);
  expect(settle([p('r1', 'aaaa2222')], [prompt('i5')], []).pending).toEqual([]);
});

it('PRESENCE-SYNC: the messenger shows the card bar\'s presence: off duty grey, overtime with the real dot', () => {
  const staff = { away: { 1: { x: 0, y: 0 } }, overtime: [2] };
  const row = { state: 'running', busy: false };
  // Gone home: grey dot and the card's word, though the session rests (green).
  const home = leadPresence(presenceOf(staff, 1), leadState(row, 'idle'));
  expect(home).toEqual({ dot: 'off', word: presenceWord('away') });
  // Overtime: the card's word, the dot of what it really does.
  expect(leadPresence(presenceOf(staff, 2), leadState({ ...row, busy: true }, 'working'))).toEqual({
    dot: 'working',
    word: presenceWord('overtime'),
  });
  // Neither: today's state.
  expect(leadPresence(presenceOf(staff, 3), leadState(row, 'idle'))).toEqual({
    dot: 'resting',
    word: t('messenger.state.resting'),
  });
});

describe('GAME-UI-1 G1: quest records and the delivered badge', () => {
  beforeEach(() => messengerResetForTests());
  const card = { toolId: 'toolu_1', tool: 'Bash command', detail: 'Clean the marks\nrm -f $M/*' };
  it('stamps (records) only an answer the daemon confirms, then folds it', () => {
    const sent: Array<{ requestId: string; toolId: string; allow: boolean }> = [];
    messengerAnswerPermission((m) => sent.push(m), 7, card, true);
    expect(sent[0]).toMatchObject({ toolId: 'toolu_1', allow: true });
    expect(snap().permissionAnswers[7]).toMatchObject({ card, allow: true });
    agtyHandleMessage({ type: 'permissionAnswerResult', requestId: sent[0].requestId, agentId: 7, ok: true, result: 'answered' });
    expect(snap().questRecords[7]).toMatchObject([{ toolId: 'toolu_1', allow: true, label: questLabel(card) }]);
    expect(questLabel(card)).toBe('Bash command · Clean the marks');
    foldQuest(7, 'toolu_1');
    expect(snap().permissionAnswers[7].folded).toBe(true);
    // A result that did nothing (no dialog on screen) gets no stamp and no record.
    messengerAnswerPermission((m) => sent.push(m), 8, { ...card, toolId: 'toolu_2' }, false);
    agtyHandleMessage({ type: 'permissionAnswerResult', requestId: sent[1].requestId, agentId: 8, ok: true, result: 'noDialog' });
    expect(snap().questRecords[8]).toBeUndefined();
  });
  it('ACP-1: "always allow" refused for a step-up proves the device and goes once more, the same option', async () => {
    const sent: Array<{ requestId: string; toolId: string; allow: boolean; optionId?: string }> = [];
    const acp = { toolId: 'acp:b00700000000:1', tool: 'Bash', options: [{ optionId: 'ok-always', name: 'Always', kind: 'allow_always' as const }] };
    stepUp.asked = 0;
    stepUp.ok = true;
    messengerAnswerPermission((m) => sent.push(m), 9, acp, true, 'ok-always');
    agtyHandleMessage({ type: 'permissionAnswerResult', requestId: sent[0].requestId, agentId: 9, ok: false, error: 'stepup' });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(stepUp.asked).toBe(1);
    expect(sent[1]).toMatchObject({ toolId: acp.toolId, allow: true, optionId: 'ok-always' });
    expect(sent[1].requestId).not.toBe(sent[0].requestId);
    // Refused again: no third try, the refusal shows.
    agtyHandleMessage({ type: 'permissionAnswerResult', requestId: sent[1].requestId, agentId: 9, ok: false, error: 'stepup' });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toHaveLength(2);
    expect(snap().permissionAnswers[9].error).toBeTruthy();
    // The step-up not proved: nothing goes again.
    stepUp.ok = false;
    messengerAnswerPermission((m) => sent.push(m), 10, acp, true, 'ok-always');
    agtyHandleMessage({ type: 'permissionAnswerResult', requestId: sent[2].requestId, agentId: 10, ok: false, error: 'stepup' });
    await vi.waitFor(() => expect(snap().permissionAnswers[10].error).toBeTruthy());
    expect(sent).toHaveLength(3);
  });
  it('notes when a send is delivered (sent), not when it is queued', () => {
    const sent: Array<{ requestId: string }> = [];
    messengerSend((m) => sent.push(m as ChatSend), true, 1, 'alpha', 'a');
    messengerSend((m) => sent.push(m as ChatSend), true, 2, 'beta', 'b');
    const contacts = [
      { agentId: 1, name: 'alpha', replies: [] },
      { agentId: 2, name: 'beta', replies: [] },
    ];
    agtyHandleMessage({ type: 'messengerContacts', contacts });
    agtyHandleMessage({ type: 'chatSendResult', requestId: sent[0].requestId, name: 'alpha', ok: true, delivered: 'queued' });
    agtyHandleMessage({ type: 'chatSendResult', requestId: sent[1].requestId, name: 'beta', ok: true });
    expect(snap().delivered[1]).toBeUndefined();
    expect(snap().delivered[2]).toBeGreaterThan(0);
  });
});

describe('the list\'s overall text search', () => {
  beforeEach(() => messengerResetForTests());
  const answer = (requestId: string) =>
    agtyHandleMessage({ type: 'chatSearchAllResult', requestId, groups: [{ agentId: 1, hits: [], more: false }], truncated: true });

  it('takes the answer of the request in flight only; a newer one or a cleared field drops the older', () => {
    requestSearchAll('s1');
    requestSearchAll('s2');
    answer('s1');
    expect(snap().searchAll).toMatchObject({ requestId: 's2', busy: true });
    answer('s2');
    expect(snap().searchAll).toMatchObject({ requestId: 's2', busy: false, result: { truncated: true } });
    clearSearchAll();
    answer('s2');
    expect(snap().searchAll).toBeNull();
  });

  it('a hit opens its conversation at the message with the words, a room at its post', () => {
    openMessenger(5, { at: 10, id: 'x', query: 'deploy' });
    expect(snap().pendingJump).toEqual({ agentId: 5, at: 10, id: 'x', query: 'deploy' });
    openRoomAt('r1', 'p1');
    expect(snap().activeRoom).toBe('r1');
    expect(snap().pendingRoomJump).toEqual({ roomId: 'r1', id: 'p1' });
  });
});

describe('T-128: messenger state across a lost socket, a jump and a first reply', () => {
  it('B6.1: an edit or cancel whose answer the lost socket took gets its buttons back', () => {
    const queued = (held: boolean) => [
      { id: '1-e.json', text: 'orig', at: T0, held },
      { id: '1-c.json', text: 'drop me', at: T0 },
    ];
    agtyHandleMessage({ type: 'chatTranscript', agentId: 1, items: [], canSend: true, queued: queued(false) });
    const sent: unknown[] = [];
    expect(messengerEditEnter((m) => sent.push(m), 1, 'alpha', 'q:1-e.json')).toBe(true);
    expect(messengerEditSave((m) => sent.push(m), 'orig v2')).toBe(true);
    messengerCancel((m) => sent.push(m), 1, 'alpha', 'q:1-c.json');
    agtyConnectionLost();
    // The new socket's full transcript still lists the edit's message as held.
    agtyHandleMessage({ type: 'chatTranscript', agentId: 1, items: [], canSend: true, queued: queued(true) });
    const [edited, cancelled] = snap().pending[1];
    expect(edited).toMatchObject({ held: true, state: 'queued', text: 'orig' });
    expect(edited.editing).toBeFalsy();
    // The queue still shows the old words: the edit is known not to have landed.
    expect(edited.refusal).toBe(t('messenger.error.editNotSaved'));
    expect(cancelled.cancelling).toBeFalsy();
    expect(cancelled.refusal).toBe(t('messenger.error.disconnectedResult'));
    expect(messengerEditEnter((m) => sent.push(m), 1, 'alpha', 'q:1-e.json')).toBe(true);
  });

  it('B6.1: an edit whose queue shows words that are neither the old nor the edited ones stays unknown', () => {
    // The daemon keeps the original's attachment lines and trims the body, so the saved text can
    // differ from what the boss typed: "not saved" would be wrong there.
    const queued = [{ id: '1-e.json', text: 'orig\n[a] a.png', at: T0, held: true }];
    agtyHandleMessage({ type: 'chatTranscript', agentId: 1, items: [], canSend: true, queued });
    expect(messengerEditEnter(() => undefined, 1, 'alpha', 'q:1-e.json')).toBe(true);
    expect(messengerEditSave(() => undefined, 'orig v2')).toBe(true);
    agtyConnectionLost();
    agtyHandleMessage({
      type: 'chatTranscript',
      agentId: 1,
      items: [],
      canSend: true,
      queued: [{ id: '1-e.json', text: 'orig v2\n[a] a.png', at: T0, held: true, edited: true }],
    });
    const [edited] = snap().pending[1];
    expect(edited).toMatchObject({ text: 'orig v2\n[a] a.png', edited: true });
    expect(edited.refusal).toBe(t('messenger.error.disconnectedResult'));
  });

  it('B6.1: an edit whose answer the lost socket took starts again from the edited words', () => {
    const queued = [{ id: '1-e.json', text: 'orig', at: T0, held: true }];
    agtyHandleMessage({ type: 'chatTranscript', agentId: 1, items: [], canSend: true, queued });
    expect(messengerEditEnter(() => undefined, 1, 'alpha', 'q:1-e.json')).toBe(true);
    expect(messengerEditSave(() => undefined, 'orig v2')).toBe(true);
    agtyConnectionLost();
    agtyHandleMessage({ type: 'chatTranscript', agentId: 1, items: [], canSend: true, queued });
    expect(messengerEditEnter(() => undefined, 1, 'alpha', 'q:1-e.json')).toBe(true);
    expect(snap().editing?.text).toBe('orig v2');
  });

  it('B6.1: the lost-answer note goes when the queue shows the edit or the cancel landed', () => {
    const queued = [
      { id: '1-e.json', text: 'orig', at: T0, held: true },
      { id: '1-c.json', text: 'drop me', at: T0 },
    ];
    agtyHandleMessage({ type: 'chatTranscript', agentId: 1, items: [], canSend: true, queued });
    expect(messengerEditEnter(() => undefined, 1, 'alpha', 'q:1-e.json')).toBe(true);
    expect(messengerEditSave(() => undefined, 'orig v2')).toBe(true);
    messengerCancel(() => undefined, 1, 'alpha', 'q:1-c.json');
    agtyConnectionLost();
    agtyHandleMessage({
      type: 'chatTranscript',
      agentId: 1,
      items: [],
      canSend: true,
      queued: [
        { id: '1-e.json', text: 'orig v2', at: T0, edited: true },
        { id: '1-c.json', text: 'drop me', at: T0, cancelled: true },
      ],
    });
    const [edited, cancelled] = snap().pending[1];
    expect(edited).toMatchObject({ text: 'orig v2', edited: true });
    expect(edited.refusal).toBeUndefined();
    expect(edited.editText).toBeUndefined();
    expect(cancelled).toMatchObject({ state: 'cancelled' });
    expect(cancelled.refusal).toBeUndefined();
  });

  it('B6.2: a send whose result the lost socket took settles when the transcript or the queue shows it', () => {
    messengerSend(() => undefined, true, 1, 'alpha', 'deploy now');
    agtyConnectionLost();
    expect(snap().pending[1]).toMatchObject([{ state: 'failed' }]);
    // It went in: the prompt settles the bubble.
    agtyHandleMessage({ type: 'chatTranscript', agentId: 1, items: [item('user', 'deploy now', 3700)], canSend: true });
    expect(snap().pending[1]).toEqual([]);
    // It was queued: the queue's own bubble takes its place, never a second one.
    messengerSend(() => undefined, true, 1, 'alpha', 'later');
    agtyConnectionLost();
    agtyHandleMessage({
      type: 'chatTranscript',
      agentId: 1,
      items: [],
      canSend: true,
      queued: [{ id: '9-q.json', text: 'later', at: T0 }],
    });
    expect(snap().pending[1]).toMatchObject([{ requestId: 'q:9-q.json', state: 'queued' }]);
    // Two lost sends of the same words and one queue entry: one stays failed (it may never have left).
    messengerSend(() => undefined, true, 1, 'alpha', 'same');
    messengerSend(() => undefined, true, 1, 'alpha', 'same');
    agtyConnectionLost();
    agtyHandleMessage({
      type: 'chatTranscript',
      agentId: 1,
      items: [],
      canSend: true,
      queued: [
        { id: '9-q.json', text: 'later', at: T0 },
        { id: '10-q.json', text: 'same', at: T0 },
      ],
    });
    expect(snap().pending[1].map((p) => [p.text, p.state])).toEqual([
      ['later', 'queued'],
      ['same', 'failed'],
      ['same', 'queued'],
    ]);
    dismissSend(1, snap().pending[1][1].requestId);
    // A send refused before it left (offline) is a real failure and stays.
    messengerSend(() => undefined, false, 1, 'alpha', 'offline');
    agtyHandleMessage({ type: 'chatTranscript', agentId: 1, items: [item('user', 'offline', 3701)], canSend: true });
    expect(snap().pending[1].map((p) => [p.text, p.state])).toEqual([
      ['later', 'queued'],
      ['same', 'queued'],
      ['offline', 'failed'],
    ]);
  });

  const tail = Array.from({ length: MAX_ITEMS }, (_, i) => item('assistant', `t${i}`, 100 + i));
  /** A quote jump far back: the list holds an older window, not the tail. */
  const jumpBack = () => {
    agtyHandleMessage({ type: 'chatTranscript', agentId: 1, items: tail, canSend: true });
    setJumpLoading(1, true);
    requestHistory(1, 'old');
    const older = Array.from({ length: 50 }, (_, i) => item('user', `o${i}`, i));
    agtyHandleMessage({ type: 'chatHistoryResult', agentId: 1, requestId: 'old', items: older, done: false });
    expect(snap().historyWindowed[1]).toBe(true);
  };

  it('B6.4: a send from an older window asks for the tail, so its echo and the reply show', () => {
    jumpBack();
    const sent: unknown[] = [];
    messengerSend((m) => sent.push(m), true, 1, 'alpha', 'about that quote');
    expect(sent).toContainEqual({ type: 'chatView', agentId: 1, on: true });
    const echo = [item('user', 'about that quote', 99_998), item('assistant', 'on it', 99_999)];
    agtyHandleMessage({ type: 'chatTranscript', agentId: 1, items: echo, canSend: true, append: true });
    // The chatView answer: the full transcript, echo and reply included.
    agtyHandleMessage({ type: 'chatTranscript', agentId: 1, items: [...tail, ...echo], canSend: true });
    expect(snap().items[1].slice(-2).map((i) => i.text)).toEqual(['about that quote', 'on it']);
    expect(snap().historyWindowed[1]).toBe(false);
  });

  it('B6.4: a send after the older window was closed asks for no tail nobody holds', () => {
    jumpBack();
    agtyHandleMessage({
      type: 'chatTranscript',
      agentId: 1,
      items: [item('assistant', 'live', 99_999)],
      canSend: true,
      append: true,
    });
    chatViewClosed(1);
    expect(snap().historyWindowed[1]).toBe(false);
    expect(snap().windowedNew[1]).toEqual([]);
    const sent: { type: string }[] = [];
    messengerSend((m) => sent.push(m), true, 1, 'alpha', 'from the board');
    expect(sent.map((m) => m.type)).toEqual(['chatSend']);
  });

  it('B6.4: a jump page still on its way when the conversation closes is ignored, so no window outlives the view', () => {
    agtyHandleMessage({ type: 'chatTranscript', agentId: 1, items: tail, canSend: true });
    setJumpLoading(1, true);
    requestHistory(1, 'old');
    chatViewClosed(1);
    const older = Array.from({ length: 50 }, (_, i) => item('user', `o${i}`, i));
    agtyHandleMessage({ type: 'chatHistoryResult', agentId: 1, requestId: 'old', items: older, done: false });
    expect(snap().historyWindowed[1]).toBeFalsy();
    expect(snap().items[1]).toHaveLength(MAX_ITEMS);
    const sent: { type: string }[] = [];
    messengerSend((m) => sent.push(m), true, 1, 'alpha', 'from the board');
    expect(sent.map((m) => m.type)).toEqual(['chatSend']);
  });

  it('B6.4: a live append leaves a jumped-to older window as it is', () => {
    jumpBack();
    const window = snap().items[1];
    agtyHandleMessage({
      type: 'chatTranscript',
      agentId: 1,
      items: [item('assistant', 'live', 99_999)],
      canSend: true,
      append: true,
    });
    expect(snap().items[1]).toBe(window);
    expect(snap().historyWindowed[1]).toBe(true);
    // Not shown, but counted for the jump button (the same reply appended twice counts once).
    agtyHandleMessage({
      type: 'chatTranscript',
      agentId: 1,
      items: [item('user', 'boss', 99_998), item('assistant', 'live', 99_999)],
      canSend: true,
      append: true,
    });
    expect(snap().windowedNew[1]).toEqual([item('assistant', 'live', 99_999).id]);
    // The full transcript (the jump to the bottom) brings the tail back.
    agtyHandleMessage({ type: 'chatTranscript', agentId: 1, items: [...tail, item('assistant', 'live', 99_999)], canSend: true });
    expect(snap().items[1].at(-1)?.text).toBe('live');
    expect(snap().historyWindowed[1]).toBe(false);
    expect(snap().windowedNew[1]).toEqual([]);
  });

  it('B6.5: a lead first seen with a read transcript and no reply counts its first reply as unread', () => {
    const heard: string[] = [];
    const off = onLeadReply((r) => heard.push(r.name));
    contacts([{ agentId: 1, name: 'alpha', replies: [], lastAt: T0 }]);
    contacts([{ agentId: 1, name: 'alpha', replies: [rid(1)], lastAt: T0 + 1000 }]);
    expect(unreadCount(snap().contacts[0].replies, snap().read.alpha)).toBe(1);
    expect(heard).toEqual(['alpha']);
    off();
    // Its transcript not read yet (no lastAt): no mark, so a new device never counts old replies.
    contacts([{ agentId: 2, name: 'beta', replies: [] }]);
    expect(snap().read.beta).toBeUndefined();
  });
});
