import { describe, expect, it } from 'vitest';

import { agentTree, EMPTY_TRACE, noteTrace, placeSub, type Spot, spotOf, type Trace } from './sidebarTree.js';

const MAIN = '/home/o/shop';
const SPOTS: Spot[] = [
  { key: '', path: MAIN },
  { key: 'feat-cart', path: `${MAIN}/.worktrees/feat-cart` },
  { key: '/home/o/shop/.worktrees/feat-search', path: `${MAIN}/.worktrees/feat-search/` },
];

const trace = (...paths: string[]): Trace => paths.reduce((t, p, i) => noteTrace(t, p, i + 1, 64), EMPTY_TRACE);

describe('spotOf: the longest known worktree prefix', () => {
  it('a worktree inside main is not main; a folder boundary, not a string prefix', () => {
    expect(spotOf(`${MAIN}/src/a.ts`, SPOTS)).toBe('');
    expect(spotOf(`${MAIN}/.worktrees/feat-cart/src/a.ts`, SPOTS)).toBe('feat-cart');
    expect(spotOf(`${MAIN}/.worktrees/feat-cart`, SPOTS)).toBe('feat-cart');
    expect(spotOf(`${MAIN}/.worktrees/feat-search/x`, SPOTS)).toBe('/home/o/shop/.worktrees/feat-search');
    expect(spotOf(`${MAIN}/.worktrees/feat-cartoon/x`, SPOTS)).toBe('');
    expect(spotOf('/home/o/shopping/x', SPOTS)).toBeNull();
    expect(spotOf('/elsewhere', SPOTS)).toBeNull();
  });
});

describe('noteTrace and placeSub', () => {
  it('counts per path; past the cap a new path is dropped, a known one still counts', () => {
    let t = noteTrace(EMPTY_TRACE, '/a', 1, 2);
    t = noteTrace(t, '/b', 2, 2);
    t = noteTrace(t, '/c', 3, 2);
    t = noteTrace(t, '/a', 4, 2);
    expect(t.paths).toEqual({ '/a': { n: 2, at: 4 }, '/b': { n: 1, at: 2 } });
  });
  it('a call clears a permission wait', () => {
    expect(noteTrace({ ...EMPTY_TRACE, perm: true }, '/a', 1, 2).perm).toBe(false);
  });
  it('the worktree touched most wins, a tie goes to the one touched last', () => {
    const cart = `${MAIN}/.worktrees/feat-cart`;
    expect(placeSub(trace(`${MAIN}/CLAUDE.md`, `${cart}/a.ts`, `${cart}/b.ts`), SPOTS, '')).toEqual({ key: 'feat-cart', unknown: false });
    expect(placeSub(trace(`${cart}/a.ts`, `${MAIN}/b.ts`), SPOTS, '')).toEqual({ key: '', unknown: false });
    expect(placeSub(trace(`${MAIN}/b.ts`, `${cart}/a.ts`), SPOTS, '')).toEqual({ key: 'feat-cart', unknown: false });
  });
  it('no evidence (or only paths outside the project): its parent worktree, unknown', () => {
    expect(placeSub(undefined, SPOTS, 'feat-cart')).toEqual({ key: 'feat-cart', unknown: true });
    expect(placeSub(trace('/tmp/x'), SPOTS, '')).toEqual({ key: '', unknown: true });
  });
});

describe('agentTree', () => {
  it('the Lead in main, a Worker on its worktree, each sub-agent where it works or under its lead', () => {
    const traces: Record<string, Trace> = {
      '1:s1': trace(`${MAIN}/.worktrees/feat-cart/src/cart.ts`),
      '1:s2': trace(`${MAIN}/.worktrees/feat-search/q.ts`, `${MAIN}/.worktrees/feat-search/r.ts`),
    };
    const tree = agentTree({
      spots: SPOTS,
      agents: [
        { name: 'shop', folder: MAIN, agentId: 1, dot: 'working' },
        { name: 'web-worker', role: 'worker', folder: MAIN, agentId: 2, dot: 'idle' },
        { name: 'searcher', role: 'worker', folder: `${MAIN}/.worktrees/feat-search`, agentId: null, dot: 'off' },
      ],
      assignees: { 'feat-cart': 'web-worker' },
      codex: [{ key: 'feat-cart', name: 'Mina', dot: 'done' }],
      subs: [
        { key: '1:s1', agentId: 1, desc: 'cart tests', dot: 'working' },
        { key: '1:s2', agentId: 1, desc: 'search fix', dot: 'permission' },
        { key: '1:s3', agentId: 1, desc: 'web look-up', dot: 'done' },
        { key: '2:w1', agentId: 2, desc: 'worker sub', dot: 'idle' },
        { key: '9:x', agentId: 9, desc: 'not ours', dot: 'idle' },
      ],
      trace: (k) => traces[k],
    });
    const ids = (k: string) => tree.get(k)?.map((a) => `${a.role}:${a.id}${a.unknown ? '?' : ''}`);
    expect(ids('')).toEqual(['lead:shop', 'sub:1:s3?']);
    expect(ids('feat-cart')).toEqual(['worker:web-worker', 'run:codex:feat-cart', 'sub:1:s1', 'sub:2:w1?']);
    expect(ids('/home/o/shop/.worktrees/feat-search')).toEqual(['worker:searcher', 'sub:1:s2']);
    expect(tree.get('feat-cart')?.find((a) => a.id === '1:s1')).toMatchObject({ name: 'shop', sub: '1:s1', desc: 'cart tests', dot: 'working' });
  });
});
