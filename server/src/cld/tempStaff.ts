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
  TempEmployee,
  TempStaff as TempStaffMsg,
} from '../../../core/src/messages.js';
import { hookProviders } from '../providers/index.js';
import { type LevelStore, XP_JOB, XP_TOOL, XP_TURN } from './levels.js';
import type { RosterStore } from './roster.js';

/** A released employee keeps its last execution on the wire this long (lingering characters). */
export const TEMP_STAFF_RECENT_MS = 60 * 60 * 1000;

const isSubagentTool = (name: unknown): boolean =>
  typeof name === 'string' && hookProviders.some((p) => p.subagentToolNames.has(name));

export interface TempStaffDeps {
  roster: RosterStore;
  levels: LevelStore;
  /** The roster project of a lead character, or null (no project: no employee). */
  projectOf(leadId: number): string | null;
  /** XP counts (the office's start-up history read is over). */
  live(): boolean;
  /** Something changed: publish the message (and pin new looks). */
  changed(): void;
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
          this.spawn(id, m.toolId, m.runInBackground === true, m.model);
        return;
      case 'subagentToolStart':
        if (typeof m.parentToolId !== 'string' || typeof m.toolId !== 'string') return;
        // Missed start (a restart, a watched background spawn): bind on its first sub-tool.
        if (!this.spawns.has(`claude:${m.parentToolId}`)) this.spawn(id, m.parentToolId, true);
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
  context(_leadId: number, spawnToolUseId: string, tokens: number, max: number): void {
    if (this.d.roster.setContext(`claude:${spawnToolUseId}`, tokens, max)) this.d.changed();
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
    const cutoff = (this.d.now ?? Date.now)() - TEMP_STAFF_RECENT_MS;
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
          ...(ctx && { contextTokens: ctx.tokens, maxContextTokens: ctx.max }),
        };
      });
    return { type: 'tempStaff', staff };
  }

  private spawn(leadId: number, toolId: string, background: boolean, model?: unknown): void {
    const exec = `claude:${toolId}`;
    const known = this.spawns.get(exec);
    this.spawns.set(exec, { leadId, background: background || !!known?.background });
    if (known) return;
    const project = this.d.projectOf(leadId);
    if (!project) return;
    const work = { provider: 'claude' as const, model: typeof model === 'string' ? model : null };
    // Started again after its own end once the history read is over: a resumed spawn
    // (SendMessage), the same execution on the same employee. Before that, a replay.
    if (this.d.roster.bind(project, exec, work, this.d.live())) this.d.changed();
  }

  private end(exec: string): void {
    this.spawns.delete(exec);
    if (this.d.roster.release(exec)) this.d.changed();
  }

  private pay(exec: string, event: string, xp: number): void {
    if (!this.d.live()) return;
    const employee = this.d.roster.pay(exec, event);
    if (employee) this.d.levels.addXp(`emp:${employee}`, xp);
  }
}
