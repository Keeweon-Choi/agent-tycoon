import { describe, expect, it } from 'vitest';

import {
  branchFromTitle,
  checkBranchName,
  folderOfBranch,
  MAX_BRANCH_NAME,
  shortId,
  taskBranch,
  tidySlug,
  uniqueBranch,
} from './branchName.js';

describe('checkBranchName', () => {
  it.each(['feat/iso-outdoor-billboard', 'fix/engine-typist-stale-input', 'chore/codex-task-a1b2c3', 'docs/x'])(
    'accepts %s',
    (n) => expect(checkBranchName(n)).toBeNull(),
  );

  it.each([
    ['no type', 'iso-billboard'],
    ['unknown type', 'task/foo'],
    ['upper case', 'feat/Iso-Billboard'],
    ['space', 'feat/iso billboard'],
    ['Hangul', 'feat/한글'],
    ['dot', 'feat/a.b'],
    ['underscore', 'feat/a_b'],
    ['double hyphen', 'feat/a--b'],
    ['trailing hyphen', 'feat/a-'],
    ['leading hyphen', 'feat/-a'],
    ['two slashes', 'feat/a/b'],
    ['dot dot', 'feat/../x'],
    ['empty rest', 'feat/'],
    ['too long', `feat/${'a'.repeat(MAX_BRANCH_NAME)}`],
  ])('refuses %s with a reason', (_why, n) => expect(checkBranchName(n)).toEqual(expect.any(String)));

  it('the longest name still passes, one more does not', () => {
    const edge = `feat/${'a'.repeat(MAX_BRANCH_NAME - 5)}`;
    expect(edge).toHaveLength(MAX_BRANCH_NAME);
    expect(checkBranchName(edge)).toBeNull();
    expect(checkBranchName(`${edge}a`)).not.toBeNull();
  });
});

describe('folderOfBranch', () => {
  it('turns the slash into a hyphen', () =>
    expect(folderOfBranch('feat/iso-outdoor-billboard')).toBe('feat-iso-outdoor-billboard'));
});

describe('branchFromTitle', () => {
  it('a Conventional title keeps its type and scope', () => {
    expect(branchFromTitle('feat(iso): draw the billboard')).toBe('feat/iso-draw-the-billboard');
    expect(branchFromTitle('fix(engine)!: Typist STALE input')).toBe('fix/engine-typist-stale-input');
    expect(branchFromTitle('docs: explain names')).toBe('docs/explain-names');
  });

  it('a Conventional title with no English after the colon gets task and a short id', () => {
    const t = 'feat(iso): 간판 그리기';
    expect(branchFromTitle(t)).toBe(`feat/iso-task-${shortId(t)}`);
  });

  it('a plain English title becomes chore/codex-<words>, at most five of them', () => {
    expect(branchFromTitle('Rules for the Billboard, again and again please')).toBe(
      'chore/codex-rules-for-the-billboard-again',
    );
    expect(branchFromTitle('# Fix it')).toBe('chore/codex-fix-it');
  });

  it('a title with no English at all gets chore/codex-task-<short id>, never a time', () => {
    const t = '간판 그리기';
    const n = branchFromTitle(t);
    expect(n).toBe(`chore/codex-task-${shortId(t)}`);
    expect(n).toMatch(/^chore\/codex-task-[0-9a-f]{6}$/);
    expect(branchFromTitle(t)).toBe(n);
    expect(branchFromTitle('다른 제목')).not.toBe(n);
  });

  it('an unknown "type" is just words', () => expect(branchFromTitle('wip(x): y')).toBe('chore/codex-wip-x-y'));

  it('every result is a valid name within the limit, however long or odd the title', () => {
    for (const t of [
      `feat(${'scope'.repeat(20)}): ${'word '.repeat(30)}`,
      'x'.repeat(200),
      `chore: ${'y'.repeat(200)}`,
      '',
      '   ',
      'Ünïcödé ✓ ../ && rm -rf /',
      'FIX(A_B.C): D/E\\F',
    ]) {
      const n = branchFromTitle(t);
      expect(checkBranchName(n)).toBeNull();
      expect(n.length).toBeLessThanOrEqual(MAX_BRANCH_NAME);
    }
  });
});

describe('tidySlug', () => {
  it.each([
    ['Fix the Login page!', 'fix-the-login-page'],
    ['  --x__y..z  ', 'x-y-z'],
    ['../x', 'x'],
    ['A', 'a'],
    ['로그인', ''],
    [undefined, ''],
  ])('%j -> %j', (t, s) => expect(tidySlug(t)).toBe(s));
  it('is cut at 30 without a trailing hyphen', () => expect(tidySlug(`${'a'.repeat(29)} b`)).toBe('a'.repeat(29)));
});

describe('taskBranch', () => {
  it('feat/<task number>-<slug> by default; the number stays so the Task is found', () => {
    expect(taskBranch('T-0042', 'Login page')).toBe('feat/t0042-login-page');
    expect(taskBranch('T-9', undefined, 'API')).toBe('feat/t9-api');
  });
  it('a Conventional title gives the type and drops the prefix from the slug', () =>
    expect(taskBranch('T-7', 'fix(ui): stale input')).toBe('fix/t7-stale-input'));
  it('a Hangul-only title gives the slug task, never an empty one', () => {
    expect(taskBranch('T-8', '로그인')).toBe('feat/t8-task');
    expect(taskBranch('T-8', undefined)).toBe('feat/t8-task');
  });
  it('a typed slug is tidied, and wins over the title', () =>
    expect(taskBranch('T-1', 'Login', '../My Slug')).toBe('feat/t1-my-slug'));
  it('stays valid for odd ids and long titles', () => {
    for (const [id, t] of [['a.b_c', 'x'], ['Z'.repeat(41), 'y'.repeat(100)], ['T-1', 'word '.repeat(40)]]) {
      const n = taskBranch(id, t);
      expect(checkBranchName(n)).toBeNull();
    }
  });
});

describe('uniqueBranch', () => {
  it('a free name is kept', async () => expect(await uniqueBranch('feat/a', () => false)).toBe('feat/a'));
  it('a taken name gets -2, then -3', async () => {
    const taken = new Set(['feat/a']);
    expect(await uniqueBranch('feat/a', (b) => taken.has(b))).toBe('feat/a-2');
    taken.add('feat/a-2');
    expect(await uniqueBranch('feat/a', (b) => taken.has(b))).toBe('feat/a-3');
  });
  it('keeps the limit: the base is cut to make room for the suffix', async () => {
    const long = `feat/${'a'.repeat(MAX_BRANCH_NAME - 5)}`;
    const n = await uniqueBranch(long, (b) => b === long);
    expect(n).toHaveLength(MAX_BRANCH_NAME);
    expect(n.endsWith('-2')).toBe(true);
    expect(checkBranchName(n)).toBeNull();
  });
  it('waits for an async check', async () => expect(await uniqueBranch('fix/x', async (b) => b === 'fix/x')).toBe('fix/x-2'));
});
