import { describe, expect, it } from 'vitest';

import type { EngineAgentCaps, EngineProject } from '../../../../core/src/messages.js';
import { baseChoices, folderOf, seatAgents, taskOf, titleFor } from './devroomState.js';

const agent = (o: Partial<EngineProject>): EngineProject => ({ name: 'x', folder: '/r', wantRunning: false, live: false, ...o }) as EngineProject;
const caps = (lifetime: 'session' | 'run') => ({ lifetime }) as EngineAgentCaps;

describe('DV4 new worktree helpers', () => {
  it('the folder is the branch with / as -, where the engine puts it', () => {
    expect(folderOf('feat/cart-coupon')).toBe('.worktrees/feat-cart-coupon');
    expect(taskOf(' fix/a/b ')).toBe('fix-a-b');
  });

  it('lists the Workers only, with their state, another worktree, and whether seating restarts them', () => {
    const engine = [
      agent({ name: 'shop', live: true }),
      agent({ name: 'w', role: 'worker', project: 'shop', live: true }),
      agent({ name: 'r', role: 'worker', project: 'shop', live: true, provider: 'runner' }),
      agent({ name: 'off', role: 'worker', project: 'shop' }),
      agent({ name: 'other', role: 'worker', project: 'api' }),
    ];
    const orchs = [{ name: 'w', provider: 'claude', state: 'active', busy: true }] as never[];
    const got = seatAgents('shop', engine, orchs, [{ task: 'feat-a', assignee: 'w' }], (p) => caps(p === 'runner' ? 'run' : 'session'));
    expect(got).toEqual([
      { name: 'w', state: 'busy', elsewhere: 'feat-a', restarts: true },
      { name: 'r', state: 'idle', elsewhere: null, restarts: false },
      { name: 'off', state: 'off', elsewhere: null, restarts: false },
    ]);
    // Its own card is not "another" one.
    expect(seatAgents('shop', engine, orchs, [{ task: 'feat-a', assignee: 'w' }], () => undefined, 'feat-a')[0].elsewhere).toBeNull();
  });

  it('bases: the project branch first, then the worktrees’ branches, once each', () => {
    expect(baseChoices('main', [{ branch: 'feat/a' }, { branch: 'main' }, { branch: 'feat/a' }])).toEqual(['main', 'feat/a']);
  });

  it('a new Task is titled by the first instruction’s first line, else the branch', () => {
    expect(titleFor('\n  move the coupon \nmore', 'feat/x')).toBe('move the coupon');
    expect(titleFor('  ', 'feat/x')).toBe('feat/x');
  });
});
