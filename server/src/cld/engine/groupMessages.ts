/** Append-only room posts, their tagged fan-out, and delivery-state folding. */
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { koText, pickRefusal, refused, type WithError } from '../../../../core/src/cld/serverText.js';
import type { ChatItem, ChatReply } from '../../../../core/src/messages.js';
import { LABEL } from '../labels.js';
import {
  CHAT_TAIL_BYTES,
  lineItems,
  type LineOptions,
  turnMessageId,
  turnParts,
  userTurnText,
} from '../transcriptView.js';
import { maintainGroupLogs, monthFile, readSegment, roomSegments } from './groupLogFiles.js';
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
  /** ROOM-MODES: an untagged post, a 공지: `targets` are every member but its sender, each
   *  delivered with that member's next message (Messenger roomNotice), never waking anyone.
   *  Absent: tagged (바로: wakes the targets), or a record-only one (an untagged post from before
   *  ROOM-MODES, a Worker's summary): those stay as recorded. */
  notice?: true;
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
    notice?: 'fyi';
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
  kind: 'assigned' | 'reported' | 'conflict' | 'merged' | 'review';
  task: string;
  /** Who acted and for whom: the line goes to the rooms that hold every one of them. */
  from: string;
  to?: string;
  /** A Task's title, a report's status, a conflict's files, a merge's branches. */
  detail?: string;
  /** A room that already shows this event in its own words (a Worker's summary post). */
  except?: string;
  /** The line already worded (the review loop's "사장님이 … 보냈어요"). */
  text?: string;
}
const SYSTEM_LINE = {
  assigned: 'sys_assigned',
  reported: 'sys_reported',
  conflict: 'sys_conflict',
  merged: 'sys_merged',
  review: 'sys_review',
} as const;
export const systemLine = (e: SystemEvent): string =>
  e.text ??
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
/** ROOM-THREADS: how far one binary-search probe reads on for a whole stamped line. */
const ROOM_PROBE_MAX_BYTES = 1024 * 1024;
/** ROOM-THREADS: how many transcripts running at a post's time are looked through for its reply. */
// ponytail: five or more sessions running at once in the folder can push the member's own
// out of reach; count the member's own sessions (registry) if folders get that crowded.
export const ROOM_EARLIER_FILES = 4;
/** ROOM-THREADS: a transcript's first record is looked for in this many bytes, then in the larger. */
const ROOM_FIRST_BYTES = 4 * 1024;
// ponytail: a transcript whose first stamped record lies past 64 KB is never a place to look.
const ROOM_FIRST_MAX_BYTES = 64 * 1024;
/** ROOM-THREADS: the earlier replies kept (their members' words), in all and per reply. */
export const EARLIER_MAX_BYTES = 4 * 1024 * 1024;
export const EARLIER_ENTRY_MAX_BYTES = 16 * 1024;
/** ROOM-THREADS: a post whose reply none of its transcripts held is looked for again after this,
 *  twice as long each time, up to the larger; never while those transcripts stay as they were. */
export const EARLIER_RETRY_MS = 60_000;
export const EARLIER_RETRY_MAX_MS = 30 * 60_000;
/** Not-found marks kept while no one views a room (one per post and member). */
const MISSED_MAX = 2000;
/** ROOM-THREADS: the delivery states whose post can have a reply in a transcript. */
const REACHED: ReadonlySet<GroupDelivery> = new Set(['delivered', 'off']);
const NL = 0x0a;

/** The top-level timestamp of the first whole line in `buf` that has one (null: none).
 *  `whole`: `buf` starts at a line (a file's start), else its first line is torn. */
function firstStamp(buf: Buffer, whole = false): number | null {
  let from = whole ? 0 : buf.indexOf(NL) + 1;
  if (!whole && from === 0) return null; // no whole line
  for (let to = buf.indexOf(NL, from); to >= 0; from = to + 1, to = buf.indexOf(NL, from)) {
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

/** Read `length` bytes of `fd` at `at` (fewer at the end of the file). */
function readAt(fd: number, at: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  return buf.subarray(0, fs.readSync(fd, buf, 0, length, at));
}

/** The first stamped whole line's time at or after `at`, read forward in CHAT_TAIL_BYTES chunks
 *  up to ROOM_PROBE_MAX_BYTES (a record can be megabytes: an image, an api-request-blob). */
function stampFrom(fd: number, at: number): number | null {
  for (let k = at; k < at + ROOM_PROBE_MAX_BYTES; k += CHAT_TAIL_BYTES) {
    const chunk = readAt(fd, k, CHAT_TAIL_BYTES);
    if (!chunk.length) return null;
    const stamp = firstStamp(chunk, k === 0);
    if (stamp !== null) return stamp;
  }
  return null;
}

/** A transcript's first record time, kept per file and size (a small read: its first lines). */
const firstStamps = new Map<string, { size: number; at: number | null }>();
function fileStart(file: string, size: number): number | null {
  const known = firstStamps.get(file);
  if (known && (known.at !== null || known.size === size)) return known.at;
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const at =
      firstStamp(readAt(fd, 0, ROOM_FIRST_BYTES), true) ??
      (size > ROOM_FIRST_BYTES ? firstStamp(readAt(fd, 0, ROOM_FIRST_MAX_BYTES), true) : null);
    firstStamps.set(file, { size, at });
    return at;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * ROOM-THREADS: the transcripts of `current`'s folder that were running at `at` (first record at
 * or before it, written to since), the latest begun first, at most ROOM_EARLIER_FILES. A renew
 * records no chain, and the folder can hold other sessions (another member's, a hand-run one):
 * each is only a place to look, the delivery id decides what is a reply. Regular files only (a
 * FIFO would block the open, a link could lead anywhere); one last written before `at` is not
 * opened.
 */
export interface EarlierFile {
  file: string;
  size: number;
  mtimeMs: number;
}
export function transcriptsAt(current: string, at: number): EarlierFile[] {
  const dir = path.dirname(current);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const found: Array<EarlierFile & { first: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const file = path.join(dir, entry.name);
    seen.add(file);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.mtimeMs < at) continue;
    const first = fileStart(file, stat.size);
    if (first !== null && first <= at) found.push({ file, first, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  for (const file of firstStamps.keys())
    if (path.dirname(file) === dir && !seen.has(file)) firstStamps.delete(file); // gone from the folder
  return found
    .sort((x, y) => y.first - x.first)
    .slice(0, ROOM_EARLIER_FILES)
    .map(({ file, size, mtimeMs }) => ({ file, size, mtimeMs }));
}

/**
 * ROOM-THREADS: the part of a transcript (one of transcriptsAt) that can hold a member's reply to
 * a post made at `at` that the tail (roomTranscript) no longer reaches (a renew started a new
 * conversation, or it lies more than ROOM_SCAN_MAX_BYTES back): at most ROOM_SCAN_MAX_BYTES from
 * the first record at `at`, found by a binary search of short probes. Whole lines only; `end`:
 * it reaches the end of the file. Null: unreadable.
 */
export function roomTranscriptAt(file: string, at: number): { text: string; end: boolean } | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    let lo = 0;
    for (let hi = size; hi - lo > CHAT_TAIL_BYTES; ) {
      const mid = Math.floor((lo + hi) / 2);
      const stamp = stampFrom(fd, mid);
      // None in reach (records megabytes long): taken for before `at`.
      if (stamp === null || stamp < at) lo = mid;
      else hi = mid;
    }
    const buf = readAt(fd, lo, ROOM_SCAN_MAX_BYTES);
    const from = lo > 0 ? buf.indexOf(NL) + 1 : 0; // the line it starts inside is torn
    const end = lo + buf.length >= size;
    const to = end ? buf.length : buf.lastIndexOf(NL) + 1; // so is the last
    return { text: from > 0 || lo === 0 ? buf.toString('utf8', from, Math.max(from, to)) : '', end };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** The first record time in a transcript text (whole lines; Infinity: none). */
function textStart(text: string): number {
  for (let from = 0, to = text.indexOf('\n'); from < text.length; from = to + 1, to = text.indexOf('\n', from)) {
    try {
      const { timestamp } = JSON.parse(text.slice(from, to < 0 ? undefined : to)) as { timestamp?: unknown };
      const at = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
      if (at) return at;
    } catch {
      /* not a record */
    }
    if (to < 0) break;
  }
  return Infinity;
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
  /** The text ends where its file does (a turn last in it is whole). */
  end = true,
): (room: GroupRoom, post: GroupPost, messageId?: string, whole?: boolean) => ChatItem[] | null {
  const lines = transcript.split('\n');
  // Each user turn's first line: only a `user` record (not a queued attachment) is a room prompt.
  // MSG-SPLIT: a joined turn (messages queued while it worked) answers each of its parts.
  const turns: Array<{ n: number; parts: string[]; user: boolean; ids: Array<string | undefined> }> = [];
  for (const [n, line] of lines.entries()) {
    if (!line.includes('"type":"user"') && !line.includes('queued_command')) continue; // no turn (userTurnText)
    const text = userTurnText(line);
    if (text === null) continue;
    const user = (JSON.parse(line) as { type?: unknown }).type === 'user';
    const parts = turnParts(text);
    turns.push({ n, parts, user, ids: user ? parts.map(turnMessageId) : [] });
  }
  // `whole`: only a turn that ends inside the text (the next turn follows in it, or the file ends).
  return (room, post, messageId, whole = false) => {
    const header = new RegExp(
      `^\\[[^\\]\\n]+ · 단톡방 '${escape(room.name)}' · ${escape(shortStamp(post.at))}\\]\\n${escape(post.text)}(?:$|\\n)`,
    );
    const i = turns.findIndex(
      (turn) =>
        turn.user && (messageId ? turn.ids.includes(messageId) : turn.parts.some((part) => header.test(part))),
    );
    if (i < 0) return null; // the turn is not in this text
    if (whole && !turns[i + 1] && !end) return null; // its reply runs on past the text
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
): ChatItem[] => roomReplyReader(transcript, read)(room, post, messageId) ?? [];

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

/** Tagged names only (a bare room post is a 공지: GroupMessages.post). */
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
  /** ROOM-THREADS: replies read from before the tail (roomTranscriptAt), per member and post, oldest
   *  used first: that part of a transcript is history. At most EARLIER_MAX_BYTES; emptied when no
   *  one views a room (forgetEarlier). */
  private readonly earlier = new Map<string, { items: ChatItem[]; bytes: number }>();
  private earlierBytes = 0;
  /** ROOM-THREADS: posts not found yet: the next transcript to look in, or when to start again. */
  //   `wait`: the last wait (doubled each time); `seen`: the transcripts (file, size, time) as they
  //   were when every one had been looked in.
  private readonly missed = new Map<string, { attempt: number; retryAt: number; wait: number; seen?: string }>();

  constructor(private readonly opts: GroupMessagesOptions) {
    this.now = opts.now ?? Date.now;
    this.ids = opts.ids ?? (() => randomBytes(8).toString('hex'));
  }

  timeline(room: GroupRoom, limit = 50): GroupPost[] {
    const posts = new Map<string, GroupPost>();
    for (const record of this.records(room.id, limit, room.systemLines === false)) {
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

  /**
   * The room's own posts that hold `folded` (the lower-cased words), newest first, for the messenger-wide
   * search: the newest `segments` log files, a line parsed only when it holds the words. `snippet` makes
   * the post's text into what is sent (null: drop it). A member's reply lives in its transcript, not in
   * this log, and is not searched.
   */
  // ponytail: a segment is read whole (a room's month is megabytes); a streaming reader if a room outgrows that.
  searchPosts(
    room: GroupRoom,
    folded: string,
    opts: { segments: number; maxHits: number; cancelled: () => boolean; snippet: (text: string) => string | null },
  ): { hits: Array<{ id: string; at: number; sender: string | null; snippet: string }>; truncated: boolean } {
    const hits: Array<{ id: string; at: number; sender: string | null; snippet: string }> = [];
    const files = roomSegments(groupTimelineDir(this.opts.home), room.id);
    const quick = !/["\\\u0000-\u001f]/.test(folded);
    for (let i = files.length - 1; i >= 0; i--) {
      if (files.length - 1 - i >= opts.segments) return { hits, truncated: true };
      const text = readSegment(files[i]);
      if (text === null) continue;
      const lines = text.split('\n');
      for (let k = lines.length - 1; k >= 0; k--) {
        if (opts.cancelled()) return { hits: [], truncated: false };
        if (quick && !lines[k].toLocaleLowerCase().includes(folded)) continue;
        let record: TimelineRecord;
        try {
          record = JSON.parse(lines[k]) as TimelineRecord;
        } catch {
          continue;
        }
        if (record?.kind !== 'post' || record.post.system || typeof record.post.text !== 'string') continue;
        const snippet = opts.snippet(record.post.text);
        if (snippet === null) continue;
        if (hits.length >= opts.maxHits) return { hits, truncated: true };
        const { id, at, sender } = record.post;
        hits.push({ id, at, sender, snippet });
      }
    }
    return { hits, truncated: false };
  }

  /** Transcript reads are deliberately supplied by the office only while a room is open: once
   *  per member, the part that can answer posts at or after `since` (the oldest tagged post shown).
   *  ROOM-THREADS: `earlierFor` (the open room only) reaches a post older than that part that
   *  reached the member (REACHED), by its delivery id only (a header's words can be another member's in a shared
   *  folder): the transcripts running at its time, one at a time (transcriptsAt, roomTranscriptAt).
   *  One window per member per build, so a build reads at most twice ROOM_SCAN_MAX_BYTES per member;
   *  another post found in that window counts only when its turn ends there. A window without the
   *  reply moves the next build on to the next transcript; after the last, the post waits
   *  EARLIER_RETRY_MS, doubling to EARLIER_RETRY_MAX_MS, and is read again only when one of those
   *  transcripts changed. What is found is kept (keepEarlier). */
  timelineWithReplies(
    room: GroupRoom,
    transcriptFor: (member: string, since: number) => string | null,
    limit = 50,
    /** How each member's lines are read (its sent files, T-0105). */
    readFor: (member: string) => LineOptions = () => ({}),
    earlierFor?: (member: string) => {
      files: (at: number) => EarlierFile[];
      window: (file: string, at: number) => { text: string; end: boolean } | null;
    } | null,
  ): GroupTimelinePost[] {
    const posts = this.timeline(room, limit);
    // A 공지 is never answered (no reply is bound to it): it reads no transcript.
    const since = Math.min(...posts.filter((post) => post.targets.length && !post.notice).map((post) => post.at));
    type Reader = ReturnType<typeof roomReplyReader>;
    const readers = new Map<string, { read: Reader; start: number } | null>();
    const readerFor = (member: string) => {
      if (!readers.has(member)) {
        const transcript = transcriptFor(member, since);
        readers.set(
          member,
          transcript === null
            ? null
            : { read: roomReplyReader(transcript, readFor(member)), start: textStart(transcript) },
        );
      }
      return readers.get(member)!;
    };
    const windows = new Map<string, Reader>(); // this build's earlier window, per member
    const touched = new Set<string>(); // the replies this build shows: never evicted by it
    const earlierItems = (member: string, post: GroupPost, named: GroupRoom, messageId: string): ChatItem[] => {
      const key = `${member}\n${post.id}`;
      touched.add(key);
      const kept = this.earlier.get(key);
      if (kept) {
        this.earlier.delete(key); // used: the newest again
        this.earlier.set(key, kept);
        return kept.items;
      }
      const source = earlierFor?.(member);
      if (!source) return [];
      const opened = windows.get(member);
      if (opened) {
        // This build's window (opened for an older post of the member) may hold this one too, but
        // only a turn that ends in it: one cut at its end waits for its own window.
        const items = opened(named, post, messageId, true);
        return items ? this.keepEarlier(key, items, touched) : [];
      }
      const now = this.now();
      const miss = this.missed.get(key);
      if (miss && miss.retryAt > now) return [];
      const files = source.files(post.at);
      const seen = files.map((f) => `${f.file}\0${f.size}\0${f.mtimeMs}`).join('\n');
      const wait = miss?.wait ? Math.min(2 * miss.wait, EARLIER_RETRY_MAX_MS) : EARLIER_RETRY_MS;
      if (miss?.seen === seen) {
        this.missed.set(key, { ...miss, wait, retryAt: now + wait }); // nothing changed: nothing read
        return [];
      }
      // ponytail: the order is read again each build, so a transcript added between two builds can
      // shift it and one is skipped this round (the next round, after its wait, sees it).
      const attempt = miss && miss.seen === undefined ? miss.attempt : 0;
      const file = files[attempt];
      if (!file) {
        this.missed.set(key, { attempt: 0, wait, retryAt: now + wait, seen });
        return [];
      }
      const text = source.window(file.file, post.at);
      const window = roomReplyReader(text?.text ?? '', readFor(member), text?.end ?? true);
      windows.set(member, window);
      const items = window(named, post, messageId);
      if (!items) {
        this.missed.set(key, { attempt: attempt + 1, retryAt: 0, wait: miss?.wait ?? 0 }); // the next build: the next one
        return [];
      }
      this.missed.delete(key);
      return this.keepEarlier(key, items, touched);
    };
    return posts.map(({ roomName, messageIds, ...post }) => ({
      ...post,
      replies: (post.notice ? [] : post.targets).flatMap((member) => {
        const reader = readerFor(member);
        if (reader === null) return [];
        const messageId = messageIds?.[member];
        const named = { ...room, name: roomName ?? room.name };
        const items =
          reader.read(named, post, messageId) ??
          // Typed into its session ('delivered'), or left in its inbox ('off': read at its next
          // start, never marked so); one still 'pending' or 'held' reached no transcript.
          (messageId && REACHED.has(post.delivery[member]) && post.at < reader.start
            ? earlierItems(member, post, named, messageId)
            : []);
        return [{ member, ...(messageId && { messageId }), items }];
      }),
    }));
  }

  /**
   * ROOM-THREADS: an earlier reply kept: only what a room shows (the member's words), at most
   * EARLIER_ENTRY_MAX_BYTES of it; the least recently used replies leave past EARLIER_MAX_BYTES,
   * never one this build shows. When this build's alone pass the cap, the reply is shown now and
   * read again EARLIER_RETRY_MS on (not every build).
   */
  private keepEarlier(key: string, items: ChatItem[], touched: Set<string>): ChatItem[] {
    const kept: ChatItem[] = [];
    let bytes = 0;
    for (const item of items) {
      if (item.kind !== 'assistant') continue;
      const left = EARLIER_ENTRY_MAX_BYTES - bytes;
      const size = Buffer.byteLength(JSON.stringify(item));
      if (size > left) {
        // One UTF-8 character is at most 3 bytes in a text the cap reaches (Korean, ASCII).
        const room = Math.floor((left - (size - Buffer.byteLength(item.text))) / 3);
        if (room > 0) kept.push({ ...item, text: `${item.text.slice(0, room)}…` });
        bytes = EARLIER_ENTRY_MAX_BYTES;
        break;
      }
      kept.push(item);
      bytes += size;
    }
    for (const [k, v] of this.earlier) {
      if (this.earlierBytes + bytes <= EARLIER_MAX_BYTES) break;
      if (touched.has(k)) continue;
      this.earlier.delete(k);
      this.earlierBytes -= v.bytes;
    }
    // ponytail: past the cap the overflow blinks out and back each EARLIER_RETRY_MS, and two open
    // rooms push each other's replies out; a per-room share of the cap if that is ever seen.
    if (this.earlierBytes + bytes > EARLIER_MAX_BYTES)
      this.missed.set(key, { attempt: 0, wait: EARLIER_RETRY_MS, retryAt: this.now() + EARLIER_RETRY_MS });
    else {
      this.earlier.set(key, { items: kept, bytes });
      this.earlierBytes += bytes;
    }
    return kept;
  }

  /** ROOM-THREADS: no one views a room: the earlier replies kept are let go. */
  forgetEarlier(): void {
    this.earlier.clear();
    this.earlierBytes = 0;
    // The not-found marks stay (small): a room closed and opened again keeps its grown wait
    // instead of reading every unfound post again (11-04 review). ponytail: dropped whole past MISSED_MAX.
    if (this.missed.size > MISSED_MAX) this.missed.clear();
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
    // ROOM-MODES: no tag = 공지 for every member but the sender (rides with each one's next message).
    const notice = !req.quiet && mentioned.targets.length === 0;
    // TOKEN-GUARD (TG-02a): a post never comes back to its own sender (@전체, a self-mention).
    let targets = (notice ? room.members : mentioned.targets).filter((member) => member !== req.from);
    if (req.from && !notice && targets.length < mentioned.targets.length && !req.quiet)
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
      sender: req.from ?? (req.source.startsWith('messenger:') ? null : LABEL),
      text,
      targets,
      delivery: Object.fromEntries(targets.map((member) => [member, 'pending' as const])),
      ...(targets.length && {
        messageIds: Object.fromEntries(targets.map((member) => [member, newMessageId()])),
      }),
      ...(replyTo && { replyTo }),
      ...(notice && targets.length > 0 && { notice: true as const }),
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
          ...(post.notice && { notice: 'fyi' as const }),
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
        sender: LABEL,
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

  /** Daily (office prune): earlier-version logs split by month, old months gzipped; nothing deleted. */
  maintain(): void {
    maintainGroupLogs(groupTimelineDir(this.opts.home), this.now(), (line) => console.log(`[agty engine] ${line}`));
  }

  /**
   * The room's records, oldest first: the newest month file, then earlier ones (gzipped or not)
   * only while fewer than `want` posts have been read (`skipSystem`: its system lines do not count).
   */
  private records(roomId: string, want = Infinity, skipSystem = false): TimelineRecord[] {
    const dir = groupTimelineDir(this.opts.home);
    const segments = roomSegments(dir, roomId);
    let records: TimelineRecord[] = [];
    let posts = 0;
    for (let i = segments.length - 1; i >= 0 && posts < want; i--) {
      const text = readSegment(segments[i]);
      if (text === null) continue;
      const found = text.split('\n').flatMap((line) => {
        try {
          const value: unknown = JSON.parse(line);
          return value && typeof value === 'object' && (value as { v?: unknown }).v === 1
            ? [value as TimelineRecord]
            : [];
        } catch {
          return [];
        }
      });
      posts += found.filter((r) => r.kind === 'post' && !(skipSystem && r.post.system)).length;
      records = [...found, ...records];
    }
    return records;
  }

  private append(roomId: string, record: TimelineRecord): boolean {
    try {
      const dir = groupTimelineDir(this.opts.home);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(monthFile(dir, roomId, this.now()), `${JSON.stringify(record)}\n`, {
        mode: 0o600,
      });
      return true;
    } catch {
      return false;
    }
  }
}
