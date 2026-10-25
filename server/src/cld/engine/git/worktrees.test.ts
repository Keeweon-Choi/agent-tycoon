import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGitRunner, gitEnv, RepoError } from './gitRun.js';
import type { ProjectFolder } from './repoRead.js';
import type { TempRepo } from './testRepo.js';
import { GIT_AVAILABLE, makeTempRepo, recording } from './testRepo.js';
import type { WorktreeRecord } from './worktrees.js';
import { readRecords, slugOf, TASK_PATTERN, taskWorktreeName, Worktrees } from './worktrees.js';

// Every test here runs real git processes (a dozen or more each, the diff test a 2.5 MB diff); on a
// starved CPU (the deploy gate: two nice'd cores) that outlasts the 10 s default while nothing is wrong.
vi.setConfig({ testTimeout: 60_000 });

const repos: TempRepo[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.cleanup();
});

/** A temp repo, its project, and Worktrees over a recorder, with records in the temp dir. */
function setup(opts: Parameters<typeof makeTempRepo>[0] = {}) {
  const r = makeTempRepo(opts);
  repos.push(r);
  const rec = recording(r.run);
  const file = path.join(r.root, 'config/worktrees.json');
  const logs: string[] = [];
  const wt = new Worktrees({ file, run: rec.run, log: (l) => logs.push(l) });
  const project: ProjectFolder = { name: 'p', folder: r.folder };
  const records = () => JSON.parse(fs.readFileSync(file, 'utf-8')) as WorktreeRecord[];
  const dir = (task: string) => path.join(r.folder, '.worktrees', task);
  const branches = () => r.git(['branch', '--format=%(refname:short)']).split('\n').filter(Boolean);
  const listed = () =>
    r
      .git(['worktree', 'list', '--porcelain'])
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice(9));
  /** A commit in the task's worktree. */
  const work = (task: string, name = 'work.txt') => {
    fs.writeFileSync(path.join(dir(task), name), `${name}\n`);
    r.git(['add', name], dir(task));
    r.git(['commit', '-q', '-m', `work ${name}`], dir(task));
  };
  return { r, rec, wt, project, file, logs, records, dir, branches, listed, work };
}

describe('task names', () => {
  it.each([
    ['a', true],
    ['0', true],
    ['fix-login-2', true],
    ['x'.repeat(41), true],
    ['', false],
    ['x'.repeat(42), false],
    ['A', false],
    ['-x', false],
    ['a_b', false],
    ['a.b', false],
    ['a/b', false],
    ['../x', false],
    ['a b', false],
    ['a\nb', false],
    ['한글', false],
  ])('%j is %s', (task, ok) => {
    expect(TASK_PATTERN.test(task)).toBe(ok);
  });
});

describe.skipIf(!GIT_AVAILABLE)('new worktree (temp repos)', () => {
  it('git worktree add <folder>/.worktrees/<task> -b task/<task>, recorded', async () => {
    const { r, rec, wt, project, file, records, dir, branches, logs } = setup();
    const before = fs.readFileSync(path.join(r.folder, '.git/config'), 'utf-8');
    const out = await wt.create(project, 'login');
    expect(out).toEqual({
      project: 'p',
      task: 'login',
      path: dir('login'),
      branch: 'task/login',
      base: 'main',
      created: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/),
      status: 'active',
    });
    expect(records()).toEqual([out]);
    expect(rec.calls).toContainEqual(['worktree', 'add', dir('login'), '-b', 'task/login']);
    expect(fs.existsSync(path.join(dir('login'), '.git'))).toBe(true);
    expect(branches()).toContain('task/login');
    expect(r.git(['rev-parse', 'HEAD'], dir('login'))).toBe(r.git(['rev-parse', 'HEAD']));
    expect(fs.readdirSync(path.dirname(file))).toEqual(['worktrees.json']); // no temp file left
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(logs).toEqual(['[cld repo] worktree new "p" login: ok']);
    // git's own config is not touched (no tracking is set up for the new branch).
    expect(fs.readFileSync(path.join(r.folder, '.git/config'), 'utf-8')).toBe(before);
  });

  it('starts from the branch the project is on, with its commits', async () => {
    const { r, wt, project, dir } = setup();
    r.git(['checkout', '-q', '-b', 'dev']);
    r.write('dev.txt', 'd\n');
    r.git(['add', '-A']);
    r.git(['commit', '-q', '-m', 'dev']);
    const out = await wt.create(project, 'x');
    expect(out.base).toBe('dev');
    expect(fs.existsSync(path.join(dir('x'), 'dev.txt'))).toBe(true);
  });

  it('on a detached HEAD the base is the commit', async () => {
    const { r, wt, project } = setup();
    r.git(['checkout', '-q', '--detach']);
    const out = await wt.create(project, 'x');
    expect(out.base).toBe(r.git(['rev-parse', 'HEAD']).trim());
    expect((await wt.status(project, 'x'))?.merged).toBe(true);
  });

  it('keeps .worktrees/ out of the project’s tracked files: info/exclude only', async () => {
    const { r, wt, project } = setup();
    await wt.create(project, 'one');
    await wt.create(project, 'two');
    const exclude = path.join(r.folder, '.git/info/exclude');
    expect(
      fs
        .readFileSync(exclude, 'utf-8')
        .split('\n')
        .filter((l) => l === '/.worktrees/'),
    ).toHaveLength(1);
    expect(r.git(['status', '--porcelain', '--untracked-files=all'])).toBe('');
    expect(fs.existsSync(path.join(r.folder, '.gitignore'))).toBe(false);
    expect(r.git(['ls-files']).trim().split('\n').sort()).toEqual(['a.txt', 'sub/b.txt']);
  });

  it('leaves info/exclude alone when something already ignores .worktrees/', async () => {
    const { r, wt, project } = setup();
    r.write('.gitignore', '.worktrees/\n');
    r.git(['add', '.gitignore']);
    r.git(['commit', '-q', '-m', 'ignore']);
    const exclude = path.join(r.folder, '.git/info/exclude');
    const before = fs.readFileSync(exclude, 'utf-8');
    await wt.create(project, 'x');
    expect(fs.readFileSync(exclude, 'utf-8')).toBe(before);
    expect(r.git(['status', '--porcelain'])).toBe('');
  });

  it('adds the line after an exclude file that does not end in a newline', async () => {
    const { r, wt, project } = setup();
    const exclude = path.join(r.folder, '.git/info/exclude');
    fs.writeFileSync(exclude, '*.log');
    await wt.create(project, 'x');
    expect(fs.readFileSync(exclude, 'utf-8')).toBe('*.log\n/.worktrees/\n');
  });

  it('refuses what is not a task name before any git runs', async () => {
    const { rec, wt, project, r } = setup();
    for (const bad of ['', 'A', '-x', 'a/b', '../x', 'x'.repeat(42), 'a b']) {
      await expect(wt.create(project, bad)).rejects.toBeInstanceOf(RepoError);
    }
    expect(rec.calls).toEqual([]);
    expect(fs.existsSync(path.join(r.folder, '.worktrees'))).toBe(false);
  });

  it('refuses a task that exists: a record, a folder, a branch', async () => {
    const { r, wt, project, dir, branches } = setup();
    await wt.create(project, 'x');
    await expect(wt.create(project, 'x')).rejects.toThrow('이미 있어요');
    fs.mkdirSync(dir('y'));
    await expect(wt.create(project, 'y')).rejects.toThrow('폴더가 이미 있어요');
    r.git(['branch', 'task/z']);
    await expect(wt.create(project, 'z')).rejects.toThrow('브랜치 task/z가 이미 있어요');
    expect(branches().sort()).toEqual(['main', 'task/x', 'task/z']);
  });

  it('refuses a .worktrees that leads out of the project', async () => {
    const { r, wt, project } = setup();
    const elsewhere = path.join(r.root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(r.folder, '.worktrees'));
    await expect(wt.create(project, 'x')).rejects.toThrow('폴더가 아니에요');
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('refuses before the first commit and outside the repository’s top folder', async () => {
    const empty = setup({ commit: false });
    await expect(empty.wt.create(empty.project, 'x')).rejects.toThrow('커밋이 하나도 없어서');
    const { wt, r } = setup();
    await expect(wt.create({ name: 'p', folder: path.join(r.folder, 'sub') }, 'x')).rejects.toThrow(
      '맨 위 폴더',
    );
    await expect(wt.create({ name: 'p', folder: path.join(r.root, 'nope') }, 'x')).rejects.toThrow(
      '폴더가 없어요',
    );
  });

  it('creates in parallel without losing a record; the same task only once', async () => {
    const { wt, project, records } = setup();
    const results = await Promise.allSettled([
      wt.create(project, 'a'),
      wt.create(project, 'b'),
      wt.create(project, 'a'),
      wt.create(project, 'c'),
    ]);
    expect(results.map((x) => x.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'rejected',
      'fulfilled',
    ]);
    expect(records().map((x) => x.task)).toEqual(['a', 'b', 'c']);
  });
});

describe.skipIf(!GIT_AVAILABLE)('worktree status (temp repos)', () => {
  it('a fresh worktree: nothing ahead, clean, merged (nothing to lose)', async () => {
    const { wt, project, dir } = setup();
    await wt.create(project, 'x');
    expect(await wt.list(project)).toEqual([
      {
        task: 'x',
        path: dir('x'),
        branch: 'task/x',
        base: 'main',
        created: expect.any(String),
        exists: true,
        ahead: 0,
        behind: 0,
        dirty: 0,
        merged: true,
      },
    ]);
  });

  it('ahead after a commit, dirty with an uncommitted file, behind when the base moves', async () => {
    const { r, wt, project, dir, work } = setup();
    await wt.create(project, 'x');
    work('x');
    fs.writeFileSync(path.join(dir('x'), 'loose.txt'), 'l\n');
    r.write('base.txt', 'b\n');
    r.git(['add', 'base.txt']);
    r.git(['commit', '-q', '-m', 'base moves']);
    expect(await wt.status(project, 'x')).toMatchObject({
      ahead: 1,
      behind: 1,
      dirty: 1,
      merged: false,
      exists: true,
    });
  });

  it('merged once the base has the branch, whatever else the base has', async () => {
    const { r, wt, project, work } = setup();
    await wt.create(project, 'x');
    work('x');
    r.git(['merge', '-q', '--no-edit', 'task/x']);
    expect(await wt.status(project, 'x')).toMatchObject({ ahead: 0, behind: 0, merged: true });
  });

  it('a folder that is gone: exists false, and what is left of the branch still counts', async () => {
    const { r, wt, project, dir, work } = setup();
    await wt.create(project, 'x');
    work('x');
    fs.rmSync(dir('x'), { recursive: true });
    expect(await wt.status(project, 'x')).toMatchObject({
      exists: false,
      dirty: 0,
      ahead: 1,
      merged: false,
    });
    expect(r.git(['branch', '--list', 'task/x'])).toContain('task/x');
  });

  it('lists only the project’s own active worktrees', async () => {
    const { wt, project, file } = setup();
    await wt.create(project, 'x');
    const records = JSON.parse(fs.readFileSync(file, 'utf-8')) as WorktreeRecord[];
    records.push({ ...records[0], project: 'other', task: 'y' });
    records.push({ ...records[0], task: 'gone', status: 'removed' });
    fs.writeFileSync(file, JSON.stringify(records));
    expect((await wt.list(project)).map((w) => w.task)).toEqual(['x']);
    expect(await wt.status(project, 'y')).toBeUndefined();
    expect(await wt.list({ name: 'none', folder: project.folder })).toEqual([]);
  });
});

describe.skipIf(!GIT_AVAILABLE)('cleanup (temp repos)', () => {
  it('a merged, clean worktree: removed, its branch deleted, the record closed', async () => {
    const { r, rec, wt, project, dir, branches, listed, records, work } = setup();
    await wt.create(project, 'x');
    work('x');
    r.git(['merge', '-q', '--no-edit', 'task/x']);
    expect(await wt.cleanup(project, 'x')).toEqual({
      ok: true,
      branchDeleted: true,
      detail: '브랜치도 지웠어요',
    });
    expect(fs.existsSync(dir('x'))).toBe(false);
    expect(branches()).toEqual(['main']);
    expect(listed()).toEqual([r.folder]);
    expect(records()).toEqual([expect.objectContaining({ task: 'x', status: 'removed' })]);
    expect(await wt.list(project)).toEqual([]);
    // Without --force, and the branch only by the safe `-d`.
    expect(rec.calls).toContainEqual(['worktree', 'remove', dir('x')]);
    expect(rec.calls).toContainEqual(['branch', '-d', 'task/x']);
    expect(rec.calls.flat()).not.toContain('-D');
    expect(rec.calls.flat()).not.toContain('--force');
    // The name is free again.
    await expect(wt.create(project, 'x')).resolves.toMatchObject({ task: 'x' });
  });

  it('unmerged commits: refused without the user’s confirmation, and nothing is touched', async () => {
    const { r, rec, wt, project, dir, branches, records, work } = setup();
    await wt.create(project, 'x');
    work('x');
    const out = await wt.cleanup(project, 'x');
    expect(out).toMatchObject({ ok: false, needsForce: true });
    expect(out.error).toContain('병합되지 않은 커밋 1개');
    expect(fs.existsSync(path.join(dir('x'), 'work.txt'))).toBe(true);
    expect(branches()).toContain('task/x');
    expect(records()[0].status).toBe('active');
    expect(rec.calls.filter((c) => c[0] === 'worktree' && c[1] === 'remove')).toEqual([]);
    expect(rec.calls.filter((c) => c[0] === 'branch')).toEqual([]);
    expect(r.git(['log', '-1', '--format=%s', 'task/x']).trim()).toBe('work work.txt');
  });

  it('unmerged, confirmed: the worktree goes, the branch with its commits stays', async () => {
    const { r, rec, wt, project, dir, branches, records, work } = setup();
    await wt.create(project, 'x');
    work('x');
    const out = await wt.cleanup(project, 'x', { force: true });
    expect(out).toEqual({
      ok: true,
      branchDeleted: false,
      detail: '브랜치 task/x는 병합되지 않아 남겼어요',
    });
    expect(fs.existsSync(dir('x'))).toBe(false);
    expect(branches()).toContain('task/x');
    expect(r.git(['log', '-1', '--format=%s', 'task/x']).trim()).toBe('work work.txt');
    expect(records()[0].status).toBe('removed');
    expect(rec.calls).toContainEqual(['worktree', 'remove', '--force', dir('x')]);
    expect(rec.calls.flat()).not.toContain('-D');
  });

  it('uncommitted changes: refused, then confirmed', async () => {
    const { wt, project, dir } = setup();
    await wt.create(project, 'x');
    fs.writeFileSync(path.join(dir('x'), 'loose.txt'), 'l\n');
    const refused = await wt.cleanup(project, 'x');
    expect(refused).toMatchObject({ ok: false, needsForce: true });
    expect(refused.error).toContain('커밋하지 않은 변경 1건');
    expect(fs.existsSync(path.join(dir('x'), 'loose.txt'))).toBe(true);
    // Merged (nothing committed on it) and confirmed: gone, and the empty branch with it.
    expect(await wt.cleanup(project, 'x', { force: true })).toEqual({
      ok: true,
      branchDeleted: true,
      detail: '브랜치도 지웠어요',
    });
    expect(fs.existsSync(dir('x'))).toBe(false);
  });

  it('a folder deleted by hand is closed out: the admin entry and, if merged, the branch', async () => {
    const { r, wt, project, dir, branches, listed } = setup();
    await wt.create(project, 'x');
    fs.rmSync(dir('x'), { recursive: true });
    expect(await wt.cleanup(project, 'x')).toEqual({
      ok: true,
      branchDeleted: true,
      detail: '브랜치도 지웠어요',
    });
    expect(listed()).toEqual([r.folder]);
    expect(branches()).toEqual(['main']);
  });

  it('a folder deleted by hand with unmerged commits keeps the branch', async () => {
    const { wt, project, dir, branches, work } = setup();
    await wt.create(project, 'x');
    work('x');
    fs.rmSync(dir('x'), { recursive: true });
    // Nothing on disk is left to lose, and the commits stay on the branch: no confirmation needed.
    expect(await wt.cleanup(project, 'x')).toEqual({
      ok: true,
      branchDeleted: false,
      detail: '브랜치 task/x는 병합되지 않아 남겼어요',
    });
    expect(branches()).toContain('task/x');
  });

  it('no such task, a bad name, and a folder that is not a registered worktree', async () => {
    const { rec, wt, project, dir, file } = setup();
    expect(await wt.cleanup(project, 'nope')).toMatchObject({
      ok: false,
      error: '그런 작업 공간이 없어요',
    });
    const calls = rec.calls.length;
    expect(await wt.cleanup(project, '../x', { force: true })).toMatchObject({ ok: false });
    expect(rec.calls.length).toBe(calls);

    // A record whose folder is a plain directory: never deleted by us.
    fs.mkdirSync(dir('ghost'), { recursive: true });
    fs.writeFileSync(path.join(dir('ghost'), 'keep.txt'), 'k\n');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify([
        {
          project: 'p',
          task: 'ghost',
          path: dir('ghost'),
          branch: 'task/ghost',
          base: 'main',
          created: 'x',
          status: 'active',
        },
      ]),
    );
    expect(await wt.cleanup(project, 'ghost', { force: true })).toMatchObject({ ok: false });
    expect(fs.readFileSync(path.join(dir('ghost'), 'keep.txt'), 'utf-8')).toBe('k\n');
  });

  it('acts on <folder>/.worktrees/<task>, never on the path the file says', async () => {
    const { r, rec, wt, project, dir, file } = setup();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify([
        {
          project: 'p',
          task: 'evil',
          path: r.root,
          branch: 'task/evil',
          base: 'main',
          created: 'x',
          status: 'active',
        },
      ]),
    );
    await wt.cleanup(project, 'evil', { force: true });
    expect(fs.existsSync(r.root)).toBe(true);
    expect(rec.calls.filter((c) => c[1] === 'remove')).toEqual([
      ['worktree', 'remove', '--force', dir('evil')],
    ]);
  });
});

describe.skipIf(!GIT_AVAILABLE)('worktrees.json', () => {
  it('a broken file is set aside and read as empty; junk records are dropped', () => {
    const { r } = setup();
    const file = path.join(r.root, 'broken.json');
    fs.writeFileSync(file, '{ not json');
    expect(readRecords(file)).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(r.root).some((f) => f.startsWith('broken.json.corrupt-'))).toBe(true);
    const mixed = path.join(r.root, 'mixed.json');
    const good = {
      project: 'p',
      task: 't',
      path: '/x',
      branch: 'task/t',
      base: 'main',
      created: 'now',
      status: 'active',
    };
    fs.writeFileSync(
      mixed,
      JSON.stringify([good, { project: 'p' }, 5, null, { ...good, status: 'x' }]),
    );
    expect(readRecords(mixed)).toEqual([good]);
    expect(readRecords(path.join(r.root, 'missing.json'))).toEqual([]);
    fs.writeFileSync(path.join(r.root, 'obj.json'), '{}');
    expect(readRecords(path.join(r.root, 'obj.json'))).toEqual([]);
  });

  it('keeps the last 100 removed records and every active one', async () => {
    const { wt, project, file, r } = setup();
    const old = Array.from({ length: 150 }, (_, i) => ({
      project: 'p',
      task: `r${i}`,
      path: '/x',
      branch: `task/r${i}`,
      base: 'main',
      created: 'old',
      status: 'removed',
    }));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(old));
    await wt.create(project, 'new');
    const out = JSON.parse(fs.readFileSync(file, 'utf-8')) as WorktreeRecord[];
    expect(out).toHaveLength(101);
    expect(out[0].task).toBe('r50');
    expect(out.at(-1)).toMatchObject({ task: 'new', status: 'active' });
    expect(r.git(['branch', '--list', 'task/new'])).toContain('task/new');
  });
});

describe('W2: a Task worktree’s name', () => {
  it.each([
    ['로그인 페이지 고치기', ''],
    ['Fix the Login page!', 'fix-the-login-page'],
    ['  --x__y..z  ', 'x-y-z'],
    ['a'.repeat(50), 'a'.repeat(30)],
    [undefined, ''],
  ])('slugOf(%j) = %j', (title, slug) => expect(slugOf(title)).toBe(slug));

  it('<id>-<slug>, lower case, 41 at most, always a task name', () => {
    expect(taskWorktreeName('T-12', 'login')).toBe('t-12-login');
    expect(taskWorktreeName('T-12', '')).toBe('t-12');
    expect(taskWorktreeName('a.b_c', 'x')).toBe('a-b-c-x');
    expect(taskWorktreeName('T-1', `${'x'.repeat(36)}-yy`)).toBe(`t-1-${'x'.repeat(36)}`);
    for (const n of [taskWorktreeName('T-99999', 'y'.repeat(40)), taskWorktreeName('Z'.repeat(41), '')])
      expect(TASK_PATTERN.test(n)).toBe(true);
  });
});

describe.skipIf(!GIT_AVAILABLE)('W2: a Task’s worktree (temp repos)', () => {
  const at = new Date('2026-10-24T03:00:00.000Z');
  const w2 = (o: Parameters<typeof setup>[0] = {}) => {
    const s = setup(o);
    const wt = new Worktrees({ file: s.file, run: s.rec.run, log: () => undefined, now: () => at });
    return { ...s, wt };
  };

  it('task/<id>-<slug> from the main branch in .worktrees/, recorded with the Task, its assignee and maker', async () => {
    const { r, rec, wt, project, records, dir, branches } = w2();
    // The project's checkout is on another branch: the Task still starts from main.
    r.git(['checkout', '-q', '-b', 'dev']);
    r.write('dev.txt', 'dev\n');
    r.git(['add', '-A']);
    r.git(['commit', '-q', '-m', 'dev']);
    const out = await wt.createForTask(project, {
      taskId: 'T-7',
      title: 'Login page',
      assignmentId: 'a_bbbbbbbbbb',
      createdBy: 'user',
    });
    expect(out).toEqual({
      project: 'p',
      task: 't-7-login-page',
      path: dir('t-7-login-page'),
      branch: 'task/t-7-login-page',
      base: 'main',
      created: at.toISOString(),
      status: 'active',
      taskId: 'T-7',
      createdBy: 'user',
      assignmentId: 'a_bbbbbbbbbb',
      assignedAt: at.toISOString(),
    });
    expect(records()).toEqual([out]);
    expect(rec.calls).toContainEqual(['worktree', 'add', dir('t-7-login-page'), '-b', 'task/t-7-login-page', 'refs/heads/main']);
    expect(branches()).toContain('task/t-7-login-page');
    expect(r.git(['rev-parse', 'HEAD'], dir('t-7-login-page'))).toBe(r.git(['rev-parse', 'main']));
    expect(fs.existsSync(path.join(dir('t-7-login-page'), 'dev.txt'))).toBe(false);
    // The wire carries the Task, the assignee and the maker.
    expect((await wt.list(project))[0]).toMatchObject({ task: 't-7-login-page', taskId: 'T-7', assignmentId: 'a_bbbbbbbbbb', createdBy: 'user' });
  });

  it('a named base; a Hangul title gives the id alone; an explicit slug; no assignee', async () => {
    const { r, wt, project } = w2();
    r.git(['branch', 'release/1.0']);
    const a = await wt.createForTask(project, { taskId: 'T-8', title: '로그인', base: 'release/1.0', createdBy: 'cli' });
    expect([a.task, a.branch, a.base]).toEqual(['t-8', 'task/t-8', 'release/1.0']);
    expect(a).not.toHaveProperty('assignmentId');
    const b = await wt.createForTask(project, { taskId: 'T-9', slug: 'api', createdBy: 'agent:alpha' });
    expect([b.task, b.createdBy]).toEqual(['t-9-api', 'agent:alpha']);
  });

  it('the main branch: the remote’s default when it is a local branch, else main, master, the branch it is on', async () => {
    const { r, wt, project } = w2();
    r.git(['branch', 'trunk']);
    r.git(['update-ref', 'refs/remotes/origin/trunk', 'HEAD']);
    r.git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']);
    expect((await wt.createForTask(project, { taskId: 'T-1', createdBy: 'cli' })).base).toBe('trunk');
    const m = w2();
    m.r.git(['branch', '-m', 'main', 'master']);
    expect((await m.wt.createForTask(m.project, { taskId: 'T-1', createdBy: 'cli' })).base).toBe('master');
    const o = w2();
    o.r.git(['branch', '-m', 'main', 'work']);
    expect((await o.wt.createForTask(o.project, { taskId: 'T-1', createdBy: 'cli' })).base).toBe('work');
  });

  it('refuses unsafe names and bases before any git runs', async () => {
    const { rec, wt, project } = w2();
    const bad = [
      { taskId: '../x' },
      { taskId: '-T' },
      { taskId: 'T 1' },
      { taskId: 'x'.repeat(42) },
      { taskId: 'T-1', slug: 'A' },
      { taskId: 'T-1', slug: '../x' },
      { taskId: 'T-1', slug: '-x' },
      { taskId: 'T-1', base: '--upload-pack=x' },
      { taskId: 'T-1', base: 'a..b' },
      { taskId: 'T-1', base: 'a b' },
      { taskId: 'T-1', base: 'x.lock' },
      { taskId: 'T-1', base: '@{-1}' },
      { taskId: 'T-1', base: 'HEAD^' },
    ];
    for (const o of bad) await expect(wt.createForTask(project, { createdBy: 'cli', ...o })).rejects.toBeInstanceOf(RepoError);
    expect(rec.calls).toEqual([]);
  });

  it('refuses: a base that is not a branch, a Task that has one, a folder or branch that exists', async () => {
    const { r, wt, project, dir, records } = w2();
    await expect(wt.createForTask(project, { taskId: 'T-1', base: 'nope', createdBy: 'cli' })).rejects.toThrow('기준 브랜치 nope가 없어요');
    await wt.createForTask(project, { taskId: 'T-1', createdBy: 'cli' });
    await expect(wt.createForTask(project, { taskId: 'T-1', slug: 'other', createdBy: 'cli' })).rejects.toThrow('이미 worktree 가 있어요');
    fs.mkdirSync(dir('t-2'), { recursive: true });
    await expect(wt.createForTask(project, { taskId: 'T-2', createdBy: 'cli' })).rejects.toThrow('폴더가 이미 있어요');
    r.git(['branch', 'task/t-3']);
    await expect(wt.createForTask(project, { taskId: 'T-3', createdBy: 'cli' })).rejects.toThrow('브랜치 task/t-3가 이미 있어요');
    expect(records().map((x) => x.taskId)).toEqual(['T-1']);
  });

  it('refuses a protected branch as the target (main, master, a remote’s default)', async () => {
    const { r, rec, wt, project, branches } = w2();
    // A remote whose default branch is the very name the Task would get.
    r.git(['update-ref', 'refs/remotes/origin/task/t-1', 'HEAD']);
    r.git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/task/t-1']);
    await expect(wt.createForTask(project, { taskId: 'T-1', base: 'main', createdBy: 'cli' })).rejects.toThrow('보호 브랜치(task/t-1)');
    expect(rec.calls.some((c) => c[0] === 'worktree')).toBe(false);
    expect(branches()).toEqual(['main']);
  });

  it.each([
    ['MERGE_HEAD', 'merge'],
    ['rebase-merge', 'rebase'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ])('refuses while the checkout is in the middle of a git operation (%s)', async (file, word) => {
    const { r, rec, wt, project, file: records } = w2();
    const at = path.join(r.folder, '.git', file);
    if (file.includes('-')) fs.mkdirSync(at);
    else fs.writeFileSync(at, `${r.git(['rev-parse', 'HEAD'])}`);
    await expect(wt.createForTask(project, { taskId: 'T-1', createdBy: 'cli' })).rejects.toThrow(`${word} 중이에요`);
    expect(rec.calls.some((c) => c[0] === 'worktree')).toBe(false);
    expect(fs.existsSync(path.join(r.folder, '.worktrees'))).toBe(false);
    expect(fs.existsSync(records)).toBe(false);
  });

  it('forTask, assign and assignedTo: the newest worktree given to an agent, the removed one after it goes', async () => {
    const { rec, file, project } = w2();
    let n = 0;
    const tick = new Worktrees({ file, run: rec.run, log: () => undefined, now: () => new Date(Date.parse('2026-10-24T03:00:00Z') + 60_000 * ++n) });
    const a = await tick.createForTask(project, { taskId: 'T-1', assignmentId: 'a_bbbbbbbbbb', createdBy: 'user' });
    const b = await tick.createForTask(project, { taskId: 'T-2', createdBy: 'user' });
    expect(tick.forTask('p', 'T-2')?.task).toBe(b.task);
    expect(tick.forTask('other', 'T-2')).toBeUndefined();
    expect(tick.assignedTo('a_bbbbbbbbbb')?.task).toBe(a.task);
    const given = await tick.assign(project, b.task, 'a_bbbbbbbbbb');
    expect(given).toMatchObject({ taskId: 'T-2', assignmentId: 'a_bbbbbbbbbb' });
    expect(tick.assignedTo('a_bbbbbbbbbb')?.task).toBe(b.task);
    expect((await tick.assign(project, b.task, null))).not.toHaveProperty('assignmentId');
    expect(tick.assignedTo('a_bbbbbbbbbb')?.task).toBe(a.task);
    await tick.cleanup(project, a.task);
    expect(tick.assignedTo('a_bbbbbbbbbb')).toMatchObject({ task: a.task, status: 'removed' });
    await expect(tick.assign(project, a.task, 'a_bbbbbbbbbb')).rejects.toThrow('그런 작업 공간이 없어요');
  });

  it('an old (pre-W2) record loads and is written back exactly as it was beside a Task’s', async () => {
    const { wt, project, file } = w2();
    const old = { project: 'p', task: 'codex-1022-041502', path: '/x', branch: 'task/codex-1022-041502', base: 'main', created: '2026-10-22T04:15:02.000Z', status: 'active' };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify([old]));
    expect(readRecords(file)).toEqual([old]);
    await wt.createForTask(project, { taskId: 'T-1', createdBy: 'cli' });
    const after = JSON.parse(fs.readFileSync(file, 'utf-8')) as WorktreeRecord[];
    expect(after[0]).toStrictEqual(old);
    expect(wt.forTask('p', 'T-1')?.task).toBe('t-1');
    expect(wt.assignedTo('a_bbbbbbbbbb')).toBeUndefined();
  });

  it('create() for a Codex Worker’s Task run records the Task and the Worker (D5 reuse)', async () => {
    const { wt, project, records, rec, dir } = w2();
    const out = await wt.create(project, 'codex-1024-120000', { taskId: 'T-4', assignmentId: 'a_wwwwwwwwww', createdBy: 'agent:w1' });
    expect(out).toMatchObject({ task: 'codex-1024-120000', taskId: 'T-4', assignmentId: 'a_wwwwwwwwww', assignedAt: at.toISOString(), createdBy: 'agent:w1' });
    expect(records()).toEqual([out]);
    // The same `git worktree add` as before W2: from HEAD, no start point.
    expect(rec.calls).toContainEqual(['worktree', 'add', dir('codex-1024-120000'), '-b', 'task/codex-1024-120000']);
  });
});

describe.skipIf(!GIT_AVAILABLE)('W2 fix 3: no worktree without its record', () => {
  it('a record that cannot be written: the worktree and the branch this call made are taken back', async () => {
    const { r, rec, project, file, dir, branches, listed } = setup();
    fs.mkdirSync(file, { recursive: true }); // worktrees.json is a folder: the write fails
    const wt = new Worktrees({ file, run: rec.run, log: () => undefined });
    await expect(wt.createForTask(project, { taskId: 'T-1', createdBy: 'cli' })).rejects.toThrow('되돌렸어요');
    expect(fs.existsSync(dir('t-1'))).toBe(false);
    expect(branches()).toEqual(['main']);
    expect(listed()).toEqual([r.folder]);
    await expect(wt.create(project, 'x')).rejects.toThrow('되돌렸어요');
    expect(branches()).toEqual(['main']);
  });

  it('a git that runs out of time: what it left is taken back', async () => {
    const { r, rec, project, file, dir, branches, listed } = setup();
    // The add goes through, then the runner says it timed out (as a slow checkout would).
    const slow: typeof rec.run = async (cwd, args, opts) => {
      const out = await rec.run(cwd, args, opts);
      return args[0] === 'worktree' && args[1] === 'add' ? { ...out, code: null, timedOut: true } : out;
    };
    const wt = new Worktrees({ file, run: slow, log: () => undefined });
    await expect(wt.createForTask(project, { taskId: 'T-1', createdBy: 'cli' })).rejects.toThrow('제한 시간');
    expect([fs.existsSync(dir('t-1')), branches(), listed()]).toEqual([false, ['main'], [r.folder]]);
  });

  it('N4: any failed add (the user’s global git-lfs smudge failing, its server unreachable): nothing left, the next call no “exists”', async () => {
    const { r, file, project, dir, branches, listed } = setup();
    r.write('.gitattributes', '*.txt filter=lfs\n');
    r.git(['add', '-A']);
    r.git(['commit', '-q', '-m', 'lfs']);
    const global = path.join(r.root, 'global.cfg');
    fs.writeFileSync(global, '[filter "lfs"]\n\tsmudge = false\n\trequired = true\n\tclean = cat\n');
    const run = createGitRunner({ env: gitEnv({ ...process.env, HOME: path.join(r.root, 'home'), GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1' }) });
    const wt = new Worktrees({ file, run, log: () => undefined });
    for (const _ of [1, 2]) {
      const err = await wt.createForTask(project, { taskId: 'T-1', createdBy: 'cli' }).catch((e: unknown) => e as RepoError);
      expect(err).toBeInstanceOf(RepoError);
      expect((err as RepoError).code).not.toBe('exists');
      expect([fs.existsSync(dir('t-1')), branches(), listed()]).toEqual([false, ['main'], [r.folder]]);
    }
  });

  it('what a dead call left (folder and branch, exactly as it would make them, no record): adopted', async () => {
    const { r, wt, project, dir, records } = setup();
    r.git(['worktree', 'add', '-q', dir('t-1-login'), '-b', 'task/t-1-login', 'main']);
    const out = await wt.createForTask(project, { taskId: 'T-1', slug: 'login', assignmentId: 'a_bbbbbbbbbb', createdBy: 'user' });
    expect(out).toMatchObject({ task: 't-1-login', branch: 'task/t-1-login', taskId: 'T-1', assignmentId: 'a_bbbbbbbbbb' });
    expect(records()).toEqual([out]);
    expect(wt.forTask('p', 'T-1')?.task).toBe('t-1-login');
    expect((await wt.list(project)).map((w) => w.task)).toEqual(['t-1-login']);
    // D5's create adopts the same way.
    r.git(['worktree', 'add', '-q', dir('codex-1'), '-b', 'task/codex-1']);
    expect((await wt.create(project, 'codex-1')).task).toBe('codex-1');
  });

  it('not adopted when it is not exactly that: a commit of its own, a change, another branch, a plain folder', async () => {
    const { r, wt, project, dir } = setup();
    r.git(['worktree', 'add', '-q', dir('t-1'), '-b', 'task/t-1', 'main']);
    fs.writeFileSync(path.join(dir('t-1'), 'w.txt'), 'w\n');
    r.git(['add', 'w.txt'], dir('t-1'));
    r.git(['commit', '-q', '-m', 'work'], dir('t-1'));
    await expect(wt.createForTask(project, { taskId: 'T-1', createdBy: 'cli' })).rejects.toThrow('폴더가 이미 있어요');
    r.git(['worktree', 'add', '-q', dir('t-2'), '-b', 'task/t-2', 'main']);
    fs.writeFileSync(path.join(dir('t-2'), 'a.txt'), 'dirty\n');
    await expect(wt.createForTask(project, { taskId: 'T-2', createdBy: 'cli' })).rejects.toThrow('폴더가 이미 있어요');
    r.git(['branch', 'task/t-3']);
    r.git(['worktree', 'add', '-q', dir('t-3'), '-b', 'other', 'main']);
    await expect(wt.createForTask(project, { taskId: 'T-3', createdBy: 'cli' })).rejects.toThrow('폴더가 이미 있어요');
    fs.mkdirSync(dir('t-4'));
    r.git(['branch', 'task/t-4']);
    await expect(wt.createForTask(project, { taskId: 'T-4', createdBy: 'cli' })).rejects.toThrow('폴더가 이미 있어요');
    expect(fs.existsSync(path.join(dir('t-1'), 'w.txt'))).toBe(true); // nothing of theirs touched
  });
});
