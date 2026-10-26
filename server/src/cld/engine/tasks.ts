/**
 * 작업 현황 (DEV-BOARD) and the Task store (D6): the tasks of every project, in
 * ~/.config/agent-tycoon/tasks.json ({v:2, tasks}, 0600, tmp+rename; the daemon is
 * the only writer). A file this store cannot read is left exactly as it is and
 * reported; nothing is written over it.
 *
 * D6 (B §2, §7): a task may have a parent, an assignee (an engine agent, kept by
 * its assignment id, shown by name), who made it and who delegated it, and
 * facts with their own source (`statusSource`, `reportedDone`, `commits`,
 * `filesChanged`, `testsRan`, `testsPassed`: {value, source, at}). Everything
 * written through add/update/import is a report (`reported`); only observe()
 * records what the daemon measured (`observed`) or guessed (`inferred`), and
 * only on Executions: a task's status never follows a run (the Lead or the user
 * reports it). Executions are the Codex tasks and jobs attached to a task
 * (`--task`, or a `--codex`/`--job` link).
 *
 * Migration (like D2's projects.json): a v1 file becomes v2 on load, every v1
 * field kept as it is (checked before anything is written), plus `statusSource:
 * reported` and one Execution per codex/job link (same ids). The v1 bytes are
 * kept as tasks.json.v1 (never overwritten), then v2 replaces the file by a
 * rename, so a crash leaves the v1 file. A read-only daemon writes nothing:
 * it shows the migrated view and refuses edits until a normal start migrates.
 * A v1 daemon refuses a v2 file (not {v:1}) and never writes over it.
 *
 * F-15: a task holds states and times, never a percentage or ETA.
 */
import { isDeepStrictEqual } from 'node:util';

import * as path from 'path';

import { koText } from '../../../../core/src/cld/serverText.js';
import type { BoardExecution, BoardTask, TaskBoard } from '../../../../core/src/messages.js';
import { CLI_NAME } from '../cliName.js';
import { readJson, writeJsonAtomic } from '../jsonFile.js';
import { maskText } from '../mask.js';
import type { CodexRecord } from './codex.js';
import { SUMMARY_MAX } from './codex.js';
import { configDir } from './events.js';
import type { JobRecord } from './jobs.js';
import { ASSIGNMENT_ID_RE, keepCopy } from './registry.js';

export const TASKS_VERSION = 2;

/** `proposed` (C5a): a Worker's create_task, addressed to its Lead, who takes it or not. */
export const STATUSES = ['proposed', 'todo', 'doing', 'review', 'blocked', 'done'] as const;
export const PRIORITIES = ['P0', 'P1', 'P2', 'later'] as const;
export const GOALS = [
  'Security',
  'Core Orchestration',
  'Collaboration & Workbench',
  'Desktop & Installer',
  'UX & Onboarding',
  'Release Candidate',
  'Public Release',
] as const;
export const OWNER_KINDS = ['lead', 'worker', 'subagent', 'codex', 'user', 'unassigned'] as const;
const LINK_KINDS = ['codex', 'job', 'url'] as const;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;
const PROJECT_RE = /^[A-Za-z0-9가-힣][A-Za-z0-9가-힣._-]{0,40}$/;
const HISTORY_MAX = 50;
const EXECUTIONS_MAX = 100;
const TASKS_MAX = 2000;
const BUDGET_MAX = 100_000;
const MAX = {
  title: 200,
  detail: 4000,
  note: 2000,
  name: 80,
  branch: 200,
  worktree: 500,
  ref: 500,
};

export type Task = BoardTask;
export type Execution = BoardExecution;
type Reply = Record<string, unknown> & { ok: boolean };
const refuse = (code: string, error: string): Reply => ({ ok: false, code, error });

export const tasksPath = (home?: string) => path.join(configDir(home), 'tasks.json');

const oneOf = <T extends string>(list: readonly T[], x: unknown): x is T =>
  typeof x === 'string' && (list as readonly string[]).includes(x);
const text = (x: unknown, max: number): string | null =>
  typeof x === 'string' &&
  x.length <= max &&
  !/[\x00-\x08\x0b-\x1f\x7f]/.test(x.replace(/\r?\n/g, ' '))
    ? x
    : null;
const isoOf = (x: unknown): string | null =>
  typeof x === 'string' && Number.isFinite(Date.parse(x)) ? x : null;

/** The editable fields of a task (what add, update and import may carry). */
type Fields = Partial<
  Pick<
    Task,
    | 'parentId'
    | 'assignee'
    | 'delegatedBy'
    | 'commits'
    | 'filesChanged'
    | 'testsRan'
    | 'testsPassed'
    | 'project'
    | 'title'
    | 'detail'
    | 'status'
    | 'priority'
    | 'goal'
    | 'owner'
    | 'branch'
    | 'worktree'
    | 'links'
    | 'note'
    | 'externalRef'
    | 'budget'
  >
>;
/** A field set to `null` is removed from the task (the CLI's `--branch ''`). */
type Patch = { [K in keyof Fields]?: Fields[K] | null };

const reported = <T>(value: T, at: string) => ({ value, source: 'reported' as const, at });
const BOOL: Record<string, boolean> = { true: true, yes: true, false: false, no: false };

/**
 * `raw`, checked: the patch, or why not. Empty strings clear an optional field.
 * `codex`/`job` (one id each, the CLI's --codex/--job) add a link to the given `links`.
 * Facts given here are reports made `at`; the same value again keeps the earlier one.
 */
export function parseFields(raw: Record<string, unknown>, prev?: Task, at = ''): Patch | string {
  const p: Patch = {};
  const clear = (x: unknown) => x === '' || x === null;
  if (raw.parentId !== undefined) {
    if (clear(raw.parentId)) p.parentId = null;
    else if (typeof raw.parentId !== 'string' || !ID_RE.test(raw.parentId))
      return 'parent: 작업 id 가 올바르지 않습니다';
    else p.parentId = raw.parentId;
  }
  if (raw.assignee !== undefined) {
    const a = raw.assignee as { assignmentId?: unknown; name?: unknown } | null;
    if (clear(a)) p.assignee = null;
    else if (
      !a ||
      typeof a !== 'object' ||
      typeof a.assignmentId !== 'string' ||
      !ASSIGNMENT_ID_RE.test(a.assignmentId) ||
      !text(a.name, MAX.name)?.trim()
    )
      return 'assignee: 에이전트 이름이 필요합니다';
    else p.assignee = { assignmentId: a.assignmentId, name: String(a.name).trim() };
  }
  // A fact as `list --json` prints it ({value, source, at}) gives its value only: whatever
  // source it claims, what comes in here is a report.
  const valueOf = (x: unknown) =>
    x && typeof x === 'object' && 'value' in x ? (x as { value: unknown }).value : x;
  for (const key of ['commits', 'filesChanged'] as const) {
    const v = valueOf(raw[key]);
    if (v === undefined) continue;
    if (clear(v)) {
      p[key] = null;
      continue;
    }
    const n = typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 1e9)
      return `${key}: 0 이상의 정수여야 합니다`;
    p[key] =
      prev?.[key]?.value === n && prev[key]?.source === 'reported' ? prev[key] : reported(n, at);
  }
  for (const key of ['testsRan', 'testsPassed'] as const) {
    const v = valueOf(raw[key]);
    if (v === undefined) continue;
    if (clear(v)) {
      p[key] = null;
      continue;
    }
    const b =
      typeof v === 'boolean' ? v : typeof v === 'string' ? BOOL[v.toLowerCase()] : undefined;
    if (b === undefined) return `${key}: yes 또는 no 여야 합니다`;
    p[key] =
      prev?.[key]?.value === b && prev[key]?.source === 'reported' ? prev[key] : reported(b, at);
  }
  const str = (key: 'detail' | 'note' | 'branch' | 'worktree', max: number): string | null => {
    if (raw[key] === undefined) return null;
    const v = text(raw[key], max);
    if (v === null) return `${key}: ${max}자 이하 글이어야 합니다`;
    p[key] = v.trim() ? v : null;
    return null;
  };
  if (raw.project !== undefined) {
    if (typeof raw.project !== 'string' || !PROJECT_RE.test(raw.project))
      return `project: 프로젝트 이름이 올바르지 않습니다`;
    p.project = raw.project;
  }
  if (raw.title !== undefined) {
    const v = text(raw.title, MAX.title)?.trim();
    if (!v) return `title: 1~${MAX.title}자 제목이 필요합니다`;
    p.title = v;
  }
  for (const [key, max] of [
    ['detail', MAX.detail],
    ['note', MAX.note],
    ['branch', MAX.branch],
    ['worktree', MAX.worktree],
  ] as const) {
    const err = str(key, max);
    if (err) return err;
  }
  if (raw.status !== undefined) {
    if (!oneOf(STATUSES, raw.status)) return `status: ${STATUSES.join('|')} 중 하나여야 합니다`;
    p.status = raw.status;
  }
  if (raw.priority !== undefined) {
    if (raw.priority === '' || raw.priority === null) p.priority = null;
    else if (!oneOf(PRIORITIES, raw.priority))
      return `priority: ${PRIORITIES.join('|')} 중 하나여야 합니다`;
    else p.priority = raw.priority;
  }
  if (raw.goal !== undefined) {
    if (raw.goal === '' || raw.goal === null) p.goal = null;
    else if (!oneOf(GOALS, raw.goal)) return `goal: ${GOALS.join(' | ')} 중 하나여야 합니다`;
    else p.goal = raw.goal;
  }
  if (raw.owner !== undefined) {
    const o = raw.owner as { kind?: unknown; name?: unknown } | null;
    if (!o || typeof o !== 'object' || !oneOf(OWNER_KINDS, o.kind))
      return `owner: ${OWNER_KINDS.join('|')}:이름 형식이어야 합니다`;
    const name = text(o.name ?? '', MAX.name);
    if (name === null) return `owner: 이름은 ${MAX.name}자 이하여야 합니다`;
    p.owner = { kind: o.kind, name: name.trim() };
  }
  let links: Task['links'] | undefined;
  if (raw.links !== undefined) {
    if (!Array.isArray(raw.links) || raw.links.length > 20)
      return 'links: 20개 이하 목록이어야 합니다';
    links = [];
    for (const l of raw.links as Array<{ kind?: unknown; ref?: unknown }>) {
      const ref = l && text(l.ref, MAX.ref)?.trim();
      if (!l || !oneOf(LINK_KINDS, l.kind) || !ref)
        return `links: {kind: ${LINK_KINDS.join('|')}, ref} 이어야 합니다`;
      links.push({ kind: l.kind, ref });
    }
  }
  for (const kind of ['codex', 'job'] as const) {
    if (raw[kind] === undefined) continue;
    const ref = text(raw[kind], MAX.ref)?.trim();
    if (!ref) return `${kind}: id 가 필요합니다`;
    links = links ?? [...(prev?.links ?? [])];
    if (!links.some((l) => l.kind === kind && l.ref === ref)) links.push({ kind, ref });
  }
  if (links) p.links = links.length ? links : null;
  if (raw.budget !== undefined) {
    // C6: a delegation's budget (stored; K2 enforces turns and minutes at runtime).
    const b = raw.budget as Record<string, unknown> | null;
    if (clear(b)) p.budget = null;
    else {
      const out: NonNullable<Task['budget']> = {};
      for (const k of ['maxTurns', 'maxMinutes'] as const) {
        const v = b && typeof b === 'object' ? b[k] : NaN;
        if (v === undefined) continue;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > BUDGET_MAX)
          return `budget.${k}: 1~${BUDGET_MAX} 정수여야 합니다`;
        out[k] = v;
      }
      if (!b || typeof b !== 'object' || !Object.keys(out).length)
        return 'budget: {maxTurns?, maxMinutes?} 이어야 합니다';
      p.budget = out;
    }
  }
  if (raw.externalRef !== undefined) {
    const e = raw.externalRef as Record<string, unknown> | null;
    const system = e && text(e.system, 40);
    const key = e && text(e.key, 100);
    const url = e?.url === undefined ? undefined : e && text(e.url, MAX.ref);
    if (!system || !key || url === null) return 'externalRef: {system, key, url?} 이어야 합니다';
    p.externalRef = { system, key, ...(url && { url }) };
  }
  return p;
}

/** One line of what changed, for the task's history. */
function describe(prev: Task, next: Task): string[] {
  const out: string[] = [];
  const show = (v: unknown) =>
    v === undefined || v === '' ? '—' : typeof v === 'object' ? ownerText(v) : String(v);
  for (const key of [
    'status',
    'priority',
    'goal',
    'owner',
    'assignee',
    'parentId',
    'delegatedBy',
    'project',
    'branch',
  ] as const)
    if (JSON.stringify(prev[key]) !== JSON.stringify(next[key]))
      out.push(`${key} ${show(prev[key])} → ${show(next[key])}`);
  for (const key of ['commits', 'filesChanged', 'testsRan', 'testsPassed'] as const)
    if (JSON.stringify(prev[key]) !== JSON.stringify(next[key]))
      out.push(`${key} ${show(prev[key]?.value)} → ${show(next[key]?.value)}`);
  for (const key of [
    'title',
    'detail',
    'note',
    'worktree',
    'links',
    'executions',
    'externalRef',
    'budget',
  ] as const)
    if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) out.push(key);
  return out;
}
const ownerText = (o: unknown) => {
  const owner = o as { kind?: string; name?: string; assignmentId?: string };
  if (owner.assignmentId) return owner.name ?? owner.assignmentId;
  return owner.kind ? `${owner.kind}:${owner.name ?? ''}` : JSON.stringify(o);
};

/** Every codex/job link has its Execution (same id; a link made before D6 becomes one). */
function withExecutions(task: Task): Task {
  const runs = (task.links ?? []).filter(
    (l): l is { kind: 'codex' | 'job'; ref: string } => l.kind === 'codex' || l.kind === 'job',
  );
  const have = new Set((task.executions ?? []).map((e) => e.id));
  const add = runs
    .map((l): Execution => ({ id: `${l.kind}:${l.ref}`, kind: l.kind, ref: l.ref }))
    .filter((e) => !have.has(e.id) && have.add(e.id));
  return add.length
    ? { ...task, executions: [...(task.executions ?? []), ...add].slice(-EXECUTIONS_MAX) }
    : task;
}

/** D6: a v1 task as v2: every field kept, its status a report, its links Executions. */
export function migrateTask(t: Task): Task {
  return withExecutions({ ...t, statusSource: 'reported' });
}

const isTask = (t: unknown): t is Task => !!t && typeof t === 'object' && !Array.isArray(t);

/** A v1 list's v2 form, or why not: any v1 field that would not survive as it is. Throws on
 *  a list that is not tasks (a null task, links or executions that are not lists). */
export function migrateTasks(v1: Task[]): Task[] | string {
  for (const t of v1) {
    if (!isTask(t)) throw new Error('작업이 아닌 항목');
    if (t.links !== undefined && !(Array.isArray(t.links) && t.links.every(isTask)))
      throw new Error(`${String(t.id)}: links 가 목록이 아닙니다`);
    if (t.executions !== undefined && !Array.isArray(t.executions))
      throw new Error(`${String(t.id)}: executions 가 목록이 아닙니다`);
  }
  const v2 = v1.map(migrateTask);
  for (const [i, t] of v1.entries()) {
    const kept = Object.fromEntries(
      Object.keys(t).map((k) => [k, (v2[i] as unknown as Record<string, unknown>)[k]]),
    );
    if (!isDeepStrictEqual(kept, t)) return `${String(t?.id)}: 옮기면 바뀌는 필드가 있습니다`;
  }
  return v2;
}

/** What the daemon reads to settle Executions: the run records, or null when gone. */
export interface ExecutionSources {
  codex(id: string): CodexRecord | null;
  job(id: string): JobRecord | null;
}

const observed = <T>(value: T, at: string) => ({ value, source: 'observed' as const, at });

/** An Execution with what its record says now (the same object when nothing is new). */
function observeOne(e: Execution, src: ExecutionSources, at: string): Execution {
  const r = e.kind === 'codex' ? src.codex(e.ref) : e.kind === 'job' ? src.job(e.ref) : null;
  if (!r) return e;
  const n: Execution = { ...e };
  if (!n.startedAt && r.started) n.startedAt = r.started;
  if (!n.log && r.log) n.log = r.log;
  const codex = e.kind === 'codex' ? (r as CodexRecord) : null;
  // A usage limit is read from Codex's own error text: a guess, not a measurement.
  if (codex?.state === 'limit' && !n.limit)
    n.limit = { value: codex.resetAt ? { resetAt: codex.resetAt } : {}, source: 'inferred', at };
  // D5: a Codex Worker's last message is its report (said, not measured), masked for the screen.
  if (codex?.summary && !n.summary)
    n.summary = { value: maskText(codex.summary).slice(0, SUMMARY_MAX), source: 'reported', at };
  if (r.ended) {
    n.endedAt = observed(r.ended, at);
    if (typeof r.exit === 'number') n.exit = observed(r.exit, at);
    // Commits are counted in the task's own worktree only (base..HEAD).
    if (codex?.worktree && typeof codex.commits === 'number')
      n.commits = observed(codex.commits, at);
  }
  return isDeepStrictEqual(n, e) ? e : n;
}

function applyPatch(base: Task, p: Patch): Task {
  const next = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(p)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next as unknown as Task;
}

export interface TaskStoreOptions {
  /** A read-only daemon: a v1 file is shown migrated but not written (edits are refused). */
  readOnly?: boolean;
  /** The assignment ids agents hold now, or null when unknown (no assignee is then "removed"). */
  live?: () => Set<string> | null;
  /** D3b: the name an assignment answers to now (a Lead swap swaps names); the stored one
   *  stays the fallback. Only what is shown changes, never the file. */
  nameOf?: (assignmentId: string) => string | undefined;
}

export class TaskStore {
  private tasks: Task[] = [];
  /** Why the file could not be read; while set, nothing is written (the file stays as it is). */
  readonly corrupt: string | null = null;
  /** Why the file is readable but must not be written (not migrated); edits are refused. */
  readonly unwritable: string | null = null;
  /** The file's other top-level keys, written back as they were. */
  private extra: Record<string, unknown> = {};
  private doc(tasks: Task[]) {
    return { v: TASKS_VERSION, tasks, ...this.extra };
  }

  constructor(
    readonly file: string,
    private readonly changed: () => void = () => undefined,
    private readonly log: (line: string) => void = (l) => console.warn(`[cld] ${l}`),
    private readonly opts: TaskStoreOptions = {},
  ) {
    let raw: Record<string, unknown> | null;
    try {
      raw = readJson(file) as typeof raw;
      if (raw === null) return;
      if (typeof raw.v === 'number' && raw.v > TASKS_VERSION)
        throw new Error(`더 새 버전이 쓴 파일입니다(v${raw.v})`);
      if ((raw.v !== 1 && raw.v !== TASKS_VERSION) || !Array.isArray(raw.tasks))
        throw new Error('{v:2, tasks:[…]} 형식이 아닙니다');
    } catch (err) {
      this.corrupt = koText('tasks_unreadable', { file, why: err instanceof Error ? err.message : String(err) });
      this.log(this.corrupt);
      return;
    }
    const { v, tasks: list, ...extra } = raw;
    const tasks = list as Task[];
    // Top-level keys besides v and tasks are kept as they were, in every write.
    this.extra = extra;
    if (v === TASKS_VERSION) {
      this.tasks = tasks.filter(isTask);
      if (this.tasks.length !== tasks.length) {
        this.unwritable = `${file} 에 작업이 아닌 항목이 있습니다. 파일은 그대로 두었고 작업을 저장하지 않습니다`;
        this.log(this.unwritable);
      }
      return;
    }
    // A malformed v1 file (a null task, links that are not a list…) must not stop the daemon:
    // it stays as it is, readable where it can be, and nothing is written.
    let v2: Task[] | string;
    try {
      v2 = migrateTasks(tasks);
    } catch (err) {
      v2 = `읽을 수 없는 항목이 있습니다: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (typeof v2 === 'string') {
      this.tasks = tasks.filter(isTask);
      this.unwritable = `${file} 을(를) v2 로 옮기지 않았습니다(${v2}). 파일은 그대로 두었고 작업을 저장하지 않습니다`;
      this.log(this.unwritable);
      return;
    }
    this.tasks = v2;
    if (opts.readOnly) {
      this.unwritable = `${file} 은(는) v1 입니다. 읽기 전용이라 옮기지 않았고, 보통 시작이 옮길 때까지 작업을 저장하지 않습니다`;
      this.log(this.unwritable);
      return;
    }
    try {
      const kept = keepCopy(file, '.v1');
      writeJsonAtomic(file, this.doc(v2));
      this.log(`tasks.json: migrated to v2, ${v2.length} tasks (v1 kept as ${kept})`);
    } catch (err) {
      this.unwritable = `${file} 을(를) v2 로 옮기지 못했습니다(${err instanceof Error ? err.message : String(err)}). 원래 파일은 그대로이고, 다시 시작할 때까지 작업을 저장하지 않습니다`;
      this.log(this.unwritable);
    }
  }

  list(filter: { project?: string | null; status?: string | null } = {}): Task[] {
    return this.tasks
      .filter(
        (t) =>
          (!filter.project || t.project === filter.project) &&
          (!filter.status || t.status === filter.status),
      )
      .map((t) => this.shown(t));
  }

  get(id: string): Task | undefined {
    const t = this.find(id);
    return t && this.shown(t);
  }

  private find(id: string): Task | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  /** A task with its assignee under the name its assignment answers to now. */
  private shown(t: Task): Task {
    const name = t.assignee && this.opts.nameOf?.(t.assignee.assignmentId);
    return name && t.assignee && name !== t.assignee.name
      ? { ...t, assignee: { ...t.assignee, name } }
      : t;
  }

  message(): TaskBoard {
    const removed = this.removedAssignees();
    return {
      type: 'taskBoard',
      tasks: this.tasks.map((t) => this.shown(t)),
      ...(this.corrupt && { corrupt: this.corrupt }),
      ...(removed.length && { removedAssignees: removed }),
    };
  }

  /** The assignees' assignment ids no agent holds any more (their tasks stay). */
  removedAssignees(): string[] {
    if (!this.tasks.some((t) => t.assignee)) return [];
    const live = this.opts.live?.();
    if (!live) return [];
    const gone = this.tasks
      .map((t) => t.assignee?.assignmentId)
      .filter((id): id is string => !!id && !live.has(id));
    return [...new Set(gone)];
  }

  /** D6: run `ref` (a Codex task or a job just started, or C6: an agent's assignment id a
   *  delegation went to) becomes an Execution of task `id`. */
  attach(
    id: string,
    run: { kind: 'codex' | 'job' | 'agent'; ref: string; log?: string },
    by: string,
    now = Date.now(),
  ): Reply {
    const blocked = this.corrupt ?? this.unwritable;
    if (blocked) return refuse('store_unwritable', blocked);
    const prev = this.find(id);
    if (!prev) return refuse('unknown_task', `'${id}' 작업이 없습니다`);
    const eid = `${run.kind}:${run.ref}`;
    if (prev.executions?.some((e) => e.id === eid))
      return { ok: true, task: prev, unchanged: true };
    const at = new Date(now).toISOString();
    const execution: Execution = {
      id: eid,
      kind: run.kind,
      ref: run.ref,
      startedAt: at,
      ...(run.log && { log: run.log }),
    };
    const task: Task = {
      ...prev,
      executions: [...(prev.executions ?? []), execution].slice(-EXECUTIONS_MAX),
      updatedAt: at,
      history: [...(prev.history ?? []), { at, by, change: `execution ${eid}` }].slice(
        -HISTORY_MAX,
      ),
    };
    return this.commit(
      this.tasks.map((t) => (t.id === id ? task : t)),
      { ok: true, task, execution },
    );
  }

  /**
   * D6: settle the open Executions from their records: start, end and exit
   * (and a Codex worktree's commits) as observed, a usage-limit stop as
   * inferred. Never a task's status, history or updatedAt. True when it wrote.
   */
  observe(src: ExecutionSources, now = Date.now()): boolean {
    if (this.corrupt || this.unwritable) return false;
    const at = new Date(now).toISOString();
    let changed = false;
    const next = this.tasks.map((t) => {
      if (!Array.isArray(t.executions) || !t.executions.some((e) => !e?.endedAt)) return t;
      const executions = t.executions.map((e) => (e.endedAt ? e : observeOne(e, src, at)));
      if (executions.every((e, i) => e === t.executions![i])) return t;
      changed = true;
      return { ...t, executions };
    });
    return changed && this.commit(next, { ok: true }).ok;
  }

  /** A new task; `fields` must hold project and title. */
  add(raw: Record<string, unknown>, by: string, now = Date.now(), meta: Meta = {}): Reply {
    const r = this.plan([{ ...raw }], by, now, 'add', meta);
    return 'ok' in r
      ? r
      : this.commit(r.next, { ok: true, task: r.next.find((t) => t.id === r.ids[0]) });
  }

  /** Change task `id`; unchanged fields leave no history. */
  update(
    id: string,
    raw: Record<string, unknown>,
    by: string,
    now = Date.now(),
    meta: Meta = {},
  ): Reply {
    if (!this.get(id)) return refuse('unknown_task', `'${id}' 작업이 없습니다`);
    const r = this.plan([{ ...raw, id }], by, now, 'update', meta);
    if ('ok' in r) return r;
    const task = r.next.find((t) => t.id === id);
    return r.changed
      ? this.commit(r.next, { ok: true, task })
      : { ok: true, task, unchanged: true };
  }

  /** Bulk, idempotent by id: updates the existing, adds the new, deletes nothing. All or none. */
  import(list: unknown, by: string, now = Date.now()): Reply {
    if (!Array.isArray(list) || list.length > TASKS_MAX)
      return refuse('usage', `tasks: ${TASKS_MAX}개 이하 목록이어야 합니다`);
    const r = this.plan(list as Array<Record<string, unknown>>, by, now, 'import');
    if ('ok' in r) return r;
    const summary = {
      added: r.added,
      updated: r.updated,
      unchanged: list.length - r.added - r.updated,
    };
    return r.changed ? this.commit(r.next, { ok: true, ...summary }) : { ok: true, ...summary };
  }

  /** The next list for `items`, or a refusal (nothing is applied then). */
  private plan(
    items: Array<Record<string, unknown>>,
    by: string,
    now: number,
    mode: 'add' | 'update' | 'import',
    meta: Meta = {},
  ): Reply | { next: Task[]; ids: string[]; added: number; updated: number; changed: boolean } {
    if (this.corrupt) return refuse('store_corrupt', this.corrupt);
    if (this.unwritable) return refuse('store_unwritable', this.unwritable);
    const next = [...this.tasks];
    const ids: string[] = [];
    let added = 0;
    let updated = 0;
    for (const [i, item] of items.entries()) {
      const where = mode === 'import' ? `${i + 1}번째(${String(item?.id ?? '?')}): ` : '';
      if (!item || typeof item !== 'object') return refuse('usage', `${where}작업이 아닙니다`);
      const given = item.id === undefined || item.id === '' ? null : item.id;
      if (given !== null && (typeof given !== 'string' || !ID_RE.test(given)))
        return refuse('usage', `${where}id 는 영문·숫자·._- 41자 이하여야 합니다`);
      let id = given as string | null;
      const at = (mode === 'import' && isoOf(item.updatedAt)) || new Date(now).toISOString();
      const index = id === null ? -1 : next.findIndex((t) => t.id === id);
      const prev = index >= 0 ? next[index] : undefined;
      if (mode === 'add' && prev)
        return refuse('exists', `'${id}' 작업이 이미 있습니다(바꾸려면 task update)`);
      const patch = parseFields(item, prev, at);
      if (typeof patch === 'string') return refuse('usage', where + patch);
      if (meta.delegatedBy) patch.delegatedBy = meta.delegatedBy;
      if (prev) {
        const task = reportStatus(withExecutions(applyPatch(prev, patch)), prev, at);
        const why = parentProblem(next, task);
        if (why) return refuse('usage', where + why);
        const change = describe(prev, task);
        if (!change.length) {
          ids.push(prev.id);
          continue;
        }
        task.updatedAt = at;
        task.history = [...(prev.history ?? []), { at, by, change: change.join(', ') }].slice(
          -HISTORY_MAX,
        );
        next[index] = task;
        updated += 1;
        ids.push(task.id);
        continue;
      }
      if (!patch.project)
        return refuse('no_project', `${where}어느 프로젝트인지 모릅니다(--project)`);
      if (!patch.title) return refuse('usage', `${where}제목이 필요합니다`);
      if (next.length >= TASKS_MAX) return refuse('too_many', `작업은 ${TASKS_MAX}개까지입니다`);
      id = id ?? nextId(next);
      const createdAt = (mode === 'import' && isoOf(item.createdAt)) || at;
      const task = reportStatus(
        withExecutions(
          applyPatch(
            {
              id,
              project: patch.project,
              title: patch.title,
              status: 'todo',
              source: 'reported',
              createdAt,
              updatedAt: at,
              history: [{ at, by, change: mode === 'import' ? 'import' : 'add' }],
              createdBy: meta.createdBy ?? createdByOf(by),
            },
            patch,
          ),
        ),
        undefined,
        at,
      );
      const why = parentProblem(next, task);
      if (why) return refuse('usage', where + why);
      next.push(task);
      added += 1;
      ids.push(id);
    }
    return { next, ids, added, updated, changed: added + updated > 0 };
  }

  private commit(next: Task[], reply: Reply): Reply {
    try {
      writeJsonAtomic(this.file, this.doc(next));
    } catch (err) {
      return refuse(
        'write_failed',
        `작업을 저장하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.tasks = next;
    this.changed();
    return reply;
  }
}

/** Who wrote a task first, from the writer's label: the office is the user. */
type Meta = { createdBy?: string; delegatedBy?: string };
const createdByOf = (by: string) => (by.startsWith('gui:') ? 'user' : 'cli');

/** Every status written here is a report; a report of done (or of no longer done) is its own fact. */
function reportStatus(task: Task, prev: Task | undefined, at: string): Task {
  if (prev && prev.status === task.status) return task;
  const next: Task = { ...task, statusSource: 'reported' };
  if (task.status === 'done') next.reportedDone = reported(true, at);
  else if (prev?.status === 'done') next.reportedDone = reported(false, at);
  return next;
}

/** A parent must exist and must not be the task or one of its own children. */
function parentProblem(tasks: Task[], task: Task): string | null {
  if (!task.parentId) return null;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  let at: string | undefined = task.parentId;
  for (let n = 0; at && n <= tasks.length; n++) {
    if (at === task.id)
      return `parent: '${task.parentId}' 아래에 둘 수 없습니다(자기 자신이나 하위 작업)`;
    const up = byId.get(at);
    if (!up) return n === 0 ? `parent: '${task.parentId}' 작업이 없습니다` : null;
    at = up.parentId;
  }
  return null;
}

/** `T-<n>`, one past the highest generated so far. */
function nextId(tasks: Task[]): string {
  let n = 0;
  for (const t of tasks) {
    const m = /^T-(\d+)$/.exec(t.id);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `T-${n + 1}`;
}

/** D6: how answerTask finds an engine agent by name (`--assignee`). */
export interface TaskAgents {
  /** The assignment id of agent `name` (a Lead's or a Worker's), or null. */
  assignmentOf(name: string): string | null;
  names(): string[];
}

/**
 * `cld-gui task …` over the control socket. `who.by` is the caller (its token's
 * agent, else `cli`), `who.project` the project it stands for (token, then cwd),
 * `who.agent` the agent its token names (D6: createdBy, delegatedBy).
 */
export function answerTask(
  store: TaskStore,
  a: Record<string, unknown>,
  who: { by: string; project: string | null; agent?: string | null },
  agents?: TaskAgents,
): Reply {
  const raw = a.fields && typeof a.fields === 'object' ? (a.fields as Record<string, unknown>) : {};
  const id = typeof a.id === 'string' ? a.id : null;
  const agent = who.agent ?? null;
  const meta = (fields: Record<string, unknown>): Meta => {
    const to = fields.assignee as { name?: string } | null | undefined;
    return {
      ...(agent && { createdBy: `agent:${agent}` }),
      ...(agent && to?.name && to.name !== agent && { delegatedBy: agent }),
    };
  };
  /**
   * `--assignee <name>`: the agent's assignment, or a refusal; '' clears it. The object
   * `list --json` prints ({assignmentId, name}) stays when the task already has that
   * assignment (an import round trip), else it is resolved by its name.
   */
  const resolve = (
    fields: Record<string, unknown>,
    taskId?: unknown,
  ): Record<string, unknown> | Reply => {
    const given = fields.assignee;
    if (given === undefined || given === '' || given === null) return fields;
    let name: unknown = given;
    if (given && typeof given === 'object' && !Array.isArray(given)) {
      const o = given as { assignmentId?: unknown; name?: unknown };
      const prev = typeof taskId === 'string' ? store.get(taskId)?.assignee : undefined;
      if (prev && prev.assignmentId === o.assignmentId) {
        const { assignee: _same, ...rest } = fields;
        return rest;
      }
      name = o.name;
    }
    if (typeof name !== 'string' || !name)
      return refuse('usage', 'assignee: 에이전트 이름이어야 합니다');
    const assignmentId = agents?.assignmentOf(name) ?? null;
    if (!assignmentId) {
      const names = agents?.names() ?? [];
      return refuse(
        'unknown_agent',
        `'${name}' 에이전트가 없습니다${!agents ? '(엔진이 꺼져 있습니다)' : names.length ? `: ${names.join(' ')}` : '(등록된 에이전트가 없습니다)'}`,
      );
    }
    return { ...fields, assignee: { assignmentId, name } };
  };
  const refused = (x: Record<string, unknown> | Reply): x is Reply => 'ok' in x && x.ok === false;
  switch (a.op) {
    case 'list': {
      const str = (x: unknown) => (typeof x === 'string' && x ? x : null);
      return { ok: true, tasks: store.list({ project: str(a.project), status: str(a.status) }) };
    }
    case 'show': {
      const task = id ? store.get(id) : undefined;
      if (!id) return refuse('usage', `사용법: ${CLI_NAME} task show <id>`);
      if (!task) return refuse('unknown_task', `'${id}' 작업이 없습니다`);
      const removed =
        !!task.assignee && store.removedAssignees().includes(task.assignee.assignmentId);
      return { ok: true, task, ...(removed && { assigneeRemoved: true }) };
    }
    case 'add': {
      const fields = resolve(raw);
      if (refused(fields)) return fields;
      return store.add(
        { project: who.project ?? undefined, ...fields, ...(id && { id }) },
        who.by,
        Date.now(),
        meta(fields),
      );
    }
    case 'update':
    case 'done': {
      if (!id) return refuse('usage', `사용법: ${CLI_NAME} task ${String(a.op)} <id> …`);
      const fields = resolve(a.op === 'done' ? { ...raw, status: 'done' } : raw, id);
      if (refused(fields)) return fields;
      const { createdBy: _c, ...m } = meta(fields);
      return store.update(id, fields, who.by, Date.now(), m);
    }
    case 'import': {
      const list = (a.tasks as unknown[] | undefined)?.map((t) => {
        if (!t || typeof t !== 'object') return t;
        const item = resolve(t as Record<string, unknown>, (t as { id?: unknown }).id);
        if (refused(item)) return item;
        return who.project && !('project' in item) ? { ...item, project: who.project } : item;
      });
      const bad = list?.find(
        (t): t is Reply => !!t && typeof t === 'object' && refused(t as Reply),
      );
      return bad ?? store.import(list, who.by);
    }
    default:
      return refuse('usage', `사용법: ${CLI_NAME} task add|update|done|show|list|import`);
  }
}

/**
 * D6: `cld-gui codex|job … --task <id>`: refused before anything starts when the
 * task is unknown or the store cannot be written; once started, the run is the
 * task's new Execution (an attach that then fails is said, the run goes on).
 */
export async function startForTask(
  store: TaskStore,
  task: string | null | undefined,
  kind: 'codex' | 'job',
  by: string,
  start: () => Reply | Promise<Reply>,
): Promise<Reply> {
  if (!task) return start();
  const blocked = store.corrupt ?? store.unwritable;
  if (blocked) return refuse('store_unwritable', blocked);
  if (!store.get(task)) return refuse('unknown_task', `'${task}' 작업이 없습니다`);
  const r = await start();
  if (!r.ok || typeof r.id !== 'string') return r;
  const log = typeof r.log === 'string' ? r.log : undefined;
  const att = store.attach(task, { kind, ref: r.id, ...(log && { log }) }, by);
  return att.ok ? { ...r, task } : { ...r, taskError: att.error };
}
