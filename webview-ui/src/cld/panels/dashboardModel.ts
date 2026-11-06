/**
 * A5 (GPT mockup look): the 현황판's counts and lists, pure. Every figure counts records the daemon
 * sent (the office's orchestrators, the Task store, the jobs, the feed); nothing is estimated, and a
 * Task carries no progress (F-15), so none is drawn.
 */
import type { BoardTask, OfficeOrchestrator } from '../../../../core/src/messages.js';
import type { ToolActivity } from '../../office/types.js';
import type { IconName } from '../game/parts.js';
import type { WaitReason } from '../waiting.js';

/** The Task statuses the board lists as in progress: someone works on it, or it waits on the owner. A 할 일
 *  answers no "who does what now" (it is the issue board's), so it is left out (IA review 11-06). */
const OPEN = ['blocked', 'doing', 'review'] as const;
type OpenStatus = (typeof OPEN)[number];
/** A row's pill: the Task's own status, or its assignee waiting on the owner (a permission, a question). */
export type Pill = OpenStatus | WaitReason;
/** What needs the owner first. */
const PILL_RANK: Record<Pill, number> = { permission: 0, blocked: 1, question: 2, doing: 3, review: 4 };

export interface TaskRow {
  task: BoardTask;
  /** Who works on it: its assignee, else its owner (an unassigned owner is nobody). */
  who: string | null;
  pill: Pill;
}

export const taskWho = (task: Pick<BoardTask, 'assignee' | 'owner'>): string | null =>
  task.assignee?.name ?? (task.owner && task.owner.kind !== 'unassigned' ? task.owner.name : null);

/** The Tasks in progress in the picked room, the most urgent first, then the latest change. */
export function taskRows(
  tasks: readonly BoardTask[],
  waitOf: (name: string) => WaitReason | null,
  inRoom: (project: string) => boolean,
): TaskRow[] {
  return tasks
    .filter((task) => (OPEN as readonly string[]).includes(task.status) && inRoom(task.project))
    .map((task) => {
      const who = taskWho(task);
      // A blocked Task stays blocked whatever its agent does now.
      const wait = task.status !== 'blocked' && who ? waitOf(who) : null;
      return { task, who, pill: wait ?? (task.status as OpenStatus) };
    })
    .sort(
      (a, b) =>
        PILL_RANK[a.pill] - PILL_RANK[b.pill] ||
        (Date.parse(b.task.updatedAt) || 0) - (Date.parse(a.task.updatedAt) || 0),
    );
}

/** The history line the daemon writes when a change made the Task done ("status doing → done", maybe among others). */
const TO_DONE = /(^|, )status \S+ → done(,|$)/;

/**
 * When a done Task became done: its last history line that turned it done, or the line that added it
 * already done. Null when no line says (an import), so a later note never counts it again.
 */
export function doneAt(task: Pick<BoardTask, 'status' | 'history'>): string | null {
  if (task.status !== 'done') return null;
  // ponytail: the daemon keeps the last lines of a history only; a Task changed that often since it turned done has no done time.
  for (let i = task.history.length - 1; i >= 0; i--) {
    const h = task.history[i];
    if (TO_DONE.test(h.change) || h.change === 'add') return h.at;
  }
  return null;
}

/** Tasks that became done today (the viewer's calendar day), by their history. */
export function doneToday(tasks: readonly Pick<BoardTask, 'status' | 'history'>[], now: number): number {
  const day = new Date(now).toDateString();
  return tasks.filter((x) => {
    const at = doneAt(x);
    return at !== null && new Date(at).toDateString() === day;
  }).length;
}

export const blockedCount = (tasks: readonly Pick<BoardTask, 'status'>[]): number =>
  tasks.filter((x) => x.status === 'blocked').length;

export type KpiId = 'working' | 'waiting' | 'blocked' | 'doneToday' | 'jobs';
export interface Kpi {
  id: KpiId;
  icon: IconName;
  tone: 'accent' | 'warn' | 'bad' | 'ok';
  value: number;
  /** Work waiting its turn (the jobs card's small line), when any. */
  queued?: number;
}

/** The count cards, the window's and the billboard's: the whole office, every one a count of records. */
export function kpis(o: {
  working: number;
  waiting: number;
  tasks: readonly Pick<BoardTask, 'status' | 'history'>[];
  work: { running: number; queued: number; gpuWait: number; limit: number };
  now: number;
}): Kpi[] {
  const queued = o.work.queued + o.work.gpuWait + o.work.limit;
  return [
    { id: 'working', icon: 'person', tone: 'accent', value: o.working },
    { id: 'waiting', icon: 'ask', tone: 'warn', value: o.waiting },
    { id: 'blocked', icon: 'stop', tone: 'bad', value: blockedCount(o.tasks) },
    { id: 'doneToday', icon: 'check', tone: 'ok', value: doneToday(o.tasks, o.now) },
    { id: 'jobs', icon: 'case', tone: 'accent', value: o.work.running, ...(queued > 0 && { queued }) },
  ];
}

export interface Approval {
  agentId: number;
  name: string;
  reason: WaitReason;
  /** A permission's open call as the tool reports it ("Bash: git push --force"), when there is one. */
  what: string | null;
}

/** Who waits on the owner, permissions first: only agents the office names. */
export function approvals(
  reasons: Readonly<Record<number, WaitReason>>,
  orchestrators: readonly OfficeOrchestrator[],
  tools: Readonly<Record<number, ToolActivity[]>>,
  inRoom: (name: string) => boolean,
): Approval[] {
  const out: Approval[] = [];
  for (const o of orchestrators) {
    const reason = o.agentId == null ? undefined : reasons[o.agentId];
    if (!reason || o.agentId == null || !inRoom(o.name)) continue;
    const call = tools[o.agentId]?.find((x) => !x.done && x.permissionWait);
    out.push({ agentId: o.agentId, name: o.name, reason, what: reason === 'permission' ? (call?.status ?? null) : null });
  }
  return out.sort((a, b) => Number(b.reason === 'permission') - Number(a.reason === 'permission') || a.name.localeCompare(b.name));
}

/** A feed event's mark (the pixel set has no emoji to miss): by its kind only, never guessing an outcome. */
export function activityIcon(kind: string): IconName {
  if (kind.endsWith('_start') || kind === 'codex_resume') return 'play';
  if (kind === 'job_end' || (kind.startsWith('codex_') && kind.endsWith('_end'))) return 'flag';
  if (kind.startsWith('delegat') || kind === 'task_report') return 'scroll';
  if (kind.startsWith('gpu_')) return 'bolt';
  if (kind.startsWith('usage_')) return 'clock';
  if (kind.startsWith('orch_') || kind.startsWith('lead_') || kind === 'revive' || kind.startsWith('renew')) return 'person';
  if (kind === 'stop' || kind === 'codex_limit') return 'stop';
  return 'log';
}
