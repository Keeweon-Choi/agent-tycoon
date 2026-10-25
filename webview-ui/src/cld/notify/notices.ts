/**
 * T-0039: where a sound came from. Every sound the cld office makes comes
 * with a toast naming the character and what happened, a ~3 s pulse on that
 * character and a line under the HUD's bell. The rules (FR-NTF-003/005):
 * each kind can be turned off; the same kind for the same character at most
 * once per 5 minutes; nothing loud for the character you are looking at (it
 * is selected, or its chat is open); turn ends only from orchestrators unless
 * the user asks for sub-agents and teammates too.
 *
 * Per device: the settings and the list (with its read marks) live in
 * localStorage, every access in try/catch (private mode, Node tests).
 */
import { useSyncExternalStore } from 'react';

import {
  CAUSE_TEXT,
  KIND_OF,
  type NoticeCause,
  type NoticeKind,
  type NoticeTarget,
  noticeTarget,
  noticeVerdict,
  parseNoticeUrl,
} from '../../../../core/src/cld/notices.js';
import { NOTICE_COOLDOWN_MS } from '../../../../core/src/constants.js';
import type { OfficeEvent, PushState } from '../../../../core/src/messages.js';
import {
  NOTICE_DEFAULT_VOLUME,
  NOTICE_FEED_REPLAY_MS,
  NOTICE_LIST_MAX,
  NOTICE_PAIR_MS,
  NOTICE_PULSE_MS,
} from '../../constants.js';
import { t, type TranslationKey } from '../../i18n/index.js';
import {
  playDoneSound,
  playJobSound,
  playPermissionSound,
  setSoundVolume,
} from '../../notificationSound.js';
import type { OfficeState } from '../../office/engine/officeState.js';
import { chatOpenFor } from '../chat.js';
import { employeeName } from '../employees.js';
import { engineGetSnapshot } from '../engineStore.js';
import { type CharacterKind, characterKind, characterName } from '../kinds.js';
import {
  type LeadReply,
  onLeadReply,
  roomShowing,
  turnRoomOf,
} from '../messenger/messengerStore.js';
import { cldGetSnapshot, virtualAgentId } from '../officeStore.js';

export {
  KIND_OF,
  NOTICE_ICON,
  type NoticeCause,
  type NoticeKind,
  type NoticeTarget,
  noticeVerdict,
} from '../../../../core/src/cld/notices.js';
import { serverLine } from '../serverText.js';

export const KIND_LABEL: Record<NoticeKind, TranslationKey> = {
  turnEnd: 'notice.turnEnd',
  attention: 'notice.attention',
  job: 'notice.job',
  reply: 'notice.reply',
};

export interface NoticeSettings {
  /** Sounds at all (the toast, pulse and bell stay). */
  sound: boolean;
  /** 0..1. */
  volume: number;
  kinds: Record<NoticeKind, boolean>;
  /** Turn ends of sub-agents and teammates too (off: orchestrators only). */
  subagents: boolean;
  /** Push turn ends of remote-control orchestrators too (FR-NTF-006). */
  remoteTurnEnds: boolean;
}
export const DEFAULT_SETTINGS: NoticeSettings = {
  sound: true,
  volume: NOTICE_DEFAULT_VOLUME,
  kinds: { turnEnd: true, attention: true, job: true, reply: true },
  subagents: false,
  remoteTurnEnds: true,
};

export interface Notice {
  id: string;
  cause: NoticeCause;
  /** The character to go to; null when it is not in the office. */
  agentId: number | null;
  name: string;
  text: string;
  at: number;
  read: boolean;
  /** Where a click on it goes (T-0043); absent in lists saved before: the character. */
  target?: NoticeTarget;
}

// ── Store ─────────────────────────────────────────────────────

const SETTINGS_KEY = 'cld.notice-settings';
const LIST_KEY = 'cld.notices';
const CLEARED_AT_KEY = 'cld.notices-cleared-at';

export interface NoticeSnapshot {
  items: Notice[];
  /** Feed events at or before this time are hidden for this browser. */
  clearedAt: number | null;
  toast: Notice | null;
  settings: NoticeSettings;
  /** Web Push for this device, as the daemon last said (part B). */
  push: PushState | null;
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode: this visit still has it.
  }
}

function loadSettings(): NoticeSettings {
  const s = load<Partial<NoticeSettings>>(SETTINGS_KEY, {});
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    kinds: { ...DEFAULT_SETTINGS.kinds, ...s.kinds },
  };
}
const loadItems = (): Notice[] => {
  const items = load<unknown>(LIST_KEY, []);
  return Array.isArray(items) ? (items as Notice[]).slice(0, NOTICE_LIST_MAX) : [];
};
const loadClearedAt = (): number | null => {
  const clearedAt = load<unknown>(CLEARED_AT_KEY, null);
  return typeof clearedAt === 'number' && Number.isFinite(clearedAt) ? clearedAt : null;
};

let snapshot: NoticeSnapshot = {
  items: loadItems(),
  clearedAt: loadClearedAt(),
  toast: null,
  settings: loadSettings(),
  push: null,
};
setSoundVolume(snapshot.settings.volume);
const last = new Map<string, number>();
const pulses = new Map<number, number>();
const listeners = new Set<() => void>();
let seq = 0;
let office: (() => OfficeState) | null = null;
/** Until when feed events are a (re)connection's replay of history. */
let replayUntil = 0;

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
function set(next: Partial<NoticeSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  if (next.items) save(LIST_KEY, snapshot.items);
  if (next.clearedAt !== undefined) save(CLEARED_AT_KEY, next.clearedAt);
  listeners.forEach((l) => l());
}

export const noticeSnapshot = () => snapshot;
export const useNotices = () => useSyncExternalStore(subscribe, noticeSnapshot);
export const unreadCount = (items: Notice[]) => items.filter((n) => !n.read).length;

/** The app's office, for names, kinds and what is selected. */
export function bindNoticeOffice(getOfficeState: (() => OfficeState) | null): void {
  office = getOfficeState;
}

export function setNoticeSettings(next: NoticeSettings): void {
  setSoundVolume(next.volume);
  save(SETTINGS_KEY, next);
  set({ settings: next });
}

/** A notice was clicked (in the toast or the bell's list): that one is read. */
export function markRead(id: string): void {
  if (snapshot.items.some((n) => n.id === id && !n.read))
    set({ items: snapshot.items.map((n) => (n.id === id ? { ...n, read: true } : n)) });
}

/** A push's click opened `t` (T-0043): the same notice in this list is read too. */
export function markReadFor(t: NoticeTarget): void {
  const same = (n: Notice) => {
    const g = noticeGoesTo(n);
    if (g.open === 'chat' && t.open === 'chat') return g.lead === t.lead;
    return JSON.stringify(g) === JSON.stringify(t);
  };
  if (snapshot.items.some((n) => !n.read && same(n)))
    set({ items: snapshot.items.map((n) => (!n.read && same(n) ? { ...n, read: true } : n)) });
}

/** 모두 읽음. */
export function markAllRead(): void {
  if (snapshot.items.some((n) => !n.read))
    set({ items: snapshot.items.map((n) => (n.read ? n : { ...n, read: true })) });
}

/** Hide all notices and feed events seen by this browser so far. */
export function clearAll(now = Date.now()): void {
  set({ items: [], clearedAt: now });
}

/** pushState from the daemon. */
export function cldPushState(push: PushState): void {
  set({ push });
}

export function dismissNoticeToast(id: string): void {
  if (snapshot.toast?.id === id) set({ toast: null });
}

/** How far into its pulse character `id` is (ms), or null when it is not pulsing. */
export function noticePulse(id: number, now = Date.now()): number | null {
  const start = pulses.get(id);
  if (start === undefined) return null;
  if (now - start >= NOTICE_PULSE_MS) {
    pulses.delete(id);
    return null;
  }
  return now - start;
}

const SOUND: Record<NoticeKind, () => Promise<void>> = {
  turnEnd: playDoneSound,
  attention: playPermissionSound,
  job: playJobSound,
  reply: playDoneSound,
};

/** When each lead's last messenger reply arrived (T-0043), to pair it with its turn end. */
const replies = new Map<number, number>();
/** NOTICE-DEDUP: when each lead's last turn end came in (shown or not): a reply after it belongs to the turn now running. */
const turnEnds = new Map<number, number>();

/**
 * NOTICE-DEDUP: a turn is one notice, the reply when it wrote one (it carries the text), else the
 * turn end. A turn end is the half to drop when a reply came during its turn (since the lead's
 * previous turn end, however long ago: text mid-turn, tools after) or within NOTICE_PAIR_MS of it
 * (a duplicate status). A reply that comes after its turn end replaces that notice in place.
 * ponytail: a reply of a turn that never ends (the lead is killed) hides the next turn end.
 */
function pairWithReply(
  cause: NoticeCause,
  agentId: number | null,
  now: number,
): 'drop' | Notice | null {
  if (agentId === null) return null;
  if (cause === 'turnEnd') {
    const prev = turnEnds.get(agentId);
    turnEnds.set(agentId, now);
    const at = replies.get(agentId);
    return at !== undefined && (prev === undefined || at > prev || now - at < NOTICE_PAIR_MS)
      ? 'drop'
      : null;
  }
  if (cause !== 'reply') return null;
  // Just after a turn end: that turn's own late reply, not the next turn's.
  const end = turnEnds.get(agentId);
  replies.set(agentId, end !== undefined && now - end < NOTICE_PAIR_MS ? end : now);
  return (
    snapshot.items.find(
      (n) => n.cause === 'turnEnd' && n.agentId === agentId && now - n.at < NOTICE_PAIR_MS,
    ) ?? null
  );
}

/** A character's notice opens its conversation when it is a lead and chat is on (T-0043). */
function targetOf(cause: NoticeCause, agentId: number | null, itemId?: string): NoticeTarget {
  const office = cldGetSnapshot().officeSnapshot;
  const orch =
    agentId === null
      ? undefined
      : office?.orchestrators.find(
          (o) => (o.agentId ?? virtualAgentId(`orch:${o.name}`)) === agentId,
        );
  const lead = office?.chat ? (orch?.name ?? null) : null;
  return noticeTarget({ cause, agentId, lead, background: !!orch?.bg?.id, itemId });
}

/** Where a notice goes: its own target, else (older lists) its character. */
export const noticeGoesTo = (n: Notice): NoticeTarget =>
  n.target ?? (n.agentId === null ? { open: 'office' } : { open: 'agent', agentId: n.agentId });

/** A push's url (`?open=…`, `?agent=`) as a target: what the page was opened for. */
export const targetFromUrl = (search: string): NoticeTarget | null => parseNoticeUrl(search);

function deliver(
  cause: NoticeCause,
  agentId: number | null,
  name: string,
  text: string,
  who: CharacterKind | 'worker',
  now: number,
  target: NoticeTarget = targetOf(cause, agentId),
  /** C3: what a notice with no character is about (a room's post): its cooldown key. */
  foldKey?: string,
): void {
  if (cause === 'reply' && snapshot.settings.kinds.reply === false) return; // the turn end stays
  const pair = pairWithReply(cause, agentId, now);
  if (pair === 'drop') return;
  const looking =
    target.open === 'room'
      ? roomShowing(target.room)
      : // A selected character is not a read chat (owner 10-24 22:28: its messages did not toast).
        agentId !== null && chatOpenFor(agentId);
  const verdict = noticeVerdict(
    {
      cause,
      target: foldKey ? `room:${foldKey}` : agentId !== null ? String(agentId) : name,
      who,
      at: now,
    },
    snapshot.settings,
    last,
    looking,
  );
  if (verdict === 'off' || verdict === 'cooldown') return;
  const notice: Notice = {
    id: `${now.toString(36)}-${++seq}`,
    cause,
    agentId,
    name,
    text,
    at: now,
    read: verdict === 'quiet',
    target: target.open === 'chat' ? { ...target, at: now } : target,
  };
  if (pair) {
    // In the turn end's place: its id (the toast stays mounted, no second toast), its read mark,
    // no second sound or pulse.
    const replaced = { ...notice, id: pair.id, read: pair.read };
    set({
      items: [replaced, ...snapshot.items.filter((n) => n !== pair)].slice(0, NOTICE_LIST_MAX),
      toast: snapshot.toast?.id === pair.id ? replaced : snapshot.toast,
    });
    return;
  }
  const items = [notice, ...snapshot.items].slice(0, NOTICE_LIST_MAX);
  if (verdict === 'quiet') {
    set({ items });
    return;
  }
  if (agentId !== null) pulses.set(agentId, now);
  if (snapshot.settings.sound) void SOUND[KIND_OF[cause]]();
  set({ items, toast: notice });
}

/** ROOM-NOTICE: when a member's text reply to a post got its notice (its later turn end adds none). */
const roomReplied = new Map<string, number>();

/** ROOM-NOTICE: a member's notice in a room: "<room> · <member>", opening the room's thread, folded per member and post. */
function roomDeliver(
  cause: 'turnEnd' | 'reply',
  agentId: number,
  member: string,
  text: string,
  who: CharacterKind | 'worker',
  now: number,
  room: NonNullable<LeadReply['room']>,
): void {
  const key = `${room.post ?? room.id ?? room.name}:${agentId}`;
  const done = roomReplied.get(key);
  if (cause === 'turnEnd' && done !== undefined && now - done < NOTICE_COOLDOWN_MS) return;
  if (cause === 'reply') roomReplied.set(key, now);
  deliver(
    cause,
    agentId,
    `${room.name} · ${member}`,
    text,
    who,
    now,
    room.id ? { open: 'room', room: room.id } : { open: 'office' },
    key,
  );
}

/**
 * A turn end, question or permission ask of office agent `id`. False when this
 * is no cld office (upstream then plays its own chime); true when the rules
 * here took it (sound, toast and all, or deliberately nothing).
 */
export function cldNotice(
  id: number,
  cause: Exclude<NoticeCause, 'job' | 'reply'>,
  now = Date.now(),
  /** PERM-PROMPT: the staff name id of the sub-agent that asks. */
  asker?: string,
): boolean {
  const { officeSnapshot: officeState, codexTasks } = cldGetSnapshot();
  const ch = office?.().characters.get(id);
  if (!officeState || !office) return false;
  if (!ch) return true;
  const name = characterName(ch, officeState, codexTasks);
  // ROOM-NOTICE: the server says this lead's newest turn answers a room post: its end is that
  // member's notice in the room (a text reply, when it wrote one, replaces this short line).
  const room = cause === 'turnEnd' ? turnRoomOf(id) : null;
  if (room) {
    roomDeliver('turnEnd', id, name, serverLine(CAUSE_TEXT.turnEnd), characterKind(ch, officeState, codexTasks), now, room);
    return true;
  }
  const kind = characterKind(ch, officeState, codexTasks);
  // K1: an engine Worker's turn ends are its Lead's news (its asks still come through).
  const worker =
    kind === 'orchestrator' && !!engineGetSnapshot().state?.projects.some((p) => p.name === name && p.role);
  const text = asker
    ? t('permPrompt.noticeSub', { name: employeeName({ nameId: asker }) })
    : serverLine(CAUSE_TEXT[cause]);
  deliver(cause, id, name, text, worker ? 'worker' : kind, now);
  return true;
}

/** A connection's snapshot begins (hostInfo, sent first): the feed that follows is history. */
export function cldNoticeReplay(now = Date.now()): void {
  replayUntil = now + NOTICE_FEED_REPLAY_MS;
}

/** A feed event (officeEvent): a job or Codex task that ended is a notice. */
export function cldNoticeEvent(ev: OfficeEvent, now = Date.now()): void {
  // Messages sent by the owner or between agents stay in the messenger only.
  if (ev.kind === 'send') return;
  if (
    ev.kind !== 'job_end' &&
    ev.kind !== 'codex_end' &&
    ev.kind !== 'orch_giveup' &&
    ev.kind !== 'usage_reset_early' &&
    ev.kind !== 'delegation_approval' &&
    ev.kind !== 'delegation_start_failed'
  )
    return;
  if (now < replayUntil) return;
  if (ev.kind === 'delegation_approval' || ev.kind === 'delegation_start_failed') {
    // C6: a delegation waits for the user, or a new Worker did not start and its Task waits:
    // an ask, opening the project's 작업실.
    const lead = cldGetSnapshot().officeSnapshot?.orchestrators.find((o) => o.name === ev.name);
    const agentId = lead ? (lead.agentId ?? virtualAgentId(`orch:${lead.name}`)) : null;
    const project = ev.name ?? '';
    const text = ev.kind === 'delegation_approval' ? t('approvals.notice') : serverLine(ev.summary);
    deliver('permission', agentId, project || t('notice.jobName'), text, 'orchestrator', now, {
      open: 'workbench',
      project,
    });
    return;
  }
  if (ev.kind === 'usage_reset_early') {
    const provider = ev.provider === 'codex' ? 'codex' : 'claude';
    const period = ev.period === 'sevenDay' ? 'sevenDay' : 'fiveHour';
    const text =
      provider === 'codex'
        ? period === 'sevenDay'
          ? t('usage.codexSevenDayEarlyReset')
          : t('usage.codexFiveHourEarlyReset')
        : period === 'sevenDay'
          ? t('usage.claudeSevenDayEarlyReset')
          : t('usage.claudeFiveHourEarlyReset');
    deliver('job', null, provider === 'codex' ? 'Codex' : 'Claude', text, 'orchestrator', now, {
      open: 'office',
    });
    return;
  }
  const { officeSnapshot: officeState } = cldGetSnapshot();
  const orch = ev.name ? officeState?.orchestrators.find((o) => o.name === ev.name) : undefined;
  const agentId = orch ? (orch.agentId ?? virtualAgentId(`orch:${orch.name}`)) : null;
  // T-0091: the engine gave up on a session: its character, not a job.
  const target =
    ev.kind === 'orch_giveup'
      ? agentId === null
        ? ({ open: 'office' } as const)
        : ({ open: 'agent', agentId } as const)
      : noticeTarget({ cause: 'job', agentId, event: { kind: ev.kind, ref: ev.ref } });
  deliver('job', agentId, ev.name ?? t('notice.jobName'), serverLine(ev.summary), 'orchestrator', now, target);
}

/** A lead's new reply in the office messenger (T-0043) whose conversation is not on screen. */
export function cldReplyNotice(r: LeadReply, now = Date.now()): void {
  if (!cldGetSnapshot().officeSnapshot) return;
  if (r.room) return roomDeliver('reply', r.agentId, r.name, r.preview, 'orchestrator', now, r.room);
  const target = targetOf('reply', r.agentId, r.itemId);
  deliver('reply', r.agentId, r.name, r.preview || t('notice.replyArrived'), 'orchestrator', now, target);
}
onLeadReply((r) => cldReplyNotice(r));

/** Test helper. */
export function noticesResetForTests(): void {
  snapshot = { items: [], clearedAt: null, toast: null, settings: DEFAULT_SETTINGS, push: null };
  last.clear();
  pulses.clear();
  replies.clear();
  turnEnds.clear();
  roomReplied.clear();
  office = null;
  replayUntil = 0;
}
