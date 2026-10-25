/**
 * U-48 phase 2a: a project's planning documents as tracked items. Read-only: the
 * documents are found by name (no tree walk), opened without following links and
 * without blocking, never written or locked. Only the conventional names (on unless
 * turned off) and the paths/globs a user turned on are read; the "켤까요?" candidates
 * come from the project's git, only when someone opens the settings.
 *
 * Budget (§6): DOCS_MAX documents per project, FILE_MAX_BYTES per file, ITEMS_MAX
 * entries per file, MORE_AFTER lines sent per document (plus the ones a Task links);
 * a file whose mtime and size did not change is not read again.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type { TrackedItem, TrackedStatus, TrackingDoc, TrackingProjectSettings } from '../../../../core/src/messages.js';
import { NO_FETCH_ENV } from '../engine/git/gitRun.js';
import { type DocEntry, type DocParse, parseDoc, parseTaskmaster } from './docs.js';
import { rawOf, titleOf } from './parse.js';
import { SKIP_DIRS } from './settings.js';
import { MORE_AFTER, readText, TOO_BIG, type TrackedProject } from './tracker.js';

export const DOCS_MAX = 50;
/** Found by name in every project folder unless turned off (case-insensitive). */
export const CONVENTIONAL = [
  'TODO.md',
  'ROADMAP.md',
  'BACKLOG.md',
  'PLAN.md',
  'tasks.md',
  'specs/*/tasks.md',
  '.kiro/specs/*/tasks.md',
  '.taskmaster/tasks/tasks.json',
  'docs/adr/*.md',
  'tasks/*.md',
];
/** A directory this big is read only this far (a glob never walks a huge folder). */
const DIR_ENTRIES_MAX = 2_000;
/** Directory listings one path or glob may take per refresh. */
export const DIR_READS_MAX = 200;
export const CANDIDATES_MAX = 20;
const CANDIDATE_FILES_MAX = 100;
const GIT_OUT_MAX = 256 * 1024;
const GIT_TIMEOUT_MS = 5_000;
/** §3: an item that vanished from a document still on shows this long as gone. */
export const GONE_MS = 24 * 3_600_000;
const GONE_MAX = 100;
/**
 * Reading and parsing stop for this refresh once it has spent this long; the documents left
 * are read on the next one (`pending`), so no refresh passes 50 ms even when a viewer arrives
 * at a project at the limits (50 x 500 entries is a few hundred ms of parsing, cold).
 */
export const READ_BUDGET_MS = 25;

export interface DocProject {
  name: string;
  folder: string;
  settings: TrackingProjectSettings;
}

/**
 * One document as read, kept small: its card, the lines it sends (the file's own text,
 * masked on the way out), how many it leaves out, and the ids it defines (for duplicates
 * and for noticing that a Task now links one of them). The rest of the parse is dropped.
 */
interface Cached {
  sig: string;
  /** What the selection depended on: short ids, the hidden keys and the linked Task ids. */
  view: string;
  card: TrackedItem;
  shown: TrackedItem[];
  left: number;
  ids: string[];
  total: number;
}

const globRe = (seg: string) =>
  new RegExp(`^${seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`, 'i');

/**
 * The files a path or glob names under `folder`, relative to it. Every step is a real
 * directory and the last a regular file (no link anywhere: nothing points out of the
 * project); names match case-insensitively; SKIP_DIRS are never entered.
 */
export function expand(folder: string, pattern: string, dirs = new Map<string, fs.Dirent[]>()): string[] {
  let reads = 0;
  const list = (rel: string) => {
    let d = dirs.get(rel);
    if (!d) {
      // ponytail: a glob that fans out over many folders stops after DIR_READS_MAX listings (what it found so far stands).
      if (++reads > DIR_READS_MAX) return [];
      try {
        d = fs.readdirSync(path.join(folder, rel), { withFileTypes: true }).slice(0, DIR_ENTRIES_MAX);
      } catch {
        d = [];
      }
      dirs.set(rel, d);
    }
    return d;
  };
  const segs = pattern.split('/');
  const out: string[] = [];
  const walk = (rel: string, n: number) => {
    const re = globRe(segs[n]);
    const last = n === segs.length - 1;
    for (const e of list(rel)) {
      if (!re.test(e.name) || SKIP_DIRS.has(e.name)) continue;
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (last ? e.isFile() : e.isDirectory()) {
        if (last) out.push(next);
        else walk(next, n + 1);
      }
    }
  };
  walk('', 0);
  return out.sort();
}

/** The documents found for a project: conventional ones (on unless off), then the ones turned on. */
export function resolveDocs(folder: string, s: TrackingProjectSettings): TrackingDoc[] {
  const dirs = new Map<string, fs.Dirent[]>();
  const found = new Map<string, TrackingDoc>();
  for (const p of CONVENTIONAL)
    for (const rel of expand(folder, p, dirs)) found.set(rel, { path: rel, conventional: true, on: !s.off.includes(rel) });
  for (const p of s.on)
    for (const rel of expand(folder, p, dirs)) if (!found.has(rel)) found.set(rel, { path: rel, conventional: false, on: true });
  return [...found.values()];
}

const rank: TrackedStatus[] = ['doing', 'review', 'blocked', 'todo', 'done', 'cancelled'];
const isOpen = (s: TrackedStatus) => s !== 'done' && s !== 'cancelled';

/** Masked once per item object (the cache keeps the object until its file changes). */
const masked = new WeakMap<TrackedItem, { title: string; raw?: string }>();
function forScreen(i: TrackedItem, duplicate: boolean): TrackedItem {
  let m = masked.get(i);
  if (!m) masked.set(i, (m = { title: titleOf(i.title), ...(i.rawStatus && { raw: rawOf(i.rawStatus) }) }));
  return { ...i, title: m.title, ...(m.raw && { rawStatus: m.raw }), ...(duplicate && { duplicate: true }) };
}

/** A copy of a piece of the file's text, so the cache does not keep the whole file alive through it. */
const own = (s: string) => Buffer.from(s, 'utf-8').toString('utf-8');

/** The view a file's selection depends on: short ids, its hidden keys, the Task ids it defines. */
const viewOf = (p: DocProject, docKey: string, ids: readonly string[], taskIds: ReadonlySet<string>) =>
  `${p.settings.shortIds}|${p.settings.hidden.filter((k) => k.startsWith(docKey)).join(',')}|${ids.filter((i) => taskIds.has(i)).join(',')}`;

function build(
  p: DocProject,
  rel: string,
  value: DocParse | 'unreadable',
  mtime: number,
  taskIds: ReadonlySet<string>,
): Omit<Cached, 'sig' | 'view'> & { keys: Set<string> } {
  const docKey = `doc:${p.name}/${rel}`;
  const changedAt = new Date(mtime).toISOString();
  if (value === 'unreadable')
    return {
      card: { key: docKey, kind: 'doc', title: rel, status: 'unknown', source: 'observed', path: rel, changedAt, unreadable: true },
      shown: [],
      left: 0,
      ids: [],
      total: 0,
      keys: new Set([docKey]),
    };
  const hidden = new Set(p.settings.hidden);
  const entries = value.entries.filter((e) => !hidden.has(`${docKey}#${e.key}`));
  // What goes out: every line a Task links, then open lines before finished ones, up to MORE_AFTER.
  // A heading with lines under it is a group, not a line: it goes along when one of its lines does.
  const parents = new Set(entries.map((e) => e.parent));
  const linked = (e: DocEntry) => !!e.id && taskIds.has(e.id);
  const lines = entries.filter((e) => !parents.has(e.key));
  const rest = lines.filter((e) => !linked(e));
  const open = rest.filter((e) => isOpen(e.status));
  const shown = (open.length >= MORE_AFTER ? open : [...open, ...rest.filter((e) => !isOpen(e.status))]).slice(0, MORE_AFTER);
  const pick = new Set([...lines.filter(linked), ...shown]);
  const groups = new Set([...pick].map((e) => e.parent));
  for (const e of entries) if (parents.has(e.key) && (groups.has(e.key) || linked(e))) pick.add(e);
  const item = (e: DocEntry): TrackedItem => ({
    key: `${docKey}#${e.key}`,
    kind: 'doc',
    parentKey: e.parent ? `${docKey}#${e.parent}` : docKey,
    title: own(e.title),
    status: e.status,
    ...(e.raw && { rawStatus: own(e.raw) }),
    source: e.source,
    path: rel,
    ...(e.line > 0 && { line: e.line }),
    changedAt,
    ...(e.refs.length && { refs: e.refs }),
    ...(e.id && { taskId: e.id }),
  });
  const statuses = new Set(value.entries.filter((e) => e.kind !== 'heading').map((e) => e.status));
  const agg = rank.find((st) => statuses.has(st));
  const card: TrackedItem = {
    key: docKey,
    kind: 'doc',
    title: value.title ? own(value.title) : rel,
    status: value.status?.status ?? agg ?? 'unknown',
    ...(value.status?.raw && { rawStatus: value.status.raw }),
    source: value.status ? 'reported' : agg ? 'inferred' : 'unknown',
    path: rel,
    changedAt,
    ...(value.mentions.length && { refs: value.mentions.slice(0, 20) }),
    ...(value.id && { taskId: value.id }),
  };
  const ids = [...(value.id ? [value.id] : []), ...value.entries.flatMap((e) => (e.id ? [e.id] : []))];
  return {
    card,
    shown: entries.filter((e) => pick.has(e)).map(item),
    left: rest.length - shown.length + value.more,
    ids,
    total: value.entries.length + value.more,
    keys: new Set([docKey, ...value.entries.map((e) => `${docKey}#${e.key}`)]),
  };
}

export class DocTracker {
  /** `<project>\0<file>` -> the document as last read. */
  private readonly files = new Map<string, Cached>();
  /** project -> items that vanished from a document still read (or with their file deleted), and when. */
  private readonly gone = new Map<string, Map<string, { item: TrackedItem; at: number }>>();
  /** Reads of file contents since construction (a test sees "no viewer, no read"). */
  reads = 0;
  /** The last refresh left documents unread (its READ_BUDGET_MS ran out). */
  pending = false;
  private deadline = Infinity;
  /** Reads this refresh: the first always happens, so a slow file still makes progress. */
  private roundReads = 0;

  clear(): void {
    this.files.clear();
    this.gone.clear();
    this.pending = false;
  }

  private goneOf(project: string) {
    let g = this.gone.get(project);
    if (!g) this.gone.set(project, (g = new Map()));
    return g;
  }

  /** §3: what a re-read (or a deleted file) dropped shows as gone for a day. */
  private vanished(project: string, before: TrackedItem[], after: ReadonlySet<string>, now: number): void {
    const g = this.goneOf(project);
    for (const i of before) if (!after.has(i.key) && !i.unreadable && !g.has(i.key)) g.set(i.key, { item: i, at: now });
    while (g.size > GONE_MAX) g.delete(g.keys().next().value as string);
  }

  /** A document, re-read only when its mtime or size, or what its selection depends on, changed. */
  private read(p: DocProject, rel: string, taskIds: ReadonlySet<string>, touched: Set<string>, now: number): Cached | null {
    const abs = path.join(p.folder, rel);
    const id = `${p.name}\0${abs}`;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch {
      return null;
    }
    if (!st.isFile()) return null; // a link, a FIFO or a device is never opened
    touched.add(id);
    const sig = `${st.mtimeMs}:${st.size}`;
    const docKey = `doc:${p.name}/${rel}`;
    const c = this.files.get(id);
    if (c?.sig === sig && c.view === viewOf(p, docKey, c.ids, taskIds)) return c;
    if (this.roundReads > 0 && performance.now() > this.deadline) {
      this.pending = true;
      return c ?? null; // read next time; what was read before stands meanwhile
    }
    this.reads++;
    this.roundReads++;
    const text = readText(abs, true);
    if (text === null) return c ?? null; // not readable now: the last read stands, try again next time
    const value =
      text === TOO_BIG ? 'unreadable' : rel.endsWith('.json') ? parseTaskmaster(text) : parseDoc(text, path.basename(rel), p.settings.shortIds);
    const { keys, ...built } = build(p, rel, value, st.mtimeMs, taskIds);
    const next: Cached = { sig, view: viewOf(p, docKey, built.ids, taskIds), ...built };
    // §3: a line that was on the screen and is no longer in the file shows as gone for a day.
    // A settings change (short ids, hidden, a new Task) re-keys lines without the file changing: nothing is gone then.
    if (c && c.sig !== sig) this.vanished(p.name, [c.card, ...c.shown], keys, now);
    const g = this.gone.get(p.name);
    if (g) for (const k of keys) g.delete(k);
    this.files.set(id, next);
    return next;
  }

  /** How many entries a found document had when last read (for the settings). */
  itemsOf(project: string, folder: string, rel: string): number | undefined {
    const c = this.files.get(`${project}\0${path.join(folder, rel)}`);
    return c && !c.card.unreadable ? c.total : undefined;
  }

  /**
   * The doc items by project. `taskIds` are the board's Task ids: an item defining one is
   * always sent (it goes under that Task's card); the rest of a document is cut at MORE_AFTER.
   */
  refresh(
    projects: DocProject[],
    taskIds: ReadonlySet<string>,
    now: number,
    budgetMs = READ_BUDGET_MS,
  ): Map<string, TrackedProject> {
    this.pending = false;
    this.roundReads = 0;
    this.deadline = performance.now() + budgetMs;
    const out = new Map<string, TrackedProject>();
    const touched = new Set<string>();
    for (const p of projects) {
      const built = this.project(p, taskIds, now, touched);
      if (built.items.length) out.set(p.name, built);
    }
    for (const [id, c] of this.files) {
      if (touched.has(id) || this.pending) continue; // a round cut short keeps what it did not reach
      // Turned off (or out of the limit): forgotten. Deleted: what it showed is gone.
      const [project, abs] = id.split('\0');
      if (!fs.existsSync(abs) && projects.some((p) => p.name === project)) this.vanished(project, [c.card, ...c.shown], new Set(), now);
      this.files.delete(id);
    }
    for (const k of this.gone.keys()) if (!projects.some((p) => p.name === k)) this.gone.delete(k);
    return out;
  }

  private project(p: DocProject, taskIds: ReadonlySet<string>, now: number, touched: Set<string>): TrackedProject {
    const read: Cached[] = [];
    const hidden = new Set(p.settings.hidden);
    for (const d of resolveDocs(p.folder, p.settings).filter((x) => x.on).slice(0, DOCS_MAX)) {
      if (hidden.has(`doc:${p.name}/${d.path}`)) continue;
      const c = this.read(p, d.path, taskIds, touched, now);
      if (c) read.push(c);
    }
    // Ids defined twice in the project: every definition stays, each is marked.
    const count = new Map<string, number>();
    for (const c of read) for (const id of c.ids) count.set(id, (count.get(id) ?? 0) + 1);
    const dup = (i: TrackedItem) => !!i.taskId && (count.get(i.taskId) ?? 0) > 1;
    const sent: TrackedItem[] = [];
    const more: TrackedProject['more'] = [];
    for (const c of read) {
      sent.push(forScreen(c.card, dup(c.card)), ...c.shown.map((i) => forScreen(i, dup(i))));
      if (c.left > 0) more.push({ parentKey: c.card.key, count: c.left });
    }
    const g = this.gone.get(p.name);
    for (const [k, x] of g ?? []) if (now - x.at > GONE_MS || hidden.has(k)) g!.delete(k);
    for (const x of g?.values() ?? []) sent.push({ ...forScreen(x.item, false), gone: true });
    return { items: sent, more };
  }

  /**
   * The "켤까요?" candidates: Markdown files the project's git changed in the last 7 days
   * (one bounded `git log`) that hold checkboxes, a status table or a front-matter status,
   * and are not read already. A suggestion only; nothing is turned on.
   */
  async candidates(folder: string, s: TrackingProjectSettings, already: ReadonlySet<string>): Promise<string[]> {
    const names = await gitChanged(folder);
    const out: string[] = [];
    const root = fs.realpathSync(folder);
    for (const rel of names.slice(0, CANDIDATE_FILES_MAX)) {
      if (out.length >= CANDIDATES_MAX) break;
      if (already.has(rel) || !rel.toLowerCase().endsWith('.md') || rel.split('/').some((seg) => SKIP_DIRS.has(seg))) continue;
      const abs = path.join(folder, rel);
      try {
        if (!fs.lstatSync(abs).isFile() || !fs.realpathSync(abs).startsWith(root + path.sep)) continue;
      } catch {
        continue; // deleted or renamed since
      }
      const text = readText(abs, true);
      if (typeof text !== 'string') continue;
      const doc = parseDoc(text, path.basename(rel), s.shortIds);
      if (doc !== 'unreadable' && (doc.status || doc.entries.some((e) => e.kind !== 'heading'))) out.push(rel);
    }
    return out;
  }
}

/**
 * The project's own .git/config is not ours to trust: a repository can name programs git
 * would run on a plain `log` (gpg.program under log.showSignature, an fsmonitor, external
 * diff and textconv drivers, hooks). Each is switched off on the command line, which wins
 * over the repository's config; and no transport (NO_FETCH_ENV: a partial clone's lazy fetch).
 */
export const GIT_LOG_ARGS = (folder: string) => [
  '-C',
  folder,
  '-c',
  'core.quotepath=off',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'log.showSignature=false',
  '-c',
  'core.hooksPath=/dev/null',
  'log',
  '--no-show-signature',
  '--no-ext-diff',
  '--no-textconv',
  '--since=7.days',
  '--name-only',
  '--relative',
  '--format=',
];

/** `git log --since=7.days --name-only` in the folder, relative to it, output bounded; [] when it is not a repository. */
function gitChanged(folder: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      'git',
      GIT_LOG_ARGS(folder),
      {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_OUT_MAX,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...NO_FETCH_ENV },
      },
      (_err, stdout) => {
        // Over the cap the run is cut: what came so far still counts.
        const lines = String(stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
        resolve([...new Set(lines)]);
      },
    );
  });
}
