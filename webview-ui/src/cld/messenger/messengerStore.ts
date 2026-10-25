/**
 * The office messenger (T-0043): the boss's chats with the team leads. The
 * daemon tails each lead's transcript and sends `messengerContacts` (every
 * lead's last message and latest reply ids) and, for each open conversation,
 * `chatTranscript` (all of it once, then appends). Sends are `chatSend`,
 * which the daemon routes to the engine messenger; `now` (Ctrl+Enter,
 * 즉시) may go in while the lead works. An engine lead's transcript also lists
 * the boss's messages still queued (`queued`), so they show as 보냄(대기 중)
 * after a reload, each with 지금 보내기 (`chatSendNow`).
 *
 * Here: which conversations are open (at most MAX_OPEN), the unread counts
 * (the last-read reply id per lead, per device in localStorage), the bubbles
 * of messages on their way, and onLeadReply for notifications (T-0039).
 */
import { useSyncExternalStore } from 'react';

import type {
  ChatCancel,
  ChatEdit,
  ChatHistoryResult,
  ChatHold,
  ChatItem,
  ChatPendingResult,
  ChatQueued,
  ChatReply,
  ChatSearchResult,
  ChatSend,
  ChatSendNow,
  ChatSendResult,
  ChatTranscript,
  GroupActionResult,
  GroupRoom,
  GroupRooms,
  GroupTimeline,
  MessengerContact,
  PermissionAnswer,
  PermissionAnswerOutcome,
  PermissionAnswerResult,
  PinnedConversations,
  SetConversationPin,
  SlashCommandsList,
} from '../../../../core/src/messages.js';
import type { TabStatus } from '../../components/AgentCard.js';
import { CHAT_REQUEST_TIMEOUT_MS } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { closeWindow, hudSubscribe, openWindow, windowShown } from '../hud/hudStore.js';
import { type Presence, presenceWord } from '../officeHours.js';
import { serverLine, serverText } from '../serverText.js';
import type { AttachmentChip } from './attachments.js';

/** Open conversations per client; the daemon refuses more (server/src/cld/conversations.ts). */
export const MAX_OPEN = 4;
/** Items kept per open conversation, including historical pages. */
export const MAX_ITEMS = 2000;
const READ_KEY = 'cld.messenger.read';

export type SendState = 'sending' | 'queued' | 'sent' | 'inbox' | 'failed' | 'cancelled';
export const sendLabel = (state: SendState): string => t(`messenger.send.${state}`);

/** A message on its way, shown until the transcript has it (then 받음). */
export interface PendingSend {
  requestId: string;
  text: string;
  state: SendState;
  error?: string;
  /** When it was sent (ms): only prompts from about then on can settle it. */
  sentAt: number;
  /** Its id in the engine messenger's queue (지금 보내기). */
  queueId?: string;
  /** C2: the message's id; the transcript's prompt for it carries the same one. */
  messageId?: string;
  /** 즉시 보내기: it may go in while the lead works. */
  now?: boolean;
  /** A 지금 보내기 on its way. */
  promoting?: boolean;
  /** A replacement request is on its way. */
  editing?: boolean;
  /** The replacement text, held until the server accepts it. */
  editText?: string;
  /** A cancellation request is on its way. */
  cancelling?: boolean;
  /** The message was replaced before entering the terminal. */
  edited?: boolean;
  /** The last edit/cancel refusal stays beside this bubble. */
  refusal?: string;
  /** MSG-ACTIONS: the message this one answers (its quote shows above the text). */
  replyTo?: ChatReply;
  /** MSG-HOLD2: opened for editing; the daemon keeps it out until a page decides. */
  held?: boolean;
  /** MSG-HOLD2: the decision this device made last: the edit cancelled or the original approved
   *  (both let the original go; a saved edit shows as `edited`). */
  holdNote?: 'editCancelled' | 'approved';
}
/** MSG-HOLD2: an edit whose message went in first (the hold came too late, another device let it
 *  go): its text is kept here, to be sent as a follow-up correction or taken back to the composer. */
export interface EditLost {
  agentId: number;
  name: string;
  text: string;
}
export interface PendingEdit {
  agentId: number;
  name: string;
  requestId: string;
  queueId: string;
  text: string;
}
/** A bubble made from the server's queue list (after a reload): requestId `q:<queue id>`. */
const QUEUED_PREFIX = 'q:';
/** Clock skew between this device and the host the transcript is written on. */
const SKEW_MS = 5 * 60_000;

/** WINMODEL: whether the messenger is open is the HUD's (`hud.open.messenger`). */
export interface MessengerSnapshot {
  /** Open conversations (agentIds), oldest first. */
  open: number[];
  /** The conversation shown; null = the contact list (phone) or none. */
  active: number | null;
  /** A group room shown in its own conversation screen. */
  activeRoom: string | null;
  /** MSG-UI2: rooms kept as tabs beside the open conversations (a room left for the list stays here). */
  openRooms: string[];
  items: Record<number, ChatItem[]>;
  canSend: Record<number, boolean>;
  slashCommands: Record<number, SlashCommandsList['commands']>;
  contacts: MessengerContact[];
  pending: Record<number, PendingSend[]>;
  /** The queued boss message currently borrowed by the composer. */
  editing: PendingEdit | null;
  /** MSG-HOLD2: the newest edit that lost the race to delivery (never dropped silently). */
  editLost: EditLost | null;
  attachments: Record<number, AttachmentChip[]>;
  /** Transcript items that settled one of this device's sends (shown as 받음). */
  received: Record<number, string[]>;
  /** Lead name -> the last reply id read on this device. */
  read: Record<string, string>;
  /** Pinned conversations (U-30): contact names and `room:<id>`, held by the daemon. */
  pinned: string[];
  /** A permission notice of this lead's background session was opened: 터미널로 보기 stands out. */
  terminalHint: number | null;
  /** Notice target waiting for the conversation to load. */
  pendingJump: { agentId: number; at: number; id?: string } | null;
  historyDone: Record<number, boolean>;
  historyBusy: Record<number, string>;
  historyError: Record<number, string>;
  searchBusy: Record<number, string>;
  searchResults: Record<number, ChatSearchResult>;
  jumpLoading: Record<number, boolean>;
  /** The conversation's items are being kept current (its chatView is on and a transcript
   *  came): false for a list held from an earlier visit, which may be behind the reply a
   *  notice is about. */
  tailLive: Record<number, boolean>;
  historyWindowed: Record<number, boolean>;
  /** Room roster/timelines are read-only state until a privileged post is made. */
  rooms: GroupRoom[];
  groupTimelines: Record<string, GroupTimeline>;
  /** Draft attachments belong to a room, rather than a one-to-one lead. */
  groupAttachments: Record<string, AttachmentChip[]>;
  /** The newest refused room write (a post, create, rename...), by its requestId. */
  groupError: { requestId: string; error: string } | null;
  /** PERM-PROMPT: the last 허용/거부 of a lead's permission card: on its way, or what it did. */
  permissionAnswers: Record<number, PermissionAnswerState>;
}
/** PERM-PROMPT: one card answer: on its way (`result` absent), done, or refused (`error`). */
export interface PermissionAnswerState {
  requestId: string;
  toolId: string;
  result?: PermissionAnswerOutcome;
  error?: string;
}

function loadRead(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(READ_KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}
function saveRead(read: Record<string, string>): void {
  try {
    localStorage.setItem(READ_KEY, JSON.stringify(read));
  } catch {
    // Private mode: this visit still remembers it.
  }
}

const initial = (): MessengerSnapshot => ({
  open: [],
  active: null,
  activeRoom: null,
  openRooms: [],
  items: {},
  canSend: {},
  slashCommands: {},
  contacts: [],
  pending: {},
  editing: null,
  editLost: null,
  attachments: {},
  received: {},
  read: loadRead(),
  pinned: [],
  terminalHint: null,
  pendingJump: null,
  historyDone: {},
  historyBusy: {},
  historyError: {},
  searchBusy: {},
  searchResults: {},
  jumpLoading: {},
  tailLive: {},
  historyWindowed: {},
  rooms: [],
  groupTimelines: {},
  groupAttachments: {},
  groupError: null,
  permissionAnswers: {},
});
let snapshot = initial();
const listeners = new Set<() => void>();
const replyListeners = new Set<(r: LeadReply) => void>();
let seq = 0;

const emit = () => listeners.forEach((l) => l());
const set = (next: Partial<MessengerSnapshot>) => {
  snapshot = { ...snapshot, ...next };
  syncRead();
  emit();
};
// Minimizing or restoring the window changes what counts as read.
hudSubscribe(() => {
  const before = snapshot.read;
  syncRead();
  if (snapshot.read !== before) emit();
});
export const messengerSubscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
export const messengerGetSnapshot = () => snapshot;
export const useMessenger = () => useSyncExternalStore(messengerSubscribe, messengerGetSnapshot);

/** Unread replies over every lead (the 메신저 icon's badge). */
export function useUnreadTotal(): number {
  const m = useMessenger();
  return (
    m.contacts.reduce((n, c) => n + unreadCount(c.replies, m.read[c.name]), 0) +
    m.rooms.reduce((n, room) => n + unreadCount(room.updates ?? [], m.read[`room:${room.id}`]), 0)
  );
}

export function setAttachments(agentId: number, chips: AttachmentChip[]): void {
  set({ attachments: { ...snapshot.attachments, [agentId]: chips } });
}

export function setGroupAttachments(roomId: string, chips: AttachmentChip[]): void {
  set({ groupAttachments: { ...snapshot.groupAttachments, [roomId]: chips } });
}

/** Older pages and live appends share a single oldest-first list. */
export function mergeItems(older: ChatItem[], held: ChatItem[], keepOldest = false): ChatItem[] {
  const seen = new Set<string>();
  const merged = [...older, ...held].filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  return keepOldest ? merged.slice(0, MAX_ITEMS) : merged.slice(-MAX_ITEMS);
}

/** Divider follows the last item of an earlier transcript. */
export function dividerAfter(items: ChatItem[], index: number): number | undefined {
  const item = items[index];
  return item?.session && items[index + 1]?.session !== item.session
    ? item.sessionStart
    : undefined;
}

/** A notice lands on the newest message (not a tool or result line, which sit between
 *  messages and are never what a notice is about) no later than its event time; only a
 *  conversation with no such message falls back to any line. */
export function jumpTarget(items: ChatItem[], at: number, id?: string): ChatItem | undefined {
  const before = [...items].reverse().filter((item) => item.at <= at);
  return (
    (id ? items.find((item) => item.id === id) : undefined) ??
    before.find((item) => item.kind === 'user' || item.kind === 'assistant') ??
    before[0]
  );
}

export type JumpStep = { step: 'wait' | 'older' } | { step: 'found'; item?: ChatItem };

/**
 * What a notice jump does with the items it has (NOTICE-JUMP): a notice names the message it is
 * about by id (a reply) or only by time. The newest earlier message is a neighbour, never the
 * answer while the real one can still arrive: an item newer than the newest loaded one, or any
 * time newer than a list that is not current (held from an earlier visit), waits for the next
 * transcript. `waitedOut` (the bounded wait ran out) and `historyDone` end the waiting; then the
 * time rule decides.
 */
export function jumpStep(
  items: ChatItem[],
  target: { at: number; id?: string },
  ctx: { live: boolean; historyDone: boolean; waitedOut: boolean },
): JumpStep {
  const named = target.id ? items.find((item) => item.id === target.id) : undefined;
  if (named) return { step: 'found', item: named };
  const newest = items.at(-1);
  // A named item's own time (ids start with `<ms>-`); the notice's time is only after it.
  const itemAt = (target.id && atOf(target.id)) || target.at;
  const ahead = !newest || itemAt > newest.at;
  if (!ctx.waitedOut && ahead && (target.id || !ctx.live)) return { step: 'wait' };
  if (items[0] && items[0].at > itemAt && !ctx.historyDone) return { step: 'older' };
  return { step: 'found', item: jumpTarget(items, target.at, target.id) };
}

// ── Pure rules (unit-tested) ─────────────────────────────────

/** Open `id`: already open stays put; a new one joins at the end, the oldest
 *  leaving when more than `max` would be open. */
export function openConversation(open: number[], id: number, max = MAX_OPEN): number[] {
  if (open.includes(id)) return open;
  return [...open, id].slice(-max);
}

/** A reply id's time (ids start with `<ms>-`). */
const atOf = (id: string) => Number(id.slice(0, id.indexOf('-'))) || 0;

/** The newest id by time (the latest listed among equals): what reading a list marks. The
 *  list's own order is not the time order (a rebuild lists posts and each member's replies
 *  by post, live ones arrive by time), so its last entry may be an older one. */
export function newestId(ids: string[]): string | undefined {
  let best: string | undefined;
  for (const id of ids) if (best === undefined || atOf(id) >= atOf(best)) best = id;
  return best;
}

/** Replies newer than the last-read one, by time (ids start with their time and survive a
 *  rebuild in another order); of equal time, the ones listed after it. Same rule for the
 *  owner's posts (never counted by the daemon) and members' replies.
 *  No mark yet: nothing unread (the device's baseline is set on first sight). */
export function unreadCount(replies: string[], readId: string | undefined): number {
  if (readId === undefined) return 0;
  const at = atOf(readId);
  const i = replies.indexOf(readId);
  return replies.filter((r, j) => atOf(r) > at || (i >= 0 && j > i && atOf(r) === at)).length;
}

/** Pinned first, then the newest activity, then by name; each group newest first (U-30). */
export function sortConversations<T extends { name: string; lastAt?: number }>(
  list: T[],
  keyOf: (item: T) => string,
  pinned: readonly string[],
): T[] {
  const pin = (c: T) => (pinned.includes(keyOf(c)) ? 1 : 0);
  return [...list].sort(
    (a, b) => pin(b) - pin(a) || (b.lastAt ?? 0) - (a.lastAt ?? 0) || a.name.localeCompare(b.name),
  );
}
export const contactKey = (c: MessengerContact): string => c.name;
export const roomKey = (r: GroupRoom): string => `room:${r.id}`;

/** Who a room may hold: `전체`'s members (the projects, i.e. their Leads) and, D3, the Workers
 *  by their own names (`전체` leaves them out, so `@전체` never wakes every Worker). */
export function roomCandidates(rooms: GroupRoom[], contacts: MessengerContact[]): string[] {
  const all = rooms.find((room) => room.id === 'all')?.members ?? [];
  const workers = contacts.filter((c) => c.project && !all.includes(c.name)).map((c) => c.name);
  return [...all, ...workers];
}

/** U-36: personal chats (개인톡) and group rooms (단톡방) are two sections; inside each, pinned
 *  first, then the newest activity. A pin never moves a conversation across sections.
 *  D3 (F-7): a Worker's chat is an advanced one: `workers` holds them per project, shown
 *  collapsed under the project's own chat (its Lead); one whose project has no chat here
 *  stays in `direct`. */
export function conversationSections(
  contacts: MessengerContact[],
  rooms: GroupRoom[],
  pinned: readonly string[],
): {
  direct: MessengerContact[];
  groups: GroupRoom[];
  workers: Record<string, MessengerContact[]>;
} {
  const leads = new Set(contacts.filter((c) => !c.project).map((c) => c.name));
  const under = (c: MessengerContact) => !!c.project && leads.has(c.project);
  const workers: Record<string, MessengerContact[]> = {};
  for (const c of sortConversations(contacts.filter(under), contactKey, pinned))
    (workers[c.project!] ??= []).push(c);
  return {
    direct: sortConversations(
      contacts.filter((c) => !under(c)),
      contactKey,
      pinned,
    ),
    groups: sortConversations(rooms, roomKey, pinned),
    workers,
  };
}

/** Pin or unpin one conversation: the daemon keeps it and tells every client. */
export function messengerPin(send: (m: SetConversationPin) => void, key: string, pinned: boolean) {
  send({ type: 'setConversationPin', key, pinned });
}

/** The server's list of the boss's queued messages is the truth for its bubbles:
 *  one it no longer lists leaves (typed in, or moved to the inbox), one no bubble
 *  of this device claims (by queue id) gets one of its own. */
export function mergeQueued(pending: PendingSend[], queued: ChatQueued[]): PendingSend[] {
  const ids = new Set(queued.map((q) => q.id));
  const out = pending.filter(
    (p) => !p.requestId.startsWith(QUEUED_PREFIX) || ids.has(p.queueId ?? ''),
  );
  for (const q of queued) {
    const i = out.findIndex((p) => p.queueId === q.id);
    if (i >= 0)
      out[i] = {
        ...out[i],
        text: q.text,
        state: q.cancelled ? 'cancelled' : 'queued',
        now: out[i].now || q.now,
        held: !!q.held,
        ...(q.messageId && { messageId: q.messageId }),
        ...(q.edited && { edited: true }),
        ...(q.cancelled && { cancelling: false }),
        ...(q.replyTo && { replyTo: q.replyTo }),
      };
    else
      out.push({
        requestId: `${QUEUED_PREFIX}${q.id}`,
        text: q.text,
        state: q.cancelled ? 'cancelled' : 'queued',
        sentAt: q.at,
        queueId: q.id,
        ...(q.messageId && { messageId: q.messageId }),
        ...(q.now && { now: true }),
        ...(q.edited && { edited: true }),
        ...(q.held && { held: true }),
        ...(q.replyTo && { replyTo: q.replyTo }),
      });
  }
  return out;
}

/** Settle sends the transcript now shows, oldest first: by message id (C2) when the
 *  prompt carries one, else (a history before C2, a `/` command) by the same text. */
export function settle(
  pending: PendingSend[],
  items: ChatItem[],
  received: string[],
): { pending: PendingSend[]; received: string[] } {
  const left = [...pending];
  const got = [...received];
  for (const item of items) {
    if (item.kind !== 'user' || got.includes(item.id)) continue;
    const byId = item.messageId
      ? left.findIndex((p) => p.state !== 'failed' && p.messageId === item.messageId)
      : -1;
    // A bubble that knows its id waits for exactly that prompt; one whose answer has not
    // come yet (no id) may still be settled by its text.
    const i =
      byId >= 0
        ? byId
        : left.findIndex(
            (p) =>
              p.state !== 'failed' &&
              !(item.messageId && p.messageId) &&
              p.text.trim() === item.text &&
              (item.at === 0 || item.at >= p.sentAt - SKEW_MS),
          );
    if (i < 0) continue;
    left.splice(i, 1);
    got.push(item.id);
  }
  return { pending: left, received: got.slice(-MAX_ITEMS) };
}

export type LeadState = 'working' | 'thinking' | 'waiting' | 'resting' | 'off';

/** A lead whose session waits on its terminal (contact.held): why nothing goes in. */
export const heldNote = (): string => t('messenger.heldNote');

/** A contact's state dot: tool activity > waiting (permission, a turn's end
 *  asking, a session held on its terminal) > busy without a tool (thinking) >
 *  idle; off when its process is. */
export function leadState(
  row: { state: string; busy: boolean | null } | undefined,
  status: TabStatus | null,
  held = false,
): LeadState {
  if (!row || row.state === 'off') return 'off';
  if (held) return 'waiting';
  if (status === 'working') return 'working';
  if (status === 'attention') return 'waiting';
  if (row.busy === true) return 'thinking';
  return 'resting';
}

/** PRESENCE-SYNC: what the messenger shows of a contact: the card bar's presence over
 *  the session's state. 퇴근 is a grey dot and the 퇴근 word (the session is alive, a
 *  message still goes through); 야근 keeps the dot of its real activity under the 야근 word. */
export function leadPresence(
  presence: Presence,
  state: LeadState,
): { dot: LeadState; word: string } {
  return {
    dot: presence === 'away' ? 'off' : state,
    word: presence ? presenceWord(presence) : t(`messenger.state.${state}`),
  };
}

// ── Drafts ──────────────────────────────────────────────────

const DRAFT_KEY = 'cld.messenger.drafts';
/** A draft is kept this long after its last edit. */
export const DRAFT_TTL_MS = 24 * 60 * 60_000;
/** MSG-ACTIONS: `reply` is the message the draft answers (답글), kept with the text. */
type Drafts = Record<string, { text: string; at: number; reply?: ChatReply }>;

function loadDrafts(): Drafts {
  try {
    const v = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Drafts) : {};
  } catch {
    return {};
  }
}
/** Keeps only live drafts; storage failures leave this visit without them. */
function saveDrafts(drafts: Drafts, now: number): void {
  const live = Object.fromEntries(
    Object.entries(drafts).filter(([, d]) => (d.text || d.reply) && now - d.at < DRAFT_TTL_MS),
  );
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(live));
  } catch {
    // Private mode: no draft survives this page.
  }
}

/** The draft key: provider and lead name (the same name may live under two providers). */
export const draftKey = (provider: string, name: string) => `${provider}:${name}`;

/** The unsent text of a conversation, or '' (none, or older than 24 h). */
export function loadDraft(key: string, now = Date.now()): string {
  const d = loadDrafts()[key];
  return d && now - d.at < DRAFT_TTL_MS ? d.text : '';
}

/** Whether this browser has any unsent, still-live messenger text. */
export function hasMessengerDraft(now = Date.now()): boolean {
  return Object.values(loadDrafts()).some((draft) => Boolean(draft.text) && now - draft.at < DRAFT_TTL_MS);
}

/** Every edit: the text (empty clears it, but not a reply the draft holds) and when. */
export function saveDraft(key: string, text: string, now = Date.now()): void {
  const drafts = loadDrafts();
  const reply = drafts[key]?.reply;
  if (text || reply) drafts[key] = { text, at: now, ...(reply && { reply }) };
  else delete drafts[key];
  saveDrafts(drafts, now);
}

/** MSG-ACTIONS: the message a conversation's draft answers, or null. */
export function loadDraftReply(key: string, now = Date.now()): ChatReply | null {
  const d = loadDrafts()[key];
  return d?.reply && now - d.at < DRAFT_TTL_MS ? d.reply : null;
}

/** MSG-ACTIONS: set (or with null clear) the message the draft answers; the text stays. */
export function saveDraftReply(key: string, reply: ChatReply | null, now = Date.now()): void {
  const drafts = loadDrafts();
  const text = drafts[key]?.text ?? '';
  if (text || reply) drafts[key] = { text, at: now, ...(reply && { reply }) };
  else delete drafts[key];
  saveDrafts(drafts, now);
}

// ── Messages ────────────────────────────────────────────────

export interface LeadReply {
  agentId: number;
  name: string;
  preview: string;
  /** The ChatItem id of the reply (the contact's newest), so its notice opens on that message. */
  itemId?: string;
  /** ROOM-NOTICE: the reply is a room turn's (the lead's text in that room), not its one-to-one chat. */
  room?: { name: string; id: string | null; post: string | null };
}

/** T-0039's bell/toast: a lead's new reply (not one the boss is reading right now). */
export function onLeadReply(listener: (r: LeadReply) => void): () => void {
  replyListeners.add(listener);
  return () => {
    replyListeners.delete(listener);
  };
}

/** The panel is open and in sight: a minimized window (or a phone tab not shown) is not being read. */
const inSight = () => windowShown('messenger');
const reading = (agentId: number) => inSight() && snapshot.active === agentId;
/** Lead `agentId`'s conversation is on screen (T-0039's chatOpenFor: you are looking at it). */
export const messengerShowing = reading;

/** C3: the room whose post lead `agentId`'s newest turn answers (the server's call), or null. */
export function turnRoomOf(
  agentId: number,
): { name: string; id: string | null; post: string | null } | null {
  return roomOfContact(snapshot.contacts.find((x) => x.agentId === agentId));
}
function roomOfContact(
  c: MessengerContact | undefined,
): { name: string; id: string | null; post: string | null } | null {
  if (!c?.room) return null;
  // A turn the messenger did not type is known by its header's name only: the room list has the id.
  const id = c.roomId ?? snapshot.rooms.find((r) => r.name === c.room)?.id ?? null;
  return { name: c.room, id, post: c.roomPost ?? null };
}
/** C3: room `id`'s conversation is on screen. */
export const roomShowing = (id: string): boolean => inSight() && snapshot.activeRoom === id;

export function messengerHandleMessage(
  msg:
    | ChatTranscript
    | ChatSendResult
    | ChatPendingResult
    | ChatHistoryResult
    | ChatSearchResult
    | GroupRooms
    | GroupTimeline
    | GroupActionResult
    | PinnedConversations
    | SlashCommandsList
    | PermissionAnswerResult
    | { type: 'messengerContacts'; contacts: MessengerContact[] },
): void {
  if (msg.type === 'pinnedConversations') {
    set({ pinned: msg.keys });
    return;
  }
  if (msg.type === 'groupRooms') {
    const read = { ...snapshot.read };
    let baseline = false;
    for (const room of msg.rooms) {
      const key = `room:${room.id}`;
      const last = newestId(room.updates ?? []);
      if (read[key] === undefined) {
        // A room first seen empty (only the boss's own post, which never counts since U-50):
        // its first replies must still read as unread, so the baseline is the start of time.
        read[key] = last ?? '0-';
        baseline = true;
      }
    }
    if (baseline) saveRead(read);
    // A deleted room closes its screen (the list on a phone, the empty pane on a desktop).
    const gone =
      snapshot.activeRoom !== null && !msg.rooms.some((x) => x.id === snapshot.activeRoom);
    const openRooms = snapshot.openRooms.filter((id) => msg.rooms.some((x) => x.id === id));
    set({
      rooms: msg.rooms,
      read,
      ...(gone && { activeRoom: null }),
      ...(openRooms.length !== snapshot.openRooms.length && { openRooms }),
    });
    return;
  }
  if (msg.type === 'groupActionResult') {
    set({
      groupError: msg.ok
        ? null
        : { requestId: msg.requestId, error: serverText(msg, t('messenger.error.room')) },
    });
    return;
  }
  if (msg.type === 'groupTimeline') {
    set({ groupTimelines: { ...snapshot.groupTimelines, [msg.room.id]: msg } });
    return;
  }
  if (msg.type === 'slashCommandsList') {
    set({ slashCommands: { ...snapshot.slashCommands, [msg.agentId]: msg.commands } });
    return;
  }
  if (msg.type === 'chatHistoryResult') {
    if (snapshot.historyBusy[msg.agentId] !== msg.requestId) return;
    const busy = { ...snapshot.historyBusy };
    delete busy[msg.agentId];
    set({
      historyBusy: busy,
      historyDone: { ...snapshot.historyDone, [msg.agentId]: msg.done },
      historyError: { ...snapshot.historyError, [msg.agentId]: serverText(msg) },
      items: {
        ...snapshot.items,
        [msg.agentId]: mergeItems(
          msg.items,
          snapshot.items[msg.agentId] ?? [],
          snapshot.jumpLoading[msg.agentId],
        ),
      },
      historyWindowed: {
        ...snapshot.historyWindowed,
        [msg.agentId]:
          snapshot.historyWindowed[msg.agentId] ||
          (!!snapshot.jumpLoading[msg.agentId] &&
            msg.items.length + (snapshot.items[msg.agentId]?.length ?? 0) > MAX_ITEMS),
      },
    });
    return;
  }
  if (msg.type === 'chatSearchResult') {
    if (snapshot.searchBusy[msg.agentId] !== msg.requestId) return;
    const busy = { ...snapshot.searchBusy };
    delete busy[msg.agentId];
    set({ searchBusy: busy, searchResults: { ...snapshot.searchResults, [msg.agentId]: msg } });
    return;
  }
  if (msg.type === 'messengerContacts') {
    const read = { ...snapshot.read };
    let baseline = false;
    for (const c of msg.contacts) {
      const prev = snapshot.contacts.find((p) => p.name === c.name);
      const last = c.replies.at(-1);
      if (read[c.name] === undefined && last) {
        read[c.name] = last; // first sight on this device: nothing unread yet
        baseline = true;
      }
      if (prev && last && prev.replies.at(-1) !== last && !reading(c.agentId))
        for (const l of replyListeners)
          l({ agentId: c.agentId, name: c.name, preview: serverLine(c.preview ?? ''), itemId: last });
      // ROOM-NOTICE: a new text reply in a room turn: its own notice (the room on screen is
      // judged in the notice rules, not by the lead's one-to-one chat being open).
      const room = c.roomReply && prev && prev.roomReply?.id !== c.roomReply.id ? roomOfContact(c) : null;
      if (room && c.roomReply)
        for (const l of replyListeners)
          l({ agentId: c.agentId, name: c.name, preview: serverLine(c.roomReply.text), room });
    }
    if (baseline) saveRead(read);
    set({ contacts: msg.contacts, read });
    return;
  }
  if (msg.type === 'chatTranscript') {
    const prev = snapshot.items[msg.agentId] ?? [];
    const items = msg.append ? mergeItems(prev, msg.items) : msg.items;
    const s = settle(
      snapshot.pending[msg.agentId] ?? [],
      msg.items,
      snapshot.received[msg.agentId] ?? [],
    );
    set({
      items: { ...snapshot.items, [msg.agentId]: items },
      tailLive: { ...snapshot.tailLive, [msg.agentId]: true },
      canSend: { ...snapshot.canSend, [msg.agentId]: msg.canSend },
      pending: {
        ...snapshot.pending,
        [msg.agentId]: msg.queued ? mergeQueued(s.pending, msg.queued) : s.pending,
      },
      received: { ...snapshot.received, [msg.agentId]: s.received },
      ...(!msg.append && { historyDone: { ...snapshot.historyDone, [msg.agentId]: false } }),
      ...(!msg.append && {
        historyWindowed: { ...snapshot.historyWindowed, [msg.agentId]: false },
      }),
    });
    return;
  }
  if (msg.type === 'permissionAnswerResult') {
    const mine = snapshot.permissionAnswers[msg.agentId];
    if (mine?.requestId !== msg.requestId) return;
    set({
      permissionAnswers: {
        ...snapshot.permissionAnswers,
        [msg.agentId]: { ...mine, ...(msg.ok ? { result: msg.result ?? 'failed' } : { error: serverText(msg) }) },
      },
    });
    return;
  }
  if (msg.type === 'chatPendingResult') {
    for (const [id, list] of Object.entries(snapshot.pending)) {
      const i = list.findIndex((p) => p.queueId === msg.id && (p.editing || p.cancelling));
      if (i < 0) continue;
      const next = [...list];
      const p = next[i];
      if (p.editing) {
        // MSG-HOLD2 (7): it went in before the edit: the bubble stays as delivered (never "edited")
        // and the edited words wait in editLost for a correction message.
        const lost = !msg.ok && msg.gone && p.editText !== undefined;
        next[i] = {
          ...p,
          editing: false,
          ...(msg.ok
            ? { text: p.editText ?? p.text, edited: true, held: false, refusal: undefined }
            : lost
              ? { held: false }
              : { refusal: serverText(msg) }),
          editText: undefined,
        };
        if (lost) {
          set({
            pending: { ...snapshot.pending, [id]: next },
            editLost: { agentId: Number(id), name: msg.name, text: p.editText! },
          });
          return;
        }
      } else {
        next[i] = {
          ...p,
          cancelling: false,
          ...(msg.ok ? { state: 'cancelled', refusal: undefined } : { refusal: serverText(msg) }),
        };
      }
      set({ pending: { ...snapshot.pending, [id]: next } });
      return;
    }
    return;
  }
  for (const [id, list] of Object.entries(snapshot.pending)) {
    const i = list.findIndex((p) => p.requestId === msg.requestId);
    if (i < 0) continue;
    if (list[i].promoting) {
      // 지금 보내기's answer: refused (typed meanwhile, say) leaves the bubble as it was.
      const next = [...list];
      next[i] = { ...list[i], promoting: false, now: msg.ok };
      set({ pending: { ...snapshot.pending, [id]: next } });
      return;
    }
    const state: SendState = !msg.ok
      ? 'failed'
      : msg.delivered === 'queued'
        ? 'queued'
        : msg.delivered === 'inbox'
          ? msg.queueId
            ? 'queued'
            : 'inbox'
          : 'sent';
    const queueId = msg.queueId;
    // A bubble the queue list made for this message meanwhile gives way to this one.
    const next = list.filter((p) => !queueId || p.requestId !== `${QUEUED_PREFIX}${queueId}`);
    const j = next.findIndex((p) => p.requestId === msg.requestId);
    next[j] = {
      ...list[i],
      state,
      ...(msg.error && { error: serverText(msg) }),
      ...(queueId && { queueId }),
      ...(msg.messageId && { messageId: msg.messageId }),
    };
    set({ pending: { ...snapshot.pending, [id]: next } });
    return;
  }
}

/** Mark what the boss is looking at as read. */
function syncRead(): void {
  const roomId = snapshot.activeRoom;
  if (inSight() && roomId) {
    const room = snapshot.rooms.find((x) => x.id === roomId);
    const last = newestId(room?.updates ?? []);
    const key = `room:${roomId}`;
    if (last && snapshot.read[key] !== last) {
      snapshot = { ...snapshot, read: { ...snapshot.read, [key]: last } };
      saveRead(snapshot.read);
    }
  }
  const id = snapshot.active;
  if (!inSight() || id === null) return;
  const c = snapshot.contacts.find((x) => x.agentId === id);
  const last = c?.replies.at(-1);
  if (!c || !last || snapshot.read[c.name] === last) return;
  snapshot = { ...snapshot, read: { ...snapshot.read, [c.name]: last } };
  saveRead(snapshot.read);
}

// ── Actions ─────────────────────────────────────────────────

/** The 메신저 tab, a card's 대화 or a notice (with its lead; `terminal`: a
 *  permission ask that may need the terminal). */
export function openMessenger(
  agentId?: number,
  opts: { terminal?: boolean; at?: number; id?: string } = {},
): void {
  openWindow('messenger'); // in front, as it was (a minimized one comes back)
  if (agentId === undefined) return;
  set({
    open: openConversation(snapshot.open, agentId),
    active: agentId,
    activeRoom: null,
    terminalHint: opts.terminal ? agentId : null,
    pendingJump:
      opts.at === undefined ? null : { agentId, at: opts.at, ...(opts.id && { id: opts.id }) },
  });
}

export function clearPendingJump(agentId: number): void {
  if (snapshot.pendingJump?.agentId === agentId) set({ pendingJump: null });
}

export function requestHistory(agentId: number, requestId: string): void {
  set({
    historyBusy: { ...snapshot.historyBusy, [agentId]: requestId },
    historyError: { ...snapshot.historyError, [agentId]: '' },
  });
  // No answer: stop waiting (a late reply no longer matches) so a retry can go out.
  setTimeout(() => {
    if (snapshot.historyBusy[agentId] !== requestId) return;
    const busy = { ...snapshot.historyBusy };
    delete busy[agentId];
    set({
      historyBusy: busy,
      historyError: { ...snapshot.historyError, [agentId]: t('messenger.error.history') },
    });
  }, CHAT_REQUEST_TIMEOUT_MS);
}

export function requestSearch(agentId: number, requestId: string): void {
  set({ searchBusy: { ...snapshot.searchBusy, [agentId]: requestId } });
  setTimeout(() => {
    if (snapshot.searchBusy[agentId] !== requestId) return;
    const busy = { ...snapshot.searchBusy };
    delete busy[agentId];
    set({
      searchBusy: busy,
      searchResults: {
        ...snapshot.searchResults,
        [agentId]: {
          type: 'chatSearchResult',
          requestId,
          agentId,
          hits: [],
          truncated: false,
          error: t('messenger.error.search'),
        },
      },
    });
  }, CHAT_REQUEST_TIMEOUT_MS);
}

export function setJumpLoading(agentId: number, on: boolean): void {
  set({ jumpLoading: { ...snapshot.jumpLoading, [agentId]: on } });
}

export function closeMessenger(): void {
  closeWindow('messenger');
}

/** Show an open conversation, or the list (null; the phone's back). */
export function showConversation(agentId: number | null): void {
  set({ active: agentId, activeRoom: null });
}

/** C3: open room `id` (a notice's click); false while the room list does not have it. */
export function showRoomById(id: string): boolean {
  if (!snapshot.rooms.some((r) => r.id === id)) return false;
  showRoom(id);
  return true;
}

/** Open a room as a peer of the one-to-one conversations (phone back returns to the list). */
export function showRoom(roomId: string): void {
  openWindow('messenger');
  set({
    active: null,
    activeRoom: roomId,
    openRooms: snapshot.openRooms.includes(roomId) ? snapshot.openRooms : [...snapshot.openRooms, roomId],
  });
}

/** MSG-UI2: close a room's tab; when it was the one shown, the last open conversation or room comes up. */
export function closeRoomTab(roomId: string): void {
  const openRooms = snapshot.openRooms.filter((id) => id !== roomId);
  if (snapshot.activeRoom !== roomId) return set({ openRooms });
  const next = openRooms.at(-1);
  set({
    openRooms,
    active: next === undefined ? (snapshot.open.at(-1) ?? null) : null,
    activeRoom: next ?? null,
  });
}

export function showMessengerList(): void {
  set({ active: null, activeRoom: null });
}

/** The conversation's chatView went off: what is held is no longer kept current. */
export function chatViewClosed(agentId: number): void {
  if (snapshot.tailLive[agentId]) set({ tailLive: { ...snapshot.tailLive, [agentId]: false } });
}

export function closeConversation(agentId: number): void {
  const open = snapshot.open.filter((id) => id !== agentId);
  set({ open, active: snapshot.active === agentId ? (open.at(-1) ?? null) : snapshot.active });
}

/** 보내기 (`now`: 즉시 보내기): a bubble at once, then what the daemon made of it. */
export function messengerSend(
  send: (m: ChatSend) => void,
  connected: boolean,
  agentId: number,
  name: string,
  text: string,
  now = false,
  replyTo?: ChatReply,
): void {
  const requestId = `${Date.now().toString(36)}-m${++seq}`;
  const sentAt = Date.now();
  const reply = replyTo && { replyTo };
  const bubble: PendingSend = connected
    ? { requestId, text, state: 'sending', sentAt, ...(now && { now }), ...reply }
    : {
        requestId,
        text,
        state: 'failed',
        error: t('messenger.error.disconnectedSend'),
        sentAt,
        ...reply,
      };
  set({
    pending: { ...snapshot.pending, [agentId]: [...(snapshot.pending[agentId] ?? []), bubble] },
  });
  if (connected) send({ type: 'chatSend', requestId, name, text, ...(now && { now }), ...reply });
}

/** PERM-PROMPT: 허용 (`allow`) or 거부 on a lead's permission card about call `toolId`. */
export function messengerAnswerPermission(
  send: (m: PermissionAnswer) => void,
  agentId: number,
  toolId: string,
  allow: boolean,
): void {
  if (snapshot.permissionAnswers[agentId] && !snapshot.permissionAnswers[agentId].result && !snapshot.permissionAnswers[agentId].error)
    return; // one answer at a time
  const requestId = `${Date.now().toString(36)}-p${++seq}`;
  set({ permissionAnswers: { ...snapshot.permissionAnswers, [agentId]: { requestId, toolId } } });
  send({ type: 'permissionAnswer', requestId, agentId, toolId, allow });
}

/** 지금 보내기 on a queued bubble: it may go in while the lead works. */
export function messengerSendNow(
  send: (m: ChatSendNow) => void,
  agentId: number,
  name: string,
  requestId: string,
): void {
  const list = snapshot.pending[agentId] ?? [];
  const p = list.find((x) => x.requestId === requestId);
  if (!p?.queueId || p.promoting) return;
  set({
    pending: {
      ...snapshot.pending,
      [agentId]: list.map((x) => (x === p ? { ...x, promoting: true } : x)),
    },
  });
  send({ type: 'chatSendNow', requestId, name, id: p.queueId });
}

/** Put a queued bubble's words in the composer and keep it in the queue. */
export function messengerEditEnter(
  send: (m: ChatHold) => void,
  agentId: number,
  name: string,
  requestId: string,
): boolean {
  const p = (snapshot.pending[agentId] ?? []).find((item) => item.requestId === requestId);
  if (!p?.queueId || p.state !== 'queued' || p.editing || p.cancelling) return false;
  set({
    editing: { agentId, name, requestId, queueId: p.queueId, text: p.text },
    pending: patchPending(agentId, requestId, { held: true, holdNote: undefined }),
  });
  send({ type: 'chatHold', name, id: p.queueId, on: true });
  return true;
}

/** One bubble changed in place (by requestId). */
function patchPending(
  agentId: number,
  requestId: string,
  patch: Partial<PendingSend>,
): Record<number, PendingSend[]> {
  const list = snapshot.pending[agentId] ?? [];
  return {
    ...snapshot.pending,
    [agentId]: list.map((p) => (p.requestId === requestId ? { ...p, ...patch } : p)),
  };
}

/** 고치기 취소 (MSG-HOLD2 "edit cancelled"): the original stays as it was and may go in. */
export function messengerEditLeave(send: (m: ChatHold) => void): void {
  const edit = snapshot.editing;
  if (!edit) return;
  set({
    editing: null,
    pending: patchPending(edit.agentId, edit.requestId, { held: false, holdNote: 'editCancelled' }),
  });
  send({ type: 'chatHold', name: edit.name, id: edit.queueId, on: false });
}

/** The composer went away mid-edit (another conversation, the panel closed): no decision was
 *  made, so the message stays held and its bubble offers the choices (MSG-HOLD2 4). */
export function messengerEditPark(): void {
  if (snapshot.editing) set({ editing: null });
}

/** 원래대로 보내기 (MSG-HOLD2 "send approved"): a held message goes as it was. */
export function messengerApproveHeld(
  send: (m: ChatHold) => void,
  agentId: number,
  name: string,
  requestId: string,
): void {
  const p = (snapshot.pending[agentId] ?? []).find((x) => x.requestId === requestId);
  if (!p?.queueId || !p.held) return;
  if (snapshot.editing?.queueId === p.queueId) set({ editing: null });
  set({ pending: patchPending(agentId, requestId, { held: false, holdNote: 'approved' }) });
  send({ type: 'chatHold', name, id: p.queueId, on: false });
}

/** The lost edit's notice is done with (sent as a correction, taken back, or dismissed). */
export function messengerEditLostClear(): void {
  if (snapshot.editLost) set({ editLost: null });
}

/** Save the composer back into the same pending message instead of making a new send. */
export function messengerEditSave(send: (m: ChatEdit) => void, text: string): boolean {
  const edit = snapshot.editing;
  if (!edit) return false;
  const list = snapshot.pending[edit.agentId] ?? [];
  const i = list.findIndex((p) => p.requestId === edit.requestId && p.queueId === edit.queueId);
  if (!text.trim()) return false;
  if (i < 0 || list[i].state !== 'queued') {
    // MSG-HOLD2 (7): it went in meanwhile: the edit becomes a correction offer, never dropped.
    set({ editing: null, editLost: { agentId: edit.agentId, name: edit.name, text } });
    return true;
  }
  const next = [...list];
  next[i] = { ...next[i], editing: true, editText: text, refusal: undefined };
  set({ pending: { ...snapshot.pending, [edit.agentId]: next }, editing: null });
  send({
    type: 'chatEdit',
    requestId: `edit:${edit.queueId}:${++seq}`,
    name: edit.name,
    id: edit.queueId,
    text,
  });
  return true;
}

/** Cancel a queued bubble without a confirmation dialog. */
export function messengerCancel(
  send: (m: ChatCancel) => void,
  agentId: number,
  name: string,
  requestId: string,
): void {
  const list = snapshot.pending[agentId] ?? [];
  const i = list.findIndex((p) => p.requestId === requestId);
  const p = list[i];
  if (!p?.queueId || p.state !== 'queued' || p.editing || p.cancelling) return;
  const next = [...list];
  next[i] = { ...p, cancelling: true, refusal: undefined };
  set({ pending: { ...snapshot.pending, [agentId]: next } });
  send({ type: 'chatCancel', requestId: `cancel:${p.queueId}:${++seq}`, name, id: p.queueId });
}

/** Drop a failed bubble. */
export function dismissSend(agentId: number, requestId: string): void {
  const list = (snapshot.pending[agentId] ?? []).filter((p) => p.requestId !== requestId);
  set({ pending: { ...snapshot.pending, [agentId]: list } });
}

/** The socket dropped: results of sends on their way can no longer arrive. */
export function messengerConnectionLost(): void {
  let changed = false;
  const pending: Record<number, PendingSend[]> = {};
  for (const [id, list] of Object.entries(snapshot.pending)) {
    pending[Number(id)] = list.map((p) => {
      if (p.promoting) {
        changed = true;
        return { ...p, promoting: false };
      }
      if (p.state !== 'sending') return p;
      changed = true;
      return { ...p, state: 'failed', error: t('messenger.error.disconnectedResult') };
    });
  }
  // PERM-PROMPT: an answer on its way never hears back on this connection.
  const permissionAnswers = Object.fromEntries(
    Object.entries(snapshot.permissionAnswers).map(([id, a]) => [
      id,
      a.result || a.error ? a : { ...a, error: t('messenger.error.disconnectedResult') },
    ]),
  );
  const lost = Object.values(snapshot.permissionAnswers).some((a) => !a.result && !a.error);
  if (changed || lost) set({ pending, ...(lost && { permissionAnswers }) });
}

/** Tests: a fresh store. */
export function messengerResetForTests(): void {
  closeWindow('messenger');
  snapshot = initial();
  emit();
}
