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
 * P4 (개발실): repoMergeCheck, repoConflicts, repoCleanupList (answers to the sender), the sync /
 * resolve / mergeContinue / mergeAbort / conflictHandoff actions (conflicts.ts), the dev room's view
 * of every project (devroomView), conflict pre-checks while viewed, auto-cleanup after a merge, and
 * the review loop's sentHead / fixed / `since` diffs.
 *
 * Projects are addressed by name (the E1 registry's),
 * never by path. The writes are gated like the other actions of T-0010, in the
 * same order and with Korean refusals, and none of them runs git when
 * refused: read-only daemon, unprivileged client, unknown project, another
 * write on the same folder still running, then the action's own arguments.
 * One log line per write, with the client's `gui:<device>`; never its
 * content (no message, no paths).
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { Coded } from '../../../../../core/src/cld/serverText.js';
import { koText, refused } from '../../../../../core/src/cld/serverText.js';
import type {
  RepoAction,
  RepoActionKind,
  RepoActionResult,
  RepoCleanupListResult,
  RepoConflictChoice,
  RepoConflictsResult,
  RepoDiff,
  RepoDiffRequest,
  RepoMergeCheckResult,
  RepoState,
  RepoView,
  RepoWorktree,
  RepoWorktreeDetail,
  RepoWorktreeRequest,
  ReviewNoteResult,
  ReviewNotes as ReviewNotesMessage,
  ReviewNotesRequest,
  ReviewNoteWrite,
  ReviewSend,
  ReviewSendResult,
} from '../../../../../core/src/messages.js';
import type { SocketStepUp, WsSend } from '../../hooks.js';
import { STEPUP_REQUIRED } from '../../shell/gate.js';
import { branchTips, cleanupRows } from './cleanupList.js';
import type { SyncOutcome } from './conflicts.js';
import { abortMerge, continueMerge, listConflicts, resolveFile, syncBase } from './conflicts.js';
import type { GitRunner } from './gitRun.js';
import { createGitRunner, READ_ENV, RepoError } from './gitRun.js';
import { guardNote, guardStatus, installGuard } from './guardHook.js';
import type { MergeOutcome } from './merge.js';
import { mergeBranches, mergeConflicts, protectedFor } from './merge.js';
import { MergeHistory } from './mergeHistory.js';
import type { ProjectFolder } from './repoRead.js';
import { readDiff, readRepoState, readStatus, repoRoot } from './repoRead.js';
import type { WriteOutcome } from './repoWrite.js';
import { commit, COMMIT_MESSAGE_MAX, push, stagePaths } from './repoWrite.js';
import type { ReviewNote, ReviewSendInput, ReviewSendOutcome } from './reviewNotes.js';
import {
  REVIEW_NOTE_BODY_MAX,
  REVIEW_NOTE_FILE_MAX,
  ReviewNotes,
  ReviewNotesError,
} from './reviewNotes.js';
import { readWorktreeDetail, readWorktreeDiff } from './worktreeRead.js';
import { Worktrees } from './worktrees.js';

export const REPO_POLL_MS = 10_000;
const REQUEST_ID_MAX = 128;
const NAME_MAX = 256;
const PATH_MAX = 4096;
const PATHS_MAX = 1_000;
const REVIEW_OPS = ['add', 'edit', 'delete'] as const;
const ACTIONS: readonly RepoActionKind[] = [
  'stage', 'unstage', 'commit', 'push', 'worktreeRemove', 'worktreeNew', 'merge',
  'sync', 'resolve', 'mergeContinue', 'mergeAbort', 'conflictHandoff',
];
/** P4: the actions inside a task worktree's own merge (conflicts.ts). */
const SYNC_ACTIONS = new Set<RepoActionKind>(['sync', 'resolve', 'mergeContinue', 'mergeAbort']);
const CHOICES: readonly RepoConflictChoice[] = ['ours', 'theirs', 'both', 'keep'];
const CHOICES_MAX = 1_000;
const FULL_SHA = /^[0-9a-f]{40}$/;
/** Conflict pre-check results kept (per base and branch commit); cleared when full. */
const CONFLICT_CACHE_MAX = 500;

type Outcome = Pick<RepoActionResult, 'ok' | 'detail' | 'error' | 'needsForce' | 'conflicts' | 'cleaned'>;
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
  const { project, path: file, staged, offset, task, since } = msg;
  if (!requestId(msg.requestId) || !isText(project, NAME_MAX) || project === '') return null;
  if (task !== undefined && !isText(task, NAME_MAX)) return null;
  if (since !== undefined && (task === undefined || typeof since !== 'string' || !FULL_SHA.test(since))) return null;
  if (!isText(file, PATH_MAX) || file === '' || typeof staged !== 'boolean') return null;
  if (offset !== undefined && !(Number.isSafeInteger(offset) && (offset as number) >= 0)) {
    return null;
  }
  return {
    type: 'repoDiffRequest',
    requestId: msg.requestId,
    project,
    ...(task !== undefined ? { task: task as string } : {}),
    ...(since !== undefined && { since: since as string }),
    path: file,
    staged,
    ...(offset !== undefined ? { offset: offset as number } : {}),
  };
}

export function parseRepoWorktree(msg: Record<string, unknown>): RepoWorktreeRequest | null {
  const { project, task } = msg;
  if (!requestId(msg.requestId) || !isText(project, NAME_MAX) || project === '') return null;
  if (!isText(task, NAME_MAX) || task === '') return null;
  const { since } = msg;
  if (since !== undefined && (typeof since !== 'string' || !FULL_SHA.test(since))) return null;
  return { type: 'repoWorktreeRequest', requestId: msg.requestId, project, task, ...(since !== undefined && { since }) };
}

/** P4: repoMergeCheck / repoConflicts ({requestId, project, task}) and repoCleanupList (no task). */
export function parseTaskRequest(msg: Record<string, unknown>, needsTask = true): { requestId: string; project: string; task: string } | null {
  if (!requestId(msg.requestId) || !isText(msg.project, NAME_MAX) || msg.project === '') return null;
  if (needsTask && (!isText(msg.task, NAME_MAX) || msg.task === '')) return null;
  return { requestId: msg.requestId, project: msg.project, task: needsTask ? (msg.task as string) : '' };
}

export function parseReviewNotes(msg: Record<string, unknown>): ReviewNotesRequest | null {
  if (!requestId(msg.requestId) || !isText(msg.project, NAME_MAX) || msg.project === '') return null;
  if (!isText(msg.task, NAME_MAX) || msg.task === '') return null;
  return { type: 'reviewNotesRequest', requestId: msg.requestId, project: msg.project, task: msg.task };
}

export function parseReviewSend(msg: Record<string, unknown>): ReviewSend | null {
  const req = parseReviewNotes(msg);
  return req && { ...req, type: 'reviewSend' };
}

/** A client note write with only the fields meaningful for its operation. */
export function parseReviewNoteWrite(msg: Record<string, unknown>): ReviewNoteWrite | null {
  if (!requestId(msg.requestId) || !isText(msg.project, NAME_MAX) || msg.project === '') return null;
  if (!isText(msg.task, NAME_MAX) || msg.task === '') return null;
  if (typeof msg.op !== 'string' || !(REVIEW_OPS as readonly string[]).includes(msg.op)) return null;
  const base = { type: 'reviewNoteWrite' as const, requestId: msg.requestId, project: msg.project, task: msg.task, op: msg.op };
  if (msg.op === 'add') {
    if (!isText(msg.file, REVIEW_NOTE_FILE_MAX) || msg.file === '' || msg.side !== 'new') return null;
    if (!(Number.isSafeInteger(msg.line) && (msg.line as number) >= 0)) return null;
    if (msg.startLine !== undefined && !(Number.isSafeInteger(msg.startLine) && (msg.startLine as number) > 0 && (msg.startLine as number) <= (msg.line as number))) return null;
    if ((msg.line as number) === 0 && msg.startLine !== undefined) return null;
    if (!isText(msg.body, REVIEW_NOTE_BODY_MAX) || msg.body.trim() === '') return null;
    return {
      ...base,
      op: 'add',
      file: msg.file,
      side: 'new',
      ...(msg.startLine !== undefined && { startLine: msg.startLine as number }),
      line: msg.line as number,
      body: msg.body,
    };
  }
  if (!isText(msg.id, 80) || msg.id === '') return null;
  if (msg.op === 'edit') {
    if (!isText(msg.body, REVIEW_NOTE_BODY_MAX) || msg.body.trim() === '') return null;
    return { ...base, op: 'edit', id: msg.id, body: msg.body };
  }
  return { ...base, op: 'delete', id: msg.id };
}

/** A well-formed repoAction, or null (the UI never sends anything else). */
export function parseRepoAction(msg: Record<string, unknown>): RepoAction | null {
  const { action, project, paths, message, task, force, taskId, assignee, base, path: file, choices } = msg;
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
  if (file !== undefined && (!isText(file, PATH_MAX) || file === '')) return null;
  if (choices !== undefined) {
    if (!Array.isArray(choices) || choices.length > CHOICES_MAX) return null;
    if (!choices.every((c) => (CHOICES as readonly unknown[]).includes(c))) return null;
  }
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
    ...(file !== undefined && { path: file as string }),
    ...(choices !== undefined && { choices: choices as RepoConflictChoice[] }),
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
  /** ~/.config/agent-tycoon (worktrees.json). */
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
  /** Step ④: the notes to the agent that made the change (the office's messenger, tasks, rooms). */
  reviewSend?: (input: ReviewSendInput) => Promise<ReviewSendOutcome>;
  /** P4: the conflict handoff, delivered like review notes (reviewNotes.deliverToWorker). */
  conflictHandoff?: (input: ConflictHandoffInput) => Promise<{ ok: boolean; to?: string; error?: string } & Coded>;
  /** P4: the agent `name` is in a turn now (a sync is refused under it). */
  agentBusy?: (name: string) => boolean;
  /** P4: the owner's `autoCleanupAfterMerge` (default on). */
  autoCleanup?: () => boolean;
}

export interface ConflictHandoffInput {
  project: string;
  worktree: string;
  taskId?: string;
  assignmentId?: string;
  base: string;
  files: string[];
  source: string;
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
  readonly reviewNotes: ReviewNotes;
  private readonly run: GitRunner;
  private readonly views = new Map<string, View>();
  /** Folders (real paths) with a write still running. */
  private readonly busy = new Set<string>();
  /** W3: per repository (real path), the merges still to run, one after another. */
  private readonly mergeQueues = new Map<string, Promise<unknown>>();
  /** W4: the merges of every project, kept across restarts. */
  private readonly history: MergeHistory;
  /** Privileged clients that asked to follow one task's review notes. */
  private readonly reviewViews = new Map<string, Set<WsSend>>();
  /** Task worktrees whose notes are being sent now (a double click sends them once). */
  private readonly reviewSending = new Set<string>();
  /** P4: conflict pre-checks, by project, task, base commit and branch commit (null: failed). */
  private readonly conflictCache = new Map<string, string[] | null>();
  /** P4: one pre-check at a time, for the whole daemon. */
  private conflictChecking = false;
  /** P4: a dev room viewer's own send per project view (so a repoView of the same client stays). */
  private readonly devroomSends = new Map<WsSend, WsSend>();
  private readonly devroomOrigin = new Map<WsSend, WsSend>();

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
    this.reviewNotes = new ReviewNotes(path.join(o.configDir, 'review-notes.json'), {
      log: (line) => this.log(line),
    });
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
      case 'reviewNotesRequest': {
        const req = parseReviewNotes(msg);
        if (!req) console.warn('[cld repo] malformed reviewNotesRequest dropped');
        else if (privileged) void this.listReviewNotes(req, send, true);
        return true;
      }
      case 'reviewNoteWrite': {
        const req = parseReviewNoteWrite(msg);
        if (!req) console.warn('[cld repo] malformed reviewNoteWrite dropped');
        else if (privileged) void this.writeReviewNote(req, send, source);
        return true;
      }
      case 'reviewSend': {
        const req = parseReviewSend(msg);
        if (!req) console.warn('[cld repo] malformed reviewSend dropped');
        else if (privileged) void this.sendReview(req, send, source);
        return true;
      }
      case 'repoMergeCheck':
      case 'repoConflicts':
      case 'repoCleanupList': {
        const req = parseTaskRequest(msg, msg.type !== 'repoCleanupList');
        if (!req) console.warn(`[cld repo] malformed ${msg.type} dropped`);
        else if (privileged) {
          const answer =
            msg.type === 'repoMergeCheck'
              ? this.mergeCheck(req)
              : msg.type === 'repoConflicts'
                ? this.conflicts(req)
                : this.cleanupList(req);
          void answer.then(
            (m) => send({ ...m }),
            (err: unknown) => console.warn(`[cld repo] ${String(msg.type)}: ${String(err)}`),
          );
        }
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
    this.devroomView(send, false);
    for (const name of [...this.views.keys()]) this.unview(name, send);
    for (const [key, sends] of this.reviewViews) {
      sends.delete(send);
      if (sends.size === 0) this.reviewViews.delete(key);
    }
  }

  dispose(): void {
    for (const v of this.views.values()) clearInterval(v.timer);
    this.views.clear();
  }

  // ── Reading ─────────────────────────────────────────────────

  /** P4: the dev room open (or closed) on `send`: a repoView of every project, under a send of its
   *  own so the client's own repoView of one project is not closed with it. */
  devroomView(send: WsSend, on: boolean): void {
    let mine = this.devroomSends.get(send);
    if (!on) {
      if (!mine) return;
      for (const name of [...this.views.keys()]) this.unview(name, mine);
      this.devroomSends.delete(send);
      this.devroomOrigin.delete(mine);
      return;
    }
    if (!mine) {
      mine = (m) => send(m);
      this.devroomSends.set(send, mine);
      this.devroomOrigin.set(mine, send);
    }
    for (const p of this.o.projects()) this.view({ type: 'repoView', project: p.name, on: true }, mine);
  }

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
    const shown = (s: WsSend) => !looking || looking(this.devroomOrigin.get(s) ?? s);
    if (!queued && looking && v.sends.size && ![...v.sends].some(shown)) return; // all hidden
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
      const top = await repoRoot(this.run, proj.folder);
      const worktrees = await this.worktreeRows(proj, top, true);
      const merges = this.history.list(name, 20);
      return { type: 'repoState', ...repo, worktrees, ...(merges.length && { merges }) };
    } catch (err) {
      console.warn(`[cld repo] ${JSON.stringify(name)}: ${String(err)}`);
      return { type: 'repoState', project: name, ok: false, ...refused('git_run_failed') };
    }
  }

  /** The project's active worktrees as the wire has them: assignee, last merge, lastChange and
   *  (`precheck`: started in the background, one at a time, cached) the conflicts with the base. */
  private async worktreeRows(proj: ProjectFolder, top: string, precheck: boolean): Promise<RepoWorktree[]> {
    const list = await this.worktrees.list(proj).catch(() => [] as RepoWorktree[]);
    const tips = list.length ? await branchTips(this.run, top) : new Map<string, { sha: string; at: string }>();
    return list.map((w) => {
      const assignee = w.assignmentId && this.o.nameOf?.(w.assignmentId);
      const merge = this.history.last(proj.name, w.task);
      const tip = tips.get(w.branch);
      const base = tips.get(w.base);
      let conflicts: string[] | null | undefined;
      if (tip && base && w.ahead > 0 && w.behind > 0) {
        const key = `${proj.name}\0${w.task}\0${base.sha}\0${tip.sha}`;
        conflicts = this.conflictCache.get(key);
        if (conflicts === undefined && precheck) this.precheck(proj.name, top, w, key);
      }
      return {
        ...w,
        ...(assignee && { assignee }),
        ...(merge && { merge }),
        ...(tip && { lastChange: tip.at }),
        ...(conflicts && { conflicts }),
      };
    });
  }

  /** One conflict pre-check in the background (none while another runs); its viewers refresh after. */
  private precheck(name: string, top: string, w: RepoWorktree, key: string): void {
    if (this.conflictChecking) return;
    this.conflictChecking = true;
    void mergeConflicts(this.run, top, w.branch, w.base)
      .then(
        (files) => files,
        (err: unknown) => {
          console.warn(`[cld repo] conflict pre-check ${w.task}: ${String(err)}`);
          return null;
        },
      )
      .then((files) => {
        if (this.conflictCache.size >= CONFLICT_CACHE_MAX) this.conflictCache.clear();
        this.conflictCache.set(key, files);
        this.conflictChecking = false;
        void this.refresh(name, true);
      });
  }

  private async diff(req: RepoDiffRequest, send: WsSend): Promise<void> {
    const reply = (rest: Pick<RepoDiff, 'ok' | 'text' | 'nextOffset' | 'limited' | 'error'>) =>
      send({
        type: 'repoDiff',
        requestId: req.requestId,
        project: req.project,
        ...(req.task !== undefined && { task: req.task }),
        ...(req.since !== undefined && { since: req.since }),
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
      const detail = await readWorktreeDetail(this.run, top, await this.spec(proj, req.task), req.since);
      reply({ ok: true, ...detail, guard: guardNote(await guardStatus(this.run, top)) });
    } catch (err) {
      if (!(err instanceof RepoError)) console.warn(`[cld repo] worktree detail: ${String(err)}`);
      reply({ ok: false, error: err instanceof RepoError ? err.message : koText('changes_unreadable') });
    }
  }

  // ── Review notes ─────────────────────────────────────────────

  private reviewKey(project: string, task: string): string {
    return `${project}\0${task}`;
  }

  private async reviewContext(project: string, task: string) {
    const proj = this.project(project);
    if (!proj) throw new RepoError(koText('project_unregistered'));
    const top = await repoRoot(this.run, proj.folder);
    const spec = await this.spec(proj, task);
    const detail = await readWorktreeDetail(this.run, top, spec);
    return { proj, top, spec, files: new Set(detail.files.map((file) => file.path)) };
  }

  /** The current new-side object identity, or null when the changed file is gone. */
  private async reviewIdentity(spec: { path: string }, file: string): Promise<string | null> {
    const result = await this.run(spec.path, ['hash-object', '--no-filters', '--', file], { env: READ_ENV });
    const identity = result.stdout.toString('utf-8').trim();
    return result.code === 0 && /^[0-9a-f]{40}$/.test(identity) ? identity : null;
  }

  /** P4: what a note's anchor reads now: its lines (hashed), a file-level note's file identity. */
  private reviewAnchor(spec: { path: string }, note: Pick<ReviewNote, 'file' | 'line' | 'startLine'>, identity: string | null): string {
    if (note.line === 0) return identity ?? 'gone';
    const file = path.resolve(spec.path, note.file);
    if (!file.startsWith(spec.path + path.sep)) return 'gone';
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch {
      return 'gone';
    }
    const lines = text.split('\n').slice((note.startLine ?? note.line) - 1, note.line);
    return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 40);
  }

  /** P4: the worktree's commit now, its uncommitted work included (`git stash create`, else HEAD).
   *  ponytail: an unreferenced stash commit can be pruned by gc after weeks; a ref per send if that bites. */
  private async headWithWork(wt: string): Promise<string | undefined> {
    const st = await this.run(wt, ['stash', 'create']);
    const made = st.stdout.toString('utf-8').trim();
    if (st.code === 0 && FULL_SHA.test(made)) return made;
    const head = await this.run(wt, ['rev-parse', '--verify', '-q', 'HEAD'], { env: READ_ENV });
    const sha = head.stdout.toString('utf-8').trim();
    return head.code === 0 && FULL_SHA.test(sha) ? sha : undefined;
  }

  private async listReviewNotes(
    req: ReviewNotesRequest,
    send: WsSend,
    subscribe: boolean,
    includeRequestId = true,
  ): Promise<void> {
    const reply = (rest: Omit<ReviewNotesMessage, 'type' | 'project' | 'task'>) =>
      send({
        type: 'reviewNotes',
        project: req.project,
        task: req.task,
        ...(includeRequestId && { requestId: req.requestId }),
        ...rest,
      });
    try {
      const context = await this.reviewContext(req.project, req.task);
      const notes = this.reviewNotes.list(req.project, req.task);
      const identities = new Map<string, string | null>();
      for (const file of new Set(notes.map((note) => note.file)))
        identities.set(file, context.files.has(file) ? await this.reviewIdentity(context.spec, file) : null);
      if (subscribe) {
        const key = this.reviewKey(req.project, req.task);
        const sends = this.reviewViews.get(key) ?? new Set<WsSend>();
        sends.add(send);
        this.reviewViews.set(key, sends);
      }
      const last = notes.filter((n) => n.sentAt && n.sentHead).sort((a, b) => (a.sentAt! < b.sentAt! ? 1 : -1))[0];
      reply({
        ok: true,
        notes: notes.map(({ sentAnchor, ...note }) => ({
          ...note,
          stale: identities.get(note.file) !== note.diffIdentity,
          ...(note.sentAt && sentAnchor && { fixed: this.reviewAnchor(context.spec, note, identities.get(note.file) ?? null) !== sentAnchor }),
        })),
        ...(last?.sentHead && { sentHead: last.sentHead }),
      });
    } catch (err) {
      if (!(err instanceof RepoError || err instanceof ReviewNotesError)) console.warn(`[cld repo] review notes: ${String(err)}`);
      reply({ ok: false, notes: [], error: err instanceof Error ? err.message : koText('review_notes_unreadable') });
    }
  }

  private async writeReviewNote(req: ReviewNoteWrite, send: WsSend, source: string): Promise<void> {
    const reply = (rest: Omit<ReviewNoteResult, 'type' | 'requestId' | 'project' | 'task' | 'op'>) =>
      send({ type: 'reviewNoteResult', requestId: req.requestId, project: req.project, task: req.task, op: req.op, ...rest });
    try {
      const context = await this.reviewContext(req.project, req.task);
      let id: string | undefined;
      if (req.op === 'add') {
        if (!req.file || !context.files.has(req.file)) throw new ReviewNotesError('review_note_invalid');
        const identity = await this.reviewIdentity(context.spec, req.file);
        if (!identity) throw new ReviewNotesError('review_note_invalid');
        id = this.reviewNotes.add(req.project, req.task, {
          file: req.file,
          side: 'new',
          ...(req.startLine !== undefined && { startLine: req.startLine }),
          line: req.line ?? 0,
          body: req.body ?? '',
        }, source, identity).id;
      } else if (req.op === 'edit') {
        const note = this.reviewNotes.list(req.project, req.task).find((item) => item.id === req.id);
        if (!note || !context.files.has(note.file)) throw new ReviewNotesError('review_note_missing');
        const identity = await this.reviewIdentity(context.spec, note.file);
        if (!identity) throw new ReviewNotesError('review_note_invalid');
        id = this.reviewNotes.edit(req.project, req.task, req.id ?? '', req.body ?? '', identity).id;
      } else {
        this.reviewNotes.delete(req.project, req.task, req.id ?? '');
        id = req.id;
      }
      reply({ ok: true, ...(id && { id }) });
      void this.broadcastReviewNotes(req.project, req.task);
    } catch (err) {
      if (!(err instanceof RepoError || err instanceof ReviewNotesError)) console.warn(`[cld repo] review note write: ${String(err)}`);
      reply({ ok: false, ...(err instanceof Error ? { error: err.message } : { error: koText('review_notes_unreadable') }) });
    }
  }

  /** Step ④: one task worktree's unsent notes to its agent; they are marked sent only when queued. */
  async sendReview(req: ReviewSend, send: WsSend, source: string): Promise<void> {
    const reply = (rest: Omit<ReviewSendResult, 'type' | 'requestId' | 'project' | 'task'>) =>
      send({ type: 'reviewSendResult', requestId: req.requestId, project: req.project, task: req.task, ...rest });
    const out = await this.deliverReview(req.project, req.task, source);
    reply(out.ok ? { ok: true, to: out.to, count: out.sent.length, delivered: out.delivered, moved: out.moved } : out);
  }

  /** Deliver a task worktree's unsent notes (`only`: that one note; `lead`: the Lead wrote it) and
   *  mark them sent with the worktree's commit and each note's anchor. Never rejects. */
  private async deliverReview(
    project: string,
    task: string,
    source: string,
    o: { only?: string; lead?: string } = {},
  ): Promise<ReviewSendOutcome> {
    const key = this.reviewKey(project, task);
    let mine = false;
    try {
      if (this.o.readOnly) return { ok: false, ...refused('read_only_mode') };
      if (!this.o.reviewSend) return { ok: false, ...refused('not_engine_project') };
      if (this.reviewSending.has(key)) return { ok: false, ...refused('project_busy', { name: project }) };
      this.reviewSending.add(key);
      mine = true;
      const context = await this.reviewContext(project, task); // the worktree is there now
      const rec = this.worktrees
        .all()
        .find((r) => r.project === project && r.task === task && r.status === 'active');
      const notes = this.reviewNotes.list(project, task).filter((note) => !note.sentAt && (!o.only || note.id === o.only));
      const sentHead = context.spec.exists ? await this.headWithWork(context.spec.path) : undefined;
      const anchors = new Map<string, string>();
      for (const note of notes) {
        const identity = note.line === 0 && context.files.has(note.file) ? await this.reviewIdentity(context.spec, note.file) : null;
        anchors.set(note.id, this.reviewAnchor(context.spec, note, identity));
      }
      const out = await this.o.reviewSend({
        project,
        worktree: task,
        ...(rec?.taskId && { taskId: rec.taskId }),
        ...(rec?.assignmentId && { assignmentId: rec.assignmentId }),
        notes,
        source,
        ...(o.lead && { lead: o.lead }),
      });
      if (!out.ok) {
        this.log(`reviewSend ${JSON.stringify(project).slice(0, 66)} ${task}: refused (${out.error}) ${source}`);
        return out;
      }
      this.reviewNotes.markSent(project, task, out.sent, { ...(sentHead && { sentHead }), anchors });
      this.log(`reviewSend ${JSON.stringify(project).slice(0, 66)} ${task}: ${out.sent.length} to ${out.to} (${out.delivered}) ${source}`);
      void this.broadcastReviewNotes(project, task);
      return out;
    } catch (err) {
      if (!(err instanceof RepoError || err instanceof ReviewNotesError)) console.warn(`[cld repo] review send: ${String(err)}`);
      return { ok: false, error: err instanceof Error ? err.message : koText('review_notes_unreadable') };
    } finally {
      if (mine) this.reviewSending.delete(key);
    }
  }

  /**
   * P4 MCP add_review_note (owner 11-01 02:17): the project Lead's note on task worktree `task`'s
   * changes, written as `agent:<lead>` and sent to the Worker at once (one line in the Lead's
   * rooms). The Task then merges only on the owner's click (hasReviewNotes).
   */
  async leadReviewNote(input: {
    project: string;
    task: string;
    file: string;
    line: number;
    startLine?: number;
    body: string;
    lead: string;
  }): Promise<{ ok: true; id: string; to: string; delivered: string } | ({ ok: false; error: string; code: string } & Coded)> {
    const source = `mcp:${input.lead}`;
    let id: string;
    try {
      if (this.o.readOnly) return { ok: false, code: 'read_only', ...refused('read_only_mode') };
      const context = await this.reviewContext(input.project, input.task);
      if (!context.files.has(input.file)) throw new ReviewNotesError('review_note_invalid');
      const identity = await this.reviewIdentity(context.spec, input.file);
      if (!identity) throw new ReviewNotesError('review_note_invalid');
      id = this.reviewNotes.add(input.project, input.task, {
        file: input.file,
        side: 'new',
        ...(input.startLine !== undefined && { startLine: input.startLine }),
        line: input.line,
        body: input.body,
      }, `agent:${input.lead}`, identity).id;
    } catch (err) {
      if (!(err instanceof RepoError || err instanceof ReviewNotesError)) console.warn(`[cld repo] lead review note: ${String(err)}`);
      return { ok: false, code: 'refused', error: err instanceof Error ? err.message : koText('review_notes_unreadable') };
    }
    const out = await this.deliverReview(input.project, input.task, source, { only: id, lead: input.lead });
    if (!out.ok) {
      void this.broadcastReviewNotes(input.project, input.task);
      return { ...out, code: out.errorCode ?? 'not_sent' };
    }
    return { ok: true, id, to: out.to, delivered: out.delivered };
  }

  private async broadcastReviewNotes(project: string, task: string): Promise<void> {
    const sends = this.reviewViews.get(this.reviewKey(project, task));
    if (!sends?.size) return;
    for (const send of sends)
      await this.listReviewNotes({ type: 'reviewNotesRequest', requestId: '', project, task }, send, false, false);
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
          : action === 'conflictHandoff'
            ? await this.handoff(req, privileged, source)
            : SYNC_ACTIONS.has(action)
              ? await this.write(name, privileged, source, action, (proj) => this.syncAction(req, proj))
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
      ...(out.conflicts && { conflicts: out.conflicts }),
      ...(out.cleaned && { cleaned: true }),
    };
  }

  /** The active record of task worktree `task`, its folder checked to be a registered worktree. */
  private async taskWorktree(proj: ProjectFolder, task: string) {
    const rec = this.worktrees
      .all()
      .find((r) => r.project === proj.name && r.task === task && r.status === 'active');
    if (!rec) throw new RepoError(koText('worktree_missing'));
    const spec = await this.spec(proj, task);
    return { rec, spec };
  }

  /** P4: sync / resolve / mergeContinue / mergeAbort inside the task worktree (conflicts.ts). */
  private async syncAction(req: RepoAction, proj: ProjectFolder): Promise<WriteResult> {
    const { rec, spec } = await this.taskWorktree(proj, req.task ?? '');
    if (!spec.exists) throw new RepoError(koText('worktree_missing'));
    let out: SyncOutcome;
    if (req.action === 'sync') {
      if (FULL_SHA.test(rec.base)) return { ok: false, code: 'no_base', ...refused('merge_no_base') };
      const who = rec.assignmentId && this.o.nameOf?.(rec.assignmentId);
      out = await syncBase(this.run, spec.path, rec.base, !!who && !!this.o.agentBusy?.(who));
    } else if (req.action === 'resolve') {
      if (!req.path || !req.choices) return { ok: false, code: 'bad_args', ...refused('conflict_file_unknown') };
      out = await resolveFile(this.run, spec.path, req.path, req.choices);
    } else if (req.action === 'mergeContinue') out = await continueMerge(this.run, spec.path);
    else out = await abortMerge(this.run, spec.path);
    return {
      ok: out.ok,
      ...(out.code && { code: out.code }),
      ...(out.error && { error: out.error }),
      ...(out.detail && { detail: out.detail }),
      ...(out.conflicts && { conflicts: out.conflicts }),
    };
  }

  /** P4 에이전트에게 맡기기: the conflicting files to the worktree's agent, one Lead line, Task to doing. */
  private async handoff(req: RepoAction, privileged: boolean, source: string): Promise<WriteResult> {
    const proj = this.project(req.project);
    const refusal = this.refusal(proj, req.project, privileged, true);
    if (refusal || !proj) return { ok: false, ...(refusal ?? { code: 'unknown_project', error: koText('project_unregistered') }) };
    if (!this.o.conflictHandoff) return { ok: false, code: 'no_engine', ...refused('not_engine_project') };
    try {
      const { rec } = await this.taskWorktree(proj, req.task ?? '');
      if (FULL_SHA.test(rec.base)) return { ok: false, code: 'no_base', ...refused('merge_no_base') };
      const files = await mergeConflicts(this.run, await repoRoot(this.run, proj.folder), rec.branch, rec.base);
      if (!files.length) return { ok: false, code: 'no_conflict', ...refused('conflict_none', { base: rec.base }) };
      const out = await this.o.conflictHandoff({
        project: proj.name,
        worktree: rec.task,
        ...(rec.taskId && { taskId: rec.taskId }),
        ...(rec.assignmentId && { assignmentId: rec.assignmentId }),
        base: rec.base,
        files,
        source,
      });
      this.log(`conflictHandoff ${JSON.stringify(proj.name).slice(0, 66)} ${rec.task}: ${out.ok ? `to ${out.to}` : `refused (${out.error})`} ${source}`);
      return out.ok
        ? { ok: true, detail: koText('handoff_done', { to: out.to ?? '' }) }
        : { ok: false, code: out.errorCode ?? 'refused', error: out.error ?? koText('handoff_no_target') };
    } catch (err) {
      if (!(err instanceof RepoError)) console.warn(`[cld repo] handoff: ${String(err)}`);
      return { ok: false, code: 'git_failed', error: err instanceof RepoError ? err.message : koText('git_run_failed') };
    }
  }

  /** P4 병합 tab: whether task worktree `task` merges now, and how (nothing changes). */
  private async mergeCheck(req: { requestId: string; project: string; task: string }): Promise<RepoMergeCheckResult> {
    const head = { type: 'repoMergeCheckResult' as const, requestId: req.requestId, project: req.project, task: req.task };
    const proj = this.project(req.project);
    if (!proj) return { ...head, ok: false, ...refused('project_unregistered') };
    try {
      const { rec, spec } = await this.taskWorktree(proj, req.task);
      if (FULL_SHA.test(rec.base)) return { ...head, ok: false, ...refused('merge_no_base') };
      const top = await repoRoot(this.run, proj.folder);
      const w = await this.worktrees.status(proj, req.task);
      if (!w) throw new RepoError(koText('worktree_missing'));
      const kind = w.merged ? 'already' : w.behind === 0 ? 'ff' : 'merge';
      const conflicts = kind === 'merge' ? await mergeConflicts(this.run, top, rec.branch, rec.base) : [];
      let notes: ReviewNote[] = [];
      try {
        notes = this.reviewNotes.list(proj.name, req.task);
      } catch {
        /* unreadable notes: counted by the merge's own lock */
      }
      // A sent note counts as being fixed until its anchored lines changed (no anchor: unknown, so yes).
      let fixing = 0;
      for (const n of notes.filter((x) => x.sentAt)) {
        const identity = n.line === 0 ? await this.reviewIdentity(spec, n.file) : null;
        if (!n.sentAnchor || this.reviewAnchor(spec, n, identity) === n.sentAnchor) fixing++;
      }
      return {
        ...head,
        ok: true,
        target: rec.base,
        clean: conflicts.length === 0,
        conflicts,
        behind: w.behind,
        ahead: w.ahead,
        dirty: w.dirty,
        kind,
        ...(kind === 'merge' && { subject: `Merge branch '${rec.branch}' into ${rec.base}` }),
        reviewNotes: notes.length,
        notesFixing: fixing,
      };
    } catch (err) {
      if (!(err instanceof RepoError)) console.warn(`[cld repo] merge check: ${String(err)}`);
      return { ...head, ok: false, error: err instanceof RepoError ? err.message : koText('git_run_failed') };
    }
  }

  /** P4: the sync merge's conflicts in task worktree `task`. */
  private async conflicts(req: { requestId: string; project: string; task: string }): Promise<RepoConflictsResult> {
    const head = { type: 'repoConflictsResult' as const, requestId: req.requestId, project: req.project, task: req.task };
    const proj = this.project(req.project);
    if (!proj) return { ...head, ok: false, ...refused('project_unregistered') };
    try {
      const { spec } = await this.taskWorktree(proj, req.task);
      if (!spec.exists) throw new RepoError(koText('worktree_missing'));
      return { ...head, ok: true, ...(await listConflicts(this.run, spec.path)) };
    } catch (err) {
      if (!(err instanceof RepoError)) console.warn(`[cld repo] conflicts: ${String(err)}`);
      return { ...head, ok: false, error: err instanceof RepoError ? err.message : koText('git_run_failed') };
    }
  }

  /** P4 작업 폴더 정리: merged or idle worktrees, sized now. */
  private async cleanupList(req: { requestId: string; project: string }): Promise<RepoCleanupListResult> {
    const head = { type: 'repoCleanupListResult' as const, requestId: req.requestId, project: req.project };
    const proj = this.project(req.project);
    if (!proj) return { ...head, ok: false, ...refused('project_unregistered') };
    try {
      const top = await repoRoot(this.run, proj.folder);
      const rows = await cleanupRows(
        (await this.worktreeRows(proj, top, false)).map((w) => {
          const m = this.history.last(proj.name, w.task);
          return {
            worktree: w,
            ...(m?.ok && { mergedAt: m.at }),
            changedFiles: async () => (await readWorktreeDetail(this.run, top, w)).files.length,
          };
        }),
      );
      return { ...head, ok: true, rows };
    } catch (err) {
      if (!(err instanceof RepoError)) console.warn(`[cld repo] cleanup list: ${String(err)}`);
      return { ...head, ok: false, error: err instanceof RepoError ? err.message : koText('git_run_failed') };
    }
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
   * remote's default, the owner's `protected-branches.json`) and a Task with review notes are never
   * merged automatically, and a person's click on a protected base from a remote device needs a
   * fresh step-up. Never rejects.
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

  /** Owner decision 11-01 02:17: a Task with review notes (sent or not) merges only on the owner's
   *  click. Notes that cannot be read count as notes: never merged by mistake. */
  private hasReviewNotes(project: string, task: string): boolean {
    try {
      return this.reviewNotes.list(project, task).length > 0;
    } catch {
      return true;
    }
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
      else if (o.auto && this.hasReviewNotes(proj.name, rec.task))
        out = { ok: false, code: 'review_notes', ...refused('merge_review_notes') };
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
    const cleaned = out.ok && (await this.cleanAfterMerge(proj, rec.task, o.source));
    void this.refresh(proj.name, true);
    const short = out.sha?.slice(0, 7);
    const detail = !out.ok
      ? undefined
      : out.kind === 'already'
        ? koText('merge_already', { branch: rec.branch, target })
        : out.kind === 'ff'
          ? `${target} ← ${rec.branch} (fast-forward, ${short})`
          : koText('merge_done_commit', { target, branch: rec.branch, short: short ?? '' });
    return {
      ok: out.ok,
      ...(out.code && { code: out.code }),
      ...(out.error && { error: out.error }),
      ...(detail && { detail }),
      ...(cleaned && { cleaned: true }),
    };
  }

  /** P4 (owner 11-01, default on): after a merge, a merged and clean worktree goes (its merged
   *  branch with it); anything else stays. Never throws. */
  private async cleanAfterMerge(proj: ProjectFolder, task: string, source: string): Promise<boolean> {
    if (!this.o.autoCleanup?.()) return false;
    try {
      const r = await this.worktrees.cleanup(proj, task);
      this.log(`autoCleanup ${JSON.stringify(proj.name).slice(0, 66)} ${task}: ${r.ok ? 'removed' : 'kept'} ${source}`);
      if (r.ok) this.reviewNotes.remove(proj.name, task);
      return r.ok;
    } catch (err) {
      console.warn(`[cld repo] auto-cleanup ${task}: ${String(err)}`);
      return false;
    }
  }

  private async perform(req: RepoAction, proj: ProjectFolder): Promise<Outcome> {
    if (req.action === 'worktreeRemove') {
      if (!req.task) throw new RepoError(koText('task_name_needed'));
      const r = await this.worktrees.cleanup(proj, req.task, { force: req.force === true });
      if (r.ok) {
        try {
          this.reviewNotes.remove(proj.name, req.task);
        } catch (err) {
          console.warn(`[cld repo] review notes not removed: ${String(err)}`);
        }
      }
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
