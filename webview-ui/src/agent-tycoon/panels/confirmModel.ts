/**
 * T-182 차례대로 확인하기, pure: which issues wait for the owner to try them (Tasks in `review`), in what
 * order, grouped by the device their 확인 방법 names, and what each answer sends. Everything comes from the
 * Task store as the daemon sent it; who wrote a part is read from the Task's own history (its `by`).
 */
import type { BoardTask, BoardTaskCheckDevice, RepoWorktree, TaskEditFields } from '../../../../core/src/messages.js';
import { TASK_NOTE_MAX } from '../../constants.js';

/** 확인했어요 · 아직 이상해요 · 나중에 (this visit only). */
export type ConfirmAnswer = 'done' | 'back' | 'later';
export type DeviceGroup = BoardTaskCheckDevice | 'none';
export const DEVICE_ORDER: readonly DeviceGroup[] = ['phone', 'pc', 'both', 'none'];

/** A history line that moved the Task into review ("status doing → review", maybe among others). */
const TO_REVIEW = /(^|, )status \S+ → review(,|$)/;

/** Who wrote a history line: the office (`gui:<device>`, the owner) or a name (an agent, `cli`). */
export type Author = { kind: 'owner'; device: string } | { kind: 'name'; name: string };
export const authorOf = (by: string): Author =>
  by.startsWith('gui:') ? { kind: 'owner', device: by.slice('gui:'.length) } : { kind: 'name', name: by };

/** The last time the Task moved into review, and by whom; null when its history no longer says. */
export function reviewEntry(task: Pick<BoardTask, 'history'>): { at: string; by: string } | null {
  // ponytail: the daemon keeps the last 50 history lines; a Task changed that often since has no entry.
  for (let i = task.history.length - 1; i >= 0; i--)
    if (TO_REVIEW.test(task.history[i].change)) return { at: task.history[i].at, by: task.history[i].by };
  return null;
}

/** The last line that wrote `field` (its creation counts), or null. */
export function lastWriter(task: Pick<BoardTask, 'history'>, field: 'detail' | 'note' | 'check'): { at: string; by: string } | null {
  for (let i = task.history.length - 1; i >= 0; i--) {
    const h = task.history[i];
    if (h.change === 'add' || h.change === 'import' || h.change.split(', ').includes(field)) return { at: h.at, by: h.by };
  }
  return null;
}

export const deviceOf = (task: Pick<BoardTask, 'check'>): DeviceGroup => task.check?.device ?? 'none';

const since = (task: BoardTask) => Date.parse(reviewEntry(task)?.at ?? task.updatedAt) || 0;

/**
 * This visit's issues: the Tasks in review where `shown` says, plus the ones answered in this visit (they stay
 * listed, marked), grouped by device (phone, pc, both, none), each group the longest waiting first.
 */
export function confirmQueue(
  tasks: readonly BoardTask[],
  shown: (task: BoardTask) => boolean,
  answered: Readonly<Record<string, ConfirmAnswer>>,
): BoardTask[] {
  return tasks
    .filter((task) => shown(task) && (task.status === 'review' || answered[task.id] !== undefined))
    .sort(
      (a, b) =>
        DEVICE_ORDER.indexOf(deviceOf(a)) - DEVICE_ORDER.indexOf(deviceOf(b)) || since(a) - since(b) || a.id.localeCompare(b.id),
    );
}

/** The queue's groups in device order, empty ones left out. */
export function deviceGroups(queue: readonly BoardTask[]): Array<{ device: DeviceGroup; tasks: BoardTask[] }> {
  return DEVICE_ORDER.map((device) => ({ device, tasks: queue.filter((task) => deviceOf(task) === device) })).filter((g) => g.tasks.length > 0);
}

/** The issue on the card: the first still in review that this visit has not answered or put off. */
export const currentTask = (queue: readonly BoardTask[], answered: Readonly<Record<string, ConfirmAnswer>>): BoardTask | null =>
  queue.find((task) => task.status === 'review' && answered[task.id] === undefined) ?? null;

/** The head's measured count: the issues answered (confirmed or sent back) out of this visit's list. */
export function confirmCount(queue: readonly BoardTask[], answered: Readonly<Record<string, ConfirmAnswer>>): { answered: number; total: number } {
  return { answered: queue.filter((task) => answered[task.id] === 'done' || answered[task.id] === 'back').length, total: queue.length };
}

/** The head's "확인 n / N": where the card stands in this visit's list (the end once all are seen). */
export const confirmPosition = (queue: readonly BoardTask[], current: BoardTask | null): number =>
  current ? queue.indexOf(current) + 1 : queue.length;

/** A queue group's rows: all of them when short or when it holds the card, else the first ones and how many more. */
export function groupRows(tasks: readonly BoardTask[], current: BoardTask | null, max: number, open: boolean): { rows: BoardTask[]; more: number } {
  if (open || tasks.length <= max || (current && tasks.includes(current))) return { rows: [...tasks], more: 0 };
  return { rows: tasks.slice(0, max - 1), more: tasks.length - (max - 1) };
}

/**
 * What an answer changes on the Task, through the board's own `taskEdit`: 확인했어요 is done (the board's
 * move to 끝남); 아직 이상해요 goes back to doing (what sending review notes does) with the owner's line, behind
 * its fixed `stamp` (who and when), in front of the note that was there, cut to the store's `max` from the
 * old end so his words always survive; 나중에 changes nothing.
 * ponytail: read, prepend, write: a note the lead writes at the same moment wins or loses whole; a
 * server-side append would close that if it shows.
 */
export function answerEdit(answer: ConfirmAnswer, line = '', stamp = '', prev = '', max = TASK_NOTE_MAX): TaskEditFields | null {
  if (answer === 'done') return { status: 'done' };
  if (answer !== 'back' || !line.trim()) return null;
  const mine = `${stamp} ${line.trim()}`.trim();
  return { status: 'doing', note: (prev.trim() ? `${mine}\n\n${prev.trim()}` : mine).slice(0, max) };
}

/**
 * What confirming does to the issue's worktree branch: the daemon merges a Task's worktree when it becomes
 * done (mergeNewlyDone, server/src/agent-tycoon/engine/taskWorktree.ts) unless that merge is refused (a
 * protected base, review notes); the repo state says which (`autoMerges`). `auto`: confirming merges it;
 * `manual`: it stays unmerged (the 머지 is the dev room's); null: nothing to merge.
 */
export function confirmMerge(worktree: Pick<RepoWorktree, 'merged' | 'autoMerges'> | undefined): 'auto' | 'manual' | null {
  if (!worktree || worktree.merged) return null;
  return worktree.autoMerges ? 'auto' : 'manual';
}

/** A press answers only the card that was on screen when it began, once it has shown for `guardMs`
 *  (a double click or tap must not land on the card that replaced it). */
export const pressAllowed = (shown: { id: string; at: number } | null, id: string, now: number, guardMs: number): boolean =>
  !!shown && shown.id === id && now - shown.at >= guardMs;
