import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RepoActionResult, RepoDiff, RepoState } from '../../../../../core/src/messages.js';
import { handleClientMessage } from '../../../clientMessageHandler.js';
import { startEngineOffice } from '../../officeTestKit.js';
import { waitFor } from '../../waitKit.js';
import { parseRepoAction, parseRepoDiff, parseRepoView, RepoManager } from './repoManager.js';
import type { TempRepo } from './testRepo.js';
import { GIT_AVAILABLE, makeTempRepo, recording } from './testRepo.js';

// Every test here runs real git processes (a handful to dozens each); on a starved CPU that
// outlasts the 10 s default while nothing is wrong.
vi.setConfig({ testTimeout: 60_000 });

const savedEnv = { ...process.env };
const repos: TempRepo[] = [];
let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
  for (const r of repos.splice(0)) r.cleanup();
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
});

type Msg = Record<string, unknown>;

/** A RepoManager over a temp repo (project `alpha`), with a recording git. */
function setup(
  opts: { readOnly?: boolean; pollMs?: number; temp?: Parameters<typeof makeTempRepo>[0] } = {},
) {
  const r = makeTempRepo(opts.temp);
  repos.push(r);
  const rec = recording(r.run);
  const logs: string[] = [];
  const mgr = new RepoManager({
    projects: () => [{ name: 'alpha', folder: r.folder }],
    readOnly: opts.readOnly ?? false,
    configDir: path.join(r.root, 'config'),
    run: rec.run,
    pollMs: opts.pollMs ?? 60_000,
    log: (l) => logs.push(l),
  });
  cleanup.push(() => mgr.dispose());
  const sent: Msg[] = [];
  const send = (m: Msg) => void sent.push(m);
  const ofType = <T>(type: string) => sent.filter((m) => m.type === type) as unknown as T[];
  let n = 0;
  /** Send a message as a client and wait for the answer (repoActionResult / repoDiff). */
  const ask = async (msg: Msg, privileged = true, source?: string) => {
    const requestId = `q${++n}`;
    expect(mgr.onClientMessage({ requestId, ...msg }, send, privileged, source)).toBe(true);
    await waitFor(() => expect(sent.find((m) => m.requestId === requestId)).toBeTruthy());
    return sent.find((m) => m.requestId === requestId)!;
  };
  const act = (action: string, extra: Msg = {}, privileged = true, source?: string) =>
    ask(
      { type: 'repoAction', action, project: 'alpha', ...extra },
      privileged,
      source,
    ) as Promise<unknown> as Promise<RepoActionResult>;
  const writes = () =>
    rec.calls.filter((c) =>
      ['add', 'reset', 'commit', 'push', 'worktree', 'branch'].includes(c[0]),
    );
  return { r, rec, mgr, logs, sent, send, ofType, ask, act, writes };
}

describe('the messages a client may send', () => {
  it('repoView', () => {
    expect(parseRepoView({ type: 'repoView', project: 'a', on: true })).toEqual({
      type: 'repoView',
      project: 'a',
      on: true,
    });
    for (const bad of [
      {},
      { project: '', on: true },
      { project: 'a' },
      { project: 'a', on: 1 },
      { project: 7, on: true },
    ]) {
      expect(parseRepoView({ type: 'repoView', ...bad })).toBeNull();
    }
  });

  it('repoDiffRequest', () => {
    const ok = {
      type: 'repoDiffRequest',
      requestId: 'r',
      project: 'a',
      path: 'x.txt',
      staged: false,
    };
    expect(parseRepoDiff(ok)).toEqual(ok);
    expect(parseRepoDiff({ ...ok, offset: 200 })).toEqual({ ...ok, offset: 200 });
    for (const bad of [
      { requestId: '' },
      { requestId: 'x'.repeat(129) },
      { project: '' },
      { path: '' },
      { path: 'x'.repeat(4097) },
      { staged: 'no' },
      { offset: -1 },
      { offset: 1.5 },
      { offset: '3' },
    ]) {
      expect(parseRepoDiff({ ...ok, ...bad })).toBeNull();
    }
  });

  it('repoAction: known actions only, typed fields only', () => {
    const ok = { type: 'repoAction', requestId: 'r', action: 'commit', project: 'a', message: 'm' };
    expect(parseRepoAction(ok)).toEqual(ok);
    const full = { ...ok, action: 'stage', paths: ['a', 'b'], task: 't', force: true };
    expect(parseRepoAction(full)).toEqual(full);
    expect(parseRepoAction({ ...ok, extra: 'dropped' })).toEqual(ok);
    // W2: a Task's worktree.
    const wt = { ...ok, action: 'worktreeNew', taskId: 'T-1', assignee: 'alpha-w1', base: 'dev' };
    expect(parseRepoAction(wt)).toEqual(wt);
    for (const bad of [
      { action: 'force-push' },
      { action: 'toString' },
      { action: 'worktreeAdd' },
      { taskId: 5 },
      { assignee: ['x'] },
      { base: 'x'.repeat(257) },
      { requestId: '' },
      { project: '' },
      { paths: 'a' },
      { paths: [1] },
      { paths: Array.from({ length: 1001 }, () => 'a') },
      { message: 5 },
      { message: 'x'.repeat(20_001) },
      { task: 5 },
      { force: 'yes' },
    ]) {
      expect(parseRepoAction({ ...ok, ...bad })).toBeNull();
    }
  });
});

describe.skipIf(!GIT_AVAILABLE)('repoAction gates refuse in Korean and never run git', () => {
  it.each<[string, { readOnly?: boolean }, string, Msg, boolean, string]>([
    [
      'read-only daemon',
      { readOnly: true },
      'stage',
      {},
      true,
      '읽기 전용 모드라 조작할 수 없어요',
    ],
    ['unprivileged client', {}, 'stage', {}, false, '이 접속에는 조작 권한이 없어요'],
    ['unknown project', {}, 'push', { project: 'nobody' }, true, '등록된 프로젝트가 아니에요'],
    [
      'a client string that is no project',
      {},
      'commit',
      { project: 'alpha; reboot' },
      true,
      '등록된 프로젝트가 아니에요',
    ],
    [
      'a path where a name should be',
      {},
      'stage',
      { project: '/tmp' },
      true,
      '등록된 프로젝트가 아니에요',
    ],
  ])('%s', async (_what, opts, action, extra, privileged, error) => {
    const { act, rec, r } = setup(opts);
    r.write('a.txt', 'one\ntwo\n');
    const result = await act(action, extra, privileged);
    expect(result).toMatchObject({ type: 'repoActionResult', ok: false, action, error });
    expect(rec.calls).toEqual([]); // not even a status
    expect(r.git(['status', '--porcelain'])).toBe(' M a.txt\n');
  });

  it('refusals are logged as refusals, without the content', async () => {
    const { act, logs, r } = setup({ readOnly: true });
    r.write('secret.txt', 's\n');
    await act('commit', { message: 'top secret plans', paths: ['secret.txt'] });
    expect(logs).toEqual([
      '[cld repo] action commit "alpha": refused (읽기 전용 모드라 조작할 수 없어요)',
    ]);
  });

  it('one write per folder at a time', async () => {
    const { act, r } = setup();
    r.write('a.txt', 'one\ntwo\n');
    r.write('b.txt', 'b\n');
    const first = act('stage', { paths: ['a.txt'] });
    const second = await act('stage', { paths: ['b.txt'] });
    expect(second).toMatchObject({ ok: false, error: 'alpha: 이미 다른 조작이 진행 중이에요' });
    expect(await first).toMatchObject({ ok: true });
    // The lock is released: the next one runs.
    expect(await act('stage', { paths: ['b.txt'] })).toMatchObject({ ok: true });
  });

  it('bad arguments are refused by the action itself, with the repository untouched', async () => {
    const { act, r, writes } = setup();
    r.write('a.txt', 'one\ntwo\n');
    const before = r.git(['rev-parse', 'HEAD']);
    expect(await act('stage', { paths: ['nope.txt'] })).toMatchObject({
      ok: false,
      error: expect.stringContaining('변경 목록에 없는 파일'),
    });
    expect(await act('commit', { message: 'x' })).toMatchObject({
      ok: false,
      error: '스테이지된 변경이 없어요',
    });
    expect(await act('push')).toMatchObject({ ok: false, error: '올릴 커밋이 없어요' });
    expect(await act('worktreeRemove')).toMatchObject({
      ok: false,
      error: '작업 이름을 알려 주세요',
    });
    expect(await act('worktreeRemove', { task: '../x', force: true })).toMatchObject({ ok: false });
    expect(writes()).toEqual([]);
    expect(r.git(['rev-parse', 'HEAD'])).toBe(before);
    expect(r.git(['status', '--porcelain'])).toBe(' M a.txt\n');
  });
});

describe.skipIf(!GIT_AVAILABLE)('stage, commit, push over the client message path', () => {
  it('end to end into the bare remote, one log line each with the device, never the content', async () => {
    const { act, r, logs } = setup();
    const configBefore = fs.readFileSync(path.join(r.folder, '.git/config'), 'utf-8');
    r.write('a.txt', 'one\ntwo\n');
    r.write('new.txt', 'n\n');
    expect(await act('stage', { paths: ['a.txt'] }, true, 'gui:ios')).toMatchObject({
      ok: true,
      detail: '1건',
    });
    expect(r.git(['status', '--porcelain'])).toBe('M  a.txt\n?? new.txt\n');
    expect(await act('stage', {}, true, 'gui:ios')).toMatchObject({ ok: true, detail: '1건' });
    expect(await act('unstage', { paths: ['new.txt'] }, true, 'gui:ios')).toMatchObject({
      ok: true,
    });
    expect(await act('stage', {}, true, 'gui:ios')).toMatchObject({ ok: true });
    const committed = await act(
      'commit',
      { message: 'Add things\n\nsecret details' },
      true,
      'gui:ios',
    );
    expect(committed).toMatchObject({
      ok: true,
      detail: expect.stringMatching(/^[0-9a-f]+$/),
    });
    expect(r.git(['log', '-1', '--format=%B']).trim()).toBe('Add things\n\nsecret details');
    expect(r.git(['rev-parse', 'refs/heads/main'], r.remote)).not.toBe(
      r.git(['rev-parse', 'HEAD']),
    );
    const pushed = await act('push', {}, true, 'gui:ios');
    expect(pushed).toMatchObject({ ok: true, detail: 'origin/main · 커밋 1개' });
    expect(r.git(['rev-parse', 'refs/heads/main'], r.remote)).toBe(r.git(['rev-parse', 'HEAD']));
    // Git's config is never written: not by staging, committing or pushing.
    expect(fs.readFileSync(path.join(r.folder, '.git/config'), 'utf-8')).toBe(configBefore);

    expect(logs.map((l) => /action (\w+) "alpha": ok \d+\.\ds gui:ios$/.exec(l)?.[1])).toEqual([
      'stage',
      'stage',
      'unstage',
      'stage',
      'commit',
      'push',
    ]);
    expect(logs[0]).toMatch(/^\[cld repo\] action /);
    const all = logs.join('\n');
    for (const secret of ['secret details', 'Add things', 'a.txt', 'new.txt']) {
      expect(all).not.toContain(secret);
    }
  });

  it('a failure is a result, not an exception; the repository is as it was', async () => {
    const { act, r, logs } = setup();
    const other = r.cloneRemote('other');
    fs.writeFileSync(path.join(other, 'remote.txt'), 'r\n');
    r.git(['add', '-A'], other);
    r.git(['commit', '-q', '-m', 'remote'], other);
    r.git(['push', '-q', 'origin', 'main'], other);
    r.write('c.txt', 'c\n');
    await act('stage');
    await act('commit', { message: 'local' });
    const theirs = r.git(['rev-parse', 'refs/heads/main'], r.remote);
    const result = await act('push', {}, true, 'gui:linux');
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('원격에 새 커밋이 있어서'),
    });
    expect(r.git(['rev-parse', 'refs/heads/main'], r.remote)).toBe(theirs);
    expect(logs.at(-1)).toMatch(/action push "alpha": failed \d+\.\ds gui:linux$/);
  });
});

describe.skipIf(!GIT_AVAILABLE)('worktreeRemove over the client message path', () => {
  it('asks for the user’s confirmation (force) before losing work, never before that', async () => {
    const { act, mgr, r } = setup();
    const project = mgr.project('alpha')!;
    await mgr.worktrees.create(project, 'feat');
    const wtDir = path.join(r.folder, '.worktrees/feat');
    fs.writeFileSync(path.join(wtDir, 'w.txt'), 'w\n');
    r.git(['add', 'w.txt'], wtDir);
    r.git(['commit', '-q', '-m', 'work'], wtDir);

    const refused = await act('worktreeRemove', { task: 'feat' });
    expect(refused).toMatchObject({ ok: false, needsForce: true });
    expect(fs.existsSync(wtDir)).toBe(true);

    const done = await act('worktreeRemove', { task: 'feat', force: true });
    expect(done).toMatchObject({ ok: true, detail: '브랜치 task/feat는 병합되지 않아 남겼어요' });
    expect(done.needsForce).toBeUndefined();
    expect(fs.existsSync(wtDir)).toBe(false);

    await mgr.worktrees.create(project, 'clean');
    expect(await act('worktreeRemove', { task: 'clean' })).toMatchObject({
      ok: true,
      detail: '브랜치도 지웠어요',
    });
  });

  it('read-only daemon: removal refused like every write', async () => {
    const { act, mgr, r } = setup({ readOnly: true });
    await mgr.worktrees.create(mgr.project('alpha')!, 'feat'); // the API itself is for jobs, not gated
    expect(await act('worktreeRemove', { task: 'feat', force: true })).toMatchObject({
      ok: false,
      error: '읽기 전용 모드라 조작할 수 없어요',
    });
    expect(fs.existsSync(path.join(r.folder, '.worktrees/feat'))).toBe(true);
  });
});

describe.skipIf(!GIT_AVAILABLE)('repoView: the state while a panel is open', () => {
  it('sends the state at once, again only when it changed, and stops when nobody looks', async () => {
    const { mgr, r, send, ofType, rec } = setup({ pollMs: 40 });
    mgr.onClientMessage({ type: 'repoView', project: 'alpha', on: true }, send, true);
    await waitFor(() => expect(ofType<RepoState>('repoState')).toHaveLength(1));
    const first = ofType<RepoState>('repoState')[0];
    expect(first).toMatchObject({
      project: 'alpha',
      ok: true,
      branch: 'main',
      upstream: 'origin/main',
      files: [],
      worktrees: [],
    });
    await new Promise((res) => setTimeout(res, 200)); // several polls, nothing changed
    expect(ofType('repoState')).toHaveLength(1);

    r.write('a.txt', 'one\ntwo\n');
    await waitFor(() => expect(ofType('repoState')).toHaveLength(2));
    expect(ofType<RepoState>('repoState')[1].files).toEqual([
      { path: 'a.txt', index: '.', worktree: 'M' },
    ]);

    mgr.onClientMessage({ type: 'repoView', project: 'alpha', on: false }, send, true);
    await waitFor(() => expect(rec.inFlight()).toBe(0)); // a read in flight finishes
    const calls = rec.calls.length;
    await new Promise((res) => setTimeout(res, 200));
    expect(rec.calls.length).toBe(calls); // no git runs for nobody
  });

  it('a second viewer gets the last state at once and shares the polling; closing stops it', async () => {
    const { mgr, ofType, rec } = setup({ pollMs: 40 });
    const a: Msg[] = [];
    const b: Msg[] = [];
    const sendA = (m: Msg) => void a.push(m);
    const sendB = (m: Msg) => void b.push(m);
    mgr.onClientMessage({ type: 'repoView', project: 'alpha', on: true }, sendA, true);
    await waitFor(() => expect(a).toHaveLength(1));
    mgr.onClientMessage({ type: 'repoView', project: 'alpha', on: true }, sendB, true);
    expect(b).toHaveLength(1); // the cached state, synchronously
    expect(b[0]).toEqual(a[0]);
    mgr.onClientClosed(sendA);
    mgr.onClientClosed(sendB);
    await waitFor(() => expect(rec.inFlight()).toBe(0)); // a read in flight finishes
    const calls = rec.calls.length;
    await new Promise((res) => setTimeout(res, 200));
    expect(rec.calls.length).toBe(calls);
    expect(ofType('repoState')).toEqual([]); // `send` of setup() never viewed
  });

  it('a write refreshes the viewers', async () => {
    const { mgr, r, send, ofType, act } = setup();
    mgr.onClientMessage({ type: 'repoView', project: 'alpha', on: true }, send, true);
    await waitFor(() => expect(ofType('repoState')).toHaveLength(1));
    r.write('a.txt', 'one\ntwo\n');
    await act('stage');
    await waitFor(() => {
      const last = ofType<RepoState>('repoState').at(-1)!;
      expect(last.files).toEqual([{ path: 'a.txt', index: 'M', worktree: '.' }]);
      expect(last.statStaged).toContain('a.txt');
    });
  });

  it('shows the worktrees of the project with their status', async () => {
    const { mgr, send, ofType } = setup();
    await mgr.worktrees.create(mgr.project('alpha')!, 'feat');
    mgr.onClientMessage({ type: 'repoView', project: 'alpha', on: true }, send, true);
    await waitFor(() => expect(ofType('repoState')).toHaveLength(1));
    expect(ofType<RepoState>('repoState')[0].worktrees).toEqual([
      expect.objectContaining({
        task: 'feat',
        branch: 'task/feat',
        ahead: 0,
        dirty: 0,
        merged: true,
        exists: true,
      }),
    ]);
  });

  it('an unknown project, and a folder that is no repository, say so', async () => {
    const { mgr, send, ofType } = setup();
    mgr.onClientMessage({ type: 'repoView', project: 'nobody', on: true }, send, true);
    expect(ofType('repoState')).toMatchObject([
      { type: 'repoState', project: 'nobody', ok: false, error: '등록된 프로젝트가 아니에요', errorCode: 'project_unregistered' },
    ]);
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-plain-'));
    cleanup.push(() => fs.rmSync(plain, { recursive: true, force: true }));
    const m2 = new RepoManager({
      projects: () => [{ name: 'plain', folder: plain }],
      readOnly: true,
      configDir: path.join(plain, 'cfg'),
      pollMs: 60_000,
    });
    cleanup.push(() => m2.dispose());
    const got: Msg[] = [];
    m2.onClientMessage(
      { type: 'repoView', project: 'plain', on: true },
      (m) => void got.push(m),
      true,
    );
    await waitFor(() => expect(got).toHaveLength(1));
    expect(got[0]).toEqual({
      type: 'repoState',
      project: 'plain',
      ok: false,
      error: '이 폴더는 git 저장소가 아니에요',
    });
  });

  it('an unprivileged client gets nothing, and no git runs', () => {
    const { mgr, send, sent, rec } = setup();
    mgr.onClientMessage({ type: 'repoView', project: 'alpha', on: true }, send, false);
    mgr.onClientMessage(
      { type: 'repoDiffRequest', requestId: 'r', project: 'alpha', path: 'a.txt', staged: false },
      send,
      false,
    );
    expect(sent).toEqual([]);
    expect(rec.calls).toEqual([]);
  });

  it('malformed repo messages are consumed and dropped', () => {
    const { mgr, send, sent } = setup();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(mgr.onClientMessage({ type: 'repoView' }, send, true)).toBe(true);
    expect(mgr.onClientMessage({ type: 'repoAction', action: 'x' }, send, true)).toBe(true);
    expect(mgr.onClientMessage({ type: 'repoDiffRequest' }, send, true)).toBe(true);
    expect(mgr.onClientMessage({ type: 'statusView', name: 'a', on: true }, send, true)).toBe(
      false,
    );
    expect(sent).toEqual([]);
  });
});

describe.skipIf(!GIT_AVAILABLE)('repoDiffRequest', () => {
  it('answers the sender with the diff, a page at a time; a file that is not changed is refused', async () => {
    const { ask, r } = setup();
    r.write('a.txt', 'one\ntwo\n');
    const diff = (await ask({
      type: 'repoDiffRequest',
      project: 'alpha',
      path: 'a.txt',
      staged: false,
    })) as unknown as RepoDiff;
    expect(diff).toMatchObject({
      type: 'repoDiff',
      project: 'alpha',
      path: 'a.txt',
      staged: false,
      ok: true,
    });
    expect(diff.text).toContain('+two');
    expect(diff.nextOffset).toBeUndefined();
    const bad = (await ask({
      type: 'repoDiffRequest',
      project: 'alpha',
      path: '../a.txt',
      staged: false,
    })) as unknown as RepoDiff;
    expect(bad).toMatchObject({ ok: false, error: '변경 목록에 없는 파일이에요' });
    expect(bad.text).toBeUndefined();
    const nope = (await ask({
      type: 'repoDiffRequest',
      project: 'beta',
      path: 'a.txt',
      staged: false,
    })) as unknown as RepoDiff;
    expect(nope).toMatchObject({ ok: false, error: '등록된 프로젝트가 아니에요' });
  });

  it('reading works on a read-only daemon (only the writes need --allow-actions)', async () => {
    const { ask, r } = setup({ readOnly: true });
    r.write('a.txt', 'one\ntwo\n');
    const diff = (await ask({
      type: 'repoDiffRequest',
      project: 'alpha',
      path: 'a.txt',
      staged: false,
    })) as unknown as RepoDiff;
    expect(diff.ok).toBe(true);
  });
});

describe.skipIf(!GIT_AVAILABLE)('through the office and the real client message handler', () => {
  async function office(readOnly: boolean) {
    const r = makeTempRepo();
    repos.push(r);
    // The engine's alpha works in the temp clone; beta's folder does not exist.
    Object.assign(process.env, { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' });
    const { office: off, store } = await startEngineOffice({
      readOnly,
      projects: [
        { name: 'alpha', folder: r.folder },
        { name: 'beta', folder: '/work/beta' },
      ],
    });
    const sent: Msg[] = [];
    const send = (m: Msg) => void sent.push(m);
    const handle = (msg: Msg, privileged = true, userAgent?: string) =>
      handleClientMessage(msg, send, {
        store,
        cache: null,
        standalone: true,
        privileged,
        userAgent,
      });
    return { r, sent, handle, off };
  }

  it('the engine’s projects are the projects: view, diff, stage — with the device in the log', async () => {
    const { r, sent, handle } = await office(false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    r.write('a.txt', 'one\ntwo\n');
    handle({ type: 'repoView', project: 'alpha', on: true });
    await waitFor(() => expect(sent.find((m) => m.type === 'repoState')).toBeTruthy());
    expect(sent.find((m) => m.type === 'repoState')).toMatchObject({
      project: 'alpha',
      ok: true,
      branch: 'main',
      files: [{ path: 'a.txt', index: '.', worktree: 'M' }],
    });
    handle({ type: 'repoView', project: 'beta', on: true }); // /work/beta is no folder here
    await waitFor(() =>
      expect(sent.find((m) => m.type === 'repoState' && m.project === 'beta')).toMatchObject({
        ok: false,
        error: '폴더가 없어요',
      }),
    );

    const ua = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36';
    handle(
      { type: 'repoAction', requestId: 'q1', action: 'stage', project: 'alpha', paths: ['a.txt'] },
      true,
      ua,
    );
    await waitFor(() =>
      expect(sent.find((m) => m.type === 'repoActionResult')).toMatchObject({
        requestId: 'q1',
        ok: true,
      }),
    );
    expect(r.git(['status', '--porcelain'])).toBe('M  a.txt\n');
    expect(log.mock.calls.map((c) => String(c[0]))).toContainEqual(
      expect.stringMatching(/^\[cld repo\] action stage "alpha": ok \d+\.\ds gui:android$/),
    );
  });

  it('read-only daemon: reads work, a write is refused; an unprivileged client reaches nothing', async () => {
    const { r, sent, handle } = await office(true);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    r.write('a.txt', 'one\ntwo\n');
    handle({ type: 'repoAction', requestId: 'q1', action: 'stage', project: 'alpha' });
    await waitFor(() =>
      expect(sent.find((m) => m.type === 'repoActionResult')).toMatchObject({
        ok: false,
        error: '읽기 전용 모드라 조작할 수 없어요',
      }),
    );
    expect(r.git(['status', '--porcelain'])).toBe(' M a.txt\n');
    handle({
      type: 'repoDiffRequest',
      requestId: 'd1',
      project: 'alpha',
      path: 'a.txt',
      staged: false,
    });
    await waitFor(() =>
      expect(sent.find((m) => m.type === 'repoDiff')).toMatchObject({ ok: true }),
    );

    sent.length = 0;
    handle({ type: 'repoView', project: 'alpha', on: true }, false);
    handle({ type: 'repoAction', requestId: 'q2', action: 'stage', project: 'alpha' }, false);
    handle(
      { type: 'repoDiffRequest', requestId: 'd2', project: 'alpha', path: 'a.txt', staged: false },
      false,
    );
    await new Promise((res) => setTimeout(res, 300));
    expect(sent).toEqual([]);
  });
});
