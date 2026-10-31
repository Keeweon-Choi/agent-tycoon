/**
 * P4 개발실 (dev room), its pure rules: which chip a task worktree's card wears, the order of the
 * rail, the remembered filter. devroomStore.ts keeps the state, WorktreeRail.tsx and
 * DevRoomPhone.tsx draw it.
 */
import type { BoardTask, RepoWorktree } from '../../../../core/src/messages.js';

/** The rail's chips, strongest first (plan 1.1). */
export type Chip = 'conflict' | 'approve' | 'review' | 'fixing' | 'working' | 'idle' | 'merged';

export interface ChipInput {
  wt: RepoWorktree;
  task?: Pick<BoardTask, 'status'>;
  /** The assignee waits on a permission (its card's yellow dot). */
  attention: boolean;
  /** The assignee is in a turn. */
  busy: boolean;
  /** Review notes on this worktree were sent to its Worker. */
  notesSent: boolean;
}

/** The files a merge into its base would conflict on (the daemon's pre-check, while viewed). */
export const conflictsOf = (wt: RepoWorktree): number => wt.conflicts?.length ?? 0;

/**
 * Merged = its branch went into the base and nothing came after. A fresh worktree with no commit
 * yet is also `merged` by git's count, so a merge record (or the Task being done) must say so too.
 */
export const isMerged = (wt: RepoWorktree, task?: Pick<BoardTask, 'status'>): boolean =>
  wt.merged && (wt.merge?.ok === true || task?.status === 'done');

export function chipOf({ wt, task, attention, busy, notesSent }: ChipInput): Chip {
  if (isMerged(wt, task)) return 'merged';
  if (conflictsOf(wt) > 0) return 'conflict';
  if (attention) return 'approve';
  if (task?.status === 'review') return 'review';
  if (task?.status === 'doing' && notesSent) return 'fixing';
  if (busy) return 'working';
  return 'idle';
}

/** The rail's order: the open ones as they were made, the merged ones (dimmed) last. */
export function railOrder<T extends { chip: Chip; wt: RepoWorktree }>(rows: readonly T[]): T[] {
  const open = rows.filter((r) => r.chip !== 'merged');
  const done = rows.filter((r) => r.chip === 'merged');
  const byCreated = (a: T, b: T) => a.wt.created.localeCompare(b.wt.created);
  return [...open.sort(byCreated), ...done.sort(byCreated)];
}

/** The card's title: its Task's, else the worktree's folder name. */
export const titleOf = (wt: RepoWorktree, tasks: readonly BoardTask[]): string =>
  (wt.taskId && tasks.find((x) => x.id === wt.taskId)?.title) || wt.task;

/** What the rail is narrowed to: one project, or every one (null). */
export function parseFilter(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const value = (JSON.parse(raw) as { project?: unknown }).project;
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

/** The one project shown: the filtered one while it still exists, or the only project; null = all. */
export const shownProject = (all: readonly string[], filter: string | null): string | null =>
  filter && all.includes(filter) ? filter : all.length === 1 ? all[0] : null;

/** The projects the rail shows. */
export const shownProjects = (all: readonly string[], filter: string | null): string[] => {
  const one = shownProject(all, filter);
  return one ? [one] : [...all];
};
