/**
 * T-183 개발실 › 이슈: one issue told as six steps (맡김, 고치는 중, 바뀐 것, 검사, 머지, 배포), each
 * built only from what is stored (owner 11-27: nothing on screen is written at display time). This is
 * the pure part: which steps have data, which one is current, the status moves to and from 검토 out of
 * the Task's history, the run on it, and the list's rows. IssueView.tsx draws it.
 */
import type { BoardTask, RepoMerge, RepoWorktree } from '../../../../core/src/messages.js';

export const STEPS = ['assign', 'work', 'changes', 'check', 'merge', 'deploy'] as const;
export type StepId = (typeof STEPS)[number];

/** One `status a → b` of a history line (engine/tasks.ts describe() writes `status doing → review`). */
export interface StatusMove {
  at: string;
  by: string;
  from: string;
  to: string;
}

const MOVE_RE = /(?:^|, )status ([^\s,]+) → ([^\s,]+)/;

export function statusMoves(history: readonly BoardTask['history'][number][]): StatusMove[] {
  return history.flatMap((h) => {
    const m = MOVE_RE.exec(h.change);
    return m ? [{ at: h.at, by: h.by, from: m[1], to: m[2] }] : [];
  });
}

/** The newest Execution with a start: the run on the issue (live while it has no end). */
export function runOf(task: Pick<BoardTask, 'executions'>): { since: string; live: boolean } | null {
  const run = (task.executions ?? []).filter((e) => e.startedAt).at(-1);
  return run?.startedAt ? { since: run.startedAt, live: !run.endedAt } : null;
}

export interface StoryFacts {
  task: Pick<BoardTask, 'status' | 'history' | 'executions' | 'testsRan' | 'testsPassed'>;
  wt: Pick<RepoWorktree, 'ahead' | 'dirty'>;
  /** Its branch went into the base (devroomState.isMerged). */
  merged: boolean;
  /** The agent on its worktree (its assignee), if any. */
  agent: string | null;
  /** Changed files the daemon listed; null = not read yet. */
  files: number | null;
  /** Review notes on its worktree. */
  notes: number;
  /** The merge pre-check answered. */
  checked: boolean;
}

/** The issue's state in one word: the list's blue phrase and the story's sentence are fixed templates per state. */
export type StoryState = 'assign' | 'work' | 'workAgain' | 'blocked' | 'check' | 'checkAgain' | 'merged' | 'done';

export interface Story {
  current: StepId;
  /** The current step's place in STEPS, 1-based: a position in a fixed sequence, never a measurement. */
  position: number;
  state: StoryState;
  /** Steps with something stored to show; the others are one dim line. */
  has: Record<StepId, boolean>;
  /** Steps at or before the current one (the ones after it are not reached: drawn dim). */
  reached: Record<StepId, boolean>;
  /** The history's moves into or out of 검토, oldest first. */
  reviewMoves: StatusMove[];
  /** The newest of them when it sent the issue back (out of 검토, not to done). */
  returned: StatusMove | null;
  /** 1 + the times it came back from 검토. */
  round: number;
  /** The work rounds from the history's moves into and out of 진행 중 (end unset: still under way). */
  rounds: { start: string; end?: string }[];
  /** When the issue took its current status (the newest status move), else null. */
  since: string | null;
  run: { since: string; live: boolean } | null;
}

/** The current step follows the stored status only (a reported status: its place is not a measurement). */
function currentOf(status: BoardTask['status'], merged: boolean): StepId {
  if (merged || status === 'done') return 'merge';
  if (status === 'review') return 'check';
  if (status === 'doing' || status === 'blocked') return 'work';
  return 'assign';
}

function stateOf(status: BoardTask['status'], merged: boolean, again: boolean): StoryState {
  if (merged) return 'merged';
  if (status === 'done') return 'done';
  if (status === 'blocked') return 'blocked';
  if (status === 'doing') return again ? 'workAgain' : 'work';
  if (status === 'review') return again ? 'checkAgain' : 'check';
  return 'assign';
}

export function story(f: StoryFacts): Story {
  const moves = statusMoves(f.task.history);
  const reviewMoves = moves.filter((m) => m.from === 'review' || m.to === 'review');
  const returns = reviewMoves.filter((m) => m.from === 'review' && m.to !== 'done');
  const last = reviewMoves.at(-1);
  const run = runOf(f.task);
  const current = currentOf(f.task.status, f.merged);
  const position = STEPS.indexOf(current) + 1;
  const rounds: Story['rounds'] = [];
  for (const m of moves) {
    if (m.to === 'doing') rounds.push({ start: m.at });
    else if (m.from === 'doing' && rounds.at(-1) && !rounds.at(-1)!.end) rounds.at(-1)!.end = m.at;
  }
  const has: Record<StepId, boolean> = {
    assign: true,
    work: f.agent !== null || run !== null || rounds.length > 0,
    changes: (f.files ?? 0) > 0 || f.wt.ahead > 0 || f.wt.dirty > 0,
    check: f.notes > 0 || !!f.task.testsRan || !!f.task.testsPassed || reviewMoves.length > 0,
    merge: f.merged || f.checked,
    // The engine links no deploy to an issue: always the one fixed line.
    deploy: false,
  };
  const reached = Object.fromEntries(STEPS.map((s, i) => [s, i < position])) as Record<StepId, boolean>;
  return {
    current,
    position,
    state: stateOf(f.task.status, f.merged, returns.length > 0),
    has,
    reached,
    reviewMoves,
    returned: last && last.from === 'review' && last.to !== 'done' ? last : null,
    round: returns.length + 1,
    rounds,
    since: moves.at(-1)?.at ?? null,
    run,
  };
}

/** The 하고 있는 일 list: rows whose worktree record names an open (not done) issue. */
export const openIssues = <T extends { task?: Pick<BoardTask, 'status'> }>(rows: readonly T[]): T[] =>
  rows.filter((r) => r.task !== undefined && r.task.status !== 'done');

/** The office's merges into the base that succeeded on `now`'s local day, newest first. */
export function todayMerges(merges: readonly RepoMerge[], now: number): RepoMerge[] {
  const day = new Date(now).toDateString();
  return merges.filter((m) => m.ok && new Date(m.at).toDateString() === day).sort((a, b) => b.at.localeCompare(a.at));
}

/** A long path kept readable in one row: its first folder, `…`, and its last two parts. */
export function shortPath(path: string): string {
  const parts = path.split('/');
  return parts.length > 3 ? `${parts[0]}/…/${parts.slice(-2).join('/')}` : path;
}
