// D5 step 4: the Codex provider over a fake CodexTasks (in memory, nothing spawned): design
// §2.2's thread and folder table row by row, one run per message, stop, ready and the Execution.
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import type { CodexRecord, WorkerRun } from '../../codex.js';
import type { ProjectRecord } from '../../registry.js';
import type { CodexRuns } from './codex.js';
import { CODEX_MISSING, CodexAgent } from './codex.js';

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.reverse()) c();
  cleanup = [];
});

type RunReq = Parameters<CodexRuns['run']>[0];

function rig(o: { git?: boolean; codexOnPath?: boolean; recorded?: Record<string, string>; notMine?: Set<string> } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-codexagent-'));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'alpha');
  const own = path.join(project, '.worktrees', 'w1');
  fs.mkdirSync(own, { recursive: true });
  if (o.git !== false) spawnSync('git', ['init', '-q', project]);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  if (o.codexOnPath !== false) fs.writeFileSync(path.join(bin, 'codex'), '', { mode: 0o755 });
  const records: CodexRecord[] = [];
  const asked: RunReq[] = [];
  const attached: Array<[string, string, string]> = [];
  const stopped: string[] = [];
  const asks: Array<[string, string, string]> = [];
  let n = 0;
  const codex: CodexRuns = {
    // As the real one: the record is written only after an await (a worktree is made first).
    run: async (req) => {
      await new Promise((r) => setTimeout(r, 10));
      asked.push(req);
      const w = req.worker as WorkerRun;
      const id = `1024-1200${String(++n).padStart(2, '0')}-alpha`;
      records.push({
        id,
        project: req.project,
        model: req.model,
        state: 'running',
        dir: req.worktree ? path.join(project, '.worktrees', `task-${n}`) : req.cwd,
        worktree: req.worktree ? path.join(project, '.worktrees', `task-${n}`) : w.ownWorktree ? req.cwd : null,
        branch: null,
        base: null,
        spec: '',
        started: '2026-10-24T12:00:00+09:00',
        ended: null,
        exit: null,
        resetAt: null,
        sid: w.resume ?? `thread-${n}`,
        commits: null,
        jobId: `job-${id}`,
        log: `/log/${id}`,
        pid: 5000 + n,
        source: 'engine',
        agent: w.name,
        assignmentId: w.assignmentId,
        ...(w.task && { task: w.task }),
        ...(w.messageId && { messageId: w.messageId }),
      });
      return { ok: true, id, log: `/log/${id}` };
    },
    runsOf: (a) => records.filter((r) => r.assignmentId === a),
    workerRecords: () => records,
    jobOf: (id) => records.find((r) => r.id === id)?.jobId ?? null,
  };
  const agent = new CodexAgent({
    codex: () => codex,
    path: () => bin,
    project: () => ({ name: 'alpha', folder: project }),
    attach: (task, run, by) => attached.push([task, `codex:${run.ref}`, by]),
    taskTitle: (t) => (t === 'T-1' ? '로그인 고치기' : undefined),
    ...(o.recorded && {
      taskWorktree: (proj: { name: string }, task: string, assignmentId: string) => {
        asks.push([proj.name, task, assignmentId]);
        const at = o.recorded![task];
        return at ? { path: at, branch: `task/${path.basename(at)}` } : null;
      },
    }),
    ...(o.notMine && { mayUse: (_p: unknown, dir: string) => !o.notMine!.has(dir) }),
    stopJob: (job) => (stopped.push(job), { ok: true }),
    log: () => undefined,
  });
  const worker = (over: Partial<ProjectRecord> = {}): ProjectRecord => ({
    projectId: 'p_aaaaaaaaaa',
    assignmentId: 'a_wwwwwwwwww',
    role: 'worker',
    name: 'w1',
    folder: project,
    provider: 'codex',
    wantRunning: true,
    ...over,
  });
  const end = () => records.forEach((r) => (r.state = 'done'));
  return { project, own, agent, records, asked, attached, stopped, worker, end, asks };
}

describe('the Codex provider', () => {
  it('a new Task, the Worker has its own folder: a new thread there (its worktree), the Task attached', async () => {
    const r = rig();
    const p = r.worker({ folder: r.own, workFolder: r.own, model: 'model-a', effort: 'high' });
    expect(await r.agent.deliver(p, '[h]\n일', { task: 'T-1', messageId: 'aaaaaaaa' })).toBe('typed');
    expect(r.asked[0]).toMatchObject({
      model: 'model-a',
      effort: 'high',
      worktree: false,
      cwd: r.own,
      project: 'alpha',
      worker: { name: 'w1', assignmentId: 'a_wwwwwwwwww', prompt: '[h]\n일', task: 'T-1', title: 'T-1 로그인 고치기', ownWorktree: true },
    });
    expect(r.asked[0].worker).not.toHaveProperty('resume');
    expect(r.attached).toEqual([['T-1', `codex:${r.records[0].id}`, 'w1']]);
  });

  it('a new Task, no folder of its own: a new task worktree of the project (git), else the project folder', async () => {
    const git = rig();
    expect(await git.agent.deliver(git.worker(), 'x', { task: 'T-1' })).toBe('typed');
    expect(git.asked[0]).toMatchObject({ worktree: true, cwd: git.project, project: 'alpha' });
    const plain = rig({ git: false });
    expect(await plain.agent.deliver(plain.worker(), 'x', { task: 'T-1' })).toBe('typed');
    expect(plain.asked[0]).toMatchObject({ worktree: false, cwd: plain.project });
    expect(plain.asked[0].worker).not.toHaveProperty('ownWorktree');
  });

  it('the same Task, or no Task (send_message, a room, the inbox): the last thread in its folder, its Task inherited', async () => {
    const r = rig();
    await r.agent.deliver(r.worker(), 'first', { task: 'T-1' });
    const first = r.records[0];
    r.end();
    expect(await r.agent.deliver(r.worker(), 'same task', { task: 'T-1' })).toBe('typed');
    expect(r.asked[1]).toMatchObject({ worktree: false, cwd: first.dir, worker: { resume: first.sid, task: 'T-1', ownWorktree: true } });
    r.end();
    expect(await r.agent.deliver(r.worker(), 'no task', { group: { id: 'g1', messageId: 'p1' } })).toBe('typed');
    expect(r.asked[2]).toMatchObject({ cwd: first.dir, worker: { resume: first.sid, task: 'T-1', room: { id: 'g1', messageId: 'p1' } } });
    expect(r.attached.map((a) => a[0])).toEqual(['T-1', 'T-1', 'T-1']);
    r.end();
    // Another Task: a new thread again.
    expect(await r.agent.deliver(r.worker(), 'next', { task: 'T-2' })).toBe('typed');
    expect(r.asked[3].worker).not.toHaveProperty('resume');
    expect(r.asked[3]).toMatchObject({ worktree: true, worker: { task: 'T-2' } });
  });

  it('W2: a new Task with a recorded worktree runs there (before the Worker’s own folder), commits counted', async () => {
    const r0 = rig();
    const wt = path.join(r0.project, '.worktrees', 't-1-login');
    const r = rig({ recorded: { 'T-1': wt } });
    const p = r.worker({ folder: r.own, workFolder: r.own });
    expect(await r.agent.deliver(p, 'x', { task: 'T-1' })).toBe('typed');
    expect(r.asks).toEqual([['alpha', 'T-1', 'a_wwwwwwwwww']]);
    expect(r.asked[0]).toMatchObject({ worktree: false, cwd: wt, worker: { task: 'T-1', ownWorktree: true, branch: 'task/t-1-login' } });
    r.end();
    // Another Task without one: as before (its own folder); a follow-up is not asked again.
    expect(await r.agent.deliver(p, 'y', { task: 'T-2' })).toBe('typed');
    expect(r.asked[1]).toMatchObject({ cwd: r.own, worktree: false });
    r.end();
    await r.agent.deliver(p, 'z', {});
    expect(r.asks.map((a) => a[1])).toEqual(['T-1', 'T-2']);
  });

  it('N5: the last run’s worktree given to another agent while it rested: a new thread elsewhere, still for that Task, not recorded as the Task’s', async () => {
    const notMine = new Set<string>();
    const r = rig({ notMine });
    await r.agent.deliver(r.worker(), 'first', { task: 'T-1' });
    const first = r.records[0];
    r.end();
    notMine.add(first.dir);
    expect(await r.agent.deliver(r.worker(), 'follow-up', {})).toBe('typed');
    expect(r.asked[1].worker).not.toHaveProperty('resume');
    expect(r.asked[1]).toMatchObject({ worktree: true, cwd: r.project, worker: { task: 'T-1', taskWorktree: false } });
    expect(r.attached.map((a) => a[0])).toEqual(['T-1', 'T-1']);
  });

  it('no run yet and no Task: a new thread in its folder or the project folder, no worktree made', async () => {
    const r = rig();
    expect(await r.agent.deliver(r.worker(), 'hi', {})).toBe('typed');
    expect(r.asked[0]).toMatchObject({ worktree: false, cwd: r.project });
    expect(r.asked[0].worker).not.toHaveProperty('task');
    const o = rig();
    await o.agent.deliver(o.worker({ folder: o.own, workFolder: o.own }), 'hi', {});
    expect(o.asked[0]).toMatchObject({ worktree: false, cwd: o.own, worker: { ownWorktree: true } });
    expect(r.attached).toEqual([]);
  });

  it('one run at a time: notReady while one runs or starts; a message already run is not run twice', async () => {
    const r = rig();
    const [a, b] = await Promise.all([
      r.agent.deliver(r.worker(), 'a', { messageId: 'aaaaaaaa', task: 'T-1' }),
      r.agent.deliver(r.worker(), 'b', { messageId: 'bbbbbbbb' }),
    ]);
    expect([a, b]).toEqual(['typed', 'notReady']);
    expect(await r.agent.deliver(r.worker(), 'b', { messageId: 'bbbbbbbb' })).toBe('notReady');
    r.end();
    // The same message again (the daemon died before its queue file went): typed, no new run.
    expect(await r.agent.deliver(r.worker(), 'a', { messageId: 'aaaaaaaa' })).toBe('typed');
    expect(r.asked).toHaveLength(1);
    expect(r.attached).toHaveLength(2); // attached again (the same id: the store keeps one)
  });

  it('live: its running run as a busy background session by assignment; stop: a resting one at once, a run’s job', async () => {
    const r = rig();
    expect(r.agent.live()).toEqual([]);
    await r.agent.deliver(r.worker(), 'x', {});
    const [s] = r.agent.live();
    expect(s).toMatchObject({ id: r.records[0].id, pid: 5001, kind: 'background', status: 'busy', assignmentId: 'a_wwwwwwwwww', name: 'w1', sessionId: 'thread-1' });
    expect(await r.agent.stop(s)).toEqual({ ok: true });
    expect(r.stopped).toEqual([`job-${r.records[0].id}`]);
    expect(await r.agent.stop({ ...s, id: 'rest:a_wwwwwwwwww', resting: true })).toEqual({ ok: true });
    expect(r.stopped).toHaveLength(1);
    r.end();
    expect(r.agent.live()).toEqual([]);
    expect(r.agent.nameMatches()).toBe(false);
    expect(r.agent.transcript()).toBe('');
  });

  it('codex not on PATH: ready() says why and a message fails (the messenger tries again later)', async () => {
    const r = rig({ codexOnPath: false });
    expect(r.agent.ready()).toBe(CODEX_MISSING);
    expect(await r.agent.deliver(r.worker(), 'x', {})).toBe('failed');
    expect(r.asked).toEqual([]);
    expect(rig().agent.ready()).toBeNull();
  });
});
