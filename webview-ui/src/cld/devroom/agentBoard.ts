/**
 * DEVROOM-SUBVIEW (owner 11-03 10:51): the 터미널 tab as a board of the project's agents, like the
 * messenger's 1 · 2 · 2×2 panes, laid out freely (paneTree.ts). Pure rules: who is on the board,
 * which status group an agent is in (needs-you first, Orca's Agent Dashboard).
 */
import type { EngineProject, MessengerContact } from '../../../../core/src/messages.js';
import type { LeadState } from '../messenger/messengerStore.js';

/** The status groups, in the strip's order. */
export const BUCKETS = ['needs', 'working', 'done', 'idle'] as const;
export type Bucket = (typeof BUCKETS)[number];

/**
 * G14 (plan §1.5 item 6: the rail said 쉬는 중 while the card row said 일하는 중): the one reading of an
 * agent's state (messengerStore.leadState) every 개발실 list makes, the rail's chip (devroomState.chipOf),
 * the board's status chips and its cards: it waits for the person, it is in a turn, or neither.
 */
export function stateGroup(state: LeadState): 'needs' | 'working' | 'rest' {
  if (state === 'waiting') return 'needs';
  return state === 'working' || state === 'thinking' ? 'working' : 'rest';
}

/** The person is waited on outside the dot's word: a session held on its terminal, or a permission the
 *  messenger already shows as a card (seen before the status dot turns). leadState's `held`. */
export const waitsOnPerson = (c: Pick<MessengerContact, 'held' | 'permission'> | undefined): boolean =>
  c?.held === true || !!c?.permission;

/** 나를 기다림 (a permission or a question), 일하는 중 (in a turn); after a turn, 끝남 while its last
 *  news is under `doneMs` old, then 쉬는 중 (off too). Orca's Done and Idle (owner 11-03 11:51). */
export function bucketOf(state: LeadState, quietMs: number, doneMs: number): Bucket {
  const group = stateGroup(state);
  if (group !== 'rest') return group;
  return state !== 'off' && quietMs < doneMs ? 'done' : 'idle';
}

/** The project's agents in the engine: its Lead, then its Workers and Reviewers. */
export const projectAgents = (project: string, engine: readonly EngineProject[]): EngineProject[] => [
  ...engine.filter((p) => !p.role && p.name === project),
  ...engine.filter((p) => !!p.role && p.project === project),
];

// ── How long an agent has been in its group ─────────────────

const since = new Map<number, { key: string; at: number }>();
/** Since when agent `id` is in `key` (a new key starts the clock again). */
export function inStateSince(id: number, key: string, now: number): number {
  const prev = since.get(id);
  if (prev?.key === key) return prev.at;
  since.set(id, { key, at: now });
  return now;
}
