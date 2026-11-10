import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GitResult, GitRunner } from './gitRun.js';
import { createGitRunner, RepoError } from './gitRun.js';
import { readStatus } from './repoRead.js';
import { commit, MAX_PATHS, push, stagePaths } from './repoWrite.js';
import type { TempRepo } from './testRepo.js';
import { GIT_AVAILABLE, makeTempRepo, recording } from './testRepo.js';

// Every test here runs real git processes (a dozen or more each, the diff test a 2.5 MB diff); on a
// starved CPU (the deploy gate: two nice'd cores) that outlasts the 10 s default while nothing is wrong.
vi.setConfig({ testTimeout: 60_000 });

const repos: TempRepo[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.cleanup();
});
const temp = (opts?: Parameters<typeof makeTempRepo>[0]) => {
  const repo = makeTempRepo(opts);
  repos.push(repo);
  return repo;
};

const status = (r: TempRepo, run: GitRunner = r.run) => readStatus(run, r.folder, Infinity);
const porcelain = (r: TempRepo) => r.git(['status', '--porcelain=v1', '--untracked-files=all']);
const head = (r: TempRepo, cwd?: string) => r.git(['rev-parse', 'HEAD'], cwd).trim();
const remoteMain = (r: TempRepo) => r.git(['rev-parse', 'refs/heads/main'], r.remote).trim();
const sortedLines = (s: string) => s.split('\n').filter(Boolean).sort();

describe.skipIf(!GIT_AVAILABLE)('stage and unstage (temp repos)', () => {
  const stage = async (r: TempRepo, paths?: string[], unstage = false) =>
    stagePaths(r.run, r.folder, await status(r), paths, unstage);

  it('all: modified, deleted and new files', async () => {
    const r = temp();
    r.write('a.txt', 'one\ntwo\n');
    fs.rmSync(path.join(r.folder, 'sub/b.txt'));
    r.write('new.txt', 'n\n');
    expect(await stage(r)).toEqual({ detail: '3건' });
    expect(sortedLines(porcelain(r))).toEqual(['A  new.txt', 'D  sub/b.txt', 'M  a.txt']);
  });

  it('selected: only those, the rest stay as they are', async () => {
    const r = temp();
    r.write('a.txt', 'one\ntwo\n');
    r.write('x.txt', 'x\n');
    r.write('y.txt', 'y\n');
    expect(await stage(r, ['x.txt', 'a.txt'])).toEqual({ detail: '2건' });
    expect(sortedLines(porcelain(r))).toEqual(['?? y.txt', 'A  x.txt', 'M  a.txt']);
  });

  it('a new folder, as the status shows it (docs/), stages the files inside', async () => {
    const r = temp();
    r.write('docs/guide.md', '# g\n');
    r.write('docs/deep/more.md', '# m\n');
    expect(await stage(r, ['docs/'])).toEqual({ detail: '1건' });
    expect(sortedLines(porcelain(r))).toEqual(['A  docs/deep/more.md', 'A  docs/guide.md']);
  });

  it('a deleted file stages its deletion', async () => {
    const r = temp();
    fs.rmSync(path.join(r.folder, 'a.txt'));
    await stage(r, ['a.txt']);
    expect(porcelain(r)).toBe('D  a.txt\n');
  });

  it('unstage: selected, then all; a rename comes apart as a whole', async () => {
    const r = temp();
    r.write('a.txt', 'one\ntwo\n');
    r.git(['add', 'a.txt']);
    r.git(['mv', 'sub/b.txt', 'sub/c.txt']);
    expect(sortedLines(porcelain(r))).toEqual(['M  a.txt', 'R  sub/b.txt -> sub/c.txt']);
    await stage(r, ['a.txt'], true);
    expect(sortedLines(porcelain(r))).toEqual([' M a.txt', 'R  sub/b.txt -> sub/c.txt']);
    // Picking the new name takes the old one along: the index is back to HEAD for both.
    await stage(r, ['sub/c.txt'], true);
    expect(sortedLines(porcelain(r))).toEqual([' D sub/b.txt', ' M a.txt', '?? sub/c.txt']);
    await stage(r);
    await stage(r, undefined, true);
    expect(sortedLines(porcelain(r))).toEqual([' D sub/b.txt', ' M a.txt', '?? sub/c.txt']);
  });

  it('works before the first commit', async () => {
    const r = temp({ commit: false });
    r.write('first.txt', 'f\n');
    await stage(r);
    expect(porcelain(r)).toBe('A  first.txt\n');
    await stage(r, undefined, true);
    expect(porcelain(r)).toBe('?? first.txt\n');
  });

  it('a path that is not an entry to stage (or unstage) is refused and nothing changes', async () => {
    const r = temp();
    r.write('a.txt', 'one\ntwo\n');
    r.write('b.txt', 'b\n');
    r.git(['add', 'b.txt']);
    fs.writeFileSync(path.join(r.root, 'outside.txt'), 'o\n');
    const before = porcelain(r);
    for (const bad of [
      'sub/b.txt', // tracked, unchanged
      'b.txt', // already staged: not a candidate to stage
      '../outside.txt',
      path.join(r.root, 'outside.txt'),
      '--all',
      '.',
      '*',
      '',
    ]) {
      await expect(stage(r, ['a.txt', bad])).rejects.toThrow('변경 목록에 없는 파일이에요');
    }
    await expect(stage(r, ['a.txt'], true)).rejects.toThrow('변경 목록에 없는 파일이에요');
    expect(porcelain(r)).toBe(before);
  });

  it('nothing to do, and too many paths', async () => {
    const r = temp();
    await expect(stage(r)).rejects.toThrow('스테이지할 변경이 없어요');
    await expect(stage(r, undefined, true)).rejects.toThrow('스테이지된 변경이 없어요');
    const many = Array.from({ length: MAX_PATHS + 1 }, (_, i) => `f${i}`);
    await expect(stage(r, many)).rejects.toThrow(`${MAX_PATHS}개까지`);
  });

  it('names are literal: a glob or an option-looking name stages only itself', async () => {
    const r = temp();
    for (const n of ['*', '-A', '--all', ':(glob)*.txt', '$(touch pwned)', 'x.txt', 'y.txt']) {
      r.write(n, `${n}\n`);
    }
    await stage(r, ['*', '-A', '--all', ':(glob)*.txt', '$(touch pwned)']);
    const raw = r.git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    expect(raw.split('\0').filter(Boolean).sort()).toEqual(
      [
        '?? x.txt',
        '?? y.txt',
        'A  $(touch pwned)',
        'A  --all',
        'A  -A',
        'A  :(glob)*.txt',
        'A  *',
      ].sort(),
    );
    expect(fs.existsSync(path.join(r.folder, 'pwned'))).toBe(false);
  });

  it('unstaging everything leaves a merge in progress alone', async () => {
    const r = temp();
    r.git(['checkout', '-q', '-b', 'other']);
    r.write('other.txt', 'o\n');
    r.git(['add', '-A']);
    r.git(['commit', '-q', '-m', 'other']);
    r.git(['checkout', '-q', 'main']);
    r.git(['merge', '--no-commit', '--no-ff', 'other']);
    expect(fs.existsSync(path.join(r.folder, '.git/MERGE_HEAD'))).toBe(true);
    await stage(r, undefined, true);
    expect(fs.existsSync(path.join(r.folder, '.git/MERGE_HEAD'))).toBe(true);
  });
});

describe.skipIf(!GIT_AVAILABLE)('commit (temp repos)', () => {
  const doCommit = async (r: TempRepo, message: string, run: GitRunner = r.run) =>
    commit(run, r.folder, await status(r, run), message);

  it('commits what is staged and nothing else, with the message as typed', async () => {
    const r = temp();
    r.write('a.txt', 'one\ntwo\n');
    r.write('b.txt', 'b\n');
    r.git(['add', 'b.txt']);
    const out = await doCommit(r, '  Add b\n\nbecause "b" matters — 한글  \n');
    expect(out.detail).toMatch(/^[0-9a-f]{7,}$/);
    expect(r.git(['log', '-1', '--format=%B']).trim()).toBe('Add b\n\nbecause "b" matters — 한글');
    expect(r.git(['show', '--name-only', '--format=', 'HEAD']).trim()).toBe('b.txt');
    expect(porcelain(r)).toBe(' M a.txt\n'); // the unstaged change stays
  });

  it('a message is a value, never an option or shell syntax', async () => {
    const r = temp();
    const messages = [
      '--amend',
      '-F /etc/passwd',
      '$(touch pwned)',
      '`touch pwned`',
      '; touch pwned',
    ];
    for (const [i, m] of messages.entries()) {
      r.write(`f${i}.txt`, 'x\n');
      r.git(['add', `f${i}.txt`]);
      await doCommit(r, m);
      expect(r.git(['log', '-1', '--format=%B']).trim()).toBe(m);
    }
    expect(r.git(['rev-list', '--count', 'HEAD']).trim()).toBe(String(1 + messages.length));
    expect(fs.existsSync(path.join(r.folder, 'pwned'))).toBe(false);
  });

  it('refuses an empty message, a huge one, and nothing staged', async () => {
    const r = temp();
    r.write('a.txt', 'one\ntwo\n');
    await expect(doCommit(r, 'x')).rejects.toThrow('스테이지된 변경이 없어요');
    r.git(['add', 'a.txt']);
    const before = head(r);
    await expect(doCommit(r, '  \n ')).rejects.toThrow('커밋 메시지를 적어 주세요');
    await expect(doCommit(r, 'x'.repeat(10_001))).rejects.toThrow('올바르지 않아요');
    await expect(doCommit(r, 'a\0b')).rejects.toThrow('올바르지 않아요');
    expect(head(r)).toBe(before);
  });

  it('an unresolved conflict is not a staged change', async () => {
    const r = temp();
    r.git(['checkout', '-q', '-b', 'other']);
    r.write('a.txt', 'other\n');
    r.git(['commit', '-q', '-am', 'other']);
    r.git(['checkout', '-q', 'main']);
    r.write('a.txt', 'main\n');
    r.git(['commit', '-q', '-am', 'main']);
    expect(() => r.git(['merge', 'other'])).toThrow();
    await expect(doCommit(r, 'x')).rejects.toThrow('스테이지된 변경이 없어요');
    r.write('a.txt', 'resolved\n');
    r.git(['add', 'a.txt']);
    await expect(doCommit(r, 'merge other')).resolves.toMatchObject({ detail: expect.any(String) });
  });

  it('git’s own reasons come back in Korean: no identity, a hook that says no (N7: the owner’s commit runs the hooks)', async () => {
    const r = temp();
    r.write('a.txt', 'one\ntwo\n');
    r.git(['add', 'a.txt']);
    const hook = path.join(r.folder, '.git/hooks/pre-commit');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, '#!/bin/sh\necho "lint says no" >&2\nexit 1\n', { mode: 0o755 });
    await expect(doCommit(r, 'x')).rejects.toThrow('커밋에 실패했어요: lint says no');
    expect(r.git(['rev-list', '--count', 'HEAD']).trim()).toBe('1'); // the hook ran and stopped it
    fs.rmSync(hook);

    r.git(['config', 'user.useConfigOnly', 'true']);
    const noIdentity = createGitRunner({
      env: {
        PATH: process.env.PATH,
        HOME: path.join(r.root, 'home'),
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_CONFIG_NOSYSTEM: '1',
      },
    });
    const err = await doCommit(r, 'x', noIdentity).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoError);
    expect((err as Error).message).toContain('사용자 이름과 이메일');
  });
});

describe.skipIf(!GIT_AVAILABLE)('push (temp repos)', () => {
  const doPush = async (r: TempRepo, run: GitRunner = r.run) =>
    push(run, r.folder, await status(r, run));
  const commitFile = (r: TempRepo, name = 'c.txt') => {
    r.write(name, `${name}\n`);
    r.git(['add', name]);
    r.git(['commit', '-q', '-m', `add ${name}`]);
  };

  it('pushes the current branch to its upstream', async () => {
    const r = temp();
    commitFile(r);
    commitFile(r, 'd.txt');
    expect(remoteMain(r)).not.toBe(head(r));
    expect((await doPush(r)).detail).toBe('origin/main · 커밋 2개');
    expect(remoteMain(r)).toBe(head(r));
  });

  it('is exactly `push <remote> <branch>:<tracked ref>`: no force, no tags, no -u, no extras', async () => {
    const r = temp();
    commitFile(r);
    const rec = recording(r.run);
    await doPush(r, rec.run);
    const pushes = rec.calls.filter((c) => c[0] === 'push');
    expect(pushes).toEqual([
      [
        'push',
        '--no-follow-tags',
        '--recurse-submodules=no',
        'origin',
        'refs/heads/main:refs/heads/main',
      ],
    ]);
    for (const arg of rec.calls.flat()) {
      expect(arg).not.toMatch(
        /^(-f|--force.*|--mirror|--delete|--all|--tags|-u|--set-upstream|\+.*)$/,
      );
    }
  });

  it('only the tracked ref of the tracked remote, whatever the config would push', async () => {
    const r = temp();
    const other = path.join(r.root, 'other.git');
    r.git(['init', '-q', '--bare', '-b', 'main', other], r.root);
    r.git(['remote', 'add', 'other', other]);
    r.git(['config', 'remote.origin.push', 'refs/heads/*:refs/heads/mirror/*']);
    r.git(['config', 'push.default', 'matching']);
    r.git(['config', 'push.followTags', 'true']);
    // A branch named differently from the ref it tracks, and an annotated tag on the way.
    r.git(['checkout', '-q', '-b', 'work', '--track', 'origin/main']);
    commitFile(r);
    r.git(['tag', '-a', 'v1', '-m', 'v1']);
    const configBefore = fs.readFileSync(path.join(r.folder, '.git/config'), 'utf-8');
    await doPush(r);
    expect(remoteMain(r)).toBe(head(r));
    expect(r.git(['for-each-ref', '--format=%(refname)'], r.remote).trim()).toBe('refs/heads/main');
    expect(r.git(['for-each-ref'], other).trim()).toBe(''); // the other remote saw nothing
    expect(fs.readFileSync(path.join(r.folder, '.git/config'), 'utf-8')).toBe(configBefore);
  });

  it('refuses without an upstream, on a detached HEAD, with nothing to push', async () => {
    const r = temp();
    await expect(doPush(r)).rejects.toThrow('올릴 커밋이 없어요');
    commitFile(r);
    const sha = head(r);
    r.git(['checkout', '-q', '--detach']);
    await expect(doPush(r)).rejects.toThrow('detached HEAD');
    r.git(['checkout', '-q', 'main']);
    r.git(['branch', '--unset-upstream']);
    await expect(doPush(r)).rejects.toThrow('upstream이 없어서');
    expect(remoteMain(r)).not.toBe(sha);
  });

  it('a remote that moved on rejects it, and is not forced', async () => {
    const r = temp();
    const other = r.cloneRemote('other');
    fs.writeFileSync(path.join(other, 'remote.txt'), 'r\n');
    r.git(['add', '-A'], other);
    r.git(['commit', '-q', '-m', 'remote'], other);
    r.git(['push', '-q', 'origin', 'main'], other);
    const theirs = remoteMain(r);
    commitFile(r);
    await expect(doPush(r)).rejects.toThrow('원격에 새 커밋이 있어서 거부됐어요');
    expect(remoteMain(r)).toBe(theirs);
  });

  describe('git’s failures in Korean (stand-in git)', () => {
    const failing = (stderr: string, extra: Partial<GitResult> = {}): GitRunner => {
      const res = (over: Partial<GitResult>): GitResult => ({
        code: 0,
        stdout: Buffer.alloc(0),
        stderr: '',
        capped: false,
        timedOut: false,
        ...over,
      });
      return async (_cwd, args) => {
        if (args[0] === 'config') {
          return res({
            stdout: Buffer.from(args[2].endsWith('.remote') ? 'origin\n' : 'refs/heads/main\n'),
          });
        }
        return res({ code: 1, stderr, ...extra });
      };
    };
    const st = {
      head: 'abc1234',
      branch: 'main',
      upstream: 'origin/main',
      ahead: 1,
      behind: 0,
      files: [],
      truncated: false,
    };
    it.each([
      ['fatal: Authentication failed for https://x/y.git', '인증이 필요해요'],
      [
        "fatal: could not read Username for 'https://x': terminal prompts disabled",
        '인증이 필요해요',
      ],
      ['git@x: Permission denied (publickey).', '인증이 필요해요'],
      [
        "fatal: unable to access 'https://x/y.git/': Could not resolve host: x",
        '원격에 연결하지 못했어요',
      ],
      [' ! [rejected]        main -> main (fetch first)', '원격에 새 커밋이 있어서'],
      [
        'remote: error: GH006: Protected branch update failed',
        'push에 실패했어요: remote: error: GH006',
      ],
    ])('%s', async (stderr, korean) => {
      await expect(push(failing(stderr), '/tmp', st)).rejects.toThrow(korean);
    });

    it('a timeout', async () => {
      await expect(push(failing('', { code: null, timedOut: true }), '/tmp', st)).rejects.toThrow(
        '제한 시간',
      );
    });

    it('a tracked remote or ref that is not a plain name never reaches the command line', async () => {
      const config = (remote: string, merge: string): GitRunner =>
        (async (_cwd, args) => ({
          code: 0,
          stdout: Buffer.from(args[2].endsWith('.remote') ? remote : merge),
          stderr: '',
          capped: false,
          timedOut: false,
        })) as GitRunner;
      for (const [remote, merge] of [
        ['--upload-pack=touch pwned', 'refs/heads/main'],
        ['.', 'refs/heads/main'],
        ['origin', '+refs/heads/main'],
        ['origin', 'refs/heads/main:refs/heads/other'],
        ['origin', 'main'],
        ['', 'refs/heads/main'],
      ]) {
        await expect(push(config(remote, merge), '/tmp', st)).rejects.toBeInstanceOf(RepoError);
      }
    });
  });
});
