import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  RepoAction,
  RepoActionResult,
  RepoDiff,
  RepoDiffRequest,
  RepoState,
} from '../../../../core/src/messages.js';
import { setLanguage } from '../../i18n/index.js';
import { stepUpFailedText } from '../auth/authApi.js';
import { cldGetSnapshot, cldHandleMessage, cldResetForTests } from '../officeStore.js';
import {
  diffKey,
  repoAsk,
  repoCancel,
  repoCloseDiff,
  repoConfirmNow,
  repoConnectionLost,
  repoGetSnapshot,
  repoHandleMessage,
  repoRequestDetail,
  repoRequestDiff,
  repoResetForTests,
} from './repoStore.js';
import { mergeHistoryLine } from './repoText.js';

const proved = { ok: true, asked: 0 };
vi.mock('../auth/stepUp.js', () => ({
  requestStepUp: async () => {
    proved.asked++;
    return proved.ok;
  },
}));

const state = (over: Partial<RepoState> = {}): RepoState => ({
  type: 'repoState',
  project: 'alpha',
  ok: true,
  branch: 'main',
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  files: [{ path: 'a.txt', index: '.', worktree: 'M' }],
  ...over,
});
const diff = (requestId: string, over: Partial<RepoDiff> = {}): RepoDiff => ({
  type: 'repoDiff',
  requestId,
  project: 'alpha',
  path: 'a.txt',
  staged: false,
  ok: true,
  text: '',
  ...over,
});
const result = (requestId: string, over: Partial<RepoActionResult> = {}): RepoActionResult => ({
  type: 'repoActionResult',
  requestId,
  action: 'stage',
  project: 'alpha',
  ok: true,
  ...over,
});

beforeEach(() => {
  setLanguage('ko');
  repoResetForTests();
  cldResetForTests();
});

describe('repoState', () => {
  it('keeps the latest state per project', () => {
    const toast = vi.fn();
    repoHandleMessage(state(), toast);
    repoHandleMessage(state({ project: 'beta', branch: 'dev' }), toast);
    repoHandleMessage(state({ ahead: 2 }), toast);
    expect(Object.keys(repoGetSnapshot().states)).toEqual(['alpha', 'beta']);
    expect(repoGetSnapshot().states.alpha.ahead).toBe(2);
    expect(toast).not.toHaveBeenCalled();
  });

  it('routes through the app store: the repo messages never touch the office snapshot', () => {
    const before = cldGetSnapshot();
    cldHandleMessage(state());
    expect(repoGetSnapshot().states.alpha).toBeDefined();
    expect(cldGetSnapshot()).toBe(before);
  });

  it('drops an open diff whose file is no longer changed', () => {
    const send = vi.fn();
    repoHandleMessage(
      state({
        files: [
          { path: 'a.txt', index: '.', worktree: 'M' },
          { path: 'b.txt', index: '.', worktree: 'M' },
        ],
      }),
      vi.fn(),
    );
    repoRequestDiff('alpha', 'a.txt', false, send);
    repoRequestDiff('alpha', 'b.txt', false, send);
    repoRequestDiff('beta', 'a.txt', false, send);
    repoHandleMessage(state({ files: [{ path: 'b.txt', index: '.', worktree: 'M' }] }), vi.fn());
    expect(Object.keys(repoGetSnapshot().diffs).sort()).toEqual(
      [diffKey('alpha', 'b.txt', false), diffKey('beta', 'a.txt', false)].sort(),
    );
  });
});

describe('diff views', () => {
  it('open: one request, loading, then the text; "\ub354 \ubcf4\uae30" asks from nextOffset and adds on', () => {
    const sent: RepoDiffRequest[] = [];
    const send = (m: RepoDiffRequest) => sent.push(m);
    repoRequestDiff('alpha', 'a.txt', false, send);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'repoDiffRequest',
      requestId: expect.any(String),
      project: 'alpha',
      path: 'a.txt',
      staged: false,
    });
    const key = diffKey('alpha', 'a.txt', false);
    expect(repoGetSnapshot().diffs[key]).toEqual({ text: '', loading: true });
    repoRequestDiff('alpha', 'a.txt', false, send); // still loading: ignored
    expect(sent).toHaveLength(1);

    repoHandleMessage(diff(sent[0].requestId, { text: 'first\n', nextOffset: 6 }), vi.fn());
    expect(repoGetSnapshot().diffs[key]).toEqual({
      text: 'first\n',
      nextOffset: 6,
      loading: false,
    });

    repoRequestDiff('alpha', 'a.txt', false, send, true);
    expect(sent[1]).toMatchObject({ offset: 6, path: 'a.txt', staged: false });
    expect(repoGetSnapshot().diffs[key]).toEqual({ text: 'first\n', nextOffset: 6, loading: true });
    repoHandleMessage(diff(sent[1].requestId, { text: 'second\n', limited: true }), vi.fn());
    expect(repoGetSnapshot().diffs[key]).toEqual({
      text: 'first\nsecond\n',
      limited: true,
      loading: false,
    });
    repoRequestDiff('alpha', 'a.txt', false, send, true); // nothing more to ask for
    expect(sent).toHaveLength(2);
  });

  it('staged and unstaged diffs of one file are separate views', () => {
    const send = vi.fn();
    repoRequestDiff('alpha', 'a.txt', false, send);
    repoRequestDiff('alpha', 'a.txt', true, send);
    expect(Object.keys(repoGetSnapshot().diffs)).toHaveLength(2);
    expect(send.mock.calls.map((c) => (c[0] as RepoDiffRequest).staged)).toEqual([false, true]);
  });

  it('an error keeps what was read; a closed view ignores a late answer', () => {
    const sent: RepoDiffRequest[] = [];
    const send = (m: RepoDiffRequest) => sent.push(m);
    const key = diffKey('alpha', 'a.txt', false);
    repoRequestDiff('alpha', 'a.txt', false, send);
    repoHandleMessage(
      diff(sent[0].requestId, { ok: false, error: '\ubcc0\uacbd \ubaa9\ub85d\uc5d0 \uc5c6\ub294 \ud30c\uc77c\uc774\uc5d0\uc694' }),
      vi.fn(),
    );
    expect(repoGetSnapshot().diffs[key]).toEqual({
      text: '',
      loading: false,
      error: '\ubcc0\uacbd \ubaa9\ub85d\uc5d0 \uc5c6\ub294 \ud30c\uc77c\uc774\uc5d0\uc694',
    });

    repoRequestDiff('alpha', 'a.txt', false, send);
    repoCloseDiff('alpha', 'a.txt', false);
    expect(repoGetSnapshot().diffs[key]).toBeUndefined();
    repoHandleMessage(diff(sent[1].requestId, { text: 'late' }), vi.fn());
    expect(repoGetSnapshot().diffs[key]).toBeUndefined();
    repoHandleMessage(diff('not-ours', { text: 'x' }), vi.fn());
    expect(repoGetSnapshot().diffs).toEqual({});
  });
});

describe('writes: ask, confirm, one action, busy, toast', () => {
  const toast = vi.fn();
  beforeEach(() => toast.mockReset());

  it('nothing is sent before the confirmation; \ucde8\uc18c sends nothing at all', () => {
    const send = vi.fn();
    repoAsk({ kind: 'stage', project: 'alpha', count: 2 });
    expect(repoGetSnapshot().confirm).toEqual({ kind: 'stage', project: 'alpha', count: 2 });
    repoCancel();
    expect(repoGetSnapshot().confirm).toBeNull();
    repoConfirmNow(send, true, toast); // nothing to confirm any more
    expect(send).not.toHaveBeenCalled();
    expect(repoGetSnapshot().busy).toEqual({});
  });

  it('confirming sends exactly one repoAction and marks the project busy until its result', () => {
    const sent: RepoAction[] = [];
    repoAsk({ kind: 'commit', project: 'alpha', message: 'Add a', count: 1 });
    repoConfirmNow((m) => sent.push(m), true, toast);
    expect(sent).toEqual([
      {
        type: 'repoAction',
        requestId: expect.any(String),
        action: 'commit',
        project: 'alpha',
        message: 'Add a',
      },
    ]);
    expect(repoGetSnapshot().confirm).toBeNull();
    expect(repoGetSnapshot().busy).toEqual({ alpha: sent[0].requestId });

    // A busy project takes no second action; another project does.
    repoAsk({ kind: 'push', project: 'alpha', upstream: 'origin/main', ahead: 1 });
    expect(repoGetSnapshot().confirm).toBeNull();
    repoAsk({ kind: 'push', project: 'beta', upstream: 'origin/main', ahead: 1 });
    expect(repoGetSnapshot().confirm).toMatchObject({ project: 'beta' });
    repoCancel();

    repoHandleMessage(result('someone-else'), toast); // not ours
    expect(repoGetSnapshot().busy).toEqual({ alpha: sent[0].requestId });
    expect(toast).not.toHaveBeenCalled();
    repoHandleMessage(result(sent[0].requestId, { action: 'commit', detail: 'abc1234' }), toast);
    expect(repoGetSnapshot().busy).toEqual({});
    expect(toast).toHaveBeenCalledWith('alpha', '\ucee4\ubc0b\ud588\uc5b4\uc694 · abc1234', 'ok');
  });

  it('a refusal or failure comes back as an error toast; the project is free again', () => {
    const sent: RepoAction[] = [];
    repoAsk({ kind: 'push', project: 'alpha', upstream: 'origin/main', ahead: 1 });
    repoConfirmNow((m) => sent.push(m), true, toast);
    repoHandleMessage(
      result(sent[0].requestId, {
        action: 'push',
        ok: false,
        error: '\uc77d\uae30 \uc804\uc6a9 \ubaa8\ub4dc\ub77c \uc870\uc791\ud560 \uc218 \uc5c6\uc5b4\uc694',
      }),
      toast,
    );
    expect(toast).toHaveBeenCalledWith('alpha', '\uc77d\uae30 \uc804\uc6a9 \ubaa8\ub4dc\ub77c \uc870\uc791\ud560 \uc218 \uc5c6\uc5b4\uc694', 'error');
    expect(repoGetSnapshot().busy).toEqual({});
  });

  it('a worktree removal sends force only when the dialog showed work that would be lost', () => {
    const sent: RepoAction[] = [];
    const worktree = {
      task: 'x',
      path: '/p/.worktrees/x',
      branch: 'task/x',
      base: 'main',
      created: 'now',
      exists: true,
      ahead: 2,
      behind: 0,
      dirty: 0,
      merged: false,
    };
    repoAsk({ kind: 'worktreeRemove', project: 'alpha', worktree });
    repoConfirmNow((m) => sent.push(m), true, toast);
    expect(sent[0]).toMatchObject({ action: 'worktreeRemove', task: 'x', force: true });
    repoHandleMessage(result(sent[0].requestId, { action: 'worktreeRemove' }), toast);
    repoAsk({
      kind: 'worktreeRemove',
      project: 'alpha',
      worktree: { ...worktree, ahead: 0, merged: true },
    });
    repoConfirmNow((m) => sent.push(m), true, toast);
    expect(sent[1].force).toBeUndefined();
  });

  it('while disconnected nothing is sent or queued, and the user is told', () => {
    const send = vi.fn();
    repoAsk({ kind: 'stage', project: 'alpha', count: 1 });
    repoConfirmNow(send, false, toast);
    expect(send).not.toHaveBeenCalled();
    expect(repoGetSnapshot()).toMatchObject({ confirm: null, busy: {} });
    expect(toast).toHaveBeenCalledWith('alpha', '\uc5f0\uacb0\uc774 \ub04a\uaca8 \ubcf4\ub0b4\uc9c0 \uc54a\uc558\uc5b4\uc694', 'error');
  });

  it('a socket that drops while a write runs: busy is given up on, with a toast', () => {
    repoConnectionLost(toast); // nothing running: silent
    expect(toast).not.toHaveBeenCalled();
    repoAsk({ kind: 'stage', project: 'alpha', count: 1 });
    repoConfirmNow(vi.fn(), true, toast);
    repoConnectionLost(toast);
    expect(repoGetSnapshot().busy).toEqual({});
    expect(toast).toHaveBeenCalledWith('alpha', expect.stringContaining('\uc5f0\uacb0\uc774 \ub04a\uaca8'), 'error');
  });

  it('the app store shows the result as its one toast', () => {
    const sent: RepoAction[] = [];
    repoAsk({ kind: 'stage', project: 'alpha', count: 1 });
    repoConfirmNow((m) => sent.push(m), true, toast);
    cldHandleMessage(result(sent[0].requestId, { detail: '1\uac74' }));
    expect(cldGetSnapshot().toast).toMatchObject({
      name: 'alpha',
      text: '\uc2a4\ud14c\uc774\uc9c0\ud588\uc5b4\uc694 · 1\uac74',
      tone: 'ok',
    });
  });
});

describe('W3 merge: a protected branch from a remote device', () => {
  beforeEach(() => repoResetForTests());
  const wt = { task: 't1-x', path: '/p/.worktrees/t1-x', branch: 'task/t1-x', base: 'main', created: '', exists: true, ahead: 1, behind: 0, dirty: 0, merged: false };
  it('a `stepup` answer proves the device and sends the same merge once more; a second one is the end', async () => {
    const sent: RepoAction[] = [];
    const toast = vi.fn();
    repoAsk({ kind: 'merge', project: 'alpha', worktree: wt });
    repoConfirmNow((m) => sent.push(m), true, toast);
    expect(sent[0]).toMatchObject({ action: 'merge', project: 'alpha', task: 't1-x' });
    const answer = (requestId: string, error?: string): RepoActionResult => ({ type: 'repoActionResult', requestId, action: 'merge', project: 'alpha', ok: !error, ...(error && { error }) });
    repoHandleMessage(answer(sent[0].requestId, 'stepup'), toast);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(proved.asked).toBe(1);
    expect(sent[1]).toMatchObject({ action: 'merge', task: 't1-x' });
    expect(repoGetSnapshot().busy.alpha).toBe(sent[1].requestId);
    repoHandleMessage(answer(sent[1].requestId, 'stepup'), toast);
    expect(repoGetSnapshot().busy.alpha).toBeUndefined();
    expect(toast).toHaveBeenCalledWith('alpha', stepUpFailedText(), 'error');
    expect(sent).toHaveLength(2);
  });
});

describe('W4 task worktree detail', () => {
  beforeEach(() => repoResetForTests());

  it('the detail and a task file diff are kept; a status poll does not drop the task diff', () => {
    const toast = vi.fn();
    const sentDetail: Array<{ requestId: string }> = [];
    const sentDiff: RepoDiffRequest[] = [];
    repoHandleMessage(state(), toast);
    repoRequestDetail('alpha', 't1', (m) => sentDetail.push(m));
    repoHandleMessage(
      { type: 'repoWorktreeDetail', requestId: sentDetail[0].requestId, project: 'alpha', task: 't1', ok: true, files: [{ path: 'x/y.txt', status: 'M' }], commits: [], guard: 'g' },
      toast,
    );
    expect(repoGetSnapshot().details['alpha\0t1']).toMatchObject({ loading: false, files: [{ path: 'x/y.txt' }], guard: 'g' });
    repoRequestDiff('alpha', 'x/y.txt', false, (m) => sentDiff.push(m), false, 't1');
    expect(sentDiff[0]).toMatchObject({ task: 't1', path: 'x/y.txt' });
    repoHandleMessage(diff(sentDiff[0].requestId, { path: 'x/y.txt', task: 't1', text: '+z' }), toast);
    repoHandleMessage(state({ files: [] }), toast); // the project's own file list has no x/y.txt
    expect(repoGetSnapshot().diffs[diffKey('alpha', 'x/y.txt', false, 't1')]?.text).toBe('+z');
    // An answer nobody asked for is ignored.
    repoHandleMessage({ type: 'repoWorktreeDetail', requestId: 'zz', project: 'alpha', task: 't2', ok: true }, toast);
    expect(repoGetSnapshot().details['alpha\0t2']).toBeUndefined();
  });

  it('a history line names the worktree and what happened', () => {
    const line = mergeHistoryLine({ ok: false, at: '2026-10-24T09:05:00.000Z', target: 'main', auto: true, task: 't1', error: 'x' });
    expect(line).toContain('t1');
    expect(line).toContain('x');
  });
});
