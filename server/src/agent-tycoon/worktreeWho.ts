/**
 * DEVROOM-NAMES (owner 11-01 16:23): who did a Codex run's worktree, for the dev room's cards.
 *
 * A Worker's run (`agent` on its record) is that Worker. A temporary run (`codex:<id>`, no Worker) is
 * the roster employee it was bound to (TEMP-PLATES). The roster keeps only the last ROSTER_ENDED_KEPT
 * ended bindings per project and runs before TEMP-PLATES (10-24) had none, so an ended run's employee
 * is written into its own record once: the bound one, else one of the project's employees picked by
 * the run id (stable). A project with no employee yet answers nothing (the card's Codex fallback).
 */
import * as fs from 'fs';
import * as path from 'path';

import type { ChatEmployee } from '../../../core/src/messages.js';
import { type CodexRecord, readCodex, saveCodex } from './engine/codex.js';
import type { RosterStore } from './roster.js';

export interface WorktreeWhoAnswer {
  agent?: string;
  employee?: ChatEmployee;
}

const key = (p: string) => path.resolve(p);

/** One of `ids` by `seed`, the same every time for the same list. */
export function pickBy(seed: string, ids: readonly string[]): string | undefined {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return ids.length ? ids[h % ids.length] : undefined;
}

export class WorktreeWho {
  /** worktree path -> record id (a record's worktree never changes). */
  private readonly byPath = new Map<string, string>();
  private readonly seen = new Set<string>();
  /** Ended runs, final. */
  private readonly done = new Map<string, WorktreeWhoAnswer>();

  constructor(private readonly d: { dir: () => string | null; roster: RosterStore }) {}

  of(project: string, worktree: string): WorktreeWhoAnswer | undefined {
    const dir = this.d.dir();
    if (!dir) return undefined;
    this.index(dir);
    const id = this.byPath.get(key(worktree));
    if (!id) return undefined;
    const kept = this.done.get(id);
    if (kept) return kept;
    const r = readCodex(dir, id);
    if (!r) return undefined;
    const ended = r.state !== 'running' && r.state !== 'limit';
    const answer = r.agent ? { agent: r.agent } : this.employee(project, r, dir, ended);
    if (answer && ended) this.done.set(id, answer);
    return answer;
  }

  private employee(project: string, r: CodexRecord, dir: string, ended: boolean): WorktreeWhoAnswer | undefined {
    if (r.employee) return { employee: r.employee };
    const bound = this.d.roster.employeeOf(`codex:${r.id}`);
    let employee: ChatEmployee | undefined = bound && { employeeId: bound.id, nameId: bound.nameId };
    if (!employee && ended) {
      const staff = this.d.roster.employees(r.project ?? project).sort((a, b) => a.hiredAt - b.hiredAt);
      const id = pickBy(r.id, staff.map((e) => e.id));
      const e = staff.find((x) => x.id === id);
      employee = e && { employeeId: e.id, nameId: e.nameId };
    }
    if (!employee) return undefined;
    if (ended) {
      try {
        saveCodex(dir, { ...r, employee });
      } catch (err) {
        console.warn(`[Agent Tycoon] codex record ${r.id}: employee not kept: ${String(err)}`);
      }
    }
    return { employee };
  }

  /** New record files only. ponytail: one readdir per call (every repoState); a watch if it shows. */
  private index(dir: string): void {
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.json') && !this.seen.has(n));
    } catch {
      return;
    }
    for (const n of names) {
      const r = readCodex(dir, n.slice(0, -5));
      if (!r) continue; // half-written: read again next time
      this.seen.add(n);
      if (r.worktree) this.byPath.set(key(r.worktree), r.id);
    }
  }
}
