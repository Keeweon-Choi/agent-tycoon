/**
 * DEVROOM-PROJECT: 프로젝트 추가's git half. A local bare repository is the clone source, all in a
 * temp dir that is also the host's home (so the picker's rules apply to it); git's config pinned.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProjectRepo, ProjectRepoProgress } from '../../../core/src/messages.js';
import type { GitRunner } from './engine/git/gitRun.js';
import { createGitRunner, findGit, gitEnv } from './engine/git/gitRun.js';
import { EMPTY_GITCONFIG, GIT_AVAILABLE, makeTempRepo, type TempRepo } from './engine/git/testRepo.js';
import { detectHostInfo } from './folders.js';
import { parseProjectRepo, ProjectRepos } from './projectRepo.js';

vi.setConfig({ testTimeout: 60_000 });

const repos: TempRepo[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.cleanup();
});

function setup(opts: { readOnly?: boolean; template?: string; host?: Record<string, unknown> } = {}) {
  const r = makeTempRepo();
  repos.push(r);
  const env = gitEnv({
    ...process.env,
    HOME: path.join(r.root, 'home'),
    GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG,
    GIT_CONFIG_NOSYSTEM: '1',
    ...(opts.template && { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'init.templateDir', GIT_CONFIG_VALUE_0: opts.template }),
  });
  const host = detectHostInfo(r.root, opts.host ? { AGTY_TEST_HOST: JSON.stringify(opts.host) } : {});
  const repos_ = new ProjectRepos({ host, readOnly: !!opts.readOnly, run: createGitRunner({ env }) });
  const projects = path.join(r.root, 'projects');
  fs.mkdirSync(projects);
  const ask = (fields: Omit<ProjectRepo, 'type' | 'requestId'>, privileged = true, remote = false) =>
    repos_.handle({ type: 'projectRepo', requestId: 'r1', ...fields }, privileged, { remote, fresh: () => false });
  return { r, env, projects, ask };
}

describe.skipIf(!GIT_AVAILABLE)('projectRepo', () => {
  it('clones a local bare repository into a new folder, which then checks as a repository', async () => {
    const { r, projects, ask } = setup();
    const res = await ask({ action: 'clone', folder: projects, url: r.remote, name: 'shop' });
    expect(res).toMatchObject({ type: 'projectRepoResult', action: 'clone', ok: true, repo: true, folder: path.join(projects, 'shop') });
    expect(fs.readFileSync(path.join(projects, 'shop', 'a.txt'), 'utf-8')).toBe('one\n');
    expect(await ask({ action: 'check', folder: path.join(projects, 'shop') })).toMatchObject({ ok: true, repo: true });
  });

  it('CLONE-PROGRESS: a real clone reports its phases to the asker', async () => {
    const { r, projects } = setup();
    const seen: ProjectRepoProgress[] = [];
    const repos = new ProjectRepos({ host: detectHostInfo(r.root, {}), readOnly: false, run: r.run });
    const res = await repos.handle({ type: 'projectRepo', requestId: 'p1', action: 'clone', folder: projects, url: r.remote, name: 'shown' }, true, undefined, (p) => seen.push(p));
    expect(res).toMatchObject({ ok: true });
    expect(seen.every((p) => p.type === 'projectRepoProgress' && p.requestId === 'p1')).toBe(true);
    // Each phase at once (the throttle holds only repeats within one phase).
    expect(seen.map((p) => p.phase)).toEqual(expect.arrayContaining(['counting', 'receiving']));
  });

  it('CLONE-PROGRESS: 취소 stops git and removes the half-made folder; only the owner may cancel', async () => {
    const { r, projects } = setup();
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    // A clone that writes half a folder, says where it is, and runs until it is stopped.
    const run: GitRunner = (_cwd, args, opts = {}) =>
      new Promise((resolve) => {
        const target = args.at(-1)!;
        fs.mkdirSync(path.join(target, '.git'), { recursive: true });
        fs.writeFileSync(path.join(target, '.git', 'half.pack'), 'x');
        opts.onStderr?.('Receiving objects:  10% (1/10), 1.00 MiB | 1.00 MiB/s\r');
        expect(opts.detached && opts.protocols && opts.env?.GIT_LFS_SKIP_SMUDGE).toBeTruthy();
        expect(args).toContain('--progress');
        opts.signal?.addEventListener('abort', () =>
          resolve({ code: null, stdout: Buffer.alloc(0), stderr: '', capped: false, timedOut: false }),
        );
        started();
      });
    const repos = new ProjectRepos({ host: detectHostInfo(r.root, {}), readOnly: false, run });
    const seen: ProjectRepoProgress[] = [];
    const done = repos.handle({ type: 'projectRepo', requestId: 'c1', action: 'clone', folder: projects, url: 'https://example.com/big.git', name: 'big' }, true, undefined, (p) => seen.push(p));
    await running;
    expect(fs.existsSync(path.join(projects, 'big'))).toBe(true);
    repos.cancel('c1', false); // a read-only client: ignored
    repos.cancel('nope', true); // not running: nothing
    let settled = false;
    void done.then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    repos.cancel('c1', true);
    expect(await done).toMatchObject({ ok: false, errorCode: 'clone_cancelled' });
    expect(fs.existsSync(path.join(projects, 'big'))).toBe(false);
    expect(seen).toEqual([{ type: 'projectRepoProgress', requestId: 'c1', phase: 'receiving', percent: 10, done: 1, total: 10, size: '1.00 MiB', speed: '1.00 MiB/s' }]);
  });

  it('runs no hook during the clone (an armed template that plain git does run)', async () => {
    const tpl = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-tpl-'));
    try {
      const marker = path.join(tpl, 'ran');
      fs.mkdirSync(path.join(tpl, 'hooks'));
      fs.writeFileSync(path.join(tpl, 'hooks', 'post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
      const { r, env, projects, ask } = setup({ template: tpl });
      // The arming works: git without our runner's guards runs the hook.
      execFileSync(findGit()!, ['clone', '-q', r.remote, path.join(r.root, 'plain-clone')], { env, stdio: 'ignore' });
      expect(fs.existsSync(marker)).toBe(true);
      fs.rmSync(marker);
      expect(await ask({ action: 'clone', folder: projects, url: r.remote, name: 'guarded' })).toMatchObject({ ok: true });
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(tpl, { recursive: true, force: true });
    }
  });

  it('a plain folder is not a repository until git init', async () => {
    const { projects, ask } = setup();
    const plain = path.join(projects, 'plain');
    fs.mkdirSync(plain);
    expect(await ask({ action: 'check', folder: plain })).toMatchObject({ ok: true, repo: false, folder: plain });
    expect(await ask({ action: 'init', folder: plain })).toMatchObject({ ok: true, repo: true });
    expect(fs.existsSync(path.join(plain, '.git'))).toBe(true);
    expect(await ask({ action: 'check', folder: plain })).toMatchObject({ ok: true, repo: true });
  });

  it('a failed clone leaves no half folder behind', async () => {
    const { r, projects, ask } = setup();
    const notRepo = path.join(r.root, 'not-a-repo');
    fs.mkdirSync(notRepo);
    const res = await ask({ action: 'clone', folder: projects, url: notRepo, name: 'broken' });
    expect(res).toMatchObject({ ok: false, errorCode: 'clone_failed' });
    expect(fs.existsSync(path.join(projects, 'broken'))).toBe(false);
  });

  it('refuses protected and outside folders, bad addresses, an existing target', async () => {
    const { r, projects, ask } = setup();
    fs.mkdirSync(path.join(r.root, '.claude'));
    fs.mkdirSync(path.join(projects, 'taken'));
    const no = async (fields: Omit<ProjectRepo, 'type' | 'requestId'>) => (await ask(fields)).errorCode;
    expect(await no({ action: 'check', folder: path.join(r.root, '.claude') })).toBe('folder_forbidden');
    expect(await no({ action: 'init', folder: '/etc' })).toBe('folder_outside');
    expect(await no({ action: 'clone', folder: r.root, url: r.remote, name: '.codex' })).toBe('folder_forbidden');
    expect(await no({ action: 'clone', folder: projects, url: path.join(r.root, '.claude'), name: 'x' })).toBe('folder_forbidden');
    expect(await no({ action: 'clone', folder: projects, url: r.remote, name: 'taken' })).toBe('clone_exists');
    expect(await no({ action: 'clone', folder: projects, url: r.remote, name: '../up' })).toBe('name_slash');
    for (const url of ['--upload-pack=touch /tmp/x', 'ext::sh -c touch% /tmp/x', 'fd::17', 'file:///etc', ''])
      expect(await no({ action: 'clone', folder: projects, url, name: 'y' })).toBe('clone_url_bad');
    expect(fs.readdirSync(projects)).toEqual(['taken']);
  });

  it('clones a work tree folder (its own .git is fine)', async () => {
    const { r, projects, ask } = setup();
    expect(await ask({ action: 'clone', folder: projects, url: r.folder, name: 'from-tree' })).toMatchObject({ ok: true });
    expect(fs.existsSync(path.join(projects, 'from-tree', 'sub', 'b.txt'))).toBe(true);
  });

  it('refuses a folder source whose .git (a symlink or a gitdir: file) is a protected repository', async () => {
    const { r, projects, ask } = setup();
    const secret = path.join(r.root, '.password-store');
    r.git(['init', '-q', secret], r.root);
    fs.writeFileSync(path.join(secret, 'pw.gpg'), 'secret\n');
    r.git(['add', '-A'], secret);
    r.git(['commit', '-q', '-m', 's'], secret);
    const linked = path.join(r.root, 'innocent');
    fs.mkdirSync(linked);
    fs.symlinkSync(path.join(secret, '.git'), path.join(linked, '.git'));
    const filed = path.join(r.root, 'innocent2');
    fs.mkdirSync(filed);
    fs.writeFileSync(path.join(filed, '.git'), `gitdir: ${path.join(secret, '.git')}\n`);
    for (const [url, name] of [[linked, 'a'], [filed, 'b']]) {
      expect((await ask({ action: 'clone', folder: projects, url, name })).errorCode).toBe('folder_forbidden');
      expect(fs.existsSync(path.join(projects, name))).toBe(false);
    }
  });

  it('refuses git init on the home folder or a drive root', async () => {
    const { r, ask } = setup();
    expect((await ask({ action: 'init', folder: r.root })).errorCode).toBe('git_init_root');
    expect(fs.existsSync(path.join(r.root, '.git'))).toBe(false);
    // A WSL host whose /mnt is a temp folder: its drive c is a root too.
    const mnt = path.join(r.root, 'mnt');
    fs.mkdirSync(path.join(mnt, 'c'), { recursive: true });
    const wsl = detectHostInfo(r.root, { AGTY_TEST_HOST: JSON.stringify({ os: 'wsl', mnt }) });
    const drive = new ProjectRepos({ host: wsl, readOnly: false, run: r.run });
    const res = await drive.handle({ type: 'projectRepo', requestId: 'd', action: 'init', folder: path.join(mnt, 'c') }, true);
    expect(res.errorCode).toBe('git_init_root');
    expect(fs.existsSync(path.join(mnt, 'c', '.git'))).toBe(false);
  });

  it('two clones into Foo and foo on a case-folding host: the second is refused while the first runs', async () => {
    const { r, projects, ask } = setup({ host: { caseInsensitive: true } });
    // Either may take the lock first (a folder source awaits a git check before it), so no winner is assumed.
    const both = await Promise.all([
      ask({ action: 'clone', folder: projects, url: r.remote, name: 'Shop' }),
      ask({ action: 'clone', folder: projects, url: r.remote, name: 'shop' }),
    ]);
    const won = both.filter((x) => x.ok);
    expect(won).toHaveLength(1);
    expect(both.find((x) => !x.ok)?.errorCode).toBe('clone_running');
    expect(fs.readdirSync(projects)).toEqual([path.basename(won[0].folder!)]);
  });

  it('wants a privileged client, a writable daemon, and a remote clone a fresh step-up', async () => {
    const { r, projects, ask } = setup();
    expect((await ask({ action: 'check', folder: projects }, false)).errorCode).toBe('no_permission');
    expect((await ask({ action: 'clone', folder: projects, url: r.remote, name: 'z' }, true, true)).error).toBe('stepup');
    const ro = setup({ readOnly: true });
    expect((await ro.ask({ action: 'init', folder: ro.projects })).errorCode).toBe('read_only_mode');
    expect(await ro.ask({ action: 'check', folder: ro.projects })).toMatchObject({ ok: true, repo: false });
  });

  it('parses only well-formed requests', () => {
    expect(parseProjectRepo({ type: 'projectRepo', requestId: 'a', action: 'clone', folder: '/x', url: 'u', name: 'n' })).toMatchObject({ action: 'clone' });
    expect(parseProjectRepo({ type: 'projectRepo', requestId: 'a', action: 'rm', folder: '/x' })).toBeNull();
    expect(parseProjectRepo({ type: 'projectRepo', requestId: 'a', action: 'check' })).toBeNull();
    expect(parseProjectRepo({ type: 'projectRepo', requestId: 'a', action: 'check', folder: '/x', url: 3 })).toBeNull();
  });
});
