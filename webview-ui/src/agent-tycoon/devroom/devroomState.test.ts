import { describe, expect, it } from 'vitest';

import type { EngineProject, RepoWorktree } from '../../../../core/src/messages.js';
import { setProviderCapabilities } from '../../office/toolUtils.js';
import {
  agentsOn,
  type Chip,
  chipOf,
  codexStamp,
  columnOf,
  graphLines,
  parseFilter,
  phoneRows,
  shownProject,
  shownProjects,
  subColumns,
} from './devroomState.js';
import { rememberSubs, sameSubs } from './subagents.js';

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
const quiet = { wait: null, state: 'resting' as const, notesSent: false };

describe('chipOf', () => {
  it('takes the strongest state first', () => {
    expect(chipOf({ wt: wt({ conflicts: ['a', 'b'] }), ...quiet, wait: 'permission' })).toBe('conflict');
    expect(chipOf({ wt: wt(), ...quiet, wait: 'permission', state: 'working' })).toBe('approve');
    expect(chipOf({ wt: wt(), ...quiet, wait: 'question', state: 'working' })).toBe('question');
    expect(chipOf({ wt: wt(), task: { status: 'review' }, ...quiet, state: 'working' })).toBe('review');
    expect(chipOf({ wt: wt(), task: { status: 'doing' }, ...quiet, notesSent: true })).toBe('fixing');
    expect(chipOf({ wt: wt(), task: { status: 'doing' }, ...quiet, state: 'working' })).toBe('working');
    expect(chipOf({ wt: wt(), ...quiet })).toBe('idle');
  });

  it('calls a worktree merged only with a merge record or a done Task, not a fresh one', () => {
    expect(chipOf({ wt: wt({ ahead: 0, merged: true }), ...quiet })).toBe('idle');
    const merge = { ok: true, at: '2026-11-01T01:00:00Z', target: 'main', auto: false };
    expect(chipOf({ wt: wt({ ahead: 0, merged: true, merge }), ...quiet })).toBe('merged');
    expect(chipOf({ wt: wt({ ahead: 0, merged: true }), task: { status: 'done' }, ...quiet })).toBe('merged');
  });
});

it('the filter falls back to every project when unreadable or gone', () => {
  expect(parseFilter('{"project":"shop"}')).toBe('shop');
  expect(parseFilter('{bad')).toBeNull();
  expect(parseFilter(null)).toBeNull();
  expect(shownProjects(['shop', 'blog'], 'shop')).toEqual(['shop']);
  expect(shownProjects(['shop', 'blog'], 'gone')).toEqual(['shop', 'blog']);
  expect(shownProject(['shop'], null)).toBe('shop'); // the only project needs no filter
});

describe('the terminal tab', () => {
  const agent = (name: string, over: Partial<EngineProject> = {}): EngineProject => ({
    name,
    folder: '/r',
    room: 'r',
    wantRunning: true,
    live: true,
    bgId: `bg-${name}`,
    provider: 'claude-pty',
    ...over,
  });
  const engine = [
    agent('shop'), // the Lead
    agent('web', { role: 'worker', project: 'shop', folder: '/r/.worktrees/t' }),
    agent('rev', { role: 'reviewer', project: 'shop', folder: '/r/.worktrees/t/' }),
    agent('rev2', { role: 'reviewer', project: 'shop' }),
    agent('other', { role: 'worker', project: 'shop', folder: '/r/.worktrees/u' }),
    agent('cx', { role: 'worker', provider: 'codex', bgId: undefined }),
    agent('old', { role: 'worker', provider: undefined }),
    agent('down', { role: 'worker', live: false, bgId: undefined }),
  ];
  const orchs = engine.map((p, i) => ({ name: p.name, agentId: i + 1 }));
  const caps = { approvalPolicy: [], lifetime: 'session' as const, limits: true, usageRefresh: false, context: true, billing: 'plan' as const };
  const capsFor = (name: string) => (name === 'cx' ? caps : { ...caps, attach: 'pty' as const });
  const names = (wt: RepoWorktree | null, tasks = []) => agentsOn('shop', wt, engine, tasks).map((p) => p.name);

  it('a worktree shows its Worker, then the Reviewers pointed at it (folder or open Task); the trunk its Lead', () => {
    expect(names(wt({ assignee: 'web' }))).toEqual(['web', 'rev']);
    const tasks = [{ status: 'doing' as const, assignee: { assignmentId: 'a', name: 'rev2' }, worktree: '/r/.worktrees/t' }];
    expect(agentsOn('shop', wt({ assignee: 'web' }), engine, tasks).map((p) => p.name)).toEqual(['web', 'rev', 'rev2']);
    expect(agentsOn('shop', wt({ assignee: 'web' }), engine, [{ ...tasks[0], status: 'done' }]).map((p) => p.name)).toEqual(['web', 'rev']);
    expect(names(null)).toEqual(['shop']);
  });

  it('only a running claude-pty agent gets a live terminal', () => {
    const col = (name: string) => columnOf(engine.find((p) => p.name === name)!, orchs, capsFor(name));
    expect(col('web')).toEqual({ kind: 'live', name: 'web', agentId: 2, bgId: 'bg-web' });
    expect(col('cx').kind).toBe('none'); // its agent has no terminal (caps), whoever it is
    // ACP-1: one that works in runs links them; a session agent (ACP) has only its 대화.
    expect(columnOf(engine.find((p) => p.name === 'cx')!, orchs, { ...caps, lifetime: 'run' })).toMatchObject({ kind: 'none', runs: true });
    expect(columnOf(engine.find((p) => p.name === 'cx')!, orchs, { ...caps, lifetime: 'session' })).not.toHaveProperty('runs');
    expect(columnOf(engine.find((p) => p.name === 'web')!, orchs, undefined).kind).toBe('live'); // caps not known yet
    expect(col('old').kind).toBe('old');
    expect(col('down').kind).toBe('off');
  });

  it('one sub column per running sub-agent, numbered across the agents, titled by its spawn', () => {
    const cols = ['web', 'rev', 'cx'].map((n) => columnOf(engine.find((p) => p.name === n)!, orchs, capsFor(n)));
    const subs = {
      2: { 'tu-a': [{ toolId: 's1', status: 'Bash: npm test', done: true }], 'tu-b': [] },
      3: { 'tu-c': [{ toolId: 's2', status: 'Read x', done: false }] },
      6: { 'tu-x': [] }, // a Codex worker has none
    };
    const tools = { 2: [{ toolId: 'tu-a', status: 'Subtask: tests', desc: 'tests', done: false }] };
    const out = subColumns(cols, subs, tools);
    expect(out.map((s) => [s.n, s.desc, s.lines.length])).toEqual([
      [1, 'tests', 1],
      [2, '', 0],
      [3, '', 1],
    ]);
    expect(subColumns(cols, { 2: {} }, tools)).toEqual([]); // subagentClear took the last one
  });

  it('DEVROOM-SIDEBAR: a running spawn with no tool rows yet is a sub-agent too; a finished one is not', () => {
    setProviderCapabilities({ readingTools: [], subagentToolNames: ['Agent'] });
    const cols = [columnOf(engine.find((p) => p.name === 'web')!, orchs, capsFor('web'))];
    const tools = {
      2: [
        { toolId: 'tu-q', toolName: 'Agent', status: 'Subtask: quiet', desc: 'quiet', done: false },
        { toolId: 'tu-end', toolName: 'Agent', status: 'Subtask: end', desc: 'end', done: true },
        { toolId: 'b1', toolName: 'Bash', status: 'Bash', done: false },
      ],
    };
    expect(subColumns(cols, { 2: {} }, tools).map((s) => [s.key, s.desc, s.done])).toEqual([['2:tu-q', 'quiet', false]]);
    setProviderCapabilities({ readingTools: [], subagentToolNames: [] });
  });

  it('T-74: a quiet sub-agent is the same row on every call, so useSubs settles instead of looping', () => {
    setProviderCapabilities({ readingTools: [], subagentToolNames: ['Agent'] });
    const cols = [columnOf(engine.find((p) => p.name === 'web')!, orchs, capsFor('web'))];
    const tools = { 2: [{ toolId: 'tu-q', toolName: 'Agent', status: 'Subtask: quiet', desc: 'quiet', done: false }] };
    const agents = new Set([2]);
    // What useSubs does after each render: remember the live rows, store them only when they changed.
    const first = rememberSubs([], subColumns(cols, { 2: {} }, tools), agents, 1, 5);
    const again = rememberSubs(first, subColumns(cols, { 2: {} }, tools), agents, 2, 5);
    expect(sameSubs(again, first)).toBe(true);
    setProviderCapabilities({ readingTools: [], subagentToolNames: [] });
  });
});

describe('phoneRows (the phone list, owner 11-01 13:30)', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const old = '2026-10-22T13:02:11Z';
  const row = (task: string, chip: Chip, over: Partial<RepoWorktree> = {}) => ({ chip, wt: wt({ task, ...over }) });

  it('puts what needs the owner first, then work, then resting, merged last', () => {
    const rows = [
      row('a-idle', 'idle', { taskId: 'T-1' }),
      row('b-merged', 'merged', { taskId: 'T-2' }),
      row('c-working', 'working', { taskId: 'T-3' }),
      row('d-review', 'review', { taskId: 'T-4' }),
      row('e-conflict', 'conflict', { taskId: 'T-5' }),
    ];
    expect(phoneRows(rows, now, 3).shown.map((r) => r.wt.task)).toEqual(['d-review', 'e-conflict', 'c-working', 'a-idle', 'b-merged']);
  });

  it('folds an old worktree with no Task, nobody and nothing to do, and only that', () => {
    const rows = [
      row('codex-1022-130211', 'idle', { created: old, lastChange: old }),
      row('codex-1022-130217', 'merged', { created: old }),
      // Each one keeps a reason to stay on the list (negative controls).
      row('has-task', 'idle', { created: old, taskId: 'T-1' }),
      row('has-worker', 'idle', { created: old, assignee: 'web-worker' }),
      row('in-conflict', 'conflict', { created: old }),
      row('fresh-commit', 'idle', { created: old, lastChange: '2026-10-31T12:00:00Z' }),
      row('fresh', 'idle', { created: '2026-10-31T12:00:00Z' }),
    ];
    const { shown, resting } = phoneRows(rows, now, 3);
    expect(resting.map((r) => r.wt.task)).toEqual(['codex-1022-130211', 'codex-1022-130217']);
    expect(shown.map((r) => r.wt.task)).toEqual(['in-conflict', 'has-task', 'has-worker', 'fresh-commit', 'fresh']);
  });
});

describe('codexStamp', () => {
  it("reads a Codex run's folder name, and nothing else", () => {
    expect(codexStamp('codex-1022-130211')).toBe('10-22 13:02');
    expect(codexStamp('t-7-login-page')).toBeNull();
    expect(codexStamp('codex-1022-1302')).toBeNull();
  });
});

describe('graphLines (owner 11-03: main -> integ -> task branches)', () => {
  const row = (branch: string, base: string) => ({ wt: { branch, base }, id: branch });
  const shape = (lines: ReturnType<typeof graphLines<ReturnType<typeof row>>>) =>
    lines.map((l) => `${'  '.repeat(l.depth)}${l.kind === 'branch' ? `[${l.name}]` : l.row.id}`);

  it('cards under their real base: integ is a line between main and its cards, a card made from a card nests', () => {
    const rows = [
      row('task/codex-1022', 'main'),
      row('task/codex-1101', 'integ/1024-1815'),
      row('task/ui-scale', 'main'),
      row('task/codex-1102', 'integ/1024-1815'),
      row('task/sub', 'task/ui-scale'),
      row('task/codex-1025', 'task/hd64'),
    ];
    expect(shape(graphLines(rows, 'main'))).toEqual([
      'task/codex-1022',
      '[integ/1024-1815]',
      '  task/codex-1101',
      '  task/codex-1102',
      'task/ui-scale',
      '  task/sub',
      '[task/hd64]',
      '  task/codex-1025',
    ]);
  });

  it('a detached base (a commit) and bases in a circle still show every card once', () => {
    const rows = [row('task/a', 'task/b'), row('task/b', 'task/a'), row('task/c', 'f'.repeat(40))];
    const lines = graphLines(rows, 'main');
    expect(lines.filter((l) => l.kind === 'row')).toHaveLength(3);
    expect(shape(lines)).toEqual(['task/c', 'task/a', '  task/b']);
  });
});
