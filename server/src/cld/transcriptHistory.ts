/** Bounded backward reads of a lead's transcript and its earlier sessions. */
import * as fs from 'fs';
import * as path from 'path';

import { refused } from '../../../core/src/cld/serverText.js';
import type { ChatItem } from '../../../core/src/messages.js';
import { CHAT_SEARCH_MAX_BYTES, CHAT_SEARCH_MAX_HITS } from '../constants.js';
import {
  CHAT_MAX_ITEMS,
  CHAT_SCAN_MAX_BYTES,
  CHAT_TAIL_BYTES,
  isRoomPromptLine,
  lineItems,
  type LineOptions,
  turnMessageId,
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
function roomTurnOffsets(file: string): TurnOffsets {
  const turns: TurnOffsets = { hidden: new Set(), bound: new Map() };
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return turns;
  }
  let offset = 0;
  let hiding = false;
  let bound: string | undefined;
  for (const line of text.split('\n')) {
    const prompt = userTurnText(line);
    if (prompt !== null) {
      hiding = isRoomPromptLine(line);
      bound = turnMessageId(prompt);
    }
    if (hiding) turns.hidden.add(offset);
    else if (bound) turns.bound.set(offset, bound);
    offset += Buffer.byteLength(line) + 1;
  }
  return turns;
}

type Hit = Pick<ChatItem, 'id' | 'at' | 'kind' | 'session' | 'sessionStart'> & { snippet: string };
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

/** D3b: the recorded lead chain (lead-history.json), asked before the heuristic below: the
 *  old Lead's transcript a Lead contact's session continues into, up to its byte offset.
 *  Set by the office while the engine runs. */
export const leadHistoryHop: {
  hop?: (file: string, start: number) => { file: string; end: number } | null;
} = {};

/** The previous session: the newest other top-level transcript that ended before `ceiling`. */
// ponytail: an unrelated session in the same folder can be taken for the previous one;
// a Lead swap's terms are recorded (leadHistoryHop); a renew's are not yet.
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

async function* chain(
  file: string,
  budget: { left: number },
  cancelled: () => boolean,
  from?: HistoryCursor,
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
    current = hop ? hop.file : start === null ? null : previous(current, start);
  }
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
        ...(messageId && { messageId }),
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

/** Text-only substring search, newest first, with an injectable budget for focused tests. */
export async function chatSearch(
  file: string | null,
  query: string,
  opts: { byteBudget?: number; cancelled?: () => boolean } = {},
): Promise<SearchPage> {
  const needle = query.trim();
  if (needle.length < MIN_QUERY || needle.length > MAX_QUERY)
    return { hits: [], truncated: false, ...refused('search_query_length') };
  if (!file) return { hits: [], truncated: false };
  const budget = { left: opts.byteBudget ?? CHAT_SEARCH_MAX_BYTES };
  const hits: Hit[] = [];
  let truncated = false;
  const roomTurns = new Map<string, TurnOffsets>();
  for await (const entry of chain(file, budget, opts.cancelled ?? (() => false))) {
    if (opts.cancelled?.()) return { hits: [], truncated: false };
    let turns = roomTurns.get(entry.file);
    if (!turns) roomTurns.set(entry.file, (turns = roomTurnOffsets(entry.file)));
    for (const item of (turns.hidden.has(entry.offset) ? [] : lineItems(entry.line)).reverse()) {
      if (item.kind !== 'user' && item.kind !== 'assistant') continue;
      const pos = item.text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
      if (pos < 0) continue;
      if (hits.length >= CHAT_SEARCH_MAX_HITS) {
        truncated = true;
        break;
      }
      const from = Math.max(0, pos - SNIPPET_RADIUS);
      const to = Math.min(item.text.length, pos + needle.length + SNIPPET_RADIUS);
      hits.push({
        id: item.id,
        at: item.at,
        kind: item.kind,
        snippet: `${from ? '…' : ''}${item.text.slice(from, to)}${to < item.text.length ? '…' : ''}`,
        ...(entry.session && { session: entry.session, sessionStart: entry.sessionStart }),
      });
    }
    if (truncated) break;
  }
  return { hits, truncated: truncated || budget.left === 0 };
}
