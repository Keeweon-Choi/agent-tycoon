/**
 * W2: "a worktree for a Task" (taskWorktree.ts) over a temp repository, a real Task store and
 * a real RepoManager: what it makes and records, who it is given to, every refusal (nothing
 * made), the one-write-per-repository rule, and `cld-gui worktree new|list`'s answers.
 */
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RepoError } from './git/gitRun.js';
import { RepoManager } from './git/repoManager.js';
import type { TempRepo } from './git/testRepo.js';
import { GIT_AVAILABLE, makeTempRepo, recording } from './git/testRepo.js';
import type { WorktreeRecord } from './git/worktrees.js';
import type { RosterAgent } from './mcpTools.js';
import { tasksPath, TaskStore } from './tasks.js';
import { answerWorktree, CLAIM_MS, type SeatDeps, seatInWorktree, worktreeForTask } from './taskWorktree.js';

vi.setConfig({ testTimeout: 60_000 });

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.splice(0).reverse()) c();
});

const agent = (name: string, project: string, role: RosterAgent['role'], id: string, o: Partial<RosterAgent> = {}): RosterAgent => ({
  name,
  project,
  role,
  assignmentId: id,
  provider: 'claude',
  wantRunning: false,
  live: false,
  busy: null,
  ...o,
});

function rig(o: { readOnly?: boolean } = {}) {
  const r: TempRepo = makeTempRepo();
  const other = makeTempRepo();
  cleanup.push(() => r.cleanup(), () => other.cleanup());
  const rec = recording(r.run);
  const cfg = path.join(r.root, 'config');
  const repos = new RepoManager({
    projects: () => [
      { name: 'alpha', folder: r.folder },
      { name: 'beta', folder: other.folder },
    ],
    readOnly: o.readOnly ?? false,
    configDir: cfg,
    run: rec.run,
    pollMs: 60_000,
    log: () => undefined,
  });
  cleanup.push(() => repos.dispose());
  const tasks = new TaskStore(tasksPath(r.root), () => undefined, () => undefined);
  const roster: RosterAgent[] = [
    agent('alpha', 'alpha', 'lead', 'a_aaaaaaaaaa', { live: true }),
    agent('alpha-w1', 'alpha', 'worker', 'a_bbbbbbbbbb', { live: true }),
    agent('alpha-c1', 'alpha', 'worker', 'a_cccccccccc', { provider: 'codex' }),
    agent('beta', 'beta', 'lead', 'a_dddddddddd'),
  ];
  const d = { tasks, repos, roster: () => roster };
  const add = (title: string, project = 'alpha') => tasks.add({ project, title }, 'cli').task as { id: string };
  const records = () => JSON.parse(fs.readFileSync(path.join(cfg, 'worktrees.json'), 'utf-8')) as WorktreeRecord[];
  const make = (req: Partial<Parameters<typeof worktreeForTask>[1]> & { taskId: string }, privileged = true) =>
    worktreeForTask(d, { by: 'gui:Phone', createdBy: 'user', ...req }, privileged, 'gui:Phone');
  return { r, other, rec, repos, tasks, roster, d, add, records, make, cfg };
}

describe.skipIf(!GIT_AVAILABLE)('W2: a worktree for a Task', () => {
  it('makes feat/t<id>-<slug> in .worktrees/, records the Task and its assignee, and the Task says where', async () => {
    const { r, add, make, records, tasks } = rig();
    const t = add('Login page');
    const out = await make({ taskId: t.id, assignee: 'alpha-w1' });
    const at = path.join(r.folder, '.worktrees', 'feat-t1-login-page');
    expect(out).toMatchObject({
      ok: true,
      project: 'alpha',
      taskId: 'T-1',
      task: 'feat-t1-login-page',
      path: at,
      branch: 'feat/t1-login-page',
      base: 'main',
      assignee: 'alpha-w1',
      assignmentId: 'a_bbbbbbbbbb',
    });
    expect(out.detail).toBe(
      'feat/t1-login-page · .worktrees/feat-t1-login-page · alpha-w1 에게 배정했어요. 켜져 있는 세션은 옮기지 않고, 다음에 켤 때 이 worktree 에서 시작해요',
    );
    expect(records()).toEqual([
      expect.objectContaining({ project: 'alpha', task: 'feat-t1-login-page', taskId: 'T-1', assignmentId: 'a_bbbbbbbbbb', createdBy: 'user', status: 'active' }),
    ]);
    const task = tasks.get('T-1')!;
    expect([task.branch, task.worktree]).toEqual(['feat/t1-login-page', at]);
    expect(task.history.at(-1)).toMatchObject({ by: 'gui:Phone', change: 'branch — → feat/t1-login-page, worktree' });
    expect(fs.existsSync(path.join(at, 'a.txt'))).toBe(true);
    expect(r.git(['status', '--porcelain'])).toBe('');
  });

  it('no assignee, a named base; the note says what the assignment means for each kind of agent', async () => {
    const { r, add, make } = rig();
    r.git(['branch', 'dev']);
    const plain = await make({ taskId: add('x').id, base: 'dev' });
    expect(plain).toMatchObject({ ok: true, base: 'dev' });
    expect(plain).not.toHaveProperty('assignee');
    expect((await make({ taskId: add('y').id, assignee: 'alpha-c1' })).detail).toContain('Codex 실행은 이 worktree 에서 돌아요');
    expect((await make({ taskId: add('z').id, assignee: 'alpha' })).detail).toContain('Lead 의 세션 폴더는 그대로예요');
  });

  it('refuses, with nothing made: unknown Task, another project’s Task or agent, unknown agent, a Task that has one', async () => {
    const { r, add, make, records, rec } = rig();
    const t = add('a');
    const b = add('b', 'beta');
    expect(await make({ taskId: 'T-99' })).toMatchObject({ ok: false, code: 'unknown_task' });
    expect(await make({ taskId: b.id, scope: 'alpha' })).toMatchObject({ ok: false, code: 'out_of_scope' });
    expect(await make({ taskId: t.id, assignee: 'nobody' })).toMatchObject({ ok: false, code: 'unknown_agent' });
    expect(await make({ taskId: t.id, assignee: 'beta' })).toMatchObject({ ok: false, code: 'out_of_scope' });
    expect(rec.calls).toEqual([]);
    expect(fs.existsSync(path.join(r.folder, '.worktrees'))).toBe(false);
    expect(await make({ taskId: t.id })).toMatchObject({ ok: true });
    expect(await make({ taskId: t.id, assignee: 'alpha-w1' })).toMatchObject({ ok: false, code: 'exists' });
    expect(records()).toHaveLength(1);
    expect(records()[0]).not.toHaveProperty('assignmentId');
  });

  it('reuse refuses a worktree another running agent holds (worktree_in_use); a stopped holder gives it up', async () => {
    const { add, make, records, roster } = rig();
    const t = add('a');
    await make({ taskId: t.id, assignee: 'alpha-w1' }); // alpha-w1 is live in this roster
    expect(await make({ taskId: t.id, assignee: 'alpha-c1', reuse: true })).toMatchObject({ ok: false, code: 'worktree_in_use' });
    expect(records().map((x) => x.assignmentId)).toEqual(['a_bbbbbbbbbb']);
    // The same holder again is not "another": fine.
    expect(await make({ taskId: t.id, assignee: 'alpha-w1', reuse: true })).toMatchObject({ ok: true, reused: true });
    roster.find((a) => a.name === 'alpha-w1')!.live = false;
    expect(await make({ taskId: t.id, assignee: 'alpha-c1', reuse: true })).toMatchObject({ ok: true, assignmentId: 'a_cccccccccc' });
  });

  it('N6: a worktree just given counts as held until its agent shows (CLAIM_MS); on-but-down Claude holds; the Lead never', async () => {
    const s = rig();
    let now = 1_000_000;
    const d = { ...s.d, claims: new Map(), now: () => now };
    const make = (taskId: string, assignee: string, reuse = false) =>
      worktreeForTask(d, { taskId, assignee, by: 'alpha', createdBy: 'agent:alpha', reuse }, true, 'mcp:alpha');
    const w1 = s.roster.find((a) => a.name === 'alpha-w1')!;
    w1.live = false; // given, not started yet (the gap between assign, send and start)
    const t = s.add('a');
    expect(await make(t.id, 'alpha-w1')).toMatchObject({ ok: true });
    expect(await make(t.id, 'alpha-c1', true)).toMatchObject({ ok: false, code: 'worktree_in_use' });
    now += CLAIM_MS + 1;
    expect(await make(t.id, 'alpha-c1', true)).toMatchObject({ ok: true, assignmentId: 'a_cccccccccc' });
    // On but down (Claude revives it into the worktree): held.
    const t2 = s.add('b');
    w1.wantRunning = true;
    expect(await make(t2.id, 'alpha-w1')).toMatchObject({ ok: true });
    now += CLAIM_MS + 1;
    expect(await make(t2.id, 'alpha-c1', true)).toMatchObject({ ok: false, code: 'worktree_in_use' });
    // The Lead's is recorded only: given on to a Worker at once (no claim kept for it either way).
    const t3 = s.add('c');
    expect(await make(t3.id, 'alpha')).toMatchObject({ ok: true });
    now += CLAIM_MS + 1;
    expect(await make(t3.id, 'alpha-c1', true)).toMatchObject({ ok: true });
  });

  it('delegate_task’s reuse: a Task that has its worktree gives that one to the new assignee', async () => {
    const { add, make, records, roster } = rig();
    const t = add('a');
    const first = await make({ taskId: t.id, assignee: 'alpha-w1' });
    roster.find((a) => a.name === 'alpha-w1')!.live = false;
    const again = await make({ taskId: t.id, assignee: 'alpha-c1', reuse: true });
    expect(again).toMatchObject({ ok: true, reused: true, path: first.path, assignmentId: 'a_cccccccccc' });
    expect(records().map((x) => x.assignmentId)).toEqual(['a_cccccccccc']);
  });

  it('the repository write gates: read-only daemon, unprivileged caller, a git failure (Korean), the Task store unwritable', async () => {
    const ro = rig({ readOnly: true });
    expect(await ro.make({ taskId: ro.add('a').id })).toMatchObject({ ok: false, code: 'read_only' });
    expect(ro.rec.calls).toEqual([]);
    const s = rig();
    const t = s.add('a');
    expect(await s.make({ taskId: t.id }, false)).toMatchObject({ ok: false, code: 'forbidden', error: '이 접속에는 조작 권한이 없어요' });
    expect(await s.make({ taskId: t.id, base: 'nope' })).toMatchObject({ ok: false, code: 'no_base', error: '기준 브랜치 nope가 없어요' });
    expect(s.tasks.get(t.id)).not.toHaveProperty('branch');
    fs.writeFileSync(tasksPath(s.r.root), '{ broken');
    const broken = new TaskStore(tasksPath(s.r.root), () => undefined, () => undefined);
    expect(await worktreeForTask({ ...s.d, tasks: broken }, { taskId: t.id, by: 'cli', createdBy: 'cli' }, true, 'cli')).toMatchObject({ ok: false, code: 'store_unwritable' });
  });

  it('one write per repository at a time: a worktree while a commit runs is refused, then made', async () => {
    const { r, repos, add, make, records } = rig();
    const t = add('a');
    let release!: () => void;
    const held = repos.write('alpha', true, 'cli', 'commit', () => new Promise<{ ok: boolean }>((res) => (release = () => res({ ok: true }))));
    expect(await make({ taskId: t.id })).toMatchObject({ ok: false, code: 'busy', error: 'alpha: 이미 다른 조작이 진행 중이에요' });
    expect(fs.existsSync(path.join(r.folder, '.worktrees'))).toBe(false);
    // Another repository is not held.
    expect(await make({ taskId: add('b', 'beta').id })).toMatchObject({ ok: true, project: 'beta' });
    release();
    await held;
    expect(await make({ taskId: t.id })).toMatchObject({ ok: true });
    expect(records().map((x) => [x.project, x.taskId])).toEqual([['beta', 'T-2'], ['alpha', 'T-1']]);
  });

  it('the screen’s repoAction worktreeNew reaches the same operation and answers as a repoActionResult', async () => {
    const s = rig();
    const repos: RepoManager = new RepoManager({
      projects: () => [{ name: 'alpha', folder: s.r.folder }],
      readOnly: false,
      configDir: s.cfg,
      run: s.rec.run,
      pollMs: 60_000,
      log: () => undefined,
      taskWorktree: (req, privileged, source) =>
        worktreeForTask({ ...s.d, repos }, { taskId: req.taskId ?? '', assignee: req.assignee || null, by: source, createdBy: 'user' }, privileged, source),
    });
    cleanup.push(() => repos.dispose());
    s.add('a');
    const got: Array<Record<string, unknown>> = [];
    repos.onClientMessage({ type: 'repoAction', requestId: 'q1', action: 'worktreeNew', project: 'alpha', taskId: 'T-1', assignee: 'alpha-w1' }, (m) => got.push(m), true, 'gui:Phone');
    await vi.waitFor(() => expect(got).toHaveLength(1));
    expect(got[0]).toMatchObject({ type: 'repoActionResult', requestId: 'q1', action: 'worktreeNew', project: 'alpha', ok: true });
    expect(got[0]).not.toHaveProperty('code');
    repos.onClientMessage({ type: 'repoAction', requestId: 'q2', action: 'worktreeNew', project: 'alpha', taskId: 'T-1' }, (m) => got.push(m), false);
    await vi.waitFor(() => expect(got).toHaveLength(2));
    expect(got[1]).toEqual({ type: 'repoActionResult', requestId: 'q2', action: 'worktreeNew', project: 'alpha', ok: false, error: '이 접속에는 조작 권한이 없어요' });
  });
});

describe.skipIf(!GIT_AVAILABLE)('W2: cld-gui worktree new|list', () => {
  const owner = { by: 'cli', agent: null, project: null };
  it('new: the owner’s CLI for any project; an agent’s token only for its own project’s Tasks', async () => {
    const s = rig();
    const d = { ...s.d, projects: () => ['alpha', 'beta'] };
    s.add('a');
    s.add('b', 'beta');
    expect(await answerWorktree(d, { op: 'new' }, owner)).toMatchObject({ ok: false, code: 'usage' });
    const made = await answerWorktree(d, { op: 'new', task: 'T-1', assign: 'alpha-w1' }, owner);
    expect(made).toMatchObject({ ok: true, taskId: 'T-1', branch: 'feat/t1-a', assignee: 'alpha-w1' });
    expect(s.records()[0].createdBy).toBe('cli');
    // Fix 5: the refusal's own code reaches the CLI (not git_failed).
    expect(await answerWorktree(d, { op: 'new', task: 'T-1' }, owner)).toMatchObject({ ok: false, code: 'exists' });
    expect(await answerWorktree(d, { op: 'new', task: 'T-2', base: 'nope' }, owner)).toMatchObject({ ok: false, code: 'no_base' });
    const lead = { by: 'alpha', agent: 'alpha', project: 'alpha' };
    expect(await answerWorktree(d, { op: 'new', task: 'T-2' }, lead)).toMatchObject({ ok: false, code: 'out_of_scope' });
    expect(await answerWorktree(d, { op: 'nope' }, owner)).toMatchObject({ ok: false, code: 'usage' });
  });

  it('list: every project’s worktrees with Task and assignee (an agent sees its project’s), or one Task’s', async () => {
    const s = rig();
    const d = { ...s.d, projects: () => ['alpha', 'beta'] };
    s.add('a');
    s.add('b', 'beta');
    s.add('c');
    await answerWorktree(d, { op: 'new', task: 'T-1', assign: 'alpha-w1' }, owner);
    await answerWorktree(d, { op: 'new', task: 'T-2' }, owner);
    await answerWorktree(d, { op: 'new', task: 'T-3' }, owner);
    const all = (await answerWorktree(d, { op: 'list' }, owner)).worktrees as Array<Record<string, unknown>>;
    expect(all.map((w) => [w.project, w.taskId, w.assignee ?? null])).toEqual([
      ['alpha', 'T-1', 'alpha-w1'],
      ['alpha', 'T-3', null],
      ['beta', 'T-2', null],
    ]);
    expect(all[0]).toMatchObject({ task: 'feat-t1-a', branch: 'feat/t1-a', base: 'main', exists: true, ahead: 0, dirty: 0, merged: true });
    const one = (await answerWorktree(d, { op: 'list', task: 'T-3' }, owner)).worktrees as Array<Record<string, unknown>>;
    expect(one.map((w) => w.taskId)).toEqual(['T-3']);
    const lead = { by: 'alpha', agent: 'alpha', project: 'alpha' };
    const mine = (await answerWorktree(d, { op: 'list' }, lead)).worktrees as Array<Record<string, unknown>>;
    expect(mine.map((w) => w.project)).toEqual(['alpha', 'alpha']);
    expect(await answerWorktree(d, { op: 'list', task: 'T-2' }, lead)).toMatchObject({ ok: false, code: 'unknown_task' });
  });
});

describe.skipIf(!GIT_AVAILABLE)('DV4: the owner makes a worktree and seats an agent in it', () => {
  function seatRig() {
    const s = rig();
    const calls: string[] = [];
    const sent: Array<{ to: string; text: string; task: string }> = [];
    const lifetimes: Record<string, 'session' | 'run'> = { 'alpha-w1': 'session', 'alpha-c1': 'run' };
    let answer: { ok: boolean; error?: string; note?: string } = { ok: true };
    const answerWith = (a: typeof answer) => {
      answer = a;
    };
    // T-70: where each agent's session works now, and which still run `claude --bg`.
    const at: Record<string, string> = {};
    const old = new Set<string>();
    const answers: Record<string, typeof answer> = {};
    const d: SeatDeps = {
      ...s.d,
      lifetime: (name) => lifetimes[name],
      engineAction: (action, name) => {
        calls.push(`${action} ${name}`);
        return Promise.resolve(answers[action] ?? answer);
      },
      worksIn: (name, folder) => at[name] === folder,
      oldStyle: (name) => old.has(name),
      send: (r) => {
        sent.push(r);
        return Promise.resolve({ ok: true });
      },
    };
    const seat = (req: Partial<Parameters<typeof seatInWorktree>[1]>) =>
      seatInWorktree(d, { taskId: '', by: 'gui:web', createdBy: 'user', seat: true, ...req }, true, 'gui:web');
    return { ...s, calls, sent, seat, answerWith, at, old, answers };
  }

  it('M1 with no issue: a new Task, the owner’s branch from the chosen base, the agent restarted there, the first instruction with the Task', async () => {
    const s = seatRig();
    s.r.git(['branch', 'dev']);
    const out = await s.seat({ title: '쿠폰 적용 순서', project: 'alpha', branch: 'feat/cart-coupon', base: 'dev', assignee: 'alpha-w1', text: '쿠폰을 합계 뒤로' });
    expect(out).toMatchObject({ ok: true, taskId: 'T-1', task: 'feat-cart-coupon', branch: 'feat/cart-coupon', base: 'dev', assignee: 'alpha-w1' });
    const at = path.join(s.r.folder, '.worktrees', 'feat-cart-coupon');
    expect(fs.existsSync(at)).toBe(true);
    expect(s.records()[0]).toMatchObject({ taskId: 'T-1', branch: 'feat/cart-coupon', base: 'dev', assignmentId: 'a_bbbbbbbbbb', createdBy: 'user' });
    expect(s.tasks.get('T-1')).toMatchObject({ project: 'alpha', title: '쿠폰 적용 순서', branch: 'feat/cart-coupon', worktree: at, assignee: { name: 'alpha-w1' } });
    // alpha-w1 is on: its session moves only at a start, so it is restarted (the engine's own action).
    expect(s.calls).toEqual(['restart alpha-w1']);
    expect(s.sent).toEqual([{ to: 'alpha-w1', text: '쿠폰을 합계 뒤로', task: 'T-1' }]);
    expect(out.detail).toContain('다시 시작해 이 워크트리에 앉혔어요');
  });

  it('a branch that exists is refused with its name, and nothing is made: no Task, no worktree, no start', async () => {
    const s = seatRig();
    s.r.git(['branch', 'feat/cart-coupon']);
    const out = await s.seat({ title: 'x', project: 'alpha', branch: 'feat/cart-coupon', assignee: 'alpha-w1' });
    expect(out).toMatchObject({ ok: false, code: 'exists' });
    expect(out.error).toContain('feat/cart-coupon');
    expect(s.tasks.list()).toEqual([]);
    expect(fs.existsSync(path.join(s.cfg, 'worktrees.json'))).toBe(false);
    expect(s.calls).toEqual([]);
    // A name outside the rules is refused the same way.
    expect(await s.seat({ title: 'x', project: 'alpha', branch: 'Cart Coupon' })).toMatchObject({ ok: false, code: 'bad_name' });
    expect(s.tasks.list()).toEqual([]);
  });

  it('M1 with an issue: that Task gets the worktree; an agent of one process per message is not started', async () => {
    const s = seatRig();
    const t = s.add('T-7 쿠폰');
    const out = await s.seat({ taskId: t.id, branch: 'fix/coupon-order', assignee: 'alpha-c1', text: 'go' });
    expect(out).toMatchObject({ ok: true, taskId: t.id, task: 'fix-coupon-order' });
    expect(s.tasks.list()).toHaveLength(1);
    expect(s.calls).toEqual([]);
    expect(s.sent).toEqual([{ to: 'alpha-c1', text: 'go', task: t.id }]);
  });

  it('M2 seating on a card: the Task’s worktree given to an agent that is off, started there; its older worktree is no longer its own', async () => {
    const s = seatRig();
    s.roster[1].live = false;
    const a = s.add('a');
    const b = s.add('b');
    await s.seat({ taskId: a.id, branch: 'feat/a-one', assignee: 'alpha-w1' });
    await s.make({ taskId: b.id });
    s.calls.length = 0;
    const out = await s.seat({ taskId: b.id, assignee: 'alpha-w1' });
    expect(out).toMatchObject({ ok: true, taskId: b.id, reused: true, assignee: 'alpha-w1' });
    const byTask = Object.fromEntries(s.records().map((x) => [x.taskId, x.assignmentId]));
    expect(byTask).toEqual({ [a.id]: undefined, [b.id]: 'a_bbbbbbbbbb' });
    // F2: the older Task no longer names it either (the rail, the board and the Lead agree).
    expect(s.tasks.get(a.id)?.assignee ?? null).toBeNull();
    expect(s.tasks.get(b.id)?.assignee).toMatchObject({ name: 'alpha-w1' });
    expect(s.calls).toEqual(['start alpha-w1']);
    expect(s.sent).toEqual([]);
  });

  it('F1 a restart that fails sends no first instruction (it would be worked in the old folder), and says why', async () => {
    const s = seatRig();
    s.answerWith({ ok: false, error: '터미널에서 쓰는 중이에요' });
    const out = await s.seat({ title: 'x', project: 'alpha', branch: 'feat/x', assignee: 'alpha-w1', text: 'go' });
    expect(out.ok).toBe(true);
    expect(s.calls).toEqual(['restart alpha-w1']);
    expect(s.sent).toEqual([]);
    expect(out.detail).toContain('첫 지시는 보내지 않았어요: 터미널에서 쓰는 중이에요');
  });

  it('F5 the engine’s own note on the start (a new conversation) reaches the owner', async () => {
    const s = seatRig();
    s.answerWith({ ok: true, note: '새 대화로 시작했어요' });
    const out = await s.seat({ title: 'x', project: 'alpha', branch: 'feat/x', assignee: 'alpha-w1' });
    expect(out.detail).toContain('다시 시작해 이 워크트리에 앉혔어요 · 새 대화로 시작했어요');
  });

  it('T-70 an agent already working in that worktree is left as it is (no restart), the instruction still goes', async () => {
    const s = seatRig();
    const t = s.add('a');
    await s.seat({ taskId: t.id, branch: 'feat/a-one', assignee: 'alpha-w1' });
    s.calls.length = 0;
    s.at['alpha-w1'] = s.records()[0].path;
    const out = await s.seat({ taskId: t.id, assignee: 'alpha-w1', text: 'go' });
    expect(out).toMatchObject({ ok: true, reused: true, assignee: 'alpha-w1' });
    expect(s.calls).toEqual([]);
    expect(s.sent).toEqual([{ to: 'alpha-w1', text: 'go', task: t.id }]);
    expect(out.detail).toContain('이미 이 워크트리에서 일하고 있어요');
    // Off in that folder: it is started there.
    s.roster[1].live = false;
    await s.seat({ taskId: t.id, assignee: 'alpha-w1' });
    expect(s.calls).toEqual(['start alpha-w1']);
  });

  it('T-70 a Claude agent still on claude --bg moves into our terminal host first; a refused move says why and it runs the old way', async () => {
    const s = seatRig();
    s.old.add('alpha-w1');
    s.roster[1].live = false;
    await s.seat({ title: 'x', project: 'alpha', branch: 'feat/x', assignee: 'alpha-w1' });
    expect(s.calls).toEqual(['pty alpha-w1', 'start alpha-w1']);
    s.calls.length = 0;
    s.roster[1].live = true;
    s.answers.pty = { ok: false, error: '아직 일하는 중이에요' };
    const out = await s.seat({ title: 'y', project: 'alpha', branch: 'feat/y', assignee: 'alpha-w1' });
    expect(s.calls).toEqual(['pty alpha-w1', 'restart alpha-w1']);
    expect(out.detail).toContain('새 터미널 방식으로 옮기지 못해 예전 방식으로 켜요: 아직 일하는 중이에요');
  });

  it('F4 the Lead is never seated (nor restarted)', async () => {
    const s = seatRig();
    const out = await s.seat({ title: 'x', project: 'alpha', branch: 'feat/x', assignee: 'alpha' });
    expect(out).toMatchObject({ ok: false, code: 'seat_lead' });
    expect(s.calls).toEqual([]);
    expect(s.tasks.list()).toEqual([]);
  });

  it('F3 .worktrees as a file is refused before a Task is made; a failure after it names the Task', async () => {
    const s = seatRig();
    fs.writeFileSync(path.join(s.r.folder, '.worktrees'), 'x');
    expect(await s.seat({ title: 'x', project: 'alpha', branch: 'feat/x' })).toMatchObject({ ok: false });
    expect(s.tasks.list()).toEqual([]);
    fs.rmSync(path.join(s.r.folder, '.worktrees'));
    const wts = s.repos.worktrees;
    wts.createForTask = () => Promise.reject(new RepoError('git worktree add 이 실패했어요'));
    const out = await s.seat({ title: 'x', project: 'alpha', branch: 'feat/x', assignee: 'alpha-w1', text: 'go' });
    expect(out).toMatchObject({ ok: false, code: 'worktree_failed' });
    expect(out.error).toContain('T-1 은 이슈 판에 있지만 워크트리는 만들지 못했어요: git worktree add 이 실패했어요');
    expect(s.tasks.list().map((t) => t.id)).toEqual(['T-1']);
    expect(s.calls).toEqual([]);
    expect(s.sent).toEqual([]);
  });

  it('from a remote device every worktreeNew needs a fresh step-up (and this PC or a fresh one goes through)', async () => {
    const s = seatRig();
    let reached = 0;
    const repos: RepoManager = new RepoManager({
      projects: () => [{ name: 'alpha', folder: s.r.folder }],
      readOnly: false,
      configDir: s.cfg,
      run: s.rec.run,
      pollMs: 60_000,
      log: () => undefined,
      taskWorktree: () => {
        reached++;
        return Promise.resolve({ ok: true });
      },
    });
    cleanup.push(() => repos.dispose());
    const req = { type: 'repoAction' as const, requestId: 'q', action: 'worktreeNew' as const, project: 'alpha', title: 'x', branch: 'feat/x', seat: true };
    expect(await repos.runAction(req, true, 'gui:phone', { remote: true, fresh: () => false })).toMatchObject({ ok: false, error: 'stepup' });
    expect(reached).toBe(0);
    expect(await repos.runAction(req, true, 'gui:phone', { remote: true, fresh: () => true })).toMatchObject({ ok: true });
    expect(await repos.runAction(req, true, 'gui:web', { remote: false, fresh: () => false })).toMatchObject({ ok: true });
    expect(reached).toBe(2);
  });
});
