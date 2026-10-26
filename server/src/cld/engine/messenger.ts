/**
 * cld-gui send (T-0019, cld/docs/design/cld-cli.md §5): a message for an
 * engine project's orchestrator, typed into its background session the way a
 * user types it, through `claude attach` (the Typist: T-0014's shared PTY).
 * Not Claude Code's cross-session socket: there a message from anything that
 * is not a Claude session in the same permission class is held for approval
 * by a session that bypasses permissions, and it arrives as another agent's
 * <cross-session-message>, not as the user's input.
 *
 * A message goes in only while the session is idle: its turn is done
 * (~/.claude/sessions status `idle`) and the input line is empty (the
 * Typist's screen check). A `now` message (the boss's 즉시 보내기 in the app:
 * Ctrl+Enter, or 지금 보내기 on a waiting one, promote) also goes in while the
 * session works (status `busy`, the working screen allowed; Claude Code queues
 * input typed during a turn for its next step), ahead of older messages that
 * wait for idle; an empty input line and no dialog are still required.
 * A session whose status stays `busy` while background sub-agents run counts
 * as idle once its transcript says the main turn ended (turnOver: a
 * `turn_duration` record after the latest prompt, or a text-only reply 5 s
 * old); the Typist's screen check (no working line) still has the last word,
 * and the transcript is read first, so no attach is spent on a running turn.
 * A session `claude agents` lists as `blocked` after it answered since its
 * start, with its turn still open on a tool call (a question or permission
 * only its terminal shows), gets no attach: its messages wait, held() says so
 * for the app, and it is asked again after each retry pause. `blocked` with
 * the turn over is a session waiting for a reply: the message goes in.
 * Otherwise it waits in ~/.config/agent-tycoon/queue/
 * (checked every 2 s; `--if-idle` gives up after 10 minutes) and
 * moves to the inbox when the session goes off. queuedFor lists the boss's
 * waiting messages for the app (보냄(대기 중), also after a reload). The inbox,
 * ~/.config/agent-tycoon/inbox/<name>/<ts>.md, is typed in as the first message
 * after the engine next starts that session (the start hook calls
 * deliverInbox), then moved to delivered/.
 *
 * Queue files are written by `cld-gui send` too while the daemon is off (same
 * format: QueuedSend), and picked up at start and when they appear.
 */
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  quoteLine,
  REPLY_ID,
  REPLY_QUOTE_MAX,
  replySender,
  snippet,
} from '../../../../core/src/cld/reply.js';
import { type Coded, refused } from '../../../../core/src/cld/serverText.js';
import { slashTextProblem } from '../../../../core/src/cld/slashText.js';
import type { ChatReply } from '../../../../core/src/messages.js';
import { maskText } from '../mask.js';
import { turnEnded } from '../providers/claudeProvider.js';
import type { EngineEvents } from './events.js';
import { configDir, shortStamp } from './events.js';
import type { TurnLedger } from './turnLedger.js';

export const MESSENGER_TIMING = {
  tickMs: 2_000,
  /** `--if-idle`: 10 minutes, then the inbox. */
  ifIdleMs: 10 * 60_000,
  /** After an attach that found no empty input line (or failed): wait before the next.
   *  TOKEN-GUARD: doubled per miss in a row, up to RETRY_MAX_FACTOR times. */
  retryMs: 30_000,
  /** turnOver: a text-only reply this old ends its turn (no turn_duration for those). */
  quietMs: 5_000,
  /** K1 (F-12): an action-needed notice waits this long for others, so a burst wakes a resting
   *  session once (one paste, one turn). */
  noticeBatchMs: 30_000,
};
/** TOKEN-GUARD: misses in a row stretch the retry pause up to this many retryMs (2 min). */
const RETRY_MAX_FACTOR = 4;
/** TOKEN-GUARD: this many misses in a row are reported once (event send_stuck). */
const STUCK_MISSES = 5;
/** turnOver reads this much of the transcript's end. */
const TAIL_BYTES = 256 * 1024;
/** Bytes: SEND_TEXT_MAX (20,000) Hangul characters are 60 KB, plus the header. */
export const TEXT_MAX = 64 * 1024;

/** One message on its way (a queue file; `cld-gui send` writes the same shape). */
export interface QueuedSend {
  v: 1;
  to: string;
  /** The sender's text without the header line (cleanText). */
  text: string;
  from: string | null;
  source: string;
  ifIdle: boolean;
  /** ms since the epoch: the header's time, and the start of `--if-idle`'s wait. */
  created: number;
  /** The start hook's delivery of these inbox files: `text` is their content as is. */
  inbox?: string[];
  /** A validated boss slash command: type it without the normal messenger header. */
  raw?: true;
  /** 즉시 보내기: may go in while the session works too. */
  now?: boolean;
  /** A room post's identity: lets its append-only timeline follow delivery.
   *  `group.messageId` is the room POST's id (shared by every member's delivery);
   *  the delivery's own id is the top-level `messageId`. */
  group?: { roomId: string; roomName: string; messageId: string };
  /** C2: this message's id, made at enqueue and kept in the queue/inbox file, so
   *  retries, the inbox and restarts keep it. The header ends with its mark
   *  (` ⟨m:<id>⟩`). Absent in files written before C2: those go in with an
   *  unmarked header, matched by its text as before. */
  messageId?: string;
  /** The boss changed this before it reached the Typist. */
  edited?: true;
  /** C6: the Task a delegate_task hands over; the header names it (`… · Task <id> · …`). */
  task?: string;
  /** MSG-ACTIONS (답글): the message this one answers, as replyRef made it. The header gets
   *  ` ⟨re:<id>⟩` after the C2 mark and the body starts with its quote line. */
  replyTo?: ChatReply;
  /** MSG-HOLD2: the boss opened it for editing. Kept in the queue file (a daemon restart keeps
   *  it), never expires and survives a page reload or a closed socket: only a decision ends it
   *  (the edit saved, the edit cancelled, the original approved, the message cancelled). */
  held?: true;
  /** S-05: the engine's compaction nudge for the conversation it was made for: dropped, never
   *  delivered later, once a renewal is under way or the session is gone. */
  kind?: 'nudge';
  /** K1 (F-12): a notice the daemon makes for an agent (never the owner's words), by what it asks:
   *  'action' — a failure, an approval to give, a question, a finished Task to decide on: wakes a
   *  resting session, after waiting noticeBatchMs for the rest of its burst (one paste);
   *  'fyi' — progress the agent may want to know: never wakes, never goes to the inbox; it waits
   *  in the queue and rides in the next agent/engine paste to that session. Absent: as before. */
  notice?: 'action' | 'fyi';
}

export type SendCode =
  | 'unknown_project'
  | 'empty_message'
  | 'too_large'
  | 'queue_failed'
  | 'not_queued'
  | 'not_running'
  | 'typing'
  | 'unknown_provider'
  | 'no_direct_chat'
  | 'self_send';
export type SendResult =
  | {
      ok: true;
      delivered: 'pane' | 'queued' | 'inbox';
      reason?: string;
      id?: string;
      /** C2: the message's id (its header's mark). */
      messageId?: string;
    }
  | ({ ok: false; code: SendCode; error: string } & Coded);

/** What a typing attempt found: typed, a draft or dialog on screen, or no attach. */
export type TypeResult = 'typed' | 'notReady' | 'failed';
/** whileWorking: a running turn's screen ("esc to interrupt") counts as ready too. */
export type TypeOptions = {
  whileWorking?: boolean;
  /** Earlier messages actually pasted into this session, newest last. */
  earlier?: string[];
  /** The current message reached the session's input box (even if its submit is still uncertain). */
  onTyped?: () => void;
  /** The engine sees the session working (status busy): a 즉시 보내기 cuts in with chat:sendNow even
   *  when the screen's spinner text is not recognised (U-31: Claude Code changed it). */
  busy?: boolean;
};
export interface Typist {
  type(id: string, text: string, o?: TypeOptions): Promise<TypeResult>;
  /** PERM-PROMPT: answer the permission dialog about the call whose words are `match`, only when it
   *  is on the screen right now (chat.ts). */
  answerPermission?(id: string, match: PermissionMatch, allow: boolean): Promise<PermissionAnswer>;
  /** PERM-PROMPT: the permission dialog on the session's screen now, whole (its rule visible), or
   *  null. One attach, read, detach. */
  readPermissionDialog?(id: string): Promise<string | null>;
}
/** What an answer from the messenger did: answered, nothing (no or another dialog), pressed but the
 *  dialog stayed, or no attach. */
export type PermissionAnswer = 'answered' | 'noDialog' | 'otherDialog' | 'notCleared' | 'failed';
/** What the dialog on screen must be about: the call's words (each inside it, from its transcript),
 *  or exactly the dialog text read off the screen before (readPermissionDialog). */
export type PermissionMatch = string[] | { dialog: string };

/** A project's live session as the messenger needs it. */
export type SessionInfo = { id: string; status?: string; transcript?: string } | 'terminal' | null;
export interface MessengerEngine {
  names(): string[];
  /** Why the registry could not be read, or null. While set, names() says nothing about
   *  which agents exist (it is empty or partial), so pending messages wait untouched. */
  registryProblem?(): string | null;
  sessionOf(name: string): SessionInfo;
  /** Wake a session Claude retired for idleness; false means it remains ordinarily off. */
  wake?(name: string): Promise<boolean>;
  /** A renew is between its turn's end and the new conversation, or a Lead swap holds the
   *  name (D3b): hold its messages. */
  renewing(name: string): boolean;
  /** Asked just before an attach: the session waits on something only someone at
   *  its terminal can answer (`claude agents`: blocked). Its messages are held,
   *  with no attach, and checked again after the retry pause. */
  held?(name: string): Promise<boolean>;
  /** D5: a message to `name` refused before anything is queued (an agent this build has no
   *  provider for: its queue files wait untouched for a build that has it), or null. */
  refuses?(
    name: string,
    m: { from: string | null; source: string; group?: QueuedSend['group'] },
  ): ({ code: SendCode; error: string } & Coded) | null;
  /** D5: an agent that takes a message itself (a Codex Worker: one run per message), instead
   *  of the Typist: its result, or null (the Typist types it). `text` carries the header. */
  deliver?(
    name: string,
    text: string,
    o: { task?: string; group?: QueuedSend['group']; messageId?: string },
  ): Promise<TypeResult> | null;
}

/** Newlines as \n, no control characters but newline and tab (nothing can leave a paste). */
export function cleanText(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

/** C2: a message id, 8 random lowercase base32 characters (40 bits). */
export const MESSAGE_ID = /^[a-z2-7]{8}$/;
/** A Task id as tasks.ts makes and takes them. */
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
export const newMessageId = (): string => [...randomBytes(8)].map((b) => BASE32[b & 31]).join('');

/** Who the boss is in a reply's quote line (an absent `sender`). */
export const BOSS_NAME = '사장';

/** MSG-ACTIONS: a reply reference from the app, made safe to type: a valid id, the sender on
 *  one line, the quote masked (mask.ts) and cut to REPLY_QUOTE_MAX. Undefined: not a reference. */
export function replyRef(r: unknown): ChatReply | undefined {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return undefined;
  const { id, sender, text } = r as Record<string, unknown>;
  if (typeof id !== 'string' || !REPLY_ID.test(id) || typeof text !== 'string') return undefined;
  if (sender !== undefined && typeof sender !== 'string') return undefined;
  const name = sender ? replySender(maskText(cleanText(sender))) : '';
  return {
    id,
    ...(name && name !== BOSS_NAME && { sender: name }),
    text: snippet(maskText(cleanText(text)), REPLY_QUOTE_MAX),
  };
}

/** The line in front of a message. `<from>에게서` reads right for any sender (an
 *  orchestrator, ops agent, codex) without a name list (NFR-CMP-009). With an id,
 *  it ends with the machine mark ` ⟨m:<id>⟩` (C2) that binds the replies to it. */
export function header(
  m: Pick<QueuedSend, 'from' | 'source' | 'created' | 'group' | 'messageId' | 'task' | 'replyTo'>,
): string {
  const line = headerText(m);
  if (!m.messageId) return line;
  return `${line} ⟨m:${m.messageId}⟩${m.replyTo ? ` ⟨re:${m.replyTo.id}⟩` : ''}`;
}

function headerText(
  m: Pick<QueuedSend, 'from' | 'source' | 'created' | 'group' | 'task'>,
): string {
  const when = shortStamp(m.created);
  if ('group' in m && m.group) {
    const sender = m.from ?? (m.source.startsWith('messenger:') ? '사장' : 'cld-gui');
    return `[${sender} · 단톡방 '${m.group.roomName}' · ${when}]`;
  }
  if (m.from && m.task) return `[cld-gui · ${m.from}에게서 · Task ${m.task} · ${when}]`;
  if (m.from) return `[cld-gui · ${m.from}에게서 · ${when}]`;
  // The office messenger (T-0043): the boss, through the app.
  if (m.source.startsWith('messenger:')) return `[사장 · 메신저 · ${when}]`;
  if (m.source.startsWith('gui:')) return `[사용자 · 앱(${m.source}) · ${when}]`;
  return `[cld-gui · 보냄 · ${when}]`;
}

/** The boss's words from the app (the office messenger). */
const fromApp = (m: QueuedSend): boolean =>
  !m.from && (m.source.startsWith('messenger:') || m.source.startsWith('gui:'));

/** The boss's words from anywhere (the app or the terminal): no sender, and not the engine. */
const fromOwner = (m: QueuedSend): boolean => !m.from && m.source !== 'engine';


/** TOKEN-GUARD (TG-04): an agent's or the engine's plain message, which may share one paste (one
 *  turn) with the ones waiting next to it. The boss's words (no sender and not the engine: the app
 *  or the terminal), commands, room posts, Task hand-overs,
 *  replies and inbox deliveries always go alone (their turn is bound to them by their header). */
const mergeable = (m: QueuedSend): boolean =>
  !!m.messageId && !fromOwner(m) && !m.raw && !m.inbox && !m.now && !m.group && (!m.task || !!m.notice) && !m.replyTo;
/** K1: a notice that never wakes its session (the owner's words are never one). */
const fyi = (m: QueuedSend): boolean => m.notice === 'fyi' && !fromOwner(m);

/** TOKEN-GUARD: the message's mark is in a main-chain user turn of the transcript's end: it was
 *  typed already (a paste whose submit looked unsure, a daemon that died before it removed the
 *  queue file). Typing it again would be a second paid turn for the same message. */
export function alreadyTyped(text: string, messageId: string): boolean {
  const mark = ` ⟨m:${messageId}⟩`;
  for (const line of text.split('\n')) {
    if (!line.includes(mark)) continue;
    try {
      const r = JSON.parse(line) as TranscriptRecord;
      // A typed paste is the user's own words, never a tool result (a log or transcript the agent read).
      if (r && r.type === 'user' && !r.isSidechain && !blocks(r).some((b) => b.type === 'tool_result'))
        return true;
    } catch {
      /* the cut first line */
    }
  }
  return false;
}

interface TranscriptRecord {
  type?: string;
  subtype?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  timestamp?: string;
  message?: { content?: unknown };
}
const blocks = (r: TranscriptRecord): Array<{ type?: string }> =>
  Array.isArray(r.message?.content) ? (r.message.content as Array<{ type?: string }>) : [];

/**
 * The main conversation's turn is over (`text`: the transcript's end, oldest
 * first): newest first, a `system` `turn_duration` record comes before any
 * prompt (a user record that is not only tool results, not meta), or the
 * newest message is an assistant reply without a tool call, at least
 * `quietMs` old (text-only turns write no turn_duration). Sub-agents'
 * sidechain records do not count. ponytail: Claude Code's record shapes
 * (2.1.306); when they change this says "running", and messages wait for idle.
 */
export function turnOver(text: string, now: number, quietMs: number): boolean {
  const lines = text.split('\n');
  let newest = true;
  for (let i = lines.length - 1; i >= 0; i--) {
    let r: TranscriptRecord;
    try {
      r = JSON.parse(lines[i]) as TranscriptRecord;
    } catch {
      continue; // the cut first line, a line being written
    }
    if (!r || typeof r !== 'object' || r.isSidechain) continue;
    if (r.type === 'system' && r.subtype === 'turn_duration') return true;
    if (r.type === 'user') {
      if (r.isMeta || (blocks(r).length && blocks(r).every((b) => b.type === 'tool_result')))
        continue;
      return false;
    }
    if (r.type === 'assistant' && newest) {
      newest = false;
      const at = Date.parse(r.timestamp ?? '');
      if (!blocks(r).some((b) => b.type === 'tool_use') && now - at >= quietMs) return true;
    }
  }
  return false;
}

/** The session answered something since it started (`since`, ms): a main-chain
 *  assistant record that new. A fresh or just resumed session has not; it reads
 *  `blocked` while it waits for its first message (T-0014), which is no question. */
export function answeredSince(text: string, since: number): boolean {
  for (const line of text.split('\n').reverse()) {
    let r: TranscriptRecord;
    try {
      r = JSON.parse(line) as TranscriptRecord;
    } catch {
      continue;
    }
    if (r && r.type === 'assistant' && !r.isSidechain && Date.parse(r.timestamp ?? '') >= since)
      return true;
  }
  return false;
}

/** The end of a transcript file, or '' when it cannot be read. */
export function tail(file: string): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    return buf.toString('utf-8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Only a header the server wrote carries our mark opener `⟨` (` ⟨m:<id>⟩`, ` ⟨re:<id>⟩`): in body
 *  text it becomes `〈`, so no sender can forge a header, a reply reference or a quote (transcriptView). */
const defang = (s: string): string => s.replaceAll('⟨', '〈');

/** What is typed in: the header and the text, or an inbox delivery as is (an inbox file is a join of
 *  messages this function already composed). */
export const messageOf = (m: QueuedSend): string =>
  m.inbox || (m.raw && fromApp(m) && slashTextProblem(m.text) === null)
    ? m.text
    : `${header(m)}\n${m.replyTo && m.messageId ? `${defang(quoteLine(m.replyTo.sender ?? BOSS_NAME, m.replyTo.text))}\n` : ''}${defang(m.text)}`;

const preview = (text: string) => text.split('\n', 1)[0].slice(0, 80);

/** The messenger UI stores uploaded attachments as final `[첨부]` lines. An
 * edit changes the words before them, never the already-uploaded files. */
function withoutAttachmentTail(text: string): { body: string; attachments: string[] } {
  const lines = text.split('\n');
  const attachments: string[] = [];
  while (/^\[첨부\] (?:\/|[A-Za-z]:[\\/]|\\\\)[^\n]+ \([^(),]+, \d+ KB\)$/.test(lines.at(-1) ?? ''))
    attachments.unshift(lines.pop()!);
  return { body: lines.join('\n').trimEnd(), attachments };
}

/** A queue file's content, or null when it is not one. */
export function parseQueued(raw: string): QueuedSend | null {
  let j: Partial<QueuedSend>;
  try {
    j = JSON.parse(raw) as Partial<QueuedSend>;
  } catch {
    return null;
  }
  const ok =
    j &&
    j.v === 1 &&
    typeof j.to === 'string' &&
    typeof j.text === 'string' &&
    (j.from === null || typeof j.from === 'string') &&
    typeof j.source === 'string' &&
    typeof j.ifIdle === 'boolean' &&
    typeof j.created === 'number' &&
    (j.inbox === undefined ||
      (Array.isArray(j.inbox) && j.inbox.every((f) => typeof f === 'string'))) &&
    (j.now === undefined || typeof j.now === 'boolean') &&
    (j.group === undefined ||
      (!!j.group &&
        typeof j.group === 'object' &&
        typeof (j.group as NonNullable<QueuedSend['group']>).roomId === 'string' &&
        typeof (j.group as NonNullable<QueuedSend['group']>).roomName === 'string' &&
        typeof (j.group as NonNullable<QueuedSend['group']>).messageId === 'string')) &&
    (j.messageId === undefined ||
      (typeof j.messageId === 'string' && MESSAGE_ID.test(j.messageId))) &&
    (j.raw === undefined || j.raw === true) &&
    (j.task === undefined || (typeof j.task === 'string' && TASK_ID.test(j.task))) &&
    (j.replyTo === undefined ||
      JSON.stringify(replyRef(j.replyTo)) === JSON.stringify(j.replyTo));
  // `edited` is deliberately part of the on-disk item, so a reload still
  // tells every messenger that this is the replacement text.
  if (ok && j.edited !== undefined && j.edited !== true) return null;
  if (ok && j.held !== undefined && j.held !== true) return null;
  if (ok && j.kind !== undefined && j.kind !== 'nudge') return null;
  if (ok && j.notice !== undefined && j.notice !== 'action' && j.notice !== 'fyi') return null;
  return ok ? (j as QueuedSend) : null;
}

/** Write a file atomically (tmp in the same folder, then rename), 0600. */
export function writeAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

let seq = 0;
/** `<ms>-<n>-<hex>`: names sort in the order they were made (the same ms included). */
const stampName = (t: number, ext: string) =>
  `${t}-${String(++seq % 1_000_000).padStart(6, '0')}${randomBytes(2).toString('hex')}${ext}`;

/** A stamped name's time (`<ms>-…`, stampName), or null: an engine notice's `0-…` name has none. */
const stampOf = (name: string): number | null => {
  const m = /^([1-9]\d*)-/.exec(name);
  return m ? Number(m[1]) : null;
};

/**
 * D3b (design-d3b §3.2 5c), files only: what was on its way to `from` before `before` (a Lead
 * swap's commit) is for the agent that now answers to `to`. Queue files with `to: from` and
 * `created < before` get `to`; inbox/<from>/ files stamped before it move to inbox/<to>/ (a
 * boss message's sidecar with them, re-addressed). A start hook's pending inbox delivery to
 * either name is dropped (its files stay for the next start, which delivers the swap's prompt
 * first). Idempotent: a re-run finds nothing left to move.
 */
export function readdressFiles(
  home: string,
  from: string,
  to: string,
  before: number,
  log: (line: string) => void = () => undefined,
): void {
  const queueDir = path.join(configDir(home), 'queue');
  const inboxDir = path.join(configDir(home), 'inbox');
  let names: string[] = [];
  try {
    names = fs.readdirSync(queueDir).filter((n) => n.endsWith('.json'));
  } catch {
    /* no queue */
  }
  for (const n of names) {
    const file = path.join(queueDir, n);
    let item: QueuedSend | null;
    try {
      item = parseQueued(fs.readFileSync(file, 'utf-8'));
    } catch {
      continue;
    }
    if (!item || (item.to !== from && item.to !== to)) continue;
    if (item.inbox) fs.rmSync(file, { force: true });
    else if (item.to === from && item.created < before)
      writeAtomic(file, JSON.stringify({ ...item, to }));
  }
  let files: string[] = [];
  try {
    files = fs.readdirSync(path.join(inboxDir, from), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name);
  } catch {
    return; // no inbox
  }
  for (const f of files) {
    const at = stampOf(f);
    if (at === null || at >= before) continue;
    const src = path.join(inboxDir, from, f);
    fs.mkdirSync(path.join(inboxDir, to), { recursive: true, mode: 0o700 });
    try {
      const meta = parseQueued(fs.readFileSync(`${src}.meta.json`, 'utf-8'));
      if (meta) writeAtomic(path.join(inboxDir, to, `${f}.meta.json`), JSON.stringify({ ...meta, to }));
      fs.rmSync(`${src}.meta.json`, { force: true });
    } catch {
      /* an engine notice has no sidecar */
    }
    fs.renameSync(src, path.join(inboxDir, to, f));
    log(`inbox ${from}/${f} -> ${to}/ (lead swap)`);
  }
}

export interface MessengerOptions {
  home: string;
  engine: MessengerEngine;
  typist: Typist;
  events: EngineEvents;
  log?: (line: string) => void;
  timing?: Partial<typeof MESSENGER_TIMING>;
  now?: () => number;
  /** C3: told, at the moment a message is typed, which turn it starts (a room's or a one-to-one). */
  ledger?: TurnLedger;
  /** A room timeline observes its member's queue/typed/inbox progress. */
  onDelivery?: (
    item: QueuedSend,
    delivered: 'pane' | 'queued' | 'inbox' | 'held',
    reason?: string,
  ) => void;
}

interface Pending {
  file: string;
  item: QueuedSend;
}

interface InboxPending extends Pending {
  /** The inbox's `.md`; `file` is its metadata sidecar. */
  messageFile: string;
  id: string;
}

interface CancelledPending {
  id: string;
  text: string;
  at: number;
  cancelled: true;
}

interface TypedMessage {
  text: string;
  at: number;
}


const TYPED_LIMIT = 20;

export class Messenger {
  readonly queueDir: string;
  readonly inboxDir: string;
  readonly typedDir: string;
  /** Pending sends in delivery order (file names sort by creation; inbox deliveries first). */
  private pending: Pending[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watcher: fs.FSWatcher | null = null;
  private ticking = false;
  /** One attach types at a time. */
  private typing: Promise<unknown> = Promise.resolve();
  /** The messages being entered now (a Typist paste, a provider's own delivery): unchangeable. */
  private readonly typingItems = new Set<QueuedSend>();
  private readonly retryAt = new Map<string, number>();
  /** TOKEN-GUARD: attaches in a row that did not type, per target (the retry backoff). */
  private readonly misses = new Map<string, number>();
  private readonly heldNow = new Set<string>();
  private readonly whyWaiting = new Map<string, string>();
  private readonly typed = new Map<string, TypedMessage[]>();
  /** Kept for this daemon lifetime so every open messenger sees a cancellation. */
  private readonly cancelled = new Map<string, CancelledPending[]>();
  private disposed = false;
  private registryHeld: string | null = null;
  private readonly t: typeof MESSENGER_TIMING;
  private readonly now: () => number;

  constructor(private readonly opts: MessengerOptions) {
    this.queueDir = path.join(configDir(opts.home), 'queue');
    this.inboxDir = path.join(configDir(opts.home), 'inbox');
    this.typedDir = path.join(configDir(opts.home), 'typed');
    this.t = { ...MESSENGER_TIMING, ...opts.timing };
    this.now = opts.now ?? Date.now;
  }

  /** Pick up queue files (also those `cld-gui send` wrote while the daemon was off). */
  start(): void {
    this.loadQueue();
    try {
      fs.mkdirSync(this.queueDir, { recursive: true, mode: 0o700 });
      this.watcher = fs.watch(this.queueDir, (_e, name) => {
        if (name && name.endsWith('.json')) this.loadQueue();
      });
      this.watcher.on('error', () => undefined);
    } catch {
      // No watch: files written while the daemon runs wait for the next start.
    }
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.close();
    if (this.timer) clearTimeout(this.timer);
  }

  /** A `cld-gui send`. Never rejects. */
  async send(req: {
    to: string;
    text: string;
    ifIdle: boolean;
    from: string | null;
    source: string;
    now?: boolean;
    created?: number;
    group?: QueuedSend['group'];
    /** Office-only: a catalogue-validated command from the privileged boss. */
    raw?: boolean;
    /** A room delivery's id, made by the room (it records it in the post). */
    messageId?: string;
    /** C6: the delegated Task this message hands over (named in the header). */
    task?: string;
    /** MSG-ACTIONS: the message this one answers (replyRef makes it safe). */
    replyTo?: unknown;
    /** S-05: the compaction nudge (engine only). */
    kind?: 'nudge';
    /** K1: a daemon-made notice's class (QueuedSend.notice); ignored on the owner's words and room posts. */
    notice?: 'action' | 'fyi';
  }): Promise<SendResult> {
    // TOKEN-GUARD (TG-09): a message to oneself is a paid turn nobody asked for (a self-reminder
    // loop). MCP refuses it too; this covers every path (the CLI, rooms, the daemon's own sends).
    if (req.from && req.from === req.to) {
      this.guard({ trigger: 'send', to: req.to, from: req.from, source: req.source, allowed: false, reason: 'self_send' });
      return { ok: false, code: 'self_send', ...refused('send_self') };
    }
    const text = cleanText(req.text);
    if (!text.trim()) return { ok: false, code: 'empty_message', ...refused('message_empty') };
    if (Buffer.byteLength(text) > TEXT_MAX)
      return {
        ok: false,
        code: 'too_large',
        ...refused('message_too_long', { kb: TEXT_MAX / 1024 }),
      };
    if (!this.opts.engine.names().includes(req.to))
      return {
        ok: false,
        code: 'unknown_project',
        ...refused('send_project_unknown', { name: req.to, names: this.opts.engine.names().join(' ') }),
      };
    const refusal = this.opts.engine.refuses?.(req.to, req);
    if (refusal) return { ok: false, ...refusal };
    const replyTo = replyRef(req.replyTo); // a raw command has no header to carry it (messageOf)
    const item: QueuedSend = {
      v: 1,
      to: req.to,
      text,
      from: req.from,
      source: req.source,
      ifIdle: req.ifIdle,
      created: req.created ?? this.now(),
      messageId: req.messageId ?? newMessageId(),
      // Commands follow the ordinary idle-turn queue: they never interrupt a turn.
      ...(req.now && !req.raw && { now: true }),
      ...(req.group && { group: req.group }),
      ...(req.task && req.from && TASK_ID.test(req.task) && { task: req.task }),
      ...(replyTo && { replyTo }),
      ...(req.kind === 'nudge' && !req.from && { kind: 'nudge' as const }),
      ...(req.notice && (req.from || req.source === 'engine') && !req.group && { notice: req.notice }),
      ...(req.raw &&
      req.from === null &&
      req.source.startsWith('messenger:') &&
      slashTextProblem(text) === null
        ? { raw: true as const }
        : {}),
    };
    let s = this.opts.engine.sessionOf(req.to);
    // An idle-retired project is deliberately off until something addresses it.
    // Start it before choosing delivery so this message itself is its first prompt.
    // K1: an FYI never starts anything.
    if (s === null && !item.raw && !fyi(item) && (await this.opts.engine.wake?.(req.to)))
      s = this.opts.engine.sessionOf(req.to);
    if ((s === null || s === 'terminal') && !fyi(item)) {
      // A command acts on a live session; an inbox file would run it at some later start.
      if (item.raw)
        return {
          ok: false,
          code: 'not_running',
          ...refused('command_needs_live'),
        };
      const reason = s === 'terminal' ? 'terminal' : 'off';
      const id = this.toInbox(item, reason);
      if (!id) return { ok: false, code: 'queue_failed', ...refused('inbox_write_failed') };
      return {
        ok: true,
        delivered: 'inbox',
        reason,
        ...(fromApp(item) && { id }),
        ...this.idOf(item),
      };
    }
    // Behind messages already waiting for this session (they keep their order).
    // K1: a notice always waits for the tick (its batch window, or a paste to ride in).
    const line = [...this.pending.filter((p) => p.item.to === req.to), { item }];
    if (!item.notice && typeof s === 'object' && s && this.next(req.to, s, line)?.item === item) {
      if ((await this.attempt(s.id, [item])) === 'typed') {
        this.record(item, 'pane');
        return { ok: true, delivered: 'pane', ...this.idOf(item) };
      }
    }
    const name = stampName(item.created, '.json');
    if (!this.enqueue(item, name))
      return { ok: false, code: 'queue_failed', ...refused('queue_write_failed') };
    this.record(item, 'queued');
    return { ok: true, delivered: 'queued', id: name, ...this.idOf(item) };
  }

  /** The id a result reports: only a message whose header carries the mark has one to bind. */
  private idOf(item: QueuedSend): { messageId?: string } {
    return item.messageId && messageOf(item) !== item.text ? { messageId: item.messageId } : {};
  }

  /** TOKEN-GUARD (directive §4): one event per input the engine blocked or dropped: what made it,
   *  for whom, why. Ids and names only: never a message body or a token. */
  guard(fields: Record<string, unknown>): void {
    this.opts.events.append('token_guard', 'engine', fields);
    this.log(`token guard: ${String(fields.reason)} (${String(fields.trigger)} → ${String(fields.to ?? '')})`);
  }

  /** The boss's messages waiting for `to` (the app's 보냄(대기 중) after a reload). */
  queuedFor(to: string): Array<{
    id: string;
    text: string;
    at: number;
    now?: boolean;
    edited?: boolean;
    cancelled?: boolean;
    held?: boolean;
    messageId?: string;
    replyTo?: ChatReply;
  }> {
    const queued = this.pending
      .filter((p) => p.item.to === to && fromApp(p.item))
      .map((p) => this.queuedView(path.basename(p.file), p.item));
    return [...queued, ...this.inboxQueuedFor(to), ...(this.cancelled.get(to) ?? [])];
  }

  /** 지금 보내기: the boss's waiting message `id` becomes a `now` one (goes in at the next check). */
  promote(to: string, id: string): SendResult {
    const p = this.pending.find(
      (x) => x.item.to === to && path.basename(x.file) === id && fromApp(x.item),
    );
    if (!p) return { ok: false, code: 'not_queued', ...refused('not_waiting') };
    if (p.item.raw)
      return { ok: false, code: 'not_queued', ...refused('command_after_turn') };
    if (!p.item.now) {
      const item = { ...p.item, now: true };
      try {
        writeAtomic(p.file, JSON.stringify(item));
      } catch (err) {
        this.log(`queue ${to}: ${err instanceof Error ? err.message : String(err)}`);
        return { ok: false, code: 'queue_failed', ...refused('queue_write_failed') };
      }
      p.item = item;
    }
    void this.tick();
    return { ok: true, delivered: 'queued', id };
  }

  /** MSG-HOLD2: keep the boss's queued message `id` from delivery while it is edited (`on`), or
   *  let it go again (the edit cancelled, the original approved). Any privileged page may decide:
   *  the page that started the edit may be gone (a reload, a daemon restart). False: not a waiting
   *  message any more, or the Typist is entering it already (nothing to hold back). */
  hold(to: string, id: string, on: boolean): boolean {
    const target = this.pending.find(
      (p) => p.item.to === to && path.basename(p.file) === id && fromApp(p.item),
    );
    if (!target || this.isTyping(target)) return false;
    if (!!target.item.held === on) return true;
    const { held: _held, ...rest } = target.item;
    const item: QueuedSend = on ? { ...rest, held: true } : rest;
    try {
      writeAtomic(target.file, JSON.stringify(item));
    } catch (err) {
      this.log(`hold ${to}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    target.item = item;
    this.opts.events.append('send_hold', item.source, { to, id, on });
    if (!on) void this.tick();
    return true;
  }

  /** Cancel a boss message before the Typist has started entering it. */
  cancel(to: string, id: string): SendResult {
    const target = this.pendingTarget(to, id);
    if (!target) return { ok: false, code: 'not_queued', ...refused('message_gone') };
    if (this.isTyping(target)) return this.typingRefusal();
    try {
      fs.rmSync(target.file, { force: true });
      if ('messageFile' in target) fs.rmSync(target.messageFile, { force: true });
    } catch (err) {
      this.log(`cancel ${to}: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, code: 'queue_failed', ...refused('queue_write_failed') };
    }
    if (!('messageFile' in target)) this.pending = this.pending.filter((p) => p !== target);
    this.cancelled.set(to, [
      ...(this.cancelled.get(to) ?? []).filter((p) => p.id !== id),
      { id, text: target.item.text, at: target.item.created, cancelled: true },
    ]);
    this.opts.events.append('send_cancel', target.item.source, { to, id });
    void this.tick();
    return { ok: true, delivered: 'queued', id };
  }

  /** Replace a boss message in place before the Typist has started entering it. */
  edit(to: string, id: string, rawText: string): SendResult {
    const target = this.pendingTarget(to, id);
    if (!target) return { ok: false, code: 'not_queued', ...refused('message_gone') };
    if (this.isTyping(target)) return this.typingRefusal();
    const edited = withoutAttachmentTail(cleanText(rawText));
    if (!edited.body.trim())
      return { ok: false, code: 'empty_message', ...refused('message_empty') };
    const text = [edited.body, ...withoutAttachmentTail(target.item.text).attachments].join('\n');
    if (Buffer.byteLength(text) > TEXT_MAX)
      return {
        ok: false,
        code: 'too_large',
        ...refused('message_too_long', { kb: TEXT_MAX / 1024 }),
      };
    const { raw, held: _held, ...rest } = target.item; // saving the edit ends its hold
    const item: QueuedSend = {
      ...rest,
      text,
      edited: true,
      ...(raw && slashTextProblem(text) === null && { raw: true }),
    };
    try {
      if ('messageFile' in target) {
        // Inbox delivery reads this exact file, so its stable name and any
        // adjacent attachment paths survive the atomic replacement.
        writeAtomic(target.messageFile, messageOf({ ...item, raw: undefined }));
      }
      writeAtomic(target.file, JSON.stringify(item));
    } catch (err) {
      this.log(`edit ${to}: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, code: 'queue_failed', ...refused('queue_write_failed') };
    }
    if (!('messageFile' in target)) target.item = item;
    this.opts.events.append('send_edit', item.source, { to, id });
    void this.tick();
    return { ok: true, delivered: 'queued', id };
  }

  /** E1's start hook: the inbox as the first message, once the session is idle. */
  deliverInbox(name: string): void {
    const dir = path.join(this.inboxDir, name);
    const queued = new Set(this.pending.flatMap((p) => p.item.inbox ?? []));
    let files: string[];
    try {
      files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.md') && !queued.has(f))
        .sort();
    } catch {
      return;
    }
    if (!files.length) return;
    const text = files
      .map((f) => {
        try {
          return fs.readFileSync(path.join(dir, f), 'utf-8').trimEnd();
        } catch {
          return '';
        }
      })
      .filter(Boolean)
      .join('\n\n');
    const created = this.now();
    // "0-" sorts before every timestamped name: the first message of the session.
    this.enqueue(
      {
        v: 1,
        to: name,
        text,
        from: null,
        source: 'engine',
        ifIdle: false,
        created,
        inbox: files,
        // Typed as is: the marks are the inbox files' own (the first one binds the turn).
        messageId: newMessageId(),
      },
      `0-${stampName(created, '.json')}`,
    );
  }

  /** A message straight to the inbox (renew's handoff, revive's notice). */
  writeInbox(name: string, text: string): boolean {
    try {
      writeAtomic(path.join(this.inboxDir, name, stampName(this.now(), '.md')), text);
      return true;
    } catch (err) {
      this.log(`inbox ${name}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** D3b: after a Lead swap (readdressFiles ran): forget what this daemon held in memory for
   *  `names` (pending items, typed hints, retry pauses) and read their queue files again. */
  resync(names: string[]): void {
    // The one being typed stays as it is (its own tick finishes it).
    this.pending = this.pending.filter((p) => !names.includes(p.item.to) || this.typingItems.has(p.item));
    for (const name of names) {
      this.typed.delete(name);
      this.retryAt.delete(name);
      this.misses.delete(name);
      this.heldNow.delete(name);
      this.whyWaiting.delete(name);
    }
    this.loadQueue();
  }

  /** Waiting messages (tests, status). */
  get queued(): QueuedSend[] {
    return this.pending.map((p) => p.item);
  }

  // ── Internals ───────────────────────────────────────────────

  private queuedView(id: string, item: QueuedSend) {
    return {
      id,
      text: item.text,
      at: item.created,
      ...(item.now && { now: true }),
      ...(item.edited && { edited: true }),
      ...(item.held && { held: true }),
      ...(item.replyTo && { replyTo: item.replyTo }),
      ...this.idOf(item),
    };
  }

  /** Boss inbox entries carry metadata beside their unchanged `.md` delivery file. */
  private inboxQueuedFor(to: string) {
    const dir = path.join(this.inboxDir, to);
    let names: string[];
    try {
      names = fs
        .readdirSync(dir)
        .filter((name) => name.endsWith('.md.meta.json'))
        .sort();
    } catch {
      return [];
    }
    return names.flatMap((meta) => {
      const file = meta.slice(0, -'.meta.json'.length);
      const p = this.inboxPending(to, `inbox:${file}`);
      return p ? [this.queuedView(p.id, p.item)] : [];
    });
  }

  private inboxPending(to: string, id: string): InboxPending | null {
    if (!id.startsWith('inbox:')) return null;
    const file = id.slice('inbox:'.length);
    if (!file.endsWith('.md') || path.basename(file) !== file) return null;
    const messageFile = path.join(this.inboxDir, to, file);
    const metaFile = `${messageFile}.meta.json`;
    let item: QueuedSend | null;
    try {
      if (!fs.statSync(messageFile).isFile()) return null;
      item = parseQueued(fs.readFileSync(metaFile, 'utf-8'));
    } catch {
      return null;
    }
    return item && item.to === to && fromApp(item)
      ? { file: metaFile, messageFile, item, id }
      : null;
  }

  private pendingTarget(to: string, id: string): Pending | InboxPending | null {
    const queued = this.pending.find(
      (p) => p.item.to === to && path.basename(p.file) === id && fromApp(p.item),
    );
    return queued ?? this.inboxPending(to, id);
  }

  private isTyping(target: Pending | InboxPending): boolean {
    return [...this.typingItems].some(
      (t) =>
        t === target.item ||
        ('messageFile' in target && !!t.inbox?.includes(path.basename(target.messageFile))),
    );
  }

  private typingRefusal(): SendResult {
    return { ok: false, code: 'typing', ...refused('already_typing') };
  }

  /** What goes into `to` now from its `line` (in order): the first when the session is
   *  idle (or busy only with background work: its main turn is over); while it
   *  works, the first `now` one (the others wait for idle). */
  private next<T extends { item: QueuedSend }>(
    to: string,
    s: { status?: string; transcript?: string },
    line: T[],
  ): T | undefined {
    const pick = this.pickNext(to, s, line);
    // Say why a message waits, once per change: a silent hold cost 90 s of guessing (10-22).
    const why = pick || !line.length ? '' : this.waitReason(to, s);
    if (why !== (this.whyWaiting.get(to) ?? '')) {
      if (why) this.log(`"${to}": messages wait: ${why}`);
      if (why) this.whyWaiting.set(to, why);
      else this.whyWaiting.delete(to);
    }
    return pick;
  }

  private pickNext<T extends { item: QueuedSend }>(
    to: string,
    s: { status?: string; transcript?: string },
    line: T[],
  ): T | undefined {
    if (this.opts.engine.renewing(to) || (this.retryAt.get(to) ?? 0) > this.now()) return undefined;
    if (turnEnded(s.status)) return line[0]; // idle, or `shell` (RENEW-STUCK)
    // Only `busy` takes a 즉시 message. Any other status (`waiting`, none at all)
    // is judged by the transcript like a busy one: is its main turn over?
    const urgent = s.status === 'busy' ? line.find((p) => p.item.now) : undefined;
    if (urgent || !line.length || !s.transcript) return urgent;
    return turnOver(tail(s.transcript), this.now(), this.t.quietMs) ? line[0] : undefined;
  }

  private waitReason(to: string, s: { status?: string }): string {
    if (this.opts.engine.renewing(to)) return 'its renewal or a Lead swap is under way';
    if ((this.retryAt.get(to) ?? 0) > this.now()) return 'pause after a miss';
    return `session ${s.status ?? 'without status'}, main turn running`;
  }

  /** Projects whose messages are held: their session needs an answer at its terminal. */
  held(to: string): boolean {
    return this.heldNow.has(to) && this.pending.some((p) => p.item.to === to);
  }

  /** typeIn, unless the session waits on its terminal (held): then no attach, and the
   *  usual pause before the next look. */
  private async attempt(id: string, items: QueuedSend[]): Promise<TypeResult> {
    const item = items[0];
    const to = item.to;
    const held = await (this.opts.engine.held?.(to) ?? Promise.resolve(false)).catch(() => false);
    if (held) {
      if (!this.heldNow.has(to)) this.log(`"${to}" waits on its terminal; its messages wait too`);
      this.heldNow.add(to);
      this.retryAt.set(to, this.now() + this.t.retryMs);
      for (const i of items) this.opts.onDelivery?.(i, 'held');
      return 'notReady';
    }
    this.heldNow.delete(to);
    return this.typeIn(id, items);
  }

  /** After an attempt: a miss stretches the next pause (doubling, capped) and is reported once
   *  when it keeps missing; a typed message resets both. The message itself always stays queued. */
  private settle(to: string, r: TypeResult): void {
    if (r === 'typed') {
      this.retryAt.delete(to);
      this.misses.delete(to);
      return;
    }
    const n = (this.misses.get(to) ?? 0) + 1;
    this.misses.set(to, n);
    this.retryAt.set(to, this.now() + this.t.retryMs * Math.min(2 ** (n - 1), RETRY_MAX_FACTOR));
    if (n === STUCK_MISSES) {
      this.log(`"${to}": ${n} tries in a row did not type; trying less often`);
      this.opts.events.append('send_stuck', 'engine', { to, misses: n });
    }
  }

  /** Type through the Typist, one attach at a time; a miss holds this target off for a while.
   *  D5: an agent that takes messages itself gets it from its provider (no attach). */
  private typeIn(id: string, items: QueuedSend[]): Promise<TypeResult> {
    const item = items[0];
    const text = items.map(messageOf).join('\n\n');
    // The turn belongs to the first message (its header starts the paste); the others are known too.
    const typedAll = () => {
      this.rememberTyped(item.to, text);
      for (const i of [...items].reverse()) this.opts.ledger?.typed(item.to, i);
    };
    // Check and mark in one synchronous step (MSG-HOLD2): no hold can slip in between.
    if (this.heldOnDisk(items)) return Promise.resolve('notReady');
    const own = this.opts.engine.deliver?.(item.to, text, {
      ...(item.task && { task: item.task }),
      ...(item.group && { group: item.group }),
      ...(item.messageId && { messageId: item.messageId }),
    });
    if (own) {
      for (const i of items) this.typingItems.add(i);
      return own
        .catch((err: unknown) => {
          this.log(`deliver to ${item.to}: ${err instanceof Error ? err.message : String(err)}`);
          return 'failed' as const;
        })
        .then((r) => {
          for (const i of items) this.typingItems.delete(i);
          if (r === 'typed') typedAll();
          this.settle(item.to, r);
          return r;
        });
    }
    const run = this.typing.then(async () => {
      let r: TypeResult;
      if (this.heldOnDisk(items)) return 'notReady' as const; // held while waiting for the Typist
      try {
        for (const i of items) this.typingItems.add(i);
        r = await this.opts.typist.type(id, text, {
          whileWorking: !!item.now && !item.raw,
          busy: (() => {
            const s = this.opts.engine.sessionOf(item.to);
            return typeof s === 'object' && s?.status === 'busy';
          })(),
          earlier: this.typedFor(item.to).map((m) => m.text),
          onTyped: typedAll,
        });
      } catch (err) {
        this.log(`type into ${item.to}: ${err instanceof Error ? err.message : String(err)}`);
        r = 'failed';
      }
      for (const i of items) this.typingItems.delete(i);
      this.settle(item.to, r);
      return r;
    });
    this.typing = run.catch(() => undefined);
    return run;
  }

  /** The last messages pasted into a project's session, loaded lazily after a daemon restart. */
  private typedFor(to: string): TypedMessage[] {
    const known = this.typed.get(to);
    if (known) return known;
    let messages: TypedMessage[] = [];
    try {
      const raw: unknown = JSON.parse(
        fs.readFileSync(path.join(this.typedDir, `${to}.json`), 'utf-8'),
      );
      if (Array.isArray(raw))
        messages = raw
          .filter(
            (m): m is TypedMessage =>
              !!m &&
              typeof m === 'object' &&
              typeof (m as TypedMessage).text === 'string' &&
              typeof (m as TypedMessage).at === 'number',
          )
          .slice(-TYPED_LIMIT);
    } catch {
      // No history (or an interrupted/old file): this is only a self-healing hint.
    }
    this.typed.set(to, messages);
    return messages;
  }

  private rememberTyped(to: string, text: string): void {
    const messages = [...this.typedFor(to), { text, at: this.now() }].slice(-TYPED_LIMIT);
    this.typed.set(to, messages);
    try {
      writeAtomic(path.join(this.typedDir, `${to}.json`), `${JSON.stringify(messages)}\n`);
    } catch (err) {
      this.log(`typed history ${to}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private enqueue(item: QueuedSend, name = stampName(item.created, '.json')): boolean {
    const file = path.join(this.queueDir, name);
    try {
      writeAtomic(file, JSON.stringify(item));
    } catch (err) {
      this.log(`queue ${item.to}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    this.add({ file, item });
    return true;
  }

  private add(p: Pending): void {
    if (this.pending.some((x) => x.file === p.file)) return;
    this.pending.push(p);
    this.pending.sort((a, b) => path.basename(a.file).localeCompare(path.basename(b.file)));
    this.schedule(this.t.tickMs);
  }

  private loadQueue(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.queueDir).filter((n) => n.endsWith('.json'));
    } catch {
      return;
    }
    for (const n of names) {
      const file = path.join(this.queueDir, n);
      if (this.pending.some((p) => p.file === file)) continue;
      let raw: string;
      try {
        raw = fs.readFileSync(file, 'utf-8');
      } catch {
        continue; // taken meanwhile
      }
      const item = parseQueued(raw);
      if (!item) {
        this.log(`${file}: not a queued message; left alone`);
        continue;
      }
      this.add({ file, item });
    }
  }

  private schedule(ms: number): void {
    if (this.disposed || this.timer || !this.pending.length) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, ms);
  }

  /** Every 2 s while anything waits: each target's first message, when its session is ready. */
  async tick(): Promise<void> {
    if (this.ticking || this.disposed) return;
    this.ticking = true;
    try {
      // A broken registry is not "every project is gone": no drop, no inbox move until it reads again.
      const problem = this.opts.engine.registryProblem?.() ?? null;
      if (problem !== this.registryHeld) {
        this.registryHeld = problem;
        if (problem) this.log(`messages wait: the project registry is unreadable (${problem})`);
      }
      if (problem) return;
      const names = this.opts.engine.names();
      for (const to of [...new Set(this.pending.map((p) => p.item.to))]) {
        const mine = () => this.pending.filter((p) => p.item.to === to);
        // MSG-HOLD2 + liveness: a message held for editing keeps the boss's later words behind it
        // (their order), while agents' messages and engine notices go past it.
        const beforeHold = () => {
          const line = mine();
          const held = line.findIndex((p) => p.item.held);
          return held < 0 ? line : line.filter((p, i) => i < held || (!p.item.held && !fromOwner(p.item)));
        };
        if (!names.includes(to)) {
          for (const p of mine()) this.drop(p, 'the project is gone');
          continue;
        }
        // S-05: a renewal under way or a session gone makes its compaction nudge stale: dropped.
        const s0 = this.opts.engine.sessionOf(to);
        if (this.opts.engine.renewing(to) || s0 === null || s0 === 'terminal')
          for (const p of mine())
            if (p.item.kind === 'nudge') {
              this.guard({ trigger: 'tick', to, messageId: p.item.messageId, allowed: false, reason: 'stale_nudge' });
              this.drop(p, 'a stale compaction nudge');
            }
        if (!mine().length) continue;
        // D5 (6.3): an agent of a provider this build lacks: its files wait as they are.
        if (this.opts.engine.refuses?.(to, mine()[0].item)?.code === 'unknown_provider') continue;
        const s = this.opts.engine.sessionOf(to);
        if (s === null || s === 'terminal') {
          const reason = s === 'terminal' ? 'terminal' : 'off';
          // An inbox delivery's files stay where they are, for the next start.
          for (const p of beforeHold())
            if (p.item.inbox) this.done(p);
            else if (fyi(p.item)) continue; // K1: waits in the queue for a later paste, never lost
            else if (this.toInbox(p.item, reason, true)) this.done(p);
          continue;
        }
        for (const p of beforeHold())
          if (p.item.ifIdle && this.now() - p.item.created >= this.t.ifIdleMs)
            if (this.toInbox(p.item, 'input_busy', true)) this.done(p);
        // K1: FYIs never start a paste; they ride in the next one an agent or the engine makes.
        const line = beforeHold().filter((p) => !fyi(p.item));
        const first = this.next(to, s, line);
        if (!first) continue;
        // K1: an action-needed notice at the head waits out its window, so its burst is one turn.
        if (first === line[0] && first.item.notice === 'action' && this.now() - first.item.created < this.t.noticeBatchMs)
          continue;
        // TOKEN-GUARD: what the transcript already shows was typed (an unsure submit, a restart
        // between typing and removing the file) leaves the queue without a second paste.
        const tailText = s.transcript && first.item.messageId && !first.item.inbox ? tail(s.transcript) : '';
        const typedBefore = (p: Pending): boolean => {
          if (!tailText || !alreadyTyped(tailText, p.item.messageId!)) return false;
          this.guard({ trigger: 'tick', to, messageId: p.item.messageId, allowed: false, reason: 'already_typed' });
          this.done(p);
          this.record(p.item, 'pane', 'already_typed', true);
          return true;
        };
        if (typedBefore(first)) continue;
        // TG-04: on the idle path, plain agent/engine messages waiting next to each other: one paste.
        const batch = [first];
        if (first === line[0] && mergeable(first.item)) {
          let bytes = Buffer.byteLength(messageOf(first.item));
          for (const p of line.slice(1)) {
            bytes += Buffer.byteLength(messageOf(p.item)) + 2;
            if (!mergeable(p.item) || bytes > TEXT_MAX) break;
            batch.push(p);
          }
          // K1: the waiting FYIs go along (after the turn's own first message).
          for (const p of beforeHold().filter((x) => fyi(x.item) && mergeable(x.item))) {
            if (typedBefore(p)) continue;
            bytes += Buffer.byteLength(messageOf(p.item)) + 2;
            if (bytes > TEXT_MAX) break;
            batch.push(p);
          }
        }
        if ((await this.attempt(s.id, batch.map((p) => p.item))) !== 'typed') continue;
        for (const p of batch) {
          this.done(p);
          if (p.item.inbox) this.delivered(p.item);
          else this.record(p.item, 'pane', undefined, true);
        }
      }
    } finally {
      this.ticking = false;
      this.schedule(this.t.tickMs);
    }
  }

  /** MSG-HOLD2: the last look before typing, at the files themselves: a message whose queue file
   *  is gone (cancelled) or says `held` is not typed. Called in the same synchronous step that
   *  marks the messages as being typed, so a hold either lands before it (and wins) or finds them
   *  being typed (and is refused): never both. Messages with no queue file (a send typed at once)
   *  cannot be held. */
  private heldOnDisk(items: QueuedSend[]): boolean {
    for (const item of items) {
      // By its id too: a hold or an edit replaced the pending entry's object meanwhile.
      const p = this.pending.find(
        (x) => x.item === item || (!!item.messageId && x.item.messageId === item.messageId && x.item.to === item.to),
      );
      if (!p) continue;
      let onDisk: QueuedSend | null = null;
      try {
        onDisk = parseQueued(fs.readFileSync(p.file, 'utf-8'));
      } catch {
        /* gone */
      }
      // An edit saved meanwhile (a hold and its save both landed in the wait): the words in hand are
      // stale, so not these; the next tick types the file's.
      if (!onDisk || onDisk.held || onDisk.text !== item.text) {
        if (onDisk) p.item = onDisk;
        return true;
      }
    }
    return false;
  }

  private done(p: Pending): void {
    this.pending = this.pending.filter((x) => x !== p);
    try {
      fs.rmSync(p.file, { force: true });
    } catch {
      /* already gone */
    }
  }

  private drop(p: Pending, why: string): void {
    this.log(`message for "${p.item.to}" dropped: ${why}`);
    this.done(p);
  }

  /** Into inbox/<to>/ with its header; false when the file could not be written. */
  private toInbox(item: QueuedSend, reason: string, queued = false): string | null {
    // Never header-less in the inbox: a stale command must not run at the next start.
    const name = stampName(this.now(), '.md');
    const file = path.join(this.inboxDir, item.to, name);
    try {
      writeAtomic(file, messageOf({ ...item, raw: undefined }));
      // The `.md` remains the inbox's real payload. Its sidecar gives the
      // office a stable id and text to edit without changing delivery format.
      if (fromApp(item)) writeAtomic(`${file}.meta.json`, JSON.stringify(item));
    } catch (err) {
      this.log(`inbox ${item.to}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    this.record(item, 'inbox', reason, queued);
    return fromApp(item) ? `inbox:${name}` : name;
  }

  /** The inbox files a start-hook delivery typed in: to delivered/. */
  private delivered(item: QueuedSend): void {
    const dir = path.join(this.inboxDir, item.to);
    const files = item.inbox ?? [];
    for (const f of files) {
      try {
        fs.mkdirSync(path.join(dir, 'delivered'), { recursive: true, mode: 0o700 });
        fs.renameSync(path.join(dir, f), path.join(dir, 'delivered', f));
        // The sidecar only identifies an editable boss inbox message while it
        // waits. Keep it with the delivered record rather than re-listing it.
        const meta = `${f}.meta.json`;
        try {
          fs.renameSync(path.join(dir, meta), path.join(dir, 'delivered', meta));
        } catch {
          /* Ordinary inbox files have no messenger metadata. */
        }
      } catch {
        /* gone meanwhile */
      }
    }
    this.opts.events.append('inbox_deliver', 'engine', {
      to: item.to,
      file: files.length ? path.join(dir, 'delivered', files[0]) : null,
      count: files.length,
    });
  }

  private record(
    item: QueuedSend,
    delivered: 'pane' | 'queued' | 'inbox',
    reason?: string,
    queued = false,
  ): void {
    this.opts.events.append('send', item.source, {
      ...(item.from && { from: item.from }),
      to: item.to,
      delivered,
      ...(reason && { reason }),
      bytes: Buffer.byteLength(messageOf(item)),
      preview: preview(item.text),
      ...(queued && { queued: true }),
    });
    this.opts.onDelivery?.(item, delivered, reason);
  }

  private log(line: string): void {
    (this.opts.log ?? ((l: string) => console.log(`[cld engine] ${l}`)))(line);
  }
}
