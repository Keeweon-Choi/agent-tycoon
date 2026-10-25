/**
 * T-0039 notice rules, shared by the screen (toast, sound, bell) and the
 * daemon (Web Push), so both decide alike (FR-NTF-002/003/005): each kind can
 * be off; the same kind for the same target at most once per cooldown;
 * nothing loud for what the user is looking at; turn ends of sub-agents and
 * teammates only when asked for. Pure, no runtime side effects.
 */
import { NOTICE_COOLDOWN_MS, PUSH_ATTENTION_COOLDOWN_MS } from '../constants.js';
import { koText } from './serverText.js';

/** `reply` (T-0043; U-49 pushed too): a lead's message to the user, with its text. */
export type NoticeKind = 'turnEnd' | 'attention' | 'job' | 'reply';
/** What the daemon reported: a turn end, a question, a permission ask, a job. */
export type NoticeCause = 'turnEnd' | 'question' | 'permission' | 'job' | 'reply';

export const KIND_OF: Record<NoticeCause, NoticeKind> = {
  turnEnd: 'turnEnd',
  question: 'attention',
  permission: 'attention',
  job: 'job',
  reply: 'reply',
};
export const NOTICE_ICON: Record<NoticeCause, string> = {
  turnEnd: '🔔',
  question: '✋',
  permission: '🔐',
  job: '🏁',
  reply: '💬',
};
export const CAUSE_TEXT: Record<Exclude<NoticeCause, 'job' | 'reply'>, string> = {
  turnEnd: koText('cause_turn_end'),
  question: koText('cause_question'),
  permission: koText('cause_permission'),
};
/**
 * O3: the push that tells the other devices a new one came in. Words only; the
 * time is filled in by the service worker in the phone's own time zone.
 */
export const DEVICE_PUSH_TITLE = {
  new: koText('dev_new'),
  unknown: koText('dev_new'),
  replaced: koText('dev_replaced'),
  passkey: koText('dev_passkey'),
} as const;
export const DEVICE_PUSH_KIND = {
  phone: koText('dev_kind_phone'),
  tablet: koText('dev_kind_tablet'),
  desktop: koText('dev_kind_desktop'),
  unknown: koText('dev_kind_unknown'),
} as const;
export const DEVICE_PUSH_VIA = {
  local: koText('dev_via_local'),
  lan: koText('dev_via_lan'),
  remote: koText('dev_via_remote'),
} as const;
/** In a push body, where the service worker puts the event's time. */
export const PUSH_TIME_MARK = '{time}';
export const DEVICE_ICON = '🔐';

/** What the rules read of a device's settings. */
export interface NoticeRules {
  /** Absent: on (a device that saved its kinds before one was added). */
  kinds: Partial<Record<NoticeKind, boolean>>;
  /** Turn ends of sub-agents and teammates too (off: orchestrators only). */
  subagents: boolean;
  /** FR-NTF-006: turn ends of orchestrators with remote-control on (the Claude
   *  app pushes those too). Absent: on. */
  remoteTurnEnds?: boolean;
}

export interface NoticeEvent {
  cause: NoticeCause;
  /** The cooldown's target: the character, or the name when there is none. */
  target: string;
  /** The character's kind (kinds.ts): 'subagent' and 'teammate' are the noisy ones, and 'worker'
   *  (K1: an engine Worker, whose routine progress reaches the owner through its Lead). */
  who: string;
  /** Its remote-control is on (only the daemon knows; FR-NTF-006). */
  remote?: boolean;
  at: number;
}

export type Verdict = 'off' | 'cooldown' | 'quiet' | 'loud';

/**
 * The rules, pure. `last` holds when each kind:target last got through and
 * is updated for 'quiet' and 'loud' (what you looked at counts as seen).
 */
export function noticeVerdict(
  ev: NoticeEvent,
  settings: NoticeRules,
  last: Map<string, number>,
  looking: boolean,
  /** Web Push: asks come through again after a minute (the screen keeps 5). */
  push = false,
): Verdict {
  const kind = KIND_OF[ev.cause];
  if (settings.kinds[kind] === false) return 'off';
  // U-49: a message replaces the turn end it came with, so it follows the turn end's rules.
  const endsTurn = ev.cause === 'turnEnd' || ev.cause === 'reply';
  if (endsTurn && !settings.subagents && (ev.who === 'subagent' || ev.who === 'teammate' || ev.who === 'worker'))
    return 'off';
  if (endsTurn && ev.remote && settings.remoteTurnEnds === false) return 'off';
  const key = `${kind}:${ev.target}`;
  const prev = last.get(key);
  const cooldown = push && kind === 'attention' ? PUSH_ATTENTION_COOLDOWN_MS : NOTICE_COOLDOWN_MS;
  // U-49: a pushed message is never dropped for coming soon after another (its tag makes the
  // newest replace the one shown); the screen still folds them.
  if (prev !== undefined && ev.at - prev < cooldown && !(push && kind === 'reply'))
    return 'cooldown';
  last.set(key, ev.at);
  return looking ? 'quiet' : 'loud';
}

/**
 * Where a notice opens (T-0043, the 10-22 01:3x ask): a lead's conversation
 * in the messenger (`terminal`: a permission ask of a background session,
 * which may need its terminal), a job card, a Codex task, or the character.
 * The same in the app and in a Web Push's url.
 */
export type NoticeTarget =
  /** `id`: the ChatItem a reply notice announces, so the jump lands on it, not on a neighbour by time. */
  | { open: 'chat'; lead: string; terminal?: boolean; at?: number; id?: string }
  /** C3: a room's conversation (by its id: a name may hold characters a url refuses), where a turn answering its post ended. */
  | { open: 'room'; room: string }
  | { open: 'job'; id: string | null }
  | { open: 'codex'; id: string | null }
  | { open: 'agent'; agentId: number }
  /** C6: a delegation waiting for approval: the 작업실's Task tab of that project, where its card is. */
  | { open: 'workbench'; project: string }
  /** O3: a new device came in: the 보안 panel, where the device list and the record are. */
  | { open: 'security' }
  | { open: 'office' };

/** The target of a notice the rules let through: `lead` when the character is a lead (a world entry). */
export function noticeTarget(n: {
  cause: NoticeCause;
  agentId: number | null;
  /** The lead's name when the character is one (an orchestrator, Claude session, ops). */
  lead?: string | null;
  /** The lead's session is a background one (attachable). */
  background?: boolean;
  /** Time of the event that made this notice, in milliseconds. */
  at?: number;
  /** reply: the ChatItem id of the message. */
  itemId?: string;
  /** job: the feed event's kind and ref. */
  event?: { kind: string; ref?: string | null };
}): NoticeTarget {
  if (n.cause === 'job') {
    const id = n.event?.ref ?? null;
    return n.event?.kind === 'codex_end' ? { open: 'codex', id } : { open: 'job', id };
  }
  if (n.lead)
    return {
      open: 'chat',
      lead: n.lead,
      ...(n.at !== undefined && { at: n.at }),
      ...(n.itemId && { id: n.itemId }),
      ...(n.cause === 'permission' && n.background && { terminal: true }),
    };
  return n.agentId === null ? { open: 'office' } : { open: 'agent', agentId: n.agentId };
}

/**
 * The tag a push is shown under: the same event again REPLACES the one in the
 * tray instead of stacking. Turn ends share one slot (a burst is one entry;
 * the bell list keeps each); asks and job ends are per character / job, so
 * one never replaces another's. Never a reason to drop a push.
 */
export function pushTag(
  cause: NoticeCause,
  agentId: number | null,
  name: string,
  target: NoticeTarget,
): string {
  if (cause === 'turnEnd') return target.open === 'room' ? `turnEnd:room:${target.room}:${name}` : 'turnEnd';
  if (cause === 'job') {
    const id = target.open === 'job' || target.open === 'codex' ? target.id : null;
    return `job:${id ?? agentId ?? name}`;
  }
  // U-49: one slot per conversation (a lead's chat, one member in a room): the newest message
  // replaces the previous one; another sender never does.
  if (cause === 'reply')
    return `reply:${target.open === 'room' ? `room:${target.room}:` : ''}${agentId ?? name}`;
  return `${KIND_OF[cause]}:${agentId ?? name}`;
}

/** A push's url for a target: only names and ids, never a command. */
export function noticeUrl(t: NoticeTarget): string {
  const q = new URLSearchParams();
  if (t.open === 'chat') {
    q.set('open', 'chat');
    q.set('lead', t.lead);
    if (t.terminal) q.set('terminal', '1');
    if (t.at !== undefined) q.set('at', String(t.at));
    if (t.id) q.set('id', t.id);
  } else if (t.open === 'room') {
    q.set('open', 'room');
    q.set('room', t.room);
  } else if (t.open === 'security') {
    q.set('open', 'security');
  } else if (t.open === 'job' || t.open === 'codex') {
    q.set('open', t.open);
    if (t.id) q.set('id', t.id);
  } else if (t.open === 'agent') q.set('agent', String(t.agentId));
  const s = q.toString();
  return s ? `/?${s}` : '/';
}

/** sessionStorage key: a target whose page showed the login first (T-0043), opened once logged in. */
export const OPEN_TARGET_KEY = 'cld.open-target';

/** A lead's name as a url may carry it: no control or markup characters, at most 80. */
const SAFE_NAME = /^[^\p{C}<>"'`&\\/]{1,80}$/u;
/** A job's or Codex task's id: engine ids, `pid:<n>`, Codex ids. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;

/**
 * The target a url's query names (`?open=chat|room|job|codex`, or the older
 * `?agent=<id>`), or null: any other `open` kind, or a name or id outside
 * the safe shapes, is refused (a url is attacker-typable).
 */
export function parseNoticeUrl(search: string): NoticeTarget | null {
  const q = new URLSearchParams(search.startsWith('/?') ? search.slice(1) : search);
  const open = q.get('open');
  const id = q.get('id');
  const lead = q.get('lead');
  const rawAt = q.get('at');
  const at =
    rawAt !== null && /^\d{1,16}$/.test(rawAt) && Number.isSafeInteger(Number(rawAt))
      ? Number(rawAt)
      : undefined;
  if (open === 'chat')
    return lead && SAFE_NAME.test(lead)
      ? {
          open: 'chat',
          lead,
          ...(q.get('terminal') === '1' && { terminal: true }),
          ...(at !== undefined && { at }),
          ...(id && SAFE_ID.test(id) && { id }),
        }
      : null;
  if (open === 'security') return { open: 'security' };
  if (open === 'room') {
    const room = q.get('room');
    return room && SAFE_ID.test(room) ? { open: 'room', room } : null;
  }
  if (open === 'job' || open === 'codex') {
    if (id === null || id === '') return { open, id: null };
    return SAFE_ID.test(id) ? { open, id } : null;
  }
  if (open !== null) return null;
  const agent = q.get('agent');
  return agent !== null && /^-?\d{1,12}$/.test(agent)
    ? { open: 'agent', agentId: Number(agent) }
    : null;
}
