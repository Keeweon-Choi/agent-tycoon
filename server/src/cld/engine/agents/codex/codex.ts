/**
 * The Codex provider (D5, design-d5 §3.2): a Codex Worker is an assignment with
 * `provider: 'codex'` and no session that stays up. One message is one
 * `codex exec` run (the cld-gui codex records and worker, engine/codex.ts):
 * a new Task starts a new thread, anything else continues the Worker's last
 * thread (`exec resume`). Between runs the engine shows a resting session
 * (holder()); the runs are found by assignment id, never by name. The run's
 * record is the Task's Execution (`codex:<run id>`); the daemon tells the Lead
 * how it ended (office.ts). Workers only: a Codex Lead (app-server) is later.
 */
import { spawnSync } from 'child_process';

import { koText } from '../../../../../../core/src/cld/serverText.js';
import { findOnPath } from '../../../providers/claudeProvider.js';
import type { CodexRecord, CodexTasks } from '../../codex.js';
import type { ProjectRecord } from '../../registry.js';
import type {
  AgentCapabilities,
  AgentProvider,
  LiveSession,
  StartResult,
  StopResult,
} from '../types.js';

/** What Codex exec offers (F-11): it never asks (exec), and Codex's own `-s` values. */
export const CODEX_CAPABILITIES: AgentCapabilities = {
  approvalPolicy: ['never'],
  sandbox: ['read-only', 'workspace-write', 'danger-full-access'],
  attach: null,
  resume: true,
  naming: 'none',
  usage: null,
  lifetime: 'run',
};

export const CODEX_MISSING = koText('codex_missing');
/** How long one look for the codex executable is trusted (holder() asks on every refresh). */
const READY_MS = 10_000;

/** The parts of CodexTasks a Worker's runs use. */
export type CodexRuns = Pick<CodexTasks, 'run' | 'runsOf' | 'workerRecords' | 'jobOf'>;

export interface CodexAgentOptions {
  /** Read late: the daemon makes its CodexTasks after the engine. */
  codex: () => CodexRuns | null;
  /** The PATH codex is looked for on (the jobs' environment). */
  path: () => string | undefined;
  /** The project an agent works for (its Lead's name): the runs' attribution and worktree. */
  project: (name: string) => { name: string; folder: string } | null;
  /** D6: the run becomes an Execution of its Task. */
  attach: (task: string, run: { kind: 'codex'; ref: string; log?: string }, by: string) => void;
  /** A Task's title (the run's title). */
  taskTitle: (task: string) => string | undefined;
  /** W2: the worktree recorded for Task `task` (its own or nobody's), where its runs go. */
  taskWorktree?: (
    project: { name: string; folder: string },
    task: string,
    assignmentId: string,
  ) => { path: string; branch: string } | null;
  /** W2 (N5): the folder of the Worker's last run may still be its own: not a daemon worktree
   *  given to another agent since, or removed. Absent: always. */
  mayUse?: (project: { name: string; folder: string }, dir: string, assignmentId: string) => boolean;
  /** Stop the engine job running a run (its worker ends the run as stopped). */
  stopJob: (jobId: string) => { ok: boolean; error?: string };
  log: (line: string) => void;
  platform?: NodeJS.Platform;
}

/** `folder` is in a git repository (git says so: a stray empty .git is not one). */
function inRepo(folder: string): boolean {
  return spawnSync('git', ['rev-parse', '--git-dir'], { cwd: folder, stdio: 'ignore', timeout: 15_000 }).status === 0;
}

const live = (r: CodexRecord) => r.state === 'running' || r.state === 'limit';

export class CodexAgent implements AgentProvider {
  readonly id = 'codex';
  readonly protocol = 'codex' as const;
  readonly capabilities = CODEX_CAPABILITIES;
  private readonly listeners = new Set<() => void>();
  /** Assignments with a run being started (the record is not written yet). */
  private readonly starting = new Set<string>();
  private readyAt = -Infinity;
  private readyWhy: string | null = null;

  constructor(private readonly o: CodexAgentOptions) {}

  /** The Codex records changed (office: CodexTasks' changed). */
  changed(): void {
    for (const cb of this.listeners) cb();
  }

  live(): LiveSession[] {
    return (this.o.codex()?.workerRecords() ?? []).filter(live).map((r) => ({
      id: r.id,
      pid: r.pid ?? 0,
      cwd: r.dir,
      kind: 'background',
      startedAt: Date.parse(r.started) || undefined,
      sessionId: r.sid ?? r.id,
      ...(r.agent && { name: r.agent }),
      status: 'busy',
      ...(r.assignmentId && { assignmentId: r.assignmentId }),
    }));
  }

  liveUnsure(): boolean {
    return false;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  nameMatches(): boolean {
    return false;
  }

  ready(): string | null {
    const now = Date.now();
    if (now - this.readyAt > READY_MS) {
      const bin = this.o.platform === 'win32' ? 'codex.cmd' : 'codex';
      this.readyWhy = findOnPath(bin, this.o.path()) ? null : CODEX_MISSING;
      this.readyAt = now;
    }
    return this.readyWhy;
  }

  /** Never called by the engine for a 'run' provider (an on Worker is a resting session). */
  start(): Promise<StartResult> {
    return Promise.resolve({ ok: true, id: null });
  }

  /** A resting session has nothing to stop; a run's engine job is stopped (state stopped). */
  stop(s: LiveSession): Promise<StopResult> {
    if (s.resting || !s.id) return Promise.resolve({ ok: true });
    const job = this.o.codex()?.jobOf(s.id);
    if (!job) return Promise.resolve({ ok: true });
    const r = this.o.stopJob(job);
    return Promise.resolve(
      r.ok ? { ok: true } : { ok: false, error: r.error ?? koText('run_stop_failed') },
    );
  }

  held(): Promise<boolean> {
    return Promise.resolve(false);
  }

  /** No Claude-shaped transcript: the messenger and the office go by the status alone. */
  transcript(): string {
    return '';
  }

  /** design-d5 §2.2: one message, one run. */
  async deliver(
    p: ProjectRecord,
    text: string,
    o: { task?: string; group?: { id: string; messageId?: string }; messageId?: string },
  ): Promise<'typed' | 'notReady' | 'failed'> {
    const codex = this.o.codex();
    const assignmentId = p.assignmentId;
    if (!codex || !assignmentId) return 'failed';
    if (this.starting.has(assignmentId)) return 'notReady';
    const runs = codex.runsOf(assignmentId);
    if (runs.some(live)) return 'notReady';
    // A run already started for this message (the daemon died before the queue file went).
    const again = o.messageId ? runs.find((r) => r.messageId === o.messageId) : undefined;
    if (again) {
      if (again.task)
        this.o.attach(again.task, { kind: 'codex', ref: again.id, log: again.log }, p.name);
      return 'typed';
    }
    if (this.ready()) return 'failed';
    const project = this.o.project(p.name);
    if (!project) return 'failed';
    const last = runs.at(-1);
    // N5: the last run's worktree given to another agent (or removed) while this one rested: its
    // thread is not continued there; a new thread starts elsewhere, still for that Task.
    const moved = !!last && !!this.o.mayUse && !this.o.mayUse(project, last.dir, assignmentId);
    const fresh = !last || (!!o.task && o.task !== last.task) || moved;
    const task = o.task ?? (fresh && !moved ? undefined : last?.task);
    // A new Task: a new thread in the Task's recorded worktree (W2), else the Worker's own folder,
    // else a new task worktree (open question 3), else (no git) the project folder. Anything
    // else: the last run's thread there.
    const recorded = fresh && o.task ? this.o.taskWorktree?.(project, o.task, assignmentId) : null;
    const where: { cwd: string; worktree: boolean; own: boolean; branch?: string | null } = !fresh
      ? { cwd: last!.dir, worktree: false, own: !!last!.worktree, branch: last!.branch }
      : recorded
        ? { cwd: recorded.path, worktree: false, own: true, branch: recorded.branch }
        : p.workFolder
        ? { cwd: p.workFolder, worktree: false, own: true }
        : task && inRepo(project.folder)
          ? { cwd: project.folder, worktree: true, own: false }
          : { cwd: project.folder, worktree: false, own: false };
    const title = task ? this.o.taskTitle(task) : undefined;
    this.starting.add(assignmentId);
    try {
      const r = await codex.run({
        spec: '',
        model: p.model ?? null,
        effort: p.effort ?? null,
        worktree: where.worktree,
        project: project.name,
        cwd: where.cwd,
        source: 'engine',
        worker: {
          name: p.name,
          assignmentId,
          prompt: text,
          role: p.role,
          ...(p.rulesFile && { rulesFile: p.rulesFile }),
          ...(task && { task }),
          ...(!fresh && last?.sid && { resume: last.sid }),
          ...(o.messageId && { messageId: o.messageId }),
          ...(o.group && { room: o.group }),
          ...(title && { title: `${task} ${title}` }),
          ...(where.own && { ownWorktree: true }),
          ...(where.branch && { branch: where.branch }),
          // Moved off the Task's worktree: a worktree of its own, not recorded as the Task's.
          ...(moved && { taskWorktree: false as const }),
        },
      });
      if (!r.ok || typeof r.id !== 'string') {
        this.o.log(`codex worker "${p.name}": not started (${String(r.error ?? r.code ?? '?')})`);
        return 'failed';
      }
      if (task)
        this.o.attach(
          task,
          { kind: 'codex', ref: r.id, ...(typeof r.log === 'string' && { log: r.log }) },
          p.name,
        );
      this.changed();
      return 'typed';
    } finally {
      this.starting.delete(assignmentId);
    }
  }
}

/** How much of a run's last message the Lead's line carries. */
export const REPORT_MAX = 1_500;
const STATE_WORD: Record<string, string> = { done: '끝남', failed: '실패', stopped: '멈춤' };

/** design-d5 §2.4: the one line the daemon sends a Worker's Lead (under the Worker's name)
 *  when its run ends or waits on a usage limit; null while it runs. */
export function runReport(r: CodexRecord, when: (t: number) => string): string | null {
  if (r.state === 'limit') {
    const reset = r.resetAt ? Date.parse(r.resetAt) : NaN;
    return `Codex 실행 ${r.id} 이(가) 사용량 한도에 걸렸어요. ${
      Number.isFinite(reset) ? `${when(reset)} 리셋 뒤` : '간격을 늘려 가며(최대 1시간) 다시 해 보며'
    } 같은 세션을 이어 가요.`;
  }
  if (!r.ended) return null;
  const facts = [
    `Codex 실행 ${r.id} ${STATE_WORD[r.state] ?? r.state}${r.state === 'stopped' ? '(사용자가 멈췄어요)' : ''}`,
    `exit ${r.exit ?? '?'}`,
    ...(r.worktree ? [`커밋 ${r.commits ?? '?'}개`] : []),
    `폴더 ${r.dir}`,
    ...(r.branch ? [`브랜치 ${r.branch}`] : []),
  ].join(' · ');
  const said = r.summary?.trim();
  return said ? `${facts}\n\n보고(Worker 의 말):\n${said.slice(0, REPORT_MAX)}` : `${facts}\n\n(마지막 메시지가 없어요)`;
}
