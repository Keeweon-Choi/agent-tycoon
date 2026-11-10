import { describe, expect, it } from 'vitest';

import type { EngineProject } from '../../../../core/src/messages.js';
import { relationsOf, subsOfLead, taskOfFolder, teamAgents, teamLead, teamRows, type TeamSub } from './teamTree.js';

const proj = (name: string, role?: 'worker' | 'reviewer', project?: string, folder = `/r/${name}`): EngineProject =>
  ({ name, role, project, folder, room: '', wantRunning: true, live: true }) as EngineProject;

const ids: Record<string, number> = { app: 1, w1: 2, w2: 3, solo: 4, other: 5, ow: 6 };
const agents = teamAgents(
  [proj('app'), proj('w1', 'worker', 'app'), proj('w2', 'worker', 'app'), proj('solo'), proj('other'), proj('ow', 'worker', 'other'), proj('ghost', 'worker', 'app')],
  (n) => ids[n] ?? null,
);
const sub = (key: string, agentId: number, dot: TeamSub['dot'] = 'working'): TeamSub => ({ key, agentId, desc: key, dot });
const all = [1, 4, 2, 5, 3, 6];

describe('teamAgents / teamLead', () => {
  it('skips agents that are not in the office and links Workers to their project Lead', () => {
    expect(agents.map((a) => a.name)).toEqual(['app', 'w1', 'w2', 'solo', 'other', 'ow']);
    expect(teamLead(2, agents)?.id).toBe(1);
    expect(teamLead(1, agents)?.id).toBe(1);
    expect(teamLead(99, agents)).toBeNull();
  });
});

describe('teamRows', () => {
  it('the default party stays flat: members as they are, no grouping', () => {
    expect(teamRows(all, all, agents, false)).toEqual(all.map((id) => ({ id, depth: 0 })));
  });
  it('a composed party brings a Lead member\'s Workers right under it, though they are not members', () => {
    expect(teamRows(all, [1], agents, true)).toEqual([{ id: 1, depth: 0 }, { id: 2, depth: 1 }, { id: 3, depth: 1 }]);
  });
  it('keeps the owner order, and a Worker member sits under its Lead only once', () => {
    expect(teamRows(all, [4, 1, 3], agents, true)).toEqual([
      { id: 4, depth: 0 },
      { id: 1, depth: 0 },
      { id: 2, depth: 1 },
      { id: 3, depth: 1 },
    ]);
  });
  it('a Worker whose Lead is not a member stays where it is', () => {
    expect(teamRows(all, [4, 2, 5], agents, true)).toEqual([
      { id: 4, depth: 0 },
      { id: 2, depth: 0 },
      { id: 5, depth: 0 },
      { id: 6, depth: 1 },
    ]);
  });
});

describe('subs and relations', () => {
  const subs = [sub('1:a', 1), sub('1:b', 1, 'done'), sub('2:c', 2), sub('5:d', 5)];
  it('counts a team\'s sub-agents, a Worker\'s included', () => {
    expect(subsOfLead(1, agents, subs).map((s) => s.key)).toEqual(['1:a', '1:b', '2:c']);
    expect(subsOfLead(4, agents, subs)).toEqual([]);
  });
  it('a Lead lists its Workers and sub-agents', () => {
    expect(relationsOf(1, agents, subs).map((r) => (r.kind === 'sub' ? r.sub.key : r.agent.name))).toEqual(['w1', 'w2', '1:a', '1:b', '2:c']);
  });
  it('a Worker lists its Lead, the other Workers and the Lead\'s sub-agents', () => {
    const r = relationsOf(2, agents, subs);
    expect(r.map((x) => x.kind)).toEqual(['lead', 'worker', 'sub', 'sub', 'sub']);
    expect(r.map((x) => (x.kind === 'sub' ? x.sub.key : x.agent.name))).toEqual(['app', 'w2', '1:a', '1:b', '2:c']);
  });
  it('a sub-agent\'s card lists the others, not itself', () => {
    const r = relationsOf(1, agents, subs, '1:a');
    expect(r.map((x) => (x.kind === 'sub' ? x.sub.key : x.agent.name))).toEqual(['app', 'w1', 'w2', '1:b', '2:c']);
  });
  it('an agent with no team lists nothing', () => {
    expect(relationsOf(99, agents, subs)).toEqual([]);
  });
});

describe('taskOfFolder', () => {
  it('reads the worktree key from a Worker\'s folder', () => {
    expect(taskOfFolder('/home/x/proj/.worktrees/feat-a')).toBe('feat-a');
    expect(taskOfFolder('C:\\p\\.worktrees\\fix-b\\')).toBe('fix-b');
    expect(taskOfFolder('/home/x/proj')).toBeNull();
  });
});
