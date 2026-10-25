/**
 * W2: the one operation "a worktree for a Task" (B §2 Worktree, F-16), used by
 * the 작업실 (repoAction `worktreeNew`), `cld-gui worktree new` and
 * `delegate_task({ task: { worktree: 'new' } })`: in the Task's project, the
 * git layer's createForTask (branch `task/<id>-<slug>` from the main branch or
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
import type { BoardTask } from '../../../../core/src/messages.js';
import { CLI_NAME } from '../cliName.js';
import type { RepoManager, WriteResult } from './git/repoManager.js';
import { WORKTREES_DIR } from './git/worktrees.js';
import type { RosterAgent } from './mcpTools.js';
import type { TaskStore } from './tasks.js';

type Reply = Record<string, unknown> & { ok: boolean };
const refuse = (code: string, error: string) => ({ ok: false as const, code, error });

export interface TaskWorktreeDeps {
  tasks: Pick<TaskStore, 'get' | 'update' | 'corrupt' | 'unwritable'>;
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
  taskId: string;
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
  const task: BoardTask | undefined = d.tasks.get(req.taskId);
  if (!req.taskId || !task) return refuse('unknown_task', `'${req.taskId}' 작업이 없습니다`);
  if (req.scope && task.project !== req.scope)
    return refuse('out_of_scope', `'${task.id}' 는 다른 프로젝트의 작업이에요`);
  let agent: RosterAgent | undefined;
  if (req.assignee) {
    agent = d.roster().find((a) => a.name === req.assignee);
    if (!agent?.assignmentId) return refuse('unknown_agent', `'${req.assignee}' 에이전트가 없습니다`);
    if (agent.project !== task.project)
      return refuse('out_of_scope', `'${agent.name}' 는 ${task.project} 의 에이전트가 아니에요`);
  }
  const wts = d.repos.worktrees;
  return d.repos.write(task.project, privileged, source, 'worktreeNew', async (proj) => {
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
    const rec = had
      ? agent
        ? await wts.assign(proj, had.task, agent.assignmentId)
        : had
      : await wts.createForTask(proj, {
          taskId: task.id,
          title: task.title,
          ...(req.slug !== undefined && { slug: req.slug }),
          ...(req.base !== undefined && { base: req.base }),
          ...(agent?.assignmentId && { assignmentId: agent.assignmentId }),
          createdBy: req.createdBy,
        });
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

/**
 * `cld-gui worktree new --task <id> [--assign <name>] [--base <branch>]` and
 * `cld-gui worktree list [--task <id>]` over the control socket. An agent's
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
    if (!taskId) return refuse('usage', `사용법: ${CLI_NAME} worktree new --task <작업 id> [--assign <에이전트>] [--base <브랜치>]`);
    const r = await worktreeForTask(
      d,
      {
        taskId,
        assignee: str(a.assign) ?? null,
        ...(str(a.base) && { base: str(a.base) }),
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
  return refuse('usage', `사용법: ${CLI_NAME} worktree new --task <작업 id> [--assign <에이전트>] [--base <브랜치>] | worktree list [--task <작업 id>]`);
}
