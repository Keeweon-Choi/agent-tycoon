import { PassThrough } from 'node:stream';

import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import type { SpawnFn } from '../../spawnJson.js';
import { configEnv, createGitRunner, filterOverrides, gitEnv, GitMissingError, GitTooOldError, NO_FETCH_ENV, NO_REPO_CODE, touchesContent } from './gitRun.js';
import { GIT_AVAILABLE, makeTempRepo } from './testRepo.js';

const posix = process.platform !== 'win32';
const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

interface Spawned {
  file: string;
  args: string[];
  options: Record<string, unknown>;
}

/** A spawn that records its call and answers `out` with exit code 0. */
function fakeSpawn(calls: Spawned[], out = 'out\n', version = 'git version 2.45.0\n'): SpawnFn {
  return ((file: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ file, args, options });
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdout, stderr, kill: () => true });
    queueMicrotask(() => {
      stdout.end(args[0] === 'version' ? version : out);
      stderr.end();
      child.emit('close', 0);
    });
    return child;
  }) as unknown as SpawnFn;
}

/** A spawn whose version probes return the supplied results in order. */
function fakeVersionResults(calls: Spawned[], versions: Array<{ out: string; code: number }>): SpawnFn {
  return ((file: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ file, args, options });
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdout, stderr, kill: () => true });
    queueMicrotask(() => {
      const result = args[0] === 'version' ? versions.shift() ?? { out: 'git version 2.45.0\n', code: 0 } : { out: 'out\n', code: 0 };
      stdout.end(result.out);
      stderr.end();
      child.emit('close', result.code);
    });
    return child;
  }) as unknown as SpawnFn;
}

describe('git runner: argv only, a pinned environment', () => {
  it('spawns the given git by argv with no shell and stdin closed, in the given cwd', async () => {
    const calls: Spawned[] = [];
    const run = createGitRunner({
      gitPath: '/usr/bin/git',
      spawnFn: fakeSpawn(calls),
      env: { PATH: '/bin', GIT_DIR: '/real/repo/.git', GIT_WORK_TREE: '/real/repo', KEEP: 'x' },
    });
    const evil = '; touch pwned $(touch pwned2) `touch pwned3`';
    const r = await run('/tmp', ['status', '--', evil], { env: { GIT_OPTIONAL_LOCKS: '0' } });
    expect(r).toMatchObject({ code: 0, capped: false, timedOut: false });
    expect(r.stdout.toString()).toBe('out\n');
    expect(calls).toHaveLength(3); // version, filter config read, then status
    const { file, args, options } = calls[2];
    expect(file).toBe('/usr/bin/git');
    expect(args).toEqual(['status', '--', evil]);
    expect(options).toMatchObject({ cwd: '/tmp', shell: false });
    expect((options.stdio as string[])[0]).toBe('ignore');
    const env = options.env as Record<string, string>;
    expect(env).toMatchObject({
      KEEP: 'x',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      LC_MESSAGES: 'C',
      // W2 fix: the repository's hooks, fsmonitor and submodules off on every call, as config in
      // the environment (a key may hold '='); the filters read first (none here).
      ...configEnv(NO_REPO_CODE, {}),
      // GIT-HARDEN: no transport (a partial clone's lazy fetch).
      ...NO_FETCH_ENV,
    });
    // Whatever picks another repository is gone: git works on the cwd's.
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
  });

  it('W2 fix: a write first reads the repository side’s filter drivers (every scope it has, with includes)', async () => {
    const calls: Spawned[] = [];
    const run = createGitRunner({ gitPath: '/usr/bin/git', spawnFn: fakeSpawn(calls), env: { PATH: '/bin', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'u' } });
    await run('/tmp', ['worktree', 'add', '/tmp/w', '-b', 'task/x']);
    expect(calls.map((c) => c.args)).toEqual([
      ['version'],
      ['config', '--show-scope', '--includes', '--get-regexp', '^(filter|merge)\\.'],
      ['worktree', 'add', '/tmp/w', '-b', 'task/x'],
    ]);
    // The environment's own GIT_CONFIG_* stay; ours come after them.
    const env = calls[2].options.env as Record<string, string>;
    expect([env.GIT_CONFIG_COUNT, env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_KEY_1]).toEqual([String(1 + NO_REPO_CODE.length), 'user.name', 'core.hooksPath']);
  });

  it('W2 fix: the owner’s confirmed commit/push (repoHooks): git as the terminal runs it, nothing read or set', async () => {
    const calls: Spawned[] = [];
    const run = createGitRunner({ gitPath: '/usr/bin/git', spawnFn: fakeSpawn(calls), env: { PATH: '/bin' } });
    await run('/tmp', ['commit', '-m', 'x'], { repoHooks: true });
    expect(calls.map((c) => c.args)).toEqual([['commit', '-m', 'x']]);
    expect((calls[0].options.env as Record<string, string>).GIT_CONFIG_COUNT).toBeUndefined();
  });

  it('W2 fix: which calls may run a filter; every repository-side driver is switched off, keys with = and . too', () => {
    for (const w of [['add', '-A'], ['commit', '-m', 'x'], ['push', 'o', 'r'], ['reset', '-q'], ['branch', '-d', 'x'], ['worktree', 'add', 'p'], ['worktree', 'remove', 'p'], ['-c', 'a=b', 'checkout', 'x'], ['status'], ['-c', 'core.quotepath=off', 'diff'], ['some-new-command']])
      expect(touchesContent(w)).toBe(true);
    for (const r of [['worktree', 'list'], ['rev-parse', 'HEAD'], ['config', '--get', 'x'], ['symbolic-ref', 'HEAD'], ['rev-list', '--count', 'a..b'], []])
      expect(touchesContent(r)).toBe(false);
    const out = ['local\tfilter.evil.smudge sh -c x', 'worktree\tfilter.a=b.clean cat', 'local\tfilter.x.y.process p', 'global\tfilter.lfs.smudge git-lfs smudge', 'system\tfilter.sys.clean c', 'command\tfilter.cmd.clean c'].join('\n');
    const off = (n: string) => [[`filter.${n}.smudge`, ''], [`filter.${n}.clean`, ''], [`filter.${n}.process`, ''], [`filter.${n}.required`, 'false']];
    expect(filterOverrides(out)).toEqual([...off('evil'), ...off('a=b'), ...off('x.y')]);
    expect(filterOverrides('')).toEqual([]);
    // W3: a repository-side merge driver never runs (a conflict instead); merge.ff etc. stay.
    expect(filterOverrides('local\tmerge.evil.driver sh -c x\nlocal\tmerge.ff false\nglobal\tmerge.g.driver g')).toEqual([['merge.evil.driver', 'false']]);
    expect(configEnv([['filter.a=b.smudge', '']], {})).toEqual({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'filter.a=b.smudge', GIT_CONFIG_VALUE_0: '' });
  });

  it('never runs in the daemon cwd: a relative cwd is refused', async () => {
    const calls: Spawned[] = [];
    const run = createGitRunner({ gitPath: '/usr/bin/git', spawnFn: fakeSpawn(calls) });
    await expect(run('.', ['status'])).rejects.toThrow('absolute');
    await expect(run('', ['status'])).rejects.toThrow('absolute');
    expect(calls).toEqual([]);
  });

  it('without git: a Korean RepoError and nothing spawned', async () => {
    const calls: Spawned[] = [];
    const run = createGitRunner({ gitPath: null, spawnFn: fakeSpawn(calls) });
    await expect(run('/tmp', ['status'])).rejects.toBeInstanceOf(GitMissingError);
    await expect(run('/tmp', ['status'])).rejects.toThrow('git을 찾지 못했어요');
    expect(calls).toEqual([]);
  });

  it('gitEnv keeps the rest of the environment and lets the call override', () => {
    const env = gitEnv({ A: '1', GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/x'", GIT_INDEX_FILE: 'x' }, { GIT_TERMINAL_PROMPT: '1' });
    expect(env).toMatchObject({ A: '1', GIT_TERMINAL_PROMPT: '1' });
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
  });

  it('requires git 2.31 before a guarded call, without starting that call on an old version', async () => {
    const calls: Spawned[] = [];
    const run = createGitRunner({ gitPath: '/usr/bin/git', spawnFn: fakeSpawn(calls, 'out\n', 'git version 2.30.2\n') });
    await expect(run('/tmp', ['rev-parse', 'HEAD'])).rejects.toBeInstanceOf(GitTooOldError);
    await expect(run('/tmp', ['rev-parse', 'HEAD'])).rejects.toThrow('git 2.31 이상이 필요해요 (지금 2.30.2)');
    expect(calls.map((c) => c.args)).toEqual([['version']]);
  });

  it('accepts supported git version formats for guarded calls', async () => {
    for (const version of ['2.31.0', '2.34.1', '2.39.2.windows.1', '2.45.0 (Apple Git-154)']) {
      const calls: Spawned[] = [];
      const run = createGitRunner({ gitPath: '/usr/bin/git', spawnFn: fakeSpawn(calls, 'out\n', `git version ${version}\n`) });
      await expect(run('/tmp', ['rev-parse', 'HEAD'])).resolves.toMatchObject({ code: 0 });
      expect(calls.map((c) => c.args)).toEqual([['version'], ['rev-parse', 'HEAD']]);
    }
  });

  it('rejects a guarded call when git version cannot be parsed', async () => {
    const calls: Spawned[] = [];
    const run = createGitRunner({ gitPath: '/usr/bin/git', spawnFn: fakeSpawn(calls, 'out\n', 'git is very new\n') });
    await expect(run('/tmp', ['rev-parse', 'HEAD'])).rejects.toBeInstanceOf(GitTooOldError);
    expect(calls.map((c) => c.args)).toEqual([['version']]);
  });

  it.each([
    { name: 'exits unsuccessfully', first: { out: 'git version 2.34.1\n', code: 1 } },
    { name: 'is unparseable', first: { out: 'git is very new\n', code: 0 } },
  ])('does not cache a version probe that $name', async ({ first }) => {
    const calls: Spawned[] = [];
    const run = createGitRunner({
      gitPath: '/usr/bin/git',
      spawnFn: fakeVersionResults(calls, [first, { out: 'git version 2.34.1\n', code: 0 }]),
    });
    await expect(run('/tmp', ['rev-parse', 'HEAD'])).rejects.toBeInstanceOf(GitTooOldError);
    await expect(run('/tmp', ['rev-parse', 'HEAD'])).resolves.toMatchObject({ code: 0 });
    expect(calls.map((c) => c.args)).toEqual([['version'], ['version'], ['rev-parse', 'HEAD']]);
  });

  it('probes git version once per runner', async () => {
    const calls: Spawned[] = [];
    const run = createGitRunner({ gitPath: '/usr/bin/git', spawnFn: fakeSpawn(calls) });
    await run('/tmp', ['rev-parse', 'HEAD']);
    await run('/tmp', ['log', '-1']);
    expect(calls.map((c) => c.args)).toEqual([['version'], ['rev-parse', 'HEAD'], ['log', '-1']]);
  });

  it.skipIf(!GIT_AVAILABLE)('does not poison a runner when its first guarded cwd is missing', async () => {
    const repo = makeTempRepo();
    const run = createGitRunner();
    try {
      await expect(run(path.join(repo.root, 'missing'), ['rev-parse', 'HEAD'])).rejects.toBeDefined();
      await expect(run(repo.folder, ['rev-parse', 'HEAD'])).resolves.toMatchObject({ code: 0 });
    } finally {
      repo.cleanup();
    }
  });

  it('does not probe before the owner’s repoHooks call', async () => {
    const calls: Spawned[] = [];
    const run = createGitRunner({ gitPath: '/usr/bin/git', spawnFn: fakeSpawn(calls) });
    await run('/tmp', ['commit', '-m', 'x'], { repoHooks: true });
    expect(calls.map((c) => c.args)).toEqual([['commit', '-m', 'x']]);
  });
});

describe.skipIf(!posix)('git runner: limits (a stand-in git script)', () => {
  function script(body: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-gitrun-'));
    cleanup.push(dir);
    const file = path.join(dir, 'git');
    fs.writeFileSync(file, `#!/bin/sh\nif [ "$1" = version ]; then echo 'git version 2.45.0'; exit 0; fi\n${body}\n`, { mode: 0o755 });
    return file;
  }

  it('stops git at maxBytes and says the output is cut', async () => {
    const run = createGitRunner({ gitPath: script('exec yes') });
    const r = await run(os.tmpdir(), ['x'], { maxBytes: 1000 });
    expect(r.capped).toBe(true);
    expect(r.code).toBeNull();
    expect(r.stdout.length).toBeGreaterThanOrEqual(1000);
    expect(r.stdout.length).toBeLessThan(1_000_000);
  });

  it('kills a git that outlives the timeout', async () => {
    const run = createGitRunner({ gitPath: script('exec sleep 30') });
    const started = Date.now();
    const r = await run(os.tmpdir(), ['x'], { timeoutMs: 150 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('returns a failing git as a result with its exit code and stderr', async () => {
    const run = createGitRunner({ gitPath: script('echo "fatal: nope" >&2; exit 128') });
    const r = await run(os.tmpdir(), ['x']);
    expect(r).toMatchObject({ code: 128, stderr: 'fatal: nope', capped: false });
  });
});

describe('no shell anywhere in this folder', () => {
  const dir = __dirname;
  const sources = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'testRepo.ts');

  it('only gitRun.ts starts a process, and only through spawn with shell off', () => {
    expect(sources).toContain('gitRun.ts');
    for (const f of sources) {
      const text = fs.readFileSync(path.join(dir, f), 'utf-8');
      expect(/shell:\s*true/.test(text), `${f}: shell: true`).toBe(false);
      expect(
        // A bare call (not RegExp's `.exec(`): child_process itself is allowed in gitRun.ts only.
        /(?<![.\w])(exec|execSync|execFile|execFileSync|spawnSync|fork)\s*\(/.test(text),
        `${f}: runs a process`,
      ).toBe(false);
      expect(/child_process/.test(text), `${f}: child_process`).toBe(f === 'gitRun.ts');
    }
    expect(fs.readFileSync(path.join(dir, 'gitRun.ts'), 'utf-8')).toContain('shell: false');
  });
});
