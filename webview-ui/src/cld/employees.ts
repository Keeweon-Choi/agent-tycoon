/**
 * TEMP-PLATES: which roster employee a sub-agent or Codex temporary character is. The
 * daemon binds each execution (`claude:<spawn tool id>`, `codex:<task id>`) to an employee
 * (tempStaff); this maps a character to its execution and names it in the UI language.
 * The employee is a game character reused across jobs; each job is a fresh AI session.
 */
import { staffName } from '../../../core/src/cld/staffNames.js';
import type { CodexTasks, TempEmployee } from '../../../core/src/messages.js';
import { getLanguage, type Language } from '../i18n/index.js';
import { contextPct, type FatigueLook, fatigueLook, type FatigueRules } from './ez/fatigue.js';
import { cldGetSnapshot, type CldSnapshot, virtualAgentId } from './officeStore.js';

/** A sub-agent character's spawn tool id (staff.ts knows the office). */
let spawnOf: (id: number) => string | undefined = () => undefined;
export function setSpawnLookup(fn: (id: number) => string | undefined): void {
  spawnOf = fn;
}

/** The execution character `id` is: its spawn, or the Codex run no Worker owns. */
export function executionOf(id: number, tasks: CodexTasks | null): string | null {
  const spawn = id < 0 ? spawnOf(id) : undefined;
  if (spawn) return `claude:${spawn}`;
  const task = tasks?.tasks.find(
    (t) => !t.agent && (t.agentId ?? virtualAgentId(`codex:${t.id}`)) === id,
  );
  return task ? `codex:${task.id}` : null;
}

/**
 * Each execution's employee as last sent. The wire carries an employee's latest execution only
 * (and for TEMP_STAFF_RECENT_MS after it ended), so a character still resting would lose its
 * name, level and 피로도 once its employee is back at work elsewhere or the hour is over.
 * ponytail: grows by one small entry per execution this page saw; a page reload clears it.
 */
const lastSeen = new Map<string, TempEmployee>();

export function employeeOf(
  id: number,
  snap: Pick<CldSnapshot, 'codexTasks' | 'tempStaff'> = cldGetSnapshot(),
): TempEmployee | undefined {
  const exec = executionOf(id, snap.codexTasks);
  if (!exec) return undefined;
  const now = snap.tempStaff.find((e) => e.execution === exec);
  if (now) lastSeen.set(exec, now);
  return now ?? lastSeen.get(exec);
}

/** Character `id`'s employee is at work on another execution now: it cannot also rest here. */
export function employeeBusyElsewhere(
  id: number,
  snap: Pick<CldSnapshot, 'codexTasks' | 'tempStaff'> = cldGetSnapshot(),
): boolean {
  const e = employeeOf(id, snap);
  return (
    !!e && snap.tempStaff.some((x) => x.employeeId === e.employeeId && x.execution !== e.execution && x.working)
  );
}

/** The employee's name in the UI language (switching it never changes the employee). */
export const employeeName = (e: Pick<TempEmployee, 'nameId'>, lang: Language = getLanguage()): string =>
  staffName(e.nameId, lang);

/** 피로도 from the execution's own context, or null: unknown (never estimated). */
export function employeeFatigue(e: TempEmployee, rules: FatigueRules): FatigueLook | null {
  if (e.contextTokens === undefined || !e.maxContextTokens) return null;
  return fatigueLook(contextPct({ tokens: e.contextTokens, max: e.maxContextTokens, drops: 0 }), 0, rules);
}
