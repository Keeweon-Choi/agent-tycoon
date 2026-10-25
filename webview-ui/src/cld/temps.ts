/**
 * T-0041 temps: sub-agents, teammates and Codex workers come in for a piece of
 * work and go home after it. The pure rules live here (the Node runner tests
 * them); staff.ts moves the characters.
 */
import type { CodexTask, WorkKind } from '../../../core/src/messages.js';
import { t } from '../i18n/index.js';
import type { ModelBadge } from './modelBadges.js';

export type TempKind = 'subagent' | 'teammate' | 'codex';
export type TempPhase = 'working' | 'lingering' | 'leaving';

/**
 * A temp goes home when all of these hold: its work is over, its lead's turn
 * has ended, and the linger time has passed since it last worked (new work
 * moves `lastWorkAt` on, so nothing new arrived meanwhile).
 */
export function shouldGoHome(
  t: { working: boolean; lastWorkAt: number },
  leadTurnEnded: boolean,
  now: number,
  lingerMs: number,
): boolean {
  return !t.working && leadTurnEnded && now - t.lastWorkAt >= lingerMs;
}

// ── One line of what a temp does ─────────────────────────────

export const TASK_LINE_MAX = 60;
export const cutLine = (text: string, max = TASK_LINE_MAX): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * What a temp does, in one line: the spawn's description, else the latest EZ
 * activity line, else the tool status. A description that is already its name
 * says nothing new, so the activity speaks instead.
 */
export function taskLine(
  name: string,
  src: { description?: string | null; ez?: string | null; status?: string | null },
): string {
  const description = src.description?.trim();
  const line = [description !== name ? description : '', src.ez, src.status].find(
    (s) => s && s.trim(),
  );
  return line ? cutLine(line) : '';
}

/** A Codex worker's task: its spec's title (the file name without .md); the id is not a task. */
export const codexTaskLine = (task: Pick<CodexTask, 'id' | 'spec'>): string =>
  cutLine(task.spec ? task.spec.replace(/\.md$/i, '') : task.id);

// ── "+N" and the 현황판 summaries ─────────────────────────────

/** What the read-only work view (T-0056) asks the server for: a sub-agent by
 *  its lead (`agentId`) and the spawn's tool_use id (`id`), a teammate by its
 *  own character. */
export interface WorkRef {
  kind: WorkKind;
  agentId?: number;
  id?: string;
}

/** The work view's reference for a temp, or null when it has nothing to read
 *  (a sub-agent whose spawn is not known yet, a Codex worker). */
export function workRefOf(
  kind: TempKind,
  ch: { id: number },
  src: { lead?: { agentId: number; toolId: string } },
): WorkRef | null {
  if (kind === 'subagent')
    return src.lead ? { kind: 'subagent', agentId: src.lead.agentId, id: src.lead.toolId } : null;
  return kind === 'teammate' ? { kind: 'teammate', agentId: ch.id } : null;
}

export interface TempRow {
  id: number;
  kind: TempKind;
  /** The lead's character (the card it sits under), or null: 외주. */
  leadId: number | null;
  name: string;
  task: string;
  model: ModelBadge | null;
  /** The model id as known (the real one once its transcript names it, else the spawn's alias). */
  modelId: string | null;
  phase: TempPhase;
  /** When it came in (ms). */
  since: number;
  /** What its work view reads (T-0056). */
  work: WorkRef | null;
}

export const outsourcedLabel = (): string => t('temps.outsourced');

/** Temps under their lead's card; those with no lead card go to 외주. */
export function groupTemps(
  rows: readonly TempRow[],
  leadCards: ReadonlySet<number>,
): { byLead: Map<number, TempRow[]>; outsourced: TempRow[] } {
  const byLead = new Map<number, TempRow[]>();
  const outsourced: TempRow[] = [];
  for (const row of rows) {
    if (row.leadId !== null && leadCards.has(row.leadId)) {
      byLead.set(row.leadId, [...(byLead.get(row.leadId) ?? []), row]);
    } else outsourced.push(row);
  }
  return { byLead, outsourced };
}

/** At most `max` rows, then "외 N". */
export function capRows<T>(rows: readonly T[], max = 5): { shown: T[]; more: number } {
  return { shown: rows.slice(0, max), more: Math.max(0, rows.length - max) };
}

const FINISHED = ['done', 'failed', 'stopped'] as const;
export const isFinishedCodex = (state: string): boolean =>
  (FINISHED as readonly string[]).includes(state);

/** Finished Codex tasks folded: "Codex 완료 12 · 실패 1 · 중지 1" (null with none). */
export function codexFold(tasks: ReadonlyArray<Pick<CodexTask, 'state'>>): string | null {
  const n = (state: string) => tasks.filter((t) => t.state === state).length;
  const parts = [
    [t('temps.done'), n('done')],
    [t('temps.failed'), n('failed')],
    [t('temps.stopped'), n('stopped')],
  ].filter(([, count]) => count);
  return parts.length ? `Codex ${parts.map(([w, c]) => `${w} ${c}`).join(' · ')}` : null;
}

/** The feed's line when a temp goes home: "fix login · 끝 (4분)". */
export function homeLine(name: string, workedMs: number): string {
  const min = Math.max(1, Math.round(workedMs / 60_000));
  const took = min < 60 ? t('temps.minutes', { count: min }) : t('temps.hoursMinutes', { hours: Math.floor(min / 60), minutes: min % 60 });
  return t('temps.homeLine', { name: cutLine(name, 40), duration: took });
}
