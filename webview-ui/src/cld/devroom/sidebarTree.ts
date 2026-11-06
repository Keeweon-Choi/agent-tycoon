/**
 * DEVROOM-SIDEBAR (owner 11-06 22:05, cld/docs/design/devroom-sidebar.md): the rail as Orca's
 * sidebar, project → every worktree → the agents working in it. Pure rules: which worktree a path
 * lies in (the longest known prefix), where a sub-agent works (the worktree its calls touched most,
 * from the paths the daemon sends with each call, counted as they come), and each worktree's agent rows.
 */
import type { LeadState } from '../messenger/messengerStore.js';

/** A worktree the rail shows: `''` the project's own folder (main), a task name, or an external one's path. */
export interface Spot {
  key: string;
  path: string;
}

const trim = (p: string) => p.replace(/[\\/]+$/, '');

/** The spot whose folder holds `path` (the longest one wins: a worktree inside main is not main), or null. */
export function spotOf(path: string, spots: readonly Spot[]): string | null {
  const p = trim(path);
  let best: Spot | null = null;
  for (const s of spots) {
    const root = trim(s.path);
    if (!root) continue;
    const inside = p === root || p.startsWith(`${root}/`) || p.startsWith(`${root}\\`);
    if (inside && (!best || root.length > trim(best.path).length)) best = s;
  }
  return best?.key ?? null;
}

/** What one sub-agent's calls touched: per path, how often and when last (a running count). */
export interface Trace {
  paths: Readonly<Record<string, { n: number; at: number }>>;
  /** Its last call waits for the person's permission. */
  perm: boolean;
}

export const EMPTY_TRACE: Trace = { paths: {}, perm: false };

/** One more call on `path` (`at` a running count); past `cap` distinct paths a new one is not kept. */
export function noteTrace(trace: Trace, path: string, at: number, cap: number): Trace {
  const had = trace.paths[path];
  if (!had && Object.keys(trace.paths).length >= cap) return trace.perm ? { ...trace, perm: false } : trace;
  return { paths: { ...trace.paths, [path]: { n: (had?.n ?? 0) + 1, at } }, perm: false };
}

/**
 * Where a sub-agent works: the spot its paths fall in most often (a tie: the one touched last).
 * With no path in any known spot it sits in `parent` (its lead's spot), marked unknown.
 */
export function placeSub(trace: Trace | undefined, spots: readonly Spot[], parent: string): { key: string; unknown: boolean } {
  const score = new Map<string, { n: number; at: number }>();
  for (const [path, hit] of Object.entries(trace?.paths ?? {})) {
    const key = spotOf(path, spots);
    if (key === null) continue;
    const s = score.get(key) ?? { n: 0, at: 0 };
    score.set(key, { n: s.n + hit.n, at: Math.max(s.at, hit.at) });
  }
  let best: [string, { n: number; at: number }] | null = null;
  for (const e of score) if (!best || e[1].n > best[1].n || (e[1].n === best[1].n && e[1].at > best[1].at)) best = e;
  return best ? { key: best[0], unknown: false } : { key: parent, unknown: true };
}

/** A row's dot, Orca's AgentStateDot: a spinner, a permission mark, idle, off or a done check. */
export type Dot = 'working' | 'permission' | 'idle' | 'off' | 'done';

export const dotOf = (state: LeadState): Dot =>
  state === 'working' || state === 'thinking' ? 'working' : state === 'waiting' ? 'permission' : state === 'resting' ? 'idle' : 'off';

export type TreeRole = 'lead' | 'worker' | 'reviewer' | 'run' | 'sub';

export interface TreeAgent {
  /** Unique in the project: the agent's name, `codex:<spot>`, or the sub-agent's key. */
  id: string;
  role: TreeRole;
  /** The agent's name (a Codex run's employee); a sub-agent's: its lead's. */
  name: string;
  /** A sub-agent's key (`<leadId>:<spawn tool id>`, SubRow.key); null for the others. */
  sub: string | null;
  /** A sub-agent's one-line task (its spawn's description). */
  desc?: string;
  dot: Dot;
  /** A sub-agent with no path in a known worktree: shown under its lead's. */
  unknown?: boolean;
}

export interface TreeInput {
  spots: readonly Spot[];
  /** The project's agents in the engine (Lead first): role absent = the Lead. */
  agents: readonly { name: string; role?: string; folder: string; agentId: number | null; dot: Dot }[];
  /** Each engine worktree's assignee (spot key → name). */
  assignees: Readonly<Record<string, string | undefined>>;
  /** A Codex run's employee on an engine worktree nobody is assigned to. */
  codex: readonly { key: string; name: string; dot: Dot }[];
  subs: readonly { key: string; agentId: number; desc: string; dot: Dot }[];
  trace: (subKey: string) => Trace | undefined;
}

/** Every spot's agent rows: its agents (Lead, Workers, Reviewers, a Codex run), then its sub-agents. */
export function agentTree(o: TreeInput): Map<string, TreeAgent[]> {
  const out = new Map<string, TreeAgent[]>(o.spots.map((s) => [s.key, []]));
  const put = (key: string, a: TreeAgent) => (out.get(key) ?? out.get('')!).push(a);
  const home = new Map<number, string>();
  for (const a of o.agents) {
    const assigned = Object.entries(o.assignees).find(([, who]) => who === a.name)?.[0];
    const key = !a.role ? '' : (assigned ?? spotOf(a.folder, o.spots) ?? '');
    if (a.agentId !== null) home.set(a.agentId, key);
    const role: TreeRole = !a.role ? 'lead' : a.role === 'reviewer' ? 'reviewer' : 'worker';
    put(key, { id: a.name, role, name: a.name, sub: null, dot: a.dot });
  }
  for (const c of o.codex) put(c.key, { id: `codex:${c.key}`, role: 'run', name: c.name, sub: null, dot: c.dot });
  const lead = (id: number) => o.agents.find((a) => a.agentId === id)?.name;
  for (const s of o.subs) {
    const name = lead(s.agentId);
    if (!name) continue;
    const at = placeSub(o.trace(s.key), o.spots, home.get(s.agentId) ?? '');
    put(at.key, { id: s.key, role: 'sub', name, sub: s.key, desc: s.desc, dot: s.dot, ...(at.unknown && { unknown: true }) });
  }
  return out;
}
