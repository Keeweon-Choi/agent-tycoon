/**
 * W2 in the office (the rules office.ts adds on top of taskWorktree.ts), with a temp repository,
 * the engine's fake claude and real starts:
 * - assignedFolder: a Claude Worker given a Task's worktree starts there; once the worktree is
 *   given to another agent or removed it starts in the project's folder again (never "폴더가
 *   없어요"); a folder the user gave it (not one of the daemon's worktrees) is left alone;
 * - codexTaskWorktree: a Codex Worker's run for a Task uses the recorded worktree only when it is
 *   its own or nobody's.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { readLiveSessions } from './engine/agents/claude/sessions.js';
import type { CodexTasksOptions } from './engine/codex.js';
import { codexDir } from './engine/codex.js';
import type { TempRepo } from './engine/git/testRepo.js';
import { GIT_AVAILABLE, makeTempRepo } from './engine/git/testRepo.js';
import { startEngineOffice } from './officeTestKit.js';

vi.setConfig({ testTimeout: 90_000 });
const WAIT = { timeout: 20_000, interval: 50 };

async function office() {
  const repo: TempRepo = makeTempRepo();
  const t = await startEngineOffice({ readOnly: false, chat: true });
  const got: Array<Record<string, unknown>> = [];
  const send = (m: Record<string, unknown>) => got.push(m);
  let n = 0;
  const ask = async (msg: Record<string, unknown>) => {
    const requestId = `r${++n}`;
    t.office.onClientMessage({ ...msg, requestId }, send, true);
    return vi.waitFor(() => {
      const r = got.find((m) => m.requestId === requestId && String(m.type).endsWith('Result'));
      expect(r).toBeDefined();
      return r!;
    }, WAIT);
  };
  const engine = (action: string, name: string, fields: Record<string, unknown> = {}) =>
    ask({ type: 'engineAction', action, name, ...fields });
  const folder = repo.folder;
  expect(await engine('add', 'alpha', { folder, room: 'lab' })).toMatchObject({ ok: true });
  for (const name of ['alpha-a', 'alpha-b'])
    expect(await engine('add', name, { role: 'worker', project: 'alpha' })).toMatchObject({ ok: true });
  const own = path.join(folder, '.worktrees', 'by-hand');
  fs.mkdirSync(own, { recursive: true });
  expect(await engine('add', 'alpha-c', { role: 'worker', project: 'alpha', folder: own })).toMatchObject({ ok: true });
  const id = (name: string) => t.office.engine!.roster().find((a) => a.name === name)!.assignmentId!;
  const cwd = (name: string) =>
    readLiveSessions(t.home).find((s) => s.kind === 'background' && s.name === name)?.cwd;
  const restart = async (name: string) => {
    await engine('stop', name);
    expect(await engine('start', name)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(cwd(name)).toBeDefined(), WAIT);
    return cwd(name);
  };
  const worktree = (taskId: string, assignee?: string) =>
    ask({ type: 'repoAction', action: 'worktreeNew', project: 'alpha', taskId, ...(assignee && { assignee }) });
  const task = (title: string) => (t.office.tasks.add({ project: 'alpha', title }, 'cli').task as { id: string }).id;
  return { t, repo, folder, own, engine, id, cwd, restart, worktree, task, ask, cleanup: () => repo.cleanup() };
}

describe.skipIf(!GIT_AVAILABLE)('W2 in the office', () => {
  it('assignedFolder: the given worktree, then the project folder once it is another’s or removed; a hand-given folder stays', async () => {
    const o = await office();
    try {
      const t1 = o.task('Login page');
      expect(await o.worktree(t1, 'alpha-a')).toMatchObject({ ok: true });
      const wt = path.join(o.folder, '.worktrees', 't-1-login-page');
      expect(await o.restart('alpha-a')).toBe(wt);
      // Given to alpha-b (alpha-a stopped): alpha-a goes back to the project's folder, alpha-b starts there.
      await o.engine('stop', 'alpha-a');
      await o.t.office.repos.worktrees.assign({ name: 'alpha', folder: o.folder }, 't-1-login-page', o.id('alpha-b'));
      expect(await o.restart('alpha-a')).toBe(o.folder);
      expect(await o.restart('alpha-b')).toBe(wt);
      // Removed: alpha-b starts again, in the project's folder (not "폴더가 없어요").
      await o.engine('stop', 'alpha-b');
      expect(await o.ask({ type: 'repoAction', action: 'worktreeRemove', project: 'alpha', task: 't-1-login-page', force: true })).toMatchObject({ ok: true });
      expect(await o.restart('alpha-b')).toBe(o.folder);
      // A folder the user gave (not a worktree of the daemon's): never moved.
      expect(await o.restart('alpha-c')).toBe(o.own);
    } finally {
      o.cleanup();
    }
  });

  it('codexTaskWorktree: the Task’s worktree for its own Worker or when nobody has it, never another’s', async () => {
    const o = await office();
    try {
      const project = { name: 'alpha', folder: o.folder };
      const t1 = o.task('Api');
      expect(o.t.office.codexTaskWorktree(project, t1, o.id('alpha-a'))).toBeNull(); // none yet
      expect(await o.worktree(t1, 'alpha-a')).toMatchObject({ ok: true });
      const wt = path.join(o.folder, '.worktrees', 't-1-api');
      expect(o.t.office.codexTaskWorktree(project, t1, o.id('alpha-a'))).toEqual({ path: wt, branch: 'task/t-1-api' });
      expect(o.t.office.codexTaskWorktree(project, t1, o.id('alpha-b'))).toBeNull();
      await o.t.office.repos.worktrees.assign(project, 't-1-api', null);
      expect(o.t.office.codexTaskWorktree(project, t1, o.id('alpha-b'))).toEqual({ path: wt, branch: 'task/t-1-api' });
      // Its folder gone by hand: not offered.
      fs.rmSync(wt, { recursive: true, force: true });
      expect(o.t.office.codexTaskWorktree(project, t1, o.id('alpha-b'))).toBeNull();
    } finally {
      o.cleanup();
    }
  });

  it('D5’s Codex task worktree goes through the repository write gate (fix 5): refused while another write runs', async () => {
    const o = await office();
    try {
      const make = (o.t.office.codex as unknown as { o: CodexTasksOptions }).o.worktree;
      let release!: () => void;
      const held = o.t.office.repos.write('alpha', true, 'cli', 'commit', () => new Promise<{ ok: boolean }>((res) => (release = () => res({ ok: true }))));
      await expect(make({ name: 'alpha', folder: o.folder }, 'codex-1024-120000')).rejects.toThrow('이미 다른 조작이 진행 중이에요');
      expect(fs.existsSync(path.join(o.folder, '.worktrees', 'codex-1024-120000'))).toBe(false);
      release();
      await held;
      const made = await make({ name: 'alpha', folder: o.folder }, 'codex-1024-120000', { taskId: 'T-9', assignmentId: o.id('alpha-a'), createdBy: 'agent:alpha-a' });
      expect(made.path).toBe(path.join(o.folder, '.worktrees', 'codex-1024-120000'));
      expect(o.t.office.repos.worktrees.forTask('alpha', 'T-9')).toMatchObject({ assignmentId: o.id('alpha-a'), createdBy: 'agent:alpha-a' });
    } finally {
      o.cleanup();
    }
  });

  it('N5/N6: who holds a Task’s worktree; a Codex Worker’s last folder stays its own only while it is', async () => {
    const o = await office();
    try {
      const project = { name: 'alpha', folder: o.folder };
      const agent = (name: string, over: Record<string, unknown> = {}) => ({ ...o.t.office.engine!.roster().find((a) => a.name === name)!, ...over });
      // A resting Codex Worker whose last run (which a follow-up continues) is the Task's.
      const dir = codexDir(o.t.home);
      fs.mkdirSync(dir, { recursive: true });
      const run = (id: string, task: string, started: string) => ({ id, project: 'alpha', model: null, state: 'done', dir: o.folder, worktree: null, branch: null, base: null, spec: '', started, ended: started, exit: 0, resetAt: null, sid: 's', commits: null, jobId: id, log: '/l', pid: null, source: 'engine', agent: 'alpha-b', assignmentId: o.id('alpha-b'), task });
      fs.writeFileSync(path.join(dir, '1024-100000-alpha.json'), JSON.stringify(run('1024-100000-alpha', 'T-7', '2026-10-24T10:00:00+09:00')));
      const codexB = agent('alpha-b', { provider: 'codex', live: false, wantRunning: true });
      // (the Codex records are re-read when their folder changes)
      await vi.waitFor(() => expect(o.t.office.holdsWorktree(codexB, 'T-7')).toBe(true), WAIT);
      expect(o.t.office.holdsWorktree({ ...codexB, wantRunning: false }, 'T-7')).toBe(false);
      expect(o.t.office.holdsWorktree(codexB, 'T-8')).toBe(false);
      expect(o.t.office.holdsWorktree(agent('alpha-a', { live: false, wantRunning: true }), 'T-7')).toBe(true); // Claude on, down
      expect(o.t.office.holdsWorktree(agent('alpha-a', { live: false, wantRunning: false }), 'T-7')).toBe(false);
      expect(o.t.office.holdsWorktree(agent('alpha', { live: true }), 'T-7')).toBe(false); // the Lead: recorded only
      // codexMayUse: its own worktree yes; once another's, or removed, no; a folder that is no worktree of ours, yes.
      const t1 = o.task('Api');
      expect(await o.worktree(t1, 'alpha-b')).toMatchObject({ ok: true });
      const wt = path.join(o.folder, '.worktrees', 't-1-api');
      expect(o.t.office.codexMayUse(project, wt, o.id('alpha-b'))).toBe(true);
      await o.t.office.repos.worktrees.assign(project, 't-1-api', o.id('alpha-a'));
      expect(o.t.office.codexMayUse(project, wt, o.id('alpha-b'))).toBe(false);
      await o.t.office.repos.worktrees.assign(project, 't-1-api', null);
      expect(o.t.office.codexMayUse(project, wt, o.id('alpha-b'))).toBe(true);
      expect(await o.ask({ type: 'repoAction', action: 'worktreeRemove', project: 'alpha', task: 't-1-api', force: true })).toMatchObject({ ok: true });
      expect(o.t.office.codexMayUse(project, wt, o.id('alpha-b'))).toBe(false);
      expect(o.t.office.codexMayUse(project, o.folder, o.id('alpha-b'))).toBe(true);
    } finally {
      o.cleanup();
    }
  });
});
