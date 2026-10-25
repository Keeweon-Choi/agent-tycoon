/**
 * W3: merge one branch into another inside a project's repository (F-10).
 *
 *   - fast-forward when the target is behind the source, else a merge commit;
 *   - the merge commit is made in a daemon-owned, detached, temporary worktree
 *     (`.worktrees/.merge-*`), so no checkout of the user or an agent is touched
 *     while git merges; it goes away whatever happens;
 *   - a conflict stops it: the conflicting files are listed, the temporary
 *     worktree is dropped, and no ref and no checkout changed;
 *   - up to date: the target must not be behind its upstream (the last fetched
 *     one: no network here), and it moves only from the commit the merge was
 *     made on (`update-ref` with the old value, or, when a checkout has the
 *     target, `merge --ff-only` there after checking its HEAD and that its
 *     tracked files are clean).
 *
 * Never a force, never a push, never history rewritten. The runner keeps the
 * repository's hooks, filters and merge drivers off (gitRun.ts). Callers
 * serialize per repository (RepoManager's queue); the policy (protected
 * branches, who may ask) is also the caller's: `protectedFor` says which.
 */
import * as fs from 'fs';
import * as path from 'path';

import { koText } from '../../../../../core/src/cld/serverText.js';
import type { GitRunner } from './gitRun.js';
import { filterOverrides, READ_ENV, RepoError } from './gitRun.js';
import { gitMessage, readStatus } from './repoRead.js';
import { protectedBranches, WORKTREES_DIR } from './worktrees.js';

const MERGE_TIMEOUT_MS = 120_000;
const CONFLICTS_MAX = 50;
/** A temporary merge worktree older than this is a leftover (a merge takes minutes at most). */
const STALE_MS = 60 * 60_000;

export interface MergeOutcome {
  ok: boolean;
  /** ff: the target moved to the source; merge: a merge commit; already: nothing to do. */
  kind?: 'ff' | 'merge' | 'already';
  /** The target's commit after. */
  sha?: string;
  /** A conflict: the files (at most 50), and nothing changed. */
  conflicts?: string[];
  /** A refusal's English word (`protected`, `stepup`, `behind`, `moved`, `dirty`, `conflict` ...). */
  code?: string;
  error?: string;
}

/** The protected branches of the repository at `top`: main, master, every remote's default, and
 *  the owner's own list for the project (`protected-branches.json`: { "<project>": ["name"] }).
 *  null: that file exists but cannot be read as such a list, so every branch counts as protected. */
export async function protectedFor(
  run: GitRunner,
  top: string,
  file: string,
  project: string,
): Promise<Set<string> | null> {
  const out = await protectedBranches(run, top);
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out;
    console.warn(`[cld repo] ${path.basename(file)}: not read, every branch protected (${String(err)})`);
    return null;
  }
  const list = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>)[project] : 0;
  if (list === undefined) return out;
  if (!Array.isArray(list) || !list.every((b) => typeof b === 'string')) {
    console.warn(`[cld repo] ${path.basename(file)}: not a list of names, every branch protected`);
    return null;
  }
  for (const b of list) if (b) out.add(b);
  return out;
}

const text = (b: Buffer) => b.toString('utf-8').trim();
const fail = (code: string, error: string): MergeOutcome => ({ ok: false, code, error });

async function sha(run: GitRunner, top: string, ref: string): Promise<string | null> {
  const r = await run(top, ['rev-parse', '--verify', '-q', `${ref}^{commit}`], { env: READ_ENV });
  return r.code === 0 ? text(r.stdout) : null;
}

async function isAncestor(run: GitRunner, top: string, a: string, b: string): Promise<boolean> {
  const r = await run(top, ['merge-base', '--is-ancestor', a, b], { env: READ_ENV });
  if (r.code !== 0 && r.code !== 1) throw new RepoError(koText('git_merge_base_failed', { why: gitMessage(r.stderr) }));
  return r.code === 0;
}

/** `branch` is being rebased or bisected in some checkout (detached there, so no checkout "has"
 *  it): its ref must not move under that, or `rebase --abort` drops the merge again. */
async function rebasing(run: GitRunner, top: string, branch: string): Promise<boolean> {
  const r = await run(top, ['rev-parse', '--git-common-dir'], { env: READ_ENV });
  if (r.code !== 0) throw new RepoError(koText('git_status_unreadable'));
  const common = path.resolve(top, text(r.stdout));
  let dirs = [common];
  try {
    dirs = dirs.concat(fs.readdirSync(path.join(common, 'worktrees')).map((d) => path.join(common, 'worktrees', d)));
  } catch {
    /* no linked worktree */
  }
  const names = [`refs/heads/${branch}`, branch];
  return dirs.some((d) =>
    ['rebase-merge/head-name', 'rebase-apply/head-name', 'BISECT_START'].some((f) => {
      try {
        return names.includes(fs.readFileSync(path.join(d, f), 'utf-8').trim());
      } catch {
        return false;
      }
    }),
  );
}

/** The checkout (path) that has `branch` checked out, if any. */
async function checkoutOf(run: GitRunner, top: string, branch: string): Promise<string | null> {
  const r = await run(top, ['worktree', 'list', '--porcelain'], { env: READ_ENV });
  if (r.code !== 0) throw new RepoError(koText('git_worktrees_unreadable'));
  let at: string | null = null;
  for (const line of text(r.stdout).split('\n')) {
    if (line.startsWith('worktree ')) at = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}`) return at;
  }
  return null;
}

/**
 * Merge local branch `source` into local branch `target` in the repository at `top` (its main
 * checkout). Throws only when git cannot run; refusals and conflicts are `ok: false`.
 */
export async function mergeBranches(
  run: GitRunner,
  top: string,
  source: string,
  target: string,
): Promise<MergeOutcome> {
  if (source === target) return fail('same', koText('merge_same'));
  const [src, old] = [await sha(run, top, `refs/heads/${source}`), await sha(run, top, `refs/heads/${target}`)];
  if (!src) return fail('no_branch', koText('branch_missing', { branch: source }));
  if (!old) return fail('no_branch', koText('branch_missing', { branch: target }));

  // Up to date: the target has every commit its upstream (as last fetched) has.
  const up = await run(top, ['for-each-ref', '--format=%(upstream)', `refs/heads/${target}`], { env: READ_ENV });
  const upstream = text(up.stdout);
  if (upstream && (await sha(run, top, upstream)) && !(await isAncestor(run, top, upstream, old)))
    return fail('behind', koText('merge_behind', { target, upstream: upstream.replace(/^refs\/remotes\//, '') }));

  if (await isAncestor(run, top, src, old)) return { ok: true, kind: 'already', sha: old };

  if (await rebasing(run, top, target))
    return fail('in_progress', koText('merge_in_progress', { target }));
  const checkout = await checkoutOf(run, top, target);
  if (checkout) {
    const st = await readStatus(run, checkout, Infinity);
    const tracked = st.files.filter((f) => f.worktree !== '?').length;
    if (tracked) return fail('dirty', koText('merge_dirty', { target, count: tracked }));
    // Its files would be written with the repository's own filters off (gitRun.ts): raw content
    // (git-crypt's ciphertext, a local LFS pointer) under a clean status. The owner merges that one.
    const f = await run(checkout, ['config', '--show-scope', '--includes', '--get-regexp', '^filter\\.'], { env: READ_ENV });
    if (f.code !== 0 && f.code !== 1) throw new RepoError(koText('git_config_unreadable'));
    if (filterOverrides(f.stdout.toString('utf-8')).length)
      return fail('filters', koText('merge_filters', { target }));
  }

  let kind: 'ff' | 'merge' = 'ff';
  let next = src;
  if (!(await isAncestor(run, top, old, src))) {
    kind = 'merge';
    const made = await mergeCommit(run, top, source, target, old, src);
    if (!made.ok) return made;
    next = made.sha!;
  }

  // Move the target only from `old` (someone may have moved it meanwhile).
  if (checkout) {
    if ((await sha(run, checkout, 'HEAD')) !== old) return fail('moved', koText('merge_moved', { target }));
    const ff = await run(checkout, ['merge', '--ff-only', '--no-stat', next], { timeoutMs: MERGE_TIMEOUT_MS });
    if (ff.code !== 0) return fail('git_failed', koText('merge_move_failed', { target, why: gitMessage(ff.stderr) }));
  } else {
    const r = await run(top, ['update-ref', '-m', `cld-gui: merge ${source}`, `refs/heads/${target}`, next, old]);
    if (r.code !== 0) return fail('moved', koText('merge_moved', { target }));
  }
  return { ok: true, kind, sha: next };
}

/** A merge commit of `src` onto `old` in a temporary detached worktree; nothing else changes. */
async function mergeCommit(
  run: GitRunner,
  top: string,
  source: string,
  target: string,
  old: string,
  src: string,
): Promise<MergeOutcome> {
  const dir = path.join(top, WORKTREES_DIR);
  // Made here only when no task worktree made it: then it goes again (the checkout as it was).
  const made = !fs.existsSync(dir) && !!fs.mkdirSync(dir, { recursive: true });
  if (!fs.lstatSync(dir).isDirectory()) throw new RepoError(koText('worktrees_not_dir', { dir: WORKTREES_DIR }));
  // A daemon stopped mid-merge left its temporary worktree: dropped once surely not live.
  for (const e of fs.readdirSync(dir)) {
    const old = path.join(dir, e);
    if (!e.startsWith('.merge-')) continue;
    const st = fs.lstatSync(old);
    // Never a link: `worktree remove` would follow it to whatever worktree it names.
    if (!st.isDirectory() || Date.now() - st.mtimeMs < STALE_MS) continue;
    await run(top, ['worktree', 'remove', '--force', old], { timeoutMs: MERGE_TIMEOUT_MS });
    fs.rmSync(old, { recursive: true, force: true });
  }
  const tmp = fs.mkdtempSync(path.join(dir, '.merge-'));
  // ponytail: a full checkout per merge commit; `merge-tree --write-tree` (git 2.38+) needs none.
  const add = await run(top, ['worktree', 'add', '--detach', tmp, old], { timeoutMs: MERGE_TIMEOUT_MS });
  try {
    if (add.code !== 0) throw new RepoError(koText('merge_prepare_failed', { why: gitMessage(add.stderr) }));
    const m = await run(
      tmp,
      ['-c', 'rerere.enabled=false', 'merge', '--no-ff', '--no-edit', '--no-stat', '--no-gpg-sign', '--no-verify',
        '-m', `Merge branch '${source}' into ${target}`, src],
      { timeoutMs: MERGE_TIMEOUT_MS },
    );
    if (m.code === 0) {
      const head = await sha(run, tmp, 'HEAD');
      return head ? { ok: true, sha: head } : fail('git_failed', koText('merge_commit_unreadable'));
    }
    const u = await run(tmp, ['diff', '--name-only', '--diff-filter=U', '-z'], { env: READ_ENV });
    const files = u.stdout.toString('utf-8').split('\0').filter(Boolean);
    if (!files.length) return fail('git_failed', koText('merge_failed', { why: gitMessage(m.stderr) }));
    const shown = files.slice(0, CONFLICTS_MAX);
    return {
      ...fail('conflict', koText('merge_conflict', {
          files: shown.join(', ') + (files.length > shown.length ? ` … +${files.length - shown.length}` : ''),
        })),
      conflicts: shown,
    };
  } finally {
    const rm = await run(top, ['worktree', 'remove', '--force', tmp], { timeoutMs: MERGE_TIMEOUT_MS });
    if (rm.code !== 0) {
      console.warn(`[cld repo] merge: temporary worktree not removed (${gitMessage(rm.stderr)})`);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    if (made)
      try {
        fs.rmdirSync(dir); // only when still empty
      } catch {
        /* something else is in it now */
      }
  }
}
