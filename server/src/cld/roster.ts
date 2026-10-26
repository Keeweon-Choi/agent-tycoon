/**
 * TEMP-PLATES: each project's staff roster, in ~/.config/agent-tycoon/roster.json.
 *
 * An Employee is a game character (a stable id, a name id from the roster names, a look
 * keyed `emp:<id>` in characters.json, XP keyed `emp:<id>` in levels.json). An Execution is
 * one real run: a Claude sub-agent spawn (`claude:<spawn tool_use id>`) or a Codex temporary
 * run (`codex:<task id>`). An execution is bound to one employee for its duration; the
 * employee "comes back to work" for later executions, but every execution is a fresh AI
 * session: nothing of an earlier session carries over (unlike an engine Worker, D3, whose
 * session really continues).
 *
 * Rules:
 * - Assignment: among the project's employees that are idle and `suitable` for the work,
 *   the one idle the longest; none: hire one under a name no employee of the project has.
 * - The same execution id always answers with its binding: a replayed start, a reconnect or
 *   a duplicate event never binds twice, and an employee runs at most one execution.
 * - XP is paid once per (execution, event): `pay` records the event id with the binding and
 *   says whether it was new. The roster is written before levels.json (see office.ts), so a
 *   crash can lose XP but never pay it twice.
 * - A daemon start releases every binding left open (a crash, a run that never ended); an
 *   execution seen again afterwards goes back to its employee when that one is still idle.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';

import { ACTIVE_STAFF_NAMES } from '../../../core/src/cld/staffNames.js';
import { readJson, writeJsonAtomic } from './jsonFile.js';

/** Ended bindings kept per project (a replay older than this binds anew). */
export const ROSTER_ENDED_KEPT = 200;
/** Event ids kept per binding for the XP dedupe. */
export const ROSTER_PAID_KEPT = 1000;
/** A project's employees stop at this many (more is no employee: the plate falls back). */
export const ROSTER_MAX_EMPLOYEES = 500;

export interface Employee {
  id: string;
  nameId: string;
  hiredAt: number;
  lastReleasedAt: number | null;
  /** The execution it runs now, or null: idle. */
  execution: string | null;
}

export interface Binding {
  employee: string;
  started: number;
  ended: number | null;
  /** 'end': its own end signal; 'restart': released by a daemon start (may come back). */
  endedBy?: 'end' | 'restart';
  paid: string[];
  /** The run's last known context (its 피로도): kept past its end and across a restart. */
  context?: { tokens: number; max: number };
}

interface ProjectRoster {
  employees: Employee[];
  executions: Record<string, Binding>;
}

/** What an execution is (role, skills and provider fit are for later). */
export interface Work {
  provider: 'claude' | 'codex';
  model?: string | null;
}

/** Whether `employee` fits `work`. Every employee fits every work for now. */
export const suitable = (_employee: Employee, _work: Work): boolean => true;

export interface RosterOptions {
  now?: () => number;
  random?: () => number;
  newId?: () => string;
}

export class RosterStore {
  private projects: Record<string, ProjectRoster> = {};
  private dirty = false;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly newId: () => string;

  constructor(
    readonly file: string,
    opts: RosterOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.newId = opts.newId ?? (() => crypto.randomUUID());
    let raw: unknown;
    try {
      raw = readJson(file);
    } catch {
      const aside = `${file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(file, aside);
      } catch {
        /* file disappeared */
      }
      console.warn(`[cld] roster: invalid JSON moved to ${aside}`);
    }
    const projects = (raw as { v?: number; projects?: unknown } | null)?.projects;
    // A record of the wrong shape (a hand edit, another version) is left out, never a crash;
    // the file as it was is kept beside it first.
    let dropped = false;
    if (projects && typeof projects === 'object')
      for (const [name, p] of Object.entries(projects as Record<string, Partial<ProjectRoster>>)) {
        if (!Array.isArray(p?.employees) || !p.executions || typeof p.executions !== 'object') {
          dropped = true;
          continue;
        }
        const employees = p.employees.filter(
          (e) => typeof e?.id === 'string' && typeof e.nameId === 'string',
        );
        const executions = Object.fromEntries(
          Object.entries(p.executions).filter(
            ([, b]) => typeof b?.employee === 'string' && Array.isArray(b.paid),
          ),
        );
        dropped ||=
          employees.length !== p.employees.length ||
          Object.keys(executions).length !== Object.keys(p.executions).length;
        this.projects[name] = { employees, executions };
      }
    if (dropped) {
      const aside = `${file}.corrupt-${Date.now()}`;
      try {
        fs.copyFileSync(file, aside);
      } catch {
        /* kept in memory as read */
      }
      console.warn(`[cld] roster: records of the wrong shape left out, the file kept as ${aside}`);
      this.dirty = true;
    }
    // A daemon start: whatever was left running has no end signal coming.
    const at = this.now();
    for (const p of Object.values(this.projects)) {
      for (const b of Object.values(p.executions)) {
        if (b.ended !== null) continue;
        b.ended = at;
        b.endedBy = 'restart';
        this.dirty = true;
      }
      // Nothing runs across a start: every employee is idle (also one whose binding was lost).
      for (const e of p.employees)
        if (e.execution !== null) {
          e.execution = null;
          e.lastReleasedAt = at;
          this.dirty = true;
        }
    }
    if (this.dirty) this.flush();
  }

  /**
   * The employee running `execution` (idempotent). A new execution gets the longest-idle
   * suitable employee, else a new hire; null only when the project is full. `resumed`: the
   * execution really runs again, so an ended binding reopens (a replay leaves it ended).
   */
  bind(project: string, execution: string, work: Work, resumed = false): Employee | null {
    const p = (this.projects[project] ??= { employees: [], executions: {} });
    const b = p.executions[execution];
    const at = this.now();
    if (b) {
      const e = p.employees.find((x) => x.id === b.employee);
      if (b.ended === null || (b.endedBy !== 'restart' && !resumed)) return e ?? null;
      // Back after a restart or resumed after its own end (a SendMessage resume runs on in
      // the same transcript): on its employee when that one is idle, else on another.
      // `started` moves so latest() shows this as the employee's current execution.
      const back = e && e.execution === null ? e : this.pick(p, work, at);
      if (!back) return null;
      back.execution = execution;
      Object.assign(b, { employee: back.id, started: at, ended: null, endedBy: undefined });
      this.flush();
      return back;
    }
    const e = this.pick(p, work, at);
    if (!e) return null;
    e.execution = execution;
    p.executions[execution] = { employee: e.id, started: at, ended: null, paid: [] };
    this.prune(p);
    this.flush();
    return e;
  }

  /** The execution ended (its own end signal). False when it was not running. */
  release(execution: string): boolean {
    const found = this.find(execution);
    if (!found || found.b.ended !== null) return false;
    const at = this.now();
    found.b.ended = at;
    found.b.endedBy = 'end';
    const e = found.p.employees.find((x) => x.id === found.b.employee);
    if (e?.execution === execution) {
      e.execution = null;
      e.lastReleasedAt = at;
    }
    this.flush();
    return true;
  }

  /** XP event `event` of `execution`: its employee's id the first time, else null. */
  pay(execution: string, event: string): string | null {
    const found = this.find(execution);
    if (!found || found.b.paid.includes(event)) return null;
    found.b.paid.push(event);
    // ponytail: past the cap the oldest ids go; a replay that old could pay again
    if (found.b.paid.length > ROSTER_PAID_KEPT) found.b.paid.shift();
    this.dirty = true;
    return found.b.employee;
  }

  /** The execution's latest context (false: no such execution). Written with the next flush. */
  setContext(execution: string, tokens: number, max: number): boolean {
    const found = this.find(execution);
    if (!found) return false;
    found.b.context = { tokens, max };
    this.dirty = true;
    return true;
  }

  /** The employee an execution is (or was last) bound to. */
  employeeOf(execution: string): (Employee & { project: string }) | undefined {
    const found = this.find(execution);
    const e = found?.p.employees.find((x) => x.id === found.b.employee);
    return e && { ...e, project: found!.project };
  }

  /** A project's employees (copies). */
  employees(project: string): Employee[] {
    return (this.projects[project]?.employees ?? []).map((e) => ({ ...e }));
  }

  /** Every project's employees (copies). */
  allEmployees(): Employee[] {
    return Object.values(this.projects).flatMap((p) => p.employees.map((e) => ({ ...e })));
  }

  /** Every project's employees with the execution each was last bound to. */
  latest(): Array<{ project: string; employee: Employee; execution: string; binding: Binding }> {
    const out: Array<{ project: string; employee: Employee; execution: string; binding: Binding }> = [];
    for (const [project, p] of Object.entries(this.projects)) {
      const last = new Map<string, [string, Binding]>();
      for (const [exec, b] of Object.entries(p.executions)) {
        const prev = last.get(b.employee);
        if (!prev || b.started >= prev[1].started) last.set(b.employee, [exec, b]);
      }
      for (const e of p.employees) {
        // The running execution wins outright: `started` ties within one millisecond.
        const cur = e.execution === null ? undefined : p.executions[e.execution];
        const l: [string, Binding] | undefined = cur ? [e.execution!, cur] : last.get(e.id);
        if (l) out.push({ project, employee: e, execution: l[0], binding: l[1] });
      }
    }
    return out;
  }

  /** Open executions whose id starts with `prefix` (codex:, claude:). */
  open(prefix: string): string[] {
    return Object.values(this.projects).flatMap((p) =>
      Object.entries(p.executions)
        .filter(([exec, b]) => b.ended === null && exec.startsWith(prefix))
        .map(([exec]) => exec),
    );
  }

  flush(): void {
    this.dirty = false;
    try {
      writeJsonAtomic(this.file, { v: 1, projects: this.projects });
    } catch (err) {
      console.warn(`[cld] roster: ${String(err)}`);
    }
  }

  /** Write only when something changed since the last write (XP marks). */
  flushIfDirty(): void {
    if (this.dirty) this.flush();
  }

  private find(execution: string): { project: string; p: ProjectRoster; b: Binding } | null {
    for (const [project, p] of Object.entries(this.projects)) {
      const b = p.executions[execution];
      if (b) return { project, p, b };
    }
    return null;
  }

  private pick(p: ProjectRoster, work: Work, at: number): Employee | null {
    const idle = p.employees
      .filter((e) => e.execution === null && suitable(e, work))
      .sort((a, b) => (a.lastReleasedAt ?? a.hiredAt) - (b.lastReleasedAt ?? b.hiredAt));
    if (idle[0]) return idle[0];
    if (p.employees.length >= ROSTER_MAX_EMPLOYEES) return null;
    const e: Employee = {
      id: this.newId(),
      nameId: freeNameId(new Set(p.employees.map((x) => x.nameId)), this.random),
      hiredAt: at,
      lastReleasedAt: null,
      execution: null,
    };
    p.employees.push(e);
    return e;
  }

  private prune(p: ProjectRoster): void {
    const ended = Object.entries(p.executions)
      .filter(([, b]) => b.ended !== null)
      .sort(([, a], [, b]) => a.ended! - b.ended!);
    for (const [exec] of ended.slice(0, Math.max(0, ended.length - ROSTER_ENDED_KEPT)))
      delete p.executions[exec];
  }
}

/**
 * A name id no one in `used` has: a random active name; once all are taken, the first
 * active name in list order with the lowest free repeat number (`harry-potter#2`, ...).
 * Held rows and names that are not on the active list are never given out.
 */
export function freeNameId(used: ReadonlySet<string>, random: () => number = Math.random): string {
  const free = ACTIVE_STAFF_NAMES.filter((n) => !used.has(n.id));
  if (free.length) return free[Math.floor(random() * free.length)].id;
  for (let n = 2; ; n++) {
    const next = ACTIVE_STAFF_NAMES.find((x) => !used.has(`${x.id}#${n}`));
    if (next) return `${next.id}#${n}`;
  }
}
