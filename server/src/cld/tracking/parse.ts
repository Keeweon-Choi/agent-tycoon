/**
 * U-48 phase 1, pure: what the agents' own work lists say, as tracked items.
 * Two source formats are read here (field names only, never copied anywhere):
 *  - Claude Code's task list files, ~/.claude/tasks/<sessionId>/<id>.json, with
 *    `id`, `subject`, `status` (pending | in_progress | completed | deleted) and
 *    `blockedBy`. The description and every other field are never looked at.
 *  - a Codex worktree's CODEX_PROGRESS.md: `- [ ]` / `- [x]` lines and a `## DONE` heading.
 * Status words are the source's claims (reported); the few the tracker works out
 * itself are inferred, what the engine saw is observed (design-doc-tracking §4).
 */
import type { BoardFactSource, TrackedStatus } from '../../../../core/src/messages.js';
import { maskText } from '../mask.js';

/** A title on the board: one line, this long at most (§7/§9). */
export const TITLE_MAX = 200;
/** The source's own status word, kept for the card's detail. */
export const RAW_MAX = 40;
/** Phase 1 links only by an exact MCP Task id (§10 question 7). */
export const TASK_ID_RE = /\bT-\d{1,5}\b/;
/** A list file or checklist above this is not read (unknown format, §9). */
export const FILE_MAX_BYTES = 256 * 1024;

const oneLine = (text: string, max: number): string => {
  const flat = maskText(text.replace(/\s+/g, ' ').trim());
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** A title for the screen: whitespace folded, secrets masked, at most TITLE_MAX characters. */
export const titleOf = (text: string): string => oneLine(text, TITLE_MAX);
export const rawOf = (text: string): string => oneLine(text, RAW_MAX);

export const taskIdOf = (title: string): string | undefined => TASK_ID_RE.exec(title)?.[0];

/** Claude's task status words. `deleted` is hidden. */
const CLAUDE_STATUS: Record<string, TrackedStatus | 'hidden'> = {
  pending: 'todo',
  in_progress: 'doing',
  completed: 'done',
  deleted: 'hidden',
};

/** What a list file's `id` and its name may look like (F2, F3). */
export const LIST_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
export const LIST_FILE_RE = /^[A-Za-z0-9_-]{1,40}\.json$/;

export interface ListEntry {
  id: string;
  title: string;
  status: TrackedStatus | 'hidden';
  raw: string;
  blockedBy: string[];
}

/**
 * One list file's text. 'bad' is not JSON (a half-written file: skipped, read again
 * next time); 'unreadable' is JSON in a shape this build does not know.
 */
export function parseListFile(text: string): ListEntry | 'bad' | 'unreadable' {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return 'bad';
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return 'unreadable';
  const f = json as Record<string, unknown>;
  const id = typeof f.id === 'number' ? String(f.id) : f.id;
  // The id becomes part of a key that goes to the screen: a plain short word, or the file is not ours to show.
  if (typeof id !== 'string' || !LIST_ID_RE.test(id) || typeof f.subject !== 'string' || typeof f.status !== 'string')
    return 'unreadable';
  return {
    id,
    title: titleOf(f.subject),
    // Own keys only: a status word like `constructor` must not find an inherited member.
    status: Object.hasOwn(CLAUDE_STATUS, f.status) ? CLAUDE_STATUS[f.status] : 'unknown',
    raw: rawOf(f.status),
    blockedBy: Array.isArray(f.blockedBy) ? f.blockedBy.map(String) : [],
  };
}

/** A pending or running item waiting on a task that is not completed is blocked (inferred). */
export function markBlocked(entries: ListEntry[]): Map<string, boolean> {
  const done = new Set(entries.filter((e) => e.status === 'done' || e.status === 'hidden').map((e) => e.id));
  const known = new Set(entries.map((e) => e.id));
  return new Map(
    entries.map((e) => [
      e.id,
      (e.status === 'todo' || e.status === 'doing') &&
        e.blockedBy.some((b) => known.has(b) && !done.has(b)),
    ]),
  );
}

export interface ProgressLine {
  mark: string;
  title: string;
}
export interface Progress {
  lines: ProgressLine[];
  /** The `## DONE` heading is there: the run said it finished. */
  hasDone: boolean;
}

const CHECKBOX = /^\s*[-*]\s+\[(.)\]\s+(.*)$/;
const DONE_HEADING = /^##\s+DONE\b/;

export function parseProgress(text: string): Progress | 'unreadable' {
  if (text.includes('\0')) return 'unreadable';
  const lines: ProgressLine[] = [];
  let hasDone = false;
  for (const line of text.split('\n')) {
    const m = CHECKBOX.exec(line);
    if (m) lines.push({ mark: m[1], title: titleOf(m[2]) });
    else if (DONE_HEADING.test(line)) hasDone = true;
  }
  return { lines, hasDone };
}

/** The engine's state word for the Codex run whose worktree holds the checklist. */
export type RunState = string;

export interface ProgressStatus {
  status: TrackedStatus;
  source: BoardFactSource;
  raw: string;
}

/**
 * §4: `[x]` is the agent's claim (reported); the first open box of a run that is
 * still going is `doing` (inferred); the same box when the run ended without a
 * `## DONE`, or waits on a limit, is `blocked` and the engine saw why (observed).
 */
export function progressStatus(
  mark: string,
  firstOpen: boolean,
  hasDone: boolean,
  run: RunState,
): ProgressStatus {
  if (mark === 'x' || mark === 'X') return { status: 'done', source: 'reported', raw: '[x]' };
  if (mark !== ' ') return { status: 'unknown', source: 'reported', raw: rawOf(`[${mark}]`) };
  const open: ProgressStatus = { status: 'todo', source: 'reported', raw: '[ ]' };
  if (!firstOpen || hasDone) return open;
  if (run === 'running') return { status: 'doing', source: 'inferred', raw: '[ ]' };
  if (run === 'limit' || run === 'failed' || run === 'stopped' || run === 'done')
    return { status: 'blocked', source: 'observed', raw: rawOf(run) };
  return open;
}
