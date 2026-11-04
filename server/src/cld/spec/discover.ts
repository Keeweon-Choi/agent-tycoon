/**
 * SPT §2.3, §2.6: the project folder's documents, as the working tree has them. The walk is the
 * file system's, not git's (an untracked or git-ignored plan is often the real one), bounded by
 * SPEC_WALK_* and never through a link: directories by their own entry, files by lstat + isFile.
 * Git is evidence only: each document's state comes from one `git status` and one `git ls-files`
 * through the guarded runner (no hooks, no fsmonitor, no filters, no optional index lock), and
 * nothing here writes the repository, `.git` or any git config.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  SPEC_FILE_MAX_BYTES,
  SPEC_FM_HEAD_BYTES,
  SPEC_GIT_MAX_BYTES,
  SPEC_SKIP_DIRS,
  SPEC_WALK_DEPTH_MAX,
  SPEC_WALK_DIRS_MAX,
  SPEC_WALK_FILES_MAX,
} from '../../constants.js';
import { type GitRunner, READ_ENV } from '../engine/git/gitRun.js';
import { parseStatusV2 } from '../engine/git/repoRead.js';
import { forbiddenFilePath } from '../files/security.js';
import { frontMatter } from '../tracking/docs.js';
import { SKIP_DIRS } from '../tracking/settings.js';

export const DOC_KINDS = ['requirements', 'design', 'decision', 'test', 'task', 'plan', 'other', 'log'] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export const GIT_STATES = ['committed', 'modified', 'untracked', 'ignored', 'not-git'] as const;
export type GitState = (typeof GIT_STATES)[number];

const SKIP = new Set([...SKIP_DIRS, ...SPEC_SKIP_DIRS]);
const DOC_FILE = /\.md$/i;
/** git's own pathspec for the same files, relative to the project folder, at any depth. */
const DOC_PATHSPEC = ':(glob,icase)**/*.md';

export interface Found {
  /** Relative to the project folder, `/`-separated. */
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * The Markdown files under `folder`. `stat` false (the cheap count while tracking is off): names
 * only, from the directory entries; true: each file lstat'ed (a link, FIFO or device is never a
 * document) and over SPEC_FILE_MAX_BYTES left out.
 */
export function walkDocs(folder: string, stat: boolean): { files: Found[]; capped: boolean } {
  const files: Found[] = [];
  let dirs = 0;
  let capped = false;
  const walk = (rel: string, depth: number) => {
    if (capped) return;
    if (++dirs > SPEC_WALK_DIRS_MAX) return void (capped = true);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(folder, rel), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (forbiddenFilePath(next)) continue;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && depth < SPEC_WALK_DEPTH_MAX) walk(next, depth + 1);
        continue;
      }
      if (!e.isFile() || !DOC_FILE.test(e.name)) continue;
      if (files.length >= SPEC_WALK_FILES_MAX) return void (capped = true);
      if (!stat) {
        files.push({ path: next, size: 0, mtimeMs: 0 });
        continue;
      }
      try {
        const st = fs.lstatSync(path.join(folder, next));
        if (st.isFile() && st.size <= SPEC_FILE_MAX_BYTES) files.push({ path: next, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* gone meanwhile */
      }
    }
  };
  walk('', 0);
  return { files, capped };
}

/** SPT §2.3: front-matter words (`type:`, `kind:`, `category:`) that name a kind. */
const FM_KINDS: Readonly<Record<string, DocKind>> = {
  requirements: 'requirements',
  requirement: 'requirements',
  prd: 'requirements',
  srs: 'requirements',
  spec: 'requirements',
  specification: 'requirements',
  design: 'design',
  architecture: 'design',
  adr: 'decision',
  decision: 'decision',
  test: 'test',
  'test-plan': 'test',
  testplan: 'test',
  task: 'task',
  plan: 'plan',
  roadmap: 'plan',
  backlog: 'plan',
  todo: 'plan',
  log: 'log',
  handoff: 'log',
  changelog: 'log',
  journal: 'log',
  progress: 'log',
};

/** The kind a document's front matter names, if any (`head`: its first bytes). */
function fmKind(head: string): DocKind | null {
  const { fields } = frontMatter(head.split(/\r?\n/));
  for (const key of ['type', 'kind', 'category']) {
    const word = fields.get(key)?.toLowerCase().split(/[\s,;/]+/)[0];
    if (word && Object.hasOwn(FM_KINDS, word)) return FM_KINDS[word];
  }
  return null;
}

/** A document's first SPEC_FM_HEAD_BYTES (no link followed), '' when it cannot be read. */
export function headOf(folder: string, rel: string): string {
  try {
    const fd = fs.openSync(path.join(folder, rel), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const b = Buffer.alloc(SPEC_FM_HEAD_BYTES);
      return b.subarray(0, fs.readSync(fd, b, 0, b.length, 0)).toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * SPT §2.3: a document's kind from its front matter's `type:`/`kind:`/`category:` word when it
 * names one, else from its name and folders (the owner fixes a wrong one on the 문서 tab). `head`:
 * the document's text or first bytes; without it, names only (the cheap count reads nothing).
 */
export function classify(rel: string, head?: string): DocKind {
  const fm = head ? fmKind(head) : null;
  if (fm) return fm;
  const segs = rel.toLowerCase().split('/');
  const name = segs.pop()!.replace(/\.md$/, '');
  const inDir = (...names: string[]) => segs.some((s) => names.includes(s));
  if (/^(handoff|progress|changelog|history|journal|worklog)\b/.test(name) || /\d{4}-\d{2}-\d{2}/.test(name) || inDir('handoff', 'logs', 'journal'))
    return 'log';
  if (inDir('adr', 'adrs', 'decisions') || /^(decisions?|adr-\d)/.test(name)) return 'decision';
  if (inDir('tasks') || /^t-\d+/.test(name) || name === 'tasks') return 'task';
  if (/test[-_ ]?plan|^test_/.test(name) || (inDir('docs') && inDir('test', 'tests'))) return 'test';
  if (inDir('design', 'architecture') || /^(architecture|design)\b|[-_]design$/.test(name)) return 'design';
  if (/^(prd|srs|requirements?)\b|[-_]roadmap$/.test(name) || inDir('requirements', 'specs', 'spec')) return 'requirements';
  if (/^(todo|plan|backlog|roadmap|milestones?)\b/.test(name) || inDir('plan', 'plans')) return 'plan';
  return 'other';
}

/** Ticked in the 켜기 window: every kind but other and log, and nothing git ignores (it may hold secrets). */
export const preselected = (kind: DocKind, git: GitState): boolean => kind !== 'other' && kind !== 'log' && git !== 'ignored';

/** The git blob id of `bytes` (what `git hash-object` prints, computed here: nothing is written). */
export const blobOf = (bytes: Buffer): string =>
  crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

export interface GitView {
  repo: boolean;
  head: string | null;
  branch: string | null;
  stateOf(rel: string): GitState;
  /** Renames staged in the index, new path → old (SPT §2.6: uncommitted renames are evidence too). */
  renames: Map<string, string>;
  /** When the bulk read was cut at SPEC_GIT_MAX_BYTES: ask git about these paths one by one (check-ignore, ls-files) before stateOf. */
  resolve(paths: readonly string[]): Promise<void>;
}

const NOT_GIT: GitView = { repo: false, head: null, branch: null, stateOf: () => 'not-git', renames: new Map(), resolve: () => Promise.resolve() };
/** Paths per check-ignore / ls-files call when the bulk read was cut. */
const RESOLVE_CHUNK = 100;

/**
 * Each document's git state, from the project folder (which may sit inside a bigger repository):
 * modified and untracked from `git status`, tracked from `git ls-files`, the rest ignored.
 */
export async function readGitView(run: GitRunner, folder: string): Promise<GitView> {
  const opts = { env: READ_ENV, maxBytes: SPEC_GIT_MAX_BYTES };
  try {
    const prefixRun = await run(folder, ['rev-parse', '--show-prefix'], opts);
    if (prefixRun.code !== 0) return NOT_GIT;
    const prefix = prefixRun.stdout.toString('utf-8').trim();
    const [status, listed] = await Promise.all([
      run(folder, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--', DOC_PATHSPEC], opts),
      run(folder, ['-c', 'core.quotepath=off', 'ls-files', '-z', '--', DOC_PATHSPEC], opts),
    ]);
    if (status.code !== 0 && !status.capped) return NOT_GIT;
    const st = parseStatusV2(status.stdout, Infinity);
    const rel = (p: string) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p);
    const changed = new Map(st.files.map((f) => [rel(f.path), f.worktree === '?' ? 'untracked' : 'modified'] as const));
    const tracked = new Set(listed.stdout.toString('utf-8').split('\0').filter(Boolean));
    const renames = new Map(st.files.filter((f) => f.origPath && f.index === 'R').map((f) => [rel(f.path), rel(f.origPath!)] as const));
    // A status or list cut at SPEC_GIT_MAX_BYTES (a huge untracked tree): a path neither names is asked about by itself, not assumed ignored.
    // ponytail: a tracked path past a cut status reads 'committed' (its modification is not asked); until resolve() asks, 'ignored' (the unticked side).
    const cut = status.capped || listed.capped;
    const asked = new Map<string, GitState>();
    const known = (p: string) => changed.has(p) || tracked.has(p) || asked.has(p);
    return {
      repo: true,
      head: st.head,
      branch: st.branch,
      stateOf: (p) => changed.get(p) ?? (tracked.has(p) ? 'committed' : (asked.get(p) ?? 'ignored')),
      renames,
      resolve: async (paths) => {
        if (!cut) return;
        const todo = [...new Set(paths)].filter((p) => !known(p));
        for (const p of todo.filter((x) => x.includes('\n'))) asked.set(p, 'ignored'); // not askable one per line: the unticked side
        for (let i = 0; i < todo.length; i += RESOLVE_CHUNK) {
          const chunk = todo.slice(i, i + RESOLVE_CHUNK).filter((x) => !asked.has(x));
          if (!chunk.length) continue;
          // Without --stdin, -z is refused: one path per line, quotepath off.
          const ign = await run(folder, ['-c', 'core.quotepath=off', 'check-ignore', '--', ...chunk], opts);
          const ignored = new Set(ign.code === 0 ? ign.stdout.toString('utf-8').split('\n').filter(Boolean) : []);
          const rest = chunk.filter((p) => !ignored.has(p));
          const ls = rest.length && listed.capped ? await run(folder, ['--literal-pathspecs', '-c', 'core.quotepath=off', 'ls-files', '-z', '--', ...rest], opts) : null;
          const inIndex = new Set(ls?.code === 0 ? ls.stdout.toString('utf-8').split('\0').filter(Boolean) : []);
          for (const p of chunk) asked.set(p, ignored.has(p) ? 'ignored' : inIndex.has(p) ? 'committed' : 'untracked');
        }
      },
    };
  } catch {
    return NOT_GIT; // git missing or too old: the documents are still read, as a folder's
  }
}

/** Recent commits on HEAD: sha, subject (unmasked: the caller masks), commit time. */
export async function readRecentCommits(
  run: GitRunner,
  folder: string,
  n: number,
): Promise<Array<{ sha: string; subject: string; time: string }>> {
  try {
    const r = await run(folder, ['log', `-${n}`, '--no-show-signature', '--format=%H%x1f%cI%x1f%s'], {
      env: READ_ENV,
      maxBytes: SPEC_GIT_MAX_BYTES,
    });
    if (r.code !== 0) return [];
    return r.stdout
      .toString('utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [sha, time, subject] = l.split('\x1f');
        return { sha, time, subject: subject ?? '' };
      });
  } catch {
    return [];
  }
}
