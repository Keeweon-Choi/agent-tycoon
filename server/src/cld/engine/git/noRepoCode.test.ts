/**
 * W2 fix (finding 1): the daemon's git never runs the repository's own code. A temp repository
 * armed with hooks (post-checkout, pre-commit, post-commit, reference-transaction, pre-push),
 * an fsmonitor command and filter drivers in its own config (smudge/clean, one pulled in by
 * `[include] path=`, a long-running `process` one): the same git without our runner's flags
 * runs them (the arming works), and none of them runs on createForTask, D5's create, or the
 * repository panel's reads and writes (status, stage, commit, push, worktree removal).
 */
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mergeBranches } from './merge.js';
import { RepoManager } from './repoManager.js';
import { readStatus } from './repoRead.js';
import type { TempRepo } from './testRepo.js';
import { GIT_AVAILABLE, makeTempRepo } from './testRepo.js';
import { readWorktreeDetail } from './worktreeRead.js';
import { Worktrees } from './worktrees.js';

vi.setConfig({ testTimeout: 60_000 });

const repos: TempRepo[] = [];
const managers: RepoManager[] = [];
afterEach(() => {
  for (const m of managers.splice(0)) m.dispose();
  for (const r of repos.splice(0)) r.cleanup();
});

const HOOKS = ['post-checkout', 'pre-commit', 'post-commit', 'reference-transaction', 'pre-push'];

/** A repository whose hooks, fsmonitor and filters each leave a marker file when they run. */
function armed() {
  const r = makeTempRepo();
  repos.push(r);
  // The files the filters apply to, committed before any driver exists.
  r.write('.gitattributes', '*.txt filter=evil\n*.md filter=inc\n*.dat filter=proc\n');
  r.write('docs.md', 'docs\n');
  r.write('x.dat', 'data\n');
  r.git(['add', '-A']);
  r.git(['commit', '-q', '-m', 'attributes']);
  r.git(['push', '-q']);
  const marks = path.join(r.root, 'marks');
  fs.mkdirSync(marks);
  const touch = (name: string) => `touch '${path.join(marks, name)}'`;
  for (const h of HOOKS)
    fs.writeFileSync(path.join(r.folder, '.git/hooks', h), `#!/bin/sh\n${touch(h)}\nexit 0\n`, { mode: 0o755 });
  const fsmonitor = path.join(r.root, 'fsmonitor.sh');
  fs.writeFileSync(fsmonitor, `#!/bin/sh\n${touch('fsmonitor')}\nexit 1\n`, { mode: 0o755 });
  r.git(['config', 'core.fsmonitor', fsmonitor]);
  r.git(['config', 'filter.evil.smudge', `sh -c "${touch('evil-smudge')}; cat"`]);
  r.git(['config', 'filter.evil.clean', `sh -c "${touch('evil-clean')}; cat"`]);
  r.git(['config', 'filter.evil.required', 'true']);
  r.git(['config', 'filter.proc.process', `sh -c "${touch('proc-process')}; exit 1"`]);
  r.git(['config', 'filter.proc.required', 'false']);
  const included = path.join(r.root, 'included.cfg');
  fs.writeFileSync(
    included,
    // Quoted whole: `;` starts a comment in a config file.
    `[filter "inc"]\n\tsmudge = "sh -c \\"${touch('inc-smudge')}; cat\\""\n\tclean = "sh -c \\"${touch('inc-clean')}; cat\\""\n\trequired = true\n`,
  );
  r.git(['config', 'include.path', included]);
  const ran = () => fs.readdirSync(marks).sort();
  const forget = () => {
    for (const f of fs.readdirSync(marks)) fs.rmSync(path.join(marks, f));
  };
  return { r, ran, forget };
}

describe.skipIf(!GIT_AVAILABLE)('W2 fix: no repository code runs in the daemon’s git', () => {
  it('the arming works: plain git (without the runner’s flags) runs the hook and the filters', () => {
    const { r, ran } = armed();
    // (the `process` driver, which fails, left out here: it would stop the checkout)
    r.git(['-c', 'filter.proc.process=', 'worktree', 'add', '-q', path.join(r.root, 'plain'), '-b', 'plain']);
    expect(ran()).toEqual(expect.arrayContaining(['evil-smudge', 'inc-smudge', 'post-checkout', 'reference-transaction']));
    r.write('x.dat', 'more\n');
    try {
      r.git(['status', '--porcelain']);
    } catch {
      /* a failing process filter may fail status: that it ran is what counts */
    }
    expect(ran()).toContain('proc-process');
  });

  it('createForTask: the worktree is made, the files as committed, nothing of the repository’s ran', async () => {
    const { r, ran } = armed();
    const wt = new Worktrees({ file: path.join(r.root, 'config/worktrees.json'), run: r.run, log: () => undefined });
    const rec = await wt.createForTask({ name: 'p', folder: r.folder }, { taskId: 'T-1', createdBy: 'cli' });
    expect(fs.readFileSync(path.join(rec.path, 'a.txt'), 'utf-8')).toBe('one\n');
    expect(fs.readFileSync(path.join(rec.path, 'docs.md'), 'utf-8')).toBe('docs\n');
    expect(fs.readFileSync(path.join(rec.path, 'x.dat'), 'utf-8')).toBe('data\n');
    expect(ran()).toEqual([]);
  });

  it('D5’s create (a Codex Worker’s task worktree): nothing of the repository’s ran', async () => {
    const { r, ran } = armed();
    const wt = new Worktrees({ file: path.join(r.root, 'config/worktrees.json'), run: r.run, log: () => undefined });
    await wt.create({ name: 'p', folder: r.folder }, 'codex-1024-120000');
    expect(ran()).toEqual([]);
  });

  it('the repository panel (N7): status, stage and removing a worktree run none of it; the owner’s confirmed commit and push run the hooks', async () => {
    const { r, ran, forget } = armed();
    const mgr = new RepoManager({
      projects: () => [{ name: 'alpha', folder: r.folder }],
      readOnly: false,
      configDir: path.join(r.root, 'config'),
      run: r.run,
      pollMs: 60_000,
      log: () => undefined,
    });
    managers.push(mgr);
    let n = 0;
    const act = (action: string, extra: Record<string, unknown> = {}) =>
      mgr.runAction({ type: 'repoAction', requestId: `q${++n}`, action: action as 'stage', project: 'alpha', ...extra }, true);
    const ok = (x: { ok: boolean; error?: string }) => [x.ok, x.error];
    r.write('a.txt', 'changed\n');
    r.write('docs.md', 'changed\n');
    expect(ok(await act('stage'))).toEqual([true, undefined]);
    expect(ran()).toEqual([]); // status and add: nothing of the repository's
    // The process filter fails when it runs (it speaks no protocol): out of the way for the
    // owner's commit, which runs git as the terminal would.
    r.git(['config', '--unset', 'filter.proc.process']);
    expect(ok(await act('commit', { message: 'w2' }))).toEqual([true, undefined]);
    expect(ran()).toEqual(expect.arrayContaining(['pre-commit', 'post-commit']));
    forget();
    expect(ok(await act('push'))).toEqual([true, undefined]);
    expect(ran()).toEqual(expect.arrayContaining(['pre-push']));
    expect(r.git(['show', 'HEAD:a.txt'])).toBe('changed\n');
    await mgr.worktrees.create({ name: 'alpha', folder: r.folder }, 'gone');
    forget();
    expect(ok(await act('worktreeRemove', { task: 'gone' }))).toEqual([true, undefined]);
    expect(ran()).toEqual([]);
  });
});

/** A fresh repository whose `.gitattributes` names `attr` for *.txt, committed, then dirtied. */
function plain(attr: string) {
  const r = makeTempRepo();
  repos.push(r);
  r.write('.gitattributes', `*.txt filter=${attr}\n`);
  r.write('t.txt', 'one\n');
  r.git(['add', '-A']);
  r.git(['commit', '-q', '-m', 'attr']);
  const marks = path.join(r.root, 'marks');
  fs.mkdirSync(marks);
  const cmd = (name: string) => `sh -c 'touch "${path.join(marks, name)}"; cat'`;
  const ran = () => fs.readdirSync(marks).sort();
  const wt = new Worktrees({ file: path.join(r.root, 'config/worktrees.json'), run: r.run, log: () => undefined });
  const project = { name: 'p', folder: r.folder };
  /** createForTask, then a same-size change and status in the main checkout and through list(). */
  const exercise = async (id: string) => {
    const rec = await wt.createForTask(project, { taskId: id, createdBy: 'cli' });
    r.write('t.txt', 'two\n');
    await readStatus(r.run, r.folder);
    await wt.list(project);
    return rec;
  };
  return { r, marks, cmd, ran, wt, project, exercise };
}

describe.skipIf(!GIT_AVAILABLE)('W2 re-verification: every repository-side filter, every scope', () => {
  it('N1: a driver whose name holds “=” (git splits -c at the first =): switched off all the same', async () => {
    const p = plain('a=b');
    p.r.git(['config', 'filter.a=b.smudge', p.cmd('eq-smudge')]);
    p.r.git(['config', 'filter.a=b.clean', p.cmd('eq-clean')]);
    // armed: plain git runs it. A real same-size change: an untouched file is skipped by its
    // stat, so the filter only ran while the commit was still "racily clean" (failed under load).
    p.r.write('t.txt', 'uno\n');
    p.r.git(['add', 't.txt']);
    expect(p.ran()).toEqual(['eq-clean']);
    fs.rmSync(path.join(p.marks, 'eq-clean'));
    await p.exercise('T-1');
    expect(p.ran()).toEqual([]);
  });

  it('N2: config.worktree (extensions.worktreeConfig), in the main checkout and in a linked worktree (list())', async () => {
    const p = plain('w');
    const rec = await p.wt.createForTask(p.project, { taskId: 'T-1', createdBy: 'cli' });
    p.r.git(['config', 'extensions.worktreeConfig', 'true']);
    p.r.git(['config', '--worktree', 'filter.w.clean', p.cmd('main-wtcfg-clean')]);
    p.r.git(['config', '--worktree', 'filter.w.clean', p.cmd('linked-wtcfg-clean')], rec.path);
    p.r.write('t.txt', 'two\n');
    fs.writeFileSync(path.join(rec.path, 't.txt'), 'two\n');
    await readStatus(p.r.run, p.r.folder);
    await p.wt.list(p.project);
    expect(p.ran()).toEqual([]);
    // armed: plain git in each runs its own
    p.r.git(['status', '--porcelain']);
    p.r.git(['status', '--porcelain'], rec.path);
    expect(p.ran()).toEqual(['linked-wtcfg-clean', 'main-wtcfg-clean']);
  });

  it('N2: drivers pulled in by includeIf (gitdir, onbranch)', async () => {
    const p = plain('c');
    const inc = path.join(p.r.root, 'inc.cfg');
    fs.writeFileSync(inc, `[filter "c"]\n\tclean = "${p.cmd('incif-clean').replaceAll('"', '\\"')}"\n\tsmudge = "${p.cmd('incif-smudge').replaceAll('"', '\\"')}"\n`);
    p.r.git(['config', `includeIf.gitdir:${p.r.root}/**.path`, inc]);
    p.r.git(['config', 'includeIf.onbranch:task/**.path', inc]);
    await p.exercise('T-1');
    expect(p.ran()).toEqual([]);
    p.r.git(['status', '--porcelain']);
    expect(p.ran()).toEqual(['incif-clean']);
  });

  it('N3: a submodule’s own filter and fsmonitor never run from the superproject’s status or worktree add', async () => {
    const p = plain('none');
    const sub = path.join(p.r.root, 'subsrc');
    fs.mkdirSync(sub);
    p.r.git(['init', '-q', '-b', 'main', sub], p.r.root);
    fs.writeFileSync(path.join(sub, '.gitattributes'), '*.txt filter=s\n');
    fs.writeFileSync(path.join(sub, 's.txt'), 's\n');
    p.r.git(['add', '-A'], sub);
    p.r.git(['commit', '-q', '-m', 's'], sub);
    p.r.git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'mod']);
    p.r.git(['commit', '-q', '-m', 'mod']);
    const mod = path.join(p.r.folder, 'mod');
    p.r.git(['config', 'filter.s.clean', p.cmd('sub-clean')], mod);
    p.r.git(['config', 'filter.s.smudge', p.cmd('sub-smudge')], mod);
    p.r.git(['config', 'submodule.recurse', 'true']);
    fs.writeFileSync(path.join(mod, 's.txt'), 't\n');
    await readStatus(p.r.run, p.r.folder);
    await p.wt.createForTask(p.project, { taskId: 'T-1', createdBy: 'cli' });
    expect(p.ran()).toEqual([]);
    p.r.git(['status', '--porcelain']);
    expect(p.ran()).toEqual(['sub-clean']);
  });
});

/**
 * GIT-HARDEN: what the repository's config can still name on the daemon's own calls. A temp
 * repository whose `main` (checked out, as pushed) is followed by `feat`, one commit carrying a
 * (fake) signature header: any signature check runs gpg.program. `script(name)` leaves a marker
 * and fails (never waits on stdin).
 */
function signedFeat() {
  const r = makeTempRepo();
  repos.push(r);
  r.write('f.txt', 'f\n');
  r.git(['add', '-A']);
  r.git(['commit', '-q', '-m', 'feat']);
  const body = r.git(['cat-file', 'commit', 'HEAD']).replace(
    /^(committer .*)$/m,
    '$1\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n fake\n -----END PGP SIGNATURE-----',
  );
  const file = path.join(r.root, 'signed.commit');
  fs.writeFileSync(file, body);
  const feat = r.git(['hash-object', '-t', 'commit', '-w', file]).trim();
  r.git(['reset', '-q', '--hard', 'HEAD~1']);
  r.git(['branch', 'feat', feat]);
  const marks = path.join(r.root, 'marks');
  fs.mkdirSync(marks);
  const script = (name: string) => {
    const f = path.join(r.root, `${name}.sh`);
    fs.writeFileSync(f, `#!/bin/sh\ntouch '${path.join(marks, name)}'\nexit 1\n`, { mode: 0o755 });
    return f;
  };
  const ran = () => fs.readdirSync(marks).sort();
  const forget = () => {
    for (const f of fs.readdirSync(marks)) fs.rmSync(path.join(marks, f));
  };
  return { r, feat, script, ran, forget };
}

describe.skipIf(!GIT_AVAILABLE)('GIT-HARDEN: no signature check, no transport on the daemon’s own calls', () => {
  it('log.showSignature + gpg.program: the compare view reads the branch’s log, gpg never runs', async () => {
    const { r, feat, script, ran, forget } = signedFeat();
    r.git(['config', 'log.showSignature', 'true']);
    r.git(['config', 'gpg.program', script('gpg')]);
    // armed: plain git (statusReport's and worktreeRead's `log --format`) runs it
    r.git(['log', '-5', '--format=%H%x1f%s', 'feat']);
    expect(ran()).toEqual(['gpg']);
    forget();
    const d = await readWorktreeDetail(r.run, r.folder, { path: path.join(r.root, 'none'), branch: 'feat', base: 'main', exists: false });
    expect(d.commits.map((c) => c.sha)).toEqual([feat]);
    expect(ran()).toEqual([]);
  });

  it('merge.verifySignatures + gpg.program: the merge fast-forwards, gpg never runs', async () => {
    const { r, feat, script, ran, forget } = signedFeat();
    r.git(['config', 'merge.verifySignatures', 'true']);
    r.git(['config', 'gpg.program', script('gpg')]);
    // armed: plain `merge --ff-only` checks the signature (and, gpg failing, refuses)
    expect(() => r.git(['merge', '--ff-only', '--no-stat', 'feat'])).toThrow();
    expect(ran()).toEqual(['gpg']);
    forget();
    expect(await mergeBranches(r.run, r.folder, 'feat', 'main')).toEqual({ ok: true, kind: 'ff', sha: feat });
    expect(ran()).toEqual([]);
  });

  it('a partial clone’s lazy fetch (a ref on a missing object, an ext:: promisor remote): no transport runs', async () => {
    const { r, script, ran, forget } = signedFeat();
    r.git(['config', 'core.repositoryformatversion', '1']);
    r.git(['config', 'extensions.partialClone', 'evil']);
    r.git(['config', 'remote.evil.promisor', 'true']);
    r.git(['config', 'protocol.ext.allow', 'always']);
    r.git(['config', 'remote.evil.url', `ext::${script('ext')} %S`]);
    // An edit, not a git command: the ref names an object nobody has.
    fs.writeFileSync(path.join(r.folder, '.git/refs/heads/ghost'), `${'1'.repeat(40)}\n`);
    // armed: plain git (and a `protocol.allow=never` override, which the repository's
    // protocol.ext.allow outranks) fetches it from the promisor remote
    expect(() => r.git(['-c', 'protocol.allow=never', 'rev-parse', '--verify', '-q', 'refs/heads/ghost^{commit}'])).toThrow();
    expect(ran()).toEqual(['ext']);
    forget();
    expect(await mergeBranches(r.run, r.folder, 'ghost', 'main')).toMatchObject({ ok: false, code: 'no_branch' });
    await expect(readWorktreeDetail(r.run, r.folder, { path: path.join(r.root, 'none'), branch: 'ghost', base: 'main', exists: false })).rejects.toThrow();
    expect(ran()).toEqual([]);
  });
});
