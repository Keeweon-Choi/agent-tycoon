import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessengerContact } from '../../../../core/src/messages.js';
import { agtyHandleMessage } from '../officeStore.js';
import {
  closeMessengerPane,
  focusMessengerPane,
  messengerGetSnapshot as snap,
  messengerResetForTests,
  messengerShowing,
  openMessenger,
  setMessengerLayout,
  setMessengerWide,
  showMessengerList,
  unreadCount,
} from './messengerStore.js';
import {
  closePane,
  emptyPanes,
  keepOpen,
  type PaneState,
  paneTarget,
  parsePanes,
  placeInPane,
  setPaneLayout,
} from './panes.js';

const panes = (keys: (string | null)[], focus = 0, layout: PaneState['layout'] = 2): PaneState => ({
  layout,
  panes: [...keys, null, null, null, null].slice(0, 4),
  focus,
});

describe('pane rules', () => {
  it('a conversation goes to the focused pane', () => {
    expect(placeInPane(panes([null, 'b'], 0), 'a', 2).panes).toEqual(['a', 'b', null, null]);
  });
  it('one already in another pane on screen takes the focus, never shown twice', () => {
    const s = panes(['a', 'b'], 0);
    expect(placeInPane(s, 'b', 2)).toEqual({ ...s, focus: 1 });
  });
  it('a copy in a pane off screen is cleared, not focused', () => {
    expect(placeInPane(panes(['a', 'b'], 0), 'b', 1).panes).toEqual(['b', null, null, null]);
  });
  it('unchanged placement keeps the same object; null empties the focused pane', () => {
    const s = panes(['a', 'b'], 1);
    expect(placeInPane(s, 'b', 2)).toBe(s);
    expect(placeInPane(s, null, 2).panes).toEqual(['a', null, null, null]);
  });
  it('close empties one pane and keeps the focus', () => {
    expect(closePane(panes(['a', 'b'], 1), 0)).toEqual(panes([null, 'b'], 1));
  });
  it('layout switch keeps the focused conversation on screen', () => {
    expect(setPaneLayout(panes(['a', 'b', 'c', 'd'], 3, 4), 2)).toEqual(
      panes(['a', 'd', 'c', 'b'], 1, 2),
    );
    expect(setPaneLayout(panes(['a', 'b'], 1), 4)).toEqual(panes(['a', 'b'], 1, 4));
    expect(setPaneLayout(panes(['a', 'b', 'c'], 2, 4), 1)).toEqual(panes(['a', 'b', 'c'], 2, 1));
  });
  it('pane keys resolve to listed leads and rooms only', () => {
    const contacts = [{ name: 'shop', agentId: 7 }];
    const rooms = [{ id: 'r1' }];
    expect(paneTarget('shop', contacts, rooms)).toEqual({ agentId: 7 });
    expect(paneTarget('room:r1', contacts, rooms)).toEqual({ room: 'r1' });
    expect(paneTarget('room:gone', contacts, rooms)).toBeNull();
    expect(paneTarget('gone', contacts, rooms)).toBeNull();
    expect(paneTarget(null, contacts, rooms)).toBeNull();
  });
  it('panes on screen stay open; the oldest others give way', () => {
    const open = [1, 2, 3, 4];
    expect(keepOpen(open, [1, 3], 4)).toBe(open);
    expect(keepOpen([2, 3, 4, 5], [1, 5], 4)).toEqual([3, 4, 5, 1]);
  });
  it('restores from storage, each part checked', () => {
    expect(parsePanes(JSON.stringify(panes(['a', 'b'], 1, 4)))).toEqual(panes(['a', 'b'], 1, 4));
    expect(parsePanes(null)).toEqual(emptyPanes());
    expect(parsePanes('{not json')).toEqual(emptyPanes());
    expect(parsePanes('"x"')).toEqual(emptyPanes());
    expect(parsePanes(JSON.stringify({ layout: 3, panes: ['a', 'a', 5, ''], focus: 9 }))).toEqual(
      panes(['a', null, null, null], 0, 1),
    );
  });
});

const T0 = Math.floor(Date.now() / 1000) * 1000 - 3_600_000;
const rid = (s: number) => `${T0 + s * 1000}-r${s}-0`;
const contact = (name: string, agentId: number, replies: number[]): MessengerContact => ({
  agentId,
  name,
  replies: replies.map(rid),
  lastAt: 0,
});
const contacts = (list: MessengerContact[]) =>
  agtyHandleMessage({ type: 'messengerContacts', contacts: list });

let stored: Map<string, string>;
beforeEach(() => {
  stored = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => stored.set(k, v),
  });
  messengerResetForTests();
});

describe('panes in the messenger store', () => {
  it('picking fills the focused pane, a pane click moves the focus, a picked one in a pane is focused', () => {
    contacts([contact('a', 1, [1]), contact('b', 2, [1]), contact('c', 3, [1])]);
    setMessengerWide(true);
    setMessengerLayout(2);
    openMessenger(1);
    focusMessengerPane(1);
    expect(snap().active).toBeNull();
    openMessenger(2);
    expect(snap().split.panes.slice(0, 2)).toEqual(['a', 'b']);
    openMessenger(1);
    expect(snap().split.focus).toBe(0);
    expect(snap().split.panes.slice(0, 2)).toEqual(['a', 'b']);
    expect(snap().open).toEqual([1, 2]);
    expect(JSON.parse(stored.get('agty.messenger.panes')!)).toMatchObject({ layout: 2, focus: 0 });
  });

  it('every pane on screen counts as read; layout 1 only the focused one', () => {
    contacts([contact('a', 1, [1]), contact('b', 2, [1])]);
    setMessengerWide(true);
    setMessengerLayout(2);
    openMessenger(1);
    focusMessengerPane(1);
    openMessenger(2);
    focusMessengerPane(0);
    contacts([contact('a', 1, [1, 2]), contact('b', 2, [1, 2])]);
    const m = snap();
    expect(unreadCount(m.contacts[1].replies, m.read.b)).toBe(0);
    expect(messengerShowing(2)).toBe(true);
    setMessengerLayout(1);
    contacts([contact('a', 1, [1, 2]), contact('b', 2, [1, 2, 3])]);
    expect(unreadCount(snap().contacts[1].replies, snap().read.b)).toBe(1);
    expect(messengerShowing(2)).toBe(false);
  });

  it('closing the focused pane empties it and closes its conversation', () => {
    contacts([contact('a', 1, [1])]);
    setMessengerWide(true);
    setMessengerLayout(2);
    openMessenger(1);
    closeMessengerPane(0);
    expect(snap()).toMatchObject({ active: null, open: [] });
    expect(snap().split.panes[0]).toBeNull();
  });

  it('after a reload the wide messenger brings the focused pane back, the phone shows its list', () => {
    stored.set('agty.messenger.panes', JSON.stringify(panes(['a', 'b'], 1, 2)));
    messengerResetForTests();
    contacts([contact('a', 1, [1]), contact('b', 2, [1])]);
    expect(snap().active).toBeNull(); // not wide (phone, narrow): nothing comes back
    setMessengerWide(true);
    expect(snap().active).toBe(2);
    expect([...snap().open].sort()).toEqual([1, 2]);
    showMessengerList();
    expect(snap().split.panes[1]).toBeNull();
  });

  it('bad storage falls back to one empty pane', () => {
    stored.set('agty.messenger.panes', '{oops');
    messengerResetForTests();
    expect(snap().split).toEqual(emptyPanes());
  });
});
