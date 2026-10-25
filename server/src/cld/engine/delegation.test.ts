/**
 * C6 (with C5b): delegate_task's checks in B §9.4 order, each the first
 * failing one in its own case, the order itself (a duplicate key wins over a
 * stopped target), depth for Lead/Worker/Reviewer, the modes, the limits
 * (approval for a Lead's call goes to the user, a Worker's to its Lead), the
 * queue cap, idle Workers of the same kind, parallel calls, and the approval
 * round trips (the user's 승인/거절, the Lead taking a Worker's proposal).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  answerDecision,
  answerMode,
  approvalsPath,
  approvalStepUpRefused,
  ApprovalStore,
  LIMITS,
  PENDING_MAX,
} from './delegation.js';
import type { McpDeps, RosterAgent } from './mcpTools.js';
import { McpTools } from './mcpTools.js';
import { tasksPath, TaskStore } from './tasks.js';

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.reverse()) c();
  cleanup = [];
});

const agent = (
  name: string,
  project: string,
  role: RosterAgent['role'],
  id: string,
  o: Partial<RosterAgent> = {},
): RosterAgent => ({
  name,
  project,
  role,
  assignmentId: id,
  provider: 'claude',
  wantRunning: true,
  live: true,
  busy: false,
  ...o,
});

const LEAD = 'a_aaaaaaaaaa';
const W1 = 'a_bbbbbbbbbb';
const W2 = 'a_dddddddddd';
const REV = 'a_eeeeeeeeee';
const BETA = 'a_cccccccccc';
const BETA_W = 'a_ffffffffff';

/** A project alpha (Lead + two Workers + a Reviewer) and beta, real Task and approval stores. */
function world(
  o: {
    addMs?: number;
    sendMs?: number;
    startFails?: boolean;
    /** approvals.json's content before the store reads it (a corrupt file). */
    approvalsRaw?: string;
    roster?: RosterAgent[];
    queue?: Record<string, number>;
    /** The providers installed here (claude only by default). */
    ready?: string[];
    /** W2: worktree 'new' is available (ok) or fails (an error). */
    worktree?: true | string;
  } = {},
) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-c6-'));
  cleanup.push(() => fs.rmSync(h, { recursive: true, force: true }));
  const roster: RosterAgent[] = o.roster ?? [
    agent('alpha', 'alpha', 'lead', LEAD),
    agent('alpha-a', 'alpha', 'worker', W1, { model: 'm-1' }),
    agent('alpha-b', 'alpha', 'worker', W2, { busy: true }),
    agent('alpha-r', 'alpha', 'reviewer', REV, { live: false }), // down: resumes when given work
    agent('beta', 'beta', 'lead', BETA),
    agent('beta-a', 'beta', 'worker', BETA_W),
  ];
  const tasks = new TaskStore(tasksPath(h), () => undefined, () => undefined);
  if (o.approvalsRaw !== undefined) {
    fs.mkdirSync(path.dirname(approvalsPath(h)), { recursive: true });
    fs.writeFileSync(approvalsPath(h), o.approvalsRaw);
  }
  const approvals = new ApprovalStore(approvalsPath(h));
  const sent: Array<{ to: string; text: string; from: string | null; task?: string }> = [];
  const events: Array<{ type: string; fields: Record<string, unknown> }> = [];
  const made: string[] = [];
  const madeWith: Array<Record<string, unknown>> = [];
  const started: string[] = [];
  const worktrees: Array<Record<string, unknown>> = [];
  const order: string[] = [];
  let n = 0;
  const queue = o.queue ?? {};
  const deps: McpDeps = {
    roster: () => roster,
    tasks,
    queueLength: (name) => queue[name] ?? 0,
    limited: () => false,
    send: async (r) => {
      if (o.sendMs) await new Promise((resolve) => setTimeout(resolve, o.sendMs));
      order.push(`send ${r.to}`);
      sent.push(r);
      return { ok: true, delivered: 'pane' };
    },
    groupPost: () => Promise.resolve({ ok: false }),
    findRoom: () => null,
    timeline: () => [],
    delegation: {
      approvals,
      providerReady: (p) => (o.ready ?? ['claude']).includes(p),
      addWorker: async (req) => {
        if (o.addMs) await new Promise((r) => setTimeout(r, o.addMs));
        made.push(req.name);
        madeWith.push(req);
        roster.push(
          agent(req.name, req.project, req.role, `a_${'g'.repeat(8)}${String.fromCharCode(97 + n++)}${'g'}`, {
            live: false,
            wantRunning: false,
            ...(req.model && { model: req.model }),
            ...(req.provider && { provider: req.provider }),
          }),
        );
        return { ok: true };
      },
      startAgent: async (name) => {
        if (o.startFails) return { ok: false, error: 'no session' };
        order.push(`start ${name}`);
        const a = roster.find((x) => x.name === name)!;
        a.live = true;
        a.wantRunning = true;
        started.push(name);
        return { ok: true };
      },
      event: (type, fields) => events.push({ type, fields }),
      // W2: like taskWorktree.ts, the Task then says where its worktree is.
      ...(o.worktree && {
        taskWorktree: async (req: { taskId: string; assignee: string; project: string; by: string }) => {
          order.push(`worktree ${req.taskId} ${req.assignee}`);
          worktrees.push(req);
          if (o.worktree === 'in_use') return { ok: false, code: 'worktree_in_use', error: 'alpha-b 의 것이에요' };
          if (typeof o.worktree === 'string') return { ok: false, error: o.worktree };
          const at = `/w/alpha/.worktrees/${req.taskId.toLowerCase()}`;
          tasks.update(req.taskId, { branch: `task/${req.taskId.toLowerCase()}`, worktree: at }, req.by);
          return { ok: true, path: at, branch: `task/${req.taskId.toLowerCase()}` };
        },
      }),
    },
  };
  const tools = new McpTools(deps);
  const call = (me: string, input: Record<string, unknown>) => tools.call(me, 'delegate_task', input);
  return { h, roster, tasks, approvals, sent, events, made, madeWith, started, tools, call, queue, worktrees, order };
}

let k = 0;
const key = () => `k${++k}`;
const toW1 = (title = 'API 테스트 작성', extra: Record<string, unknown> = {}) => ({
  idempotencyKey: key(),
  task: { title },
  target: { agentId: W1 },
  ...extra,
});
const fresh = (extra: Record<string, unknown> = {}, title = `새 일 ${k}`) => ({
  idempotencyKey: key(),
  task: { title },
  target: { newWorker: { provider: 'claude', reason: '긴 변경', ...extra } },
});

describe('the checks in B §9.4 order', () => {
  it('1 identity: no known agent → rejected/no_identity', async () => {
    const w = world();
    expect(await w.call('nobody', toW1())).toMatchObject({ status: 'rejected', code: 'no_identity' });
  });

  it('2 scope: another project’s target or task → rejected/out_of_scope', async () => {
    const w = world();
    expect(await w.call('alpha', { idempotencyKey: key(), task: { title: 'x' }, target: { agentId: BETA_W } }))
      .toMatchObject({ status: 'rejected', code: 'out_of_scope' });
    const theirs = w.tasks.add({ project: 'beta', title: '베타 일' }, 'cli').task as { id: string };
    expect(await w.call('alpha', toW1('x', { task: { title: 'x', parentTaskId: theirs.id } })))
      .toMatchObject({ status: 'rejected', code: 'out_of_scope' });
  });

  it('3 duplicate: the same key → the first result; an open Task with the same parent, target and title → duplicate', async () => {
    const w = world();
    const input = toW1();
    const first = await w.call('alpha', input);
    expect(first).toMatchObject({ status: 'accepted', agentId: W1 });
    const again = await w.call('alpha', input);
    expect(again).toMatchObject({ status: 'duplicate', taskId: first.taskId, executionId: first.executionId });
    const sameTitle = await w.call('alpha', toW1('  api 테스트 작성 '));
    expect(sameTitle).toMatchObject({ status: 'duplicate', taskId: first.taskId });
    const task = w.tasks.get(first.taskId as string)!;
    expect(task.executions).toHaveLength(1);
    expect(w.sent.filter((s) => s.to === 'alpha-a')).toHaveLength(1);
  });

  it('D3b: after a Lead swap the swapped names’ delegate_task keys are forgotten (a new session answers to them)', async () => {
    const w = world();
    const first = toW1('첫 일');
    expect(await w.call('alpha', first)).toMatchObject({ status: 'accepted' });
    const sameKey = { ...first, task: { title: '다른 일' } };
    expect(await w.call('alpha', sameKey)).toMatchObject({ status: 'duplicate' });
    w.tools.forget(['alpha', 'alpha-a']);
    expect(await w.call('alpha', sameKey)).toMatchObject({ status: 'accepted' });
    expect(w.tasks.list({ project: 'alpha' }).map((t) => t.title).sort()).toEqual(['다른 일', '첫 일']);
  });

  it('order: a duplicate key wins over a stopped target (3 before 6), scope over a duplicate (2 before 3)', async () => {
    const w = world();
    const input = toW1('순서');
    expect((await w.call('alpha', input)).status).toBe('accepted');
    const a = w.roster.find((x) => x.name === 'alpha-a')!;
    a.live = false;
    a.wantRunning = false; // the user stopped it
    expect(await w.call('alpha', input)).toMatchObject({ status: 'duplicate' });
    expect(await w.call('alpha', toW1('다른 일'))).toMatchObject({ status: 'rejected', code: 'target_stopped' });
    // The same key aimed at another project's agent: scope decides first.
    expect(await w.call('alpha', { ...input, target: { agentId: BETA_W } })).toMatchObject({
      status: 'rejected',
      code: 'out_of_scope',
    });
  });

  it('4 depth: a Lead at 1, a Worker/Reviewer under its own Task at 2, else a proposal to the Lead', async () => {
    const w = world();
    const lead = await w.call('alpha', toW1('부모 일'));
    expect(lead.status).toBe('accepted');
    // alpha-a delegates under its own Task (delegated by the Lead): depth 2, runs.
    const sub = await w.call('alpha-a', {
      idempotencyKey: key(),
      task: { title: '하위 일', parentTaskId: lead.taskId },
      target: { agentId: REV },
    });
    expect(sub).toMatchObject({ status: 'accepted', agentId: REV });
    expect(w.tasks.get(sub.taskId as string)).toMatchObject({ parentId: lead.taskId, delegatedBy: 'alpha-a' });
    // alpha-r (Reviewer) under its depth-2 Task: depth 3 → proposal to the Lead.
    w.sent.length = 0;
    const deep = await w.call('alpha-r', {
      idempotencyKey: key(),
      task: { title: '더 깊은 일', parentTaskId: sub.taskId },
      target: { agentId: W1 },
    });
    expect(deep).toMatchObject({ status: 'pending_approval', approvalId: deep.taskId });
    expect(String(deep.message)).toMatch(/depth 3/);
    expect(w.tasks.get(deep.taskId as string)).toMatchObject({
      status: 'proposed',
      assignee: { name: 'alpha' },
      createdBy: 'agent:alpha-r',
    });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({ to: 'alpha', from: 'alpha-r', task: deep.taskId });
    expect(w.sent[0].text).toContain(`Task ${String(deep.taskId)} 제안`);
    // A Worker not under its own Task (alpha-b has none): a proposal too.
    const loose = await w.call('alpha-b', { idempotencyKey: key(), task: { title: '혼자 일' }, target: { agentId: W1 } });
    expect(loose).toMatchObject({ status: 'pending_approval' });
    expect(String(loose.message)).toMatch(/own task/);
    expect(w.approvals.list().filter((a) => a.approver === 'lead')).toHaveLength(2);
  });

  it('5 mode: off → every delegation asks; reuse → only a new Worker asks; auto → none', async () => {
    const w = world();
    w.approvals.setMode('alpha', 'off');
    expect(await w.call('alpha', toW1('끔'))).toMatchObject({ status: 'pending_approval' });
    w.approvals.setMode('alpha', 'reuse');
    expect((await w.call('alpha', toW1('재사용'))).status).toBe('accepted');
    const asked = await w.call('alpha', fresh({ role: 'reviewer' }));
    expect(asked).toMatchObject({ status: 'pending_approval' });
    expect(w.approvals.get(asked.approvalId as string)).toMatchObject({ approver: 'user', check: 'mode', caller: 'alpha' });
    expect(w.made).toEqual([]);
    w.approvals.setMode('alpha', 'auto');
    const made = await w.call('alpha', fresh({ role: 'reviewer', name: 'alpha-r2', model: 'm-9' }));
    expect(made).toMatchObject({ status: 'accepted' });
    expect(w.made).toEqual(['alpha-r2']);
    expect(w.started).toEqual(['alpha-r2']);
    expect(w.sent.find((s) => s.to === 'alpha-r2')).toMatchObject({ from: 'alpha', task: made.taskId });
    // list_agents shows the mode and what the caller may do under it.
    w.approvals.setMode('alpha', 'reuse');
    const listed = await w.tools.call('alpha', 'list_agents', {});
    expect(listed).toMatchObject({ mode: 'reuse', you: { canDelegate: true, canCreateWorker: false } });
  });

  it('6 target: the Lead, yourself, a stopped agent, a full queue, a provider, an idle Worker of that kind', async () => {
    const w = world({ queue: { 'alpha-b': 1 } });
    const to = (agentId: string, title: string) => ({ idempotencyKey: key(), task: { title }, target: { agentId } });
    expect(await w.call('alpha', to(LEAD, 'a'))).toMatchObject({ code: 'bad_target' });
    expect(await w.call('alpha-a', { ...to(W1, 'b') })).toMatchObject({ status: 'pending_approval' }); // 4 first
    expect(await w.call('alpha', to('a_zzzzzzzzzz', 'c'))).toMatchObject({ code: 'unknown_agent' });
    // busy → queued with its place in the line
    const q = await w.call('alpha', to(W2, 'd'));
    expect(q).toMatchObject({ status: 'queued', position: 2, agentId: W2 });
    w.queue['alpha-b'] = LIMITS.queuePerWorker;
    expect(await w.call('alpha', to(W2, 'e'))).toMatchObject({ status: 'rejected', code: 'target_queue_full' });
    // down (wants to run, no session) → accepted, resumed in its own session
    expect(await w.call('alpha', to(REV, 'f'))).toMatchObject({ status: 'accepted' });
    expect(await w.call('alpha', fresh({ provider: 'codex' }))).toMatchObject({ code: 'provider_unavailable' });
    const idle = await w.call('alpha', fresh({ model: 'm-1' }));
    expect(idle).toMatchObject({ status: 'rejected', code: 'idle_worker_available' });
    expect((idle.candidates as Array<{ id: string }>).map((c) => c.id)).toEqual([W1]);
    expect(await w.call('alpha', { ...fresh(), task: { title: 'g', worktree: 'new' } })).toMatchObject({
      code: 'unsupported',
    });
    expect(w.made).toEqual([]);
  });

  it('D5 (6.3): an existing Worker whose provider is not available here: provider_unavailable; list_agents says why', async () => {
    const w = world();
    w.roster.find((a) => a.name === 'alpha-r')!.provider = 'nope'; // down, as it would be
    const to = { idempotencyKey: key(), task: { title: 'x' }, target: { agentId: REV } };
    expect(await w.call('alpha', to)).toMatchObject({ status: 'rejected', code: 'provider_unavailable' });
    expect(w.sent).toEqual([]);
    expect(w.tasks.list({ project: 'alpha' })).toEqual([]);
    const listed = (await w.tools.call('alpha', 'list_agents', {})).agents as Array<Record<string, unknown>>;
    expect(listed.find((a) => a.name === 'alpha-r')).toMatchObject({
      provider: 'nope',
      state: 'down',
      canAccept: false,
      why: 'its agent CLI is not available here',
    });
    expect(listed.find((a) => a.name === 'alpha-a')).toMatchObject({ canAccept: true });
  });

  it('D5: a new Codex Worker when codex is installed here; a Codex target gets the last-message line, not update_task', async () => {
    const w = world({ ready: ['claude', 'codex'] });
    const made = await w.call('alpha', fresh({ provider: 'codex', model: 'model-a' }));
    expect(made).toMatchObject({ status: 'accepted' });
    expect(w.madeWith).toEqual([expect.objectContaining({ provider: 'codex', model: 'model-a', role: 'worker' })]);
    const codexName = w.made[0];
    const toCodex = w.sent.find((x) => x.to === codexName)!;
    expect(toCodex.text).toContain('끝나면 마지막 메시지에 결과·커밋·남은 일을 짧게 적어 주세요. 그 글이 Lead 에게 그대로 가요.');
    expect(toCodex.text).not.toContain('update_task');
    // A Claude target keeps its line.
    expect(await w.call('alpha', toW1('클로드 일'))).toMatchObject({ status: 'accepted' });
    expect(w.sent.find((x) => x.to === 'alpha-a')!.text).toContain('update_task({ taskId:');
    // A Claude new Worker is made without a provider (the default).
    const c = world({ ready: ['claude', 'codex'] });
    expect(await c.call('alpha', fresh({ model: 'other' }))).toMatchObject({ status: 'accepted' });
    expect(c.madeWith[0]).not.toHaveProperty('provider');
    // An unknown provider is never made.
    expect(await w.call('alpha', fresh({ provider: 'acp' }))).toMatchObject({ code: 'provider_unavailable' });
  });

  it('7 limits: a Lead’s call over a limit asks the user, a Worker’s asks its Lead; budgets fit the parent', async () => {
    const w = world();
    // Three Workers running in alpha already: a new one would be the fourth.
    for (const a of w.roster) if (a.project === 'alpha' && a.role !== 'lead') Object.assign(a, { live: true, busy: true });
    const lead = await w.call('alpha', fresh({ model: 'other' }));
    expect(lead).toMatchObject({ status: 'pending_approval' });
    expect(w.approvals.get(lead.approvalId as string)).toMatchObject({ approver: 'user', check: 'limits' });
    expect(String(lead.message)).toMatch(/3 managed Workers of this project/);
    // A Worker under its own Task asking for a new Worker at the limit: to its Lead.
    const parent = w.tasks.add(
      { project: 'alpha', title: '내 일', assignee: { assignmentId: W1, name: 'alpha-a' } },
      'alpha',
      Date.now(),
      { delegatedBy: 'alpha' },
    ).task as { id: string };
    const worker = await w.call('alpha-a', { ...fresh({ model: 'other' }), task: { title: '하위', parentTaskId: parent.id } });
    expect(worker).toMatchObject({ status: 'pending_approval', taskId: worker.approvalId });
    expect(w.approvals.get(worker.approvalId as string)).toMatchObject({ approver: 'lead', check: 'limits' });
    expect(w.sent.at(-1)).toMatchObject({ to: 'alpha', from: 'alpha-a' });
    // The parent's remaining budget.
    const budgeted = w.tasks.add({ project: 'alpha', title: '예산 있는 일', budget: { maxTurns: 10 } }, 'cli')
      .task as { id: string };
    const fits = await w.call('alpha', {
      idempotencyKey: key(),
      task: { title: '예산 6', parentTaskId: budgeted.id },
      target: { agentId: W2 },
      budget: { maxTurns: 6 },
    });
    expect(fits.status).toBe('queued');
    expect(w.tasks.get(fits.taskId as string)?.budget).toEqual({ maxTurns: 6 });
    const over = await w.call('alpha', {
      idempotencyKey: key(),
      task: { title: '예산 5', parentTaskId: budgeted.id },
      target: { agentId: W2 },
      budget: { maxTurns: 5 },
    });
    expect(over).toMatchObject({ status: 'pending_approval' });
    expect(String(over.message)).toMatch(/remaining 4/);
  });

  it('7 limits: 30 delegations and 5 new Workers a day; 6 Workers on the host', async () => {
    const w = world();
    for (let i = 0; i < LIMITS.delegationsPerDay; i++) {
      const t = w.tasks.add({ project: 'alpha', title: `옛 일 ${i}` }, 'alpha').task as { id: string };
      w.tasks.attach(t.id, { kind: 'agent', ref: W1 }, 'alpha');
    }
    const over = await w.call('alpha', toW1('31번째'));
    expect(over).toMatchObject({ status: 'pending_approval' });
    expect(String(over.message)).toMatch(/30 delegations today/);
    const w2 = world({
      roster: [
        agent('alpha', 'alpha', 'lead', LEAD),
        agent('beta', 'beta', 'lead', BETA),
        ...['a_hhhhhhhhha', 'a_hhhhhhhhhb', 'a_hhhhhhhhhc', 'a_hhhhhhhhhd', 'a_hhhhhhhhhe', 'a_hhhhhhhhhf'].map((id, i) =>
          agent(`beta-${i}`, 'beta', 'worker', id, { busy: true }),
        ),
      ],
    });
    const host = await w2.call('alpha', fresh());
    expect(String(host.message)).toMatch(/6 managed Workers are running on this host/);
    const w3 = world();
    for (let i = 0; i < LIMITS.newWorkersPerDay; i++) w3.approvals.noteNewWorker('alpha', `x${i}`);
    const many = await w3.call('alpha', fresh({ model: 'other' }));
    expect(String(many.message)).toMatch(/5 new Workers were made today/);
  });

  it('8 rate: more than 6 delegations a minute between the same two agents → rejected/rate_limited', async () => {
    const w = world();
    for (let i = 0; i < 6; i++) expect((await w.call('alpha', toW1(`일 ${i}`))).status).toBe('accepted');
    const seventh = await w.call('alpha', toW1('일 7'));
    expect(seventh).toMatchObject({ status: 'rejected', code: 'rate_limited' });
    expect(seventh.retryAfterSec).toBeGreaterThan(0);
  });
});

describe('parallel calls and approvals', () => {
  it('10 new Workers at once against a limit of 3: exactly 3 accepted, the rest ask (5) or are refused (too many pending)', async () => {
    const w = world({
      addMs: 30,
      roster: [agent('alpha', 'alpha', 'lead', LEAD)],
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => w.call('alpha', fresh({}, `병렬 ${i}`))),
    );
    const by = (s: string) => results.filter((r) => r.status === s).length;
    expect(by('accepted')).toBe(LIMITS.projectWorkers);
    // The other 7 ask the user, up to the caller's PENDING_MAX; the rest are refused, not dropped.
    expect(by('pending_approval')).toBe(PENDING_MAX);
    expect(results.filter((r) => r.code === 'too_many_pending')).toHaveLength(10 - LIMITS.projectWorkers - PENDING_MAX);
    expect(new Set(w.made).size).toBe(LIMITS.projectWorkers);
    expect(w.approvals.list().filter((a) => a.approver === 'user')).toHaveLength(PENDING_MAX);
  });

  it('the same key twice at once runs once', async () => {
    const w = world({ addMs: 30, roster: [agent('alpha', 'alpha', 'lead', LEAD)] });
    const input = fresh();
    const [a, b] = await Promise.all([w.call('alpha', input), w.call('alpha', input)]);
    expect([a.status, b.status].sort()).toEqual(['accepted', 'duplicate']);
    expect(w.made).toHaveLength(1);
  });

  it('approve re-runs the stored call with its key, once; deny leaves the reason', async () => {
    const w = world();
    w.approvals.setMode('alpha', 'off');
    const input = toW1('승인 대기');
    const asked = await w.call('alpha', input);
    expect(asked.status).toBe('pending_approval');
    // The caller asking again (same key) is told it still waits; nothing ran.
    expect(await w.call('alpha', input)).toMatchObject({ status: 'duplicate', approvalId: asked.approvalId });
    const d = w.tools.delegator!;
    expect(d.cards(w.roster)).toEqual([
      expect.objectContaining({ id: asked.approvalId, caller: 'alpha', check: 'mode', title: '승인 대기', target: 'alpha-a', newWorker: false }),
    ]);
    const ok = await d.answer(asked.approvalId as string, 'approve');
    expect(ok).toMatchObject({ ok: true, result: { status: 'accepted' } });
    const taskId = (ok as unknown as { result: { taskId: string } }).result.taskId;
    expect(await d.answer(asked.approvalId as string, 'approve')).toMatchObject({ ok: false, code: 'unknown_approval' });
    expect(await w.call('alpha', input)).toMatchObject({ status: 'duplicate', taskId });
    expect(w.tasks.list({ project: 'alpha' }).filter((t) => t.title === '승인 대기')).toHaveLength(1);
    expect(w.sent.filter((s) => s.to === 'alpha-a' && s.task === taskId)).toHaveLength(1);
    expect(w.sent.find((s) => s.to === 'alpha' && s.from === null)?.text).toMatch(/^\[위임 승인\] .*accepted/);
    // Deny.
    const other = toW1('거절될 일');
    const asked2 = await w.call('alpha', other);
    expect(await d.answer(asked2.approvalId as string, 'deny', '지금은 안 돼요')).toMatchObject({
      ok: true,
      result: { status: 'rejected', code: 'denied', message: '지금은 안 돼요' },
    });
    expect(w.sent.at(-1)).toMatchObject({ to: 'alpha', from: null });
    expect(w.sent.at(-1)!.text).toContain('지금은 안 돼요');
    expect(await w.call('alpha', other)).toMatchObject({ code: 'denied' });
    expect(w.tasks.list({ project: 'alpha' }).some((t) => t.title === '거절될 일')).toBe(false);
    expect(w.approvals.list()).toEqual([]);
  });

  it('approve skips only the check that asked: the next one can still ask', async () => {
    const w = world();
    w.approvals.setMode('alpha', 'reuse');
    for (const a of w.roster)
      if (a.project === 'alpha' && a.role !== 'lead') Object.assign(a, { live: true, busy: true });
    const asked = await w.call('alpha', fresh({ model: 'other' }));
    expect(w.approvals.get(asked.approvalId as string)?.check).toBe('mode');
    const r = await w.tools.delegator!.answer(asked.approvalId as string, 'approve');
    // mode skipped, limits (3 Workers running) now asks: a new card, nothing made.
    expect(r).toMatchObject({ ok: true, result: { status: 'pending_approval' } });
    expect(w.approvals.list().map((a) => a.check)).toEqual(['limits']);
    expect(w.made).toEqual([]);
  });

  it('a Worker’s proposal: the Lead accepts it with delegate_task({ task: { id } })', async () => {
    const w = world();
    const proposed = await w.call('alpha-b', { idempotencyKey: 'wk', task: { title: '제안된 일' }, target: { agentId: REV } });
    expect(proposed.status).toBe('pending_approval');
    const id = proposed.approvalId as string;
    w.sent.length = 0;
    const taken = await w.call('alpha', { idempotencyKey: key(), task: { id } });
    expect(taken).toMatchObject({ status: 'accepted', taskId: id, agentId: REV });
    expect(w.tasks.get(id)).toMatchObject({ status: 'todo', assignee: { assignmentId: REV }, delegatedBy: 'alpha' });
    expect(w.sent.find((s) => s.to === 'alpha-r')).toMatchObject({ from: 'alpha', task: id });
    expect(w.sent.find((s) => s.to === 'alpha-b')?.text).toContain(`Task ${id}`);
    expect(w.approvals.get(id)).toBeUndefined();
    expect(await w.call('alpha-b', { idempotencyKey: 'wk', task: { title: '제안된 일' }, target: { agentId: REV } }))
      .toMatchObject({ status: 'duplicate', taskId: id });
  });

  it('approving a new Worker from a remote device needs a fresh step-up', async () => {
    const w = world({ roster: [agent('alpha', 'alpha', 'lead', LEAD)] });
    w.approvals.setMode('alpha', 'off');
    const worker = await w.call('alpha', fresh());
    w.roster.push(agent('alpha-a', 'alpha', 'worker', W1));
    const reuse = await w.call('alpha', toW1('재사용'));
    const d = w.tools.delegator!;
    const remote = (ok: boolean) => ({ remote: true, fresh: () => ok });
    expect(approvalStepUpRefused(d, worker.approvalId as string, remote(false))).toBe(true);
    expect(approvalStepUpRefused(d, worker.approvalId as string, remote(true))).toBe(false);
    expect(approvalStepUpRefused(d, worker.approvalId as string, { remote: false, fresh: () => false })).toBe(false);
    expect(approvalStepUpRefused(d, reuse.approvalId as string, remote(false))).toBe(false);
  });

  it('approvals.json is versioned, 0600, and survives a new store', async () => {
    const w = world();
    w.approvals.setMode('alpha', 'off');
    const asked = await w.call('alpha', toW1('남는 승인'));
    const file = approvalsPath(w.h);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(doc).toMatchObject({ v: 1, modes: { alpha: 'off' } });
    expect(doc.approvals[0]).toMatchObject({
      id: asked.approvalId,
      approver: 'user',
      project: 'alpha',
      caller: 'alpha',
      check: 'mode',
      input: { task: { title: '남는 승인' }, target: { agentId: W1 } },
    });
    expect(typeof doc.approvals[0].createdAt).toBe('string');
    expect(new ApprovalStore(file).get(asked.approvalId as string)?.caller).toBe('alpha');
  });

  it('cld-gui task mode: shows and sets a project’s mode; an agent may read it, not set it', () => {
    const w = world();
    const projects = ['alpha', 'beta'];
    expect(answerMode(w.approvals, { op: 'mode' }, { project: 'alpha' }, projects)).toEqual({ ok: true, project: 'alpha', mode: 'auto' });
    expect(answerMode(w.approvals, { op: 'mode', mode: 'reuse', project: 'beta' }, { project: 'alpha' }, projects)).toEqual({
      ok: true,
      project: 'beta',
      mode: 'reuse',
    });
    expect(w.approvals.mode('beta')).toBe('reuse');
    expect(answerMode(w.approvals, { op: 'mode', mode: 'off' }, { project: 'alpha', agent: 'alpha' }, projects)).toMatchObject({ code: 'forbidden' });
    expect(answerMode(w.approvals, { op: 'mode', mode: 'maybe' }, { project: 'alpha' }, projects)).toMatchObject({ code: 'usage' });
    expect(answerMode(w.approvals, { op: 'mode' }, { project: null }, projects)).toMatchObject({ code: 'no_project' });
    expect(answerMode(w.approvals, { op: 'mode', project: 'gamma' }, { project: null }, projects)).toMatchObject({ code: 'unknown_project' });
  });
});

describe('fix round', () => {
  it('a Worker’s own Task is depth 1 whatever made it: a board-assigned chain asks at depth 3', async () => {
    const w = world();
    // The user assigns T on the board (no delegatedBy).
    const t = w.tasks.add(
      { project: 'alpha', title: '보드에서 맡긴 일', assignee: { assignmentId: W1, name: 'alpha-a' } },
      'gui:desk',
    ).task as { id: string };
    const child = await w.call('alpha-a', { idempotencyKey: key(), task: { title: '하위', parentTaskId: t.id }, target: { agentId: REV } });
    expect(child).toMatchObject({ status: 'accepted', agentId: REV });
    const deeper = await w.call('alpha-r', {
      idempotencyKey: key(),
      task: { title: '그 아래', parentTaskId: child.taskId },
      target: { agentId: W2 },
    });
    expect(deeper).toMatchObject({ status: 'pending_approval', taskId: deeper.approvalId });
    expect(String(deeper.message)).toMatch(/depth 3/);
    expect(w.tasks.list({ project: 'alpha' }).filter((x) => x.assignee?.assignmentId === W2)).toHaveLength(0);
  });

  it('new Workers fail closed: a corrupt approvals.json makes none (Lead: refused, Worker: a proposal)', async () => {
    const w = world({ approvalsRaw: '{not json' });
    expect(w.approvals.problem).toBeTruthy();
    for (let i = 0; i < 8; i++) {
      const r = await w.call('alpha', fresh({ model: `m-z${i}` }));
      expect(r).toMatchObject({ status: 'rejected', code: 'store_unwritable' });
    }
    const own = w.tasks.add({ project: 'alpha', title: '내 일', assignee: { assignmentId: W1, name: 'alpha-a' } }, 'alpha')
      .task as { id: string };
    const worker = await w.call('alpha-a', { ...fresh({ model: 'm-x' }), task: { title: '하위 새 사람', parentTaskId: own.id } });
    expect(worker).toMatchObject({ status: 'pending_approval' });
    expect(String(worker.message)).toMatch(/cannot be read/);
    expect(w.made).toEqual([]);
    expect(fs.readFileSync(approvalsPath(w.h), 'utf8')).toBe('{not json');
  });

  it('new Workers fail closed: an approvals.json that cannot be written makes none', async () => {
    const w = world();
    // Read fine at start; from now on every write fails (the path is a non-empty folder).
    fs.mkdirSync(path.join(approvalsPath(w.h), 'x'), { recursive: true });
    for (let i = 0; i < 8; i++) {
      const r = await w.call('alpha', fresh({ model: `m-z${i}` }));
      expect(r).toMatchObject({ status: 'rejected', code: 'store_unwritable' });
    }
    const own = w.tasks.add({ project: 'alpha', title: '내 일', assignee: { assignmentId: W1, name: 'alpha-a' } }, 'alpha')
      .task as { id: string };
    const worker = await w.call('alpha-a', { ...fresh({ model: 'm-x' }), task: { title: '하위 새 사람', parentTaskId: own.id } });
    expect(worker).toMatchObject({ status: 'pending_approval' });
    expect(String(worker.message)).toMatch(/cannot be written/);
    expect(w.made).toEqual([]);
  });

  it('a new Worker is counted in approvals.json for the day', async () => {
    const w = world();
    expect((await w.call('alpha', fresh({ role: 'reviewer', model: 'm-9', name: 'alpha-r9' }))).status).toBe('accepted');
    expect(w.approvals.newWorkersToday('alpha')).toBe(1);
    expect(JSON.parse(fs.readFileSync(approvalsPath(w.h), 'utf8')).newWorkers).toEqual([
      expect.objectContaining({ project: 'alpha', name: 'alpha-r9' }),
    ]);
  });

  it('approving skips only the limit that asked: a budget card approved after the host filled up asks again for the host', async () => {
    const w = world();
    const parent = w.tasks.add({ project: 'alpha', title: '예산 10', budget: { maxTurns: 10 } }, 'cli').task as { id: string };
    const asked = await w.call('alpha', {
      ...fresh({ role: 'reviewer', model: 'm-b' }),
      task: { title: '예산 넘는 새 일', parentTaskId: parent.id },
      budget: { maxTurns: 20 },
    });
    expect(w.approvals.get(asked.approvalId as string)).toMatchObject({ check: 'limits', limit: 'budget' });
    // Another project fills the host: 6 running (alpha-a, alpha-b, beta-a + three more).
    for (const id of ['a_hhhhhhhhha', 'a_hhhhhhhhhb', 'a_hhhhhhhhhc'])
      w.roster.push(agent(`beta-${id.slice(-1)}`, 'beta', 'worker', id, { busy: true }));
    const card = w.tools.delegator!.cards(w.roster)[0] as { counts: { hostWorkersRunning: number[] } };
    expect(card.counts.hostWorkersRunning).toEqual([6, LIMITS.hostWorkers]);
    const r = await w.tools.delegator!.answer(asked.approvalId as string, 'approve');
    expect(r).toMatchObject({ ok: true, result: { status: 'pending_approval' } });
    expect(w.approvals.list()).toEqual([expect.objectContaining({ limit: 'hostWorkers' })]);
    expect(w.approvals.list()[0].why).toMatch(/6 managed Workers are running on this host/);
    expect(w.made).toEqual([]);
  });

  it(`at most ${PENDING_MAX} pending approvals per caller; the same task waiting is a duplicate`, async () => {
    const w = world();
    w.approvals.setMode('alpha', 'off');
    const first = await w.call('alpha', toW1('대기 0'));
    expect(await w.call('alpha', toW1(' 대기 0 '))).toMatchObject({ status: 'duplicate', approvalId: first.approvalId });
    for (let i = 1; i < PENDING_MAX; i++) expect((await w.call('alpha', toW1(`대기 ${i}`))).status).toBe('pending_approval');
    const over = await w.call('alpha', toW1('대기 넘침'));
    expect(over).toMatchObject({ status: 'rejected', code: 'too_many_pending' });
    expect(String(over.message)).toContain(String(first.approvalId));
    expect(w.approvals.list()).toHaveLength(PENDING_MAX);
    // Proposals to the Lead: the same cap per Worker, the same task twice is a duplicate.
    const p0 = await w.call('alpha-b', { idempotencyKey: key(), task: { title: '제안 0' }, target: { agentId: REV } });
    expect(await w.call('alpha-b', { idempotencyKey: key(), task: { title: '제안 0' }, target: { agentId: REV } })).toMatchObject({
      status: 'duplicate',
      approvalId: p0.approvalId,
    });
    for (let i = 1; i < PENDING_MAX; i++)
      expect((await w.call('alpha-b', { idempotencyKey: key(), task: { title: `제안 ${i}` }, target: { agentId: REV } })).status).toBe(
        'pending_approval',
      );
    const tooMany = await w.call('alpha-b', { idempotencyKey: key(), task: { title: '제안 넘침' }, target: { agentId: REV } });
    expect(tooMany).toMatchObject({ status: 'rejected', code: 'too_many_pending' });
    expect(String(tooMany.message)).toContain(String(p0.approvalId));
  });

  it('parallel calls to a busy Worker take queue places 1, 2, 3; the rest find it full', async () => {
    const w = world({ sendMs: 20 });
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        w.call('alpha', { idempotencyKey: key(), task: { title: `줄 ${i}` }, target: { agentId: W2 } }),
      ),
    );
    expect(results.filter((r) => r.status === 'queued').map((r) => r.position).sort()).toEqual([1, 2, 3]);
    expect(results.filter((r) => r.code === 'target_queue_full')).toHaveLength(2);
  });

  it('the 작업실’s decision: privileged, writable, and a fresh step-up before a remote device starts a new Worker', async () => {
    const w = world({ roster: [agent('alpha', 'alpha', 'lead', LEAD)] });
    w.approvals.setMode('alpha', 'off');
    const asked = await w.call('alpha', fresh());
    const d = w.tools.delegator!;
    const msg = { requestId: 'r1', id: asked.approvalId, decision: 'approve' };
    const remote = (ok: boolean) => ({ remote: true, fresh: () => ok });
    expect(await answerDecision(d, msg, { privileged: false, readOnly: false }, 'stepup')).toMatchObject({
      requestId: 'r1',
      error: expect.any(String),
    });
    expect(await answerDecision(d, msg, { privileged: true, readOnly: true }, 'stepup')).toMatchObject({ error: expect.any(String) });
    expect(await answerDecision(d, msg, { privileged: true, readOnly: false, stepUp: remote(false) }, 'stepup')).toEqual({
      requestId: 'r1',
      error: 'stepup',
    });
    expect(w.approvals.get(asked.approvalId as string)).toBeTruthy();
    expect(w.made).toEqual([]);
    expect(await answerDecision(d, msg, { privileged: true, readOnly: false, stepUp: remote(true) }, 'stepup')).toMatchObject({
      requestId: 'r1',
      outcome: 'accepted',
    });
    expect(w.made).toHaveLength(1);
  });

  it('approving checks the caller still works for the project; a Worker that does not start is still accepted, with a notice', async () => {
    const w = world();
    w.approvals.setMode('alpha', 'off');
    const asked = await w.call('alpha', toW1('옮긴 뒤'));
    w.roster.find((a) => a.name === 'alpha')!.project = 'gamma';
    expect(await w.tools.delegator!.answer(asked.approvalId as string, 'approve')).toMatchObject({
      ok: true,
      result: { status: 'rejected', code: 'out_of_scope' },
    });
    expect(w.tasks.list({ project: 'alpha' }).some((t) => t.title === '옮긴 뒤')).toBe(false);
    const f = world({ startFails: true });
    const r = await f.call('alpha', fresh({ role: 'reviewer', model: 'm-s', name: 'alpha-s' }));
    expect(r).toMatchObject({ status: 'accepted' });
    expect(f.events.find((e) => e.type === 'delegation_start_failed')?.fields).toMatchObject({
      name: 'alpha',
      to: 'alpha-s',
      task: r.taskId,
    });
  });
});

describe('W2: worktree new', () => {
  it('an existing Worker: the Task’s worktree is made and given to it before the Task is sent; the message names it', async () => {
    const w = world({ worktree: true });
    const r = await w.call('alpha', { idempotencyKey: key(), task: { title: '로그인', worktree: 'new' }, target: { agentId: W1 } });
    expect(r).toMatchObject({ status: 'accepted', taskId: 'T-1', agentId: W1 });
    expect(w.worktrees).toEqual([{ taskId: 'T-1', assignee: 'alpha-a', project: 'alpha', by: 'alpha' }]);
    expect(w.order).toEqual(['worktree T-1 alpha-a', 'send alpha-a']);
    expect(w.sent[0].text).toContain('worktree: /w/alpha/.worktrees/t-1 · 브랜치: task/t-1');
    expect(w.tasks.get('T-1')).toMatchObject({ branch: 'task/t-1', worktree: '/w/alpha/.worktrees/t-1', assignee: { assignmentId: W1 } });
  });

  it('a new Worker: made, its worktree given, the Task sent, then started (it starts in the worktree)', async () => {
    const w = world({ worktree: true });
    const r = await w.call('alpha', { ...fresh({ name: 'alpha-n', model: 'm-9' }), task: { title: 'api', worktree: 'new' } });
    expect(r).toMatchObject({ status: 'accepted' });
    expect(w.made).toEqual(['alpha-n']);
    expect(w.madeWith[0]).not.toHaveProperty('folder');
    expect(w.order).toEqual([`worktree ${String(r.taskId)} alpha-n`, 'send alpha-n', 'start alpha-n']);
  });

  it('a worktree that cannot be made: rejected/worktree_failed, the Task on the board, nothing sent or started', async () => {
    const w = world({ worktree: '저장소가 rebase 중이에요' });
    const r = await w.call('alpha', { ...fresh({ name: 'alpha-n', model: 'm-9' }), task: { title: 'api', worktree: 'new' } });
    expect(r).toMatchObject({ status: 'rejected', code: 'worktree_failed', taskId: 'T-1' });
    expect(String(r.message)).toContain('저장소가 rebase 중이에요');
    expect(String(r.message)).toContain('task: { id: "T-1", worktree: "new" }');
    expect(w.sent).toEqual([]);
    expect(w.started).toEqual([]);
    expect(w.tasks.get('T-1')?.executions ?? []).toEqual([]);
  });

  it('a Task whose worktree another running agent holds: rejected/worktree_in_use, the Task unchanged, nothing sent', async () => {
    const w = world({ worktree: 'in_use' });
    const t = w.tasks.add({ project: 'alpha', title: 'held', assignee: { assignmentId: W2, name: 'alpha-b' } }, 'alpha').task as { id: string };
    const r = await w.call('alpha', { idempotencyKey: key(), task: { id: t.id, worktree: 'new' }, target: { agentId: W1 } });
    expect(r).toMatchObject({ status: 'rejected', code: 'worktree_in_use', taskId: t.id });
    expect(w.tasks.get(t.id)?.assignee?.assignmentId).toBe(W2);
    expect(w.sent).toEqual([]);
    expect(w.tasks.get(t.id)?.executions ?? []).toEqual([]);
  });

  it('without the operation (a build that has none): unsupported, as before', async () => {
    const w = world();
    expect(await w.call('alpha', { ...fresh(), task: { title: 'g', worktree: 'new' } })).toMatchObject({ code: 'unsupported' });
    expect(w.made).toEqual([]);
  });
});
