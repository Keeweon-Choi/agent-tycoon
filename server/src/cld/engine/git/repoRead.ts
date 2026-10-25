/**
 * Reading a repository (FR-ENG-005): `git status --porcelain=v2 --branch -z`,
 * the two `git diff --stat`s, and a per-file unified diff, 200 KB a page.
 * Everything runs in the repository's top folder, which must BE the project
 * folder, and every path a client names has to be an entry of the latest
 * status: no client string reaches git unchecked.
 */
import * as fs from 'fs';
import * as path from 'path';

import { koText } from '../../../../../core/src/cld/serverText.js';
import type { RepoFile, RepoState } from '../../../../../core/src/messages.js';
import type { GitRunner } from './gitRun.js';
import { LITERAL_ENV, READ_ENV, RepoError } from './gitRun.js';

/** A project the daemon manages: the E1 registry's entries fit. */
export interface ProjectFolder {
  name: string;
  /** Absolute. */
  folder: string;
}

export const MAX_FILES = 300;
export const STAT_MAX_BYTES = 16 * 1024;
export const DIFF_CHUNK_BYTES = 200 * 1024;
/** The diff goes on past this, but the daemon will not page through it. */
export const DIFF_TOTAL_BYTES = 2 * 1024 * 1024;
const DIFF_TIMEOUT_MS = 20_000;
const NEW_DIRECTORY_NOTE = koText('new_folder_stage');

export interface ParsedStatus {
  /** Short commit id; null before the first commit. */
  head: string | null;
  /** Null on a detached HEAD. */
  branch: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  files: RepoFile[];
  /** More entries than `files` holds (cut at maxFiles, or git's output was cut). */
  truncated: boolean;
}

/** A merge conflict: porcelain's unmerged codes. */
export const isConflict = (f: RepoFile): boolean =>
  ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(f.index + f.worktree);
/** Staged: the index differs from HEAD (an unresolved conflict is not a staged change). */
export const isStaged = (f: RepoFile): boolean =>
  f.index !== '.' && f.index !== '?' && !isConflict(f);
/** Something in the work tree to add: a change, a deletion, a new file, a conflict to resolve. */
export const isUnstaged = (f: RepoFile): boolean => f.worktree !== '.';

/** git's first useful line, without its `fatal:`/`error:` prefix. */
export function gitMessage(stderr: string): string {
  const line = stderr
    .split('\n')
    .map((l) => l.replace(/^(fatal|error): /, '').trim())
    .find(Boolean);
  return (line ?? '').slice(0, 200);
}

function sameDir(a: string, b: string): boolean {
  try {
    const x = fs.realpathSync(a);
    const y = fs.realpathSync(b);
    return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
  } catch {
    return false;
  }
}

function openFailure(stderr: string): string {
  if (/not a git repository/i.test(stderr)) return koText('git_not_repo');
  if (/dubious ownership|safe\.directory/i.test(stderr)) {
    return koText('git_other_owner');
  }
  if (/work ?tree/i.test(stderr)) return koText('git_not_worktree');
  return koText('git_open_failed', { why: gitMessage(stderr) });
}

/**
 * The folder to run git in: `folder` itself, which must be the repository's
 * top folder (a subfolder would make status paths and worktrees ambiguous).
 * Throws a RepoError (Korean) otherwise.
 */
export async function repoRoot(run: GitRunner, folder: string): Promise<string> {
  if (!path.isAbsolute(folder)) throw new RepoError(koText('folder_path_invalid'));
  let real: string;
  try {
    real = fs.realpathSync(folder);
    if (!fs.statSync(real).isDirectory()) throw new Error('not a folder');
  } catch {
    throw new RepoError(koText('folder_missing'));
  }
  const r = await run(real, ['rev-parse', '--show-toplevel'], { env: READ_ENV });
  if (r.code !== 0) throw new RepoError(openFailure(r.stderr));
  if (!sameDir(r.stdout.toString('utf-8').trim(), real)) {
    throw new RepoError(koText('git_not_top'));
  }
  return real;
}

/** The first `n` space-separated fields of `line`, then the rest (a path may hold spaces). */
function splitFields(line: string, n: number): string[] | null {
  const out: string[] = [];
  let pos = 0;
  for (let i = 0; i < n; i++) {
    const space = line.indexOf(' ', pos);
    if (space < 0) return null;
    out.push(line.slice(pos, space));
    pos = space + 1;
  }
  out.push(line.slice(pos));
  return out;
}

/**
 * `git status --porcelain=v2 --branch -z`. Entries are NUL-terminated and
 * their paths raw (no quoting); a rename/copy (`2`) is followed by one more
 * NUL-terminated field, the old path. Ignored entries are not asked for.
 */
export function parseStatusV2(out: Buffer | string, maxFiles = MAX_FILES): ParsedStatus {
  const tokens = (typeof out === 'string' ? out : out.toString('utf-8')).split('\0');
  const st: ParsedStatus = {
    head: null,
    branch: null,
    upstream: null,
    ahead: null,
    behind: null,
    files: [],
    truncated: false,
  };
  const add = (file: RepoFile) => {
    if (st.files.length < maxFiles) st.files.push(file);
    else st.truncated = true;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (t.startsWith('# ')) {
      const m = /^# branch\.(oid|head|upstream|ab) (.*)$/.exec(t);
      if (!m) continue;
      const [, key, value] = m;
      if (key === 'oid') st.head = value === '(initial)' ? null : value.slice(0, 7);
      else if (key === 'head') st.branch = value === '(detached)' ? null : value;
      else if (key === 'upstream') st.upstream = value;
      else {
        const ab = /^\+(\d+) -(\d+)$/.exec(value);
        if (ab) [st.ahead, st.behind] = [Number(ab[1]), Number(ab[2])];
      }
    } else if (t[0] === '1' || t[0] === 'u') {
      const f = splitFields(t, t[0] === '1' ? 8 : 10);
      if (f) add({ path: f[f.length - 1], index: f[1][0], worktree: f[1][1] });
    } else if (t[0] === '2') {
      const orig = tokens[++i];
      const f = splitFields(t, 9);
      if (f) {
        add({
          path: f[9],
          ...(orig ? { origPath: orig } : {}),
          index: f[1][0],
          worktree: f[1][1],
        });
      }
    } else if (t[0] === '?') {
      add({ path: t.slice(2), index: '.', worktree: '?' });
    }
  }
  return st;
}

export async function readStatus(
  run: GitRunner,
  top: string,
  maxFiles = MAX_FILES,
): Promise<ParsedStatus> {
  const r = await run(
    top,
    ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'],
    { env: READ_ENV, timeoutMs: DIFF_TIMEOUT_MS },
  );
  if (r.code !== 0 && !r.capped) throw new RepoError(koText('git_status_failed', { why: gitMessage(r.stderr) }));
  const st = parseStatusV2(r.stdout, maxFiles);
  return { ...st, truncated: st.truncated || r.capped };
}

/** `git diff [--cached] --stat`, cut at a line end under STAT_MAX_BYTES. */
async function statText(run: GitRunner, top: string, cached: boolean): Promise<string> {
  const r = await run(
    top,
    ['-c', 'core.quotepath=off', 'diff', ...(cached ? ['--cached'] : []), '--stat', '--no-color'],
    { env: READ_ENV, maxBytes: STAT_MAX_BYTES },
  );
  if (r.code !== 0 && !r.capped) return '';
  const text = r.stdout.toString('utf-8');
  return r.capped ? text.slice(0, text.lastIndexOf('\n') + 1) : text;
}

/** The repository as `repoState` shows it, minus the worktrees (worktrees.ts). Never rejects on a RepoError. */
export async function readRepoState(
  run: GitRunner,
  project: ProjectFolder,
): Promise<Omit<RepoState, 'type' | 'worktrees'>> {
  try {
    const top = await repoRoot(run, project.folder);
    const st = await readStatus(run, top);
    const [statStaged, statUnstaged] = await Promise.all([
      st.files.some(isStaged) ? statText(run, top, true) : '',
      st.files.some((f) => isUnstaged(f) && f.worktree !== '?') ? statText(run, top, false) : '',
    ]);
    return {
      project: project.name,
      ok: true,
      branch: st.branch,
      head: st.head,
      upstream: st.upstream,
      ahead: st.ahead,
      behind: st.behind,
      files: st.files,
      filesTruncated: st.truncated,
      statUnstaged,
      statStaged,
    };
  } catch (err) {
    if (err instanceof RepoError) return { project: project.name, ok: false, error: err.message };
    throw err;
  }
}

export interface DiffPage {
  text: string;
  /** Present when more follows. */
  nextOffset?: number;
  /** The diff goes on past what the daemon pages through. */
  limited?: boolean;
}

/** Back from `end` to the start of a UTF-8 character (never cut one in two). */
function charBoundary(buf: Buffer, start: number, end: number): number {
  let at = end;
  while (at > start && (buf[at] & 0xc0) === 0x80) at--;
  return at;
}

/**
 * One 200 KB page of a file's unified diff, from byte `offset` of git's
 * output, cut at a line end. `staged`: the index against HEAD; otherwise the
 * work tree against the index (a new file is shown whole). git is re-run per
 * page and stopped as soon as the page and one byte more have arrived.
 */
export async function readDiff(
  run: GitRunner,
  folder: string,
  q: { path: string; staged: boolean; offset?: number },
): Promise<DiffPage> {
  const top = await repoRoot(run, folder);
  const status = await readStatus(run, top, Infinity);
  const file = status.files.find((f) => f.path === q.path);
  if (!file) throw new RepoError(koText('file_not_changed'));

  const base = ['-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', '--no-textconv'];
  let args: string[];
  let okCodes = [0];
  const conflict = isConflict(file);
  if (file.worktree === '?') {
    if (file.path.endsWith('/')) return { text: NEW_DIRECTORY_NOTE };
    args = [...base, '--no-index', '--', '/dev/null', file.path];
    okCodes = [0, 1]; // 1 = the files differ
  } else if (q.staged && !conflict) {
    if (!isStaged(file)) throw new RepoError(koText('file_no_staged'));
    args = [...base, '--cached', '-M', '--', ...(file.origPath ? [file.origPath] : []), file.path];
  } else {
    if (!isUnstaged(file)) throw new RepoError(koText('file_no_unstaged'));
    args = [...base, '--', file.path];
  }

  return pageDiff(run, top, args, okCodes, q.offset);
}

/** One page of git's output for the diff command `args`, from byte `offset` (see readDiff). */
export async function pageDiff(
  run: GitRunner,
  cwd: string,
  args: string[],
  okCodes: number[],
  at?: number,
): Promise<DiffPage> {
  const offset = Math.max(0, Math.floor(at ?? 0));
  if (offset >= DIFF_TOTAL_BYTES) return { text: '', limited: true };
  const r = await run(cwd, args, {
    env: { ...READ_ENV, ...LITERAL_ENV },
    maxBytes: offset + DIFF_CHUNK_BYTES + 1,
    timeoutMs: DIFF_TIMEOUT_MS,
  });
  if (r.timedOut) throw new RepoError(koText('diff_timeout'));
  if (!r.capped && (r.code === null || !okCodes.includes(r.code))) {
    throw new RepoError(koText('git_diff_failed', { why: gitMessage(r.stderr) }));
  }
  const buf = r.stdout;
  if (offset >= buf.length) return { text: '' };
  const more = buf.length > offset + DIFF_CHUNK_BYTES;
  let end = Math.min(buf.length, offset + DIFF_CHUNK_BYTES);
  if (more) {
    const newline = buf.lastIndexOf(0x0a, end - 1);
    end = newline >= offset ? newline + 1 : charBoundary(buf, offset, end);
  }
  const page: DiffPage = { text: buf.subarray(offset, end).toString('utf-8') };
  if (more) {
    if (end >= DIFF_TOTAL_BYTES) page.limited = true;
    else page.nextOffset = end;
  }
  return page;
}
