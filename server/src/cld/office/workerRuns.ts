/** Worker runs and Task worktrees: which agent holds which assignment and worktree, and the end of a Worker's run told to its Lead. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runReport } from '../engine/agents/codex/codex.js';
import type { CodexRecord } from '../engine/codex.js';
import type { CodexTasks } from '../engine/codex.js';
import { readCodex } from '../engine/codex.js';
import type { Engine } from '../engine/engine.js';
import { shortStamp } from '../engine/events.js';
import type { RepoManager } from '../engine/git/repoManager.js';
import { TASK_PATTERN, worktreePath } from '../engine/git/worktrees.js';
import type { GroupMessages } from '../engine/groupMessages.js';
import type { JobRecord, Jobs } from '../engine/jobs.js';
import type { Messenger } from '../engine/messenger.js';
import { writeAtomic } from '../engine/messenger.js';
import { cliOf, loadRegistry, registryPath } from '../engine/registry.js';
import type { TaskStore } from '../engine/tasks.js';
import type { TaskWorktreeDeps } from '../engine/taskWorktree.js';
import { mergeNewlyDone } from '../engine/taskWorktree.js';

interface WorkerRunsDeps {
  opts: { home?: string; readOnly: boolean };
  tasks(): TaskStore;
  repos(): RepoManager;
  engine(): Engine | null;
  codex(): CodexTasks | null;
  jobs(): Jobs | null;
  messenger(): Messenger | null;
  groupMessages(): GroupMessages | null;
}

export class WorkerRuns {
  /** D5: Worker runs whose end or limit is being told to their Lead right now. */
  private readonly telling = new Set<string>();
  /** D5: Worker runs whose end was told (read once from <id>.told, never again). */
  private readonly toldEnd = new Set<string>();
  /** D6: the agents' assignment ids by name, read from the engine's registry while its files stay the same. */
  private assignmentCache: {
    sig: string;
    map: Map<string, string> | null;
    /** CH-3: each registry name's agent provider (its first look's mascot). */
    providers: Map<string, string>;
  } | null = null;

  constructor(private readonly deps: WorkerRunsDeps) {}

  /** W3: the Tasks seen done, read from the store at construction. */
  seedDoneTasks(): void {
    this.doneTasks = new Set(this.deps.tasks().list({ status: 'done' }).map((t) => t.id));
  }

  /** CH-3: an engine name's agent provider from the registry (null: unknown). */
  providerOfName(name: string): string | null {
    this.assignments();
    return this.assignmentCache?.providers.get(name) ?? null;
  }

  /**
   * D6: every agent's assignment id by name (a Lead's and a Worker's), from the
   * engine's registry files (the engine writes them on each change); null when
   * the engine is off or its registry cannot be read.
   */
  /** The name assignment `id` answers to now. */
  nameOfAssignment(id: string): string | undefined {
    for (const [name, a] of this.assignments() ?? []) if (a === id) return name;
    return undefined;
  }

  /** W3: the Tasks seen done (null until the store is read): a newly done one merges. */
  private doneTasks: Set<string> | null = null;

  /** W3: a Task newly done: its worktree's branch merges into its base, automatically (never into
   *  a protected branch, never a Task with review notes: those wait for the owner's click in the
   *  작업실). The merges never reject; their outcome is in the merge history. */
  mergeDoneTasks(): void {
    if (this.deps.opts.readOnly) return;
    this.doneTasks = mergeNewlyDone(this.deps.tasks(), this.deps.repos(), this.doneTasks).seen;
  }

  /** W2 (N6): worktrees just given, until their agent starts (taskWorktree.ts CLAIM_MS). */
  private readonly worktreeClaims = new Map<string, { assignmentId: string; until: number }>();

  /** W2: what "a worktree for a Task" works with (taskWorktree.ts). */
  taskWorktreeDeps(): TaskWorktreeDeps {
    return {
      tasks: this.deps.tasks(),
      repos: this.deps.repos(),
      roster: () => this.deps.engine()?.roster() ?? [],
      holds: (a, taskId) => this.holdsWorktree(a, taskId),
      claims: this.worktreeClaims,
    };
  }

  /** W2 (N5, N6): agent `a` may be working in Task `taskId`'s worktree: running; a Claude agent
   *  that is on (down sessions are started again); a resting Codex Worker whose last run, which
   *  a follow-up continues, is that Task's. */
  holdsWorktree(a: { role: string; assignmentId: string | null; provider: string; live: boolean; wantRunning: boolean }, taskId: string): boolean {
    if (a.role === 'lead') return false; // its folder is the project's: it holds no worktree
    if (a.live) return true;
    if (a.provider !== 'codex') return a.wantRunning;
    return a.wantRunning && !!a.assignmentId && this.deps.codex()?.runsOf(a.assignmentId).at(-1)?.task === taskId;
  }

  /** W2 (N5): the folder of a Codex Worker's last run is still its own: not one of the daemon's
   *  worktrees that is now another agent's or removed. */
  codexMayUse(project: { name: string; folder: string }, dir: string, assignmentId: string): boolean {
    let top: string;
    try {
      top = fs.realpathSync(project.folder);
    } catch {
      return true;
    }
    const at = path.resolve(dir);
    const recs = this.deps.repos().worktrees
      .all()
      .filter((r) => r.project === project.name && TASK_PATTERN.test(r.task) && worktreePath(top, r.task) === at);
    if (!recs.length) return true;
    const active = recs.find((r) => r.status === 'active');
    return !!active && (!active.assignmentId || active.assignmentId === assignmentId);
  }

  /** W2: `.worktrees/<task>` of the repository at `folder` (rebuilt, never the file's path), if it is there. */
  private worktreeFolder(folder: string, task: string): string | null {
    try {
      const at = worktreePath(fs.realpathSync(folder), task);
      return TASK_PATTERN.test(task) && fs.statSync(at).isDirectory() ? at : null;
    } catch {
      return null;
    }
  }

  /** W2: where a Codex Worker's new run for Task `task` goes: the Task's recorded worktree when
   *  it is this Worker's or nobody's (another Worker's is never shared), and it is there. */
  codexTaskWorktree(
    project: { name: string; folder: string },
    task: string,
    assignmentId: string,
  ): { path: string; branch: string } | null {
    const rec = this.deps.repos().worktrees.forTask(project.name, task);
    if (!rec || (rec.assignmentId && rec.assignmentId !== assignmentId)) return null;
    const at = this.worktreeFolder(project.folder, rec.task);
    return at ? { path: at, branch: rec.branch } : null;
  }

  /**
   * W2: where a Claude Worker starts next (Engine's `assignedFolder`): the worktree last given
   * to it (and there); else, when its folder is one of the daemon's worktrees that is no longer
   * its own (given to another agent, or removed), its project's folder again; otherwise null
   * (no change: a folder the user gave it stays).
   */
  assignedFolder(p: { name: string; assignmentId?: string; workFolder?: string }): string | null {
    const project = p.assignmentId && this.deps.engine()?.projectOf(p.name);
    const folder = project ? this.deps.engine()?.folders().find((f) => f.name === project)?.folder : undefined;
    if (!project || !folder) return null;
    const recs = this.deps.repos().worktrees.all().filter((r) => r.project === project);
    const when = (r: { assignedAt?: string; created: string }) => r.assignedAt ?? r.created;
    const mine = recs
      .filter((r) => r.status === 'active' && r.assignmentId === p.assignmentId)
      .sort((a, b) => when(b).localeCompare(when(a)))[0];
    const at = mine && this.worktreeFolder(folder, mine.task);
    if (at) return at;
    if (!p.workFolder) return null;
    let top: string;
    try {
      top = fs.realpathSync(folder);
    } catch {
      return null;
    }
    const own = path.resolve(p.workFolder);
    return recs.some((r) => TASK_PATTERN.test(r.task) && worktreePath(top, r.task) === own) ? folder : null;
  }

  assignments(): Map<string, string> | null {
    if (!this.deps.engine()) return null;
    const file = registryPath(this.deps.opts.home ?? os.homedir());
    const stamp = (f: string) => {
      try {
        const st = fs.statSync(f);
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        return '-';
      }
    };
    const sig = `${stamp(file)}|${stamp(path.join(path.dirname(file), 'assignments.json'))}`;
    if (this.assignmentCache?.sig !== sig) {
      const loaded = loadRegistry(file);
      this.assignmentCache = {
        sig,
        map:
          loaded.broken || loaded.migrated
            ? null
            : new Map(
                loaded.projects.flatMap((p) => {
                  const id = p.role ? p.assignmentId : p.leadAssignmentId;
                  return id ? [[p.name, id] as const] : [];
                }),
              ),
        providers: new Map(loaded.projects.map((p) => [p.name, cliOf(p)])),
      };
    }
    return this.assignmentCache.map;
  }

  /**
   * D3b + C6: a proposal (a Worker's Task proposed to its Lead) is assigned to the Lead's
   * assignment. After a swap that assignment is the Worker `worker`; the project's open
   * proposals go to the new Lead, which decides them now (the Lead seat, like the project's
   * queued messages). Other Tasks keep their assignee (they follow the agent).
   */
  leadProposals(lead: string, worker: string): void {
    const ids = this.assignments();
    const newLead = ids?.get(lead);
    const oldLead = ids?.get(worker);
    if (!newLead || !oldLead) return;
    for (const t of this.deps.tasks().list({ project: lead, status: 'proposed' }))
      if (t.assignee?.assignmentId === oldLead) {
        const r = this.deps.tasks().update(t.id, { assignee: { assignmentId: newLead, name: lead } }, 'engine');
        if (!r.ok) console.warn(`[agty] lead swap: proposal ${t.id} not moved to the new Lead (${String(r.error)})`);
      }
  }

  /** D6: the tasks' open Executions, settled from the Codex and job records. */
  observeExecutions(): void {
    const jobs = this.deps.jobs();
    const codex = this.deps.codex();
    if (!jobs) return;
    let all: JobRecord[] | null = null;
    this.deps.tasks().observe({
      codex: (id) => (codex ? readCodex(codex.dir, id) : null),
      job: (id) => (all ??= jobs.list(true, true)).find((j) => j.id === id) ?? null,
    });
  }

  /** D5: a Worker run with a Task is that Task's Execution, also when the daemon died between
   *  starting it and attaching it (the same id attaches once). */
  attachWorkerRuns(): void {
    for (const r of this.deps.codex()?.workerRecords() ?? [])
      if (r.task && r.agent && !this.deps.tasks().get(r.task)?.executions?.some((e) => e.id === `codex:${r.id}`))
        this.deps.tasks().attach(r.task, { kind: 'codex', ref: r.id, log: r.log }, r.agent);
  }

  /** D5 (design §2.4): a Worker run that ended, or waits on a usage limit, is told to its Lead
   *  once, under the Worker's name; a room post's end goes to the room too. What was told is in
   *  <id>.told beside the record (the worker rewrites the record whole: never written here). */
  reportWorkerRuns(): void {
    const codex = this.deps.codex();
    if (!codex || !this.deps.messenger() || !this.deps.engine() || this.deps.opts.readOnly) return;
    for (const r of codex.workerRecords()) {
      const mark = r.state === 'limit' ? `limit:${r.resetAt ?? ''}` : r.ended ? 'end' : null;
      if (!mark || !r.agent || this.telling.has(r.id) || this.toldEnd.has(r.id)) continue;
      const file = path.join(codex.dir, `${r.id}.told`);
      let told = '';
      try {
        told = fs.readFileSync(file, 'utf-8').trim();
      } catch {
        /* not told yet */
      }
      if (told === 'end') this.toldEnd.add(r.id);
      if (told === mark || told === 'end') continue;
      this.telling.add(r.id);
      void this.tellWorkerRun(r, mark, file)
        .catch((err) => console.warn(`[agty] codex ${r.id}: ${String(err)}`))
        .finally(() => this.telling.delete(r.id));
    }
  }

  /** C4: a delegation event as a room's one line: a Task given out, a Worker's report. */
  systemLine(type: string, f: Record<string, unknown>): void {
    const task = typeof f.task === 'string' ? f.task : null;
    const from = typeof f.from === 'string' ? f.from : null;
    const groupMessages = this.deps.groupMessages();
    if (!task || !from || !groupMessages) return;
    if (type === 'delegate' && typeof f.to === 'string')
      groupMessages.system({ kind: 'assigned', task, from, to: f.to, detail: this.deps.tasks().get(task)?.title });
    else if (type === 'task_report')
      groupMessages.system({
        kind: 'reported',
        task,
        from,
        to: this.deps.engine()?.projectOf(from) ?? undefined,
        detail: typeof f.status === 'string' ? f.status : undefined,
      });
  }

  async tellWorkerRun(r: CodexRecord, mark: string, file: string): Promise<void> {
    const text = runReport(r, shortStamp);
    const lead = this.deps.engine()?.projectOf(r.agent!) ?? r.project;
    if (text && lead && this.deps.engine()?.names().includes(lead)) {
      const sent = await this.deps.messenger()!.send({
        to: lead,
        text,
        ifIdle: false,
        from: r.agent!,
        source: 'codex',
        ...(r.task && { task: r.task }),
        // K1: a finished run is the Lead's to decide on; a usage-limit wait resumes by itself.
        notice: mark === 'end' ? 'action' : 'fyi',
      });
      if (!sent.ok) {
        console.warn(`[agty] codex ${r.id}: ${lead} not told (${sent.error}); tried again on the next change`);
        return;
      }
    }
    // C4: the report as one line in the rooms that hold the Worker and its Lead (not the run's own
    // room: the summary below says it there).
    if (mark === 'end' && r.task && lead && lead !== r.agent)
      this.deps.groupMessages()?.system({ kind: 'reported', task: r.task, from: r.agent!, to: lead, detail: r.state, except: r.room?.id });
    const groupMessages = this.deps.groupMessages();
    if (mark === 'end' && r.room && groupMessages) {
      const post = await groupMessages.post({
        room: r.room.id,
        text: r.summary?.trim() || '(마지막 메시지가 없어요)',
        from: r.agent!,
        source: 'codex',
        quiet: true, // TOKEN-GUARD (TG-02b): the Lead is told above; the room copy wakes nobody
      });
      if (!post.ok) console.warn(`[agty] codex ${r.id}: room ${r.room.id} not posted (${post.error})`);
    }
    try {
      writeAtomic(file, `${mark}\n`);
      if (mark === 'end') this.toldEnd.add(r.id);
    } catch (err) {
      console.warn(`[agty] codex ${r.id}: ${String(err)}`);
    }
  }
}
