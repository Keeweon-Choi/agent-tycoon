import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RepoDiff, RepoState, RepoWorktreeDetail } from '../../../../../core/src/messages.js';
import { waitFor } from '../../waitKit.js';
import { GUARD_LOG } from './guardHook.js';
import { RepoManager } from './repoManager.js';
import type { TempRepo } from './testRepo.js';
import { GIT_AVAILABLE, makeTempRepo } from './testRepo.js';

vi.setConfig({ testTimeout: 60_000 });

const repos: TempRepo[] = [];
const managers: RepoManager[] = [];
afterEach(() => {
  for (const m of managers.splice(0)) m.dispose();
  for (const r of repos.splice(0)) r.cleanup();
});

type Msg = Record<string, unknown>;

function setup() {
  const r = makeTempRepo();
  repos.push(r);
  const configDir = path.join(r.root, 'config');
  const proj = { name: 'alpha', folder: r.folder };
  const manager = () => {
    const mgr = new RepoManager({ projects: () => [proj], readOnly: false, configDir, run: r.run, log: () => undefined });
    managers.push(mgr);
    return mgr;
  };
  const mgr = manager();
  const sent: Msg[] = [];
  let n = 0;
  const ask = async <T>(msg: Msg): Promise<T> => {
    const requestId = `q${++n}`;
    mgr.onClientMessage({ requestId, ...msg }, (m) => void sent.push(m), true);
    await waitFor(() => expect(sent.find((m) => m.requestId === requestId)).toBeTruthy());
    return sent.find((m) => m.requestId === requestId) as T;
  };
  const task = async (id: string, base = 'main') => {
    const wt = await mgr.worktrees.createForTask(proj, { taskId: id, slug: 'x', base, createdBy: 'user' });
    return wt;
  };
  return { r, mgr, manager, configDir, proj, sent, ask, task };
}

describe.skipIf(!GIT_AVAILABLE)('W4 per-worktree changes, commits, diffs', () => {
  it('two worktrees show their own changes, commits and diffs', async () => {
    const { r, ask, task } = setup();
    const a = await task('T-1');
    const b = await task('T-2');
    // T-1: a committed edit, a committed new file, an uncommitted edit, an untracked file.
    fs.writeFileSync(path.join(a.path, 'a.txt'), 'one\nA changed\n');
    fs.writeFileSync(path.join(a.path, 'new.txt'), 'new\n');
    r.git(['add', '-A'], a.path);
    r.git(['commit', '-qm', 'agent a: edit and add'], a.path);
    fs.writeFileSync(path.join(a.path, 'sub/b.txt'), 'b\nuncommitted\n');
    fs.writeFileSync(path.join(a.path, 'untracked.txt'), 'u\n');
    // T-2: a different file.
    fs.writeFileSync(path.join(b.path, 'other.txt'), 'x\n');
    r.git(['add', '-A'], b.path);
    r.git(['commit', '-qm', 'agent b: other'], b.path);

    const da = await ask<RepoWorktreeDetail>({ type: 'repoWorktreeRequest', project: 'alpha', task: a.task });
    expect(da.ok).toBe(true);
    expect(da.files).toEqual([
      { path: 'a.txt', status: 'M' },
      { path: 'new.txt', status: 'A' },
      { path: 'sub/b.txt', status: 'M' },
      { path: 'untracked.txt', status: '?' },
    ]);
    expect(da.commits).toHaveLength(1);
    expect(da.commits![0]).toMatchObject({ subject: 'agent a: edit and add', author: 'Test' });
    expect(da.guard).toContain('가드');

    const db = await ask<RepoWorktreeDetail>({ type: 'repoWorktreeRequest', project: 'alpha', task: b.task });
    expect(db.files).toEqual([{ path: 'other.txt', status: 'A' }]);
    expect(db.commits!.map((c) => c.subject)).toEqual(['agent b: other']);

    const diff = (task: string, p: string) =>
      ask<RepoDiff>({ type: 'repoDiffRequest', project: 'alpha', task, path: p, staged: false });
    expect((await diff(a.task, 'a.txt')).text).toContain('+A changed');
    expect((await diff(a.task, 'sub/b.txt')).text).toContain('+uncommitted'); // committed + uncommitted together
    expect((await diff(a.task, 'untracked.txt')).text).toContain('+u');
    // Not that worktree's file, not a file at all: refused, nothing read.
    expect(await diff(b.task, 'a.txt')).toMatchObject({ ok: false });
    expect(await diff(a.task, '../../etc/passwd')).toMatchObject({ ok: false });
    expect(await ask<RepoWorktreeDetail>({ type: 'repoWorktreeRequest', project: 'alpha', task: 'nope' })).toMatchObject({ ok: false });
  });

  it('a large diff is cut into pages with a note', async () => {
    const { r, ask, task } = setup();
    const a = await task('T-1');
    fs.writeFileSync(path.join(a.path, 'big.txt'), 'line of text\n'.repeat(40_000)); // ~520 KB
    r.git(['add', '-A'], a.path);
    r.git(['commit', '-qm', 'big'], a.path);
    const d = await ask<RepoDiff>({ type: 'repoDiffRequest', project: 'alpha', task: a.task, path: 'big.txt', staged: false });
    expect(d.ok).toBe(true);
    expect(d.nextOffset).toBeGreaterThan(0);
    expect(d.text!.length).toBeLessThan(210 * 1024);
  });

  it('the merge history survives a restart (and carries the worktree it was)', async () => {
    const { r, mgr, manager, proj, task, configDir } = setup();
    r.git(['branch', 'dev']);
    const a = await mgr.worktrees.createForTask(proj, { taskId: 'T-1', slug: 'x', base: 'dev', createdBy: 'user' });
    fs.writeFileSync(path.join(a.path, 'f.txt'), 'f\n');
    r.git(['add', '-A'], a.path);
    r.git(['commit', '-qm', 'f'], a.path);
    expect(await mgr.merge('alpha', a.task, { privileged: true, source: 'test' })).toMatchObject({ ok: true });
    expect(await mgr.merge('alpha', a.task, { privileged: true, source: 'test', auto: true })).toMatchObject({ ok: true });
    void task;

    const again = manager(); // a new daemon over the same config folder
    const sent: Msg[] = [];
    again.onClientMessage({ type: 'repoView', project: 'alpha', on: true }, (m) => void sent.push(m), true);
    await waitFor(() => expect(sent.find((m) => m.type === 'repoState')).toBeTruthy());
    const st = sent.find((m) => m.type === 'repoState') as unknown as RepoState;
    expect(st.merges).toHaveLength(2);
    expect(st.merges![0]).toMatchObject({ ok: true, task: a.task, branch: a.branch, target: 'dev', auto: true, kind: 'already' });
    expect(st.merges![1]).toMatchObject({ ok: true, kind: 'ff', auto: false });
    expect(st.worktrees![0].merge).toMatchObject({ kind: 'already' });
    expect(fs.statSync(path.join(configDir, 'merge-history.json')).mode & 0o777).toBe(0o600);
  });

  it('the history is bounded per project', async () => {
    const { MergeHistory } = await import('./mergeHistory.js');
    const dir = fs.mkdtempSync(path.join(setup().r.root, 'h-'));
    const h = new MergeHistory(path.join(dir, 'h.json'));
    for (let i = 0; i < 60; i++) h.add('p', { at: `t${i}`, target: 'main', auto: false, ok: true });
    expect(h.list('p')).toHaveLength(50);
    expect(h.list('p')[0].at).toBe('t59');
    fs.writeFileSync(path.join(dir, 'bad.json'), '{{');
    expect(new MergeHistory(path.join(dir, 'bad.json')).list('p')).toEqual([]);
  });
});

describe.skipIf(!GIT_AVAILABLE)('W5 protected-branch guard hook', () => {
  const commitIn = (r: TempRepo, cwd: string, file: string) => {
    fs.writeFileSync(path.join(cwd, file), `${file}\n`);
    r.git(['add', file], cwd);
    r.git(['commit', '-qm', file], cwd);
  };

  it('refuses a commit on a protected branch in a task worktree, allows the task branch, records it', async () => {
    const { r, task, configDir } = setup();
    const a = await task('T-1');
    commitIn(r, a.path, 'ok.txt'); // task/T-1-x: allowed
    r.git(['switch', '-q', '-c', 'master'], a.path);
    expect(() => commitIn(r, a.path, 'bad.txt')).toThrow(/protected branch.*not a security boundary/s);
    expect(r.git(['log', '--format=%s', '-1'], a.path).trim()).toBe('ok.txt');
    const log = fs.readFileSync(path.join(configDir, GUARD_LOG), 'utf-8').trim().split('\n');
    expect(log).toHaveLength(1);
    expect(log[0].split('\t').slice(1, 3)).toEqual(['pre-commit', 'master']);
    // The owner's own checkout is not guarded.
    commitIn(r, r.folder, 'mine.txt');
    expect(r.git(['log', '--format=%s', '-1', 'main']).trim()).toBe('mine.txt');
  });

  it('refuses a push to a protected branch, allows a task branch, and the owner list counts', async () => {
    const { r, task, configDir } = setup();
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'protected-branches.json'), JSON.stringify({ alpha: ['release'] }));
    const a = await task('T-1');
    commitIn(r, a.path, 'f.txt');
    expect(() => r.git(['push', '-q', 'origin', 'HEAD:main'], a.path)).toThrow(/protected branch/);
    expect(() => r.git(['push', '-q', 'origin', 'HEAD:release'], a.path)).toThrow(/protected branch/);
    expect(() => r.git(['push', '-q', 'origin', '--delete', 'main'], a.path)).toThrow(/protected branch/);
    r.git(['push', '-q', 'origin', 'HEAD:refs/heads/task/mine'], a.path);
    expect(r.git(['ls-remote', '--heads', 'origin', 'task/mine'])).toContain('refs/heads/task/mine');
    expect(fs.readFileSync(path.join(configDir, GUARD_LOG), 'utf-8').trim().split('\n')).toHaveLength(3);
    r.git(['switch', '-q', '-c', 'release'], a.path);
    expect(() => commitIn(r, a.path, 'g.txt')).toThrow(/protected branch/);
  });

  it('never overwrites a hook of the user; the other one is still installed, and the note says so', async () => {
    const { r, task, ask } = setup();
    const hooks = path.join(r.folder, '.git', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    const mine = '#!/bin/sh\n# my own hook\nexit 0\n';
    fs.writeFileSync(path.join(hooks, 'pre-commit'), mine, { mode: 0o755 });
    const a = await task('T-1');
    expect(fs.readFileSync(path.join(hooks, 'pre-commit'), 'utf-8')).toBe(mine);
    expect(fs.readFileSync(path.join(hooks, 'pre-push'), 'utf-8')).toContain('cld-gui-guard');
    r.git(['switch', '-q', '-c', 'master'], a.path);
    commitIn(r, a.path, 'allowed.txt'); // the user's hook rules there, not ours
    const d = await ask<RepoWorktreeDetail>({ type: 'repoWorktreeRequest', project: 'alpha', task: a.task });
    expect(d.guard).toContain('pre-commit');
    expect(d.guard).toContain('건드리지 않았어요');
    // A second worktree rewrites only ours.
    await task('T-2');
    expect(fs.readFileSync(path.join(hooks, 'pre-commit'), 'utf-8')).toBe(mine);
  });

  it('installs nothing when the repository sets its own hooksPath', async () => {
    const { r, task, ask } = setup();
    r.git(['config', 'core.hooksPath', '.husky']);
    const a = await task('T-1');
    expect(fs.existsSync(path.join(r.folder, '.git', 'hooks', 'pre-push'))).toBe(false);
    expect(fs.existsSync(path.join(r.folder, '.husky'))).toBe(false);
    const d = await ask<RepoWorktreeDetail>({ type: 'repoWorktreeRequest', project: 'alpha', task: a.task });
    expect(d.guard).toContain('hooksPath');
  });
});
