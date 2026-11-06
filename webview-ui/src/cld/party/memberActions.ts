/**
 * FEAT-PARTY-V2 (owner 11-06 17:49, "지금은 버튼이 너무 많아"): which of a member's actions the card shows as its
 * (at most three) big buttons and which wait in its ⋯ menu. Pure, so the split is tested; the card wires each
 * action to its existing handler (the engine's ask-first ones for 끄기 / 재시작 / 삭제).
 */
import type { BoardTask, BoardTaskStatus } from '../../../../core/src/messages.js';

export type MemberAction =
  | 'chat'
  | 'start'
  | 'stop'
  | 'work'
  | 'looks'
  | 'stats'
  | 'dev'
  | 'files'
  | 'restart'
  | 'promote'
  | 'edit'
  | 'remove';

export interface MemberFacts {
  /** Its conversation exists (chatTarget). */
  chat: boolean;
  /** A temp with a work view (T-0056). */
  work: boolean;
  /** It has a look key (꾸미기). */
  looks: boolean;
  /** An engine-managed agent: its session actions now (sessionActions) and whether it is a Worker. */
  engine: { actions: readonly ('start' | 'stop' | 'restart')[]; worker: boolean } | null;
  /** This client may act (useCanAct). */
  canAct: boolean;
}

export const MEMBER_MAIN_MAX = 3;

export function memberActions(f: MemberFacts): { main: MemberAction[]; more: MemberAction[] } {
  const e = f.engine;
  const act = !!e && f.canAct;
  const power: MemberAction | null = act ? (e.actions.includes('start') ? 'start' : e.actions.includes('stop') ? 'stop' : null) : null;
  const main: MemberAction[] = [
    ...(f.chat ? (['chat'] as const) : []),
    ...(power ? ([power] as const) : []),
    ...(f.work ? (['work'] as const) : []),
  ].slice(0, MEMBER_MAIN_MAX);
  const more: MemberAction[] = [
    ...(f.looks ? (['looks'] as const) : []),
    'stats',
    ...(e ? (['dev', 'files'] as const) : []),
    ...(act && e.actions.includes('restart') ? (['restart'] as const) : []),
    ...(act && e.worker ? (['promote'] as const) : []),
    ...(act ? (['edit', 'remove'] as const) : []),
  ];
  return { main, more };
}

/** The member's issues: the Tasks it works on (assignee, else owner), the open ones first, then the latest. */
export function memberTasks(tasks: readonly BoardTask[], name: string, who: (t: BoardTask) => string | null): BoardTask[] {
  const rank: Record<BoardTaskStatus, number> = { blocked: 0, doing: 1, review: 2, todo: 3, proposed: 4, done: 5 };
  return tasks
    .filter((task) => who(task) === name)
    .sort((a, b) => rank[a.status] - rank[b.status] || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
}
