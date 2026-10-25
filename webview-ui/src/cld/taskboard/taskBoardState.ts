/**
 * 작업 현황 (DEV-BOARD), pure: the reported tasks (taskBoard) next to what the
 * engine observes (codexTasks, officeJobs), the 지금 하는 일 strip, the status
 * groups and the filters. F-15: only states and times that exist; no
 * percentage or ETA on the task cards.
 */
import { useSyncExternalStore } from 'react';

import type {
  BoardTask,
  BoardTaskOwner,
  BoardTaskStatus,
  CodexTask,
  OfficeJob,
  TrackedItem,
  TrackedItems,
  TrackedStatus,
  TrackingSources,
} from '../../../../core/src/messages.js';
import { codexKind } from '../panels/jobs.js';

export const STATUS_ORDER: BoardTaskStatus[] = ['doing', 'review', 'blocked', 'proposed', 'todo', 'done'];
export const DONE_SHOWN = 20;
const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, later: 3 };

/** A run the engine saw: a Codex task or a background job. */
export interface ObservedRun {
  kind: 'codex' | 'job';
  id: string;
  project: string | null;
  /** The engine's own state word; `queued` (Codex, worker not started) and `gpuWait` (job holding a GPU queue place) are waits, not running (U-03). */
  state: 'queued' | 'gpuWait' | 'running' | 'limit' | 'done' | 'failed' | 'stopped' | 'unknown';
  title: string | null;
  model?: string | null;
  branch?: string | null;
  /** When it was asked for; `started` is when it really began (null while it waits). */
  created: string | null;
  started: string | null;
  ended: string | null;
  codex?: CodexTask;
  job?: OfficeJob;
}

/** U-48 §10 default: a tracked item whose status is unknown (an ended session) sits in this column, folded with the finished. */
export const UNKNOWN_COLUMN: BoardTaskStatus = 'done';

/** One card of the board: a reported task, an observed run nobody linked, or (U-48) a tracked session. */
export interface BoardItem {
  key: string;
  id: string;
  project: string | null;
  title: string;
  status: BoardTaskStatus;
  source: 'reported' | 'observed' | 'tracked';
  owner: BoardTaskOwner | null;
  /** The latest time this item has (reported: updatedAt; observed: ended or started). */
  updatedAt: string | null;
  /** Since when it is `doing`, as far as the record says. */
  since: string | null;
  task?: BoardTask;
  /** Reported: the runs it links that the engine shows; observed: itself. */
  runs: ObservedRun[];
  /** Reported: linked run ids the engine does not show (finished long ago, or never ran). */
  missing: string[];
  /** U-48, `source: 'tracked'`: the session this card shows. */
  tracked?: TrackedItem;
  /** U-48: the agents' own list lines under this card (a session's list, a Codex run's checklist, or lines naming this Task by id). */
  trackedChildren?: TrackedItem[];
  /** U-48: how many more lines the daemon did not send. */
  trackedMore?: number;
  /** U-48 2a, a Task card: the document lines that define this Task's id (its source lines). */
  trackedDocs?: TrackedItem[];
  /** U-48 2a, a Task card: a document says another status than the Task does (report vs report). */
  trackedDrift?: boolean;
  /** U-48 2a, a Task card: document items that only mention its id (a link, never an item). */
  trackedMentions?: TrackedItem[];
}

const jobId = (j: OfficeJob) => j.id ?? `pid:${j.pid}`;

export function observedRuns(codex: CodexTask[] = [], jobs: OfficeJob[] = []): ObservedRun[] {
  const codexIds = new Set(codex.map((c) => c.id));
  return [
    ...codex.map(
      (c): ObservedRun => ({
        kind: 'codex',
        id: c.id,
        project: c.project,
        state: c.state === 'running' ? codexKind(c) : c.state,
        title: c.title ?? c.spec ?? null,
        model: c.model ?? null,
        branch: c.branch ?? null,
        created: c.created ?? c.started ?? null,
        started: c.started ?? null,
        ended: c.ended ?? null,
        codex: c,
      }),
    ),
    // A Codex task runs as a job of the same id: it shows once, as the Codex task.
    ...jobs
      .filter((j) => !codexIds.has(jobId(j)))
      .map(
        (j): ObservedRun => ({
          kind: 'job',
          id: jobId(j),
          project: j.project,
          state: !j.ended
            ? j.gpu === 'queued'
              ? 'gpuWait'
              : 'running'
            : j.stopped
              ? 'stopped'
              : j.exit === 0
                ? 'done'
                : 'failed',
          title: j.label ?? null,
          created: j.created ?? j.started ?? null,
          started: j.started ?? null,
          ended: j.ended ?? null,
          job: j,
        }),
      ),
  ];
}

/** Where an unlinked run sits on the board: what it is doing, not a guess at more. */
const runStatus = (r: ObservedRun): BoardTaskStatus =>
  r.state === 'running'
    ? 'doing'
    : r.state === 'limit' || r.state === 'gpuWait'
      ? 'blocked'
      : r.state === 'queued'
        ? 'todo'
        : 'done';

/** The latest record that made the task `doing`, else when it was written (it came in as `doing`). */
export function doingSince(task: BoardTask): string | null {
  for (let i = task.history.length - 1; i >= 0; i--)
    if (/status \S+ → doing/.test(task.history[i].change)) return task.history[i].at;
  return task.history.some((h) => h.change.startsWith('status ')) ? null : task.createdAt;
}

/** The board column of a tracked item's status (the six board words; unknown and cancelled sit with the finished, see UNKNOWN_COLUMN). */
export const trackedColumn = (status: TrackedStatus): BoardTaskStatus =>
  status === 'unknown' || status === 'cancelled' ? UNKNOWN_COLUMN : status;

/** U-48 2a: a document item is a card of its own (a document) or a line under one. */
export const isDocCard = (i: TrackedItem) => i.kind === 'doc' && !i.parentKey;
/** The document card a doc line sits under (its key up to `#`). */
const docRoot = (key: string) => key.slice(0, key.indexOf('#') < 0 ? key.length : key.indexOf('#'));

/**
 * U-48 2a §4: the document's status next to the Task's. Only report vs report, only when the
 * document says something (unknown or gone says nothing); proposed reads as todo.
 */
export function docDrift(task: BoardTask, line: TrackedItem): boolean {
  if (line.gone || line.status === 'unknown') return false;
  const t = task.status === 'proposed' ? 'todo' : task.status;
  return line.status !== t;
}

/**
 * U-48: the tracked items next to the cards. A session is a card of its own with its list
 * folded under it; a Codex run's checklist goes under the run's card; a line that names a
 * Task by its exact id (T-n) goes under that Task's card instead. Nothing else is linked.
 */
function attachTracked(items: BoardItem[], tasks: BoardTask[], tracked: TrackedItems[]): BoardItem[] {
  const taskIds = new Set(tasks.map((t) => t.id));
  const taskOf = new Map(tasks.map((t) => [t.id, t]));
  const lines = tracked.flatMap((m) => m.items.map((item) => ({ project: m.project, item })));
  const more = new Map(tracked.flatMap((m) => (m.more ?? []).map((x) => [x.parentKey, x.count] as const)));
  const under = new Map<string, TrackedItem[]>();
  const put = (map: Map<string, TrackedItem[]>, key: string, item: TrackedItem) => map.set(key, [...(map.get(key) ?? []), item]);
  const docsOf = new Map<string, TrackedItem[]>();
  const mentionsOf = new Map<string, TrackedItem[]>();
  const taskCard = new Map(items.filter((i) => i.task).map((i) => [i.id, i.key]));
  const runCard = new Map<string, string>(
    items.flatMap((i) => i.runs.filter((r) => r.kind === 'codex').map((r) => [`codex:${r.id}`, i.key] as const)),
  );
  const cards: BoardItem[] = [];
  const card = (project: string, item: TrackedItem): BoardItem => ({
    key: item.key,
    id: item.kind === 'doc' ? (item.taskId ?? item.path ?? item.key) : (item.ref ?? item.key),
    project,
    title: item.title,
    status: trackedColumn(item.status),
    source: 'tracked',
    owner: null,
    updatedAt: item.changedAt ?? null,
    since: null,
    runs: [],
    missing: [],
    tracked: item,
    trackedMore: more.get(item.key),
  });
  for (const { project, item } of lines) {
    if (item.kind === 'doc') {
      // A document's id that is a Task of the same project: a source line on that Task's card (§4).
      const task = item.taskId ? taskOf.get(item.taskId) : undefined;
      if (task && task.project === project) {
        put(docsOf, task.id, item);
        continue;
      }
      for (const r of item.refs ?? []) {
        const t = taskOf.get(r);
        if (t && t.project === project && r !== item.taskId) put(mentionsOf, t.id, item);
      }
      if (isDocCard(item)) cards.push(card(project, item));
      else put(under, docRoot(item.key), item);
      continue;
    }
    if (item.kind === 'session') {
      cards.push(card(project, item));
      continue;
    }
    const linked = item.taskId && taskIds.has(item.taskId) ? taskCard.get(item.taskId) : undefined;
    const parent = linked ?? (item.parentKey ? (runCard.get(item.parentKey) ?? item.parentKey) : undefined);
    if (parent) put(under, parent, item);
  }
  // A document whose own id is a Task: its lines go under that Task's card too.
  const docCardTask = new Map<string, string>();
  for (const [id, docs] of docsOf) for (const d of docs) if (isDocCard(d)) docCardTask.set(d.key, id);
  for (const [root, task] of docCardTask) {
    const key = taskCard.get(task);
    if (key) for (const l of under.get(root) ?? []) put(under, key, l);
    under.delete(root);
  }
  const all = [...items, ...cards];
  for (const c of all) {
    const children = under.get(c.key);
    if (children) c.trackedChildren = children;
    if (c.source !== 'tracked') {
      const run = c.runs.find((r) => more.has(`codex:${r.id}`));
      if (run) c.trackedMore = more.get(`codex:${run.id}`);
    }
    if (c.task) {
      const docs = docsOf.get(c.task.id);
      if (docs) {
        c.trackedDocs = docs;
        c.trackedDrift = docs.some((d) => docDrift(c.task!, d));
      }
      const mentions = mentionsOf.get(c.task.id);
      if (mentions) c.trackedMentions = mentions;
    }
  }
  return all;
}

export function boardItems(
  tasks: BoardTask[],
  codex: CodexTask[] = [],
  jobs: OfficeJob[] = [],
  tracked: TrackedItems[] = [],
): BoardItem[] {
  const runs = observedRuns(codex, jobs);
  const linked = new Set<string>();
  const items = tasks.map((task): BoardItem => {
    // D6: the Executions are runs too (a link made before D6 is one with the same id).
    const refs = [
      ...(task.links ?? []).filter((l) => l.kind !== 'url'),
      ...(task.executions ?? []).filter((e) => e.kind !== 'agent'),
    ].filter((l, i, all) => all.findIndex((m) => m.kind === l.kind && m.ref === l.ref) === i);
    const found: ObservedRun[] = [];
    const missing: string[] = [];
    for (const l of refs) {
      const run = runs.find((r) => r.id === l.ref && (r.kind === l.kind || l.kind === 'job'));
      if (run) {
        found.push(run);
        linked.add(`${run.kind}:${run.id}`);
      } else missing.push(l.ref);
    }
    return {
      key: task.id,
      id: task.id,
      project: task.project,
      title: task.title,
      status: task.status,
      source: 'reported',
      owner: task.owner ?? null,
      updatedAt: task.updatedAt,
      since: task.status === 'doing' ? doingSince(task) : null,
      task,
      runs: found,
      missing,
    };
  });
  for (const r of runs) {
    if (linked.has(`${r.kind}:${r.id}`)) continue;
    const status = runStatus(r);
    items.push({
      key: `${r.kind}:${r.id}`,
      id: r.id,
      project: r.project,
      title: r.title ?? (r.kind === 'codex' ? 'Codex' : r.id),
      status,
      source: 'observed',
      owner:
        r.kind === 'codex'
          ? { kind: 'codex', name: r.model ? `Codex ${r.model}` : 'Codex' }
          : r.project
            ? { kind: 'lead', name: r.project }
            : null,
      updatedAt: r.ended ?? r.started ?? r.created,
      since: status === 'doing' ? r.started : null,
      runs: [r],
      missing: [],
    });
  }
  return tracked.length ? attachTracked(items, tasks, tracked) : items;
}

/**
 * D6: children under their parent, one level shown: a task whose parent (or
 * any ancestor) is among `items` goes under the topmost of them; the rest stay
 * on top. Order is kept.
 */
export function nestItems(items: BoardItem[]): { top: BoardItem[]; children: Map<string, BoardItem[]> } {
  const byId = new Map(items.filter((i) => i.task).map((i) => [i.id, i]));
  const rootOf = (i: BoardItem): BoardItem => {
    let root = i;
    const seen = new Set([i.id]);
    for (let up = i.task?.parentId; up && byId.has(up) && !seen.has(up); up = byId.get(up)!.task?.parentId) {
      root = byId.get(up)!;
      seen.add(up);
    }
    return root;
  };
  const top: BoardItem[] = [];
  const children = new Map<string, BoardItem[]>();
  for (const i of items) {
    const root = rootOf(i);
    if (root === i) top.push(i);
    else children.set(root.key, [...(children.get(root.key) ?? []), i]);
  }
  return { top, children };
}

/** D6: the assignee to show: its name, and whether its agent is gone (its tasks stay). */
export function assigneeOf(
  task: BoardTask | undefined,
  removed: readonly string[] = [],
): { name: string; removed: boolean } | null {
  const a = task?.assignee;
  return a ? { name: a.name, removed: removed.includes(a.assignmentId) } : null;
}

export const ownerKey = (o: BoardTaskOwner | null): string =>
  o ? `${o.kind}:${o.name}` : 'unassigned:';

export interface BoardFilter {
  project: string | null;
  goal: string | null;
  owner: string | null;
}
export const NO_FILTER: BoardFilter = { project: null, goal: null, owner: null };

/** The server's fixed MVP goals, kept in board order for filters and progress. */
export const GOALS = [
  'Security',
  'Core Orchestration',
  'Collaboration & Workbench',
  'Desktop & Installer',
  'UX & Onboarding',
  'Release Candidate',
  'Public Release',
] as const;
export type Goal = (typeof GOALS)[number];
export const OTHER_GOAL = 'other';
export const OVERALL_GOAL = 'overall';

export interface GoalProgressRow {
  goal: Goal | typeof OTHER_GOAL;
  total: number;
  done: number;
  active: number;
}

export interface OverallProgressRow extends Omit<GoalProgressRow, 'goal'> {
  goal: typeof OVERALL_GOAL;
}

export interface GoalProgress {
  goals: GoalProgressRow[];
  overall: OverallProgressRow;
}

/**
 * MVP progress is deliberately a project overview: it retains the project
 * filter but never narrows itself to the selected goal. Observed runs are not
 * tasks, so only reported task cards contribute.
 */
export function goalProgress(items: BoardItem[], filter: BoardFilter = NO_FILTER): GoalProgress {
  const counted = items.filter((item) => item.task && (!filter.project || item.project === filter.project));
  const row = (goal: Goal | typeof OTHER_GOAL): GoalProgressRow => {
    const matching = counted.filter((item) =>
      goal === OTHER_GOAL ? !item.task?.goal : item.task?.goal === goal,
    );
    return {
      goal,
      total: matching.length,
      done: matching.filter((item) => item.status === 'done').length,
      active: matching.filter((item) => item.status === 'doing' || item.status === 'review').length,
    };
  };
  const goals = GOALS.map(row);
  const other = row(OTHER_GOAL);
  if (other.total) goals.push(other);
  return {
    goals,
    overall: goals
      .filter((progress) => progress.goal !== OTHER_GOAL)
      .reduce<OverallProgressRow>(
        (total, progress) => ({
          goal: OVERALL_GOAL,
          total: total.total + progress.total,
          done: total.done + progress.done,
          active: total.active + progress.active,
        }),
        { goal: OVERALL_GOAL, total: 0, done: 0, active: 0 },
      ),
  };
}

/** Select a summary row, or clear that goal when its selected row is clicked again. */
export function toggleGoalFilter(filter: BoardFilter, goal: Goal): BoardFilter {
  return { ...filter, goal: filter.goal === goal ? null : goal };
}

export function filterItems(items: BoardItem[], f: BoardFilter): BoardItem[] {
  return items.filter(
    (i) =>
      (!f.project || i.project === f.project) &&
      (!f.goal || i.task?.goal === f.goal) &&
      (!f.owner || ownerKey(i.owner) === f.owner),
  );
}

/** The choices each filter offers, from what the items hold. */
export function filterChoices(items: BoardItem[]) {
  const uniq = (xs: Array<string | null | undefined>) =>
    [...new Set(xs.filter((x): x is string => !!x))].sort();
  const owners = new Map<string, BoardTaskOwner>();
  for (const i of items) if (i.owner) owners.set(ownerKey(i.owner), i.owner);
  return {
    projects: uniq(items.map((i) => i.project)),
    goals: uniq(items.map((i) => i.task?.goal)),
    owners: [...owners.entries()].sort(([a], [b]) => a.localeCompare(b)),
  };
}

/**
 * U-48: how many agent list lines (a list's or a checklist's, including the ones the daemon
 * left out) the daemon sent for this project filter. Session cards and "unreadable" lines are
 * not lines; none of it is a Task, so no progress count has it.
 */
export function trackedCount(tracked: TrackedItems[], project: string | null = null): number {
  return tracked
    .filter((m) => !project || m.project === project)
    .reduce(
      (n, m) =>
        n +
        m.items.filter((i) => i.kind !== 'session' && !isDocCard(i) && !i.unreadable && !i.gone).length +
        (m.more ?? []).reduce((k, x) => k + x.count, 0),
      0,
    );
}

const ms = (s: string | null) => (s ? Date.parse(s) || 0 : 0);

/** The status groups in board order; within a group P0 first, then the latest. 끝남 keeps its latest `DONE_SHOWN`. */
export function groupItems(items: BoardItem[]) {
  return STATUS_ORDER.map((status) => {
    const all = items
      .filter((i) => i.status === status)
      .sort((a, b) =>
        status === 'done'
          ? ms(b.updatedAt) - ms(a.updatedAt)
          : (PRIORITY_RANK[a.task?.priority ?? ''] ?? 9) - (PRIORITY_RANK[b.task?.priority ?? ''] ?? 9) ||
            ms(b.updatedAt) - ms(a.updatedAt),
      );
    const shown = status === 'done' ? all.slice(0, DONE_SHOWN) : all;
    return { status, items: shown, total: all.length };
  });
}

/** 지금 하는 일: one row per owner with `doing` items, the longest-running first. */
export function nowStrip(items: BoardItem[]) {
  const rows = new Map<string, { owner: BoardTaskOwner | null; items: BoardItem[] }>();
  for (const i of items) {
    // A tracked session has no owner of its own: its card is in the 진행 group, not in this strip.
    if (i.status !== 'doing' || i.source === 'tracked') continue;
    const key = ownerKey(i.owner);
    const row = rows.get(key) ?? { owner: i.owner, items: [] };
    row.items.push(i);
    rows.set(key, row);
  }
  const first = (r: { items: BoardItem[] }) =>
    Math.min(...r.items.map((i) => ms(i.since) || Number.MAX_SAFE_INTEGER));
  return [...rows.entries()]
    .map(([key, r]) => ({ key, ...r }))
    .sort((a, b) => first(a) - first(b) || a.key.localeCompare(b.key));
}

// ── 업무 | 실행: which half of the 작업 tab shows (a notice for a job opens 실행) ──

export type JobsView = 'tasks' | 'runs';
let view: JobsView = 'tasks';
const listeners = new Set<() => void>();
export function setJobsView(next: JobsView): void {
  if (view === next) return;
  view = next;
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
export const useJobsView = () => useSyncExternalStore(subscribe, () => view);

// ── U-48 2a: the 문서 출처 answer (trackingSources), per project ──

let docSources: Record<string, TrackingSources> = {};
const docListeners = new Set<() => void>();
export function docSourcesHandleMessage(msg: TrackingSources): void {
  docSources = { ...docSources, [msg.project]: msg };
  docListeners.forEach((l) => l());
}
const subscribeDocs = (l: () => void) => {
  docListeners.add(l);
  return () => {
    docListeners.delete(l);
  };
};
export const useDocSources = (project: string) => useSyncExternalStore(subscribeDocs, () => docSources[project]);
