/** Bounded backward reads of a lead's transcript and its earlier sessions. */
import * as fs from 'fs';
import * as path from 'path';

import { splitAttachmentText } from '../../../core/src/cld/attachmentLines.js';
import { refused } from '../../../core/src/cld/serverText.js';
import type { ChatItem, ChatLibraryFile, ChatSearchHit } from '../../../core/src/messages.js';
import {
  CHAT_LIBRARY_PAGE,
  CHAT_SEARCH_MASK_WINDOW,
  CHAT_SEARCH_MAX_BYTES,
  CHAT_SEARCH_MAX_HITS,
} from '../constants.js';
import { maskText } from './mask.js';
import {
  carriedId,
  CHAT_MAX_ITEMS,
  CHAT_SCAN_MAX_BYTES,
  CHAT_TAIL_BYTES,
  isRoomPromptLine,
  lineItems,
  type LineOptions,
  turnMessageId,
  turnParts,
  userTurnText,
} from './transcriptView.js';

const JUMP_CONTEXT = 10;
const JUMP_MAX_ITEMS = 400;
const SNIPPET_RADIUS = 40;
const MIN_QUERY = 2;
const MAX_QUERY = 100;

/** Byte offsets of records belonging to room turns, and (C2) of records bound
 * to a marked message, with its id.  History and search walk backwards, so
 * pre-classify each file forwards once to retain the exact same turn boundary
 * as the live TranscriptTail (RoomTurnFilter). */
interface TurnOffsets {
  hidden: Set<number>;
  bound: Map<number, string>;
}
function roomTurnOffsets(file: string, from = 0): TurnOffsets {
  const turns: TurnOffsets = { hidden: new Set(), bound: new Map() };
  let hiding = false;
  let bound: string | undefined;
  let carried: string | undefined;
  try {
    forward(file, from, (line, offset) => {
      const prompt = userTurnText(line);
      if (prompt !== null) {
        hiding = isRoomPromptLine(line);
        // TYPIST-STALE: an unmarked turn after a one-to-one header alone is its body (RoomTurnFilter's carried).
        const own = turnMessageId(prompt);
        bound = own ?? carried;
        carried = carriedId(prompt);
      }
      // A joined turn (MSG-SPLIT) stays: lineItems drops its room parts and keeps its DM parts.
      if (hiding && !(prompt !== null && turnParts(prompt).length > 1)) turns.hidden.add(offset);
      else if (bound) turns.bound.set(offset, bound);
    });
  } catch {
    /* unreadable: what was read so far */
  }
  return turns;
}

/** Every line of `file` oldest first with its byte offset, read in CHAT_TAIL_BYTES chunks (MEM-IDLE:
 *  a transcript can be 100 MB; this holds one chunk plus the line crossing it, never the file). */
function forward(file: string, from: number, visit: (line: string, offset: number) => void): void {
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(CHAT_TAIL_BYTES);
    let carry = Buffer.alloc(0); // the start of a line the previous chunk ended inside
    let base = from; // file offset of carry[0]
    let at = from;
    const next = () => {
      const n = fs.readSync(fd, chunk, 0, chunk.length, at);
      at += n;
      return n;
    };
    // From the middle of a file the first piece is the tail of a line: skip to the next one.
    let skipping = from > 0;
    for (let n = next(); n > 0; n = next()) {
      let buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
      let start = 0;
      if (skipping) {
        const nl = buf.indexOf(NL);
        if (nl < 0) {
          carry = Buffer.alloc(0);
          base += buf.length;
          continue;
        }
        skipping = false;
        start = nl + 1;
        base += start;
        buf = buf.subarray(start);
        start = 0;
      }
      for (let nl = buf.indexOf(NL); nl >= 0; nl = buf.indexOf(NL, start)) {
        visit(buf.toString('utf8', start, nl), base + start);
        start = nl + 1;
      }
      carry = Buffer.from(buf.subarray(start));
      base += start;
    }
    if (carry.length) visit(carry.toString('utf8'), base);
  } finally {
    fs.closeSync(fd);
  }
}
const NL = 0x0a;

type Hit = Omit<ChatSearchHit, 'sender'>;
export interface HistoryPage {
  items: ChatItem[];
  done: boolean;
}
export interface SearchPage {
  hits: Hit[];
  truncated: boolean;
  error?: string;
}

/** A record timestamp, including records that do not produce a chat item. */
function recordTime(line: string): number | null {
  try {
    const value = JSON.parse(line) as { timestamp?: unknown };
    const at = typeof value.timestamp === 'string' ? Date.parse(value.timestamp) : NaN;
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/** First/last record times; only the edges are read, never the whole file. */
function edgeTime(file: string, first: boolean): number | null {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      let offset = first ? 0 : size;
      let carry = '';
      while (first ? offset < size : offset > 0) {
        const length = Math.min(CHAT_TAIL_BYTES, first ? size - offset : offset);
        const start = first ? offset : offset - length;
        const buf = Buffer.alloc(length);
        const read = fs.readSync(fd, buf, 0, length, start);
        if (!read) break;
        const text = first
          ? carry + buf.subarray(0, read).toString('utf8')
          : buf.subarray(0, read).toString('utf8') + carry;
        const lines = text.split('\n');
        carry = first ? lines.pop()! : lines.shift()!;
        for (const line of first ? lines : lines.reverse()) {
          const at = recordTime(line);
          if (at !== null) return at;
        }
        offset = first ? offset + read : start;
      }
      return recordTime(carry);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** D3b, K1: the recorded chain, asked before the heuristic below: the old Lead's transcript a
 *  Lead contact's session continues into (lead-history.json), or the conversation a renew
 *  replaced (renew-history.json), up to its byte offset. Set by the office while the engine runs. */
export const leadHistoryHop: {
  hop?: (file: string, start: number) => { file: string; end: number } | null;
} = {};

/** The previous session: the newest other top-level transcript that ended before `ceiling`. */
// ponytail: an unrelated session in the same folder can be taken for the previous one; only for
// conversations no history names (before K1's renew-history.json, or never renewed nor swapped).
function previous(file: string, ceiling: number): string | null {
  let best: { file: string; at: number } | null = null;
  try {
    for (const entry of fs.readdirSync(path.dirname(file), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const candidate = path.join(path.dirname(file), entry.name);
      if (candidate === file) continue;
      const at = edgeTime(candidate, false);
      if (at !== null && at < ceiling && (!best || at > best.at)) best = { file: candidate, at };
    }
  } catch {
    /* A session may disappear during renew. */
  }
  return best?.file ?? null;
}

/** Complete lines newest first (with their byte offsets), from `end` back, under a byte budget shared across sessions. */
async function* backward(
  file: string,
  budget: { left: number },
  from?: number,
): AsyncGenerator<{ line: string; offset: number }> {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return;
  }
  try {
    let end = Math.min(from ?? Infinity, fs.fstatSync(fd).size);
    let carry = Buffer.alloc(0); // the start of a line that began before `end`
    while (end > 0 && budget.left > 0) {
      const length = Math.min(CHAT_TAIL_BYTES, end, budget.left);
      const start = end - length;
      const buf = Buffer.alloc(length);
      const count = fs.readSync(fd, buf, 0, length, start);
      if (!count) break;
      budget.left -= count;
      const joined = Buffer.concat([buf.subarray(0, count), carry]);
      let stop = joined.length;
      for (let nl = joined.lastIndexOf(0x0a, stop - 1); stop > 0 && nl >= 0;) {
        if (stop > nl + 1)
          yield { line: joined.toString('utf8', nl + 1, stop), offset: start + nl + 1 };
        stop = nl;
        nl = stop > 0 ? joined.lastIndexOf(0x0a, stop - 1) : -1;
      }
      carry = Buffer.from(joined.subarray(0, stop));
      end = start;
      // Let a newer search cancel this one before the next disk chunk.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (end === 0 && carry.length) yield { line: carry.toString('utf8'), offset: 0 };
  } finally {
    fs.closeSync(fd);
  }
}

/** Where a page stopped: the next page reads back from `end` in `file` and skips
 *  the `skip` newest items of that first line (already sent). */
export interface HistoryCursor {
  file: string;
  end: number;
  skip: number;
}

/** `guess`: past the recorded history, the folder's newest earlier transcript (previous()); off, only
 *  what lead-history.json and renew-history.json name (an agent's own conversations, BRN K3). */
async function* chain(
  file: string,
  budget: { left: number },
  cancelled: () => boolean,
  from?: HistoryCursor,
  guess = true,
): AsyncGenerator<{
  line: string;
  file: string;
  offset: number;
  session?: string;
  sessionStart?: number;
}> {
  let current: string | null = from?.file ?? file;
  let end = from?.end;
  const visited = new Set<string>();
  while (current && !visited.has(current) && budget.left > 0 && !cancelled()) {
    visited.add(current);
    const start = edgeTime(current, true);
    const earlier = current !== file;
    for await (const { line, offset } of backward(current, budget, end)) {
      if (cancelled()) return;
      yield {
        line,
        file: current,
        offset,
        ...(earlier && { session: path.basename(current, '.jsonl'), sessionStart: start ?? 0 }),
      };
    }
    end = undefined;
    if (budget.left <= 0) return;
    const hop: { file: string; end: number } | null =
      start === null ? null : (leadHistoryHop.hop?.(current, start) ?? null);
    if (hop) end = hop.end;
    current = hop ? hop.file : start === null || !guess ? null : previous(current, start);
  }
}

/** REPLY-FULL: the replied message `id` as a session started at `startedAt` (ms) has it in its
 *  context: 'recent', its text (before that start or before the transcript's last `boundary`, or
 *  in an earlier conversation: gone from the context), or 'missing' (not found). */
export async function repliedState(
  file: string,
  id: string,
  boundary: string,
  startedAt: number,
): Promise<'recent' | 'missing' | { text: string }> {
  const found = await findReplied(file, id, boundary);
  if (!found) return 'missing';
  return found.earlier || found.compacted || found.item.at < startedAt ? { text: found.item.text } : 'recent';
}

/**
 * REPLY-FULL: the message a reply names (`id`: a user item's C2 id, else any item's own id, as the
 * app's replyIdOf), newest first through this conversation and the ones before it (the history
 * budget), or null. `compacted`: a `boundary` record (Claude's compact_boundary) of this
 * conversation lies after it; `earlier`: it is in an earlier conversation's transcript.
 */
export async function findReplied(
  file: string,
  id: string,
  boundary: string,
): Promise<{ item: ChatItem; compacted: boolean; earlier: boolean } | null> {
  const budget = { left: CHAT_SCAN_MAX_BYTES };
  const roomTurns = new Map<string, TurnOffsets>();
  let compacted = false;
  for await (const entry of chain(file, budget, () => false)) {
    if (entry.file === file && entry.line.includes(boundary)) compacted = true;
    let turns = roomTurns.get(entry.file);
    if (!turns) roomTurns.set(entry.file, (turns = roomTurnOffsets(entry.file)));
    if (turns.hidden.has(entry.offset)) continue;
    const bound = turns.bound.get(entry.offset);
    for (const item of lineItems(entry.line))
      if (item.id === id || (item.kind === 'user' && (item.messageId ?? bound) === id))
        return { item, compacted, earlier: entry.file !== file };
  }
  return null;
}

/**
 * BRN K3 get_message: the item `id` names (as findReplied matches it), newest first through this
 * conversation and the ones the recorded history says it continues (never a guessed one: another
 * session in the same folder is not this agent's), with the user or assistant items right before
 * and after it, and the earlier conversation's session id when it is in one. Null: not found.
 */
export async function messageAround(
  file: string,
  id: string,
): Promise<{ item: ChatItem; before?: ChatItem; after?: ChatItem; session?: string } | null> {
  const budget = { left: CHAT_SCAN_MAX_BYTES };
  const roomTurns = new Map<string, TurnOffsets>();
  const talk = (i: ChatItem) => i.kind === 'user' || i.kind === 'assistant';
  let newer: ChatItem | undefined;
  let found: { item: ChatItem; after?: ChatItem; session?: string } | null = null;
  for await (const entry of chain(file, budget, () => false, undefined, false)) {
    let turns = roomTurns.get(entry.file);
    if (!turns) roomTurns.set(entry.file, (turns = roomTurnOffsets(entry.file)));
    if (turns.hidden.has(entry.offset)) continue;
    const bound = turns.bound.get(entry.offset);
    for (const item of lineItems(entry.line).reverse()) {
      if (found) {
        if (talk(item)) return { ...found, before: item };
        continue;
      }
      if (item.id === id || (item.kind === 'user' && (item.messageId ?? bound) === id))
        found = { item: { ...item, ...(bound && !item.messageId && { messageId: bound }) }, ...(newer && { after: newer }), ...(entry.session && { session: entry.session }) };
      else if (talk(item)) newer = item;
    }
  }
  return found;
}

function older(item: ChatItem, before: string): boolean {
  const at = Number(before.slice(0, before.indexOf('-')));
  return item.at < at || (item.at === at && item.id < before);
}

/** One page, or enough older lines to reach `until` plus context. `from` (the
 *  cursor the page ending at `before` returned) resumes where that page stopped,
 *  so a deep page costs its own bytes, not a re-read from the end. Without it,
 *  items are skipped up to and including `before` (file order; ids tie-break
 *  badly because they carry a random uuid). */
export async function chatHistory(
  file: string | null,
  before?: string,
  until?: number,
  from?: HistoryCursor,
  read: LineOptions = {},
): Promise<HistoryPage & { cursor?: HistoryCursor }> {
  if (!file) return { items: [], done: true };
  const first = await readPage(file, before, until, from, false, read);
  // `before` never turned up (its line is gone): fall back to ordering by time and id.
  if (before && !from && !first.passed)
    return (await readPage(file, before, until, from, true, read)).page;
  return first.page;
}

async function readPage(
  file: string,
  before: string | undefined,
  until: number | undefined,
  from: HistoryCursor | undefined,
  byTime: boolean,
  read: LineOptions,
): Promise<{ page: HistoryPage & { cursor?: HistoryCursor }; passed: boolean }> {
  const budget = { left: CHAT_SCAN_MAX_BYTES };
  const items: ChatItem[] = [];
  let context = 0;
  let reached = false;
  let exhausted = true;
  let cursor: HistoryCursor | undefined;
  let skip = from?.skip ?? 0;
  let passed = !before || !!from || byTime;
  const max = until === undefined ? CHAT_MAX_ITEMS : JUMP_MAX_ITEMS;
  const roomTurns = new Map<string, TurnOffsets>();
  for await (const entry of chain(file, budget, () => false, from)) {
    let turns = roomTurns.get(entry.file);
    if (!turns) roomTurns.set(entry.file, (turns = roomTurnOffsets(entry.file)));
    const messageId = turns.bound.get(entry.offset);
    let seen = 0; // items of this line already sent or skipped
    for (const item of (turns.hidden.has(entry.offset) ? [] : lineItems(entry.line, 0, read)).reverse()) {
      if (skip > 0 || !passed || (byTime && before && !older(item, before))) {
        if (skip > 0) skip--;
        else if (!passed && item.id === before) passed = true;
        seen++;
        continue;
      }
      if (items.length >= max || (until !== undefined && reached && context >= JUMP_CONTEXT)) {
        exhausted = false;
        break;
      }
      items.push({
        ...item,
        ...(messageId && !item.messageId && { messageId }),
        ...(entry.session && { session: entry.session, sessionStart: entry.sessionStart }),
      });
      seen++;
      if (until !== undefined) {
        if (reached) context++;
        else if (item.at <= until) reached = true;
      }
    }
    skip = 0;
    // Stopped inside this line: read it again next time, skipping what was sent.
    cursor = {
      file: entry.file,
      end: exhausted ? entry.offset : entry.offset + Buffer.byteLength(entry.line),
      skip: exhausted ? 0 : seen,
    };
    if (!exhausted) break;
  }
  return {
    page: { items: items.reverse(), done: exhausted && budget.left > 0, cursor },
    passed,
  };
}

/** Options of chatSearch. The plain ones serve one open conversation; `bounded` is the messenger-wide
 *  search over every conversation (searchAll.ts): a smaller window, snippets masked like the work view. */
export interface ChatSearchOptions {
  /** Injectable for focused tests. */
  byteBudget?: number;
  cancelled?: () => boolean;
  /** The search ends here, keeping what it found (a time limit); `truncated` says so. */
  stop?: () => boolean;
  maxHits?: number;
  bounded?: boolean;
}

/** The match's line(s), masked like the work view (maskText), and the match again in the masked text:
 *  null when it was inside a secret (or past the line cap), so a secret is neither shown nor confirmed. */
function maskedAround(text: string, needle: string): { text: string; pos: number } | null {
  const lower = text.toLocaleLowerCase();
  const raw = lower.indexOf(needle);
  if (raw < 0) return null;
  let from = 0;
  let to = text.length;
  if (text.length > CHAT_SEARCH_MASK_WINDOW * 2) {
    // A huge message: the lines around the match; a line past the mask's cap is cut there, so its match is gone.
    const low = raw - CHAT_SEARCH_MASK_WINDOW;
    from = low > 0 ? text.lastIndexOf('\n', low) + 1 : 0;
    const after = text.indexOf('\n', raw + CHAT_SEARCH_MASK_WINDOW);
    to = after < 0 ? text.length : after;
  }
  const masked = maskText(text.slice(from, to));
  const pos = masked.toLocaleLowerCase().indexOf(needle);
  return pos < 0 ? null : { text: masked, pos };
}

/** The query as searched (trimmed), or null when it is too short or too long. */
export function searchNeedle(query: string): string | null {
  const needle = query.trim();
  return needle.length < MIN_QUERY || needle.length > MAX_QUERY ? null : needle;
}

/** The short text around the first match of `folded` (the lower-cased words) in `text`, with … where it
 *  was cut; `masked`: the secrets in it are gone first (maskedAround), and null is a match inside one. */
export function matchSnippet(text: string, folded: string, masked: boolean): string | null {
  let pos = text.toLocaleLowerCase().indexOf(folded);
  if (pos < 0) return null;
  if (masked) {
    const found = maskedAround(text, folded);
    if (!found) return null;
    ({ text, pos } = found);
  }
  const from = Math.max(0, pos - SNIPPET_RADIUS);
  const to = Math.min(text.length, pos + folded.length + SNIPPET_RADIUS);
  return `${from ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`;
}

/** Text-only substring search, newest first. */
export async function chatSearch(
  file: string | null,
  query: string,
  opts: ChatSearchOptions = {},
): Promise<SearchPage> {
  const needle = query.trim();
  if (needle.length < MIN_QUERY || needle.length > MAX_QUERY)
    return { hits: [], truncated: false, ...refused('search_query_length') };
  if (!file) return { hits: [], truncated: false };
  const budget = { left: opts.byteBudget ?? CHAT_SEARCH_MAX_BYTES };
  const maxHits = opts.maxHits ?? CHAT_SEARCH_MAX_HITS;
  const folded = needle.toLocaleLowerCase();
  // ponytail: a record whose line does not hold the words as written (JSON escapes a quote, a backslash,
  // a control character) is read without the shortcut; a writer that escapes non-ASCII (\uXXXX) would hide
  // Korean from the bounded search. Claude's transcripts hold it as it is.
  const quick = !!opts.bounded && !/["\\\u0000-\u001f]/.test(needle);
  const hits: Hit[] = [];
  let truncated = false;
  const roomTurns = new Map<string, TurnOffsets>();
  const reach = new Map<string, number>();
  for await (const entry of chain(file, budget, opts.cancelled ?? (() => false), undefined, !opts.bounded)) {
    if (opts.cancelled?.()) return { hits: [], truncated: false };
    if (opts.stop?.()) {
      truncated = true;
      break;
    }
    // Bounded: the part of each file this search can reach (a chunk of margin) is all of it that is classified.
    if (!reach.has(entry.file))
      reach.set(entry.file, Math.max(0, entry.offset - budget.left - CHAT_TAIL_BYTES));
    if (quick && !entry.line.toLocaleLowerCase().includes(folded)) continue;
    let turns = roomTurns.get(entry.file);
    if (!turns)
      roomTurns.set(
        entry.file,
        (turns = roomTurnOffsets(entry.file, opts.bounded ? reach.get(entry.file) : 0)),
      );
    for (const item of (turns.hidden.has(entry.offset) ? [] : lineItems(entry.line)).reverse()) {
      if (item.kind !== 'user' && item.kind !== 'assistant') continue;
      const snippet = matchSnippet(item.text, folded, !!opts.bounded);
      if (snippet === null) continue;
      if (hits.length >= maxHits) {
        truncated = true;
        break;
      }
      hits.push({
        id: item.id,
        at: item.at,
        kind: item.kind,
        snippet,
        ...(entry.session && { session: entry.session, sessionStart: entry.sessionStart }),
      });
    }
    if (truncated) break;
  }
  return { hits, truncated: truncated || budget.left === 0 };
}

export interface FilesPage {
  files: ChatLibraryFile[];
  /** The last message of this page, when older ones may follow. */
  next?: string;
  done: boolean;
}

/** The files one message carries: the boss's `[첨부]` lines, or what the lead sent. */
function filesOf(item: ChatItem): ChatLibraryFile[] {
  const base = { id: item.id, at: item.at };
  if (item.kind === 'user')
    return splitAttachmentText(item.text).attachments.map((file) => ({
      ...base,
      kind: 'user' as const,
      name: file.name,
      path: file.path,
      type: file.type,
      sizeKb: file.sizeKb,
    }));
  if (item.kind !== 'assistant') return [];
  return (item.attachments ?? []).map((file) => ({
    ...base,
    kind: 'assistant' as const,
    name: file.name,
    ...(file.path && { path: file.path }),
    ...(file.type && { type: file.type }),
    ...(file.sizeKb !== undefined && { sizeKb: file.sizeKb }),
    ...(file.unavailable && { unavailable: true }),
  }));
}

/**
 * The library: files exchanged in the conversation, newest first, from the same lines history reads
 * (no new store). A page ends on a message boundary; `before` (the previous page's `next`) resumes after
 * that message, which is found again by walking from the newest (ponytail: a deep page rereads the
 * newer part of the chain, bounded by the scan budget; a cursor like chatHistory's if that hurts).
 */
export async function chatFiles(
  file: string | null,
  before?: string,
  read: LineOptions = {},
): Promise<FilesPage> {
  if (!file) return { files: [], done: true };
  const budget = { left: CHAT_SEARCH_MAX_BYTES };
  const files: ChatLibraryFile[] = [];
  let passed = !before;
  let next: string | undefined;
  let more = false;
  const roomTurns = new Map<string, TurnOffsets>();
  scan: for await (const entry of chain(file, budget, () => false)) {
    let turns = roomTurns.get(entry.file);
    if (!turns) roomTurns.set(entry.file, (turns = roomTurnOffsets(entry.file)));
    for (const item of (turns.hidden.has(entry.offset) ? [] : lineItems(entry.line, 0, read)).reverse()) {
      if (!passed) {
        if (item.id === before) passed = true;
        continue;
      }
      const here = filesOf(item);
      if (!here.length) continue;
      if (files.length >= CHAT_LIBRARY_PAGE) {
        more = true;
        break scan;
      }
      files.push(...here);
      next = item.id;
    }
  }
  // ponytail: a chain longer than the scan budget ends there (no `next`): the library holds the newest 64 MB.
  return { files, ...(more && next && { next }), done: !more };
}
