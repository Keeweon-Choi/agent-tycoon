/**
 * A lead's conversation, read from its transcript JSONL (T-0014's chat view,
 * T-0043's messenger): user and assistant text, and one line per tool call
 * (tool name + the provider's status, plus its optional agent description,
 * which the client shows the EZ way).
 * A message the boss sent while the lead was mid-turn is no `user` record:
 * Claude Code queues it (a `queue-operation` enqueue, ignored here) and the
 * turn that picks it up carries it as an `attachment` of type `queued_command`
 * (humanTurn true), which is shown where it was delivered.
 * Sub-agent (sidechain) and meta records, tool results, thinking and
 * command/hook wrappers are left out, except the progress lines of Claude
 * Code's "updates" thinking display: a session in that mode keeps the short
 * lines it shows its user mid-turn ("T-0077 명세를 완료했고…") in thinking
 * blocks of records marked `thinkingDisplay: "updates"`. Those are what the
 * lead says, not its reasoning, and the messenger shows them (10-22 14:36).
 *
 * TranscriptTail reads incrementally: the end of the file once, then only
 * what was appended since (a torn last line waits for its newline). No PTY,
 * no re-parse of the whole tail on every change. The first read walks the
 * file backwards chunk by chunk until it has the last CHAT_MAX_ITEMS items:
 * a tail of huge tool results holds few messages (the cld-gui lead's 34 MB
 * transcript had 3 in its last 256 KB), so a fixed tail looked like a wiped
 * history after a restart.
 */
import * as fs from 'fs';

import { parseQuote } from '../../../core/src/cld/reply.js';
import { koText } from '../../../core/src/cld/serverText.js';
import type { ChatAttachment, ChatEmployee, ChatItem, ChatReply } from '../../../core/src/messages.js';
import { formatToolStatus } from '../providers/hook/claude/claude.js';
import { SENT_MAX, sentLines } from './files/outbox.js';

/** One backward read of a (re)load, and the largest jump an append is followed through. */
export const CHAT_TAIL_BYTES = 256 * 1024;
/** A (re)load gives up looking for older items after this many bytes. */
export const CHAT_SCAN_MAX_BYTES = 16 * 1024 * 1024;
/** A tool_result line this long is no message: skipped unparsed unless results are wanted. */
const BIG_RESULT_BYTES = 8 * 1024;
export const CHAT_MAX_ITEMS = 80;
const TEXT_MAX = 4000;
/** The boss's own messages are shown whole up to the chat's send limit (U-37). */
const USER_TEXT_MAX = 24_000;
const TOOL_DESC_MAX = 200;
/** Prompt-side wrappers Claude Code writes as user text (slash commands, hooks). */
const WRAPPER = /^<(command-|local-command|system-reminder|bash-|user-prompt-submit-hook)/;
/** The header line of a message the boss sent through the app: the engine
 *  messenger's for a `gui:` source. */
const BOSS_HEADER = /^\[(?:사장 · 메신저|사용자 · 앱\(gui:[A-Za-z0-9._:-]*\)) · [^\]\n]*\]\n/;
/** A peer's header line (another orchestrator, the ops agent): `cld-gui send`'s
 *  `<name>에게서`, and the older tool's `<name> 오케스트레이터가 보냄` (or `<name> 가 보냄`) still in old transcripts. Group 1/2 = the name. */
const PEER_HEADER = /^\[cld-gui · ([^\]\n]+?)에게서 · [^\]\n]*\]\n/;
/** The header line of a sender nobody named (`cld-gui send` with no `from`, an older tool's unknown sender): a notice. */
const SYSTEM_HEADER = /^\[cld-gui · 보냄 · [^\]\n]*\]\n/;
/** Notices that are their own first line, tag and all (Codex's end, the engine's recovery, an older tool's renew): kept whole. */
const SYSTEM_TAG = /^\[cld-gui (?:codex|renew|자동 복구)[\] ·]/;
/** Background-task completion records are notifications, not boss prompts. */
const TASK_NOTIFICATION = /^<task-notification>/;
/** The peer label shown for a background task's completion notice. */
export const TASK_NOTICE_NAME = koText('task_notice');
/** A group post is deliberately identified narrowly: it is a real user turn whose
 * first bytes are exactly the header `Messenger.header()` writes.  This keeps a
 * quoted/header-like line in an ordinary DM from disappearing. */
const ROOM_HEADER = /^\[[^·\]\n]+ · 단톡방 '([^'\]\n]+)' · \d{2}-\d{2} \d{2}:\d{2}\]\n/;

/** Our header lines (messenger.ts header()), without the C2 mark. */
const OUR_HEADERS = [BOSS_HEADER, PEER_HEADER, SYSTEM_HEADER, ROOM_HEADER];
/** C2: one of our header lines with the machine mark ` ⟨m:<id>⟩` (messenger.ts MESSAGE_ID) at its
 *  end: the text's first line, or a line right after a blank line (the start of each `.md` file the
 *  start hook joins into one turn, Messenger.deliverInbox). MSG-ACTIONS: a reply's header has
 *  ` ⟨re:<id>⟩` right after that mark (core/src/cld/reply.ts REPLY_ID), and its body's first line
 *  is the quote (`> <sender>: <quote>`, quoteLine); both are part of the header here. */
const MARKED =
  /(^|\n\n)(\[[^\n]*\]) ⟨m:([a-z2-7]{8})⟩(?: ⟨re:([A-Za-z0-9._:-]{1,64})⟩(?:\n> ([^\n]*))?)?(?=\n)/g;
/** The boss's name in a reply's quote line (messenger.ts BOSS_NAME): absent on the wire. */
const BOSS_NAME = '사장';

/**
 * C2: a user text with the mark removed from each of OUR header lines that
 * starts it or a joined inbox file, and the id of the last such message (the
 * turn's replies answer it: it is the newest the agent read). Anything else (no
 * mark, a mark inside a header line or in a body line, a header that is not
 * ours) stays as written and binds nothing: those pair by their header text as before.
 * MSG-ACTIONS: the reply reference and its quote line go too, and that message's
 * `replyTo`; a `⟨re:` or a `> …` line anywhere else is the sender's own text.
 */
export function unmark(t: string): { text: string; messageId?: string; replyTo?: ChatReply } {
  let messageId: string | undefined;
  let replyTo: ChatReply | undefined;
  const text = t.replace(
    MARKED,
    (all: string, lead: string, head: string, id: string, re?: string, quote?: string) => {
      if (!OUR_HEADERS.some((h) => h.test(`${head}\n`))) return all;
      messageId = id;
      replyTo = undefined;
      if (re) {
        const q = parseQuote(quote ?? '');
        replyTo = { id: re, ...(q.sender && q.sender !== BOSS_NAME && { sender: q.sender }), text: q.text };
      }
      return `${lead}${head}`;
    },
  );
  return messageId ? { text, messageId, ...(replyTo && { replyTo }) } : { text: t };
}

/** The message id a user turn's text (userTurnText) binds its replies to, if any. */
export const turnMessageId = (prompt: string): string | undefined =>
  unmark(prompt.replace(PASTED, '$1').trim()).messageId;

/**
 * C3: the channel of a user turn's prompt (userTurnText): the name of the room whose post it
 * delivers, else null (a DM). THE one predicate: the DM view drops a room turn with it
 * (T-0119), the contact says which room its lead's turn belongs to, and the push of a turn
 * end goes to the room instead of the lead (currentTurn). Not a second guess anywhere else.
 */
export const roomOfPrompt = (prompt: string): string | null =>
  ROOM_HEADER.exec(unmark(prompt).text)?.[1] ?? null;

/** A user turn's prompt (userTurnText) starts a room turn (one that stays out of the DM). */
const isRoomPrompt = (prompt: string): boolean => roomOfPrompt(prompt) !== null;

const TASK_NOTICE_DROP =
  /<(?:task-id|tool-use-id|output-file|status|note|usage)\b[^>]*>[\s\S]*?<\/(?:task-id|tool-use-id|output-file|status|note|usage)\s*>/gi;
/** Only the notice's own wrapper tags: a `<string>` or `<Messenger />` in a result is the agent's text. */
const TASK_NOTICE_TAG =
  /<\/?(?:task-notification|task-id|tool-use-id|output-file|status|summary|result|note|usage)\b[^>]*>/gi;

/** A background task's completion notice as Markdown (the bubble renders it): the summary in
 *  bold, the status when it is not a plain completion, then the agent's result as it wrote it. */
function taskNoticeText(raw: string): string {
  const field = (name: 'summary' | 'result' | 'status'): string | undefined => {
    const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}\\s*>`, 'i').exec(raw);
    return match ? match[1].trim() : undefined;
  };
  const summary = field('summary');
  if (summary) {
    const status = field('status');
    const head = `**${summary}**${status && status !== 'completed' ? ` (${status})` : ''}`;
    const result = field('result');
    return result ? `${head}\n\n${result}` : head;
  }
  return raw.replace(TASK_NOTICE_DROP, '').replace(TASK_NOTICE_TAG, '').trim();
}

/** Who wrote a user-side text (by its FIRST line only, so a header-like line mid-text counts for nothing)
 *  and the text without its header line. Absent `from` = the boss. */
function sender(
  raw: string,
  taskNotification = false,
): Pick<ChatItem, 'from' | 'fromName' | 'replyTo' | 'execution'> & { text: string } {
  const { text: t, replyTo } = unmark(raw);
  if (replyTo) return { ...sender(t, taskNotification), replyTo };
  if (taskNotification || TASK_NOTIFICATION.test(t)) {
    const tool = /<tool-use-id\b[^>]*>\s*([\w-]{1,100})\s*<\/tool-use-id\s*>/i.exec(t)?.[1];
    return {
      text: taskNoticeText(t),
      from: 'peer',
      fromName: TASK_NOTICE_NAME,
      ...(tool && { execution: `claude:${tool}` }),
    };
  }
  if (BOSS_HEADER.test(t)) return { text: t.replace(BOSS_HEADER, '').trim() };
  const peer = PEER_HEADER.exec(t);
  if (peer) {
    return {
      text: t.slice(peer[0].length).trim(),
      from: 'peer',
      fromName: (peer[1] ?? peer[2]).trim(),
    };
  }
  if (SYSTEM_HEADER.test(t)) return { text: t.replace(SYSTEM_HEADER, '').trim(), from: 'system' };
  return SYSTEM_TAG.test(t) ? { text: t, from: 'system' } : { text: t };
}

/** The bracketed-paste wrapper around a message the boss sent: the inner text is the message.
 *  Real transcripts close it with the id too, `</pasted_content id="…">`, and put a newline
 *  inside each tag (10-22 04:5x), so both are optional here. */
const PASTED = /<pasted_content\b[^>]*>\n?([\s\S]*?)\n?<\/pasted_content\b[^>]*>/g;

type Block = {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  input?: unknown;
  id?: unknown;
  content?: unknown;
  thinking?: unknown;
};
type Rec = {
  type?: unknown;
  parentToolUseID?: unknown;
  data?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  message?: unknown;
  attachment?: unknown;
  uuid?: unknown;
  timestamp?: unknown;
  thinkingDisplay?: unknown;
  origin?: unknown;
};

const isTaskNotificationOrigin = (origin: unknown): boolean =>
  !!origin &&
  typeof origin === 'object' &&
  (origin as { kind?: unknown }).kind === 'task-notification';

/** The user text that starts a Claude turn, if this line starts one.  Tool
 * results are user records too, but continue the assistant's existing turn. */
export function userTurnText(line: string): string | null {
  let r: Rec;
  try {
    r = JSON.parse(line) as Rec;
  } catch {
    return null;
  }
  if (!r || typeof r !== 'object' || r.isSidechain === true || r.isMeta === true) return null;
  const content = (r.message as { content?: unknown } | undefined)?.content;
  if (r.type === 'user') {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return null;
    const text = (content as Block[]).filter(
      (b) => b?.type === 'text' && typeof b.text === 'string',
    );
    return text.length ? text.map((b) => b.text as string).join('\n') : null;
  }
  if (r.type !== 'attachment') return null;
  const attachment = r.attachment as
    { type?: unknown; humanTurn?: unknown; prompt?: unknown } | undefined;
  return attachment?.type === 'queued_command' &&
    attachment.humanTurn === true &&
    typeof attachment.prompt === 'string'
    ? attachment.prompt
    : null;
}

/** Whether a record begins the room turn that must stay out of a member's DM. */
export const isRoomPromptLine = (line: string): boolean => {
  const text = userTurnText(line);
  return text !== null && isRoomPrompt(text);
};

/** C3: the room a turn belongs to. `id` and `post` (the room post's id) are known when the
 *  messenger typed the turn (TurnLedger); a turn classified from its header alone has the name. */
export interface RoomRef {
  name: string;
  id?: string;
  post?: string;
}

/** C3: a member's text reply read in a room turn: the room list's unread counts it (office.ts). */
export interface RoomReply {
  room: RoomRef;
  /** The turn's delivery id (its header's mark), when it has one. */
  deliveryId?: string;
  item: ChatItem;
}

export interface RoomTurnOptions {
  /** The room of the delivery the messenger typed under this id (null: it typed a DM); undefined:
   *  not one it typed (an old record, a restart): the header decides (roomOfPrompt). */
  classify?: (deliveryId: string | undefined) => RoomRef | null | undefined;
  /** Called for each user turn read, with its delivery id (the TurnLedger marks it seen). */
  onTurn?: (deliveryId: string | undefined) => void;
  /** Called for each text reply of a room turn (the DM view does not show it). */
  onReply?: (reply: RoomReply) => void;
}

/** Stateful room-turn filter for a forward transcript reader. It also binds
 *  (C2): a user turn whose header carries a mark gives its own item and every
 *  item after it, up to the next user turn, that `messageId`. */
export class RoomTurnFilter {
  /** C3: the room the newest user turn read belongs to (null: a DM turn, or none yet). */
  turn: RoomRef | null = null;
  private bound: string | undefined;

  constructor(private readonly options: RoomTurnOptions = {}) {}

  /** The room's name (see `turn`). */
  get room(): string | null {
    return this.turn?.name ?? null;
  }

  reset(): void {
    this.turn = null;
    this.bound = undefined;
  }

  items(line: string, n = 0, opts: LineOptions = {}): ChatItem[] {
    const prompt = userTurnText(line);
    if (prompt !== null) {
      const name = roomOfPrompt(prompt);
      this.bound = turnMessageId(prompt);
      // What the messenger typed is the record; the header alone only for what it did not type.
      const typed = this.options.classify?.(this.bound);
      this.turn = typed !== undefined ? typed : name === null ? null : { name };
      this.options.onTurn?.(this.bound);
    }
    if (this.turn !== null) {
      if (this.options.onReply && line.includes('"type":"assistant"'))
        for (const item of lineItems(line, n, opts))
          if (item.kind === 'assistant')
            this.options.onReply({
              room: this.turn,
              ...(this.bound && { deliveryId: this.bound }),
              item,
            });
      return [];
    }
    const items = lineItems(line, n, opts);
    const messageId = this.bound;
    return messageId ? items.map((item) => ({ ...item, messageId })) : items;
  }
}

/** The newest turn of a transcript, for the push of its end (see currentTurn). */
export interface CurrentTurn {
  /** C3: the room it belongs to (null: a one-to-one turn). */
  room: string | null;
  /** U-49: the text of its last assistant message, as the messenger would show it (null: none). */
  text: string | null;
}

/**
 * C3 + U-49: the newest turn in `file`: the room whose turn it is (null: a DM turn, none, or an
 * unreadable file), and the text of its last assistant message (null: it wrote none). The
 * fallback for a turn the messenger did not type (TurnLedger has no record of it) and the
 * source of the message a turn end is pushed with: asynchronous, and only asked when a push will
 * go out. Reads backwards until it meets the turn's user record: a long turn (big tool results)
 * can be larger than one window, so the window grows up to CHAT_SCAN_MAX_BYTES. The text is read
 * with lineItems, so it is exactly what the messenger shows: sidechain, tool lines and results
 * never count.
 */
export async function currentTurn(file: string | null): Promise<CurrentTurn> {
  const none: CurrentTurn = { room: null, text: null };
  if (!file) return none;
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, 'r');
  } catch {
    return none;
  }
  try {
    const size = (await handle.stat()).size;
    for (let window = CHAT_TAIL_BYTES; ; window *= 4) {
      const start = Math.max(0, size - window);
      const buf = Buffer.alloc(size - start);
      const { bytesRead } = await handle.read(buf, 0, buf.length, start);
      const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n');
      if (start > 0) lines.shift(); // torn at its head
      let text: string | null = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (text === null && line.includes('"type":"assistant"')) {
          const said = lineItems(line)
            .filter((item) => item.kind === 'assistant' && item.text.trim() !== '')
            .at(-1);
          if (said) text = said.text;
        }
        if (!line.includes('"type":"user"') && !line.includes('queued_command')) continue;
        if (line.length > BIG_RESULT_BYTES && line.includes('"type":"tool_result"')) continue;
        const prompt = userTurnText(line);
        if (prompt !== null) return { room: roomOfPrompt(prompt), text };
      }
      if (start === 0 || window >= CHAT_SCAN_MAX_BYTES) return { room: null, text };
    }
  } catch {
    return none;
  } finally {
    await handle.close();
  }
}

/** What a reader wants beyond the messenger's view (T-0056's work view of a temp). */
export interface LineOptions {
  /** A temp's own transcript is sidechain top to bottom: keep those records. */
  sidechain?: boolean;
  /** Tool results, trimmed, as `result` items. */
  results?: boolean;
  /**
   * The messenger's reader of the lead's sent files (T-0105): the attachment
   * for one source path. Given, a `SendUserFile` call and the `[첨부] <path>`
   * lines of assistant text become attachments of an assistant item; absent,
   * the call stays a tool line and the text stays as written.
   */
  outbox?: (source: string) => ChatAttachment;
  /** MSG-ALIGN: the employee a sub-agent run was bound to (the roster keeps every run's), stamped on its
   *  task notice so the name and face outlive the employee's reuse and a reload. */
  employeeOf?: (execution: string) => ChatEmployee | undefined;
}

/** A tool result's text in the work view: trimmed, it is a hint of what came back. */
export const RESULT_MAX = 300;

/** The text of a tool_result block's content (a string, or text blocks). */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Block[])
    .map((b) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('\n');
}

/** The agent's own short label for a tool call, when the transcript carries one. */
export function toolDescription(input: unknown): string | undefined {
  const description = (input as { description?: unknown } | undefined)?.description;
  if (typeof description !== 'string') return undefined;
  const trimmed = description.trim();
  return trimmed ? trimmed.slice(0, TOOL_DESC_MAX) : undefined;
}

/** A `SendUserFile` call's files (the first SENT_MAX) and caption; null when it names no file. */
function sentFiles(input: unknown): { files: string[]; caption: string } | null {
  const { files, caption } = (input ?? {}) as { files?: unknown; caption?: unknown };
  const list = Array.isArray(files)
    ? files.filter((f): f is string => typeof f === 'string' && f !== '').slice(0, SENT_MAX)
    : [];
  if (!list.length) return null;
  const text = typeof caption === 'string' ? caption.trim() : '';
  return { files: list, caption: text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}…` : text };
}

/** The chat items of one transcript line (none for a torn, skipped or non-JSON line).
 *  `n` names items of records without a uuid (fixtures). */
export function lineItems(line: string, n = 0, opts: LineOptions = {}): ChatItem[] {
  // Cheap pre-filter, before JSON.parse: only these records can make an item.
  if (
    !line.includes('"type":"user"') &&
    !line.includes('"type":"assistant"') &&
    !line.includes('queued_command')
  ) {
    return [];
  }
  if (!opts.results && line.length > BIG_RESULT_BYTES && line.includes('"type":"tool_result"')) {
    return [];
  }
  let r: Rec;
  try {
    r = JSON.parse(line) as Rec;
  } catch {
    return [];
  }
  return recordItems(r, n, opts);
}

function recordItems(r: Rec, n: number, opts: LineOptions): ChatItem[] {
  if (!r || typeof r !== 'object' || (r.isSidechain === true && !opts.sidechain)) return [];
  if (r.isMeta === true) return [];
  const at = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) || 0 : 0;
  const base = `${at}-${typeof r.uuid === 'string' ? r.uuid.slice(0, 8) : `n${n}`}`;
  const items: ChatItem[] = [];
  const add = (item: Omit<ChatItem, 'id' | 'at'>) =>
    items.push({ ...item, id: `${base}-${items.length}`, at });
  const text = (kind: 'user' | 'assistant', value: unknown, taskNotification = false) => {
    if (typeof value !== 'string') return;
    let t = value.trim();
    if (!t || WRAPPER.test(t)) return;
    let who: Pick<ChatItem, 'from' | 'fromName' | 'replyTo' | 'execution' | 'employee'> = {};
    if (kind === 'user') {
      ({ text: t, ...who } = sender(t.replace(PASTED, '$1').trim(), taskNotification));
      const employee = who.execution ? opts.employeeOf?.(who.execution) : undefined;
      if (employee) who = { ...who, employee };
    }
    let files: ChatAttachment[] = [];
    if (kind === 'assistant' && opts.outbox) {
      const sent = sentLines(t);
      t = sent.text;
      files = sent.paths.slice(0, SENT_MAX).map(opts.outbox);
    }
    const max = kind === 'user' ? USER_TEXT_MAX : TEXT_MAX;
    if (t || files.length)
      add({
        kind,
        text: t.length > max ? `${t.slice(0, max)}…` : t,
        ...who,
        ...(files.length && { attachments: files }),
      });
  };
  const content = (r.message as { content?: unknown } | undefined)?.content;
  const blocks = Array.isArray(content) ? (content as Block[]) : [];
  const taskNotification = isTaskNotificationOrigin(r.origin);
  if (r.type === 'user') {
    if (typeof content === 'string') text('user', content, taskNotification);
    for (const b of blocks) {
      if (b?.type === 'text') text('user', b.text, taskNotification);
      else if (opts.results && b?.type === 'tool_result') {
        const t = resultText(b.content).trim();
        if (t)
          add({ kind: 'result', text: t.length > RESULT_MAX ? `${t.slice(0, RESULT_MAX)}…` : t });
      }
    }
  } else if (r.type === 'attachment') {
    const a = r.attachment as { type?: unknown; humanTurn?: unknown; prompt?: unknown } | undefined;
    if (a?.type === 'queued_command' && a.humanTurn === true) text('user', a.prompt);
  } else if (r.type === 'assistant') {
    const updates = r.thinkingDisplay === 'updates';
    for (const b of blocks) {
      if (b?.type === 'text') text('assistant', b.text);
      else if (updates && b?.type === 'thinking') text('assistant', b.thinking);
      else if (b?.type === 'tool_use' && typeof b.name === 'string') {
        const sent = opts.outbox && b.name === 'SendUserFile' ? sentFiles(b.input) : null;
        if (sent && opts.outbox) {
          add({ kind: 'assistant', text: sent.caption, attachments: sent.files.map(opts.outbox) });
          continue;
        }
        const desc = toolDescription(b.input);
        add({
          kind: 'tool',
          toolName: b.name,
          text: formatToolStatus(b.name, b.input),
          ...(desc ? { desc } : {}),
        });
      }
    }
  }
  return items;
}

/**
 * An inline sub-agent's items out of its lead's transcript (T-0056): the
 * spawn's own prompt (the `tool_use` with `spawnId`) and the sidechain
 * records the lead logged for it, `progress` records of type `agent_progress`
 * whose parentToolUseID is the spawn. Newer harnesses log none of the latter
 * (the sub-agent has a transcript file of its own: a sidecar), which is the
 * sidecar reader's case.
 */
export function spawnLineItems(line: string, spawnId: string, n = 0): ChatItem[] {
  if (!line.includes(spawnId)) return []; // both the spawn and its progress records name it
  let r: Rec;
  try {
    r = JSON.parse(line) as Rec;
  } catch {
    return [];
  }
  if (!r || typeof r !== 'object') return [];
  const opts = { sidechain: true, results: true };
  if (r.type === 'progress' && r.parentToolUseID === spawnId) {
    const data = r.data as { type?: unknown; message?: Rec } | undefined;
    if (data?.type !== 'agent_progress' || !data.message) return [];
    const m = data.message;
    return recordItems(
      { ...m, timestamp: m.timestamp ?? r.timestamp, uuid: m.uuid ?? r.uuid },
      n,
      opts,
    );
  }
  if (r.type !== 'assistant') return [];
  const content = (r.message as { content?: unknown } | undefined)?.content;
  const spawn = (Array.isArray(content) ? (content as Block[]) : []).find(
    (b) => b?.type === 'tool_use' && b.id === spawnId,
  );
  const prompt = (spawn?.input as { prompt?: unknown } | undefined)?.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) return [];
  const at = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) || 0 : 0;
  const text = prompt.trim();
  return [
    {
      kind: 'user',
      text: text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}…` : text,
      id: `${at}-${spawnId.slice(-8)}-prompt`,
      at,
    },
  ];
}

/** Chat items from whole transcript lines, oldest first, the last `max`. */
export function chatItems(jsonl: string, max = CHAT_MAX_ITEMS): ChatItem[] {
  const roomTurns = new RoomTurnFilter();
  return jsonl
    .split('\n')
    .flatMap((l, i) => roomTurns.items(l, i))
    .slice(-max);
}

const NL = 0x0a;

/** One transcript, followed by its appended bytes. */
export class TranscriptTail {
  /** The conversation so far: the last CHAT_MAX_ITEMS items. */
  items: ChatItem[] = [];
  private file: string | null | undefined = undefined;
  private ino = -1;
  private offset = 0;
  /** Bytes after the last newline: a line still being written. */
  private partial: Buffer = Buffer.alloc(0);
  private lines = 0;

  constructor(
    private readonly max = CHAT_MAX_ITEMS,
    /** One line's items: the messenger's view unless a reader asks for another (T-0056). */
    private readonly parse: ((line: string, n: number) => ChatItem[]) & { reset?: () => void } = (
      l,
      n,
    ) => lineItems(l, n),
  ) {}

  /**
   * Catch up with `file` (null: none yet). Null when nothing changed; else
   * `reset` (the items were replaced: a new or truncated file, or a jump too
   * big to read) and the items added.
   */
  poll(file: string | null): { reset: boolean; added: ChatItem[] } | null {
    let st: fs.Stats | null = null;
    try {
      if (file) st = fs.statSync(file);
    } catch {
      /* not written yet */
    }
    const same = file === this.file && st !== null && st.ino === this.ino;
    if (same && st!.size === this.offset) return null;
    if (!same && !st) {
      if (file === this.file) return null; // still missing
      this.restart(file, -1);
      return { reset: true, added: [] };
    }
    const size = st!.size;
    if (!same || size < this.offset || size - this.offset > CHAT_TAIL_BYTES) {
      this.restart(file, st!.ino);
      this.items = this.loadBack(file!, size);
      return { reset: true, added: this.items };
    }
    const chunk = this.read(file!, this.offset, size);
    this.offset += chunk.length;
    const added = this.take(Buffer.concat([this.partial, chunk]));
    if (added.length) this.items = [...this.items, ...added].slice(-this.max);
    return added.length ? { reset: false, added } : null;
  }

  private restart(file: string | null, ino: number): void {
    this.file = file;
    this.ino = ino;
    this.offset = 0;
    this.partial = Buffer.alloc(0);
    this.items = [];
    this.parse.reset?.();
  }

  /** Items of the complete lines in `buf`; the rest waits in `partial`. A
   *  newline byte never sits inside a UTF-8 sequence, so splitting on it is safe. */
  private take(buf: Buffer): ChatItem[] {
    const end = buf.lastIndexOf(NL);
    this.partial = Buffer.from(buf.subarray(end + 1));
    if (end < 0) return [];
    return buf
      .subarray(0, end)
      .toString('utf8')
      .split('\n')
      .flatMap((l) => this.parse(l, ++this.lines));
  }

  /**
   * The last `max` items ending at `size`, read backwards in CHAT_TAIL_BYTES
   * chunks until there are enough or CHAT_SCAN_MAX_BYTES is spent. Holds one
   * chunk plus the head fragment of the line that crosses into it. Sets
   * `offset` and `partial` as a forward read would have.
   */
  private loadBack(file: string, size: number): ChatItem[] {
    const start = Math.max(0, size - CHAT_SCAN_MAX_BYTES);
    let buf = this.read(file, start, size);
    const last = buf.lastIndexOf(NL);
    this.partial = Buffer.from(buf.subarray(last + 1)); // a line still being written
    this.offset = size;
    buf = buf.subarray(0, last + 1);
    // The first record can start before the scan window.  Drop only that torn
    // record, then parse oldest-first: room-turn filtering is stateful.
    if (start > 0) {
      const first = buf.indexOf(NL);
      buf = first < 0 ? Buffer.alloc(0) : buf.subarray(first + 1);
    }
    // Negative line numbers: ids of records without a uuid stay apart from the forward
    // reader's positive ones and sort below the history pages' n0 (older() compares ids).
    let back = 0;
    return buf
      .toString('utf8')
      .split('\n')
      .flatMap((line) => this.parse(line, --back))
      .slice(-this.max);
  }

  private read(file: string, from: number, to: number): Buffer {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(to - from);
      const n = fs.readSync(fd, buf, 0, buf.length, from);
      return buf.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  }
}
