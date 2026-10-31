import { describe, expect, it } from 'vitest';

import type { RepoWorktree } from '../../../../core/src/messages.js';
import { chipOf, parseFilter, railOrder, shownProject, shownProjects } from './devroomState.js';

const wt = (over: Partial<RepoWorktree> = {}): RepoWorktree => ({
  task: 't',
  path: '/r/.worktrees/t',
  branch: 'task/t',
  base: 'main',
  created: '2026-11-01T00:00:00Z',
  exists: true,
  ahead: 1,
  behind: 0,
  dirty: 0,
  merged: false,
  ...over,
});
const quiet = { attention: false, busy: false, notesSent: false };

describe('chipOf', () => {
  it('takes the strongest state first', () => {
    expect(chipOf({ wt: wt({ conflicts: ['a', 'b'] }), ...quiet, attention: true })).toBe('conflict');
    expect(chipOf({ wt: wt(), ...quiet, attention: true, busy: true })).toBe('approve');
    expect(chipOf({ wt: wt(), task: { status: 'review' }, ...quiet, busy: true })).toBe('review');
    expect(chipOf({ wt: wt(), task: { status: 'doing' }, ...quiet, notesSent: true })).toBe('fixing');
    expect(chipOf({ wt: wt(), task: { status: 'doing' }, ...quiet, busy: true })).toBe('working');
    expect(chipOf({ wt: wt(), ...quiet })).toBe('idle');
  });

  it('calls a worktree merged only with a merge record or a done Task, not a fresh one', () => {
    expect(chipOf({ wt: wt({ ahead: 0, merged: true }), ...quiet })).toBe('idle');
    const merge = { ok: true, at: '2026-11-01T01:00:00Z', target: 'main', auto: false };
    expect(chipOf({ wt: wt({ ahead: 0, merged: true, merge }), ...quiet })).toBe('merged');
    expect(chipOf({ wt: wt({ ahead: 0, merged: true }), task: { status: 'done' }, ...quiet })).toBe('merged');
  });
});

it('railOrder puts the merged ones last, each part as made', () => {
  const rows = [
    { chip: 'merged' as const, wt: wt({ task: 'a', created: '1' }) },
    { chip: 'idle' as const, wt: wt({ task: 'c', created: '3' }) },
    { chip: 'working' as const, wt: wt({ task: 'b', created: '2' }) },
  ];
  expect(railOrder(rows).map((r) => r.wt.task)).toEqual(['b', 'c', 'a']);
});

it('the filter falls back to every project when unreadable or gone', () => {
  expect(parseFilter('{"project":"shop"}')).toBe('shop');
  expect(parseFilter('{bad')).toBeNull();
  expect(parseFilter(null)).toBeNull();
  expect(shownProjects(['shop', 'blog'], 'shop')).toEqual(['shop']);
  expect(shownProjects(['shop', 'blog'], 'gone')).toEqual(['shop', 'blog']);
  expect(shownProject(['shop'], null)).toBe('shop'); // the only project needs no filter
});
