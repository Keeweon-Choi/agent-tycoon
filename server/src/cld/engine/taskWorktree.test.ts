/**
 * W2: "a worktree for a Task" (taskWorktree.ts) over a temp repository, a real Task store and
 * a real RepoManager: what it makes and records, who it is given to, every refusal (nothing
 * made), the one-write-per-repository rule, and `cld-gui worktree new|list`'s answers.
 */
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RepoManager } from './git/repoManager.js';
import type { TempRepo } from './git/testRepo.js';
import { GIT_AVAILABLE, makeTempRepo, recording } from './git/testRepo.js';
import type { WorktreeRecord } from './git/worktrees.js';
import type { RosterAgent } from './mcpTools.js';
import { tasksPath, TaskStore } from './tasks.js';
import { answerWorktree, CLAIM_MS, worktreeForTask } from './taskWorktree.js';

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
  it('makes task/<id>-<slug> in .worktrees/, records the Task and its assignee, and the Task says where', async () => {
    const { r, add, make, records, tasks } = rig();
    const t = add('Login page');
    const out = await make({ taskId: t.id, assignee: 'alpha-w1' });
    const at = path.join(r.folder, '.worktrees', 't-1-login-page');
    expect(out).toMatchObject({
      ok: true,
      project: 'alpha',
      taskId: 'T-1',
      task: 't-1-login-page',
      path: at,
      branch: 'task/t-1-login-page',
      base: 'main',
      assignee: 'alpha-w1',
      assignmentId: 'a_bbbbbbbbbb',
    });
    expect(out.detail).toBe(
      'task/t-1-login-page · .worktrees/t-1-login-page · alpha-w1 에게 배정했어요. 켜져 있는 세션은 옮기지 않고, 다음에 켤 때 이 worktree 에서 시작해요',
    );
    expect(records()).toEqual([
      expect.objectContaining({ project: 'alpha', task: 't-1-login-page', taskId: 'T-1', assignmentId: 'a_bbbbbbbbbb', createdBy: 'user', status: 'active' }),
    ]);
    const task = tasks.get('T-1')!;
    expect([task.branch, task.worktree]).toEqual(['task/t-1-login-page', at]);
    expect(task.history.at(-1)).toMatchObject({ by: 'gui:Phone', change: 'branch — → task/t-1-login-page, worktree' });
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
    expect(made).toMatchObject({ ok: true, taskId: 'T-1', branch: 'task/t-1-a', assignee: 'alpha-w1' });
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
    expect(all[0]).toMatchObject({ task: 't-1-a', branch: 'task/t-1-a', base: 'main', exists: true, ahead: 0, dirty: 0, merged: true });
    const one = (await answerWorktree(d, { op: 'list', task: 'T-3' }, owner)).worktrees as Array<Record<string, unknown>>;
    expect(one.map((w) => w.taskId)).toEqual(['T-3']);
    const lead = { by: 'alpha', agent: 'alpha', project: 'alpha' };
    const mine = (await answerWorktree(d, { op: 'list' }, lead)).worktrees as Array<Record<string, unknown>>;
    expect(mine.map((w) => w.project)).toEqual(['alpha', 'alpha']);
    expect(await answerWorktree(d, { op: 'list', task: 'T-2' }, lead)).toMatchObject({ ok: false, code: 'unknown_task' });
  });
});
