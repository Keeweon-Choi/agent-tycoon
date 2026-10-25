/**
 * The repository side of a project card on the wire (FR-ENG-003, FR-ENG-005):
 *
 *   repoView          -> repoState   a project's panel is open: its repository now
 *                                    and every 10 s (and after each write) while anyone looks
 *   repoDiffRequest   -> repoDiff    one file's unified diff, 200 KB a page (W4: with `task`, a file
 *                                    of a task worktree's changes)
 *   repoWorktreeRequest -> repoWorktreeDetail   W4: a task worktree's changed files, commits, guard
 *   repoAction        -> repoActionResult   stage, unstage, commit, push, worktreeRemove,
 *                                    worktreeNew (W2: a Task's worktree, taskWorktree.ts),
 *                                    merge (W3: a task worktree's branch into its base, merge.ts)
 *
 * Projects are addressed by name (the E1 registry's),
 * never by path. The writes are gated like the other actions of T-0010, in the
 * same order and with Korean refusals, and none of them runs git when
 * refused: read-only daemon, unprivileged client, unknown project, another
 * write on the same folder still running, then the action's own arguments.
 * One log line per write, with the client's `gui:<device>`; never its
 * content (no message, no paths).
 */
import * as fs from 'fs';
import * as path from 'path';

import { koText, refused } from '../../../../../core/src/cld/serverText.js';
import type {
  RepoAction,
  RepoActionKind,
  RepoActionResult,
  RepoDiff,
  RepoDiffRequest,
  RepoState,
  RepoView,
  RepoWorktreeDetail,
  RepoWorktreeRequest,
} from '../../../../../core/src/messages.js';
import type { SocketStepUp, WsSend } from '../../hooks.js';
import { STEPUP_REQUIRED } from '../../shell/gate.js';
import type { GitRunner } from './gitRun.js';
import { createGitRunner, RepoError } from './gitRun.js';
import { guardNote, guardStatus, installGuard } from './guardHook.js';
import type { MergeOutcome } from './merge.js';
import { mergeBranches, protectedFor } from './merge.js';
import { MergeHistory } from './mergeHistory.js';
import type { ProjectFolder } from './repoRead.js';
import { readDiff, readRepoState, readStatus, repoRoot } from './repoRead.js';
import type { WriteOutcome } from './repoWrite.js';
import { commit, COMMIT_MESSAGE_MAX, push, stagePaths } from './repoWrite.js';
import { readWorktreeDetail, readWorktreeDiff } from './worktreeRead.js';
import { Worktrees } from './worktrees.js';

export const REPO_POLL_MS = 10_000;
const REQUEST_ID_MAX = 128;
const NAME_MAX = 256;
const PATH_MAX = 4096;
const PATHS_MAX = 1_000;
const ACTIONS: readonly RepoActionKind[] = ['stage', 'unstage', 'commit', 'push', 'worktreeRemove', 'worktreeNew', 'merge'];
const FULL_SHA = /^[0-9a-f]{40}$/;

type Outcome = Pick<RepoActionResult, 'ok' | 'detail' | 'error' | 'needsForce'>;
/** A write's outcome; `code` (a refusal's English word) stays off the wire. */
export type WriteResult = Outcome & { code?: string };

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const requestId = (v: unknown): v is string => isText(v, REQUEST_ID_MAX) && v !== '';

export function parseRepoView(msg: Record<string, unknown>): RepoView | null {
  if (!isText(msg.project, NAME_MAX) || msg.project === '' || typeof msg.on !== 'boolean') {
    return null;
  }
  return { type: 'repoView', project: msg.project, on: msg.on };
}

export function parseRepoDiff(msg: Record<string, unknown>): RepoDiffRequest | null {
  const { project, path: file, staged, offset, task } = msg;
  if (!requestId(msg.requestId) || !isText(project, NAME_MAX) || project === '') return null;
  if (task !== undefined && !isText(task, NAME_MAX)) return null;
  if (!isText(file, PATH_MAX) || file === '' || typeof staged !== 'boolean') return null;
  if (offset !== undefined && !(Number.isSafeInteger(offset) && (offset as number) >= 0)) {
    return null;
  }
  return {
    type: 'repoDiffRequest',
    requestId: msg.requestId,
    project,
    ...(task !== undefined ? { task: task as string } : {}),
    path: file,
    staged,
    ...(offset !== undefined ? { offset: offset as number } : {}),
  };
}

export function parseRepoWorktree(msg: Record<string, unknown>): RepoWorktreeRequest | null {
  const { project, task } = msg;
  if (!requestId(msg.requestId) || !isText(project, NAME_MAX) || project === '') return null;
  if (!isText(task, NAME_MAX) || task === '') return null;
  return { type: 'repoWorktreeRequest', requestId: msg.requestId, project, task };
}

/** A well-formed repoAction, or null (the UI never sends anything else). */
export function parseRepoAction(msg: Record<string, unknown>): RepoAction | null {
  const { action, project, paths, message, task, force, taskId, assignee, base } = msg;
  if (!requestId(msg.requestId) || !isText(project, NAME_MAX) || project === '') return null;
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) return null;
  if (paths !== undefined) {
    if (!Array.isArray(paths) || paths.length > PATHS_MAX) return null;
    if (!paths.every((p) => isText(p, PATH_MAX))) return null;
  }
  if (message !== undefined && !isText(message, COMMIT_MESSAGE_MAX * 2)) return null;
  if (task !== undefined && !isText(task, NAME_MAX)) return null;
  if (force !== undefined && typeof force !== 'boolean') return null;
  for (const v of [taskId, assignee, base]) if (v !== undefined && !isText(v, NAME_MAX)) return null;
  return {
    type: 'repoAction',
    requestId: msg.requestId,
    action: action as RepoActionKind,
    project,
    ...(paths !== undefined ? { paths: paths as string[] } : {}),
    ...(message !== undefined ? { message: message as string } : {}),
    ...(task !== undefined ? { task: task as string } : {}),
    ...(force !== undefined ? { force: force as boolean } : {}),
    ...(taskId !== undefined ? { taskId: taskId as string } : {}),
    ...(assignee !== undefined ? { assignee: assignee as string } : {}),
    ...(base !== undefined ? { base: base as string } : {}),
  };
}

const real = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

export interface RepoManagerOptions {
  /** The projects the daemon manages (E1 registry): name and folder. */
  projects: () => ProjectFolder[];
  readOnly: boolean;
  /** ~/.config/cld-gui (worktrees.json). */
  configDir: string;
  run?: GitRunner;
  pollMs?: number;
  log?: (line: string) => void;
  /** Whether a viewer's page is showing (T-0025): no git polls for hidden ones. */
  looking?: (send: WsSend) => boolean;
  /** W2: `worktreeNew` (the office's taskWorktree.ts, which writes through write()). */
  taskWorktree?: (req: RepoAction, privileged: boolean, source: string) => Promise<WriteResult>;
  /** W2: the name an assignment answers to now (a worktree's assignee). */
  nameOf?: (assignmentId: string) => string | undefined;
}

interface View {
  sends: Set<WsSend>;
  timer: ReturnType<typeof setInterval>;
  /** The state last sent, as JSON: a poll that finds the same sends nothing. */
  last?: string;
  running: boolean;
  again: boolean;
}

export class RepoManager {
  /** For jobs and Codex (E2, E4): new / status / cleanup of task worktrees. */
  readonly worktrees: Worktrees;
  private readonly run: GitRunner;
  private readonly views = new Map<string, View>();
  /** Folders (real paths) with a write still running. */
  private readonly busy = new Set<string>();
  /** W3: per repository (real path), the merges still to run, one after another. */
  private readonly mergeQueues = new Map<string, Promise<unknown>>();
  /** W4: the merges of every project, kept across restarts. */
  private readonly history: MergeHistory;

  /** A merge or another git write is running now (the update notice postpones for it). */
  get writing(): boolean {
    return this.busy.size > 0 || this.mergeQueues.size > 0;
  }

  constructor(private readonly o: RepoManagerOptions) {
    this.run = o.run ?? createGitRunner();
    this.worktrees = new Worktrees({
      file: path.join(o.configDir, 'worktrees.json'),
      run: this.run,
      log: o.log,
      guard: (top, project) => installGuard(this.run, top, o.configDir, project),
    });
    this.history = new MergeHistory(path.join(o.configDir, 'merge-history.json'));
  }

  project(name: string): ProjectFolder | undefined {
    return this.o.projects().find((p) => p.name === name);
  }

  /** True when `msg` was a repo message (also a malformed one, which is dropped). */
  onClientMessage(
    msg: Record<string, unknown>,
    send: WsSend,
    privileged: boolean,
    source = 'gui:web',
    stepUp?: SocketStepUp,
  ): boolean {
    switch (msg.type) {
      case 'repoView': {
        const req = parseRepoView(msg);
        if (!req) console.warn('[cld repo] malformed repoView dropped');
        else if (privileged) this.view(req, send);
        return true;
      }
      case 'repoDiffRequest': {
        const req = parseRepoDiff(msg);
        if (!req) console.warn('[cld repo] malformed repoDiffRequest dropped');
        else if (privileged) void this.diff(req, send);
        return true;
      }
      case 'repoWorktreeRequest': {
        const req = parseRepoWorktree(msg);
        if (!req) console.warn('[cld repo] malformed repoWorktreeRequest dropped');
        else if (privileged) void this.worktreeDetail(req, send);
        return true;
      }
      case 'repoAction': {
        const req = parseRepoAction(msg);
        if (!req) console.warn('[cld repo] malformed repoAction dropped');
        else {
          void this.runAction(req, privileged, source, stepUp).then(
            (result) => send({ ...result }),
            (err: unknown) => console.warn(`[cld repo] action: ${String(err)}`),
          );
        }
        return true;
      }
      default:
        return false;
    }
  }

  onClientClosed(send: WsSend): void {
    for (const name of [...this.views.keys()]) this.unview(name, send);
  }

  dispose(): void {
    for (const v of this.views.values()) clearInterval(v.timer);
    this.views.clear();
  }

  // ── Reading ─────────────────────────────────────────────────

  private view(req: RepoView, send: WsSend): void {
    const name = req.project;
    if (!req.on) return this.unview(name, send);
    if (!this.project(name)) {
      send({ type: 'repoState', project: name, ok: false, ...refused('project_unregistered') });
      return;
    }
    let v = this.views.get(name);
    if (!v) {
      const timer = setInterval(
        () => void this.refresh(name, false),
        this.o.pollMs ?? REPO_POLL_MS,
      );
      timer.unref();
      v = { sends: new Set(), timer, running: false, again: false };
      this.views.set(name, v);
    }
    v.sends.add(send);
    if (v.last) send(JSON.parse(v.last) as Record<string, unknown>);
    void this.refresh(name, true);
  }

  private unview(name: string, send: WsSend): void {
    const v = this.views.get(name);
    if (!v) return;
    v.sends.delete(send);
    if (v.sends.size === 0) {
      clearInterval(v.timer);
      this.views.delete(name);
    }
  }

  /**
   * Read the project and send the state to its viewers when it changed.
   * `queued`: a write just finished, so run once more even if a poll is
   * already in flight (it may have started before the write).
   */
  private async refresh(name: string, queued: boolean): Promise<void> {
    const v = this.views.get(name);
    if (!v) return;
    if (v.running) {
      if (queued) v.again = true;
      return;
    }
    const proj = this.project(name);
    if (!queued && proj && this.busy.has(real(proj.folder))) return; // the write refreshes when done
    const { looking } = this.o;
    if (!queued && looking && v.sends.size && ![...v.sends].some(looking)) return; // all hidden
    v.running = true;
    try {
      do {
        v.again = false;
        const state = await this.state(name);
        const json = JSON.stringify(state);
        if (json !== v.last) {
          v.last = json;
          for (const s of v.sends) s(state as unknown as Record<string, unknown>);
        }
      } while (v.again && this.views.has(name));
    } finally {
      v.running = false;
    }
  }

  private async state(name: string): Promise<RepoState> {
    const proj = this.project(name);
    if (!proj)
      return { type: 'repoState', project: name, ok: false, ...refused('project_unregistered') };
    try {
      const repo = await readRepoState(this.run, proj);
      if (!repo.ok) return { type: 'repoState', ...repo };
      const worktrees = (await this.worktrees.list(proj).catch(() => [])).map((w) => {
        const assignee = w.assignmentId && this.o.nameOf?.(w.assignmentId);
        const merge = this.history.last(name, w.task);
        return { ...w, ...(assignee && { assignee }), ...(merge && { merge }) };
      });
      const merges = this.history.list(name, 20);
      return { type: 'repoState', ...repo, worktrees, ...(merges.length && { merges }) };
    } catch (err) {
      console.warn(`[cld repo] ${JSON.stringify(name)}: ${String(err)}`);
      return { type: 'repoState', project: name, ok: false, ...refused('git_run_failed') };
    }
  }

  private async diff(req: RepoDiffRequest, send: WsSend): Promise<void> {
    const reply = (rest: Pick<RepoDiff, 'ok' | 'text' | 'nextOffset' | 'limited' | 'error'>) =>
      send({
        type: 'repoDiff',
        requestId: req.requestId,
        project: req.project,
        ...(req.task !== undefined && { task: req.task }),
        path: req.path,
        staged: req.staged,
        ...rest,
      });
    const proj = this.project(req.project);
    if (!proj) return reply({ ok: false, ...refused('project_unregistered') });
    try {
      const page = req.task
        ? await readWorktreeDiff(this.run, await repoRoot(this.run, proj.folder), await this.spec(proj, req.task), req)
        : await readDiff(this.run, proj.folder, req);
      reply({ ok: true, ...page });
    } catch (err) {
      if (!(err instanceof RepoError)) console.warn(`[cld repo] diff: ${String(err)}`);
      reply({ ok: false, error: err instanceof RepoError ? err.message : koText('diff_failed') });
    }
  }

  /** The active task worktree `task` as git says it is now. */
  private async spec(proj: ProjectFolder, task: string) {
    const w = (await this.worktrees.list(proj)).find((x) => x.task === task);
    if (!w) throw new RepoError(koText('worktree_missing'));
    return { path: w.path, branch: w.branch, base: w.base, exists: w.exists };
  }

  /** W4: what task worktree `req.task` changed (read-only; for privileged clients, like diffs). */
  private async worktreeDetail(req: RepoWorktreeRequest, send: WsSend): Promise<void> {
    const reply = (rest: Partial<RepoWorktreeDetail> & { ok: boolean }) =>
      send({ type: 'repoWorktreeDetail', requestId: req.requestId, project: req.project, task: req.task, ...rest });
    const proj = this.project(req.project);
    if (!proj) return reply({ ok: false, ...refused('project_unregistered') });
    try {
      const top = await repoRoot(this.run, proj.folder);
      const detail = await readWorktreeDetail(this.run, top, await this.spec(proj, req.task));
      reply({ ok: true, ...detail, guard: guardNote(await guardStatus(this.run, top)) });
    } catch (err) {
      if (!(err instanceof RepoError)) console.warn(`[cld repo] worktree detail: ${String(err)}`);
      reply({ ok: false, error: err instanceof RepoError ? err.message : koText('changes_unreadable') });
    }
  }

  // ── Writing ─────────────────────────────────────────────────

  /** Never rejects: refusals and git failures are `ok: false` results. */
  async runAction(
    req: RepoAction,
    privileged: boolean,
    source = 'gui:web',
    stepUp?: SocketStepUp,
  ): Promise<RepoActionResult> {
    const { action, project: name } = req;
    const out: WriteResult =
      action === 'worktreeNew'
        ? await (this.o.taskWorktree?.(req, privileged, source) ??
            Promise.resolve({ ok: false, ...refused('worktree_cannot_make') } as WriteResult))
        : action === 'merge'
          ? await this.merge(name, req.task ?? '', { privileged, source, stepUp })
          : await this.write(name, privileged, source, action, (proj) => this.perform(req, proj));
    return {
      type: 'repoActionResult',
      requestId: req.requestId,
      action,
      project: name,
      ok: out.ok,
      ...(out.detail ? { detail: out.detail } : {}),
      ...(out.error ? { error: out.error } : {}),
      ...(out.needsForce ? { needsForce: true } : {}),
    };
  }

  /**
   * One write on project `name`'s repository, gated as every repoAction (read-only daemon,
   * unprivileged client, unknown project, another write on the same folder still running)
   * before `fn` runs: one log line, then the viewers' refresh. Never rejects.
   */
  async write<T extends WriteResult>(
    name: string,
    privileged: boolean,
    source: string,
    action: string,
    fn: (proj: ProjectFolder) => Promise<T>,
  ): Promise<T | WriteResult> {
    const what = `${action} ${JSON.stringify(name).slice(0, 66)}`;
    const proj = this.project(name);
    const refusal = this.refusal(proj, name, privileged);
    if (refusal || !proj) {
      this.log(`${what}: refused (${refusal?.error})`);
      return { ok: false, code: refusal?.code ?? 'unknown_project', error: refusal?.error ?? koText('project_unregistered') };
    }
    const key = real(proj.folder);
    this.busy.add(key);
    const started = Date.now();
    let out: T | WriteResult;
    try {
      out = await fn(proj);
    } catch (err) {
      if (!(err instanceof RepoError)) console.warn(`[cld repo] ${what}: ${String(err)}`);
      out = {
        ok: false,
        code: (err instanceof RepoError && err.code) || 'git_failed',
        error: err instanceof RepoError ? err.message : koText('git_run_failed'),
      };
    } finally {
      this.busy.delete(key);
    }
    this.log(
      `${what}: ${out.ok ? 'ok' : 'failed'} ${((Date.now() - started) / 1000).toFixed(1)}s ${source}`,
    );
    void this.refresh(name, true);
    return out;
  }

  private refusal(proj: ProjectFolder | undefined, name: string, privileged: boolean, queued = false) {
    const no = (code: string, error: string) => ({ code, error });
    if (this.o.readOnly) return no('read_only', koText('read_only_mode'));
    if (!privileged) return no('forbidden', koText('no_permission'));
    if (!proj) return no('unknown_project', koText('project_unregistered'));
    if (!queued && this.busy.has(real(proj.folder))) return no('busy', koText('project_busy', { name }));
    return null;
  }

  /**
   * W3: merge task worktree `task`'s branch into its base (merge.ts), queued behind the
   * repository's other merges (never refused as busy). Policy: a protected base (main, master, a
   * remote's default, the owner's `protected-branches.json`) is never merged automatically, and
   * a person's click on it from a remote device needs a fresh step-up. Never rejects.
   */
  merge(
    name: string,
    task: string,
    o: { privileged: boolean; source: string; auto?: boolean; stepUp?: SocketStepUp },
  ): Promise<WriteResult> {
    const proj = this.project(name);
    const refusal = this.refusal(proj, name, o.privileged, true);
    const rec = this.worktrees
      .all()
      .find((r) => r.project === name && r.task === task && r.status === 'active');
    if (refusal || !proj || !rec) {
      const out = refusal ?? { code: 'unknown_worktree', error: koText('worktree_missing') };
      this.log(`merge ${JSON.stringify(name).slice(0, 66)}: refused (${out.error})`);
      return Promise.resolve({ ok: false, ...out });
    }
    const key = real(proj.folder);
    const next = (this.mergeQueues.get(key) ?? Promise.resolve()).then(() => this.mergeNow(proj, rec, o));
    const tail = next.catch(() => undefined);
    this.mergeQueues.set(key, tail);
    void tail.then(() => {
      if (this.mergeQueues.get(key) === tail) this.mergeQueues.delete(key);
    });
    return next;
  }

  private async mergeNow(
    proj: ProjectFolder,
    rec: { task: string; branch: string; base: string },
    o: { source: string; auto?: boolean; stepUp?: SocketStepUp },
  ): Promise<WriteResult> {
    const started = Date.now();
    const target = rec.base;
    let out: MergeOutcome;
    try {
      const top = await repoRoot(this.run, proj.folder);
      const list = await protectedFor(this.run, top, path.join(this.o.configDir, 'protected-branches.json'), proj.name);
      const prot = !list || list.has(target);
      if (FULL_SHA.test(target)) out = { ok: false, code: 'no_base', ...refused('merge_no_base') };
      else if (prot && o.auto)
        out = { ok: false, code: 'protected', ...refused('merge_protected', { target }) };
      else if (prot && o.stepUp?.remote && !o.stepUp.fresh()) {
        this.log(`merge ${JSON.stringify(proj.name).slice(0, 66)} ${rec.task}: step-up needed ${o.source}`);
        return { ok: false, code: STEPUP_REQUIRED, error: STEPUP_REQUIRED };
      } else out = await mergeBranches(this.run, top, rec.branch, target);
    } catch (err) {
      if (!(err instanceof RepoError)) console.warn(`[cld repo] merge: ${String(err)}`);
      out = { ok: false, code: 'git_failed', error: err instanceof RepoError ? err.message : koText('git_run_failed') };
    }
    try {
      this.history.add(proj.name, {
        task: rec.task,
        branch: rec.branch,
        at: new Date().toISOString(),
        target,
        auto: !!o.auto,
        ...out,
      });
    } catch (err) {
      console.warn(`[cld repo] merge history not written: ${String(err)}`);
    }
    this.log(
      `merge ${JSON.stringify(proj.name).slice(0, 66)} ${rec.task}: ${out.ok ? out.kind : `failed (${out.code})`} ${((Date.now() - started) / 1000).toFixed(1)}s ${o.source}`,
    );
    void this.refresh(proj.name, true);
    const short = out.sha?.slice(0, 7);
    const detail = !out.ok
      ? undefined
      : out.kind === 'already'
        ? koText('merge_already', { branch: rec.branch, target })
        : out.kind === 'ff'
          ? `${target} ← ${rec.branch} (fast-forward, ${short})`
          : koText('merge_done_commit', { target, branch: rec.branch, short: short ?? '' });
    return { ok: out.ok, ...(out.code && { code: out.code }), ...(out.error && { error: out.error }), ...(detail && { detail }) };
  }

  private async perform(req: RepoAction, proj: ProjectFolder): Promise<Outcome> {
    if (req.action === 'worktreeRemove') {
      if (!req.task) throw new RepoError(koText('task_name_needed'));
      const r = await this.worktrees.cleanup(proj, req.task, { force: req.force === true });
      return {
        ok: r.ok,
        ...(r.error ? { error: r.error } : {}),
        ...(r.needsForce ? { needsForce: true } : {}),
        ...(r.ok && r.detail ? { detail: r.detail } : {}),
      };
    }
    // The status read right now is what the arguments are checked against.
    const top = await repoRoot(this.run, proj.folder);
    const status = await readStatus(this.run, top, Infinity);
    let out: WriteOutcome;
    switch (req.action) {
      case 'stage':
      case 'unstage':
        out = await stagePaths(this.run, top, status, req.paths, req.action === 'unstage');
        break;
      case 'commit':
        out = await commit(this.run, top, status, req.message ?? '');
        break;
      case 'push':
        out = await push(this.run, top, status);
        break;
      default:
        throw new RepoError(koText('action_unknown'));
    }
    return { ok: true, ...(out.detail ? { detail: out.detail } : {}) };
  }

  private log(line: string): void {
    (this.o.log ?? console.log)(`[cld repo] action ${line}`);
  }
}
