/**
 * W2: the one operation "a worktree for a Task" (B §2 Worktree, F-16), used by
 * the 작업실 (repoAction `worktreeNew`), `agty worktree new` and
 * `delegate_task({ task: { worktree: 'new' } })`: in the Task's project, the
 * git layer's createForTask (branch `feat/t<id>-<slug>` from the main branch or
 * a named base, `.worktrees/`, refusals there), through RepoManager.write (the
 * gates every repository write has: read-only daemon, privileged caller, known
 * project, one write per repository). The Task then reports its `branch` and
 * `worktree` (written as `reported`, by the caller); the record holds who it is
 * given to.
 *
 * What giving a worktree to an agent does (assignment id in the record, never a
 * running session's cwd moved):
 *   - a Claude Worker starts in it on its next start (Engine's `assignedFolder`);
 *   - a Codex Worker's runs for that Task run in it (CodexAgent's `taskWorktree`);
 *   - the Lead: recorded only (its session's folder is the project's).
 */
import { koText } from '../../../../core/src/agent-tycoon/serverText.js';
import type { BoardTask } from '../../../../core/src/messages.js';
import { CLI_NAME } from '../cliName.js';
import type { RepoManager, WriteResult } from './git/repoManager.js';
import { WORKTREES_DIR } from './git/worktrees.js';
import type { RosterAgent } from './mcpTools.js';
import type { TaskStore } from './tasks.js';

type Reply = Record<string, unknown> & { ok: boolean };
const refuse = (code: string, error: string) => ({ ok: false as const, code, error });

export interface TaskWorktreeDeps {
  tasks: Pick<TaskStore, 'get' | 'add' | 'update' | 'attach' | 'corrupt' | 'unwritable'>;
  repos: Pick<RepoManager, 'write' | 'worktrees' | 'project'>;
  /** Every engine agent now (the Lead's name is its project's). */
  roster(): RosterAgent[];
  /** W2 (N5, N6): `a` may be working in Task `taskId`'s worktree: running, about to (on but
   *  down), or (a Codex Worker) resting with a run for that Task to continue. Default: running
   *  or, not a Codex Worker, on. */
  holds?(a: RosterAgent, taskId: string): boolean;
  /** W2 (N6): worktrees just given (project + Task → assignment and until when): the gap before
   *  the agent's start or delivery shows. Kept by the caller across calls. */
  claims?: Map<string, { assignmentId: string; until: number }>;
  now?(): number;
}

/** How long a just-given worktree counts as held while its agent has not started (N6). */
export const CLAIM_MS = 2 * 60_000;

const defaultHolds = (a: RosterAgent) =>
  a.role !== 'lead' && (a.live || (a.provider !== 'codex' && a.wantRunning));

export interface TaskWorktreeRequest {
  /** '' with `title` (DV4 새 워크트리): a new Task of `project`, made once the checks pass. */
  taskId: string;
  title?: string;
  project?: string;
  /** DV4: the branch the owner named (Worktrees.createForTask `branch`). */
  branch?: string;
  /** The agent (a name) it is given to; none: nobody yet. */
  assignee?: string | null;
  base?: string;
  slug?: string;
  /** The caller's project (an agent's token); null or absent: the owner. */
  scope?: string | null;
  /** Who writes, for the Task's history (`gui:<device>`, `cli`, an agent's name). */
  by: string;
  /** For the record: `user`, `cli`, `agent:<name>`. */
  createdBy: string;
  /** delegate_task: a Task that already has its worktree gives that one to `assignee`. */
  reuse?: boolean;
}

export type TaskWorktreeResult = WriteResult & {
  project?: string;
  taskId?: string;
  task?: string;
  path?: string;
  branch?: string;
  base?: string;
  assignee?: string;
  assignmentId?: string;
  reused?: boolean;
  /** What the assignment means for that agent (assignmentNote). */
  note?: string;
};

/** What the assignment means for that agent, in a few words (the toast, the CLI, the result). */
export function assignmentNote(a: Pick<RosterAgent, 'role' | 'provider' | 'live' | 'name'>): string {
  if (a.role === 'lead') return `${a.name}(Lead)에게 배정했어요. Lead 의 세션 폴더는 그대로예요`;
  if (a.provider === 'codex') return `${a.name} 에게 배정했어요. 이 Task 의 Codex 실행은 이 worktree 에서 돌아요`;
  return a.live
    ? `${a.name} 에게 배정했어요. 켜져 있는 세션은 옮기지 않고, 다음에 켤 때 이 worktree 에서 시작해요`
    : `${a.name} 에게 배정했어요. 다음에 켤 때 이 worktree 에서 시작해요`;
}

/** Task `taskId`'s worktree, made (or with `reuse`, the one it has) and given to `assignee`. Never rejects. */
export async function worktreeForTask(
  d: TaskWorktreeDeps,
  req: TaskWorktreeRequest,
  privileged: boolean,
  source: string,
): Promise<TaskWorktreeResult> {
  // The Task must be able to say where its work is: no worktree it could not record.
  const blocked = d.tasks.corrupt ?? d.tasks.unwritable;
  if (blocked) return refuse('store_unwritable', blocked);
  const fresh = !req.taskId && !!req.title?.trim() && !!req.project;
  const found: BoardTask | undefined = fresh ? undefined : d.tasks.get(req.taskId);
  if (!fresh && !found) return refuse('unknown_task', `'${req.taskId}' 작업이 없습니다`);
  const project = found?.project ?? req.project!;
  if (req.scope && project !== req.scope)
    return { ok: false as const, code: 'out_of_scope', error: koText('task_other_project', { task: found?.id ?? '' }) };
  let agent: RosterAgent | undefined;
  if (req.assignee) {
    agent = d.roster().find((a) => a.name === req.assignee);
    if (!agent?.assignmentId) return refuse('unknown_agent', `'${req.assignee}' 에이전트가 없습니다`);
    if (agent.project !== project)
      return { ok: false as const, code: 'out_of_scope', error: koText('agent_other_project', { name: agent.name, project }) };
  }
  const wts = d.repos.worktrees;
  return d.repos.write(project, privileged, source, 'worktreeNew', async (proj) => {
    // DV4: the owner's branch is checked before its Task is made (a refusal leaves nothing).
    if (req.branch !== undefined) await wts.check(proj, req.branch, req.base);
    let task = found;
    if (!task) {
      const made = d.tasks.add({ project: proj.name, title: req.title!.trim() }, req.by, d.now?.() ?? Date.now(), { createdBy: req.createdBy });
      if (!made.ok) return refuse(String(made.code ?? 'refused'), String(made.error ?? ''));
      task = made.task as BoardTask;
    }
    const had = wts.forTask(proj.name, task.id);
    if (had && !req.reuse)
      return refuse('exists', `Task ${task.id} 에는 이미 worktree 가 있어요: ${WORKTREES_DIR}/${had.task}`);
    // One Task, one worktree (F-16): never shared with an agent that may be working in it. A
    // stopped holder gives it up (it starts in its project's folder next time).
    const now = d.now?.() ?? Date.now();
    const key = `${proj.name}\0${task.id}`;
    const holder = had?.assignmentId && had.assignmentId !== agent?.assignmentId
      ? d.roster().find((a) => a.assignmentId === had.assignmentId)
      : undefined;
    const claim = d.claims?.get(key);
    const claimed = !!claim && claim.assignmentId === holder?.assignmentId && claim.until > now;
    if (holder && (claimed || (d.holds ?? defaultHolds)(holder, task.id)))
      return refuse(
        'worktree_in_use',
        `Task ${task.id} 의 worktree(${WORKTREES_DIR}/${had!.task})는 ${holder.name} 가 쓰고 있거나 곧 쓸 거예요. ${holder.name} 를 멈춘 뒤에 다시 맡겨 주세요`,
      );
    const made = () =>
      had
        ? agent
          ? wts.assign(proj, had.task, agent.assignmentId)
          : Promise.resolve(had)
        : wts.createForTask(proj, {
            taskId: task.id,
            title: task.title,
            ...(req.slug !== undefined && { slug: req.slug }),
            ...(req.base !== undefined && { base: req.base }),
            ...(req.branch !== undefined && { branch: req.branch }),
            ...(agent?.assignmentId && { assignmentId: agent.assignmentId }),
            createdBy: req.createdBy,
          });
    let rec: Awaited<ReturnType<typeof made>>;
    try {
      rec = await made();
    } catch (err) {
      // DV4: the Task just made stays on the board (as delegate_task's does); the refusal names it.
      if (found) throw err;
      const why = err instanceof Error ? err.message : String(err);
      return { ok: false as const, code: 'worktree_failed', error: koText('task_without_worktree', { task: task.id, why }) };
    }
    if (agent?.assignmentId) d.claims?.set(key, { assignmentId: agent.assignmentId, until: now + CLAIM_MS });
    // The Task says where its work is (a report, by the caller); the daemon observes git later.
    const up = d.tasks.update(task.id, { branch: rec.branch, worktree: rec.path }, req.by);
    const notes = [
      `${rec.branch} · ${WORKTREES_DIR}/${rec.task}`,
      ...(agent ? [assignmentNote(agent)] : []),
      ...(up.ok ? [] : [`Task 에 적지 못했어요: ${String(up.error)}`]),
    ];
    return {
      ok: true,
      detail: notes.join(' · '),
      project: proj.name,
      taskId: task.id,
      task: rec.task,
      path: rec.path,
      branch: rec.branch,
      base: rec.base,
      ...(agent?.assignmentId && { assignee: agent.name, assignmentId: agent.assignmentId, note: assignmentNote(agent) }),
      ...(had && { reused: true }),
    };
  });
}

/** DV4: what seating an agent needs beyond worktreeForTask (office.ts wires the engine and the messenger). */
export interface SeatDeps extends TaskWorktreeDeps {
  /** `run`: one process per message (its runs for the Task go to the worktree by themselves);
   *  else a session that stays, which starts in its worktree (Engine's `assignedFolder`). */
  lifetime(name: string): 'session' | 'run' | undefined;
  /** The engine's own start / restart, and `pty`: its move of a Claude agent into our terminal
   *  host (engine.run, the gates every engine action has). */
  engineAction(action: 'start' | 'restart' | 'pty', name: string): Promise<{ ok: boolean; error?: string; note?: string }>;
  /** T-70: `name`'s session works in `folder` already (seating it there moves nothing). */
  worksIn(name: string, folder: string): boolean;
  /** T-70: `name` is a Claude agent still on `claude --bg` while our terminal host is here. */
  oldStyle(name: string): boolean;
  /** The messenger's send of the owner's words (queued until the session can take them). */
  send(req: { to: string; text: string; task: string }): Promise<{ ok: boolean; error?: unknown }>;
}

export interface SeatRequest extends TaskWorktreeRequest {
  /** The assignee starts working there now: started, or restarted when it is on (a session moves
   *  only at its start). A Task that already has its worktree gives that one (no `branch`). */
  seat?: boolean;
  /** The first instruction, to the seated agent through the messenger, after its start. */
  text?: string;
}

/**
 * DV4 (M1 새 워크트리, M2 앉히기): the owner's direct path beside the Lead's delegate_task, through
 * the same steps: the Task's worktree given to the agent (worktreeForTask), the Task's assignee,
 * then the engine's start or restart so its session works in that folder, then the messenger.
 * The agent's other worktrees of the project stop being its own (one agent, one worktree).
 * Never rejects.
 */
export async function seatInWorktree(d: SeatDeps, req: SeatRequest, privileged: boolean, source: string): Promise<TaskWorktreeResult> {
  // The Lead works in its project's own folder: it is never seated (nor restarted for it).
  if (req.seat && req.assignee && d.roster().find((x) => x.name === req.assignee)?.role === 'lead')
    return { ok: false, code: 'seat_lead', error: koText('seat_lead') };
  const r = await worktreeForTask(d, { ...req, reuse: !!req.seat && req.branch === undefined }, privileged, source);
  if (!r.ok || !req.seat || !r.assignee || !r.assignmentId || !r.taskId || !r.project || !r.task) return r;
  const { assignee: name, assignmentId, taskId, project } = r;
  const notes = [`${r.branch} · ${WORKTREES_DIR}/${r.task}`];
  const wts = d.repos.worktrees;
  const proj = d.repos.project(project);
  // One agent, one worktree: its older ones (and their Tasks) are no longer its own.
  for (const w of wts.all()) {
    if (!proj || w.project !== project || w.status !== 'active' || w.assignmentId !== assignmentId || w.task === r.task) continue;
    await wts.assign(proj, w.task, null).catch((err: unknown) => notes.push(`${w.task}: ${String(err)}`));
    const old = w.taskId ? d.tasks.get(w.taskId) : undefined;
    if (old?.assignee?.assignmentId === assignmentId) d.tasks.update(old.id, { assignee: null }, req.by);
  }
  d.tasks.update(taskId, { assignee: { assignmentId, name } }, req.by);
  d.tasks.attach(taskId, { kind: 'agent', ref: assignmentId }, req.by);
  const a = d.roster().find((x) => x.name === name);
  let send = true;
  // T-70: a session already in this worktree is left as it is (the 개발실 just opens its terminal).
  if (a?.live && r.path && d.worksIn(name, r.path)) notes.push(koText('seat_already_there', { name }));
  else if (a && d.lifetime(name) !== 'run') {
    // T-70: the owner's seat opens its terminal, so a Claude agent still on `claude --bg` moves into
    // our host first (the engine's own move: same conversation, a busy one refused with the reason).
    if (d.oldStyle(name)) {
      const m = await d.engineAction('pty', name);
      if (!m.ok) notes.push(koText('seat_pty_failed', { name, why: m.error ?? '' }));
    }
    const on = await d.engineAction(a.live ? 'restart' : 'start', name);
    const why = on.error ?? '';
    if (on.ok) notes.push(koText(a.live ? 'seat_restarted' : 'seat_started', { name }), ...(on.note ? [on.note] : []));
    // Still in its old folder: the instruction would be worked there, so it waits for the owner.
    else if (a.live && req.text?.trim()) {
      send = false;
      notes.push(koText('seat_restart_failed', { name, why }));
    } else notes.push(koText('seat_start_failed', { name, why }));
  }
  if (send && req.text?.trim()) {
    const sent = await d.send({ to: name, text: req.text, task: taskId });
    notes.push(sent.ok ? koText('seat_text_sent') : koText('seat_text_failed', { why: String(sent.error ?? '') }));
  }
  return { ...r, detail: notes.join(' · ') };
}

/**
 * `agty worktree new --task <id> [--assign <name>] [--base <branch>]` and
 * `agty worktree list [--task <id>]` over the control socket. An agent's
 * token keeps it to its own project (and agents of it); the owner's CLI sees all.
 */
export async function answerWorktree(
  d: TaskWorktreeDeps & { projects(): string[] },
  a: Record<string, unknown>,
  who: { by: string; agent: string | null; project: string | null },
): Promise<Reply> {
  const str = (x: unknown) => (typeof x === 'string' && x ? x : undefined);
  const scope = who.agent ? who.project : null;
  if (a.op === 'new') {
    const taskId = str(a.task);
    if (!taskId) return refuse('usage', `사용법: ${CLI_NAME} worktree new --task <작업 id> [--assign <에이전트>] [--base <브랜치>] [--branch <종류/영역-하는일>]`);
    const r = await worktreeForTask(
      d,
      {
        taskId,
        assignee: str(a.assign) ?? null,
        ...(str(a.base) && { base: str(a.base) }),
        // The Lead's own naming (type/scope-what) instead of feat/t<id>-<slug>; branchName.ts rules apply.
        ...(str(a.branch) && { branch: str(a.branch) }),
        scope,
        by: who.by,
        createdBy: who.agent ? `agent:${who.agent}` : 'cli',
      },
      true,
      who.agent ? `agent:${who.agent}` : 'cli',
    );
    return r.ok ? r : refuse(r.code ?? 'refused', r.error ?? '');
  }
  if (a.op === 'list') {
    const taskId = str(a.task);
    let names = scope ? [scope] : d.projects();
    if (taskId) {
      const t = d.tasks.get(taskId);
      if (!t || (scope && t.project !== scope)) return refuse('unknown_task', `'${taskId}' 작업이 없습니다`);
      names = [t.project];
    }
    const nameOf = new Map(d.roster().map((x) => [x.assignmentId, x.name]));
    const worktrees: Array<Record<string, unknown>> = [];
    for (const name of names) {
      const proj = d.repos.project(name);
      if (!proj) continue;
      const list = await d.repos.worktrees.list(proj).catch(() => []);
      for (const w of list)
        if (!taskId || w.taskId === taskId)
          worktrees.push({
            project: name,
            ...w,
            ...(w.assignmentId && nameOf.get(w.assignmentId) && { assignee: nameOf.get(w.assignmentId) }),
          });
    }
    return { ok: true, worktrees };
  }
  return refuse('usage', `사용법: ${CLI_NAME} worktree new --task <작업 id> [--assign <에이전트>] [--base <브랜치>] [--branch <종류/영역-하는일>] | worktree list [--task <작업 id>]`);
}

/**
 * W3: the Tasks done now that were not in `seen` (ids; null = the store not read yet, nothing
 * merges): each one's worktree branch merges into its base by itself. RepoManager.merge refuses
 * the automatic request for a protected base and for a Task with review notes (those wait for
 * the owner's 머지 in the 작업실). Returns the done ids to remember and the merges started.
 */
export function mergeNewlyDone(
  tasks: Pick<TaskStore, 'list'>,
  repos: Pick<RepoManager, 'worktrees' | 'merge'>,
  seen: ReadonlySet<string> | null,
): { seen: Set<string> | null; merges: Array<Promise<WriteResult>> } {
  if (!seen) return { seen, merges: [] };
  const done = tasks.list({ status: 'done' });
  const merges: Array<Promise<WriteResult>> = [];
  for (const t of done) {
    if (seen.has(t.id)) continue;
    const rec = repos.worktrees.forTask(t.project, t.id);
    if (rec) merges.push(repos.merge(t.project, rec.task, { privileged: true, source: 'auto', auto: true }));
  }
  return { seen: new Set(done.map((t) => t.id)), merges };
}
