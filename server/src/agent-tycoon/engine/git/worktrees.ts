/**
 * Task worktrees (FR-ENG-003): one `git worktree` per task under the
 * project's `.worktrees/<task>`, on branch `task/<task>` started from the
 * branch the project is on. Jobs and Codex (E2, E4) call `create`; the UI
 * lists them and removes them. Every worktree the daemon makes is recorded in
 * `worktrees.json` (project, task, path, branch, base, created, status);
 * the record names what is ours. Its path is used only when git has that folder registered as a
 * worktree inside the project's repository and named after the task (one made from inside another
 * worktree, `.worktrees/integ/.worktrees/<task>`); else it is rebuilt from the project folder and
 * the task name (folderOf).
 *
 * Removal never loses work quietly: `git worktree remove` without --force
 * unless the caller says the user confirmed, and the branch goes only when it
 * is merged into its base (`git branch -d`).
 *
 * Names (branchName.ts): a branch is `<type>/<scope>-<what>` and its folder the same with `/` as `-`;
 * records made before 2026-11 have `task/<name>` branches and plain folders, and keep them (a record
 * holds both names, so nothing derives one from the other).
 *
 * W2: a Task's worktree (`createForTask`): `.worktrees/feat-t0042-<slug>` on
 * branch `feat/t0042-<slug>` (lower case) from the project's main branch
 * or a named one, its record carrying `taskId`, `assignmentId` (who it is
 * given to), `createdBy` and `assignedAt`. Older records have none of these
 * and are read and written back as they are.
 */
import * as fs from 'fs';
import * as path from 'path';

import { koText, refused } from '../../../../../core/src/agent-tycoon/serverText.js';
import type { RepoWorktree } from '../../../../../core/src/messages.js';
import { checkBranchName, folderOfBranch, MAX_BRANCH_NAME, taskBranch, uniqueBranch } from './branchName.js';
import type { GitRunner } from './gitRun.js';
import { READ_ENV, RepoError } from './gitRun.js';
import type { ProjectFolder } from './repoRead.js';
import { gitMessage, readStatus, repoRoot } from './repoRead.js';
import type { WorktreeSpec } from './worktreeRead.js';

/** A worktree folder name: a branch with its `/` turned into `-` (or an older plain task name). */
export const TASK_PATTERN = new RegExp(`^[a-z0-9][a-z0-9-]{0,${MAX_BRANCH_NAME - 1}}$`);
export const WORKTREES_DIR = '.worktrees';
/** Anchored: only the project's own folder, matched in `.git/info/exclude`. */
const EXCLUDE_LINE = `/${WORKTREES_DIR}/`;
const WORKTREE_TIMEOUT_MS = 60_000;
const KEEP_REMOVED = 100;
const FULL_SHA = /^[0-9a-f]{40}$/;

export interface WorktreeRecord {
  project: string;
  task: string;
  path: string;
  branch: string;
  /** The branch the task started from, or its commit when HEAD was detached. */
  base: string;
  created: string;
  status: 'active' | 'removed';
  /** W2: the Task (D6 id) this worktree is for. */
  taskId?: string;
  /** W2: the assignment (a Worker's or the Lead's) it is given to. */
  assignmentId?: string;
  /** W2: who made it (`user`, `cli`, `agent:<name>`). */
  createdBy?: string;
  /** W2: when it was given to `assignmentId`. */
  assignedAt?: string;
}

export interface CleanupResult {
  ok: boolean;
  error?: string;
  /** Refused only because it would lose uncommitted or unmerged work. */
  needsForce?: boolean;
  branchDeleted?: boolean;
  detail?: string;
}

/** What the record says plus what git says now. */
interface Inspected extends RepoWorktree {
  dirExists: boolean;
  registered: boolean;
  branchOk: boolean;
  baseOk: boolean;
}

const isRecord = (r: unknown): r is WorktreeRecord => {
  const o = r as Record<string, unknown> | null;
  return (
    typeof o === 'object' &&
    o !== null &&
    ['project', 'task', 'path', 'branch', 'base', 'created'].every(
      (k) => typeof o[k] === 'string',
    ) &&
    (o.status === 'active' || o.status === 'removed')
  );
};

/** The records; a missing file is empty, a broken one is moved aside and read as empty. */
export function readRecords(file: string): WorktreeRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  try {
    const data: unknown = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error('not an array');
    return data.filter(isRecord);
  } catch {
    console.warn(`[agty repo] ${path.basename(file)} is not valid; moved aside, starting empty`);
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      /* gone already */
    }
    return [];
  }
}

function writeRecords(file: string, records: WorktreeRecord[]): void {
  const removed = records.filter((r) => r.status === 'removed');
  const keep = new Set(removed.slice(-KEEP_REMOVED));
  const out = records.filter((r) => r.status === 'active' || keep.has(r));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export const worktreePath = (top: string, task: string): string =>
  path.join(top, WORKTREES_DIR, task);

/** Something is there, also a broken link. */
const lexists = (p: string): boolean => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

const realOrSame = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

/** `git worktree list --porcelain`'s entries: the folder, its branch (null: detached), bare, prunable. */
export function parseWorktreeList(text: string): Array<{ path: string; branch: string | null; bare: boolean; prunable: boolean }> {
  const out: Array<{ path: string; branch: string | null; bare: boolean; prunable: boolean }> = [];
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n');
    const head = lines.find((l) => l.startsWith('worktree '));
    if (!head) continue;
    const b = lines.find((l) => l.startsWith('branch refs/heads/'));
    out.push({
      path: head.slice('worktree '.length),
      branch: b ? b.slice('branch refs/heads/'.length) : null,
      bare: lines.includes('bare'),
      prunable: lines.some((l) => l === 'prunable' || l.startsWith('prunable ')),
    });
  }
  return out;
}

/** The real paths of the repository's worktrees (`git worktree list --porcelain`). */
async function registeredWorktrees(run: GitRunner, top: string): Promise<Set<string>> {
  const r = await run(top, ['worktree', 'list', '--porcelain'], { env: READ_ENV });
  const out = new Set<string>();
  if (r.code !== 0) return out;
  for (const line of r.stdout.toString('utf-8').split('\n')) {
    if (line.startsWith('worktree ')) out.add(realOrSame(line.slice('worktree '.length)));
  }
  return out;
}

/**
 * Where record `rec` lives: its recorded folder when git has it registered inside the repository's
 * folder `top` under the task's own name (made from inside another worktree), else the folder
 * rebuilt from the project and the task name.
 */
export function folderOf(top: string, rec: Pick<WorktreeRecord, 'path' | 'task'>, registered: Set<string>): string {
  const p = path.resolve(rec.path);
  const inside = p.startsWith(top + path.sep) && path.basename(p) === rec.task;
  return inside && registered.has(realOrSame(p)) ? p : worktreePath(top, rec.task);
}

async function commitExists(run: GitRunner, top: string, ref: string): Promise<boolean> {
  const r = await run(top, ['rev-parse', '--verify', '-q', `${ref}^{commit}`], { env: READ_ENV });
  return r.code === 0;
}

/** A Task id as the Task store writes it (tasks.ts ID_RE). */
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;
/** A base branch given by name: plain characters only, never an option or a ref expression. */
const BASE_RE = /^(?![-./])(?!.*\.\.)(?!.*\/\/)(?!.*[./]$)(?!.*\.lock$)[A-Za-z0-9._/-]{1,200}$/;

/** The branches a worktree must never be (F-10): main, master and every remote's default. */
export async function protectedBranches(run: GitRunner, top: string): Promise<Set<string>> {
  const out = new Set(['main', 'master']);
  const r = await run(top, ['for-each-ref', '--format=%(symref)', 'refs/remotes/*/HEAD'], { env: READ_ENV });
  if (r.code === 0)
    for (const line of r.stdout.toString('utf-8').split('\n')) {
      const m = /^refs\/remotes\/[^/]+\/(.+)$/.exec(line.trim());
      if (m) out.add(m[1]);
    }
  return out;
}

/** The project's main branch: a remote's default, else main, else master, else the branch it is on. */
async function mainBranch(run: GitRunner, top: string): Promise<string | null> {
  const has = (b: string) => commitExists(run, top, `refs/heads/${b}`);
  const r = await run(top, ['for-each-ref', '--format=%(symref)', 'refs/remotes/origin/HEAD'], { env: READ_ENV });
  const remote = /^refs\/remotes\/origin\/(.+)$/.exec(r.stdout.toString('utf-8').trim())?.[1];
  for (const b of [remote, 'main', 'master']) if (b && (await has(b))) return b;
  const on = await run(top, ['symbolic-ref', '--short', '-q', 'HEAD'], { env: READ_ENV });
  const current = on.code === 0 ? on.stdout.toString('utf-8').trim() : '';
  return current && (await has(current)) ? current : null;
}

const OPERATIONS: Array<[string, string]> = [
  ['MERGE_HEAD', 'merge'],
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase(am)'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_LOG', 'bisect'],
];

/** The git operation the checkout at `top` is in the middle of (its name), or null. */
export async function operationInProgress(run: GitRunner, top: string): Promise<string | null> {
  const r = await run(top, ['rev-parse', ...OPERATIONS.flatMap(([f]) => ['--git-path', f])], { env: READ_ENV });
  if (r.code !== 0) throw new RepoError(koText('git_status_unreadable'));
  const paths = r.stdout.toString('utf-8').split('\n').filter(Boolean);
  const at = paths.findIndex((p) => lexists(path.resolve(top, p)));
  return at < 0 ? null : (OPERATIONS[at]?.[1] ?? 'git operation');
}

export interface TaskWorktreeOptions {
  taskId: string;
  /** Default: from `title`. */
  slug?: string;
  title?: string;
  /** A local branch to start from; default the project's main branch. */
  base?: string;
  /** DV4 (새 워크트리): the branch the owner named (branchName.ts rules), instead of the Task's
   *  `feat/t<id>-<slug>`; one that exists is refused, never taken over. */
  branch?: string;
  assignmentId?: string;
  createdBy: string;
}

export interface WorktreesOptions {
  /** ~/.config/agent-tycoon/worktrees.json */
  file: string;
  run: GitRunner;
  log?: (line: string) => void;
  now?: () => Date;
  /** W5: called with the repository's top folder and the project's name once a worktree exists
   *  (the protected-branch guard hook); must not throw. */
  guard?: (top: string, project: string) => Promise<unknown>;
}

export class Worktrees {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: WorktreesOptions) {}

  /** One change at a time: the records file is read, changed and written back. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private log(line: string): void {
    (this.o.log ?? console.log)(`[agty repo] worktree ${line}`);
  }

  /**
   * new(project, name): from the current branch, `git worktree add <folder>/.worktrees/<dir> -b <branch>`:
   * a `name` with a `/` is a branch (`feat/iso-billboard`, checked by branchName.ts; a repeat gets
   * `-2`, `-3`) in the folder `feat-iso-billboard`; a plain `name` is the older folder with
   * branch `task/<name>`. `.worktrees/` kept out of the project's
   * tracked files (its `.git/info/exclude`), and the record written.
   * Throws a RepoError (Korean) when it cannot.
   */
  async create(
    project: ProjectFolder,
    task: string,
    /** W2: a Codex Worker's run for a Task (D5) records whose worktree it is. */
    meta: Pick<WorktreeRecord, 'taskId' | 'assignmentId' | 'createdBy'> = {},
  ): Promise<WorktreeRecord> {
    const isBranch = task.includes('/');
    const bad = isBranch ? checkBranchName(task) : TASK_PATTERN.test(task) ? null : koText('worktree_name_rule');
    if (bad) throw new RepoError(bad, 'bad_name');
    return this.serial(async () => {
      const { run } = this.o;
      const top = await repoRoot(run, project.folder);
      const head = await run(top, ['rev-parse', '--verify', '-q', 'HEAD'], { env: READ_ENV });
      if (head.code !== 0) throw new RepoError(koText('worktree_no_commit'));
      const onBranch = await run(top, ['symbolic-ref', '--short', '-q', 'HEAD'], {
        env: READ_ENV,
      });
      const base =
        onBranch.code === 0
          ? onBranch.stdout.toString('utf-8').trim()
          : head.stdout.toString('utf-8').trim();
      const at = (this.o.now?.() ?? new Date()).toISOString();
      const branch = isBranch
        ? await uniqueBranch(task, (b) => this.taken(project, top, b))
        : `task/${task}`;
      return this.add(project, top, isBranch ? folderOfBranch(branch) : task, branch, base, null, {
        ...(meta.taskId && { taskId: meta.taskId }),
        ...(meta.createdBy && { createdBy: meta.createdBy }),
        ...(meta.assignmentId && { assignmentId: meta.assignmentId, assignedAt: at }),
      });
    });
  }

  /**
   * W2: Task `taskId`'s worktree: `.worktrees/feat-t0042-<slug>` on `feat/t0042-<slug>`
   * (branchName.ts) from the project's main branch (or `base`), recorded with the Task and who it is given to. Refused
   * (a RepoError, nothing made) for an unsafe name or base, a Task that has one, a protected
   * branch as the target, a checkout in the middle of a merge or rebase, and whatever create refuses.
   */
  async createForTask(project: ProjectFolder, o: TaskWorktreeOptions): Promise<WorktreeRecord> {
    if (!TASK_ID_RE.test(o.taskId)) throw new RepoError(koText('task_id_invalid'), 'bad_name');
    const branch = o.branch ?? taskBranch(o.taskId, o.title, o.slug);
    const task = this.named(branch, o.base, o.branch !== undefined);
    return this.serial(async () => {
      const top = await repoRoot(this.o.run, project.folder);
      const had = readRecords(this.o.file).find(
        (r) => r.project === project.name && r.taskId === o.taskId && r.status === 'active',
      );
      if (had) throw new RepoError(koText('task_has_worktree', { task: o.taskId, dir: WORKTREES_DIR, name: had.task }), 'exists');
      const base = await this.ready(project, top, branch, o.base, o.branch !== undefined);
      const at = (this.o.now?.() ?? new Date()).toISOString();
      return this.add(project, top, task, branch, base, `refs/heads/${base}`, {
        taskId: o.taskId,
        createdBy: o.createdBy,
        ...(o.assignmentId && { assignmentId: o.assignmentId, assignedAt: at }),
      });
    });
  }

  /**
   * DV4: what createForTask would refuse for the owner's `branch` from `base` (a RepoError), checked
   * before its Task is made so a refusal leaves nothing behind. Resolves to the base it would use.
   */
  check(project: ProjectFolder, branch: string, base?: string): Promise<string> {
    this.named(branch, base, true);
    return this.serial(async () => this.ready(project, await repoRoot(this.o.run, project.folder), branch, base, true));
  }

  /** The folder of a Task branch, or a RepoError for an unsafe branch or base name. */
  private named(branch: string, base: string | undefined, owner: boolean): string {
    if (base !== undefined && !BASE_RE.test(base))
      throw new RepoError(koText('base_name_invalid', { name: base.slice(0, 60) }), 'bad_name');
    const why = checkBranchName(branch);
    const task = folderOfBranch(branch);
    if (why || !TASK_PATTERN.test(task)) throw new RepoError(owner && why ? why : koText('worktree_name_failed'), 'bad_name');
    return task;
  }

  /** createForTask's checks on the repository (inside serial): the base, a protected target, a
   *  merge or rebase in progress, a `.worktrees` that is not a folder and, for a branch the owner
   *  named, one that exists. */
  private async ready(project: ProjectFolder, top: string, branch: string, want: string | undefined, owner: boolean): Promise<string> {
    const { run } = this.o;
    const base = want ?? (await mainBranch(run, top));
    if (!base) throw new RepoError(koText('base_not_found'), 'no_base');
    if (!(await commitExists(run, top, `refs/heads/${base}`)))
      throw new RepoError(koText('base_missing', { branch: base }), 'no_base');
    if ((await protectedBranches(run, top)).has(branch))
      throw new RepoError(koText('worktree_protected', { branch }), 'protected');
    const busy = await operationInProgress(run, top);
    if (busy) throw new RepoError(koText('repo_busy', { operation: busy }), 'in_progress');
    if (owner && (await this.taken(project, top, branch))) throw new RepoError(koText('branch_exists', { branch }), 'exists');
    // `.worktrees` must be a real folder inside the project (add() checks it again).
    const dir = path.join(top, WORKTREES_DIR);
    if (lexists(dir) && !fs.lstatSync(dir).isDirectory()) throw new RepoError(koText('worktrees_not_dir', { dir: WORKTREES_DIR }));
    return base;
  }

  /** `branch` (or its folder) is already a worktree of the project, a folder on disk or a git branch. */
  private async taken(project: ProjectFolder, top: string, branch: string): Promise<boolean> {
    const dir = folderOfBranch(branch);
    return (
      readRecords(this.o.file).some((r) => r.project === project.name && r.status === 'active' && (r.task === dir || r.branch === branch)) ||
      lexists(worktreePath(top, dir)) ||
      (await commitExists(this.o.run, top, `refs/heads/${branch}`))
    );
  }

  /** The checks and the `git worktree add` both kinds share; inside serial(). `start` null: HEAD. */
  private async add(
    project: ProjectFolder,
    top: string,
    task: string,
    branch: string,
    base: string,
    start: string | null,
    extra: Partial<WorktreeRecord>,
  ): Promise<WorktreeRecord> {
    const { run } = this.o;
    const records = readRecords(this.o.file);
    if (
      records.some((r) => r.project === project.name && r.task === task && r.status === 'active')
    ) {
      throw new RepoError(koText('worktree_exists', { task }), 'exists');
    }
    // `.worktrees` must be a real folder inside the project, not a link out of it.
    const dir = path.join(top, WORKTREES_DIR);
    if (lexists(dir) && !fs.lstatSync(dir).isDirectory()) {
      throw new RepoError(koText('worktrees_not_dir', { dir: WORKTREES_DIR }));
    }
    const wt = worktreePath(top, task);
    const record = (): WorktreeRecord => ({
      project: project.name,
      task,
      path: wt,
      branch,
      base,
      created: (this.o.now?.() ?? new Date()).toISOString(),
      status: 'active',
      ...extra,
    });
    const folderThere = lexists(wt);
    const branchThere = await commitExists(run, top, `refs/heads/${branch}`);
    if (folderThere || branchThere) {
      // What an earlier call made before it died (no record): taken over when it is exactly that.
      if (folderThere && branchThere && (await this.orphan(top, wt, branch, start ?? 'HEAD'))) {
        const rec = record();
        writeRecords(this.o.file, [...records, rec]);
        await this.o.guard?.(top, project.name);
        this.log(`adopt ${JSON.stringify(project.name)} ${task}: ok`);
        return rec;
      }
      if (folderThere) throw new RepoError(koText('worktree_folder_exists', { dir: WORKTREES_DIR, name: task }), 'exists');
      throw new RepoError(koText('branch_exists', { branch }), 'exists');
    }
    const from = await run(top, ['rev-parse', '--verify', '-q', `${start ?? 'HEAD'}^{commit}`], { env: READ_ENV });
    const sha = from.stdout.toString('utf-8').trim();

    await this.ensureIgnored(top);
    const add = await run(top, ['worktree', 'add', wt, '-b', branch, ...(start ? [start] : [])], {
      timeoutMs: WORKTREE_TIMEOUT_MS,
    });
    if (add.code !== 0) {
      // A failed add (a timeout, a checkout filter that fails) may have left the branch or half a
      // worktree: what this call made goes again (nothing was there before it).
      await this.undo(top, wt, branch, sha);
      throw new RepoError(koText('worktree_make_failed', { why: add.timedOut ? koText('timed_out') : gitMessage(add.stderr) }));
    }
    await this.o.guard?.(top, project.name);
    const rec = record();
    try {
      writeRecords(this.o.file, [...records, rec]);
    } catch (err) {
      // No record, no worktree: one the daemon cannot name is one nobody can remove from the screen.
      await this.undo(top, wt, branch, sha);
      this.log(`new ${JSON.stringify(project.name)} ${task}: record not written (${String(err)}), undone`);
      throw new RepoError(koText('worktree_record_failed'));
    }
    this.log(`new ${JSON.stringify(project.name)} ${task}: ok`);
    return rec;
  }

  /**
   * `wt` on `branch` is exactly what this call would make, left without a record: a registered
   * worktree of this repository, checked out on that branch, clean, with no commit `start` lacks.
   */
  private async orphan(top: string, wt: string, branch: string, start: string): Promise<boolean> {
    const { run } = this.o;
    if (!(await registeredWorktrees(run, top)).has(realOrSame(wt))) return false;
    const on = await run(wt, ['symbolic-ref', '-q', 'HEAD'], { env: READ_ENV });
    if (on.code !== 0 || on.stdout.toString('utf-8').trim() !== `refs/heads/${branch}`) return false;
    const ahead = await run(top, ['rev-list', '--count', `${start}..refs/heads/${branch}`], { env: READ_ENV });
    if (ahead.code !== 0 || ahead.stdout.toString('utf-8').trim() !== '0') return false;
    try {
      return (await readStatus(run, wt)).files.length === 0;
    } catch {
      return false;
    }
  }

  /** Take back what one call made: its worktree, and its branch while it is still at `sha`. */
  private async undo(top: string, wt: string, branch: string, sha: string): Promise<void> {
    const { run } = this.o;
    if ((await registeredWorktrees(run, top)).has(realOrSame(wt)))
      await run(top, ['worktree', 'remove', '--force', wt], { timeoutMs: WORKTREE_TIMEOUT_MS });
    const tip = await run(top, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { env: READ_ENV });
    if (sha && tip.code === 0 && tip.stdout.toString('utf-8').trim() === sha)
      await run(top, ['branch', '-D', branch]);
  }

  /**
   * P4 직접 풀기 / 에이전트에게 맡기기 on an active record whose folder is gone but whose branch is
   * kept (an old Codex run's): the folder is checked out again at `.worktrees/<task>` on the same
   * branch (`git worktree add`, never --force) and the record points at it. A folder that is there
   * is left as it is. Throws a RepoError when it cannot.
   */
  async reopen(project: ProjectFolder, task: string): Promise<void> {
    return this.serial(async () => {
      const { run } = this.o;
      const top = await repoRoot(run, project.folder);
      const records = readRecords(this.o.file);
      const rec = records.find((r) => r.project === project.name && r.task === task && r.status === 'active');
      if (!rec) throw new RepoError(koText('worktree_missing'));
      const st = await this.inspect(top, rec, await registeredWorktrees(run, top));
      if (st.exists) return;
      if (!st.branchOk) throw new RepoError(koText('worktree_missing'));
      const wt = worktreePath(top, task);
      if (lexists(wt)) throw new RepoError(koText('worktree_folder_exists', { dir: WORKTREES_DIR, name: task }), 'exists');
      await this.ensureIgnored(top);
      const add = await run(top, ['worktree', 'add', wt, rec.branch], { timeoutMs: WORKTREE_TIMEOUT_MS });
      if (add.code !== 0)
        throw new RepoError(koText('worktree_make_failed', { why: add.timedOut ? koText('timed_out') : gitMessage(add.stderr) }));
      await this.o.guard?.(top, project.name);
      writeRecords(this.o.file, records.map((r) => (r === rec ? { ...r, path: wt } : r)));
      this.log(`reopen ${JSON.stringify(project.name)} ${task}: ok`);
    });
  }

  /** W2: every record (active and the last removed ones). */
  all(): WorktreeRecord[] {
    return readRecords(this.o.file);
  }

  /** W2: the project's active worktree of Task `taskId`. */
  forTask(project: string, taskId: string): WorktreeRecord | undefined {
    return readRecords(this.o.file).find(
      (r) => r.project === project && r.taskId === taskId && r.status === 'active',
    );
  }

  /** W2: the worktree last given to `assignmentId` (active, else the last removed one). */
  assignedTo(assignmentId: string): WorktreeRecord | undefined {
    const mine = readRecords(this.o.file).filter((r) => r.assignmentId === assignmentId);
    const when = (r: WorktreeRecord) => r.assignedAt ?? r.created;
    const newest = (list: WorktreeRecord[]) =>
      list.reduce<WorktreeRecord | undefined>((a, r) => (!a || when(r) >= when(a) ? r : a), undefined);
    return newest(mine.filter((r) => r.status === 'active')) ?? newest(mine);
  }

  /** W2: give the active worktree `task` to `assignmentId` (null: to nobody). */
  async assign(project: ProjectFolder, task: string, assignmentId: string | null): Promise<WorktreeRecord> {
    return this.serial(async () => {
      const records = readRecords(this.o.file);
      const rec = records.find((r) => r.project === project.name && r.task === task && r.status === 'active');
      if (!rec) throw new RepoError(koText('worktree_missing'));
      const { assignmentId: _a, assignedAt: _t, ...rest } = rec;
      const next: WorktreeRecord = assignmentId
        ? { ...rest, assignmentId, assignedAt: (this.o.now?.() ?? new Date()).toISOString() }
        : rest;
      writeRecords(this.o.file, records.map((r) => (r === rec ? next : r)));
      this.log(`assign ${JSON.stringify(project.name)} ${task}: ok`);
      return next;
    });
  }

  /** `.worktrees/` into the project's `.git/info/exclude`, unless something already ignores it. */
  private async ensureIgnored(top: string): Promise<void> {
    const { run } = this.o;
    const probe = await run(top, ['check-ignore', '-q', '--', `${WORKTREES_DIR}/x`], {
      env: READ_ENV,
    });
    if (probe.code === 0) return;
    const where = await run(top, ['rev-parse', '--git-path', 'info/exclude'], { env: READ_ENV });
    if (where.code !== 0) throw new RepoError(koText('git_config_dir'));
    const file = path.resolve(top, where.stdout.toString('utf-8').trim());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
    fs.appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${EXCLUDE_LINE}\n`);
  }

  private async inspect(
    top: string,
    rec: WorktreeRecord,
    registered: Set<string>,
    /** The folder itself (an external worktree's), instead of the one rebuilt from the record. */
    at?: string,
  ): Promise<Inspected> {
    const { run } = this.o;
    const wt = at ?? folderOf(top, rec, registered);
    const dirExists = fs.existsSync(wt);
    const isRegistered = dirExists && registered.has(realOrSame(wt));
    const branchRef = `refs/heads/${rec.branch}`;
    const baseRef = FULL_SHA.test(rec.base) ? rec.base : `refs/heads/${rec.base}`;
    const [branchOk, baseOk] = await Promise.all([
      commitExists(run, top, branchRef),
      commitExists(run, top, baseRef),
    ]);
    // No branch: no commits left to lose. No base: merged cannot be told, so it is "not merged".
    let ahead = 0;
    let behind = 0;
    let merged = !branchOk;
    if (branchOk && baseOk) {
      const c = await run(
        top,
        ['rev-list', '--left-right', '--count', `${baseRef}...${branchRef}`],
        {
          env: READ_ENV,
        },
      );
      const m = /^(\d+)\s+(\d+)$/.exec(c.stdout.toString('utf-8').trim());
      if (c.code === 0 && m) {
        behind = Number(m[1]);
        ahead = Number(m[2]);
        merged = ahead === 0;
      }
    }
    let dirty = 0;
    if (isRegistered) {
      try {
        dirty = (await readStatus(run, wt)).files.length;
      } catch {
        dirty = 1; // unreadable: do not call it clean
      }
    }
    return {
      task: rec.task,
      ...(typeof rec.taskId === 'string' && { taskId: rec.taskId }),
      ...(typeof rec.assignmentId === 'string' && { assignmentId: rec.assignmentId }),
      ...(typeof rec.createdBy === 'string' && { createdBy: rec.createdBy }),
      path: wt,
      branch: rec.branch,
      base: rec.base,
      created: rec.created,
      exists: isRegistered,
      ahead,
      behind,
      dirty,
      merged,
      dirExists,
      registered: isRegistered,
      branchOk,
      baseOk,
    };
  }

  /** status: the project's active task worktrees with ahead/behind, dirty and merged-into-base. */
  async list(project: ProjectFolder): Promise<RepoWorktree[]> {
    const active = readRecords(this.o.file).filter(
      (r) => r.project === project.name && r.status === 'active',
    );
    if (!active.length) return [];
    const top = await repoRoot(this.o.run, project.folder);
    const registered = await registeredWorktrees(this.o.run, top);
    const all = await Promise.all(active.map((rec) => this.inspect(top, rec, registered)));
    return all.map(({ dirExists: _d, registered: _r, branchOk: _b, baseOk: _o, ...wire }) => wire);
  }

  /**
   * DEVROOM-SIDEBAR: the repository's other worktrees (`git worktree list --porcelain`) with no
   * active record: made by hand or by an agent's own `git worktree add`. Not the project's folder,
   * not a bare, detached or vanished one. Each is read like a recorded one against the main branch.
   */
  async external(project: ProjectFolder): Promise<RepoWorktree[]> {
    const { run } = this.o;
    const top = await repoRoot(run, project.folder);
    const r = await run(top, ['worktree', 'list', '--porcelain'], { env: READ_ENV });
    if (r.code !== 0) return [];
    const entries = parseWorktreeList(r.stdout.toString('utf-8'));
    const registered = new Set(entries.map((e) => realOrSame(e.path)));
    const ours = new Set(
      readRecords(this.o.file)
        .filter((x) => x.project === project.name && x.status === 'active')
        .map((x) => realOrSame(folderOf(top, x, registered))),
    );
    const self = realOrSame(top);
    // ponytail: detached and vanished worktrees are left out; show them when someone needs them.
    const others = entries.filter((e) => e.branch && !e.bare && !e.prunable && realOrSame(e.path) !== self && !ours.has(realOrSame(e.path)));
    if (!others.length) return [];
    const main = (await mainBranch(run, top)) ?? null;
    return Promise.all(
      others.map(async (e) => {
        const branch = e.branch as string;
        let created: string;
        try {
          created = fs.statSync(e.path).mtime.toISOString();
        } catch {
          created = new Date(0).toISOString();
        }
        const rec: WorktreeRecord = { project: project.name, task: path.basename(e.path), path: e.path, branch, base: main ?? branch, created, status: 'active' };
        const { dirExists: _d, registered: _r, branchOk: _b, baseOk: _o, ...wire } = await this.inspect(top, rec, registered, e.path);
        return wire;
      }),
    );
  }

  /** Active task worktree `task`'s folder, branch and base, and whether git has the folder as a
   *  worktree: two git calls, not list()'s few per worktree of the project. */
  async spec(project: ProjectFolder, task: string): Promise<WorktreeSpec | undefined> {
    const rec = readRecords(this.o.file).find((r) => r.project === project.name && r.task === task && r.status === 'active');
    if (!rec) return undefined;
    const top = await repoRoot(this.o.run, project.folder);
    const registered = await registeredWorktrees(this.o.run, top);
    const wt = folderOf(top, rec, registered); // a nested (integ/.worktrees/…) folder too, like list()
    const exists = fs.existsSync(wt) && registered.has(realOrSame(wt));
    return { path: wt, branch: rec.branch, base: rec.base, exists };
  }

  async status(project: ProjectFolder, task: string): Promise<RepoWorktree | undefined> {
    return (await this.list(project)).find((w) => w.task === task);
  }

  /**
   * cleanup(project, task): remove a merged or abandoned worktree. Without
   * `force` it is refused while the worktree has uncommitted changes or
   * commits its base lacks (`needsForce`); `force` is what the user's
   * confirmation sends; with it, uncommitted work is first committed to the branch (P4). The
   * branch is deleted only when merged.
   */
  async cleanup(
    project: ProjectFolder,
    task: string,
    opts: { force?: boolean } = {},
  ): Promise<CleanupResult> {
    if (!TASK_PATTERN.test(task)) return { ok: false, ...refused('task_name_invalid') };
    return this.serial(async () => {
      const { run } = this.o;
      const top = await repoRoot(run, project.folder);
      const records = readRecords(this.o.file);
      const rec = records.find(
        (r) => r.project === project.name && r.task === task && r.status === 'active',
      );
      if (!rec) return { ok: false, error: koText('worktree_missing') };
      const st = await this.inspect(top, rec, await registeredWorktrees(run, top));
      const wt = st.path;
      if (st.dirExists && !st.registered) {
        return { ok: false, ...refused('worktree_unregistered') };
      }
      const losses: string[] = [];
      if (st.ahead > 0) losses.push(koText('loss_commits', { count: st.ahead }));
      if (st.branchOk && !st.baseOk) losses.push(koText('loss_unknown_merge'));
      if (st.dirty > 0) losses.push(koText('loss_dirty', { count: st.dirty }));
      if (st.registered && !opts.force && (st.dirty > 0 || !st.merged)) {
        return {
          ok: false,
          needsForce: true,
          ...refused('remove_may_lose', { losses: losses.join(', ') }),
        };
      }

      // P4 (owner 11-01): a confirmed removal never drops uncommitted work: it is committed to the
      // branch first (a WIP commit), so the branch, which then is not merged, keeps it.
      let merged = st.merged;
      if (st.registered && opts.force && st.dirty > 0) {
        const op = await operationInProgress(run, wt);
        if (op) return { ok: false, ...refused('repo_busy', { operation: op }) };
        const add = await run(wt, ['add', '-A']);
        const commit =
          add.code === 0 &&
          (await run(wt, ['commit', '-q', '--no-verify', '--no-gpg-sign', '-m', `WIP: ${task} (kept when its folder was cleaned up)`]));
        if (!commit || commit.code !== 0)
          return { ok: false, ...refused('wip_commit_failed', { why: gitMessage(commit ? commit.stderr : add.stderr) }) };
        merged = false;
      }

      const rm = await run(top, ['worktree', 'remove', ...(opts.force ? ['--force'] : []), wt], {
        timeoutMs: WORKTREE_TIMEOUT_MS,
      });
      // A folder that is already gone and was never (or is no longer) registered: nothing to remove.
      if (rm.code !== 0 && !(!st.dirExists && /is not a working tree/.test(rm.stderr))) {
        return { ok: false, ...refused('worktree_remove_failed', { why: gitMessage(rm.stderr) }) };
      }

      let branchDeleted = false;
      let detail: string | undefined;
      if (st.branchOk) {
        if (merged) {
          const del = await run(top, ['branch', '-d', rec.branch]);
          branchDeleted = del.code === 0;
          detail = branchDeleted
            ? koText('branch_deleted')
            : koText('branch_kept_why', { branch: rec.branch, why: gitMessage(del.stderr) });
        } else {
          detail = koText('branch_kept_unmerged', { branch: rec.branch });
        }
      }
      writeRecords(
        this.o.file,
        records.map((r) => (r === rec ? { ...r, status: 'removed' as const } : r)),
      );
      this.log(`remove ${JSON.stringify(project.name)} ${task}: ok`);
      return { ok: true, branchDeleted, ...(detail ? { detail } : {}) };
    });
  }
}
