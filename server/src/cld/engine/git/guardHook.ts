/**
 * W5: a guard against slips in task worktrees. When a Task worktree is made, a small `pre-commit`
 * and `pre-push` hook goes into the repository's hooks folder; in a task worktree (a linked
 * worktree under `.worktrees/`) they refuse a commit on, or a push to, a protected branch (main,
 * master, a remote's default, the owner's list: merge.ts' protectedFor) and record the refusal
 * (`guard-refusals.log`, tab-separated: time, hook, branch, worktree). Everywhere else (the
 * owner's own checkout) they do nothing.
 *
 * This is a guard against mistakes, NOT a security boundary: `--no-verify` skips it and an agent
 * that can write `.git/hooks` can remove it (the refusal says so). The daemon's own git runs with
 * hooks off (gitRun.ts), so this never touches what the daemon does itself.
 *
 * Never overwrites a hook it did not write (it is left alone, with a note), and installs nothing
 * when the repository sets its own `core.hooksPath` (husky and such: that folder is not ours).
 * The protected list is embedded when the hook is (re)written, which is at each new worktree.
 */
import * as fs from 'fs';
import * as path from 'path';

import { koText } from '../../../../../core/src/cld/serverText.js';
import type { GitRunner } from './gitRun.js';
import { READ_ENV } from './gitRun.js';
import { protectedFor } from './merge.js';
import { protectedBranches } from './worktrees.js';

export const GUARD_MARK = '# cld-gui-guard v1';
export const GUARD_LOG = 'guard-refusals.log';
const HOOKS = ['pre-commit', 'pre-push'] as const;
const SAFE_NAME = /^[A-Za-z0-9._/-]{1,100}$/;
const LOG_KEEP = 200;

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The hook script `hook`, refusing the branches in `branches`, logging to `log`. */
export function guardScript(hook: (typeof HOOKS)[number], branches: Iterable<string>, log: string): string {
  const list = ` ${[...new Set(branches)].filter((b) => SAFE_NAME.test(b)).join(' ')} `;
  const check =
    hook === 'pre-commit'
      ? `b=$(git symbolic-ref --short -q HEAD) || exit 0
case "$PROTECTED" in *" "$b" "*) refuse "$b" ;; esac`
      : `while read -r lref lsha rref rsha; do
  case "$rref" in refs/heads/*) b=\${rref#refs/heads/}; case "$PROTECTED" in *" "$b" "*) refuse "$b" ;; esac ;; esac
done`;
  return `#!/bin/sh
${GUARD_MARK} (written by cld-gui; delete this file to turn it off)
# A guard against slips in task worktrees, not a security boundary: --no-verify skips it.
PROTECTED=${quote(list)}
LOG=${quote(log)}
[ "$(git rev-parse --git-dir 2>/dev/null)" != "$(git rev-parse --git-common-dir 2>/dev/null)" ] || exit 0
top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
case "$top" in */.worktrees/*) ;; *) exit 0 ;; esac
refuse() {
  printf '%s\\t%s\\t%s\\t%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" ${hook} "$1" "$top" >> "$LOG" 2>/dev/null
  if [ "$(wc -l < "$LOG" 2>/dev/null || echo 0)" -gt ${LOG_KEEP * 2} ]; then tail -n ${LOG_KEEP} "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi
  echo "cld-gui: '$1' 는 보호 브랜치라 여기서는 ${hook === 'pre-commit' ? '커밋' : 'push'}하지 않아요. 작업 브랜치(task/...)에서 하고, 병합은 작업실에서 해 주세요." >&2
  echo "cld-gui: '$1' is a protected branch. This hook is a guard against mistakes, not a security boundary." >&2
  exit 1
}
${check}
exit 0
`;
}

export type GuardState = 'ours' | 'none' | 'user';

export interface GuardStatus {
  /** The repository sets its own hooks folder: nothing is installed. */
  hooksPath: boolean;
  hooks: Record<(typeof HOOKS)[number], GuardState>;
  dir: string;
}

async function hooksDir(run: GitRunner, top: string): Promise<{ dir: string; hooksPath: boolean }> {
  // The runner's own override (command scope) is not the repository's setting.
  const own = await run(top, ['config', '--show-scope', '--get-all', 'core.hooksPath'], { env: READ_ENV });
  const hooksPath = own.stdout
    .toString('utf-8')
    .split('\n')
    .some((l) => l && !l.startsWith('command\t'));
  const c = await run(top, ['rev-parse', '--git-common-dir'], { env: READ_ENV });
  return { dir: path.join(path.resolve(top, c.stdout.toString('utf-8').trim()), 'hooks'), hooksPath };
}

function stateOf(file: string): GuardState {
  try {
    if (!fs.lstatSync(file).isFile()) return 'user';
    return fs.readFileSync(file, 'utf-8').includes(GUARD_MARK) ? 'ours' : 'user';
  } catch {
    return 'none';
  }
}

export async function guardStatus(run: GitRunner, top: string): Promise<GuardStatus> {
  const { dir, hooksPath } = await hooksDir(run, top);
  return { hooksPath, dir, hooks: { 'pre-commit': stateOf(path.join(dir, 'pre-commit')), 'pre-push': stateOf(path.join(dir, 'pre-push')) } };
}

/** What the guard is doing for this repository, in a Korean line. */
export function guardNote(s: GuardStatus): string {
  if (s.hooksPath) return koText('guard_own_hooks');
  const on = HOOKS.filter((h) => s.hooks[h] === 'ours');
  const user = HOOKS.filter((h) => s.hooks[h] === 'user');
  const base = on.length
    ? koText('guard_on', { hooks: on.join(', ') })
    : koText('guard_none');
  return user.length ? koText('guard_user', { base, hooks: user.join(', ') }) : base;
}

/**
 * Write the guard hooks for the repository at `top` (its main checkout): ours are rewritten with the
 * current protected list, a hook of the user's is left alone. Never throws: the note says what
 * happened.
 */
export async function installGuard(run: GitRunner, top: string, configDir: string, project: string): Promise<string> {
  try {
    const st = await guardStatus(run, top);
    if (!st.hooksPath) {
      const names = (await protectedFor(run, top, path.join(configDir, 'protected-branches.json'), project)) ?? (await protectedBranches(run, top));
      fs.mkdirSync(st.dir, { recursive: true });
      for (const h of HOOKS) {
        if (st.hooks[h] === 'user') continue;
        const file = path.join(st.dir, h);
        const tmp = `${file}.cld-${process.pid}.tmp`;
        fs.writeFileSync(tmp, guardScript(h, names, path.join(configDir, GUARD_LOG)), { mode: 0o755 });
        fs.renameSync(tmp, file);
        st.hooks[h] = 'ours';
      }
    }
    return guardNote(st);
  } catch (err) {
    console.warn(`[cld repo] guard hook not installed: ${String(err)}`);
    return koText('guard_failed');
  }
}
