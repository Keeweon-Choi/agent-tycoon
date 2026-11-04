/**
 * SPT C1-C2 (§8.3, §8.4, §8.6): the code scan, run outside the daemon as `cld-worker.js spec-map <folder>`
 * (a short child process: it reads every code file one at a time, keeps only the resolved import
 * pairs and the display IDs, test names and head-comment tags each names, reads the task specs and
 * `git log --no-merges` once, prints one JSON and exits, so its memory goes back). The daemon side
 * here is the listing that makes the cache key (no file opened) and the spawn. Folding, counting and
 * the link rules (FR-TRC-018: which of these numbers count) are structure.ts's and chain.ts's.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { idPattern, idSource } from '../../../../core/src/cld/spec/ids.js';
import type { MapStructure } from '../../../../core/src/cld/spec/trace.js';
import {
  SPEC_GIT_MAX_BYTES,
  SPEC_MAP_COMMITS_MAX,
  SPEC_MAP_FILE_MAX_BYTES,
  SPEC_MAP_FILES_MAX,
  SPEC_MAP_HEAP_MB,
  SPEC_MAP_KILL_GRACE_MS,
  SPEC_MAP_LOG_MAX_BYTES,
  SPEC_MAP_OUT_MAX_BYTES,
  SPEC_MAP_READ_MAX_BYTES,
  SPEC_MAP_TIME_MS,
  SPEC_TITLE_MAX,
} from '../../constants.js';
import { createGitRunner, type GitRunner, READ_ENV } from '../engine/git/gitRun.js';
import { maskText } from '../mask.js';
import { walkFiles } from './archOwner.js';
import { classify } from './discover.js';

// ── what counts (SPT §8.2, D5: JS and TS only) ──
const CODE_EXT = /\.(ts|tsx|js|mjs|cjs)$/;
const SKIP = /(^|\/)(node_modules|dist|public)\/|\.d\.ts$/;
export const isCodeFile = (f: string): boolean => CODE_EXT.test(f) && !SKIP.test(f);
/** A generated file (its head says so: this repository's core/src/messages.ts) is left out. */
export const isGenerated = (head: string): boolean => /AUTO-GENERATED|@generated|DO NOT EDIT/.test(head);
const HEAD_CHARS = 300;

// ── what names a number (SPT §8.4; which of them count is chain.ts's) ──
// ponytail: the default grammar only (a project's short IDs and own patterns are not passed to the child, and task specs are found by name, not by the documents tracked); pass them as arguments and key the cache on them when a project needs it.
const ID_RE = idPattern(false);
/** A test's name: the first argument of `it(`, `test(`, `describe(` (and their `.only`/`.skip`), a plain string. */
const TEST_NAME = /\b(?:it|test|describe)(?:\.(?:only|skip|todo|concurrent))?\(\s*(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
/** A head comment's tag (R4's): a comment line starting with a capital dashed word that is no display ID. */
const TAG_LINE = /^\s*(?:\/\*\*?|\/\/|\*)\s*([A-Z][A-Z0-9]{1,11}(?:-[A-Z0-9]{1,11})+)\b/gm;
/** The head a tag is read from. */
const TAG_HEAD_CHARS = 1500;
const ID_WHOLE = new RegExp(`^(?:${idSource(false)})$`);
const uniqIds = (text: string) => [...new Set(text.match(ID_RE) ?? [])];
export function testNameIds(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(TEST_NAME)) for (const id of m[2].match(ID_RE) ?? []) out.add(id);
  return [...out];
}
export function headTags(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.slice(0, TAG_HEAD_CHARS).matchAll(TAG_LINE)) if (!ID_WHOLE.test(m[1])) out.add(m[1]);
  return [...out];
}

/**
 * `git log --no-merges --name-only` from HEAD, newest first (SPT §8.4): its IDs, the tags it names
 * (of `tags`, as words) and the code files it changed. `[]` without a HEAD or git, or when git takes
 * longer than `timeoutMs` (the scan's time left: the daemon kills the whole child at
 * SPEC_MAP_TIME_MS + SPEC_MAP_KILL_GRACE_MS, and the structure with it).
 */
export async function readCommits(
  folder: string,
  run: GitRunner,
  at: ReadonlyMap<string, number>,
  tags: readonly string[],
  timeoutMs: number = SPEC_MAP_TIME_MS,
): Promise<{ commits: ScanCommit[]; capped: boolean }> {
  const commits: ScanCommit[] = [];
  let capped = false;
  const tagRe = tags.length ? new RegExp(`(?<![A-Za-z0-9_-])(?:${[...tags].sort((a, b) => b.length - a.length).join('|')})(?![A-Za-z0-9_])`, 'g') : null;
  try {
    const r = await run(
      folder,
      ['-c', 'core.quotePath=false', 'log', '--no-merges', `-${SPEC_MAP_COMMITS_MAX}`, '--no-show-signature', '--format=%x1e%H%x1f%ct%x1f%B%x1f', '--name-only', 'HEAD', '--'],
      { env: READ_ENV, maxBytes: SPEC_MAP_LOG_MAX_BYTES, timeoutMs },
    );
    if (r.code !== 0 && !r.capped) return { commits, capped };
    capped = r.capped;
    const recs = r.stdout.toString('utf-8').split('\x1e').slice(1);
    if (r.capped) recs.pop(); // cut in the middle of one
    for (const rec of recs) {
      const [sha, t, msg = '', names = ''] = rec.split('\x1f');
      if (!/^[0-9a-f]{40,64}$/.test(sha)) continue;
      const f = [...new Set(names.split('\n').flatMap((n) => (at.has(n.trim()) ? [at.get(n.trim())!] : [])))];
      const ids = uniqIds(msg);
      const named = tagRe ? [...new Set(msg.match(tagRe) ?? [])] : [];
      if (!f.length && !ids.length) continue;
      commits.push({ sha, t: Number(t) || 0, s: maskText(msg.split('\n')[0]).slice(0, SPEC_TITLE_MAX), ids, tags: named, f });
    }
  } catch {
    /* git gone: no commits */
  }
  return { commits, capped };
}

/** SPT C2 (§8.4): what the links are made of. Every display ID of the default grammar is kept; the daemon keeps the requirements' and the tasks'. */
export interface ScanLinks {
  /** Display ID → the files (indexes into `files`) whose text names it anywhere. */
  body: Record<string, number[]>;
  /** Display ID → the files with a test name (`it`·`test`·`describe`'s first argument) naming it. */
  names: Record<string, number[]>;
  /** Head-comment tags (`SPT-P3`, `MAP-A`: capital words, no display ID) → the files whose head has it. */
  tags: Record<string, number[]>;
  /** Task specs (a tasks document named `T-NNNN…`): its number → its title (masked) and the display IDs it names. */
  tasks: Record<string, { title: string; ids: string[] }>;
  /** `git log --no-merges` from HEAD, newest first, at most SPEC_MAP_COMMITS_MAX: those that touch a code file or name an ID. */
  commits: ScanCommit[];
  /** The log's output reached SPEC_MAP_LOG_MAX_BYTES: older commits not read. */
  capped: boolean;
}
export interface ScanCommit {
  sha: string;
  /** Commit time, seconds. */
  t: number;
  /** Its subject, masked, capped. */
  s: string;
  ids: string[];
  /** The head-comment tags its message names. */
  tags: string[];
  /** The code files it changed (indexes into `files`). */
  f: number[];
}

/** What the child process answers: the code files and their resolved relative imports. */
export interface CodeScan {
  files: string[];
  /** Flat pairs of indexes into `files`: an import from files[edges[2i]] to files[edges[2i+1]]. */
  edges: number[];
  unresolved: number;
  /** The root package.json's workspaces, as folders. */
  workspaces: string[];
  partial?: MapStructure['partial'];
  /** Files over SPEC_MAP_FILE_MAX_BYTES: counted, their imports not read. */
  big: number;
  at: string;
  ms: number;
  rssKb: number;
  /** SPT C2: none from a scan of C1 or a test that only folds. */
  links?: ScanLinks;
}

// ── imports (SPT §8.3: R4's IMP and resolve, no new dependency) ──
const IMP = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;
/** The relative specifiers a file imports (`./x.js`, `../y`); a package or an alias is none of them. */
export function relativeImports(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(IMP)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec.startsWith('.')) out.push(spec);
  }
  return out;
}
/** `spec` imported from `from`, as a file `has` knows (`.js` → `.ts`, a folder → its index), or null. */
export function resolveImport(from: string, spec: string, has: (f: string) => boolean): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  const stem = base.replace(/\.(js|mjs|cjs|jsx)$/, '');
  for (const c of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.mjs`, `${stem}.cjs`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`]) if (has(c)) return c;
  return null;
}

/** package.json `workspaces` (a list or `{packages}`) as folders; `dir/*` names each folder under it that holds a file. */
export function workspaceDirs(pkg: unknown, files: readonly string[]): string[] {
  const w = (pkg as { workspaces?: unknown } | null)?.workspaces;
  const list = Array.isArray(w) ? w : Array.isArray((w as { packages?: unknown } | undefined)?.packages) ? (w as { packages: unknown[] }).packages : [];
  const out = new Set<string>();
  for (const p of list) {
    if (typeof p !== 'string') continue;
    const dir = p.replace(/^\.\//, '').replace(/\/+$/, '');
    // ponytail: plain folders and `dir/*` only; `**` and other globs name nothing.
    if (!dir.includes('*')) {
      if (dir) out.add(dir);
    } else if (dir.endsWith('/*') && !dir.slice(0, -2).includes('*')) {
      const parent = `${dir.slice(0, -2)}/`;
      for (const f of files) if (f.startsWith(parent) && f.slice(parent.length).includes('/')) out.add(parent + f.slice(parent.length).split('/')[0]);
    }
  }
  return [...out].sort();
}

/** SPT C2: a task spec (`cld/tasks/T-0018-engine.md`): a tasks document by its name whose name starts with its number. */
const TASK_NAME = /^(T-\d{1,5})(?![0-9])[^/]*\.md$/;
export const taskNumber = (rel: string): string | null => {
  const m = TASK_NAME.exec(path.posix.basename(rel));
  return m && classify(rel) === 'task' ? m[1] : null;
};

/**
 * The project's code files, sorted: `git ls-files` (tracked and untracked, not ignored) in a
 * repository, else the capped folder walk (archOwner's). `capped`: the listing was cut. `tasks`: the
 * task specs listed (SPT C2's 작업 길).
 */
export async function listCode(folder: string, run: GitRunner): Promise<{ files: string[]; tasks: string[]; capped: boolean }> {
  const out = (names: string[], capped: boolean) => ({ files: [...new Set(names.filter(isCodeFile))].sort(), tasks: [...new Set(names.filter((f) => taskNumber(f)))].sort(), capped });
  try {
    const r = await run(folder, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { env: READ_ENV, maxBytes: SPEC_GIT_MAX_BYTES });
    if (r.code === 0 || r.capped) {
      const names = r.stdout.toString('utf-8').split('\0').filter(Boolean);
      if (r.capped) names.pop(); // cut in the middle of one
      return out(names, r.capped);
    }
  } catch {
    /* no git: walk */
  }
  const w = walkFiles(folder);
  return out(w.files, w.capped);
}

/**
 * A listed path's stats when it is a regular file inside `root` (the project folder, real path):
 * never a link (to /dev/zero, to a file outside), a FIFO or a device, never through a linked folder.
 */
export function regularFile(root: string, rel: string, dirs?: Map<string, string>): fs.Stats | null {
  const full = path.join(root, rel);
  try {
    const st = fs.lstatSync(full);
    if (!st.isFile()) return null;
    // One realpath per folder (C1 measured 290 ms for 20,000 files with one per file).
    const parent = path.dirname(full);
    let dir = dirs?.get(parent);
    if (dir === undefined) {
      dir = fs.realpathSync(parent);
      dirs?.set(parent, dir);
    }
    return dir === root || dir.startsWith(root + path.sep) ? st : null;
  } catch {
    return null; // deleted, still in the index
  }
}

/** The cache key's file part (SPT §8.6): how many code files and the latest mtime. Stats only, no file opened; the scan's files only. */
// ponytail: a rename that keeps the mtime and the count (an uncommitted git mv) leaves the key as it was; hash the sorted paths if that ever matters.
export async function codeKey(folder: string, run: GitRunner): Promise<string> {
  const { files, capped } = await listCode(folder, run);
  const root = fs.realpathSync(folder);
  const dirs = new Map<string, string>();
  let n = 0;
  let latest = 0;
  for (const f of files) {
    const st = regularFile(root, f, dirs);
    if (!st) continue;
    latest = Math.max(latest, st.mtimeMs);
    n++;
  }
  return `${n}|${latest}|${capped ? 'c' : ''}`;
}

/** A regular file's text, opened without following a link and without blocking on a FIFO, at most `max` bytes read. */
function readRegular(full: string, max: number): string | null {
  const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
  const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;
  const fd = fs.openSync(full, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max) return null; // swapped since the lstat
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) {
      const n = fs.readSync(fd, buf, got, st.size - got, got);
      if (!n) break;
      got += n;
    }
    return buf.toString('utf-8', 0, got);
  } finally {
    fs.closeSync(fd);
  }
}

/** The child process's work: list, read one file at a time, keep the resolved import pairs. */
export async function scanCode(folder: string, run: GitRunner = createGitRunner(), clock: () => number = Date.now): Promise<CodeScan> {
  const t0 = clock();
  const listed = await listCode(folder, run);
  let partial: CodeScan['partial'] = listed.capped ? 'list' : undefined;
  let all = listed.files;
  if (all.length > SPEC_MAP_FILES_MAX) {
    all = all.slice(0, SPEC_MAP_FILES_MAX);
    partial ??= 'files';
  }
  const known = new Set(all);
  const root = fs.realpathSync(folder);
  const dirs = new Map<string, string>();
  const drop = new Set<string>();
  const pairs: string[] = [];
  // SPT C2: by path for now (files drop out below): each file's IDs, test-name IDs and head tags.
  const named = new Map<string, { body: string[]; names: string[]; tags: string[] }>();
  let unresolved = 0;
  let big = 0;
  let bytes = 0;
  for (const f of all) {
    if (clock() - t0 > SPEC_MAP_TIME_MS) {
      partial = 'time';
      break;
    }
    // A link, a FIFO, a device, a path through a linked folder: not code of this project, never opened.
    const st = regularFile(root, f, dirs);
    if (!st) {
      drop.add(f);
      continue;
    }
    if (st.size > SPEC_MAP_FILE_MAX_BYTES) {
      big++;
      continue;
    }
    if (bytes + st.size > SPEC_MAP_READ_MAX_BYTES) {
      partial = 'bytes';
      break;
    }
    bytes += st.size;
    let text: string | null;
    try {
      text = readRegular(path.join(root, f), SPEC_MAP_FILE_MAX_BYTES);
    } catch {
      text = null;
    }
    if (text === null) {
      drop.add(f);
      continue;
    }
    if (isGenerated(text.slice(0, HEAD_CHARS))) {
      drop.add(f);
      continue;
    }
    for (const spec of relativeImports(text)) {
      const to = resolveImport(f, spec, (c) => known.has(c));
      if (to) pairs.push(f, to);
      else unresolved++;
    }
    const body = uniqIds(text);
    const names = body.length ? testNameIds(text) : [];
    const tags = headTags(text);
    if (body.length || tags.length) named.set(f, { body, names, tags });
  }
  const files = all.filter((f) => !drop.has(f));
  const at = new Map(files.map((f, i) => [f, i]));
  const links: ScanLinks = { body: {}, names: {}, tags: {}, tasks: {}, commits: [], capped: false };
  const push = (m: Record<string, number[]>, key: string, i: number) => void (m[key] ??= []).push(i);
  for (const [f, n] of named) {
    const i = at.get(f);
    if (i === undefined) continue;
    for (const id of n.body) push(links.body, id, i);
    for (const id of n.names) push(links.names, id, i);
    for (const tag of n.tags) push(links.tags, tag, i);
  }
  // The task specs: their title and the IDs they name, read like the code (regular files, the same caps).
  for (const doc of listed.tasks) {
    if (partial === 'time' || partial === 'bytes') break;
    const st = regularFile(root, doc, dirs);
    if (!st || st.size > SPEC_MAP_FILE_MAX_BYTES) continue;
    if (bytes + st.size > SPEC_MAP_READ_MAX_BYTES) {
      partial = 'bytes';
      break;
    }
    bytes += st.size;
    let text: string | null = null;
    try {
      text = readRegular(path.join(root, doc), SPEC_MAP_FILE_MAX_BYTES);
    } catch {
      /* gone */
    }
    if (text === null) continue;
    const num = taskNumber(doc)!;
    const t = (links.tasks[num] ??= { title: '', ids: [] });
    t.title ||= maskText(/^#\s+(.+)$/m.exec(text)?.[1].replace(new RegExp(`^${num}[\\s:.—–-]*`), '') ?? '').slice(0, SPEC_TITLE_MAX);
    t.ids = [...new Set([...t.ids, ...uniqIds(text).filter((id) => id !== num)])];
  }
  const left = SPEC_MAP_TIME_MS - (clock() - t0);
  if (left > 0) Object.assign(links, await readCommits(folder, run, at, Object.keys(links.tags), left));
  const edges: number[] = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const a = at.get(pairs[i]);
    const b = at.get(pairs[i + 1]);
    // An import of a file left out (a generated one) is one this scan could not resolve.
    if (a === undefined || b === undefined) unresolved++;
    else edges.push(a, b);
  }
  let pkg: unknown = null;
  try {
    const text = regularFile(root, 'package.json', dirs) ? readRegular(path.join(root, 'package.json'), SPEC_MAP_FILE_MAX_BYTES) : null;
    if (text !== null) pkg = JSON.parse(text);
  } catch {
    /* none */
  }
  return {
    files,
    edges,
    unresolved,
    workspaces: workspaceDirs(pkg, files),
    ...(partial && { partial }),
    big,
    at: new Date(clock()).toISOString(),
    ms: clock() - t0,
    rssKb: process.resourceUsage().maxRSS,
    links,
  };
}

/** The daemon's side: `node --max-old-space-size=… cld-worker.js spec-map <folder>`, its JSON, or null (killed, failed, malformed). */
export function spawnSpecMap(worker: string, node = process.execPath): (folder: string) => Promise<CodeScan | null> {
  return (folder) =>
    new Promise((resolve) => {
      execFile(
        node,
        [`--max-old-space-size=${SPEC_MAP_HEAP_MB}`, worker, 'spec-map', folder],
        { timeout: SPEC_MAP_TIME_MS + SPEC_MAP_KILL_GRACE_MS, maxBuffer: SPEC_MAP_OUT_MAX_BYTES, windowsHide: true, encoding: 'utf-8' },
        (err, stdout) => {
          if (err) {
            console.warn(`[Agent Tycoon] spec map scan failed: ${err.message.split('\n')[0]}`);
            return resolve(null);
          }
          try {
            const scan = JSON.parse(stdout) as CodeScan;
            resolve(Array.isArray(scan.files) && Array.isArray(scan.edges) ? scan : null);
          } catch {
            resolve(null);
          }
        },
      );
    });
}
