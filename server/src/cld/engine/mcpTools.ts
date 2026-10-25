/**
 * C5a: the agent tools behind the MCP adapter (cld/bin/cld-gui-mcp.js, B §9.3).
 * The adapter is stateless; every call arrives here over the control socket as
 * `mcp` with the session's CLD_AGENT_TOKEN, and the daemon decides. The caller
 * is the agent its token names (control.ts), never a cwd or `--from`.
 *
 * Checks (B §9.4, the ones C5a applies): 1 identity (control.ts refuses a
 * missing or unknown token), 2 scope (the caller's project: another project's
 * agent, Task or a room the caller is not in → out_of_scope), 3 duplicate (a
 * writing call with the same caller and `idempotencyKey` within 24 h gets the
 * first result back with status 'duplicate'), 8 pairwise rate (more than 6
 * messages/tasks between the same two agents a minute → rate_limited). The
 * counters live in memory: a daemon restart forgets them, which only lets a
 * few more calls through. delegate_task and its checks 4-7 (C5b/C6) are in
 * delegation.ts.
 *
 * Results are JSON objects; a refusal is `{ error: { code, message } }` with a
 * stable English code. Long lists take a `cursor`.
 */
import type { BoardTask } from '../../../../core/src/messages.js';
import { SEND_TEXT_MAX } from '../chatSend.js';
import type { DelegationDeps } from './delegation.js';
import { Delegator, LIMITS, MCP_SOURCE } from './delegation.js';
import type { GroupPost } from './groupMessages.js';
import { roomMentions } from './groupMessages.js';
import type { GroupRoom } from './groups.js';
import type { TaskStore } from './tasks.js';
import { STATUSES } from './tasks.js';

/** One agent as the engine knows it (Engine.roster). */
export interface RosterAgent {
  name: string;
  /** The project it works for (a Lead's is its own name). */
  project: string | null;
  role: 'lead' | 'worker' | 'reviewer';
  assignmentId: string | null;
  provider: string;
  model?: string;
  wantRunning: boolean;
  live: boolean;
  /** Its session's status says a turn runs (null: no session). */
  busy: boolean | null;
}

export interface McpDeps {
  roster(): RosterAgent[];
  tasks: TaskStore;
  /** Messages waiting in the messenger's queue for `name`. */
  queueLength(name: string): number;
  /** The provider's usage limit is reached now. */
  limited(provider: string): boolean;
  /** The messenger's send (the header names `from`). */
  send(req: {
    to: string;
    text: string;
    ifIdle: boolean;
    /** null: the daemon itself (an approval's result line). */
    from: string | null;
    source: string;
    /** C6: the delegated Task this message hands over (the header names it). */
    task?: string;
    /** K1: a daemon-made notice's class (messenger QueuedSend.notice). */
    notice?: 'action' | 'fyi';
  }): Promise<Reply>;
  /** The room post (mentions wake members, B §9.1). */
  groupPost(req: { room: string; text: string; from: string; source: string }): Promise<Reply>;
  findRoom(room: string): GroupRoom | null;
  /** The room's posts, oldest first. */
  timeline(room: GroupRoom): GroupPost[];
  /** C6: delegate_task's parts; absent, delegate_task answers rejected/unavailable. */
  delegation?: DelegationDeps;
  now?: () => number;
}

type Reply = Record<string, unknown> & { ok: boolean };
type Result = Record<string, unknown>;

export { LIMITS, MCP_SOURCE };
export const RATE = { perMinute: 6, windowMs: 60_000 };
const DUPLICATE_MS = 24 * 60 * 60_000;
const DUPLICATE_MAX = 10_000;
const PAGE = { tasks: 20, posts: 20, postsMax: 100 };
const WRITING = new Set(['create_task', 'update_task', 'send_message', 'post_to_group']);

type Failure = { error: { code: string; message: string }; retryAfterSec?: number };
export const fail = (code: string, message: string): Failure => ({ error: { code, message } });
const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);
const isError = (r: Result) => 'error' in r;

/** An offset cursor: the number of items already returned. */
function offsetOf(cursor: unknown): number | null {
  if (cursor === undefined || cursor === null || cursor === '') return 0;
  return typeof cursor === 'string' && /^\d{1,6}$/.test(cursor) ? Number(cursor) : null;
}

export class McpTools {
  private readonly now: () => number;
  /** "a\0b" (sorted) → times of the calls between them in the last window. */
  private readonly pairs = new Map<string, number[]>();
  /** "caller\0tool\0key" → the first result and when. */
  private readonly done = new Map<string, { at: number; result: Result }>();
  /** The same key while its first call still runs: a concurrent duplicate waits for it. */
  private readonly running = new Map<string, Promise<Result>>();
  /** C6: delegate_task (its own duplicate keys: an approval re-runs a call by its key). */
  readonly delegator: Delegator | null;

  constructor(private readonly d: McpDeps) {
    this.now = d.now ?? Date.now;
    const delegation = d.delegation;
    this.delegator = delegation
      ? new Delegator({
          deps: { ...d, delegation },
          now: this.now,
          reserve: (a, others) => this.reserve(a, others),
          state: (a) => this.state(a),
          agentRef: (a) => this.agentRef(a, this.d.tasks.list({ project: a.project })),
        })
      : null;
  }

  /** D3b: a Lead swap committed: `names` now answer for other sessions, so what this daemon
   *  remembers per caller (idempotency keys, calls in flight) and per pair (the rate) for them
   *  is forgotten, here and in delegate_task's. */
  forget(names: readonly string[]): void {
    const mine = (k: string) => names.some((n) => k.startsWith(`${n}\0`));
    for (const m of [this.done, this.running]) for (const k of [...m.keys()]) if (mine(k)) m.delete(k);
    for (const k of [...this.pairs.keys()])
      if (k.split('\0').some((n) => names.includes(n))) this.pairs.delete(k);
    this.delegator?.forget(names);
  }

  /** One tool call by agent `me` (already identified by its token). */
  async call(me: string, tool: string, raw: unknown): Promise<Result> {
    const input =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const roster = this.d.roster();
    const self = roster.find((a) => a.name === me);
    if (tool === 'delegate_task') {
      // B §9.3's result shape: a status, never an error object.
      if (!self || !self.project)
        return { status: 'rejected', code: 'no_identity', message: 'this session is not a known agent' };
      if (!this.delegator)
        return { status: 'rejected', code: 'unavailable', message: 'delegation is not available in this daemon' };
      return this.delegator.call(self, roster, input);
    }
    if (!self || !self.project) return fail('no_identity', 'this session is not a known agent');
    const key = input.idempotencyKey;
    if (key !== undefined && (typeof key !== 'string' || !key || key.length > 200))
      return fail('bad_input', 'idempotencyKey must be a string of 1-200 characters');
    const dupKey = WRITING.has(tool) && typeof key === 'string' ? `${me}\0${tool}\0${key}` : null;
    if (!dupKey) return this.run(self, roster, tool, input);
    this.prune();
    const first = this.done.get(dupKey);
    if (first) return { ...first.result, status: 'duplicate' };
    const inFlight = this.running.get(dupKey);
    if (inFlight) {
      const r = await inFlight;
      return isError(r) ? r : { ...r, status: 'duplicate' };
    }
    const run = Promise.resolve(this.run(self, roster, tool, input));
    this.running.set(dupKey, run);
    try {
      const result = await run;
      if (!isError(result)) {
        if (this.done.size >= DUPLICATE_MAX) this.done.delete(this.done.keys().next().value!);
        this.done.set(dupKey, { at: this.now(), result });
      }
      return result;
    } finally {
      this.running.delete(dupKey);
    }
  }

  private run(
    me: RosterAgent,
    roster: RosterAgent[],
    tool: string,
    input: Record<string, unknown>,
  ): Result | Promise<Result> {
    const mine = roster.filter((a) => a.project === me.project);
    switch (tool) {
      case 'list_agents':
        return this.listAgents(me, roster, input);
      case 'create_task':
        return this.createTask(me, mine, input);
      case 'update_task':
        return this.updateTask(me, input);
      case 'get_task_status':
        return this.taskStatus(me, input);
      case 'send_message':
        return this.sendMessage(me, roster, input);
      case 'post_to_group':
        return this.postToGroup(me, roster, input);
      case 'get_group_context':
        return this.groupContext(me, input);
      default:
        return fail('unknown_tool', `no tool '${tool}'`);
    }
  }

  private state(a: RosterAgent): 'idle' | 'busy' | 'down' | 'limit' | 'stopped' {
    if (!a.live) return a.wantRunning ? (this.d.limited(a.provider) ? 'limit' : 'down') : 'stopped';
    if (this.d.limited(a.provider)) return 'limit';
    return a.busy ? 'busy' : 'idle';
  }

  private listAgents(
    me: RosterAgent,
    roster: RosterAgent[],
    input: Record<string, unknown>,
  ): Result {
    const want = input.state ?? 'all';
    if (want !== 'idle' && want !== 'busy' && want !== 'all')
      return fail('bad_input', "state must be 'idle', 'busy' or 'all'");
    const tasks = this.d.tasks.list({ project: me.project });
    const agents = roster
      .filter((a) => a.project === me.project && a.name !== me.name)
      .map((a) => this.agentRef(a, tasks))
      .filter((a) => want === 'all' || a.state === want);
    const running = (list: RosterAgent[]) => list.filter((a) => a.role !== 'lead' && a.live).length;
    // C6: what delegate_task would allow now, from its own rules.
    const standing = this.delegator?.standing(me, roster);
    return {
      you: {
        id: me.assignmentId ?? me.name,
        name: me.name,
        role: me.role,
        depth: me.role === 'lead' ? 1 : 2,
        canDelegate: false,
        canCreateWorker: false,
        ...standing?.you,
      },
      mode: standing?.mode ?? 'auto',
      agents,
      limits: standing?.limits ?? {
        workersRunning: [
          running(roster.filter((a) => a.project === me.project)),
          LIMITS.projectWorkers,
        ],
        hostWorkersRunning: [running(roster), LIMITS.hostWorkers],
        newWorkersToday: [0, LIMITS.newWorkersPerDay],
        delegationsToday: [0, LIMITS.delegationsPerDay],
      },
    };
  }

  /** One agent as list_agents (and idle_worker_available's candidates) show it. */
  agentRef(a: RosterAgent, tasks: BoardTask[]): Result & { state: string } {
    const state = this.state(a);
    const queue = this.d.queueLength(a.name);
    const why =
      a.role === 'lead'
        ? 'the Lead takes no delegated work'
        : state === 'stopped'
          ? 'stopped by the user'
          : this.d.delegation && !this.d.delegation.providerReady(a.provider)
            ? 'its agent CLI is not available here'
            : queue >= LIMITS.queuePerWorker
            ? 'its queue is full'
            : null;
    return {
      id: a.assignmentId ?? a.name,
      name: a.name,
      role: a.role,
      provider: a.provider,
      ...(a.model && { model: a.model }),
      state,
      canAccept: why === null,
      ...(why && { why }),
      queue,
      openTasks: tasks
        .filter(
          (t) =>
            t.status !== 'done' && !!a.assignmentId && t.assignee?.assignmentId === a.assignmentId,
        )
        .map((t) => ({ id: t.id, title: t.title, status: t.status })),
    };
  }

  /** The Task, when the caller may see it. */
  private task(me: RosterAgent, id: unknown): BoardTask | Failure {
    if (typeof id !== 'string' || !id) return fail('bad_input', 'taskId is required');
    const t = this.d.tasks.get(id);
    if (!t) return fail('unknown_task', `no task '${id}'`);
    if (t.project !== me.project)
      return fail('out_of_scope', `task '${id}' belongs to another project`);
    return t;
  }

  private createTask(me: RosterAgent, mine: RosterAgent[], input: Record<string, unknown>): Result {
    const title = str(input.title);
    if (!title) return fail('bad_input', 'title is required');
    if (input.detail !== undefined && typeof input.detail !== 'string')
      return fail('bad_input', 'detail must be a string');
    if (input.parentTaskId !== undefined) {
      const parent = this.task(me, input.parentTaskId);
      if ('error' in parent) return parent;
    }
    // A Worker's task is a proposal addressed to its Lead (the Lead decides).
    const lead = me.role === 'lead' ? null : mine.find((a) => a.role === 'lead');
    if (me.role !== 'lead' && !lead?.assignmentId)
      return fail('no_lead', 'your project has no Lead to propose to');
    const slot = lead ? this.reserve(me.name, [lead.name]) : () => undefined;
    if (typeof slot !== 'function') return slot;
    const r = this.d.tasks.add(
      {
        project: me.project,
        title,
        ...(typeof input.detail === 'string' && input.detail && { detail: input.detail }),
        ...(typeof input.parentTaskId === 'string' && { parentId: input.parentTaskId }),
        status: lead ? 'proposed' : 'todo',
        ...(lead && { assignee: { assignmentId: lead.assignmentId, name: lead.name } }),
      },
      me.name,
      this.now(),
      { createdBy: `agent:${me.name}` },
    );
    if (!r.ok) {
      slot();
      return fail(String(r.code ?? 'refused'), String(r.error ?? ''));
    }
    const task = r.task as BoardTask;
    return { status: lead ? 'proposed' : 'created', taskId: task.id, task: brief(task, mine) };
  }

  private updateTask(me: RosterAgent, input: Record<string, unknown>): Result {
    const t = this.task(me, input.taskId);
    if ('error' in t) return t;
    const assignee = !!me.assignmentId && t.assignee?.assignmentId === me.assignmentId;
    if (!assignee && me.role !== 'lead')
      return fail('forbidden', "only the task's assignee and the project's Lead may update it");
    const fields: Record<string, unknown> = {};
    if (input.status !== undefined) {
      if (!(STATUSES as readonly unknown[]).includes(input.status))
        return fail('bad_input', `status must be one of ${STATUSES.join(', ')}`);
      fields.status = input.status;
    }
    if (input.note !== undefined) {
      if (typeof input.note !== 'string') return fail('bad_input', 'note must be a string');
      fields.note = input.note;
    }
    if (!Object.keys(fields).length) return fail('bad_input', 'give status or note');
    const r = this.d.tasks.update(t.id, fields, me.name, this.now());
    if (!r.ok) return fail(String(r.code ?? 'refused'), String(r.error ?? ''));
    // C4: the assignee handing its work back (review, done) is a report, a room's one line.
    if (assignee && !r.unchanged && (fields.status === 'review' || fields.status === 'done') && t.status !== fields.status)
      this.d.delegation?.event('task_report', { name: me.project, from: me.name, task: t.id, status: fields.status });
    return {
      status: r.unchanged ? 'unchanged' : 'updated',
      task: brief(r.task as BoardTask, this.d.roster()),
    };
  }

  private taskStatus(me: RosterAgent, input: Record<string, unknown>): Result {
    if (input.taskId !== undefined) {
      const t = this.task(me, input.taskId);
      return 'error' in t ? t : { tasks: [brief(t, this.d.roster())] };
    }
    const offset = offsetOf(input.cursor);
    if (offset === null) return fail('bad_input', 'cursor is not one this tool returned');
    let list = this.d.tasks.list({ project: me.project });
    if (input.mine === true)
      list = list.filter(
        (t) =>
          (!!me.assignmentId && t.assignee?.assignmentId === me.assignmentId) ||
          t.createdBy === `agent:${me.name}`,
      );
    const page = list.slice(offset, offset + PAGE.tasks);
    const next = offset + page.length;
    const roster = this.d.roster();
    return {
      tasks: page.map((t) => brief(t, roster)),
      ...(next < list.length && { cursor: String(next) }),
    };
  }

  /** `to`: an assignment id or a name. */
  private target(me: RosterAgent, roster: RosterAgent[], to: unknown): RosterAgent | Failure {
    const want = str(to);
    if (!want) return fail('bad_input', 'to is required (an agent id or name)');
    const a = roster.find((x) => x.assignmentId === want) ?? roster.find((x) => x.name === want);
    if (!a) return fail('unknown_agent', `no agent '${want}'`);
    if (a.project !== me.project)
      return fail('out_of_scope', `'${want}' works for another project`);
    if (a.name === me.name) return fail('bad_input', 'you cannot message yourself');
    return a;
  }

  private async sendMessage(
    me: RosterAgent,
    roster: RosterAgent[],
    input: Record<string, unknown>,
  ): Promise<Result> {
    const to = this.target(me, roster, input.to);
    if ('error' in to) return to;
    const text = checkedText(input.text);
    if (typeof text !== 'string') return text;
    // Reserved before the await: parallel calls cannot all pass the same check.
    const slot = this.reserve(me.name, [to.name]);
    if (typeof slot !== 'function') return slot;
    const r = await this.d.send({
      to: to.name,
      text,
      ifIdle: false,
      from: me.name,
      source: MCP_SOURCE,
    });
    if (!r.ok) {
      slot();
      return fail(String(r.code ?? 'send_failed'), String(r.error ?? ''));
    }
    return {
      status: 'sent',
      to: { id: to.assignmentId ?? to.name, name: to.name },
      delivered: r.delivered,
    };
  }

  /** The room, when the caller is in it. */
  private room(me: RosterAgent, room: unknown): GroupRoom | Failure {
    const name = str(room);
    if (!name) return fail('bad_input', 'room is required');
    const found = this.d.findRoom(name);
    if (!found) return fail('unknown_room', `no room '${name}'`);
    if (!found.members.includes(me.name))
      return fail('out_of_scope', `you are not a member of '${name}'`);
    return found;
  }

  private async postToGroup(
    me: RosterAgent,
    roster: RosterAgent[],
    input: Record<string, unknown>,
  ): Promise<Result> {
    const room = this.room(me, input.room);
    if ('error' in room) return room;
    const text = checkedText(input.text);
    if (typeof text !== 'string') return text;
    const { targets, error } = roomMentions(text, room.members);
    if (error) return fail('unknown_member', error);
    const others = targets.filter((t) => t !== me.name);
    const outside = others.find((t) => roster.find((a) => a.name === t)?.project !== me.project);
    if (outside) return fail('out_of_scope', `'${outside}' works for another project`);
    const slot = this.reserve(me.name, others);
    if (typeof slot !== 'function') return slot;
    const r = await this.d.groupPost({
      room: room.id,
      text,
      from: me.name,
      source: MCP_SOURCE,
    });
    if (!r.ok) {
      slot();
      return fail(String(r.code ?? 'post_failed'), String(r.error ?? ''));
    }
    const post = r.post as GroupPost;
    return { status: 'posted', room: room.name, postId: post.id, mentioned: post.targets };
  }

  private groupContext(me: RosterAgent, input: Record<string, unknown>): Result {
    const room = this.room(me, input.room);
    if ('error' in room) return room;
    const n = input.n ?? PAGE.posts;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > PAGE.postsMax)
      return fail('bad_input', `n must be an integer 1-${PAGE.postsMax}`);
    const skip = offsetOf(input.cursor);
    if (skip === null) return fail('bad_input', 'cursor is not one this tool returned');
    // Newest first in pages; each page oldest first. The cursor counts posts already returned.
    const all = this.d.timeline(room);
    const end = Math.max(0, all.length - skip);
    const page = all.slice(Math.max(0, end - n), end);
    const next = skip + page.length;
    return {
      room: { id: room.id, name: room.name, members: room.members },
      posts: page.map((p) => ({
        id: p.id,
        at: new Date(p.at).toISOString(),
        sender: p.sender ?? 'user',
        text: p.text,
        mentioned: p.targets,
      })),
      ...(next < all.length && { cursor: String(next) }),
    };
  }

  /**
   * Check 8: one slot for `a` with each of `others` (agent names), taken now, synchronously,
   * before the caller awaits anything; a refusal when a pair already has its limit this minute.
   * The returned function gives the slots back (the call then failed).
   */
  private reserve(a: string, others: string[]): Failure | (() => void) {
    const now = this.now();
    const keys = others.map((b) => [a, b].sort().join('\0'));
    for (const [i, key] of keys.entries()) {
      const times = (this.pairs.get(key) ?? []).filter((t) => now - t < RATE.windowMs);
      this.pairs.set(key, times);
      if (times.length >= RATE.perMinute)
        return {
          ...fail(
            'rate_limited',
            `more than ${RATE.perMinute} messages/tasks a minute between ${a} and ${others[i]}`,
          ),
          retryAfterSec: Math.max(1, Math.ceil((times[0] + RATE.windowMs - now) / 1000)),
        };
    }
    for (const key of keys) this.pairs.get(key)!.push(now);
    return () => {
      for (const key of keys) {
        const times = this.pairs.get(key);
        const i = times?.lastIndexOf(now) ?? -1;
        if (i >= 0) times!.splice(i, 1);
      }
    };
  }

  private prune(): void {
    const now = this.now();
    for (const [k, v] of this.done) if (now - v.at >= DUPLICATE_MS) this.done.delete(k);
  }
}

/** The message text, or why not: empty, or longer than the app's chat takes (SEND_TEXT_MAX characters). */
function checkedText(text: unknown): string | Failure {
  if (typeof text !== 'string' || !text.trim()) return fail('bad_input', 'text is required');
  if (text.length > SEND_TEXT_MAX)
    return fail('bad_input', `text must be at most ${SEND_TEXT_MAX} characters`);
  return text;
}

/** A Task as the tools return it: every field and fact with its source; the edit history left
 *  out. D3b: its assignee under the name its assignment answers to now (`roster`), as the board
 *  shows it; the stored name when no agent holds that assignment. */
function brief(t: BoardTask, roster: readonly RosterAgent[]): Record<string, unknown> {
  const { history: _h, ...rest } = t;
  const a = t.assignee;
  const name = a && roster.find((r) => r.assignmentId === a.assignmentId)?.name;
  return name && a && name !== a.name ? { ...rest, assignee: { ...a, name } } : rest;
}
