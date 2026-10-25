/** Append-only room posts, their tagged fan-out, and delivery-state folding. */
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { koText, pickRefusal, refused, type WithError } from '../../../../core/src/cld/serverText.js';
import type { ChatItem, ChatReply } from '../../../../core/src/messages.js';
import {
  CHAT_TAIL_BYTES,
  lineItems,
  type LineOptions,
  turnMessageId,
  userTurnText,
} from '../transcriptView.js';
import { ALL_GROUP_ID, type GroupRoom, GroupStore, groupTimelineDir } from './groups.js';
import type { QueuedSend, SendResult } from './messenger.js';
import { cleanText, MESSAGE_ID, newMessageId, replyRef, TEXT_MAX } from './messenger.js';

export type GroupDelivery = 'pending' | 'delivered' | 'held' | 'off';
export interface GroupPost {
  id: string;
  at: number;
  sender: string | null;
  text: string;
  targets: string[];
  delivery: Record<string, GroupDelivery>;
  /** The room's name at posting time: it is in the header the members' transcripts hold, so a
   *  rename must not orphan the replies. Kept off the wire. */
  roomName?: string;
  /** C2: each member's delivery id (its header's mark), so the room finds exactly the
   *  reply to this post. Absent on posts made before C2. Kept off the wire (GroupReply has it). */
  messageIds?: Record<string, string>;
  /** MSG-ACTIONS: the message this post answers (replyRef); every target's delivery carries it. */
  replyTo?: ChatReply;
  /** C4: a one-line system event (systemLine), delivered to nobody. */
  system?: true;
}
export interface GroupReply {
  member: string;
  messageId?: string;
  items: ChatItem[];
}
export type GroupTimelinePost = GroupPost & { replies: GroupReply[] };
type TimelineRecord =
  | { v: 1; kind: 'post'; post: GroupPost }
  | { v: 1; kind: 'delivery'; id: string; member: string; state: GroupDelivery };

export interface GroupMessenger {
  send(req: {
    to: string;
    text: string;
    ifIdle: boolean;
    from: string | null;
    source: string;
    created?: number;
    group?: QueuedSend['group'];
    messageId?: string;
    replyTo?: ChatReply;
  }): Promise<SendResult>;
  /** TOKEN-GUARD: record a delivery the room refused (Messenger.guard). */
  guard?(fields: Record<string, unknown>): void;
}

export interface GroupMessagesOptions {
  home: string;
  store: GroupStore;
  messenger: GroupMessenger;
  now?: () => number;
  ids?: () => string;
  changed?: (roomId: string) => void;
}

const BOSS = '사장';

/** C4 (F-18): the collaboration events a room shows as one line. Lookups (list_agents,
 *  get_task_status, get_group_context) are never among them: they stay in the event log. */
export interface SystemEvent {
  kind: 'assigned' | 'reported' | 'conflict' | 'merged';
  task: string;
  /** Who acted and for whom: the line goes to the rooms that hold every one of them. */
  from: string;
  to?: string;
  /** A Task's title, a report's status, a conflict's files, a merge's branches. */
  detail?: string;
  /** A room that already shows this event in its own words (a Worker's summary post). */
  except?: string;
}
const SYSTEM_LINE = {
  assigned: 'sys_assigned',
  reported: 'sys_reported',
  conflict: 'sys_conflict',
  merged: 'sys_merged',
} as const;
export const systemLine = (e: SystemEvent): string =>
  koText(SYSTEM_LINE[e.kind], {
    task: e.task,
    line: `${e.from}${e.to ? ` → ${e.to}` : ''}${e.detail ? ` · ${e.detail}` : ''}`
      .replace(/[\r\n]+/g, ' ')
      .slice(0, 200),
  });
/** A room record's delivery ids as Messenger writes them (member → MESSAGE_ID); anything
 *  else in the file is ignored, as a bad queue id is (parseQueued), never sent on. */
const validIds = (v: unknown): v is Record<string, string> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.values(v).every((id) => typeof id === 'string' && MESSAGE_ID.test(id));
const PUNCTUATION = /[,.!?;:\]\)}]+$/;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const shortStamp = (at: number) => {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * A room reads its replies from the end of a member's transcript, at most this many bytes per
 * build (a few ms on this PC; a whole 40 MB transcript once per post stalled the daemon for
 * seconds). A post whose turn lies further back keeps its post and shows no replies: the same
 * honesty rule as the chat view's "이전 대화" paging.
 */
export const ROOM_SCAN_MAX_BYTES = 4 * 1024 * 1024;
const NL = 0x0a;

/** The top-level timestamp of the first whole line in `buf` that has one (null: none). */
function firstStamp(buf: Buffer): number | null {
  let from = buf.indexOf(NL) + 1; // the line before it is torn
  for (let to = buf.indexOf(NL, from); from > 0 && to > 0; from = to + 1, to = buf.indexOf(NL, from)) {
    try {
      const { timestamp } = JSON.parse(buf.toString('utf8', from, to)) as { timestamp?: unknown };
      const at = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
      if (at) return at;
    } catch {
      /* not a record */
    }
  }
  return null;
}

/**
 * The end of a member's transcript that holds its replies to posts made at or after `since`:
 * read backwards in CHAT_TAIL_BYTES chunks until a record written before `since` (a post's
 * delivery is never older than the post) or ROOM_SCAN_MAX_BYTES. Whole lines only. Null: unreadable.
 */
export function roomTranscript(file: string, since: number): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const floor = Math.max(0, size - ROOM_SCAN_MAX_BYTES);
    const chunks: Buffer[] = [];
    let start = size;
    while (start > floor) {
      const from = Math.max(floor, start - CHAT_TAIL_BYTES);
      const chunk = Buffer.alloc(start - from);
      chunks.unshift(chunk.subarray(0, fs.readSync(fd, chunk, 0, chunk.length, from)));
      start = from;
      const at = start > 0 ? firstStamp(chunk) : null;
      if (at !== null && at < since) break;
    }
    const buf = Buffer.concat(chunks);
    // The first record can start before what was read: drop only that torn line.
    return start > 0 ? buf.toString('utf8', buf.indexOf(NL) + 1 || buf.length) : buf.toString('utf8');
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * One member's reply to a post: only assistant/progress/tool lines after the
 * room prompt and before their next user prompt.  Call this only while a room
 * is open; the room JSONL intentionally contains no copied transcript.
 * C2: with the member's delivery id, the prompt is the user turn whose header
 * carries that mark; without one (a post made before C2) it is the first turn
 * whose header text and words match, as before (a marked header never does).
 * The transcript is split and its turns found once, for every post asked.
 * `read`: how the lead's lines are read (its sent files become attachments, as in its DM).
 */
export function roomReplyReader(
  transcript: string,
  read: LineOptions = {},
): (room: GroupRoom, post: GroupPost, messageId?: string) => ChatItem[] {
  const lines = transcript.split('\n');
  // Each user turn's first line: only a `user` record (not a queued attachment) is a room prompt.
  const turns: Array<{ n: number; text: string; user: boolean; id?: string }> = [];
  for (const [n, line] of lines.entries()) {
    if (!line.includes('"type":"user"') && !line.includes('queued_command')) continue; // no turn (userTurnText)
    const text = userTurnText(line);
    if (text === null) continue;
    const user = (JSON.parse(line) as { type?: unknown }).type === 'user';
    turns.push({ n, text, user, id: user ? turnMessageId(text) : undefined });
  }
  return (room, post, messageId) => {
    const header = new RegExp(
      `^\\[[^\\]\\n]+ · 단톡방 '${escape(room.name)}' · ${escape(shortStamp(post.at))}\\]\\n${escape(post.text)}(?:$|\\n)`,
    );
    const i = turns.findIndex(
      (turn) => turn.user && (messageId ? turn.id === messageId : header.test(turn.text)),
    );
    if (i < 0) return [];
    const items: ChatItem[] = [];
    // Tool-result records have type user but continue the same assistant turn.
    for (let n = turns[i].n + 1; n < (turns[i + 1]?.n ?? lines.length); n++)
      for (const item of lineItems(lines[n], n, read))
        if (item.kind !== 'user') items.push(messageId ? { ...item, messageId } : item);
    return items;
  };
}

export const roomReplyItems = (
  transcript: string,
  room: GroupRoom,
  post: GroupPost,
  messageId?: string,
  read?: LineOptions,
): ChatItem[] => roomReplyReader(transcript, read)(room, post, messageId);

/**
 * The room list's events (preview and last time): each post, and each item a member wrote under
 * it. C3: `counts` is what the room's unread counts, the same rule as a one-to-one conversation's
 * (its reply = the lead's text): the post and a member's text, never a tool line (each would be
 * an unread of its own).
 */
export function roomEvents(posts: GroupTimelinePost[]): Array<{
  id: string;
  at: number;
  text: string;
  sender: string | null;
  counts: boolean;
}> {
  return posts.flatMap((post) => [
    {
      id: `${post.at}-${post.id}`,
      at: post.at,
      text: post.text,
      sender: post.sender,
      counts: post.sender !== null && !post.system, // C4: a system line is no unread
    },
    ...post.replies.flatMap((reply) =>
      reply.items.map((item) => ({
        id: item.id,
        at: item.at,
        text: item.text,
        sender: reply.member,
        counts: item.kind === 'assistant',
      })),
    ),
  ]);
}

/** Tagged names only. A bare room post stays readable but interrupts no lead. */
export function roomMentions(
  text: string,
  members: string[],
): { targets: string[] } & Partial<WithError> {
  const all = new Set(members);
  const targets = new Set<string>();
  const recognized = new Set<string>();
  if (/@전체(?=$|\s|[,.!?;:\]\)}])/u.test(text)) {
    for (const member of members) targets.add(member);
    recognized.add('전체');
  }
  for (const member of [...members].sort((a, b) => b.length - a.length)) {
    const match = new RegExp(`@${escape(member)}(?=$|\\s|[,.!?;:\\]\\)}])`, 'gu');
    if (match.test(text)) {
      targets.add(member);
      recognized.add(member);
    }
  }
  for (const raw of text.matchAll(/@([^\s@]+)/gu)) {
    const name = raw[1].replace(PUNCTUATION, '');
    if (!recognized.has(name) && !all.has(name))
      return { targets: [], ...refused('room_no_member', { name }) };
  }
  return { targets: members.filter((member) => targets.has(member)) };
}

export class GroupMessages {
  private readonly now: () => number;
  private readonly ids: () => string;

  constructor(private readonly opts: GroupMessagesOptions) {
    this.now = opts.now ?? Date.now;
    this.ids = opts.ids ?? (() => randomBytes(8).toString('hex'));
  }

  timeline(room: GroupRoom, limit = 50): GroupPost[] {
    const posts = new Map<string, GroupPost>();
    for (const record of this.records(room.id)) {
      if (record.kind === 'post') {
        // C4: a room with its system lines off shows none, also those written before.
        if (record.post.system && room.systemLines === false) continue;
        const { messageIds, replyTo: rawReply, ...post } = record.post;
        const replyTo = replyRef(rawReply); // read back as safe as it was written
        posts.set(record.post.id, {
          ...post,
          delivery: { ...record.post.delivery },
          ...(validIds(messageIds) && { messageIds }),
          ...(replyTo && { replyTo }),
        });
      }
      else {
        const post = posts.get(record.id);
        if (post && post.targets.includes(record.member))
          post.delivery[record.member] = record.state;
      }
    }
    return [...posts.values()].slice(-Math.max(1, limit));
  }

  /** Transcript reads are deliberately supplied by the office only while a room is open: once
   *  per member, the part that can answer posts at or after `since` (the oldest tagged post shown). */
  timelineWithReplies(
    room: GroupRoom,
    transcriptFor: (member: string, since: number) => string | null,
    limit = 50,
    /** How each member's lines are read (its sent files, T-0105). */
    readFor: (member: string) => LineOptions = () => ({}),
  ): GroupTimelinePost[] {
    const posts = this.timeline(room, limit);
    const since = Math.min(...posts.filter((post) => post.targets.length).map((post) => post.at));
    const readers = new Map<string, ReturnType<typeof roomReplyReader> | null>();
    const readerFor = (member: string) => {
      if (!readers.has(member)) {
        const transcript = transcriptFor(member, since);
        readers.set(member, transcript === null ? null : roomReplyReader(transcript, readFor(member)));
      }
      return readers.get(member)!;
    };
    return posts.map(({ roomName, messageIds, ...post }) => ({
      ...post,
      replies: post.targets.flatMap((member) => {
        const reader = readerFor(member);
        if (reader === null) return [];
        const messageId = messageIds?.[member];
        return [
          {
            member,
            ...(messageId && { messageId }),
            items: reader(
              { ...room, name: roomName ?? room.name },
              post,
              messageId,
            ),
          },
        ];
      }),
    }));
  }

  async post(req: {
    room: string;
    text: string;
    from: string | null;
    source: string;
    /** MSG-ACTIONS: the message this post answers (replyRef makes it safe). */
    replyTo?: unknown;
    /** TOKEN-GUARD (TG-02b): the daemon's copy of a Codex Worker's summary: shown in the room,
     *  delivered to nobody (its Lead is told separately); a mention in it wakes no one. */
    quiet?: boolean;
  }): Promise<{ ok: true; post: GroupPost } | ({ ok: false } & WithError)> {
    const room = this.opts.store.find(req.room);
    if (!room) return { ok: false, ...refused('room_missing') };
    // `[사장 · 단톡방 …]` is the boss's header: only the app may write it.
    if (req.from === BOSS && !req.source.startsWith('messenger:'))
      return { ok: false, ...refused('room_name_reserved', { name: BOSS }) };
    const text = cleanText(req.text);
    if (!text.trim()) return { ok: false, ...refused('message_empty') };
    if (Buffer.byteLength(text) > TEXT_MAX)
      return { ok: false, ...refused('message_too_long', { kb: TEXT_MAX / 1024 }) };
    const mentioned = roomMentions(text, room.members);
    if (mentioned.error) return { ok: false, ...pickRefusal(mentioned) };
    // TOKEN-GUARD (TG-02a): a post never comes back to its own sender (@전체, a self-mention).
    let targets = mentioned.targets.filter((member) => member !== req.from);
    if (req.from && targets.length < mentioned.targets.length && !req.quiet)
      this.opts.messenger.guard?.({ trigger: 'room', room: room.id, to: req.from, from: req.from, allowed: false, reason: 'room_echo' });
    if (req.quiet && mentioned.targets.length) {
      this.opts.messenger.guard?.({ trigger: 'room_summary', room: room.id, from: req.from, targets: mentioned.targets.length, allowed: false, reason: 'summary_post' });
      targets = [];
    }
    const at = this.now();
    const replyTo = replyRef(req.replyTo);
    const post: GroupPost = {
      id: this.ids(),
      at,
      // The app's posts are the boss's own (no sender line); anything else is named.
      roomName: room.name,
      sender: req.from ?? (req.source.startsWith('messenger:') ? null : 'cld-gui'),
      text,
      targets,
      delivery: Object.fromEntries(targets.map((member) => [member, 'pending' as const])),
      ...(targets.length && {
        messageIds: Object.fromEntries(targets.map((member) => [member, newMessageId()])),
      }),
      ...(replyTo && { replyTo }),
    };
    if (!this.append(room.id, { v: 1, kind: 'post', post }))
      return { ok: false, ...refused('room_log_failed') };
    this.opts.changed?.(room.id);
    await Promise.all(
      post.targets.map(async (to) => {
        const result = await this.opts.messenger.send({
          to,
          text,
          ifIdle: false,
          from: req.from,
          source: req.source,
          created: at,
          group: { roomId: room.id, roomName: room.name, messageId: post.id },
          messageId: post.messageIds?.[to],
          ...(replyTo && { replyTo }),
        });
        if (result.ok)
          this.delivery(
            room.id,
            post.id,
            to,
            result.delivered === 'pane'
              ? 'delivered'
              : result.delivered === 'inbox'
                ? 'off'
                : 'pending',
          );
      }),
    );
    return { ok: true, post: this.timeline(room).find((item) => item.id === post.id) ?? post };
  }

  /** C4: the event as one line in each room (not `전체`, not one switched off) that holds every
   *  party. Delivered to nobody: a system line never starts a turn. */
  system(e: SystemEvent): void {
    const parties = [e.from, ...(e.to ? [e.to] : [])];
    for (const room of this.opts.store.list()) {
      if (room.id === ALL_GROUP_ID || room.id === e.except || room.systemLines === false) continue;
      if (!parties.every((p) => room.members.includes(p))) continue;
      const post: GroupPost = {
        id: this.ids(),
        at: this.now(),
        roomName: room.name,
        sender: 'cld-gui',
        text: systemLine(e),
        targets: [],
        delivery: {},
        system: true,
      };
      if (this.append(room.id, { v: 1, kind: 'post', post })) this.opts.changed?.(room.id);
    }
  }

  /** Called by Messenger as an item changes without rewriting the JSONL post. */
  observe(item: QueuedSend, delivered: 'pane' | 'queued' | 'inbox' | 'held'): void {
    const group = item.group;
    if (!group) return;
    this.delivery(
      group.roomId,
      group.messageId,
      item.to,
      delivered === 'pane'
        ? 'delivered'
        : delivered === 'inbox'
          ? 'off'
          : delivered === 'held'
            ? 'held'
            : 'pending',
    );
  }

  private delivery(roomId: string, id: string, member: string, state: GroupDelivery): void {
    const room = this.opts.store.find(roomId);
    if (!room) return;
    const current = this.timeline(room).find((post) => post.id === id)?.delivery[member];
    // A held callback precedes the queued record in the immediate-send path.
    if (current === state || (current === 'held' && state === 'pending')) return;
    if (this.append(roomId, { v: 1, kind: 'delivery', id, member, state }))
      this.opts.changed?.(roomId);
  }

  private records(roomId: string): TimelineRecord[] {
    let text: string;
    try {
      text = fs.readFileSync(
        path.join(groupTimelineDir(this.opts.home), `${roomId}.jsonl`),
        'utf-8',
      );
    } catch {
      return [];
    }
    return text.split('\n').flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line);
        return value && typeof value === 'object' && (value as { v?: unknown }).v === 1
          ? [value as TimelineRecord]
          : [];
      } catch {
        return [];
      }
    });
  }

  private append(roomId: string, record: TimelineRecord): boolean {
    try {
      const dir = groupTimelineDir(this.opts.home);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(path.join(dir, `${roomId}.jsonl`), `${JSON.stringify(record)}\n`, {
        mode: 0o600,
      });
      return true;
    } catch {
      return false;
    }
  }
}
