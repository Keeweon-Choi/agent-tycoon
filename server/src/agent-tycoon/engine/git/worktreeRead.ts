/**
 * W4: what one task worktree changed, read-only (git's reads only, the runner keeps hooks and
 * filters off): its changed files against the commit its branch left its base at (committed and
 * uncommitted together, plus files git does not track yet), its commits the base lacks, and one
 * file's diff, paged like the project's own (repoRead.pageDiff). Every path a client names has to
 * be an entry of a list git gave (readWorktreeChanges; the dev room keeps its last one a few seconds).
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { koText } from '../../../../../core/src/agent-tycoon/serverText.js';
import type { RepoChangedFile, RepoCommit } from '../../../../../core/src/messages.js';
import type { GitRunner } from './gitRun.js';
import { READ_ENV, RepoError } from './gitRun.js';
import type { DiffPage } from './repoRead.js';
import { gitMessage, MAX_FILES, pageDiff, readStatus } from './repoRead.js';

export const COMMITS_MAX = 20;
const FULL_SHA = /^[0-9a-f]{40}$/;
const NEW_FOLDER_NOTE = koText('new_folder_commit');

/** A task worktree as the record and git say it is now. */
export interface WorktreeSpec {
  /** Absolute. */
  path: string;
  branch: string;
  base: string;
  /** The folder is a registered worktree (RepoWorktree.exists). */
  exists: boolean;
}

export interface WorktreeDetail {
  files: RepoChangedFile[];
  filesTruncated: boolean;
  commits: RepoCommit[];
  /** Moves when the changes do (a file, a commit, also one more edit of a file already changed). */
  stamp: string;
  /** What the per-file diffs need (kept off the wire). */
  changes: WorktreeChanges;
}

/** A task worktree's changed files now and where their diffs run. */
export interface WorktreeChanges {
  basis: Basis;
  files: RepoChangedFile[];
  truncated: boolean;
}

const text = (b: Buffer) => b.toString('utf-8').trim();

/** Where the diff runs: the worktree itself, else (folder gone) the repository against the branch. */
export interface Basis {
  mb: string;
  cwd: string;
  /** The extra revision to diff against `mb`; none: the work tree. */
  tip: string[];
}

async function basis(run: GitRunner, top: string, spec: WorktreeSpec, since?: string): Promise<Basis> {
  if (since !== undefined) {
    // P4: what changed since a review's send (`sentHead`): a commit of this repository.
    const ok = FULL_SHA.test(since) && (await run(top, ['cat-file', '-e', `${since}^{commit}`], { env: READ_ENV })).code === 0;
    if (!ok) throw new RepoError(koText('compare_no_branch'));
    return spec.exists ? { mb: since, cwd: spec.path, tip: [] } : { mb: since, cwd: top, tip: [`refs/heads/${spec.branch}`] };
  }
  const baseRef = FULL_SHA.test(spec.base) ? spec.base : `refs/heads/${spec.base}`;
  const branchRef = `refs/heads/${spec.branch}`;
  const mb = await run(top, ['merge-base', baseRef, branchRef], { env: READ_ENV });
  if (mb.code !== 0) throw new RepoError(koText('compare_no_branch'));
  return spec.exists
    ? { mb: text(mb.stdout), cwd: spec.path, tip: [] }
    : { mb: text(mb.stdout), cwd: top, tip: [branchRef] };
}

const DIFF_BASE = ['-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M'];

async function changedFiles(
  run: GitRunner,
  spec: WorktreeSpec,
  b: Basis,
): Promise<{ files: RepoChangedFile[]; truncated: boolean }> {
  const r = await run(b.cwd, [...DIFF_BASE, '--name-status', '-z', b.mb, ...b.tip, '--'], { env: READ_ENV });
  if (r.code !== 0 && !r.capped) throw new RepoError(koText('git_diff_failed', { why: gitMessage(r.stderr) }));
  const t = r.stdout.toString('utf-8').split('\0');
  const files: RepoChangedFile[] = [];
  for (let i = 0; i < t.length; ) {
    const st = t[i++];
    if (!st) continue;
    if (st[0] === 'R' || st[0] === 'C') {
      const orig = t[i++];
      files.push({ path: t[i++] ?? '', origPath: orig ?? '', status: st[0] });
    } else files.push({ path: t[i++] ?? '', status: st[0] });
  }
  if (spec.exists)
    for (const f of (await readStatus(run, b.cwd, Infinity)).files)
      if (f.worktree === '?') files.push({ path: f.path, status: '?' });
  const list = files.filter((f) => f.path).sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return { files: list.slice(0, MAX_FILES), truncated: list.length > MAX_FILES || r.capped };
}

/** What task worktree `spec` changed (since its base, or since commit `since`) and where to diff it. */
export async function readWorktreeChanges(run: GitRunner, top: string, spec: WorktreeSpec, since?: string): Promise<WorktreeChanges> {
  const b = await basis(run, top, spec, since);
  return { basis: b, ...(await changedFiles(run, spec, b)) };
}

/** Each changed file's size and time in the folder: an edit of a file already listed moves the stamp. */
function fileTimes(spec: WorktreeSpec, files: readonly RepoChangedFile[]): string {
  if (!spec.exists) return '';
  return files
    .map((f) => {
      try {
        const st = fs.lstatSync(path.join(spec.path, f.path));
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        return '-';
      }
    })
    .join(',');
}

export async function readWorktreeDetail(
  run: GitRunner,
  top: string,
  spec: WorktreeSpec,
  since?: string,
): Promise<WorktreeDetail> {
  const changes = await readWorktreeChanges(run, top, spec, since);
  const { files, truncated } = changes;
  const baseRef = FULL_SHA.test(spec.base) ? spec.base : `refs/heads/${spec.base}`;
  const log = await run(
    top,
    ['log', '-z', `-n${COMMITS_MAX}`, '--format=%H%x1f%an%x1f%aI%x1f%s', `${baseRef}..refs/heads/${spec.branch}`],
    { env: READ_ENV },
  );
  const commits: RepoCommit[] = [];
  if (log.code === 0)
    for (const rec of log.stdout.toString('utf-8').split('\0')) {
      const [sha, author, at, ...subject] = rec.trim().split('\x1f');
      if (sha && FULL_SHA.test(sha)) commits.push({ sha, author: author ?? '', at: at ?? '', subject: subject.join('\x1f').slice(0, 300) });
    }
  const stamp = createHash('sha1')
    .update(JSON.stringify([changes.basis.mb, files, fileTimes(spec, files)]))
    .update(log.stdout)
    .digest('hex');
  return { files, filesTruncated: truncated, commits, stamp, changes };
}

/** One page of a changed file's diff (the work tree against where the branch left its base). */
export async function readWorktreeDiff(
  run: GitRunner,
  changes: WorktreeChanges,
  q: { path: string; offset?: number },
): Promise<DiffPage> {
  const b = changes.basis;
  const file = changes.files.find((f) => f.path === q.path);
  if (!file) throw new RepoError(koText('file_not_changed'));
  if (file.status === '?') {
    if (file.path.endsWith('/')) return { text: NEW_FOLDER_NOTE };
    return pageDiff(run, b.cwd, [...DIFF_BASE, '--no-index', '--', '/dev/null', file.path], [0, 1], q.offset);
  }
  return pageDiff(
    run,
    b.cwd,
    [...DIFF_BASE, b.mb, ...b.tip, '--', ...(file.origPath ? [file.origPath] : []), file.path],
    [0],
    q.offset,
  );
}
