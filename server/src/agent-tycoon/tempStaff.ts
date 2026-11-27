/**
 * TEMP-PLATES: binds the office's temporary work to the per-project staff roster
 * (roster.ts) and pays the employees their XP.
 *
 * Executions:
 * - a Claude sub-agent spawn, `claude:<spawn tool_use id>`: bound on the lead's spawn
 *   (`agentToolStart` of a sub-agent tool that is not a teammate spawn) or, missed, on its
 *   first sub-tool; released on `subagentClear` (its tool_result or, in the background, its
 *   queue-operation), on the lead's `agentToolsClear` (an interrupted foreground spawn) and
 *   when the lead goes;
 * - a Codex temporary run, `codex:<task id>` (no Worker): bound while running or waiting out
 *   a limit, released when it ends or its record is gone.
 *
 * XP, each once per (execution, event): a sub-tool XP_TOOL, a finished spawn XP_TURN, a
 * Codex run done XP_JOB. The Lead's own XP rules are untouched.
 * Fatigue: a sub-agent's own transcript context (the shadow watch), kept with its binding in the
 * roster (past its end and across a restart: a known value never turns unknown); Codex runs have none the
 * office can verify (`codex exec --json` reports a turn's spend, not the context, and no
 * window), so their plates say 미확인.
 */
import type {
  CodexTask,
  ContextLimitBasis,
  SubagentRun,
  SubagentRuns,
  TempEmployee,
  TempStaff as TempStaffMsg,
} from '../../../core/src/messages.js';
import { hookProviders } from '../providers/index.js';
import { type LevelStore, XP_JOB, XP_TOOL, XP_TURN } from './levels.js';
import type { RosterStore } from './roster.js';

/** A released employee keeps its last execution on the wire this long (lingering characters). */
export const TEMP_STAFF_RECENT_MS = 60 * 60 * 1000;
/** T-185: the sub-agent runs on the wire: open, or ended within this long (the 타임라인's 오늘). */
export const TEMP_STAFF_RUNS_MS = 24 * 60 * 60 * 1000;
/** T-185: at most this many of them, the newest (a busy day must not make a large message). */
export const TEMP_STAFF_RUNS_MAX = 300;

const isSubagentTool = (name: unknown): boolean =>
  typeof name === 'string' && hookProviders.some((p) => p.subagentToolNames.has(name));

export interface TempStaffDeps {
  roster: RosterStore;
  levels: LevelStore;
  /** The roster project of a lead character, or null (no project: no employee). */
  projectOf(leadId: number): string | null;
  /** XP counts (the office's start-up history read is over). */
  live(): boolean;
  /** The name of a character (a sub-agent's spawner), or null. */
  nameOf(id: number): string | null;
  /** Something changed: publish the message (and pin new looks). */
  changed(): void;
  /** T-185: a sub-agent binding was made, released or re-bound: publish runsMessage(). */
  runsChanged(): void;
  now?: () => number;
}

export class TempStaff {
  /** Sub-agent executions this daemon saw start: their lead and whether they run in the background. */
  private readonly spawns = new Map<string, { leadId: number; background: boolean }>();

  constructor(private readonly d: TempStaffDeps) {}

  /** One main-store broadcast. */
  observe(m: Record<string, unknown>): void {
    const id = m.id;
    if (typeof id !== 'number') return;
    switch (m.type) {
      case 'agentToolStart':
        if (isSubagentTool(m.toolName) && !m.isTeammateSpawn && typeof m.toolId === 'string')
          this.spawn(id, m.toolId, m.runInBackground === true, 'spawn', m.model, m.desc);
        return;
      case 'subagentToolStart':
        if (typeof m.parentToolId !== 'string' || typeof m.toolId !== 'string') return;
        // Missed start (a restart, a watched background spawn): bind on its first sub-tool.
        if (!this.spawns.has(`claude:${m.parentToolId}`)) this.spawn(id, m.parentToolId, true, 'tool');
        this.pay(`claude:${m.parentToolId}`, `tool:${m.toolId}`, XP_TOOL);
        return;
      case 'subagentClear': {
        if (typeof m.parentToolId !== 'string') return;
        const exec = `claude:${m.parentToolId}`;
        this.pay(exec, 'finish', XP_TURN);
        this.end(exec);
        return;
      }
      case 'agentToolsClear':
        for (const [exec, s] of this.spawns) if (s.leadId === id && !s.background) this.end(exec);
        return;
      default:
        return;
    }
  }

  /** A character was removed: its sub-agents' executions end with it. */
  leadGone(leadId: number): void {
    for (const [exec, s] of this.spawns) if (s.leadId === leadId) this.end(exec);
  }

  /** The sub-agent's own context (SubagentWatch.onContext). */
  context(
    _leadId: number,
    spawnToolUseId: string,
    tokens: number,
    max: number,
    basis?: ContextLimitBasis,
  ): void {
    if (this.d.roster.setContext(`claude:${spawnToolUseId}`, tokens, max, basis)) this.d.changed();
  }

  /** The compactions counted in the sub-agent's own transcript (SubagentWatch.onCompactions). */
  compactions(_leadId: number, spawnToolUseId: string, count: number): void {
    if (this.d.roster.setCompactions(`claude:${spawnToolUseId}`, count)) this.d.changed();
  }

  /** The Codex task list (temporaries are the runs no Worker owns). */
  codex(tasks: readonly CodexTask[]): void {
    let changed = false;
    const running = new Set<string>();
    for (const t of tasks) {
      if (t.agent) continue;
      const exec = `codex:${t.id}`;
      if (t.state === 'running' || t.state === 'limit') {
        running.add(exec);
        const before = this.d.roster.employeeOf(exec)?.execution;
        const e = this.d.roster.bind(t.project, exec, { provider: 'codex', model: t.model });
        changed ||= !!e && before !== exec;
      } else if (this.d.roster.employeeOf(exec)) {
        if (t.state === 'done') this.pay(exec, 'finish', XP_JOB);
        changed = this.d.roster.release(exec) || changed;
      }
    }
    for (const exec of this.d.roster.open('codex:'))
      if (!running.has(exec)) changed = this.d.roster.release(exec) || changed;
    if (changed) this.d.changed();
  }

  message(): TempStaffMsg {
    const now = (this.d.now ?? Date.now)();
    const cutoff = now - TEMP_STAFF_RECENT_MS;
    const staff: TempEmployee[] = this.d.roster
      .latest()
      .filter(({ binding: b }) => b.ended === null || b.ended >= cutoff)
      .map(({ project, employee: e, execution, binding: b }) => {
        const ctx = b.context;
        return {
          execution,
          employeeId: e.id,
          nameId: e.nameId,
          project,
          working: b.ended === null,
          ...(this.d.levels.view(`emp:${e.id}`) && { level: this.d.levels.view(`emp:${e.id}`) }),
          ...(ctx && {
            contextTokens: ctx.tokens,
            maxContextTokens: ctx.max,
            ...(ctx.basis && { limitBasis: ctx.basis }),
            ...(ctx.compactions && { compactions: ctx.compactions }),
          }),
        };
      });
    return { type: 'tempStaff', staff };
  }

  /** T-185: the sub-agent runs for the 현황판's 타임라인: open or ended within TEMP_STAFF_RUNS_MS, the newest
   *  TEMP_STAFF_RUNS_MAX, and from when the record is whole when it is not. Its own message: a context
   *  update (staff) does not carry it again. */
  runsMessage(): SubagentRuns {
    const now = (this.d.now ?? Date.now)();
    const all = this.d.roster
      .runs('claude:', now - TEMP_STAFF_RUNS_MS)
      .map((r) => ({ ...r, from: r.binding.rebound ? (r.binding.first ?? r.binding.started) : r.binding.started }))
      .sort((a, b) => b.from - a.from);
    const kept = all.slice(0, TEMP_STAFF_RUNS_MAX);
    const cut = all.length > kept.length ? kept[kept.length - 1].from : null;
    const pruned = Math.max(cut ?? 0, this.d.roster.prunedBefore() ?? 0);
    const runs: SubagentRun[] = kept.map(({ project, execution, binding: b, from }) => ({
      execution,
      project,
      started: new Date(from).toISOString(),
      ...(b.ended !== null && { ended: new Date(b.ended).toISOString() }),
      ...(b.endedBy && { endedBy: b.endedBy }),
      ...(b.desc && { desc: b.desc }),
      employeeId: b.employee,
      ...(b.spawner && { spawner: b.spawner }),
      ...(b.seen && { seen: b.seen }),
      ...(b.rebound && { rebound: true }),
    }));
    return { type: 'subagentRuns', runs, ...(pruned > 0 && { prunedBefore: new Date(pruned).toISOString() }) };
  }

  private spawn(leadId: number, toolId: string, background: boolean, seen: 'spawn' | 'tool', model?: unknown, desc?: unknown): void {
    const exec = `claude:${toolId}`;
    const known = this.spawns.get(exec);
    this.spawns.set(exec, { leadId, background: background || !!known?.background });
    if (known) return;
    const project = this.d.projectOf(leadId);
    if (!project) return;
    const work = {
      provider: 'claude' as const,
      model: typeof model === 'string' ? model : null,
      desc: typeof desc === 'string' ? desc : null,
      // First seen in the start-up history read: that read's time, not the run's.
      seen: this.d.live() ? seen : ('replay' as const),
      spawner: this.d.nameOf(leadId),
    };
    // Started again after its own end once the history read is over: a resumed spawn
    // (SendMessage), the same execution on the same employee. Before that, a replay.
    if (this.d.roster.bind(project, exec, work, this.d.live())) {
      this.d.changed();
      this.d.runsChanged();
    }
  }

  private end(exec: string): void {
    this.spawns.delete(exec);
    if (this.d.roster.release(exec)) {
      this.d.changed();
      this.d.runsChanged();
    }
  }

  private pay(exec: string, event: string, xp: number): void {
    if (!this.d.live()) return;
    const employee = this.d.roster.pay(exec, event);
    if (employee) this.d.levels.addXp(`emp:${employee}`, xp);
  }
}
