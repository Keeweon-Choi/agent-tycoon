import { describe, expect, it } from 'vitest';

import type { EngineProject, RepoWorktree } from '../../../../core/src/messages.js';
import { leadState } from '../messenger/messengerStore.js';
import { bucketOf, projectAgents, waitsOnPerson } from './agentBoard.js';
import { chipOf } from './devroomState.js';

describe('the terminal board (DEVROOM-SUBVIEW)', () => {
  it('groups: waiting needs you, a turn is working, recent news is done, old news or off is idle', () => {
    const DONE = 30 * 60_000;
    expect(bucketOf('waiting', DONE * 9, DONE)).toBe('needs');
    expect(bucketOf('thinking', 0, DONE)).toBe('working');
    expect(bucketOf('resting', DONE - 1, DONE)).toBe('done');
    expect(bucketOf('resting', DONE, DONE)).toBe('idle');
    expect(bucketOf('off', 0, DONE)).toBe('idle');
  });

  it("the project's Lead first, then its Workers; nobody else's", () => {
    const p = (name: string, over: Partial<EngineProject> = {}) => ({ name, folder: '/', room: '', wantRunning: true, live: true, ...over }) as EngineProject;
    const engine = [p('w1', { role: 'worker', project: 'shop' }), p('other'), p('shop'), p('w2', { role: 'worker', project: 'other' })];
    expect(projectAgents('shop', engine).map((x) => x.name)).toEqual(['shop', 'w1']);
  });

  it('G14: the rail chip and the card read one state, where they used to disagree', () => {
    const wt = { task: 't1', path: '/w', branch: 'feat/t1', base: 'main', created: '2026-11-06T00:00:00Z', merged: false, ahead: 1, behind: 0 } as RepoWorktree;
    const DONE = 30 * 60_000;
    const both = (row: { state: string; busy: boolean | null }, status: 'working' | 'attention' | null, held = false) => {
      const state = leadState(row, status, held);
      return [chipOf({ wt, wait: null, state, notesSent: false }), bucketOf(state, DONE * 9, DONE)];
    };
    // The plan's case: a tool runs (the dot says working) while the row's busy flag is still false.
    // The rail read rowBusy(row) (false: 쉬는 중), the card leadState (일하는 중).
    expect(both({ state: 'running', busy: false }, 'working')).toEqual(['working', 'working']);
    expect(both({ state: 'running', busy: true }, null)).toEqual(['working', 'working']);
    expect(both({ state: 'running', busy: false }, null, true)).toEqual(['approve', 'needs']);
    expect(both({ state: 'running', busy: false }, null)).toEqual(['idle', 'idle']);
    // A permission the messenger shows as a card is a wait on both sides, before the dot turns.
    const card = { toolId: 'tu-1', tool: 'Bash' } as NonNullable<Parameters<typeof waitsOnPerson>[0]>['permission'];
    expect(both({ state: 'running', busy: true }, 'working', waitsOnPerson({ held: false, permission: card }))).toEqual(['approve', 'needs']);
    expect(waitsOnPerson(undefined)).toBe(false);
  });
});
