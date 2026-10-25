/**
 * W4: what one task worktree changed, read-only (git's reads only, the runner keeps hooks and
 * filters off): its changed files against the commit its branch left its base at (committed and
 * uncommitted together, plus files git does not track yet), its commits the base lacks, and one
 * file's diff, paged like the project's own (repoRead.pageDiff). Every path a client names has to
 * be an entry of the list read now.
 */
import { koText } from '../../../../../core/src/cld/serverText.js';
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
}

const text = (b: Buffer) => b.toString('utf-8').trim();

/** Where the diff runs: the worktree itself, else (folder gone) the repository against the branch. */
interface Basis {
  mb: string;
  cwd: string;
  /** The extra revision to diff against `mb`; none: the work tree. */
  tip: string[];
}

async function basis(run: GitRunner, top: string, spec: WorktreeSpec): Promise<Basis> {
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

export async function readWorktreeDetail(
  run: GitRunner,
  top: string,
  spec: WorktreeSpec,
): Promise<WorktreeDetail> {
  const b = await basis(run, top, spec);
  const { files, truncated } = await changedFiles(run, spec, b);
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
  return { files, filesTruncated: truncated, commits };
}

/** One page of a changed file's diff (the work tree against where the branch left its base). */
export async function readWorktreeDiff(
  run: GitRunner,
  top: string,
  spec: WorktreeSpec,
  q: { path: string; offset?: number },
): Promise<DiffPage> {
  const b = await basis(run, top, spec);
  const file = (await changedFiles(run, spec, b)).files.find((f) => f.path === q.path);
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
