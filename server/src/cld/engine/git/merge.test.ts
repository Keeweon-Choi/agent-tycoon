import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mergeBranches } from './merge.js';
import { RepoManager } from './repoManager.js';
import type { TempRepo } from './testRepo.js';
import { GIT_AVAILABLE, makeTempRepo } from './testRepo.js';

vi.setConfig({ testTimeout: 60_000 });

const repos: TempRepo[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.cleanup();
});

/** A repo on main with branch `dev` and branch `feat` (one commit on a.txt). */
function setup(): TempRepo {
  const r = makeTempRepo();
  repos.push(r);
  r.git(['branch', 'dev']);
  r.git(['switch', '-q', '-c', 'feat']);
  r.write('a.txt', 'feat\n');
  r.git(['commit', '-qam', 'feat']);
  r.git(['switch', '-q', 'main']);
  return r;
}

/** Everything a merge could leave behind: refs, HEAD, the checkout, the worktrees and their admin. */
function snapshot(r: TempRepo): string {
  const admin = path.join(r.folder, '.git', 'worktrees');
  return JSON.stringify([
    r.git(['for-each-ref', '--format=%(refname) %(objectname)']),
    r.git(['rev-parse', 'HEAD']),
    r.git(['symbolic-ref', 'HEAD']),
    r.git(['status', '--porcelain=v2', '--branch', '--untracked-files=all', '--ignored']),
    r.git(['worktree', 'list', '--porcelain']),
    fs.existsSync(admin) ? fs.readdirSync(admin) : null,
    fs.readFileSync(path.join(r.folder, 'a.txt'), 'utf-8'),
    fs.readdirSync(r.folder),
  ]);
}

describe.skipIf(!GIT_AVAILABLE)('W3 mergeBranches', () => {
  it('fast-forwards when the target is behind (a branch nobody has checked out: update-ref)', async () => {
    const r = setup();
    const feat = r.git(['rev-parse', 'feat']).trim();
    expect(await mergeBranches(r.run, r.folder, 'feat', 'dev')).toEqual({ ok: true, kind: 'ff', sha: feat });
    expect(r.git(['rev-parse', 'dev']).trim()).toBe(feat);
    expect(await mergeBranches(r.run, r.folder, 'feat', 'dev')).toMatchObject({ ok: true, kind: 'already' });
  });

  it('a merge commit when both moved; the checked-out target follows in its checkout', async () => {
    const r = setup();
    r.write('c.txt', 'main\n');
    r.git(['add', 'c.txt']);
    r.git(['commit', '-qm', 'main side']);
    const old = r.git(['rev-parse', 'main']).trim();
    const out = await mergeBranches(r.run, r.folder, 'feat', 'main');
    expect(out).toMatchObject({ ok: true, kind: 'merge' });
    expect(r.git(['rev-parse', 'main']).trim()).toBe(out.sha);
    expect(r.git(['log', '-1', '--format=%P %s', 'main']).trim()).toBe(
      `${old} ${r.git(['rev-parse', 'feat']).trim()} Merge branch 'feat' into main`,
    );
    // The checkout has the merged content and is clean; no temporary worktree is left.
    expect(fs.readFileSync(path.join(r.folder, 'a.txt'), 'utf-8')).toBe('feat\n');
    expect(r.git(['status', '--porcelain'])).toBe('');
    expect(r.git(['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1);
  });

  it('a conflict stops with the files listed and the repository exactly as before', async () => {
    const r = setup();
    r.write('a.txt', 'main\n');
    r.write('untracked.txt', 'mine\n');
    r.git(['commit', '-qm', 'main side', '--', 'a.txt']);
    const before = snapshot(r);
    const out = await mergeBranches(r.run, r.folder, 'feat', 'main');
    expect(out).toMatchObject({ ok: false, code: 'conflict', conflicts: ['a.txt'] });
    expect(out.error).toContain('a.txt');
    expect(snapshot(r)).toBe(before);

    // Negative control: the snapshot does see what a plain conflicting merge leaves behind.
    expect(() => r.git(['merge', '-q', 'feat'])).toThrow();
    expect(snapshot(r)).not.toBe(before);
  });

  it('refuses a target behind its upstream, and a checkout of it with uncommitted changes', async () => {
    const r = setup();
    const other = r.cloneRemote('other');
    fs.writeFileSync(path.join(other, 'x.txt'), 'x\n');
    r.git(['add', 'x.txt'], other);
    r.git(['commit', '-qm', 'remote'], other);
    r.git(['push', '-q'], other);
    r.git(['fetch', '-q']);
    expect(await mergeBranches(r.run, r.folder, 'feat', 'main')).toMatchObject({ ok: false, code: 'behind' });
    r.git(['merge', '-q', '--ff-only', 'origin/main']);
    r.write('sub/b.txt', 'dirty\n');
    expect(await mergeBranches(r.run, r.folder, 'feat', 'main')).toMatchObject({ ok: false, code: 'dirty' });
  });

  it('never runs the repository’s own merge driver (GIT-HARDEN): that file is a conflict instead', async () => {
    const r = setup();
    const marker = path.join(r.root, 'ran');
    r.git(['config', 'merge.evil.driver', `touch ${marker}; cp %B %A`]);
    fs.writeFileSync(path.join(r.folder, '.git', 'info', 'attributes'), 'a.txt merge=evil\n');
    r.write('a.txt', 'main\n');
    r.git(['commit', '-qam', 'main side']);
    expect(await mergeBranches(r.run, r.folder, 'feat', 'main')).toMatchObject({ ok: false, conflicts: ['a.txt'] });
    expect(fs.existsSync(marker)).toBe(false);
    // Armed: plain git does run it.
    r.git(['merge', '-q', '--no-edit', 'feat']);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('a checked-out target in a repository with its own filters is refused (the owner merges it); not checked out, it merges', async () => {
    const r = setup();
    r.git(['config', 'filter.crypt.smudge', 'cat']);
    r.git(['config', 'filter.crypt.clean', 'cat']);
    const main = r.git(['rev-parse', 'main']).trim();
    expect(await mergeBranches(r.run, r.folder, 'feat', 'main')).toMatchObject({ ok: false, code: 'filters' });
    expect(r.git(['rev-parse', 'main']).trim()).toBe(main);
    expect(fs.readFileSync(path.join(r.folder, 'a.txt'), 'utf-8')).toBe('one\n');
    expect(await mergeBranches(r.run, r.folder, 'feat', 'dev')).toMatchObject({ ok: true, kind: 'ff' });
    r.git(['config', '--remove-section', 'filter.crypt']);
    expect(await mergeBranches(r.run, r.folder, 'feat', 'main')).toMatchObject({ ok: true, kind: 'ff' });
  });

  it('refuses a target being rebased in another checkout (rebase --abort would drop the merge)', async () => {
    const r = setup();
    const other = path.join(r.root, 'devwt');
    r.git(['worktree', 'add', '-q', other, 'dev']);
    fs.writeFileSync(path.join(other, 'a.txt'), 'dev\n');
    r.git(['commit', '-qam', 'dev side'], other);
    expect(() => r.git(['rebase', 'feat'], other)).toThrow(); // stops on the a.txt conflict
    const dev = r.git(['rev-parse', 'dev']).trim();
    r.git(['switch', '-q', '-c', 'x', 'main']);
    r.write('x.txt', 'x\n');
    r.git(['add', 'x.txt']);
    r.git(['commit', '-qm', 'x']);
    r.git(['switch', '-q', 'main']);
    expect(await mergeBranches(r.run, r.folder, 'x', 'dev')).toMatchObject({ ok: false, code: 'in_progress' });
    expect(r.git(['rev-parse', 'dev']).trim()).toBe(dev);
    r.git(['rebase', '--abort'], other);
    expect(await mergeBranches(r.run, r.folder, 'x', 'dev')).toMatchObject({ ok: true, kind: 'merge' });
  });

  it('a temporary merge worktree a stopped daemon left is dropped by the next merge commit; a link never followed', async () => {
    const r = setup();
    const dir = path.join(r.folder, '.worktrees');
    fs.mkdirSync(dir);
    const left = path.join(dir, '.merge-left');
    r.git(['worktree', 'add', '-q', '--detach', left, 'main']);
    const victim = path.join(r.root, 'victim');
    r.git(['worktree', 'add', '-q', '--detach', victim, 'main']);
    fs.symlinkSync(victim, path.join(dir, '.merge-link'));
    const hourAgo = new Date(Date.now() - 2 * 60 * 60_000);
    fs.utimesSync(left, hourAgo, hourAgo);
    fs.lutimesSync(path.join(dir, '.merge-link'), hourAgo, hourAgo);
    r.write('c.txt', 'main\n');
    r.git(['add', 'c.txt']);
    r.git(['commit', '-qm', 'main side']);
    expect(await mergeBranches(r.run, r.folder, 'feat', 'main')).toMatchObject({ ok: true, kind: 'merge' });
    expect(fs.readdirSync(dir)).toEqual(['.merge-link']);
    expect(r.git(['worktree', 'list', '--porcelain'])).not.toContain('.merge-left');
    expect(fs.existsSync(path.join(victim, 'a.txt'))).toBe(true);
  });
});

describe.skipIf(!GIT_AVAILABLE)('W3 RepoManager merge: policy and queue', () => {
  /** Project `alpha` with Task worktrees `t1` (base `dev`) and `t2` (base `dev`, touching another
   *  file), and `m1` (base main, protected); each with one commit. */
  async function setupManager() {
    const r = setup();
    const mgr = new RepoManager({ projects: () => [{ name: 'alpha', folder: r.folder }], readOnly: false, configDir: path.join(r.root, 'config'), run: r.run, log: () => undefined });
    const proj = { name: 'alpha', folder: r.folder };
    const made: Record<string, string> = {};
    for (const [id, base, file] of [['t1', 'dev', 'one.txt'], ['t2', 'dev', 'two.txt'], ['m1', 'main', 'three.txt']] as const) {
      const wt = await mgr.worktrees.createForTask(proj, { taskId: id, slug: 'x', base, createdBy: 'user' });
      fs.writeFileSync(path.join(wt.path, file), `${id}\n`);
      r.git(['add', file], wt.path);
      r.git(['commit', '-qm', id], wt.path);
      made[id] = wt.task;
    }
    return { r, mgr, made };
  }
  const local = { remote: false, fresh: () => false };
  const remoteStale = { remote: true, fresh: () => false };
  const remoteFresh = { remote: true, fresh: () => true };

  it('two requests at once run one after the other: both land on dev (the second as a merge commit)', async () => {
    const { r, mgr, made } = await setupManager();
    const [a, b] = await Promise.all([
      mgr.merge('alpha', made.t1, { privileged: true, source: 'test', auto: true }),
      mgr.merge('alpha', made.t2, { privileged: true, source: 'test', auto: true }),
    ]);
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
    expect(r.git(['ls-tree', '--name-only', 'dev']).split('\n')).toEqual(expect.arrayContaining(['one.txt', 'two.txt']));
    expect(r.git(['log', '-1', '--format=%s', 'dev']).trim()).toBe(`Merge branch 'task/${made.t2}' into dev`);
  });

  it('a protected base: the automatic request is refused; a click needs step-up from a remote device', async () => {
    const { r, mgr, made } = await setupManager();
    const main = r.git(['rev-parse', 'main']).trim();
    expect(await mgr.merge('alpha', made.m1, { privileged: true, source: 'auto', auto: true })).toMatchObject({ ok: false, code: 'protected' });
    expect(await mgr.merge('alpha', made.m1, { privileged: true, source: 'gui:phone', stepUp: remoteStale })).toMatchObject({ ok: false, error: 'stepup' });
    expect(r.git(['rev-parse', 'main']).trim()).toBe(main);
    expect(await mgr.merge('alpha', made.m1, { privileged: true, source: 'gui:phone', stepUp: remoteFresh })).toMatchObject({ ok: true });
    expect(r.git(['ls-tree', '--name-only', 'main'])).toContain('three.txt');
    // The owner's own list protects `dev` too; the local screen's click needs no step-up.
    fs.writeFileSync(path.join(r.root, 'config', 'protected-branches.json'), JSON.stringify({ alpha: ['dev'] }));
    expect(await mgr.merge('alpha', made.t1, { privileged: true, source: 'auto', auto: true })).toMatchObject({ ok: false, code: 'protected' });
    expect(await mgr.merge('alpha', made.t1, { privileged: true, source: 'gui:web', stepUp: local })).toMatchObject({ ok: true });
    // A list that cannot be read protects every branch: never open by mistake.
    for (const bad of ['{ "alpha": ["dev"', 'null', '{"alpha": "dev"}']) {
      fs.writeFileSync(path.join(r.root, 'config', 'protected-branches.json'), bad);
      expect(await mgr.merge('alpha', made.t2, { privileged: true, source: 'auto', auto: true })).toMatchObject({ ok: false, code: 'protected' });
    }
    mgr.dispose();
  });
});
