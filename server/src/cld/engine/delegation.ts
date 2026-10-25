/**
 * C6 (with C5b): `delegate_task`, the one tool that makes another agent work
 * (B §9.3, §9.4). The Lead's LLM picks the target; the daemon only checks and
 * executes. Checks, in this order, the first failing one deciding the result:
 *
 *   1 identity   the token's agent (control.ts, McpTools.call)  → rejected/no_identity
 *   2 scope      checkScope: task, parent and target in the caller's project → rejected/out_of_scope
 *   3 duplicate  checkDuplicate: same caller + key (24 h), or an open Task with the
 *                same parent + target + title → duplicate
 *   4 permission checkPermission: a Lead at depth 1; a Worker/Reviewer under its own
 *                Task at depth 2; anything else → a proposal to its Lead (pending_approval)
 *   5 mode       checkMode: the project's delegation mode (auto / reuse / off) → pending_approval
 *   6 target     checkTarget: a managed Worker/Reviewer of this project, or a new one
 *                (stopped, queue full, provider, idle Worker of the same kind → rejected)
 *   7 limits     checkLimits: concurrent Workers, today's new Workers and delegations,
 *                the parent's remaining budget → pending_approval
 *   8 rate       the pairwise limiter (McpTools.reserve) → rejected/rate_limited
 *   9 execute    the Task, its Execution, the delivery, an event
 *
 * Approval goes to the user for a Lead's call (approvals.json, cards in the
 * 작업실) and to the Lead for a Worker's (a `proposed` Task plus a message; the
 * Lead accepts with delegate_task({ task: { id } })). Nothing is dropped
 * silently: every call ends in one of the five statuses, and an approved or
 * denied call leaves a line in the caller's session.
 *
 * Parallel calls: everything from check 2 to the reservations is synchronous,
 * so two calls never pass the same count; each reservation is given back when
 * the call ends (the store then holds what it made). Counters: the idempotency
 * keys and the in-flight reservations are in memory (a daemon restart forgets
 * them); today's delegations are counted from tasks.json and today's new
 * Workers, the pending approvals and the modes are kept in approvals.json.
 */
import { randomBytes } from 'crypto';
import * as path from 'path';

import { koText } from '../../../../core/src/cld/serverText.js';
import type { BoardTask } from '../../../../core/src/messages.js';
import { readJson, writeJsonAtomic } from '../jsonFile.js';
import { configDir } from './events.js';
import type { McpDeps, RosterAgent } from './mcpTools.js';
import { checkName } from './registry.js';

export const MCP_SOURCE = 'mcp';
/** B §9.4-6/7 defaults. */
export const LIMITS = {
  projectWorkers: 3,
  hostWorkers: 6,
  newWorkersPerDay: 5,
  delegationsPerDay: 30,
  queuePerWorker: 3,
};
export const MODES = ['auto', 'reuse', 'off'] as const;
export type DelegationMode = (typeof MODES)[number];
export type ApprovalCheck = 'permission' | 'mode' | 'limits';
/** Which of check 7's limits asked (an approval skips only that one when re-run). */
export type LimitKind =
  | 'projectWorkers'
  | 'hostWorkers'
  | 'newWorkersPerDay'
  | 'delegationsPerDay'
  | 'budget'
  /** approvals.json cannot count today's new Workers: none is made without the owner. */
  | 'newWorkerRecord';
/** Pending approvals (user cards, or open proposals to the Lead) one caller may have. */
export const PENDING_MAX = 5;
const DUPLICATE_MS = 24 * 60 * 60_000;
const DUPLICATE_MAX = 10_000;
const APPROVALS_VERSION = 1;
const TEXT_MAX = { title: 200, detail: 4000, area: 200, reason: 500, key: 200 };
const OPEN = (t: BoardTask) => t.status !== 'done';

type Result = Record<string, unknown>;
type Rejected = Result & { status: 'rejected'; code: string; message: string };
const rejected = (code: string, message: string, extra: Result = {}): Rejected => ({
  status: 'rejected',
  code,
  message,
  ...extra,
});
const isRejected = (r: unknown): r is Rejected =>
  !!r && typeof r === 'object' && (r as Result).status === 'rejected';

// ── The approval store (~/.config/cld-gui/approvals.json) ─────────────────

/** A delegate_task call waiting for someone: the user (`ap-…`) or the Lead (its proposed Task's id). */
export interface PendingApproval {
  id: string;
  approver: 'user' | 'lead';
  project: string;
  /** The agent that called. */
  caller: string;
  check: ApprovalCheck;
  /** check 'limits': which limit asked. */
  limit?: LimitKind;
  why: string;
  /** Project, parent, target and folded title: a call for the same task is its duplicate. */
  match?: string;
  /** The call's input exactly as it came. */
  input: Record<string, unknown>;
  createdAt: string;
}
interface ApprovalDoc {
  v: number;
  approvals: PendingApproval[];
  /** Per project; absent = auto. */
  modes: Record<string, DelegationMode>;
  /** Workers delegate_task made, kept for the day count (older days are dropped). */
  newWorkers: Array<{ project: string; name: string; at: number }>;
}

export const approvalsPath = (home?: string) => path.join(configDir(home), 'approvals.json');
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

export class ApprovalStore {
  private doc: ApprovalDoc = { v: APPROVALS_VERSION, approvals: [], modes: {}, newWorkers: [] };
  /** Why the file is not written (it could not be read); approvals then cannot be stored. */
  readonly problem: string | null = null;

  constructor(
    readonly file: string,
    private readonly changed: () => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {
    try {
      const raw = readJson(file) as Partial<ApprovalDoc> | null;
      if (raw === null) return;
      if (raw.v !== APPROVALS_VERSION || !Array.isArray(raw.approvals))
        throw new Error(`{v:${APPROVALS_VERSION}, approvals:[…]} 형식이 아닙니다`);
      this.doc = {
        v: APPROVALS_VERSION,
        approvals: raw.approvals.filter((a) => !!a && typeof a === 'object' && typeof a.id === 'string'),
        modes: raw.modes && typeof raw.modes === 'object' ? raw.modes : {},
        newWorkers: Array.isArray(raw.newWorkers) ? raw.newWorkers : [],
      };
    } catch (err) {
      this.problem = `${file} 을(를) 읽지 못했습니다(${err instanceof Error ? err.message : String(err)}). 파일은 그대로 두었고 승인 요청을 저장하지 않습니다`;
      console.warn(`[cld] ${this.problem}`);
    }
  }

  list(): PendingApproval[] {
    return this.doc.approvals;
  }
  get(id: string): PendingApproval | undefined {
    return this.doc.approvals.find((a) => a.id === id);
  }
  /** The pending call of `caller` with this idempotency key. */
  byKey(caller: string, key: string): PendingApproval | undefined {
    return this.doc.approvals.find((a) => a.caller === caller && a.input.idempotencyKey === key);
  }
  add(a: PendingApproval): boolean {
    return this.write({ ...this.doc, approvals: [...this.doc.approvals, a] });
  }
  remove(id: string): boolean {
    if (!this.get(id)) return false;
    return this.write({ ...this.doc, approvals: this.doc.approvals.filter((a) => a.id !== id) });
  }
  mode(project: string): DelegationMode {
    const m = this.doc.modes[project];
    return (MODES as readonly string[]).includes(m) ? m : 'auto';
  }
  setMode(project: string, mode: DelegationMode): boolean {
    const modes = { ...this.doc.modes };
    if (mode === 'auto') delete modes[project];
    else modes[project] = mode;
    return this.write({ ...this.doc, modes });
  }
  newWorkersToday(project: string): number {
    const now = this.now();
    return this.doc.newWorkers.filter((w) => w.project === project && sameDay(w.at, now)).length;
  }
  noteNewWorker(project: string, name: string): boolean {
    const now = this.now();
    const today = this.doc.newWorkers.filter((w) => sameDay(w.at, now));
    return this.write({ ...this.doc, newWorkers: [...today, { project, name, at: now }] });
  }

  private write(next: ApprovalDoc): boolean {
    if (this.problem) return false;
    try {
      writeJsonAtomic(this.file, next);
    } catch (err) {
      console.warn(`[cld] approvals: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    this.doc = next;
    this.changed();
    return true;
  }
}

// ── The tool ───────────────────────────────────────────────────────────────

/** What delegate_task needs beyond the C5a tools' deps (office.ts wires the engine). */
export interface DelegationDeps {
  approvals: ApprovalStore;
  /** This build can start a session of `provider` here (installed and known). */
  providerReady(provider: string): boolean;
  /** A new managed Worker, made the way `cld-gui worker add` makes one (stopped). */
  addWorker(req: {
    name: string;
    project: string;
    role: 'worker' | 'reviewer';
    folder?: string;
    model?: string;
    effort?: string;
    /** D5: 'codex' for a Codex Worker; absent = Claude. */
    provider?: string;
  }): Promise<{ ok: boolean; error?: string }>;
  /** Start an agent the way `cld-gui worker start` does. */
  startAgent(name: string): Promise<{ ok: boolean; error?: string }>;
  /** A line for events.jsonl (the feed; `delegation_approval` is also a notice). */
  event(type: string, fields: Record<string, unknown>): void;
  /** W2: `worktree: 'new'`, the Task's worktree given to the target (taskWorktree.ts; a Task
   *  that has one gives that one). Absent: `rejected/unsupported`. */
  taskWorktree?(req: {
    taskId: string;
    assignee: string;
    project: string;
    by: string;
  }): Promise<{ ok: boolean; code?: string; error?: string; path?: string; branch?: string }>;
}

/** What the tool needs from McpTools (the limiter, the state rule, the agent shape). */
export interface DelegationHost {
  deps: McpDeps & { delegation: DelegationDeps };
  now(): number;
  /** Check 8, C5a's pairwise limiter: a refusal, or the function that gives the slot back. */
  reserve(a: string, others: string[]): Result | (() => void);
  state(a: RosterAgent): 'idle' | 'busy' | 'down' | 'limit' | 'stopped';
  agentRef(a: RosterAgent): Result;
}

/** D5: the providers delegate_task may make a new Worker of (when providerReady says so). */
const NEW_WORKER_PROVIDERS = ['claude', 'codex'];

type NewWorker = {
  provider: string;
  model?: string;
  effort?: string;
  role: 'worker' | 'reviewer';
  name?: string;
  reason: string;
};
type Target = { agentId: string } | { newWorker: NewWorker };
type Worktree = 'new' | 'none' | { path: string };
interface Call {
  key: string;
  task: {
    id?: string;
    title?: string;
    detail?: string;
    acceptance?: string;
    parentTaskId?: string;
    area?: string;
    worktree?: Worktree;
  };
  target?: Target;
  budget?: { maxTurns?: number; maxMinutes?: number };
}
/** What checks 2-6 found. */
interface Scoped {
  /** task.id: the Task being handed over (a proposal or a to-do). */
  task?: BoardTask;
  parent?: BoardTask;
  target: Target;
  /** task.id is a Worker's proposal waiting for this Lead. */
  proposal?: PendingApproval;
}
type Picked =
  | { kind: 'existing'; agent: RosterAgent; name: string; state: string; position?: number }
  | { kind: 'new'; name: string; worker: NewWorker };

const optText = (x: unknown, max: number, what: string): string | undefined | Rejected => {
  if (x === undefined) return undefined;
  if (typeof x !== 'string' || x.length > max)
    return rejected('bad_input', `${what} must be a string of at most ${max} characters`);
  return x;
};

/** The input, checked for shape only (nothing about agents or tasks yet). */
export function parseCall(raw: Record<string, unknown>): Call | Rejected {
  const key = raw.idempotencyKey;
  if (typeof key !== 'string' || !key || key.length > TEXT_MAX.key)
    return rejected('bad_input', 'idempotencyKey is required (1-200 characters)');
  const t = raw.task;
  if (!t || typeof t !== 'object' || Array.isArray(t))
    return rejected('bad_input', 'task is required');
  const task = t as Record<string, unknown>;
  const out: Call = { key, task: {} };
  for (const [k, max] of [
    ['id', 41],
    ['title', TEXT_MAX.title],
    ['detail', TEXT_MAX.detail],
    ['acceptance', TEXT_MAX.detail],
    ['parentTaskId', 41],
    ['area', TEXT_MAX.area],
  ] as const) {
    const v = optText(task[k], max, `task.${k}`);
    if (isRejected(v)) return v;
    if (v !== undefined && v.trim()) out.task[k] = k === 'title' ? v.trim() : v;
  }
  if (!out.task.id && !out.task.title) return rejected('bad_input', 'task.title or task.id is required');
  if ((out.task.detail?.length ?? 0) + (out.task.acceptance?.length ?? 0) > TEXT_MAX.detail - 20)
    return rejected('bad_input', `task.detail and task.acceptance together must fit in ${TEXT_MAX.detail - 20} characters`);
  const wt = task.worktree;
  if (wt !== undefined) {
    if (wt === 'new' || wt === 'none') out.task.worktree = wt;
    else if (wt && typeof wt === 'object' && typeof (wt as { path?: unknown }).path === 'string' && (wt as { path: string }).path)
      out.task.worktree = { path: (wt as { path: string }).path };
    else return rejected('bad_input', "task.worktree must be 'new', 'none' or { path }");
  }
  const target = raw.target as Record<string, unknown> | undefined;
  if (target !== undefined) {
    if (!target || typeof target !== 'object') return rejected('bad_input', 'target must be { agentId } or { newWorker }');
    const hasId = typeof target.agentId === 'string' && !!target.agentId;
    const nw = target.newWorker as Record<string, unknown> | undefined;
    if (hasId === !!nw) return rejected('bad_input', 'target must be exactly one of { agentId } or { newWorker }');
    if (hasId) out.target = { agentId: target.agentId as string };
    else {
      if (!nw || typeof nw !== 'object' || typeof nw.provider !== 'string' || !nw.provider)
        return rejected('bad_input', 'target.newWorker.provider is required');
      const reason = optText(nw.reason, TEXT_MAX.reason, 'target.newWorker.reason');
      if (isRejected(reason)) return reason;
      if (!reason?.trim()) return rejected('bad_input', 'target.newWorker.reason is required');
      const role = nw.role ?? 'worker';
      if (role !== 'worker' && role !== 'reviewer')
        return rejected('bad_input', "target.newWorker.role must be 'worker' or 'reviewer'");
      const w: NewWorker = { provider: nw.provider, role, reason };
      for (const k of ['model', 'effort', 'name'] as const) {
        const v = optText(nw[k], 64, `target.newWorker.${k}`);
        if (isRejected(v)) return v;
        if (v) w[k] = v;
      }
      out.target = { newWorker: w };
    }
  }
  if (!out.target && !out.task.id) return rejected('bad_input', 'target is required');
  const b = raw.budget as Record<string, unknown> | undefined;
  if (b !== undefined) {
    if (!b || typeof b !== 'object') return rejected('bad_input', 'budget must be { maxTurns?, maxMinutes? }');
    const budget: NonNullable<Call['budget']> = {};
    for (const k of ['maxTurns', 'maxMinutes'] as const) {
      const v = b[k];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 100_000)
        return rejected('bad_input', `budget.${k} must be a whole number 1-100000`);
      budget[k] = v;
    }
    if (Object.keys(budget).length) out.budget = budget;
  }
  return out;
}

const fold = (s: string) => s.trim().toLowerCase();
const targetKey = (t: Target, caller: string) =>
  'agentId' in t ? t.agentId : `new:${caller}`;

export class Delegator {
  /** "caller\0key" → the first result and when (B §9.4-3). */
  private readonly done = new Map<string, { at: number; result: Result }>();
  private readonly running = new Map<string, Promise<Result>>();
  // In-flight reservations, given back when a call ends.
  private readonly openKeys = new Set<string>();
  private readonly starting = new Map<string, number>();
  private readonly newWorkers = new Map<string, number>();
  private readonly delegations = new Map<string, number>();
  private readonly queued = new Map<string, number>();
  private readonly names = new Set<string>();

  constructor(private readonly h: DelegationHost) {}

  /** D3b: after a Lead swap, the idempotency of calls made under `names` (another session now
   *  answers to each). In-flight counts balance themselves when their calls end; the approvals
   *  store keeps its callers as written (a pending call goes on under the name's new holder). */
  forget(names: readonly string[]): void {
    const mine = (k: string) => names.some((n) => k.startsWith(`${n}\0`));
    for (const m of [this.done, this.running]) for (const k of [...m.keys()]) if (mine(k)) m.delete(k);
  }

  private get d() {
    return this.h.deps;
  }
  private get store() {
    return this.h.deps.delegation.approvals;
  }

  /** delegate_task by `me` (identity, check 1, is done: its token named it). */
  call(
    me: RosterAgent,
    roster: RosterAgent[],
    raw: Record<string, unknown>,
    opt: { skip?: ApprovalCheck; skipLimit?: LimitKind; rerun?: boolean } = {},
  ): Promise<Result> {
    const c = parseCall(raw);
    if (isRejected(c)) return Promise.resolve(c);
    const s = this.checkScope(me, roster, c);
    if (isRejected(s)) return Promise.resolve(s);
    const k = `${me.name}\0${c.key}`;
    const dup = this.checkDuplicate(me, c, s, k, !!opt.rerun);
    if (dup) return dup instanceof Promise ? dup : Promise.resolve(dup);
    const open = this.openKey(me, c, s);
    this.openKeys.add(open);
    const run = this.decide(me, roster, raw, c, s, opt).catch((err: unknown) =>
      rejected('daemon_error', err instanceof Error ? err.message : String(err)),
    );
    this.running.set(k, run);
    return run.then((result) => {
      this.running.delete(k);
      this.openKeys.delete(open);
      // A refusal is not remembered (a retry may pass), except the user's "no".
      if (!isRejected(result) || result.code === 'denied') this.remember(k, result);
      return result;
    });
  }

  private remember(k: string, result: Result): void {
    if (this.done.size >= DUPLICATE_MAX) this.done.delete(this.done.keys().next().value!);
    this.done.set(k, { at: this.h.now(), result });
  }

  // ── 2 scope ──
  checkScope(me: RosterAgent, roster: RosterAgent[], c: Call): Scoped | Rejected {
    const own = (id: string, what: string): BoardTask | Rejected => {
      const t = this.d.tasks.get(id);
      if (!t) return rejected('unknown_task', `no ${what} '${id}'`);
      if (t.project !== me.project) return rejected('out_of_scope', `${what} '${id}' belongs to another project`);
      return t;
    };
    let task: BoardTask | undefined;
    let proposal: PendingApproval | undefined;
    if (c.task.id) {
      const t = own(c.task.id, 'task');
      if (isRejected(t)) return t;
      if (t.status !== 'proposed' && t.status !== 'todo')
        return rejected('task_not_open', `task '${t.id}' is ${t.status}: only a proposal or a to-do is handed out`);
      task = t;
      const p = this.store.get(t.id);
      if (p?.approver === 'lead') proposal = p;
    }
    let parent: BoardTask | undefined;
    const parentId = c.task.parentTaskId ?? task?.parentId;
    if (parentId) {
      const p = own(parentId, 'parent task');
      if (isRejected(p)) return p;
      parent = p;
    } else if (!task) parent = this.currentTask(me);
    let target = c.target;
    if (!target && proposal) {
      const stored = parseCall(proposal.input);
      if (!isRejected(stored)) target = stored.target;
    }
    if (!target) return rejected('bad_input', 'target is required');
    if ('agentId' in target) {
      const a = findAgent(roster, target.agentId);
      if (a && a.project !== me.project)
        return rejected('out_of_scope', `'${target.agentId}' works for another project`);
    }
    return { task, parent, target, proposal };
  }

  /** The caller's Task now: its newest open Task (not a proposal), or none. */
  private currentTask(me: RosterAgent): BoardTask | undefined {
    if (!me.assignmentId) return undefined;
    return this.d.tasks
      .list({ project: me.project })
      .filter((t) => OPEN(t) && t.status !== 'proposed' && t.assignee?.assignmentId === me.assignmentId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  }

  // ── 3 duplicate ──
  checkDuplicate(
    me: RosterAgent,
    c: Call,
    s: Scoped,
    k: string,
    rerun: boolean,
  ): Result | Promise<Result> | null {
    if (!rerun) {
      const now = this.h.now();
      for (const [key, v] of this.done) if (now - v.at >= DUPLICATE_MS) this.done.delete(key);
      const first = this.done.get(k);
      if (first) return { ...first.result, status: 'duplicate' };
      const inFlight = this.running.get(k);
      if (inFlight) return inFlight.then((r) => (isRejected(r) ? r : { ...r, status: 'duplicate' }));
      // Durable: a call still waiting for approval (also after a daemon restart).
      const waiting = this.store.byKey(me.name, c.key);
      if (waiting)
        return {
          status: 'duplicate',
          approvalId: waiting.id,
          ...(waiting.approver === 'lead' && { taskId: waiting.id }),
          message: 'this call is still waiting for approval',
        };
    }
    const title = c.task.title ?? s.task?.title;
    if (!title) return null;
    // A call for the same task already waiting for approval (not the proposal being taken now).
    const match = this.openKey(me, c, s);
    const pending = this.store.list().find((a) => a.match === match && a.id !== s.task?.id);
    if (pending)
      return {
        status: 'duplicate',
        approvalId: pending.id,
        ...(pending.approver === 'lead' && { taskId: pending.id }),
        message: 'the same task is already waiting for approval',
      };
    if (this.openKeys.has(match))
      return { status: 'duplicate', message: 'the same task is being delegated right now' };
    const parentId = s.parent?.id;
    const same = this.d.tasks.list({ project: me.project }).find(
      (t) =>
        OPEN(t) &&
        t.status !== 'proposed' &&
        t.id !== s.task?.id &&
        t.parentId === parentId &&
        fold(t.title) === fold(title) &&
        ('agentId' in s.target
          ? !!t.assignee &&
            (t.assignee.assignmentId === s.target.agentId || t.assignee.name === s.target.agentId)
          : t.delegatedBy === me.name && !!t.assignee),
    );
    if (!same) return null;
    const execution = same.executions?.filter((e) => e.kind === 'agent').at(-1);
    return {
      status: 'duplicate',
      taskId: same.id,
      ...(same.assignee && { agentId: same.assignee.assignmentId }),
      ...(execution && { executionId: execution.id }),
      message: `task ${same.id} with this title is still open for that agent`,
    };
  }

  private openKey(me: RosterAgent, c: Call, s: Scoped): string {
    const title = fold(c.task.title ?? s.task?.title ?? '');
    return [me.project, s.parent?.id ?? '', targetKey(s.target, me.name), title].join('\0');
  }

  /**
   * How deep `t` is: it and its parents held by a Worker or Reviewer (not the Lead, not
   * unassigned), whoever gave them (the board, `cld-gui task`, create_task, delegate_task).
   */
  private depthOf(t: BoardTask | undefined, roster: RosterAgent[]): number {
    const leads = new Set(roster.filter((a) => a.role === 'lead').map((a) => a.assignmentId));
    let n = 0;
    const seen = new Set<string>();
    for (let at = t; at && !seen.has(at.id); at = at.parentId ? this.d.tasks.get(at.parentId) : undefined) {
      seen.add(at.id);
      if (at.assignee && !leads.has(at.assignee.assignmentId)) n++;
    }
    return n;
  }

  /** The depth a delegation by `me` under `parent` has: a Lead's is 1; a Worker's own Task is
   *  depth 1 whatever made it, so its delegation is at least 2. */
  depthFor(me: RosterAgent, parent: BoardTask | undefined, roster: RosterAgent[]): number {
    return me.role === 'lead' ? 1 : Math.max(1, this.depthOf(parent, roster)) + 1;
  }

  // ── 4 permission and depth ──
  checkPermission(
    me: RosterAgent,
    roster: RosterAgent[],
    c: Call,
    s: Scoped,
  ): { ok: true } | { why: string } | Rejected {
    if (me.role === 'lead') return { ok: true };
    if (c.task.id) return rejected('forbidden', 'only the Lead hands out an existing task');
    const own =
      !!s.parent && OPEN(s.parent) && !!me.assignmentId && s.parent.assignee?.assignmentId === me.assignmentId;
    if (!own) return { why: 'a Worker delegates only under its own task' };
    const depth = this.depthFor(me, s.parent, roster);
    if (depth > 2) return { why: `depth ${depth}: deeper than 2 needs your Lead` };
    return { ok: true };
  }

  // ── 5 the project's delegation mode ──
  checkMode(me: RosterAgent, s: Scoped): string | null {
    const mode = this.store.mode(me.project!);
    if (mode === 'off') return "the project's delegation mode is off: every delegation needs approval";
    if (mode === 'reuse' && 'newWorker' in s.target)
      return "the project's delegation mode is reuse: a new Worker needs approval";
    return null;
  }

  // ── 6 target ──
  checkTarget(me: RosterAgent, roster: RosterAgent[], c: Call, s: Scoped): Picked | Rejected {
    if (c.task.worktree === 'new' && !this.d.delegation.taskWorktree)
      return rejected('unsupported', "worktree 'new' is not available here: give an existing worktree's path, or 'none'");
    if ('agentId' in s.target) {
      const a = findAgent(roster, s.target.agentId);
      if (!a) return rejected('unknown_agent', `no agent '${s.target.agentId}'`);
      if (a.role === 'lead') return rejected('bad_target', 'the Lead takes no delegated work');
      if (a.name === me.name) return rejected('bad_target', 'you cannot delegate to yourself');
      // D5 (6.3): an agent whose CLI this build cannot run here would only gather messages.
      if (!this.d.delegation.providerReady(a.provider))
        return rejected('provider_unavailable', `${a.name}'s agent CLI (${a.provider}) is not available here`);
      const state = this.h.state(a);
      if (state === 'stopped')
        return rejected('target_stopped', `${a.name} was stopped by the user (it is not started for you)`);
      if (state === 'idle' || state === 'down') return { kind: 'existing', agent: a, name: a.name, state };
      const waiting = this.d.queueLength(a.name) + (this.queued.get(a.name) ?? 0);
      if (waiting >= LIMITS.queuePerWorker)
        return rejected('target_queue_full', `${a.name} already has ${waiting} waiting (at most ${LIMITS.queuePerWorker})`);
      return { kind: 'existing', agent: a, name: a.name, state, position: waiting + 1 };
    }
    const w = s.target.newWorker;
    if (!NEW_WORKER_PROVIDERS.includes(w.provider) || !this.d.delegation.providerReady(w.provider))
      return rejected('provider_unavailable', `provider '${w.provider}' cannot start a Worker here (claude, or codex when it is installed)`);
    const idle = roster.filter(
      (a) =>
        a.project === me.project &&
        a.name !== me.name &&
        a.role === w.role &&
        a.provider === w.provider &&
        (!w.model || a.model === w.model) &&
        ['idle', 'down'].includes(this.h.state(a)),
    );
    if (idle.length)
      return rejected('idle_worker_available', 'a Worker of the same kind is free: delegate to one of the candidates', {
        candidates: idle.map((a) => this.h.agentRef(a)),
      });
    const taken = (n: string) => this.names.has(n) || roster.some((a) => a.name === n);
    let name = w.name;
    if (name) {
      const bad = checkName(name);
      if (bad) return rejected('bad_input', `target.newWorker.name: ${bad}`);
      if (taken(name)) return rejected('name_taken', `'${name}' is already an agent's name`);
    } else {
      const base = `${me.project!.slice(0, 30)}-${w.role === 'reviewer' ? 'r' : 'w'}`;
      for (let n = 1; !name; n++) if (!taken(`${base}${n}`)) name = `${base}${n}`;
    }
    return { kind: 'new', name, worker: w };
  }

  /** Workers running now plus those being started (Leads do not count). */
  private workersRunning(roster: RosterAgent[], project: string | null): number {
    const live = roster.filter((a) => a.role !== 'lead' && a.live && (!project || a.project === project)).length;
    const starting = project
      ? (this.starting.get(project) ?? 0)
      : [...this.starting.values()].reduce((x, y) => x + y, 0);
    return live + starting;
  }

  /** Today's delegations of a project: the agent Executions started today (tasks.json). */
  delegationsToday(project: string): number {
    const now = this.h.now();
    let n = 0;
    for (const t of this.d.tasks.list({ project }))
      for (const e of t.executions ?? [])
        if (e.kind === 'agent' && e.startedAt && sameDay(Date.parse(e.startedAt), now)) n++;
    return n + (this.delegations.get(project) ?? 0);
  }
  newWorkersToday(project: string): number {
    return this.store.newWorkersToday(project) + (this.newWorkers.get(project) ?? 0);
  }

  // ── 7 limits and budgets ──
  /** The first limit this call is over (all but `skip`, the one an approval already allowed). */
  checkLimits(
    me: RosterAgent,
    roster: RosterAgent[],
    c: Call,
    s: Scoped,
    t: Picked,
    skip?: LimitKind,
  ): { limit: LimitKind; why: string } | null {
    const project = me.project!;
    const over = (limit: LimitKind, why: string) => (limit === skip ? null : { limit, why });
    const starts = t.kind === 'new' || t.state === 'down';
    const found: Array<{ limit: LimitKind; why: string } | null> = [];
    if (starts) {
      const p = this.workersRunning(roster, project);
      if (p >= LIMITS.projectWorkers)
        found.push(over('projectWorkers', `${p} managed Workers of this project are running (at most ${LIMITS.projectWorkers})`));
      const all = this.workersRunning(roster, null);
      if (all >= LIMITS.hostWorkers)
        found.push(over('hostWorkers', `${all} managed Workers are running on this host (at most ${LIMITS.hostWorkers})`));
    }
    if (t.kind === 'new') {
      // Fail closed: without approvals.json, today's new Workers cannot be counted.
      if (this.store.problem)
        found.push(over('newWorkerRecord', 'approvals.json cannot be read, so today\'s new Workers cannot be counted'));
      const n = this.newWorkersToday(project);
      if (n >= LIMITS.newWorkersPerDay)
        found.push(over('newWorkersPerDay', `${n} new Workers were made today (at most ${LIMITS.newWorkersPerDay} a day)`));
    }
    const n = this.delegationsToday(project);
    if (n >= LIMITS.delegationsPerDay)
      found.push(over('delegationsPerDay', `${n} delegations today (at most ${LIMITS.delegationsPerDay} a day)`));
    const pb = s.parent?.budget;
    if (c.budget && pb) {
      for (const k of ['maxTurns', 'maxMinutes'] as const) {
        const want = c.budget[k];
        const has = pb[k];
        if (want === undefined || has === undefined) continue;
        const used = this.d.tasks
          .list({ project })
          .filter((x) => x.parentId === s.parent!.id && OPEN(x) && x.id !== s.task?.id)
          .reduce((sum, x) => sum + (x.budget?.[k] ?? 0), 0);
        if (want > has - used)
          found.push(over('budget', `budget.${k} ${want} is more than the parent task's remaining ${Math.max(0, has - used)}`));
      }
    }
    return found.find((f) => f !== null) ?? null;
  }

  /** Checks 4-9 (2 and 3 are done). Synchronous up to the reservations. */
  private async decide(
    me: RosterAgent,
    roster: RosterAgent[],
    raw: Record<string, unknown>,
    c: Call,
    s: Scoped,
    opt: { skip?: ApprovalCheck; skipLimit?: LimitKind },
  ): Promise<Result> {
    const perm = this.checkPermission(me, roster, c, s);
    if (isRejected(perm)) return perm;
    if ('why' in perm) return this.propose(me, roster, raw, c, s, 'permission', perm.why);
    if (opt.skip !== 'mode') {
      const why = this.checkMode(me, s);
      if (why) return this.ask(me, roster, raw, c, s, 'mode', why);
    }
    const t = this.checkTarget(me, roster, c, s);
    if (isRejected(t)) return t;
    // An approval for one limit skips that limit only; the others are checked again.
    const over = this.checkLimits(me, roster, c, s, t, opt.skipLimit);
    if (over) return this.ask(me, roster, raw, c, s, 'limits', over.why, over.limit);
    const slot = this.h.reserve(me.name, [t.name]);
    if (typeof slot !== 'function') {
      const f = slot as { error: { code: string; message: string }; retryAfterSec?: number };
      return rejected(f.error.code, f.error.message, { retryAfterSec: f.retryAfterSec });
    }
    const release = this.hold(me.project!, t);
    try {
      const r = await this.execute(me, roster, raw, c, s, t);
      if (isRejected(r)) slot();
      return r;
    } finally {
      release();
    }
  }

  /** The in-flight counts this call holds until it ends. */
  private hold(project: string, t: Picked): () => void {
    const bump = (m: Map<string, number>, k: string, by: number) => m.set(k, (m.get(k) ?? 0) + by);
    const starts = t.kind === 'new' || t.state === 'down';
    if (starts) bump(this.starting, project, 1);
    if (t.kind === 'new') {
      bump(this.newWorkers, project, 1);
      this.names.add(t.name);
    }
    if (t.kind === 'existing' && t.position) bump(this.queued, t.name, 1);
    bump(this.delegations, project, 1);
    return () => {
      if (starts) bump(this.starting, project, -1);
      if (t.kind === 'new') {
        bump(this.newWorkers, project, -1);
        this.names.delete(t.name);
      }
      if (t.kind === 'existing' && t.position) bump(this.queued, t.name, -1);
      bump(this.delegations, project, -1);
    };
  }

  /** Approval: a Lead's call goes to the user, a Worker's to its Lead. */
  private ask(
    me: RosterAgent,
    roster: RosterAgent[],
    raw: Record<string, unknown>,
    c: Call,
    s: Scoped,
    check: ApprovalCheck,
    why: string,
    limit?: LimitKind,
  ): Result | Promise<Result> {
    if (me.role !== 'lead') return this.propose(me, roster, raw, c, s, check, why, limit);
    const mine = this.store.list().filter((a) => a.approver === 'user' && a.caller === me.name);
    if (mine.length >= PENDING_MAX)
      return rejected(
        'too_many_pending',
        `${mine.length} of your delegations already wait for the user's approval (at most ${PENDING_MAX}): ${mine.map((a) => a.id).join(', ')}`,
      );
    const id = `ap-${randomBytes(5).toString('hex')}`;
    const ok = this.store.add({
      id,
      approver: 'user',
      project: me.project!,
      caller: me.name,
      check,
      ...(limit && { limit }),
      why,
      match: this.openKey(me, c, s),
      input: raw,
      createdAt: new Date(this.h.now()).toISOString(),
    });
    if (!ok) return rejected('store_unwritable', this.store.problem ?? 'approvals.json could not be written');
    this.d.delegation.event('delegation_approval', { name: me.project, from: me.name, id, check });
    return { status: 'pending_approval', approvalId: id, message: `waiting for the user's approval: ${why}` };
  }

  /** A Worker's delegation as a proposal to its Lead: a `proposed` Task and a message naming it. */
  private async propose(
    me: RosterAgent,
    roster: RosterAgent[],
    raw: Record<string, unknown>,
    c: Call,
    s: Scoped,
    check: ApprovalCheck,
    why: string,
    limit?: LimitKind,
  ): Promise<Result> {
    const lead = roster.find((a) => a.project === me.project && a.role === 'lead');
    if (!lead?.assignmentId) return rejected('no_lead', 'your project has no Lead to propose to');
    const open = this.d.tasks
      .list({ project: me.project })
      .filter((t) => t.status === 'proposed' && t.createdBy === `agent:${me.name}`);
    if (open.length >= PENDING_MAX)
      return rejected(
        'too_many_pending',
        `${open.length} of your proposals already wait for your Lead (at most ${PENDING_MAX}): ${open.map((t) => t.id).join(', ')}`,
      );
    const slot = this.h.reserve(me.name, [lead.name]);
    if (typeof slot !== 'function') {
      const f = slot as { error: { code: string; message: string }; retryAfterSec?: number };
      return rejected(f.error.code, f.error.message, { retryAfterSec: f.retryAfterSec });
    }
    const r = this.d.tasks.add(
      {
        project: me.project,
        title: c.task.title,
        ...(taskDetail(c) && { detail: taskDetail(c) }),
        ...(s.parent && { parentId: s.parent.id }),
        status: 'proposed',
        assignee: { assignmentId: lead.assignmentId, name: lead.name },
        ...(c.budget && { budget: c.budget }),
      },
      me.name,
      this.h.now(),
      { createdBy: `agent:${me.name}` },
    );
    if (!r.ok) {
      slot();
      return rejected(String(r.code ?? 'refused'), String(r.error ?? ''));
    }
    const task = r.task as BoardTask;
    const stored = this.store.add({
      id: task.id,
      approver: 'lead',
      project: me.project!,
      caller: me.name,
      check,
      ...(limit && { limit }),
      why,
      match: this.openKey(me, c, s),
      input: raw,
      createdAt: new Date(this.h.now()).toISOString(),
    });
    const target = describeTarget(s.target, roster);
    const sent = await this.d.send({
      to: lead.name,
      text: [
        `Task ${task.id} 제안: ${me.name} 이(가) 위임을 제안했어요 (${why}).`,
        `제목: ${task.title}`,
        `대상: ${'newWorker' in s.target ? `새 Worker (${target})` : target}`,
        `받아들이려면 delegate_task({ idempotencyKey, task: { id: "${task.id}" } }) 를 부르세요. 대상을 바꾸려면 target 을 함께 주세요.`,
      ].join('\n'),
      ifIdle: false,
      from: me.name,
      source: MCP_SOURCE,
      task: task.id,
      notice: 'action', // K1: an approval for the Lead to give
    });
    this.d.delegation.event('delegation_proposal', { name: lead.name, from: me.name, task: task.id, check });
    return {
      status: 'pending_approval',
      approvalId: task.id,
      taskId: task.id,
      message: `proposed to your Lead ${lead.name}: ${why}${stored ? '' : ' (approvals.json not written: the Lead must give target)'}${sent.ok ? '' : ` (the message did not go: ${String(sent.error ?? '')})`}`,
    };
  }

  // ── 9 execute ──
  private async execute(
    me: RosterAgent,
    roster: RosterAgent[],
    raw: Record<string, unknown>,
    c: Call,
    s: Scoped,
    t: Picked,
  ): Promise<Result> {
    const project = me.project!;
    let agent: RosterAgent | undefined = t.kind === 'existing' ? t.agent : undefined;
    const folder =
      c.task.worktree && typeof c.task.worktree === 'object' ? c.task.worktree.path : undefined;
    if (t.kind === 'new') {
      // Counted before it is made (fail closed): a store that cannot record it makes none.
      if (!this.store.noteNewWorker(project, t.name))
        return this.ask(me, roster, raw, c, s, 'limits', "approvals.json cannot be written, so today's new Workers cannot be counted", 'newWorkerRecord');
      const made = await this.d.delegation.addWorker({
        name: t.name,
        project,
        role: t.worker.role,
        ...(folder && { folder }),
        ...(t.worker.model && { model: t.worker.model }),
        ...(t.worker.effort && { effort: t.worker.effort }),
        ...(t.worker.provider !== 'claude' && { provider: t.worker.provider }),
      });
      if (!made.ok) return rejected('worker_failed', made.error ?? 'the Worker could not be made');
      agent = this.d.roster().find((a) => a.name === t.name);
    }
    if (!agent?.assignmentId) return rejected('worker_failed', `${t.name} has no assignment`);
    const assignee = { assignmentId: agent.assignmentId, name: agent.name };
    const fields = {
      status: 'todo',
      assignee,
      ...(c.budget && { budget: c.budget }),
      ...(folder && { worktree: folder }),
    };
    const now = this.h.now();
    // W2: the Task's worktree, given to the target before anything is sent. A Task that exists
    // gets it first (a refusal then changes nothing); a new one needs its id, so it comes after.
    const giveWorktree = async (id: string): Promise<Result | null> => {
      if (c.task.worktree !== 'new') return null;
      const w = await this.d.delegation.taskWorktree!({ taskId: id, assignee: agent!.name, project, by: me.name });
      if (w.ok) return null;
      // Another agent that is on works in the Task's worktree: said as such (it is not shared).
      return w.code === 'worktree_in_use'
        ? rejected('worktree_in_use', `${w.error ?? ''}; nothing was changed or sent`, { taskId: id })
        : rejected(
            'worktree_failed',
            `task ${id} is on the board (assigned to ${agent!.name}) but its worktree was not made (${w.code ?? 'failed'}): ${w.error ?? ''}; nothing was sent. Try again with task: { id: "${id}", worktree: "new" }`,
            { taskId: id, agentId: agent!.assignmentId },
          );
    };
    if (s.task) {
      const no = await giveWorktree(s.task.id);
      if (no) return no;
    }
    const r = s.task
      ? this.d.tasks.update(s.task.id, fields, me.name, now, { delegatedBy: me.name })
      : this.d.tasks.add(
          {
            project,
            title: c.task.title,
            ...(taskDetail(c) && { detail: taskDetail(c) }),
            ...(s.parent && { parentId: s.parent.id }),
            ...fields,
          },
          me.name,
          now,
          { createdBy: `agent:${me.name}`, delegatedBy: me.name },
        );
    if (!r.ok) return rejected(String(r.code ?? 'refused'), String(r.error ?? ''));
    let task = r.task as BoardTask;
    if (!s.task) {
      const no = await giveWorktree(task.id);
      if (no) return no;
    }
    task = this.d.tasks.get(task.id) ?? task;
    const att = this.d.tasks.attach(task.id, { kind: 'agent', ref: agent.assignmentId }, me.name, now);
    const executionId = `agent:${agent.assignmentId}`;
    const sent = await this.d.send({
      to: agent.name,
      text: deliveryText(task, me.name, c, s.parent, agent.provider),
      ifIdle: false,
      from: me.name,
      source: MCP_SOURCE,
      task: task.id,
    });
    let note = '';
    if (t.kind === 'new') {
      const started = await this.d.delegation.startAgent(agent.name);
      if (!started.ok) {
        note = ` (made, but it did not start: ${started.error ?? ''}; the task waits in its inbox)`;
        // Still accepted (the Task waits in its inbox), but the owner is told so it is not missed.
        this.d.delegation.event('delegation_start_failed', { name: project, to: agent.name, task: task.id });
      }
    }
    const status = t.kind === 'existing' && t.position ? 'queued' : 'accepted';
    this.d.delegation.event('delegate', {
      name: project,
      from: me.name,
      to: agent.name,
      task: task.id,
      status,
      ...(t.kind === 'new' && { newWorker: true }),
      ...(c.task.area && { area: c.task.area }),
    });
    if (s.proposal) this.settleProposal(s.proposal, me, { status, taskId: task.id, agentId: agent.assignmentId });
    if (!sent.ok)
      return rejected('delivery_failed', `task ${task.id} is on the board but did not reach ${agent.name}: ${String(sent.error ?? '')}`, {
        taskId: task.id,
        agentId: agent.assignmentId,
      });
    return {
      status,
      taskId: task.id,
      executionId: att.ok ? executionId : undefined,
      agentId: agent.assignmentId,
      ...(t.kind === 'existing' && t.position && { position: t.position }),
      ...(note && { message: note.trim() }),
    };
  }

  /** The Lead took a Worker's proposal: the proposer hears it, its key now means this. */
  private settleProposal(p: PendingApproval, lead: RosterAgent, result: Result): void {
    this.store.remove(p.id);
    const key = typeof p.input.idempotencyKey === 'string' ? p.input.idempotencyKey : null;
    if (key) this.remember(`${p.caller}\0${key}`, result);
    void this.d.send({
      to: p.caller,
      text: `[위임 제안 결과] ${lead.name} 이(가) Task ${p.id} 를 맡겼어요: ${String(result.status)}`,
      ifIdle: false,
      from: null,
      source: 'engine',
      notice: 'fyi', // K1: the proposer has nothing to do about it
    });
  }

  // ── The user's answer ──

  /** Approving needs a fresh step-up on a remote device when it would start a new Worker. */
  startsNewWorker(id: string): boolean {
    const a = this.store.get(id);
    const c = a && parseCall(a.input);
    return !!c && !isRejected(c) && !!c.target && 'newWorker' in c.target;
  }

  /** The user's 승인 / 거절 on a pending call; the caller gets a line either way. */
  async answer(
    id: string,
    decision: 'approve' | 'deny',
    reason = '',
  ): Promise<{ ok: true; result: Result } | { ok: false; code: string; error: string }> {
    const a = this.store.get(id);
    if (!a || a.approver !== 'user') return { ok: false, code: 'unknown_approval', error: `no pending approval '${id}'` };
    // Taken off first: a second click (or another screen) finds nothing to run.
    if (!this.store.remove(id))
      return { ok: false, code: 'store_unwritable', error: this.store.problem ?? 'approvals.json could not be written' };
    const key = String(a.input.idempotencyKey ?? '');
    const roster = this.d.roster();
    // The caller must still work for the approval's project.
    const me = roster.find((x) => x.name === a.caller && x.project === a.project);
    let result: Result;
    if (decision === 'deny') {
      result = rejected('denied', reason.trim() || 'the user denied this delegation');
      this.remember(`${a.caller}\0${key}`, result);
    } else if (!me) result = rejected('out_of_scope', `${a.caller} no longer works for ${a.project}`);
    else
      result = await this.call(me, roster, a.input, {
        ...(a.check === 'limits' && a.limit ? { skipLimit: a.limit } : { skip: a.check }),
        rerun: true,
      });
    this.d.delegation.event('delegation_decision', { name: a.project, to: a.caller, id, decision, status: result.status });
    if (me)
      void this.d.send({
        to: a.caller,
        text: `[위임 ${decision === 'approve' ? '승인' : '거절'}] delegate_task(${key}): ${String(result.status)}${result.taskId ? ` ${String(result.taskId)}` : ''}${result.message ? ` — ${String(result.message)}` : ''}`,
        ifIdle: false,
        from: null,
        source: 'engine',
        notice: 'action', // K1: the answer to the caller's approval request
      });
    return { ok: true, result };
  }

  /** list_agents' `you` and `limits`, from the same rules as the checks. */
  standing(me: RosterAgent, roster: RosterAgent[]): { you: Result; mode: DelegationMode; limits: Result } {
    const project = me.project!;
    const mode = this.store.mode(project);
    const parent = this.currentTask(me);
    const depth = this.depthFor(me, parent, roster);
    const allowed =
      me.role === 'lead' ||
      (!!parent && !!me.assignmentId && parent.assignee?.assignmentId === me.assignmentId && depth <= 2);
    const canDelegate =
      allowed && mode !== 'off' && this.delegationsToday(project) < LIMITS.delegationsPerDay;
    const canCreateWorker =
      canDelegate &&
      mode === 'auto' &&
      this.d.delegation.providerReady('claude') &&
      this.workersRunning(roster, project) < LIMITS.projectWorkers &&
      this.workersRunning(roster, null) < LIMITS.hostWorkers &&
      this.newWorkersToday(project) < LIMITS.newWorkersPerDay;
    return {
      you: { depth, canDelegate, canCreateWorker },
      mode,
      limits: {
        workersRunning: [this.workersRunning(roster, project), LIMITS.projectWorkers],
        hostWorkersRunning: [this.workersRunning(roster, null), LIMITS.hostWorkers],
        newWorkersToday: [this.newWorkersToday(project), LIMITS.newWorkersPerDay],
        delegationsToday: [this.delegationsToday(project), LIMITS.delegationsPerDay],
      },
    };
  }

  /** The cards: the user's pending calls, as the 작업실 shows them. */
  cards(roster: RosterAgent[]): Array<Record<string, unknown>> {
    return this.store
      .list()
      .filter((a) => a.approver === 'user')
      .map((a) => {
        const c = parseCall(a.input);
        const call = isRejected(c) ? null : c;
        const task = call?.task.id ? this.d.tasks.get(call.task.id) : undefined;
        return {
          id: a.id,
          project: a.project,
          caller: a.caller,
          check: a.check,
          why: a.why,
          title: call?.task.title ?? task?.title ?? '',
          target: call?.target ? describeTarget(call.target, roster) : '',
          newWorker: !!call?.target && 'newWorker' in call.target,
          createdAt: a.createdAt,
          // The counts now (not when it asked), so the owner sees what approving would add to.
          counts: {
            workersRunning: [this.workersRunning(roster, a.project), LIMITS.projectWorkers],
            hostWorkersRunning: [this.workersRunning(roster, null), LIMITS.hostWorkers],
            newWorkersToday: [this.newWorkersToday(a.project), LIMITS.newWorkersPerDay],
            delegationsToday: [this.delegationsToday(a.project), LIMITS.delegationsPerDay],
          },
        };
      });
  }
}

/**
 * `cld-gui task mode [auto|reuse|off] [--project P]` over the control socket: show or set a
 * project's delegation mode. Setting it is the owner's (no agent token); reading is anyone's.
 */
export function answerMode(
  store: ApprovalStore,
  a: Record<string, unknown>,
  who: { project: string | null; agent?: string | null },
  projects: string[],
): Record<string, unknown> & { ok: boolean } {
  const project = typeof a.project === 'string' && a.project ? a.project : who.project;
  if (!project)
    return { ok: false, code: 'no_project', error: '어느 프로젝트인지 모릅니다(--project <이름>)' };
  if (!projects.includes(project))
    return { ok: false, code: 'unknown_project', error: `'${project}' 프로젝트가 없습니다` };
  const mode = a.mode;
  if (mode === undefined || mode === '') return { ok: true, project, mode: store.mode(project) };
  if (who.agent) return { ok: false, code: 'forbidden', error: '에이전트는 위임 모드를 바꿀 수 없어요' };
  if (!(MODES as readonly unknown[]).includes(mode))
    return { ok: false, code: 'usage', error: `위임 모드는 ${MODES.join('|')} 중 하나예요` };
  if (!store.setMode(project, mode as DelegationMode))
    return { ok: false, code: 'store_unwritable', error: store.problem ?? 'approvals.json 을 쓰지 못했습니다' };
  return { ok: true, project, mode };
}

/**
 * The 작업실's `delegationDecision` (office.ts sends what this returns, with the cards):
 * privileged and writable only; approving a new Worker from a remote device wants a fresh
 * step-up first (nothing runs, `error: 'stepup'`).
 */
export async function answerDecision(
  d: Delegator | null | undefined,
  msg: Record<string, unknown>,
  ctx: { privileged: boolean; readOnly: boolean; stepUp?: { remote: boolean; fresh(): boolean } },
  stepUpRequired: string,
): Promise<Record<string, unknown>> {
  const requestId = typeof msg.requestId === 'string' ? msg.requestId.slice(0, 80) : '';
  const id = typeof msg.id === 'string' ? msg.id : '';
  const decision = msg.decision === 'approve' || msg.decision === 'deny' ? msg.decision : null;
  if (!d) return { requestId, error: koText('delegation_off') };
  if (!ctx.privileged || ctx.readOnly) return { requestId, error: koText('no_permission') };
  if (!requestId || !id || !decision) return { requestId, error: koText('bad_request') };
  if (decision === 'approve' && approvalStepUpRefused(d, id, ctx.stepUp))
    return { requestId, error: stepUpRequired };
  const reason = typeof msg.reason === 'string' ? msg.reason.slice(0, 500) : '';
  const r = await d.answer(id, decision, reason);
  if (!r.ok) return { requestId, error: r.error };
  return {
    requestId,
    outcome: String(r.result.status),
    ...(typeof r.result.taskId === 'string' && { taskId: r.result.taskId }),
    ...(r.result.status === 'rejected' && { error: String(r.result.message ?? r.result.code) }),
  };
}

/** S1: approving a call that starts a new Worker, from a remote device without a fresh step-up, is refused. */
export function approvalStepUpRefused(
  d: Delegator,
  id: string,
  stepUp?: { remote: boolean; fresh(): boolean },
): boolean {
  return !!stepUp?.remote && d.startsNewWorker(id) && !stepUp.fresh();
}

const findAgent = (roster: RosterAgent[], id: string) =>
  roster.find((a) => a.assignmentId === id) ?? roster.find((a) => a.name === id);

/** The target in a few words: a Worker's name, or the new Worker's provider (model, effort, name). */
function describeTarget(t: Target, roster: RosterAgent[]): string {
  if ('agentId' in t) return findAgent(roster, t.agentId)?.name ?? t.agentId;
  const w = t.newWorker;
  return [w.provider, w.model, w.effort, w.role === 'reviewer' ? 'reviewer' : '', w.name].filter(Boolean).join(' ');
}

function taskDetail(c: Call): string | undefined {
  const parts = [c.task.detail?.trim(), c.task.acceptance?.trim() && `완료 기준: ${c.task.acceptance.trim()}`];
  const text = parts.filter(Boolean).join('\n\n');
  return text || undefined;
}

/** What the target's session gets under the header (which names the Task and the delegating agent). */
function deliveryText(task: BoardTask, from: string, c: Call, parent?: BoardTask, provider = 'claude'): string {
  return [
    `Task ${task.id}: ${task.title}`,
    task.detail,
    [
      parent && `상위 Task: ${parent.id}`,
      c.task.area && `영역: ${c.task.area}`,
      task.worktree && `worktree: ${task.worktree}`,
      task.branch && `브랜치: ${task.branch}`,
      task.budget && `예산: ${[task.budget.maxTurns && `${task.budget.maxTurns}턴`, task.budget.maxMinutes && `${task.budget.maxMinutes}분`].filter(Boolean).join(' · ')}`,
    ]
      .filter(Boolean)
      .join(' · '),
    // D5: a Codex Worker has no agent tools; its run's last message is its report.
    provider === 'codex'
      ? `${from} 이(가) 맡긴 일이에요. 끝나면 마지막 메시지에 결과·커밋·남은 일을 짧게 적어 주세요. 그 글이 Lead 에게 그대로 가요.`
      : `${from} 이(가) 맡긴 일이에요. 진행과 결과는 update_task({ taskId: "${task.id}" }) 로 보고해 주세요.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
