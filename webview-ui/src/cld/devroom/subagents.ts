/**
 * DEVROOM-SUBVIEW (owner 11-03 10:43): the 터미널 tab's list of sub-agents. The running ones come
 * from subColumns (the office's subagentTool* rows, summaries only); a sub-agent is cleared from
 * those when it ends, so the list remembers what it saw end while the dev room was open, as done.
 * Only the selected one's transcript is read in full (the work view, AgentColumns.tsx).
 */
import type { ToolActivity } from '../../office/types.js';
import { commandOf, describeActivity } from '../ez/activity.js';
import type { SubColumn } from './devroomState.js';

/** A step in one line: a shell step as its command, any other in the office's words for it. */
export function lineText(line: ToolActivity): string {
  const command = commandOf(line.status);
  if (command) return command;
  const a = describeActivity({ toolName: line.toolName ?? null, status: line.status, desc: line.desc ?? null });
  return a.detail ? `${a.text} · ${a.detail}` : a.text;
}

export interface SubRow extends Omit<SubColumn, 'n' | 'done'> {
  running: boolean;
  /** First seen (ms): its elapsed time counts from here. */
  since: number;
  /** When it was seen to end (ms); null while running. */
  endedAt: number | null;
}

/**
 * The list after the office's rows changed. Only the lead ids in `agents` (the pick's) are
 * judged: a sub-agent of another pick is not done because this pick does not show it. At most
 * `keepDone` finished ones are kept (the newest). Running first, then done; each in spawn order.
 */
export function rememberSubs(
  prev: readonly SubRow[],
  live: readonly SubColumn[],
  agents: ReadonlySet<number>,
  now: number,
  keepDone: number,
): SubRow[] {
  const old = new Map(prev.map((r) => [r.key, r]));
  const seen = live.map((s): SubRow => {
    const was = old.get(s.key);
    return {
      key: s.key,
      desc: s.desc,
      lines: s.lines,
      agentId: s.agentId,
      parent: s.parent,
      running: !s.done,
      since: was?.since ?? now,
      endedAt: s.done ? (was?.endedAt ?? now) : null,
    };
  });
  const keys = new Set(live.map((s) => s.key));
  const gone = prev
    .filter((r) => !keys.has(r.key))
    .map((r) => (agents.has(r.agentId) && r.running ? { ...r, running: false, endedAt: now } : r));
  const all = [...seen, ...gone];
  const done = all
    .filter((r) => !r.running)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, keepDone);
  const kept = new Set([...all.filter((r) => r.running), ...done]);
  return all
    .filter((r) => kept.has(r))
    .sort((a, b) => Number(b.running) - Number(a.running) || a.since - b.since);
}

/** The same list, or a new one: the rows changed in what the list shows. */
export const sameSubs = (a: readonly SubRow[], b: readonly SubRow[]): boolean =>
  a.length === b.length &&
  a.every((r, i) => r.key === b[i].key && r.running === b[i].running && r.lines === b[i].lines && r.desc === b[i].desc);
