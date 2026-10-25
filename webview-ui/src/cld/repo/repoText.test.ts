import { beforeEach, describe, expect, it } from 'vitest';

import type { RepoActionResult, RepoFile, RepoWorktree } from '../../../../core/src/messages.js';
import { setLanguage, t } from '../../i18n/index.js';
import {
  branchLine,
  confirmAction,
  confirmText,
  diffRuns,
  fileLetter,
  groupFiles,
  isConflict,
  pushBlocked,
  type RepoConfirm,
  resultToast,
  worktreeLoss,
  worktreeOfTask,
} from './repoText.js';

beforeEach(() => setLanguage('ko'));

const file = (index: string, worktree: string, path = 'a.txt', origPath?: string): RepoFile => ({
  path,
  index,
  worktree,
  ...(origPath ? { origPath } : {}),
});
const wt = (over: Partial<RepoWorktree> = {}): RepoWorktree => ({
  task: 'login',
  path: '/p/.worktrees/login',
  branch: 'task/login',
  base: 'main',
  created: '2026-10-21T00:00:00.000Z',
  exists: true,
  ahead: 0,
  behind: 0,
  dirty: 0,
  merged: true,
  ...over,
});

describe('groupFiles', () => {
  it('sorts entries into staged, changed, untracked and conflicts; MM is in two', () => {
    const files = [
      file('M', '.', 'staged.txt'),
      file('.', 'M', 'changed.txt'),
      file('M', 'M', 'both.txt'),
      file('.', 'D', 'gone.txt'),
      file('R', '.', 'new.txt', 'old.txt'),
      file('.', '?', 'fresh.txt'),
      file('U', 'U', 'conflict.txt'),
      file('A', 'A', 'both-added.txt'),
    ];
    const g = groupFiles(files);
    expect(g.staged.map((f) => f.path)).toEqual(['staged.txt', 'both.txt', 'new.txt']);
    expect(g.changed.map((f) => f.path)).toEqual(['changed.txt', 'both.txt', 'gone.txt']);
    expect(g.untracked.map((f) => f.path)).toEqual(['fresh.txt']);
    expect(g.conflicts.map((f) => f.path)).toEqual(['conflict.txt', 'both-added.txt']);
    expect(files.filter(isConflict)).toHaveLength(2);
  });

  it('nothing changed is four empty lists', () => {
    expect(groupFiles([])).toEqual({ conflicts: [], staged: [], changed: [], untracked: [] });
  });
});

describe('labels', () => {
  it('the letter of each side, with its Korean name', () => {
    expect(fileLetter(file('M', 'D'), 'staged')).toEqual({ letter: 'M', label: '\uc218\uc815' });
    expect(fileLetter(file('M', 'D'), 'worktree')).toEqual({ letter: 'D', label: '\uc0ad\uc81c' });
    expect(fileLetter(file('.', '?'), 'worktree')).toEqual({ letter: '?', label: '\uc0c8 \ud30c\uc77c' });
    expect(fileLetter(file('X', '.'), 'staged')).toEqual({ letter: 'X', label: 'X' });
  });

  it('the branch line and why push is not offered', () => {
    expect(branchLine({ branch: 'main', upstream: 'origin/main' })).toBe('main → origin/main');
    expect(branchLine({ branch: 'dev', upstream: null })).toBe('dev (upstream \uc5c6\uc74c)');
    expect(branchLine({ branch: null, head: 'abc1234', upstream: null })).toBe(
      '\ubd84\ub9ac\ub41c HEAD abc1234 (upstream \uc5c6\uc74c)',
    );
    expect(branchLine({ branch: null, head: null })).toContain('\ucee4\ubc0b \uc5c6\uc74c');
    expect(pushBlocked({ branch: 'main', upstream: 'origin/main', ahead: 2 })).toBeNull();
    expect(pushBlocked({ branch: 'main', upstream: 'origin/main', ahead: 0 })).toBe(
      '\uc62c\ub9b4 \ucee4\ubc0b \uc5c6\uc74c',
    );
    expect(pushBlocked({ branch: 'main', upstream: null, ahead: null })).toBe('upstream \uc5c6\uc74c');
    expect(pushBlocked({ branch: 'main', upstream: 'origin/main', ahead: null })).toContain(
      '\ucc3e\uc744 \uc218 \uc5c6\uc5b4\uc694',
    );
    expect(pushBlocked({ branch: null, upstream: null, ahead: null })).toBe('\ube0c\ub79c\uce58\uac00 \uc544\ub2c8\uc5d0\uc694');
  });
});

describe('what the confirmation says and sends', () => {
  const cases: Array<[string, RepoConfirm, string, string]> = [
    [
      'stage all',
      { kind: 'stage', project: 'p', count: 3 },
      '\ubcc0\uacbd 3\uac74\uc744 \ubaa8\ub450 \uc2a4\ud14c\uc774\uc9c0\ud560\uae4c\uc694?',
      '\uc2a4\ud14c\uc774\uc9c0',
    ],
    [
      'stage some',
      { kind: 'stage', project: 'p', paths: ['a', 'b'], count: 2 },
      '\uc120\ud0dd\ud55c \ud30c\uc77c 2\uac1c\ub97c \uc2a4\ud14c\uc774\uc9c0\ud560\uae4c\uc694?',
      '\uc2a4\ud14c\uc774\uc9c0',
    ],
    [
      'unstage all',
      { kind: 'unstage', project: 'p', count: 2 },
      '\uc2a4\ud14c\uc774\uc9c0\ub41c \ubcc0\uacbd 2\uac74\uc744 \ubaa8\ub450 \ud574\uc81c\ud560\uae4c\uc694?',
      '\ud574\uc81c',
    ],
    [
      'unstage some',
      { kind: 'unstage', project: 'p', paths: ['a'], count: 1 },
      '\uc120\ud0dd\ud55c \ud30c\uc77c 1\uac1c\uc758 \uc2a4\ud14c\uc774\uc9c0\ub97c \ud574\uc81c\ud560\uae4c\uc694?',
      '\ud574\uc81c',
    ],
    [
      'commit',
      { kind: 'commit', project: 'p', message: 'msg', count: 2 },
      '\uc2a4\ud14c\uc774\uc9c0\ub41c \ud30c\uc77c 2\uac1c\ub97c \ucee4\ubc0b\ud560\uae4c\uc694?',
      '\ucee4\ubc0b',
    ],
    [
      'push',
      { kind: 'push', project: 'p', upstream: 'origin/main', ahead: 2 },
      'origin/main\uc5d0 push\ud560\uae4c\uc694?',
      'push',
    ],
  ];
  it.each(cases)('%s', (_what, confirm, question, button) => {
    const text = confirmText(confirm);
    expect(text).toMatchObject({ question, button, danger: false });
  });

  it('the commit dialog quotes the message, cut when long; push says it is never forced', () => {
    expect(
      confirmText({ kind: 'commit', project: 'p', message: 'Add\n\nthings', count: 1 }).quote,
    ).toBe('Add\n\nthings');
    const long = confirmText({ kind: 'commit', project: 'p', message: 'x'.repeat(500), count: 1 });
    expect(long.quote).toHaveLength(301);
    expect(long.quote?.endsWith('…')).toBe(true);
    expect(
      confirmText({ kind: 'push', project: 'p', upstream: 'origin/main', ahead: 3 }).note,
    ).toBe(`\ucee4\ubc0b 3\uac1c\uac00 \uc62c\ub77c\uac00\uc694. \uac15\uc81c\ub85c \uc62c\ub9ac\uc9c0\ub294 \uc54a\uc544\uc694. ${t('repo.confirm.hooksRun')}`);
  });

  it('N7: commit and push say in one line that the repository’s git hooks run; the automatic writes do not', () => {
    setLanguage('en');
    const line = 'The repository’s git hooks (pre-commit, pre-push and so on) run, as they would in your terminal.';
    expect(confirmText({ kind: 'commit', project: 'p', message: 'm', count: 1 }).note).toBe(line);
    expect(confirmText({ kind: 'push', project: 'p', upstream: 'origin/main', ahead: 1 }).note).toContain(line);
    for (const c of [
      { kind: 'stage', project: 'p', count: 1 },
      { kind: 'worktreeRemove', project: 'p', worktree: wt() },
      { kind: 'worktreeNew', project: 'p', taskId: 'T-1' },
    ] as RepoConfirm[])
      expect(confirmText(c).note ?? '').not.toContain('hooks');
  });

  it('removing a merged, clean worktree is plain; one with work in it is the dangerous kind', () => {
    const clean = confirmText({ kind: 'worktreeRemove', project: 'p', worktree: wt() });
    expect(clean).toMatchObject({
      question: '\uc791\uc5c5 \uacf5\uac04 login\uc744 \uc9c0\uc6b8\uae4c\uc694?',
      button: '\uc9c0\uc6b0\uae30',
      danger: false,
    });
    expect(clean.note).toContain('task/login\ub3c4 \ud568\uaed8 \uc9c0\uc6cc\uc694');

    const unmerged = wt({ ahead: 2, merged: false, dirty: 3 });
    expect(worktreeLoss(unmerged)).toBe('\ubcd1\ud569\ub418\uc9c0 \uc54a\uc740 \ucee4\ubc0b 2\uac1c, \ucee4\ubc0b\ud558\uc9c0 \uc54a\uc740 \ubcc0\uacbd 3\uac74');
    const danger = confirmText({ kind: 'worktreeRemove', project: 'p', worktree: unmerged });
    expect(danger).toMatchObject({ button: '\ubc84\ub9ac\uace0 \uc9c0\uc6b0\uae30', danger: true });
    expect(danger.note).toContain('\ubcd1\ud569\ub418\uc9c0 \uc54a\uc740 \ucee4\ubc0b 2\uac1c');
    expect(danger.note).toContain('\ube0c\ub79c\uce58 task/login\ub294 \ub0a8\uaca8\uc694');

    expect(worktreeLoss(wt({ dirty: 1 }))).toBe('\ucee4\ubc0b\ud558\uc9c0 \uc54a\uc740 \ubcc0\uacbd 1\uac74');
    expect(worktreeLoss(wt({ merged: false }))).toBe('\ubcd1\ud569\ub410\ub294\uc9c0 \uc54c \uc218 \uc5c6\uc5b4\uc694');
    expect(worktreeLoss(wt({ exists: false, ahead: 4, merged: false }))).toBeNull();
    expect(
      confirmText({ kind: 'worktreeRemove', project: 'p', worktree: wt({ exists: false }) }).note,
    ).toBe('\ud3f4\ub354\ub294 \uc774\ubbf8 \uc5c6\uc5b4\uc694. \uae30\ub85d\ub9cc \uc815\ub9ac\ud574\uc694.');
  });

  it('the repoAction a dialog sends: force only when the dialog showed a loss', () => {
    expect(confirmAction({ kind: 'stage', project: 'p', count: 3 })).toEqual({
      action: 'stage',
      project: 'p',
    });
    expect(confirmAction({ kind: 'unstage', project: 'p', paths: ['a'], count: 1 })).toEqual({
      action: 'unstage',
      project: 'p',
      paths: ['a'],
    });
    expect(confirmAction({ kind: 'commit', project: 'p', message: 'm', count: 1 })).toEqual({
      action: 'commit',
      project: 'p',
      message: 'm',
    });
    expect(
      confirmAction({ kind: 'push', project: 'p', upstream: 'origin/main', ahead: 1 }),
    ).toEqual({ action: 'push', project: 'p' });
    expect(confirmAction({ kind: 'worktreeRemove', project: 'p', worktree: wt() })).toEqual({
      action: 'worktreeRemove',
      project: 'p',
      task: 'login',
    });
    expect(
      confirmAction({
        kind: 'worktreeRemove',
        project: 'p',
        worktree: wt({ ahead: 1, merged: false }),
      }),
    ).toEqual({ action: 'worktreeRemove', project: 'p', task: 'login', force: true });
  });
});

describe('result toast', () => {
  const result = (over: Partial<RepoActionResult>): RepoActionResult => ({
    type: 'repoActionResult',
    requestId: 'r',
    action: 'commit',
    project: 'p',
    ok: true,
    ...over,
  });
  it('ok with and without a detail; failure shows the reason', () => {
    expect(resultToast(result({ detail: 'abc1234' }))).toEqual({
      text: '\ucee4\ubc0b\ud588\uc5b4\uc694 · abc1234',
      tone: 'ok',
    });
    expect(resultToast(result({ action: 'push' }))).toEqual({ text: 'push\ud588\uc5b4\uc694', tone: 'ok' });
    expect(resultToast(result({ ok: false, error: '\uc62c\ub9b4 \ucee4\ubc0b\uc774 \uc5c6\uc5b4\uc694' }))).toEqual({
      text: '\uc62c\ub9b4 \ucee4\ubc0b\uc774 \uc5c6\uc5b4\uc694',
      tone: 'error',
    });
    expect(resultToast(result({ ok: false }))).toEqual({ text: '\uc2e4\ud328\ud588\uc5b4\uc694', tone: 'error' });
  });
});

describe('diffRuns', () => {
  it('cuts a unified diff into runs of one kind', () => {
    const diff = [
      'diff --git a/a.txt b/a.txt',
      'index 1..2 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,2 +1,3 @@',
      ' one',
      '-two',
      '+TWO',
      '+three',
      ' tail',
      '',
    ].join('\n');
    expect(diffRuns(diff)).toEqual([
      {
        kind: 'meta',
        text: 'diff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt',
      },
      { kind: 'hunk', text: '@@ -1,2 +1,3 @@' },
      { kind: 'ctx', text: ' one' },
      { kind: 'del', text: '-two' },
      { kind: 'add', text: '+TWO\n+three' },
      { kind: 'ctx', text: ' tail' },
    ]);
  });

  it('empty, a new file, a binary file, a removed line that looks like a header', () => {
    expect(diffRuns('')).toEqual([]);
    expect(diffRuns('new file mode 100644\n@@ -0,0 +1 @@\n+x\n')).toEqual([
      { kind: 'meta', text: 'new file mode 100644' },
      { kind: 'hunk', text: '@@ -0,0 +1 @@' },
      { kind: 'add', text: '+x' },
    ]);
    expect(diffRuns('Binary files a/x and b/x differ\n')).toEqual([
      { kind: 'meta', text: 'Binary files a/x and b/x differ' },
    ]);
    // Inside a hunk only the first character counts: a removed `-- x` is a removed line.
    expect(
      diffRuns('diff --git a/x b/x\n@@ -1 +1 @@\n--- x\n+++ y\n\\ No newline at end of file\n'),
    ).toEqual([
      { kind: 'meta', text: 'diff --git a/x b/x' },
      { kind: 'hunk', text: '@@ -1 +1 @@' },
      { kind: 'del', text: '--- x' },
      { kind: 'add', text: '+++ y' },
      { kind: 'meta', text: '\\ No newline at end of file' },
    ]);
    // Text is kept whole: runs joined by newlines give the diff back.
    const text = '@@ -1 +1 @@\n-a\n+b\n c';
    expect(
      diffRuns(text)
        .map((r) => r.text)
        .join('\n'),
    ).toBe(text);
  });
});

describe('W2: a Task worktree', () => {
  beforeEach(() => setLanguage('en'));
  const ask: RepoConfirm = { kind: 'worktreeNew', project: 'p', taskId: 'T-3', assignee: 'p-w1' };

  it('asks with the Task, the base and who gets it; sends taskId, assignee and base only when given', () => {
    expect(confirmText(ask)).toEqual({
      question: 'Create a worktree for Task T-3?',
      note: 'A new branch task/… starts from the main branch, in a folder under the project’s .worktrees/. It goes to p-w1. A running session is not moved; it starts in this folder next time.',
      button: 'Create worktree',
      danger: false,
    });
    expect(confirmText({ ...ask, assignee: undefined, base: 'dev' }).note).toBe(
      'A new branch task/… starts from dev, in a folder under the project’s .worktrees/.',
    );
    expect(confirmAction(ask)).toEqual({ action: 'worktreeNew', project: 'p', taskId: 'T-3', assignee: 'p-w1' });
    expect(confirmAction({ kind: 'worktreeNew', project: 'p', taskId: 'T-3', base: 'dev' })).toEqual({
      action: 'worktreeNew',
      project: 'p',
      taskId: 'T-3',
      base: 'dev',
    });
    const done: RepoActionResult = { type: 'repoActionResult', requestId: 'r', action: 'worktreeNew', project: 'p', ok: true, detail: 'task/t-3' };
    expect(resultToast(done)).toEqual({ text: 'Worktree created · task/t-3', tone: 'ok' });
  });

  it('finds the worktree made for a Task by its record’s taskId only', () => {
    const list = [wt({ task: 't-3-x', taskId: 'T-3', assignee: 'p-w1' }), wt({ task: 'codex-1' })];
    expect(worktreeOfTask(list, 'T-3')?.task).toBe('t-3-x');
    expect(worktreeOfTask(list, 'T-4')).toBeUndefined();
    expect(worktreeOfTask(undefined, 'T-3')).toBeUndefined();
    expect(worktreeOfTask(list, undefined)).toBeUndefined();
  });
});
