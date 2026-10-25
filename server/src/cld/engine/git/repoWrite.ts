/**
 * The git writes a project card may ask for (FR-ENG-005): stage, unstage,
 * commit and push. W2 (N7): the owner's confirmed commit and push run the
 * repository's hooks (and filters) as their own terminal would; everything else
 * the daemon runs has them off (gitRun.ts). Each takes the status read just before it, so a path is
 * only ever one of that status's own entries. Never `--force`, never a `+`
 * refspec, never another remote than the branch's tracked one, never a write
 * to git's config. Failures are RepoErrors in Korean.
 */
import { koText } from '../../../../../core/src/cld/serverText.js';
import type { GitResult, GitRunner } from './gitRun.js';
import { LITERAL_ENV, READ_ENV, RepoError } from './gitRun.js';
import type { ParsedStatus } from './repoRead.js';
import { gitMessage, isStaged, isUnstaged } from './repoRead.js';

export const MAX_PATHS = 100;
export const COMMIT_MESSAGE_MAX = 10_000;
const COMMIT_TIMEOUT_MS = 60_000;
const PUSH_TIMEOUT_MS = 90_000;

export interface WriteOutcome {
  /** A short Korean note for the result toast. */
  detail?: string;
}

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * `git add` / `git reset` (unstage) of the given status entries, or of all of
 * them when `paths` is empty. Selecting a rename takes its old path along.
 */
export async function stagePaths(
  run: GitRunner,
  top: string,
  status: ParsedStatus,
  paths: string[] | undefined,
  unstage: boolean,
): Promise<WriteOutcome> {
  const pool = status.files.filter(unstage ? isStaged : isUnstaged);
  let args: string[];
  let count: number;
  if (!paths?.length) {
    if (!pool.length)
      throw new RepoError(unstage ? koText('nothing_staged') : koText('nothing_to_stage'));
    // `reset -- .` (a pathspec) leaves merge/rebase state alone, a bare `reset` would not.
    args = unstage ? ['reset', '-q', '--', '.'] : ['add', '-A'];
    count = pool.length;
  } else {
    if (paths.length > MAX_PATHS) {
      throw new RepoError(koText('stage_too_many', { max: MAX_PATHS }));
    }
    const picked = new Set<string>();
    for (const p of paths) {
      const file = pool.find((f) => f.path === p);
      if (!file) {
        throw new RepoError(
          koText(unstage ? 'file_not_staged' : 'file_not_stageable', { file: clip(p) }),
        );
      }
      picked.add(file.path);
      if (file.origPath) picked.add(file.origPath);
    }
    args = unstage ? ['reset', '-q', '--', ...picked] : ['add', '--', ...picked];
    count = new Set(paths).size;
  }
  const r = await run(top, args, { env: LITERAL_ENV });
  if (r.code !== 0) {
    throw new RepoError(
      koText(unstage ? 'unstage_failed' : 'stage_failed', { why: explainLock(r) ?? gitMessage(r.stderr) }),
    );
  }
  return { detail: koText('stage_done', { count }) };
}

/** git's index lock, in Korean; else undefined. */
function explainLock(r: GitResult): string | undefined {
  return /index\.lock|another git process/i.test(r.stderr)
    ? koText('git_busy')
    : undefined;
}

function explainCommit(r: GitResult): string {
  const s = r.stderr;
  if (r.timedOut) return koText('commit_timeout');
  if (/nothing (added )?to commit|no changes added/i.test(s)) return koText('commit_nothing');
  if (/who you are|unable to auto-detect|empty ident/i.test(s)) {
    return koText('git_no_identity');
  }
  if (/unmerged files|unresolved conflict/i.test(s)) return koText('commit_conflicts');
  const lock = explainLock(r);
  if (lock) return lock;
  if (/gpg failed|failed to sign|signing failed/i.test(s)) {
    return koText('commit_sign_failed', { why: gitMessage(s) });
  }
  // A failing hook says nothing of its own: its output is the reason.
  const last = s.split('\n').filter(Boolean).at(-1) ?? '';
  return koText('commit_failed', { why: clip(last.replace(/^(fatal|error): /, ''), 200) });
}

/** `git commit -m <message>` of what is staged (never `-a`). */
export async function commit(
  run: GitRunner,
  top: string,
  status: ParsedStatus,
  message: string,
): Promise<WriteOutcome> {
  const text = message.replace(/\r\n?/g, '\n').trim();
  if (!text) throw new RepoError(koText('commit_message_needed'));
  if (text.length > COMMIT_MESSAGE_MAX || text.includes('\0')) {
    throw new RepoError(koText('commit_message_invalid'));
  }
  if (!status.files.some(isStaged)) throw new RepoError(koText('nothing_staged'));
  // `-m` takes the next argument whatever it starts with.
  // W2 (N7): the owner's confirmed commit runs the repository's hooks, as in their terminal.
  const r = await run(top, ['commit', '-m', text], { timeoutMs: COMMIT_TIMEOUT_MS, repoHooks: true });
  if (r.code !== 0) throw new RepoError(explainCommit(r));
  const head = await run(top, ['rev-parse', '--short', 'HEAD'], { env: READ_ENV });
  return {
    ...(head.code === 0 ? { detail: head.stdout.toString('utf-8').trim() } : {}),
  };
}

function explainPush(r: GitResult): string {
  const s = r.stderr;
  if (r.timedOut) return koText('push_timeout');
  if (/\[rejected\]|non-fast-forward|fetch first|stale info/i.test(s)) {
    return koText('push_rejected');
  }
  if (
    /authentication failed|could not read (username|password)|permission denied|terminal prompts disabled|publickey|\b40[13]\b/i.test(
      s,
    )
  ) {
    return koText('push_auth');
  }
  if (
    /could not resolve host|unable to access|connection (refused|timed out)|could not read from remote|does not appear to be a git repository/i.test(
      s,
    )
  ) {
    return koText('push_no_remote');
  }
  const last = s.split('\n').filter(Boolean).at(-1) ?? '';
  return koText('push_failed', { why: clip(last.replace(/^(fatal|error): /, ''), 200) });
}

async function configValue(run: GitRunner, top: string, key: string): Promise<string> {
  const r = await run(top, ['config', '--get', key], { env: READ_ENV });
  return r.code === 0 ? r.stdout.toString('utf-8').trim() : '';
}

/**
 * Push the current branch to the branch it tracks, on the remote it tracks:
 * `git push <remote> refs/heads/<branch>:<tracked ref>`. Nothing else is
 * pushed (no force, tags or submodules, whatever the user's config says).
 */
export async function push(
  run: GitRunner,
  top: string,
  status: ParsedStatus,
): Promise<WriteOutcome> {
  if (!status.branch) throw new RepoError(koText('push_detached'));
  if (!status.upstream) {
    throw new RepoError(
      koText('push_no_upstream'),
    );
  }
  if (!status.ahead) throw new RepoError(koText('push_nothing'));
  const remote = await configValue(run, top, `branch.${status.branch}.remote`);
  const tracked = await configValue(run, top, `branch.${status.branch}.merge`);
  // A remote of `.` tracks a local branch; and nothing odd may reach the command line.
  if (!remote || remote === '.' || remote.startsWith('-') || /[\s\0:]/.test(remote)) {
    throw new RepoError(koText('push_remote_unknown'));
  }
  if (!/^refs\/heads\/[^\s\0:]+$/.test(tracked))
    throw new RepoError(koText('push_branch_unknown'));
  const r = await run(
    top,
    [
      'push',
      '--no-follow-tags',
      '--recurse-submodules=no',
      remote,
      `refs/heads/${status.branch}:${tracked}`,
    ],
    // W2 (N7): pre-push runs (git-lfs uploads its objects there), as in the owner's terminal.
    { timeoutMs: PUSH_TIMEOUT_MS, repoHooks: true },
  );
  if (r.code !== 0) throw new RepoError(explainPush(r));
  return { detail: koText('push_done', { upstream: status.upstream, count: status.ahead }) };
}
