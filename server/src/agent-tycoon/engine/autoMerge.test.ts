/**
 * W3 auto-merge, end to end below the office: a Task the store sees done for the first time
 * (TaskStore) has its worktree branch merged into its base (mergeNewlyDone → RepoManager.merge
 * with `auto`) in a real git repository. Tech debt #2 and the owner's 11-01 02:17 decision
 * (a Task with review notes waits for the owner's 머지), plus SEC-CONTROL (a caller without a
 * token cannot mark a Task done, so it cannot start a merge).
 */
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ControlDeps } from './control.js';
import { answerControl } from './control.js';
import { MergeHistory } from './git/mergeHistory.js';
import { RepoManager } from './git/repoManager.js';
import type { TempRepo } from './git/testRepo.js';
import { GIT_AVAILABLE, makeTempRepo } from './git/testRepo.js';
import { answerTask, TaskStore } from './tasks.js';
import { mergeNewlyDone } from './taskWorktree.js';

vi.setConfig({ testTimeout: 60_000 });

const repos: TempRepo[] = [];
const managers: RepoManager[] = [];
afterEach(() => {
  for (const m of managers.splice(0)) m.dispose();
  for (const r of repos.splice(0)) r.cleanup();
});

/** Project `alpha` (base branches main, protected, and dev), a task store, a worktree per Task. */
function setup() {
  const r = makeTempRepo();
  repos.push(r);
  r.git(['branch', 'dev']);
  const configDir = path.join(r.root, 'config');
  const proj = { name: 'alpha', folder: r.folder };
  const mgr = new RepoManager({ projects: () => [proj], readOnly: false, configDir, run: r.run, log: () => undefined });
  managers.push(mgr);
  const tasks = new TaskStore(path.join(configDir, 'tasks.json'), () => undefined, () => undefined);
  let seen: Set<string> | null = new Set();
  /** What the office does on each store change. */
  const tick = async () => {
    const out = mergeNewlyDone(tasks, mgr, seen);
    seen = out.seen;
    return Promise.all(out.merges);
  };
  /** Task `id` with a worktree on `base` and one commit writing `file`. */
  const task = async (id: string, base: string, file = `${id}.txt`, content = `${id}\n`) => {
    expect(tasks.add({ id, title: id, project: 'alpha', status: 'doing' }, 'test')).toMatchObject({ ok: true });
    const wt = await mgr.worktrees.createForTask(proj, { taskId: id, slug: 'x', base, createdBy: 'user' });
    fs.writeFileSync(path.join(wt.path, file), content);
    r.git(['add', file], wt.path);
    r.git(['commit', '-qm', id], wt.path);
    return wt;
  };
  const done = (id: string) => expect(tasks.update(id, { status: 'done' }, 'test')).toMatchObject({ ok: true });
  const files = (branch: string) => r.git(['ls-tree', '--name-only', branch]).split('\n');
  return { r, mgr, configDir, tasks, tick, task, done, files };
}

describe.skipIf(!GIT_AVAILABLE)('W3 auto-merge when a Task goes done', () => {
  it('an unprotected base is merged once; a protected base is refused and left as it was', async () => {
    const { r, tick, task, done, files } = setup();
    await task('T-1', 'dev');
    await task('T-2', 'main');
    expect(await tick()).toEqual([]); // nothing done yet
    done('T-1');
    expect(await tick()).toEqual([expect.objectContaining({ ok: true })]);
    expect(files('dev')).toContain('T-1.txt');
    expect(await tick()).toEqual([]); // seen: not merged again
    const main = r.git(['rev-parse', 'main']).trim();
    done('T-2');
    expect(await tick()).toEqual([expect.objectContaining({ ok: false, code: 'protected' })]);
    expect(r.git(['rev-parse', 'main']).trim()).toBe(main);
  });

  it('a conflict aborts, leaves the base as it was and is reported', async () => {
    const { r, configDir, tick, task, done } = setup();
    await task('T-1', 'dev', 'a.txt', 'task side\n');
    r.git(['switch', '-q', 'dev']);
    r.write('a.txt', 'dev side\n');
    r.git(['commit', '-qam', 'dev side']);
    r.git(['switch', '-q', 'main']);
    const dev = r.git(['rev-parse', 'dev']).trim();
    done('T-1');
    const [out] = await tick();
    expect(out).toMatchObject({ ok: false, code: 'conflict' });
    expect(out.error).toContain('a.txt');
    expect(r.git(['rev-parse', 'dev']).trim()).toBe(dev);
    expect(r.git(['status', '--porcelain'])).toBe('');
    // The 작업실's merge history says so (merge-history.json, what RepoManager reports).
    const history = new MergeHistory(path.join(configDir, 'merge-history.json'));
    expect(history.list('alpha')[0]).toMatchObject({ ok: false, code: 'conflict', auto: true });
  });

  it('a Task with review notes (sent or not) is not merged automatically; the owner’s click merges it', async () => {
    const { mgr, tick, task, done, files } = setup();
    const a = await task('T-1', 'dev');
    const b = await task('T-2', 'dev');
    mgr.reviewNotes.add('alpha', a.task, { file: 'T-1.txt', side: 'new', line: 1, body: 'rename this' }, 'owner', 'id1');
    const sent = mgr.reviewNotes.add('alpha', b.task, { file: 'T-2.txt', side: 'new', line: 1, body: 'ok?' }, 'owner', 'id2');
    mgr.reviewNotes.markSent('alpha', b.task, [sent]);
    expect(mgr.reviewNotes.list('alpha', b.task)[0].sentAt).toBeTruthy();
    done('T-1');
    done('T-2');
    const outs = await tick();
    expect(outs).toEqual([
      expect.objectContaining({ ok: false, code: 'review_notes' }),
      expect.objectContaining({ ok: false, code: 'review_notes' }),
    ]);
    expect(files('dev')).not.toContain('T-1.txt');
    expect(files('dev')).not.toContain('T-2.txt');
    // 머지 in the 작업실: not automatic, so the notes do not stop it.
    expect(await mgr.merge('alpha', a.task, { privileged: true, source: 'gui:web' })).toMatchObject({ ok: true });
    expect(files('dev')).toContain('T-1.txt');
  });

  it('SEC-CONTROL: a caller without a token cannot mark a Task done, so no merge starts; the owner and the Lead can', async () => {
    const { tasks, tick, task, files } = setup();
    await task('T-1', 'dev');
    await task('T-2', 'dev');
    const deps = {
      names: () => ['alpha'],
      projectAt: () => 'alpha',
      agentOf: (t: string) => (t === 'lead-token' ? 'alpha' : null),
      projectOf: (n: string) => n,
      isOwner: (c: string) => c === 'owner-token',
      task: (args: Record<string, unknown>, who: { by: string; project: string | null; agent: string | null }) =>
        answerTask(tasks, args, who),
    } as unknown as ControlDeps;
    const doneOver = (id: string, who: { token?: string; owner?: string }) =>
      answerControl({ cmd: 'task', cwd: '/w/alpha', source: 'cli', ...who, args: { op: 'done', id } }, deps);
    expect(await doneOver('T-1', {})).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await doneOver('T-1', { owner: 'a guess' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(tasks.list({ status: 'done' })).toEqual([]);
    expect(await tick()).toEqual([]);
    expect(files('dev')).not.toContain('T-1.txt');
    expect(await doneOver('T-1', { token: 'lead-token' })).toMatchObject({ ok: true });
    expect(await doneOver('T-2', { owner: 'owner-token' })).toMatchObject({ ok: true });
    expect(await tick()).toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })]);
    expect(files('dev')).toEqual(expect.arrayContaining(['T-1.txt', 'T-2.txt']));
  });
});
