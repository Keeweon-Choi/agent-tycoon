/**
 * T-0036: what kind of character each office character is, what it is called,
 * and who gets a name on the canvas. Read from what the stores already know
 * (officeState, codexTasks, the office character), so no protocol change.
 *
 * Card bar order: grouped by kind (orchestrators, teammates, sub-agents,
 * Codex, visitors), manual order kept inside each group. By kind rather than
 * after each lead: the user asked to tell the kinds apart at a glance, and a
 * sub-agent's lead is in its tooltip.
 */
import type { CodexTasks, OfficeSnapshot } from '../../../core/src/messages.js';
import { t } from '../i18n/index.js';
import { employeeName, employeeOf } from './employees.js';
import { virtualAgentId } from './officeStore.js';

export type CharacterKind = 'orchestrator' | 'teammate' | 'subagent' | 'codex' | 'visitor';

/** Card bar groups, top to bottom (left to right on the phone). */
export const KIND_ORDER: readonly CharacterKind[] = [
  'orchestrator',
  'teammate',
  'subagent',
  'codex',
  'visitor',
];

export const kindLabel = (kind: CharacterKind): string => t(`kind.${kind}`);

/** The office character fields the kind is read from. */
export interface KindFacts {
  id: number;
  isSubagent?: boolean;
  leadAgentId?: number;
  agentName?: string;
  isTeamLead?: boolean;
  directoryName?: string;
}

const orchestratorOf = (id: number, office: OfficeSnapshot | null) =>
  office?.orchestrators.find((o) => (o.agentId ?? virtualAgentId(`orch:${o.name}`)) === id);
const codexTaskOf = (id: number, tasks: CodexTasks | null) =>
  tasks?.tasks.find((t) => (t.agentId ?? virtualAgentId(`codex:${t.id}`)) === id);

/**
 * Sub-agent: a negative-id Subtask. Teammate: a named agent working for a lead
 * (checked before the project rows, since a teammate's own session is listed there
 * too). Orchestrator: an engine orchestrator (or a plain Claude session
 * seated at its project). Codex: a synthetic Codex worker.
 * Anyone else is a lobby visitor.
 */
export function characterKind(
  ch: KindFacts,
  office: OfficeSnapshot | null,
  tasks: CodexTasks | null,
): CharacterKind {
  if (ch.isSubagent || (ch.id < 0 && ch.id > -1_000_000_000)) return 'subagent';
  if (codexTaskOf(ch.id, tasks)) return 'codex';
  if (ch.leadAgentId !== undefined || (ch.agentName && !ch.isTeamLead)) return 'teammate';
  if (orchestratorOf(ch.id, office)) return 'orchestrator';
  return 'visitor';
}

/** What a character is called: its project name, its roster employee's name (TEMP-PLATES),
 *  team name, subtask or folder. */
export function characterName(
  ch: KindFacts,
  office: OfficeSnapshot | null,
  tasks: CodexTasks | null,
  subtaskLabel?: string,
): string {
  const orch = orchestratorOf(ch.id, office);
  if (orch) return orch.name;
  const employee = employeeOf(ch.id);
  if (employee) return employeeName(employee);
  const task = codexTaskOf(ch.id, tasks);
  if (task) return `codex·${task.project}`;
  if (ch.agentName) return ch.agentName;
  if (ch.isSubagent) return subtaskLabel || kindLabel('subagent');
  return ch.directoryName || `#${ch.id}`;
}

/**
 * Name on the canvas. With nameplates (charpack v3 §6A, on by default) every
 * character but a sub-agent with no roster employee (TEMP-PLATES); without,
 * orchestrators only. 항상 이름 보기 adds everyone, sub-agents too.
 */
export const showsNameLabel = (
  kind: CharacterKind,
  alwaysShowLabels: boolean,
  nameplates = false,
  employed = false,
): boolean =>
  alwaysShowLabels || kind === 'orchestrator' || (nameplates && (kind !== 'subagent' || employed));

/** "3분째" for how long the current activity has run. */
export function elapsedText(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return t('elapsed.justStarted');
  if (min < 60) return t('elapsed.minutes', { count: min });
  const h = Math.floor(min / 60);
  return min % 60
    ? t('elapsed.hoursMinutes', { hours: h, minutes: min % 60 })
    : t('elapsed.hours', { count: h });
}

export function elapsedDuration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return t('elapsed.justStarted');
  if (min < 60) return t('elapsed.minutesBare', { count: min });
  const h = Math.floor(min / 60);
  return min % 60
    ? t('elapsed.hoursMinutesBare', { hours: h, minutes: min % 60 })
    : t('elapsed.hoursBare', { count: h });
}

// Since when each character has done what it does now (its activity line).
const since = new Map<number, { key: string; at: number }>();
/** How long character `id` has shown `key`; a new key starts the clock again. */
export function activityElapsed(id: number, key: string, now = Date.now()): number {
  const prev = since.get(id);
  if (prev?.key === key) return now - prev.at;
  since.set(id, { key, at: now });
  return 0;
}

/** A card bar card in cld mode: its group (KIND_ORDER rank), header and name. */
export function cardInfo(
  ch: KindFacts,
  office: OfficeSnapshot | null,
  tasks: CodexTasks | null,
  subtaskLabel?: string,
): { group: number; groupLabel: string; name: string } {
  const kind = characterKind(ch, office, tasks);
  return {
    group: KIND_ORDER.indexOf(kind),
    groupLabel: kindLabel(kind),
    name: characterName(ch, office, tasks, subtaskLabel),
  };
}
