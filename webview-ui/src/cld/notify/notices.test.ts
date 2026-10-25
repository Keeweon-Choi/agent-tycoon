import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NOTICE_COOLDOWN_MS } from '../../../../core/src/constants.js';
import type { OfficeEvent, OfficeSnapshot } from '../../../../core/src/messages.js';
import { NOTICE_PAIR_MS, NOTICE_PULSE_MS } from '../../constants.js';
import { t } from '../../i18n/index.js';
import type { OfficeState } from '../../office/engine/officeState.js';
import { hudGetSnapshot } from '../hud/hudStore.js';
import {
  closeMessenger,
  messengerGetSnapshot,
  messengerResetForTests,
  openMessenger,
  showMessengerList,
  showRoom,
} from '../messenger/messengerStore.js';
import { cldHandleMessage, cldResetForTests } from '../officeStore.js';
import { NO_PROJECT } from '../workbench/workbenchState.js';
import { workbenchGetSnapshot } from '../workbench/workbenchStore.js';
import { mergeNews } from './newsList.js';
import {
  bindNoticeOffice,
  cldNotice,
  cldNoticeEvent,
  cldNoticeReplay,
  cldReplyNotice,
  clearAll,
  DEFAULT_SETTINGS,
  markAllRead,
  markRead,
  noticeGoesTo,
  noticePulse,
  noticeSnapshot,
  noticesResetForTests,
  noticeVerdict,
  setNoticeSettings,
  unreadCount,
} from './notices.js';
import { openTarget } from './openTarget.js';

const T0 = 1_800_000_000_000;
const ev = (over: Partial<Parameters<typeof noticeVerdict>[0]> = {}) => ({
  cause: 'turnEnd' as const,
  target: '7',
  who: 'orchestrator' as const,
  at: T0,
  ...over,
});

describe('notice rules (T-0039, FR-NTF-003/005)', () => {
  it('cooldown: the same kind for the same character at most once per 5 minutes', () => {
    const last = new Map<string, number>();
    expect(noticeVerdict(ev(), DEFAULT_SETTINGS, last, false)).toBe('loud');
    expect(noticeVerdict(ev({ at: T0 + 60_000 }), DEFAULT_SETTINGS, last, false)).toBe('cooldown');
    // Another kind, another character: their own clocks.
    expect(noticeVerdict(ev({ cause: 'permission' }), DEFAULT_SETTINGS, last, false)).toBe('loud');
    expect(noticeVerdict(ev({ target: '8' }), DEFAULT_SETTINGS, last, false)).toBe('loud');
    // A question and a permission ask are one kind (attention).
    expect(noticeVerdict(ev({ cause: 'question' }), DEFAULT_SETTINGS, last, false)).toBe(
      'cooldown',
    );
    expect(noticeVerdict(ev({ at: T0 + NOTICE_COOLDOWN_MS }), DEFAULT_SETTINGS, last, false)).toBe(
      'loud',
    );
  });

  it('each kind can be turned off', () => {
    const off = { ...DEFAULT_SETTINGS, kinds: { turnEnd: false, attention: true, job: false } };
    const last = new Map<string, number>();
    expect(noticeVerdict(ev(), off, last, false)).toBe('off');
    expect(noticeVerdict(ev({ cause: 'job' }), off, last, false)).toBe('off');
    expect(noticeVerdict(ev({ cause: 'permission' }), off, last, false)).toBe('loud');
    expect(last.size).toBe(1); // what was off does not start a cooldown
  });

  it('nothing loud for the character you are looking at', () => {
    const last = new Map<string, number>();
    expect(noticeVerdict(ev(), DEFAULT_SETTINGS, last, true)).toBe('quiet');
    // You saw it: the cooldown runs from there.
    expect(noticeVerdict(ev({ at: T0 + 1_000 }), DEFAULT_SETTINGS, last, false)).toBe('cooldown');
  });

  it('turn ends come from orchestrators only, unless sub-agents are asked for', () => {
    const last = new Map<string, number>();
    for (const who of ['subagent', 'teammate'] as const) {
      expect(noticeVerdict(ev({ who, target: who }), DEFAULT_SETTINGS, last, false)).toBe('off');
      // Their permission asks still count.
      expect(
        noticeVerdict(ev({ who, target: who, cause: 'permission' }), DEFAULT_SETTINGS, last, false),
      ).toBe('loud');
    }
    const withSubs = { ...DEFAULT_SETTINGS, subagents: true };
    expect(noticeVerdict(ev({ who: 'teammate', target: 'x' }), withSubs, last, false)).toBe('loud');
    expect(noticeVerdict(ev({ who: 'visitor', target: 'v' }), DEFAULT_SETTINGS, last, false)).toBe(
      'loud',
    );
  });
});

/** A office with `veteran` (agent 7) and the office's characters. */
function setup(selected: number | null = null) {
  noticesResetForTests();
  cldResetForTests();
  cldHandleMessage({
    type: 'officeSnapshot',
    capabilities: ['ls'],
    orchestrators: [{ name: 'veteran', agentId: 7 }],
    tabs: [],
  } as unknown as OfficeSnapshot);
  const characters = new Map<number, Record<string, unknown>>([
    [7, { id: 7 }],
    [8, { id: 8 }],
    [9, { id: 9, leadAgentId: 7, agentName: 'scout' }],
  ]);
  bindNoticeOffice(() => ({ characters, selectedAgentId: selected }) as unknown as OfficeState);
}

describe('notices in the office', () => {
  beforeEach(() => setup());

  it('a turn end: a toast naming the character, a pulse, an unread line', () => {
    expect(cldNotice(7, 'turnEnd', T0)).toBe(true);
    const { toast, items } = noticeSnapshot();
    expect(toast).toMatchObject({
      name: 'veteran',
      text: 'Finished its work',
      cause: 'turnEnd',
    });
    expect(unreadCount(items)).toBe(1);
    expect(noticePulse(7, T0 + 1_000)).toBe(1_000);
    expect(noticePulse(7, T0 + NOTICE_PULSE_MS)).toBeNull();
    // Within the cooldown: nothing new.
    cldNotice(7, 'turnEnd', T0 + 1_000);
    expect(noticeSnapshot().items).toHaveLength(1);
  });

  it('K1: an engine Worker\'s turn end makes no owner notice; its permission ask comes at once', () => {
    cldHandleMessage({
      type: 'engineState',
      projects: [{ name: 'veteran', role: 'worker', folder: '/w', room: 'r' }],
    } as never);
    try {
      cldNotice(7, 'turnEnd', T0);
      expect(noticeSnapshot().items).toHaveLength(0);
      cldNotice(7, 'permission', T0);
      expect(noticeSnapshot().toast).toMatchObject({ name: 'veteran', cause: 'permission' });
    } finally {
      cldHandleMessage({ type: 'engineState', projects: [] } as never);
    }
    // Negative control: the same character as a Lead (no role) still notifies its turn end.
    cldNotice(7, 'turnEnd', T0 + NOTICE_COOLDOWN_MS);
    expect(noticeSnapshot().toast).toMatchObject({ cause: 'turnEnd' });
  });

  it('a teammate turn end is noise by default; with the setting it is a notice', () => {
    cldNotice(9, 'turnEnd', T0);
    expect(noticeSnapshot().items).toHaveLength(0);
    setNoticeSettings({ ...DEFAULT_SETTINGS, subagents: true });
    cldNotice(9, 'turnEnd', T0);
    expect(noticeSnapshot().toast).toMatchObject({ name: 'scout' });
  });

  it('the selected character still toasts: selecting it is not reading its chat', () => {
    setup(7);
    cldNotice(7, 'permission', T0);
    const { toast, items } = noticeSnapshot();
    expect(toast).toMatchObject({ text: 'Waiting for your permission' });
    expect(items[0]).toMatchObject({ text: 'Waiting for your permission', read: false });
  });

  it('no cld office: upstream keeps its chime', () => {
    cldResetForTests();
    expect(cldNotice(7, 'turnEnd', T0)).toBe(false);
  });

  it('a job that ended is a notice; the replayed history is not', () => {
    const base = { type: 'officeEvent' as const, source: null, name: 'veteran' };
    cldNoticeReplay(T0 - 1_000); // a connection's snapshot, its feed right behind
    cldNoticeEvent(
      { ...base, ts: new Date(T0).toISOString(), kind: 'job_end', summary: 'old' },
      T0,
    );
    cldNoticeEvent({ ...base, ts: new Date(T0).toISOString(), kind: 'turn_end', summary: 'x' }, T0);
    expect(noticeSnapshot().items).toHaveLength(0);
    cldNoticeEvent(
      {
        ...base,
        ts: new Date(T0 + 5_000).toISOString(),
        kind: 'job_end',
        summary: '\uc791\uc5c5 \ub05d: veteran (exit 0)',
      },
      T0 + 5_000,
    );
    expect(noticeSnapshot().toast).toMatchObject({
      cause: 'job',
      agentId: 7,
      text: '\uc791\uc5c5 \ub05d: veteran (exit 0)',
    });
  });

  it('NOTICE-DEDUP: a job or Codex run starting is no notice; its end is one', () => {
    const base = { type: 'officeEvent' as const, source: null, name: 'veteran' };
    for (const kind of ['job_start', 'codex_start'])
      cldNoticeEvent({ ...base, ts: new Date(T0).toISOString(), kind, summary: 'start' }, T0);
    expect(noticeSnapshot()).toMatchObject({ items: [], toast: null });
    cldNoticeEvent(
      { ...base, ts: new Date(T0 + 1).toISOString(), kind: 'job_end', summary: 'end' },
      T0 + 1,
    );
    expect(noticeSnapshot().items.map((n) => n.cause)).toEqual(['job']);
  });

  it('an owner sent message never makes an in-app notice', () => {
    cldNoticeEvent(
      {
        type: 'officeEvent',
        source: 'gui:phone',
        name: null,
        ts: new Date(T0).toISOString(),
        kind: 'send',
        summary: 'owner message',
      },
      T0,
    );
    expect(noticeSnapshot()).toMatchObject({ items: [], toast: null });
  });

  it('C6: a delegation waiting for approval is an ask that opens the workbench on its project', () => {
    cldNoticeEvent(
      { type: 'officeEvent', source: 'mcp', name: 'veteran', ts: new Date(T0).toISOString(), kind: 'delegation_approval', summary: 'x' },
      T0,
    );
    expect(noticeSnapshot().toast).toMatchObject({
      cause: 'permission',
      agentId: 7,
      text: t('approvals.notice'),
      target: { open: 'workbench', project: 'veteran' },
    });
  });

  it('C6: a new Worker that did not start is an ask naming it and its waiting Task', () => {
    cldNoticeEvent(
      { type: 'officeEvent', source: 'mcp', name: 'veteran', ts: new Date(T0).toISOString(), kind: 'delegation_start_failed', summary: 'w1 T-5' },
      T0,
    );
    expect(noticeSnapshot().toast).toMatchObject({ cause: 'permission', text: 'w1 T-5', target: { open: 'workbench', project: 'veteran' } });
  });

  it('an early reset uses its structured provider and period, without repeating the name', () => {
    cldNoticeEvent(
      {
        type: 'officeEvent',
        ts: new Date(T0).toISOString(),
        kind: 'usage_reset_early',
        summary: 'untrusted localized summary',
        provider: 'codex',
        period: 'fiveHour',
      },
      T0,
    );
    expect(noticeSnapshot().toast).toMatchObject({
      name: 'Codex',
      text: '5-hour usage was reset early',
    });
    expect(noticeSnapshot().toast?.text).not.toContain('Codex');
  });
});

describe('messenger replies (T-0043)', () => {
  beforeEach(() => {
    setup();
    closeMessenger();
  });
  const reply = (at: number, preview = '\ubc30\ud3ec \ub05d\ub0ac\uc5b4\uc694') =>
    cldReplyNotice({ agentId: 7, name: 'veteran', preview }, at);

  it('a reply in a conversation not on screen: a 💬 notice with its first line', () => {
    reply(T0);
    expect(noticeSnapshot().toast).toMatchObject({
      cause: 'reply',
      name: 'veteran',
      text: '\ubc30\ud3ec \ub05d\ub0ac\uc5b4\uc694',
    });
    expect(noticePulse(7, T0)).toBe(0);
  });

  it('the new reply of a closed conversation reaches the notices from the messenger', () => {
    const contacts = (replies: string[]) =>
      cldHandleMessage({
        type: 'messengerContacts',
        contacts: [{ agentId: 7, name: 'veteran', replies, preview: '\ub9ac\ubdf0 \ub05d' }],
      });
    contacts([`${T0}-a-0`]);
    contacts([`${T0}-a-0`, `${T0 + 1}-b-0`]);
    expect(noticeSnapshot().toast).toMatchObject({ cause: 'reply', text: '\ub9ac\ubdf0 \ub05d' });
  });

  it('its conversation on screen: listed as read, no toast', () => {
    openMessenger(7);
    reply(T0);
    expect(noticeSnapshot().toast).toBeNull();
    expect(noticeSnapshot().items[0]).toMatchObject({ cause: 'reply', read: true });
  });

  it('\uba54\uc2e0\uc800 \ub2f5\uc7a5 can be turned off (the turn end then stays)', () => {
    setNoticeSettings({ ...DEFAULT_SETTINGS, kinds: { ...DEFAULT_SETTINGS.kinds, reply: false } });
    reply(T0);
    expect(noticeSnapshot().items).toHaveLength(0);
    cldNotice(7, 'turnEnd', T0 + 1_000);
    expect(noticeSnapshot().toast).toMatchObject({ cause: 'turnEnd' });
  });

  it('a turn end and its reply together are one notice, the reply', () => {
    cldNotice(7, 'turnEnd', T0);
    const turnEnd = noticeSnapshot().toast!;
    reply(T0 + 2_000);
    const { items, toast } = noticeSnapshot();
    expect(items.map((n) => n.cause)).toEqual(['reply']);
    expect(toast).toMatchObject({ cause: 'reply', text: '\ubc30\ud3ec \ub05d\ub0ac\uc5b4\uc694' });
    // Same toast, new words: no second toast mounts.
    expect(toast!.id).toBe(turnEnd.id);
    // The other order: the reply first, its turn end dropped.
    setup();
    reply(T0);
    cldNotice(7, 'turnEnd', T0 + 3_000);
    expect(noticeSnapshot().items.map((n) => n.cause)).toEqual(['reply']);
    // Far apart they are two events.
    cldNotice(7, 'turnEnd', T0 + NOTICE_PAIR_MS + 1);
    expect(noticeSnapshot().items.map((n) => n.cause)).toEqual(['turnEnd', 'reply']);
  });

  it('NOTICE-DEDUP: text written mid-turn, then the turn ends much later: the reply only', () => {
    reply(T0);
    cldNotice(7, 'turnEnd', T0 + 10 * 60_000);
    expect(noticeSnapshot().items.map((n) => n.cause)).toEqual(['reply']);
    // The next turn wrote nothing: its end is a notice again.
    cldNotice(7, 'turnEnd', T0 + 20 * 60_000);
    expect(noticeSnapshot().items.map((n) => n.cause)).toEqual(['turnEnd', 'reply']);
  });

  it('NOTICE-DEDUP: a reply that follows its turn end does not hide the next turn end', () => {
    cldNotice(7, 'turnEnd', T0);
    reply(T0 + 2_000);
    expect(noticeSnapshot().items.map((n) => n.cause)).toEqual(['reply']);
    cldNotice(7, 'turnEnd', T0 + 10 * 60_000);
    expect(noticeSnapshot().items.map((n) => n.cause)).toEqual(['turnEnd', 'reply']);
  });

  it('NOTICE-DEDUP: a turn with no text keeps its turn end', () => {
    cldNotice(7, 'turnEnd', T0);
    expect(noticeSnapshot().items.map((n) => n.cause)).toEqual(['turnEnd']);
  });
});

describe('read marks and where a notice opens (T-0043, 10-22 01:3x)', () => {
  /** veteran (7) is a lead with a background session; 9 is its teammate scout. */
  function withChat(chat: boolean) {
    setup();
    cldHandleMessage({
      type: 'officeSnapshot',
      capabilities: ['ls'],
      chat,
      orchestrators: [{ name: 'veteran', agentId: 7, bg: { id: 'a0000016', state: 'blocked' } }],
      tabs: [],
    } as unknown as OfficeSnapshot);
  }

  it('a notice is read when clicked (markRead), all with \ubaa8\ub450 \uc77d\uc74c; nothing else reads them', () => {
    withChat(true);
    cldNotice(7, 'turnEnd', T0);
    cldNotice(7, 'permission', T0 + 1);
    const [perm, turn] = noticeSnapshot().items;
    expect(unreadCount(noticeSnapshot().items)).toBe(2);
    markRead(turn.id);
    expect(noticeSnapshot().items.map((n) => n.read)).toEqual([false, true]);
    markAllRead();
    expect(unreadCount(noticeSnapshot().items)).toBe(0);
    expect(perm.id).not.toBe(turn.id);
  });

  it('clears notices and old feed events while later events and notices still appear', () => {
    setup();
    closeMessenger();
    cldNotice(7, 'turnEnd', T0);
    clearAll(T0);

    expect(noticeSnapshot().items).toEqual([]);
    expect(unreadCount(noticeSnapshot().items)).toBe(0);

    const feed = (at: number, summary: string): OfficeEvent => ({
      type: 'officeEvent',
      ts: new Date(at).toISOString(),
      kind: 'compacted',
      name: 'veteran',
      summary,
    });
    const news = mergeNews(
      noticeSnapshot().items,
      [feed(T0, 'old feed'), feed(T0 + 1, 'new feed')],
      noticeSnapshot().clearedAt,
    );
    expect(news.map((item) => item.text)).toEqual(['new feed']);

    cldNotice(7, 'permission', T0 + 2);
    expect(unreadCount(noticeSnapshot().items)).toBe(1);
  });

  it('targets: a lead → its conversation (a permission ask of a background session: the terminal too); others → the character', () => {
    withChat(true);
    cldNotice(7, 'turnEnd', T0);
    cldNotice(7, 'permission', T0 + 1);
    cldNotice(9, 'permission', T0 + 2);
    const [scout, perm, turn] = noticeSnapshot().items;
    expect(noticeGoesTo(turn)).toEqual({ open: 'chat', lead: 'veteran', at: T0 });
    expect(noticeGoesTo(perm)).toEqual({
      open: 'chat',
      lead: 'veteran',
      terminal: true,
      at: T0 + 1,
    });
    expect(noticeGoesTo(scout)).toEqual({ open: 'agent', agentId: 9 });
    // Chat off: no messenger, the character as before.
    withChat(false);
    cldNotice(7, 'turnEnd', T0);
    expect(noticeGoesTo(noticeSnapshot().items[0])).toEqual({ open: 'agent', agentId: 7 });
    // A list saved before targets existed: the character.
    expect(noticeGoesTo({ ...noticeSnapshot().items[0], target: undefined })).toEqual({
      open: 'agent',
      agentId: 7,
    });
  });

  it('targets: a job end → its card in \uc791\uc5c5, a Codex end → its task', () => {
    withChat(true);
    const base = { type: 'officeEvent' as const, source: null, name: 'veteran' };
    const ts = new Date(T0).toISOString();
    cldNoticeEvent(
      { ...base, ts, kind: 'job_end', summary: '\uc791\uc5c5 \ub05d', ref: 'pid:4242' },
      T0,
    );
    cldNoticeEvent(
      { ...base, name: null, ts, kind: 'codex_end', summary: 'Codex c1 \ub05d', ref: 'c1' },
      T0 + 1,
    );
    const [codex, job] = noticeSnapshot().items;
    expect(noticeGoesTo(job)).toEqual({ open: 'job', id: 'pid:4242' });
    expect(noticeGoesTo(codex)).toEqual({ open: 'codex', id: 'c1' });
  });

  it('a reply notice names the reply item, so its click lands on it, not on a neighbour', () => {
    withChat(true);
    cldReplyNotice({ agentId: 7, name: 'veteran', preview: 'x', itemId: `${T0}-a-0` }, T0);
    expect(noticeSnapshot().toast?.target).toMatchObject({
      open: 'chat',
      lead: 'veteran',
      at: T0,
      id: `${T0}-a-0`,
    });
  });

  it('a new reply from the contacts carries the newest reply id', () => {
    withChat(true);
    messengerResetForTests();
    closeMessenger();
    const contacts = (replies: string[]) =>
      cldHandleMessage({
        type: 'messengerContacts',
        contacts: [{ agentId: 7, name: 'veteran', replies, preview: 'p' }],
      });
    contacts([`${T0}-a-0`]);
    contacts([`${T0}-a-0`, `${T0 + 1}-b-0`]);
    expect(noticeSnapshot().toast?.target).toMatchObject({ id: `${T0 + 1}-b-0` });
  });

  it('opening: the conversation (with the hint), the panel, the character; not yet there → false', () => {
    withChat(true);
    closeMessenger();
    vi.stubGlobal('window', { dispatchEvent: () => true }); // a job opens the 작업실
    const calls: string[] = [];
    let held = false; // the character is out of sight while the page settles
    const deps = {
      goToAgent: (id: number) => !held && calls.push(`go ${id}`) > 0,
      officeHas: (id: number) => id === 7,
    };
    expect(openTarget({ open: 'chat', lead: 'veteran', terminal: true, at: T0 }, deps)).toBe(true);
    expect(hudGetSnapshot().open.messenger).toBe(true);
    expect(messengerGetSnapshot()).toMatchObject({
      active: 7,
      terminalHint: 7,
      pendingJump: { agentId: 7, at: T0 },
    });
    expect(openTarget({ open: 'chat', lead: 'nobody' }, deps)).toBe(false);
    expect(openTarget({ open: 'job', id: 'pid:1' }, deps)).toBe(false); // no jobs yet
    cldHandleMessage({ type: 'officeJobs', jobs: [] });
    expect(openTarget({ open: 'job', id: 'pid:1' }, deps)).toBe(true);
    expect(openTarget({ open: 'agent', agentId: 7 }, deps)).toBe(true);
    expect(openTarget({ open: 'agent', agentId: 8 }, deps)).toBe(false);
    expect(calls).toEqual(['go 7']);
    // A character held out of sight is not followed: false, so the click is asked again.
    held = true;
    expect(openTarget({ open: 'agent', agentId: 7 }, deps)).toBe(false);
    held = false;
    expect(openTarget({ open: 'agent', agentId: 7 }, deps)).toBe(true);
  });
});

describe('UI-C1: a job or Codex notice opens the workbench on the item', () => {
  const deps = { goToAgent: () => true, officeHas: () => true };
  beforeEach(() => {
    setup();
    vi.stubGlobal('window', { dispatchEvent: () => true });
    cldHandleMessage({
      type: 'officeSnapshot',
      capabilities: ['ls'],
      chat: true,
      orchestrators: [{ name: 'veteran', agentId: 7 }],
      tabs: [],
    } as unknown as OfficeSnapshot);
    cldHandleMessage({
      type: 'officeJobs',
      jobs: [
        { id: 'j1', project: 'veteran', pid: 1, cmd: 'a', started: null, ended: null },
        { id: 'j2', project: null, pid: 2, cmd: 'b', started: null, ended: null },
      ],
    } as never);
    cldHandleMessage({
      type: 'codexTasks',
      tasks: [
        { id: 'c1', project: 'veteran', state: 'done' },
        { id: 'c2', project: 'ghost', state: 'running' },
      ],
    } as never);
  });

  it('a job: Task tab, on its project; no project → no project', () => {
    expect(openTarget({ open: 'job', id: 'j1' }, deps)).toBe(true);
    expect(workbenchGetSnapshot()).toEqual({ project: 'veteran', tab: 'tasks' });
    expect(openTarget({ open: 'job', id: 'j2' }, deps)).toBe(true);
    expect(workbenchGetSnapshot()).toEqual({ project: NO_PROJECT, tab: 'tasks' });
  });

  it('a Codex run: agents tab, on its project; one of a project not in the picker → no project', () => {
    expect(openTarget({ open: 'codex', id: 'c1' }, deps)).toBe(true);
    expect(workbenchGetSnapshot()).toEqual({ project: 'veteran', tab: 'agents' });
    expect(openTarget({ open: 'codex', id: 'c2' }, deps)).toBe(true);
    expect(workbenchGetSnapshot()).toEqual({ project: NO_PROJECT, tab: 'agents' });
  });
});

describe('ROOM-NOTICE: each member\'s reply in a room is its own notice, like a DM reply', () => {
  const ROOM = '\ucd9c\uc2dc\ud300';
  const contactsAre = (
    room?: string,
    post = 'post0001',
    replies: Record<number, { id: string; text: string }> = {},
  ) =>
    cldHandleMessage({
      type: 'messengerContacts',
      contacts: [
        { agentId: 7, name: 'veteran' },
        { agentId: 8, name: 'chief' },
      ].map((c) => ({
        ...c,
        replies: [],
        ...(room && { room, roomId: 'release', roomPost: post }),
        ...(replies[c.agentId] && { roomReply: replies[c.agentId] }),
      })),
    });
  const rooms = () =>
    cldHandleMessage({
      type: 'groupRooms',
      rooms: [{ id: 'release', name: ROOM, members: ['veteran', 'chief'] }],
    });
  beforeEach(() => {
    setup();
    messengerResetForTests();
    cldHandleMessage({
      type: 'officeSnapshot',
      capabilities: ['ls'],
      chat: true,
      orchestrators: [
        { name: 'veteran', agentId: 7 },
        { name: 'chief', agentId: 8 },
      ],
      tabs: [],
    } as unknown as OfficeSnapshot);
    closeMessenger();
  });

  it('two members answering one post give two notices with their names and previews, opening the room', () => {
    contactsAre(ROOM);
    contactsAre(ROOM, 'post0001', {
      7: { id: 'a1', text: 'I will take it' },
      8: { id: 'b1', text: 'I will review' },
    });
    const { items } = noticeSnapshot();
    expect(items.map((n) => [n.cause, n.agentId, n.name, n.text])).toEqual([
      ['reply', 8, `${ROOM} \u00b7 chief`, 'I will review'],
      ['reply', 7, `${ROOM} \u00b7 veteran`, 'I will take it'],
    ]);
    expect(noticeGoesTo(items[0])).toEqual({ open: 'room', room: 'release' });
    // The turn ends that come with them are the same notices, not more.
    cldNotice(7, 'turnEnd', Date.now());
    cldNotice(8, 'turnEnd', Date.now());
    expect(noticeSnapshot().items).toHaveLength(2);
  });

  it('a turn end before the text is the short line naming the member; the text then replaces it', () => {
    contactsAre(ROOM);
    cldNotice(7, 'turnEnd', Date.now());
    expect(noticeSnapshot().items.map((n) => [n.cause, n.name])).toEqual([
      ['turnEnd', `${ROOM} \u00b7 veteran`],
    ]);
    contactsAre(ROOM, 'post0001', { 7: { id: 'a1', text: 'done, merged' } });
    expect(noticeSnapshot().items.map((n) => [n.cause, n.text])).toEqual([['reply', 'done, merged']]);
  });

  it('a turn end long after the member\'s text adds no second notice', () => {
    contactsAre(ROOM);
    contactsAre(ROOM, 'post0001', { 7: { id: 'a1', text: 'on it' } });
    cldNotice(7, 'turnEnd', Date.now() + 60_000); // past the pairing window
    expect(noticeSnapshot().items.map((n) => n.cause)).toEqual(['reply']);
  });

  it('a tool-only turn (no text) stays the short line, one per member and post; another post notifies again', () => {
    contactsAre(ROOM);
    cldNotice(7, 'turnEnd', T0);
    cldNotice(8, 'turnEnd', T0 + 1_000);
    cldNotice(7, 'turnEnd', T0 + 2_000); // the same member, the same post
    expect(noticeSnapshot().items.map((n) => n.name)).toEqual([`${ROOM} \u00b7 chief`, `${ROOM} \u00b7 veteran`]);
    contactsAre(ROOM, 'post0002');
    cldNotice(7, 'turnEnd', T0 + 3_000);
    expect(noticeSnapshot().items).toHaveLength(3);
    contactsAre(ROOM, 'post0001');
    // A permission ask stays the lead's own.
    cldNotice(7, 'permission', T0 + 4_000);
    expect(noticeGoesTo(noticeSnapshot().items[0])).toEqual({
      open: 'chat',
      lead: 'veteran',
      at: T0 + 4_000,
    });
  });

  it('the first sight of a reply is not news; the owner\'s chat being open does not hide a room reply', () => {
    contactsAre(ROOM, 'post0001', { 7: { id: 'a1', text: 'old' } });
    expect(noticeSnapshot().items).toHaveLength(0);
    openMessenger(7); // veteran's one-to-one chat is on screen
    contactsAre(ROOM, 'post0001', { 7: { id: 'a2', text: 'new' } });
    expect(noticeSnapshot().toast).toMatchObject({ text: 'new', read: false });
  });

  it("a DM turn (no room) notifies the lead as before, and its cooldown is not the room's", () => {
    contactsAre(ROOM);
    cldNotice(7, 'turnEnd', T0);
    contactsAre();
    cldNotice(7, 'turnEnd', T0 + 1_000);
    expect(noticeSnapshot().items.map((n) => n.name)).toEqual(['veteran', `${ROOM} \u00b7 veteran`]);
  });

  it('the room on screen: listed as read, no toast; its notice opens the room', () => {
    rooms();
    contactsAre(ROOM);
    showRoom('release');
    cldNotice(7, 'turnEnd', T0);
    contactsAre(ROOM, 'post0001', { 8: { id: 'b1', text: 'hello' } });
    expect(noticeSnapshot().toast).toBeNull();
    expect(noticeSnapshot().items.map((n) => [n.name, n.read])).toEqual([
      [`${ROOM} \u00b7 chief`, true],
      [`${ROOM} \u00b7 veteran`, true],
    ]);
    showMessengerList();
    const deps = { goToAgent: () => true, officeHas: () => true };
    expect(openTarget({ open: 'room', room: 'nobody' }, deps)).toBe(false);
    expect(openTarget({ open: 'room', room: 'release' }, deps)).toBe(true);
    expect(hudGetSnapshot().open.messenger).toBe(true);
    expect(messengerGetSnapshot()).toMatchObject({
      active: null,
      activeRoom: 'release',
    });
  });
});
