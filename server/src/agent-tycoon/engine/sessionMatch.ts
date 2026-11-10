/**
 * Session matching helpers extracted from engine.ts (E1, E4).
 */
import type { PathHost } from '../../../../core/src/agent-tycoon/projectPath.js';
import type { AgentProvider, LiveSession } from './agents/types.js';
import type { ProjectRecord } from './registry.js';
import { samePath, sessionName } from './registry.js';

/** A live session and the provider that listed it. */
export type Live = LiveSession & { agent: AgentProvider };

/** An agent's assignment id: a Worker's own, a Lead's lead assignment. */
export const assignmentOf = (p: ProjectRecord): string | undefined => (p.role ? p.assignmentId : p.leadAssignmentId);

export const newest = (xs: Live[]): Live | null =>
  [...xs].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0] ?? null;

/** What the matching functions read: engine state taken fresh at each call. */
export interface MatchCtx {
  projects: ProjectRecord[];
  live: Live[];
  agentOf: (p: ProjectRecord) => AgentProvider | undefined;
  host: PathHost;
  /** contested() conflicts already logged (agent + session): the engine's one Set. */
  logged: Set<string>;
  log: (line: string) => void;
}

/** The live session that is this project's (of its provider): its conversation (any
 *  kind), or a background session with its name in its folder. Background first. */
export function holderOf(ctx: MatchCtx, p: ProjectRecord): Live | null {
  const agent = ctx.agentOf(p);
  const assignment = assignmentOf(p);
  const mine = ctx.live.filter(
    (s) =>
      s.agent === agent &&
      ((s.assignmentId !== undefined && s.assignmentId === assignment) ||
        (p.sessionId !== undefined && s.sessionId === p.sessionId) ||
        (claims(ctx, p, s) && !contested(ctx, p, (q) => claims(ctx, q, s), s.name, s.sessionId))),
  );
  const found = mine.find((s) => s.kind === 'background') ?? mine[0] ?? null;
  if (found || !agent || agent.capabilities.lifetime !== 'run' || !p.wantRunning || agent.ready?.())
    return found;
  // D5: an on assignment of a 'run' provider with no run is resting (never in this.live, so
  // followConversations and the rest never see it).
  return {
    id: `rest:${assignment ?? p.name}`,
    pid: 0,
    cwd: p.folder,
    kind: 'background',
    sessionId: '',
    name: p.name,
    status: 'idle',
    resting: true,
    agent,
    ...(assignment && { assignmentId: assignment }),
  };
}

/** A background session of `q`'s provider with `q`'s session name in `q`'s folder. */
export function claims(ctx: MatchCtx, q: ProjectRecord, s: Live): boolean {
  return s.kind === 'background' && s.agent === ctx.agentOf(q) && claimsName(ctx, q, s.name, s.cwd);
}

/** A session named as `q`'s (its provider's rule: Claude's `<name> (N)`) in `q`'s folder. */
export function claimsName(
  ctx: MatchCtx,
  q: ProjectRecord,
  name: string | null | undefined,
  dir: string,
): boolean {
  const agent = ctx.agentOf(q);
  return !!agent && agent.nameMatches(name, sessionName(q)) && samePath(dir, q.folder, ctx.host);
}

/** D3: two agents of one provider in one folder whose session names match either way: a
 *  live session of one could be taken for the other's (neither then takes it). */
export function collide(ctx: MatchCtx, a: ProjectRecord, b: ProjectRecord): boolean {
  const agent = ctx.agentOf(a);
  return (
    !!agent &&
    agent === ctx.agentOf(b) &&
    samePath(a.folder, b.folder, ctx.host) &&
    (agent.nameMatches(sessionName(a), sessionName(b)) ||
      agent.nameMatches(sessionName(b), sessionName(a)))
  );
}

/**
 * Another agent in the same folder claims this session by name too (a store carried
 * over from D2, or edited by hand): it is never guessed to be `p`'s (only its own
 * conversation id makes it so). Logged once per agent and session.
 */
export function contested(
  ctx: MatchCtx,
  p: ProjectRecord,
  claimedBy: (q: ProjectRecord) => boolean,
  name: string | null | undefined,
  sessionId: string | null | undefined,
): boolean {
  const others = ctx.projects.filter((q) => q !== p && claimedBy(q));
  if (!others.length) return false;
  const key = `${p.name}\0${sessionId ?? name}`;
  if (!ctx.logged.has(key)) {
    ctx.logged.add(key);
    ctx.log(
      `"${p.name}": live session "${name}" (${sessionId?.slice(0, 8) ?? '-'}) also matches ${others.map((q) => `"${q.name}"`).join(', ')} in the same folder; not followed (give them different names or titles)`,
    );
  }
  return true;
}
