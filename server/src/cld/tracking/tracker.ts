/**
 * U-48 phase 1: the tracked-item index. Derived and in memory only; nothing is
 * written anywhere, no lock is taken, and nothing runs unless a caller asks
 * (the office asks only while someone views). One refresh stats the few files it
 * knows and re-reads only those whose mtime or size changed (§6).
 *
 * Budget (§6): at most SESSIONS_MAX sessions, CODEX_MAX Codex worktrees, LIST_FILES_MAX
 * files per list, MORE_AFTER visible children per parent.
 */
import * as fs from 'fs';
import * as path from 'path';

import type { TrackedItem, TrackedMore, TrackedStatus } from '../../../../core/src/messages.js';
import {
  FILE_MAX_BYTES,
  LIST_FILE_RE,
  type ListEntry,
  markBlocked,
  parseListFile,
  parseProgress,
  type Progress,
  progressStatus,
  taskIdOf,
  titleOf,
} from './parse.js';

export const SESSIONS_MAX = 32;
export const CODEX_MAX = 20;
export const LIST_FILES_MAX = 100;
export const MORE_AFTER = 30;
/** §10 question 2: a finished session folds (disappears) this long after its list last changed. */
export const ENDED_FOLD_MS = 24 * 3_600_000;
/** Remembered sessions, so one that ends while the daemon watches can still be shown as ended. */
const SEEN_MAX = 64;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
/** readText's answer for a file over the cap (an unreadable line, not a failure). */
export const TOO_BIG = Symbol('too big');
export const PROGRESS_FILE = 'CODEX_PROGRESS.md';

export interface TrackSession {
  sessionId: string;
  name: string;
  /** Already worked out by the caller (engine assignment, else the project folder holding the cwd). */
  project: string;
  live: boolean;
  /** The provider's own word: working (true), at rest (false), neither (null). */
  busy: boolean | null;
}
export interface TrackCodex {
  id: string;
  project: string;
  /** The engine's state word (running, limit, done, failed, stopped). */
  state: string;
  /** Where Codex works: its worktree, or the folder it was started in. */
  dir: string;
  ended: string | null;
}
export interface TrackInput {
  sessions: TrackSession[];
  codex: TrackCodex[];
  now: number;
}
export interface TrackedProject {
  items: TrackedItem[];
  more: TrackedMore[];
}

type Seen = TrackSession & { liveAt: number };
type Sig = string;
interface Cached<T> {
  sig: Sig;
  value: T;
}

const isOpen = (c: TrackCodex) => c.state === 'running' || c.state === 'limit';
const sigOf = (st: fs.Stats): Sig => `${st.mtimeMs}:${st.size}`;
const iso = (ms: number) => new Date(ms).toISOString();

export class Tracker {
  private readonly lists = new Map<string, Cached<ListEntry | 'unreadable'>>();
  private readonly progress = new Map<string, Cached<Progress | 'unreadable'>>();
  /** Sessions seen so far, with when each was last seen live (0 = never). */
  private readonly seen = new Map<string, Seen>();
  /** Reads of file contents since construction (a test sees "no viewer, no read"). */
  reads = 0;

  constructor(private readonly home: string) {}

  clear(): void {
    this.lists.clear();
    this.progress.clear();
    this.seen.clear();
  }

  /** The tracked items by project. Never throws; what cannot be read is skipped or one "unreadable" line. */
  refresh(input: TrackInput): Map<string, TrackedProject> {
    const out = new Map<string, TrackedProject>();
    const slot = (project: string) => {
      let p = out.get(project);
      if (!p) out.set(project, (p = { items: [], more: [] }));
      return p;
    };
    const touchedLists = new Set<string>();
    const touchedProgress = new Set<string>();
    for (const s of this.sessionsOf(input.sessions, input.now).slice(0, SESSIONS_MAX))
      this.addSession(slot(s.project), s, input.now, touchedLists);
    const codex = [...input.codex]
      .sort(
        (a, b) =>
          Number(isOpen(b)) - Number(isOpen(a)) ||
          (Date.parse(b.ended ?? '') || 0) - (Date.parse(a.ended ?? '') || 0),
      )
      .slice(0, CODEX_MAX);
    for (const c of codex) this.addCodex(slot(c.project), c, touchedProgress);
    // Drop what this round did not touch: the caches never outgrow what is shown.
    for (const k of this.lists.keys()) if (!touchedLists.has(k)) this.lists.delete(k);
    for (const k of this.progress.keys()) if (!touchedProgress.has(k)) this.progress.delete(k);
    for (const [project, p] of out) if (p.items.length === 0) out.delete(project);
    return out;
  }

  /** The given sessions, then the remembered ones that are gone (ended); live and busy first. */
  private sessionsOf(given: TrackSession[], now: number): Seen[] {
    const ids = new Set(given.map((s) => s.sessionId));
    const current: Seen[] = given.map((s) => ({
      ...s,
      liveAt: s.live ? now : (this.seen.get(s.sessionId)?.liveAt ?? 0),
    }));
    for (const s of current) {
      this.seen.delete(s.sessionId);
      this.seen.set(s.sessionId, s);
    }
    while (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.keys().next().value as string);
    const gone = [...this.seen.values()]
      .filter((s) => !ids.has(s.sessionId))
      .map((s) => ({ ...s, live: false, busy: null }));
    return [...current, ...gone]
      .filter((s) => SESSION_ID_RE.test(s.sessionId))
      .sort((a, b) => Number(b.live) - Number(a.live) || Number(b.busy === true) - Number(a.busy === true));
  }

  private addSession(into: TrackedProject, s: Seen, now: number, touched: Set<string>): void {
    const dir = path.join(this.home, '.claude', 'tasks', s.sessionId);
    const { entries, unreadable, newest } = this.readList(dir, touched);
    // An ended session stays ENDED_FOLD_MS after its list last changed or it was last seen running;
    // one nothing is known about (never seen live here, no list) has nothing to show.
    const lastKnown = Math.max(newest ?? 0, s.liveAt);
    if (!s.live && (lastKnown === 0 || now - lastKnown > ENDED_FOLD_MS)) return;
    const key = `session:${s.sessionId}`;
    const status: TrackedStatus = !s.live ? 'unknown' : s.busy === true ? 'doing' : s.busy === false ? 'review' : 'unknown';
    into.items.push({
      key,
      kind: 'session',
      title: titleOf(s.name),
      status,
      source: 'observed',
      ref: s.sessionId.slice(0, 8),
      // A running session's time is its list's (it changes only when the list does); an ended one's is when it was last seen running.
      changedAt: s.live ? (newest === null ? null : iso(newest)) : iso(lastKnown),
      ...(!s.live && { ended: true }),
    });
    const blocked = markBlocked(entries.map((e) => e.entry));
    const rows: TrackedItem[] = entries
      .filter((e) => e.entry.status !== 'hidden')
      .map((e): TrackedItem => {
        const isBlocked = blocked.get(e.entry.id) === true;
        const title = e.entry.title;
        const taskId = taskIdOf(title);
        return {
          key: `claude-task:${s.sessionId}/${e.entry.id}`,
          kind: 'agentList',
          parentKey: key,
          title,
          status: isBlocked ? 'blocked' : (e.entry.status as TrackedStatus),
          rawStatus: isBlocked ? 'blockedBy' : e.entry.raw,
          source: isBlocked ? 'inferred' : 'reported',
          reporter: titleOf(s.name),
          ref: `~/.claude/tasks/${s.sessionId.slice(0, 8)}/${e.file}`,
          changedAt: iso(e.mtime),
          ...(taskId && { taskId }),
        };
      });
    // Open ones first (by id), then the most recently finished.
    const num = (k: string) => Number(k.slice(k.lastIndexOf('/') + 1)) || 0;
    rows.sort(
      (a, b) =>
        Number(a.status === 'done') - Number(b.status === 'done') ||
        (a.status === 'done' ? Date.parse(b.changedAt ?? '') - Date.parse(a.changedAt ?? '') : num(a.key) - num(b.key)),
    );
    const shown = rows.slice(0, MORE_AFTER);
    into.items.push(...shown);
    if (unreadable)
      into.items.push({
        key: `claude-task:${s.sessionId}/unreadable`,
        kind: 'agentList',
        parentKey: key,
        title: '',
        status: 'unknown',
        source: 'observed',
        unreadable: true,
      });
    if (rows.length > shown.length) into.more.push({ parentKey: key, count: rows.length - shown.length });
  }

  /** The session's list files, each re-read only when its mtime or size changed. */
  private readList(dir: string, touched: Set<string>) {
    const entries: Array<{ entry: ListEntry; file: string; mtime: number }> = [];
    let unreadable = false;
    let newest: number | null = null;
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => LIST_FILE_RE.test(n));
    } catch {
      return { entries, unreadable, newest };
    }
    for (const file of names.sort().slice(0, LIST_FILES_MAX)) {
      const full = path.join(dir, file);
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue; // gone between the listing and the stat
      }
      // A FIFO, a device or a link to one is not a list: skipped silently, never opened.
      if (!st.isFile()) continue;
      touched.add(full);
      newest = Math.max(newest ?? 0, st.mtimeMs);
      let c = this.lists.get(full);
      if (c?.sig !== sigOf(st)) {
        const text = this.readText(full, false);
        if (text === null) continue; // not readable now: try again next time
        const parsed = text === TOO_BIG ? 'unreadable' : parseListFile(text);
        if (parsed === 'bad') continue; // half written: skipped, read again next time
        c = { sig: sigOf(st), value: parsed };
        this.lists.set(full, c);
      }
      if (c.value === 'unreadable') unreadable = true;
      else entries.push({ entry: c.value, file, mtime: st.mtimeMs });
    }
    return { entries, unreadable, newest };
  }

  private addCodex(into: TrackedProject, c: TrackCodex, touched: Set<string>): void {
    const file = path.join(c.dir, PROGRESS_FILE);
    let st: fs.Stats;
    try {
      // lstat: a repository may ship the file as a link to anything; a link is not read.
      st = fs.lstatSync(file);
    } catch {
      return;
    }
    if (!st.isFile()) return;
    touched.add(file);
    let cached = this.progress.get(file);
    if (cached?.sig !== sigOf(st)) {
      const text = this.readText(file, true);
      if (text === null) return;
      cached = { sig: sigOf(st), value: text === TOO_BIG ? 'unreadable' : parseProgress(text) };
      this.progress.set(file, cached);
    }
    const parentKey = `codex:${c.id}`;
    if (cached.value === 'unreadable') {
      into.items.push({
        key: `codex-progress:${c.id}#unreadable`,
        kind: 'codexProgress',
        parentKey,
        title: '',
        status: 'unknown',
        source: 'observed',
        unreadable: true,
      });
      return;
    }
    const { lines, hasDone } = cached.value;
    let firstOpen = true;
    const rows = lines.map((l, n): TrackedItem => {
      const s = progressStatus(l.mark, l.mark === ' ' && firstOpen, hasDone, c.state);
      if (l.mark === ' ') firstOpen = false;
      const taskId = taskIdOf(l.title);
      return {
        key: `codex-progress:${c.id}#${n + 1}`,
        kind: 'codexProgress',
        parentKey,
        title: l.title,
        status: s.status,
        rawStatus: s.raw,
        source: s.source,
        reporter: 'Codex',
        ref: PROGRESS_FILE,
        changedAt: iso(st.mtimeMs),
        ...(taskId && { taskId }),
      };
    });
    into.items.push(...rows.slice(0, MORE_AFTER));
    if (rows.length > MORE_AFTER) into.more.push({ parentKey, count: rows.length - MORE_AFTER });
  }

  private readText(file: string, noFollow: boolean): string | typeof TOO_BIG | null {
    this.reads++;
    return readText(file, noFollow);
  }
}

/**
 * The file's text, TOO_BIG when it holds more than FILE_MAX_BYTES, or null when it cannot be
 * read or is not a regular file. Opened without blocking (a FIFO swapped in after the stat
 * must not hang the daemon) and, for `noFollow`, without following a link; the size is
 * decided on the open descriptor and the read stops one byte past the cap, so a file that
 * grows after the stat is still bounded.
 */
export function readText(file: string, noFollow: boolean): string | typeof TOO_BIG | null {
  const { O_RDONLY, O_NONBLOCK = 0, O_NOFOLLOW = 0 } = fs.constants;
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, O_RDONLY | O_NONBLOCK | (noFollow ? O_NOFOLLOW : 0));
    if (!fs.fstatSync(fd).isFile()) return null;
    const buf = Buffer.allocUnsafe(FILE_MAX_BYTES + 1);
    let n = 0;
    while (n < buf.length) {
      const got = fs.readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
    }
    return n > FILE_MAX_BYTES ? TOO_BIG : buf.toString('utf-8', 0, n);
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
