import type { OfficeOrchestrator } from '../../../core/src/messages.js';
import type { AgentActivity } from '../components/AgentCard.js';

/**
 * STATE-SYNC (owner 11-04 21:24, pearl waiting on its training job showed 쉬는 중 in the office and
 * the party while the engine had it at work): what the engine says of a session it runs, the one
 * rule the character, its card, the party, the messenger, the dev room and the terminal tabs read.
 * The tool rows only refine it (which tool), they never decide rest for an engine session.
 *   'on'   a turn runs (busy), or a renew is under way
 *   'job'  the turn is over but a background shell it started still runs (shellWait)
 *   'over' the turn is over
 *   'off'  no session
 *   null   not an engine session, or the engine does not know: the tool rows decide, as before
 */
export type EngineTurn = 'on' | 'job' | 'over' | 'off' | null;

export function engineTurn(
  row: Pick<OfficeOrchestrator, 'provider' | 'state' | 'busy' | 'shellWait' | 'renewing'> | undefined,
): EngineTurn {
  if (!row || row.provider !== 'engine') return null;
  if (row.state === 'off') return 'off';
  if (row.renewing || row.busy === true) return 'on';
  if (row.shellWait) return 'job';
  return row.busy === false ? 'over' : null;
}

/** The engine has the agent at work (its turn, or its job). */
export const atWork = (turn: EngineTurn): boolean => turn === 'on' || turn === 'job';

/**
 * The status dot every list reads (party, messenger, dev room, terminal tabs: useTerminalDrawer's
 * statusFor). Waiting on the person and an open tool come first; then the engine's word; only a
 * session the engine does not run falls back to the turn end the office saw. null: nothing seen yet.
 */
export function sharedActivity(i: {
  turn: EngineTurn;
  seen: boolean;
  /** Waits for the person (agent-tycoon/waiting.ts: a permission or a question). */
  asks: boolean;
  openTool: boolean;
  /** The office saw its turn end (agentStatus waiting). */
  turnEnded: boolean;
}): AgentActivity | null {
  if (!i.seen && i.turn === null) return null;
  if (i.turn === 'off') return 'idle';
  if (i.asks) return 'attention';
  if (i.openTool) return 'working';
  if (i.turn) return atWork(i.turn) ? 'working' : 'idle';
  return i.turnEnded ? 'idle' : 'working';
}

/** A row's `busy` as a screen reads it: an engine row at work (its turn, its job, a renew) is busy. */
export const rowBusy = (
  row: Pick<OfficeOrchestrator, 'provider' | 'state' | 'busy' | 'shellWait' | 'renewing'>,
): boolean | null => (atWork(engineTurn(row)) ? true : row.busy);

/** describeActivity's busy and jobWait for a character (ToolOverlay): the engine's word, else the office's. */
export const turnInputs = (turn: EngineTurn, officeBusy: boolean) => ({
  busy: turn ? turn === 'on' : officeBusy,
  jobWait: turn === 'job',
});
