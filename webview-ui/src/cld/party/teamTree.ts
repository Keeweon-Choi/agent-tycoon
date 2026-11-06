/**
 * T-71 (owner 11-06 23:12, 23:15): the party's team tree. A Lead brings its Workers and its sub-agents along
 * in an owner-composed party (the default party 모두 stays flat). Pure rules on the links the devroom
 * sidebar already uses (sidebarTree.ts): a Worker's Lead is the Lead of its project, a sub-agent belongs to
 * the agent that spawned it. Nothing here is stored: parties.json keeps its members only.
 */
import type { EngineProject } from '../../../../core/src/messages.js';
import type { Dot } from '../devroom/sidebarTree.js';

export type TeamRole = 'lead' | 'worker' | 'reviewer';

/** An engine agent as the party knows it: the id of its card (the office's), its project and its folder. */
export interface TeamAgent {
  id: number;
  name: string;
  role: TeamRole;
  project: string;
  folder: string;
}

/** A running (or just finished) sub-agent: SubRow.key, the agent that spawned it, its task and its dot. */
export interface TeamSub {
  key: string;
  agentId: number;
  desc: string;
  dot: Dot;
}

/** The engine's agents with the card id each has in the office (`idOf` by name; null: not in the office). */
export function teamAgents(engine: readonly EngineProject[], idOf: (name: string) => number | null): TeamAgent[] {
  return engine.flatMap((p): TeamAgent[] => {
    const id = idOf(p.name);
    if (id === null) return [];
    const role: TeamRole = !p.role ? 'lead' : p.role === 'reviewer' ? 'reviewer' : 'worker';
    return [{ id, name: p.name, role, project: p.role ? (p.project ?? '') : p.name, folder: p.folder }];
  });
}

/** The Lead of agent `id`'s team: itself for a Lead, its project's Lead for a Worker, else null. */
export function teamLead(id: number, agents: readonly TeamAgent[]): TeamAgent | null {
  const me = agents.find((a) => a.id === id);
  if (!me) return null;
  return me.role === 'lead' ? me : (agents.find((a) => a.role === 'lead' && a.project === me.project) ?? null);
}

export interface PartyRow {
  id: number;
  /** 1: a Lead's Worker, one indent step in. */
  depth: 0 | 1;
}

/**
 * The rows a party draws. `all` is the column's order, `shown` the members the party lists (in `all`'s
 * order). Not composed (모두): the members as they are. Composed: a Lead that is a member is followed by
 * its Workers (members or not, in the column's order); a Worker whose Lead is not a member stays where it is.
 */
export function teamRows(
  all: readonly number[],
  shown: readonly number[],
  agents: readonly TeamAgent[],
  composed: boolean,
): PartyRow[] {
  if (!composed) return shown.map((id) => ({ id, depth: 0 }));
  const members = new Set(shown);
  const leadOf = (id: number) => {
    const a = agents.find((x) => x.id === id);
    return a && a.role !== 'lead' ? teamLead(id, agents)?.id : undefined;
  };
  const under = (lead: number) => all.filter((id) => leadOf(id) === lead);
  return shown.flatMap((id): PartyRow[] => {
    const lead = leadOf(id);
    if (lead !== undefined && members.has(lead)) return []; // placed under its Lead
    return [{ id, depth: 0 }, ...under(id).map((w): PartyRow => ({ id: w, depth: 1 }))];
  });
}

/** The sub-agents a Lead's team runs (a Worker's too), in the order given. */
export const subsOfLead = (lead: number, agents: readonly TeamAgent[], subs: readonly TeamSub[]): TeamSub[] =>
  subs.filter((s) => teamLead(s.agentId, agents)?.id === lead);

/** What a card's 관계 tab lists. */
export type Relation =
  | { kind: 'lead'; agent: TeamAgent }
  | { kind: 'worker'; agent: TeamAgent }
  | { kind: 'sub'; sub: TeamSub };

/**
 * The connected ones of agent `id` (or of sub-agent `self`, whose spawner is `id`, listed too): the Lead (unless
 * it is `id`), the Lead's Workers and Reviewers (not `id`), and the team's sub-agents (not `self`).
 */
export function relationsOf(id: number, agents: readonly TeamAgent[], subs: readonly TeamSub[], self?: string): Relation[] {
  const lead = teamLead(id, agents);
  if (!lead) return [];
  const own = self === undefined; // a sub-agent's card lists its spawner too
  return [
    ...(lead.id === id && own ? [] : [{ kind: 'lead', agent: lead } as const]),
    ...agents.filter((a) => a.role !== 'lead' && a.project === lead.project && (a.id !== id || !own)).map((agent) => ({ kind: 'worker', agent }) as const),
    ...subsOfLead(lead.id, agents, subs).filter((s) => s.key !== self).map((sub) => ({ kind: 'sub', sub }) as const),
  ];
}

const WORKTREES = '.worktrees';

/** The devroom's worktree key of a Worker's folder (`<project>/.worktrees/<task>`), or null (the trunk shows it). */
export function taskOfFolder(folder: string): string | null {
  const parts = folder.split(/[\\/]+/).filter(Boolean);
  const at = parts.lastIndexOf(WORKTREES);
  return at >= 0 && parts[at + 1] ? parts[at + 1] : null;
}
