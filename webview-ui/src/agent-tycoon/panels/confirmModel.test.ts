/** T-182: the 차례대로 확인하기 queue (order, device groups, the card) and what each answer sends. */
import { describe, expect, it } from 'vitest';

import type { BoardTask } from '../../../../core/src/messages.js';
import {
  answerEdit,
  authorOf,
  confirmCount,
  confirmMerge,
  confirmPosition,
  confirmQueue,
  currentTask,
  deviceGroups,
  groupRows,
  lastWriter,
  pressAllowed,
  reviewEntry,
} from './confirmModel.js';

const at = (min: number) => new Date(Date.UTC(2026, 10, 27, 9, min)).toISOString();

const task = (id: string, over: Partial<BoardTask> = {}, reviewMin?: number): BoardTask => ({
  id,
  project: 'p',
  title: id,
  status: 'review',
  source: 'reported',
  createdAt: at(0),
  updatedAt: at(50),
  history: [
    { at: at(0), by: 'cli', change: 'add' },
    ...(reviewMin === undefined ? [] : [{ at: at(reviewMin), by: 'lead-p', change: 'status doing → review, note' }]),
  ],
  ...over,
});

describe('confirm queue', () => {
  it('lists review only, the longest waiting first, by the time it entered review', () => {
    const tasks = [task('T-3', {}, 30), task('T-1', {}, 10), task('T-2', { status: 'doing' }, 5), task('T-4', {}, 20)];
    expect(confirmQueue(tasks, () => true, {}).map((x) => x.id)).toEqual(['T-1', 'T-4', 'T-3']);
  });

  it('without a review line, the last change stands in for the time', () => {
    const tasks = [task('T-1', { updatedAt: at(40) }), task('T-2', {}, 35)];
    expect(confirmQueue(tasks, () => true, {}).map((x) => x.id)).toEqual(['T-2', 'T-1']);
  });

  it('groups by device: phone, pc, both, then the ones with no check steps', () => {
    const tasks = [
      task('T-1', {}, 1),
      task('T-2', { check: { device: 'both' } }, 2),
      task('T-3', { check: { device: 'pc' } }, 3),
      task('T-4', { check: { device: 'phone' } }, 4),
      task('T-5', { check: { device: 'pc' } }, 0),
    ];
    const queue = confirmQueue(tasks, () => true, {});
    expect(queue.map((x) => x.id)).toEqual(['T-4', 'T-5', 'T-3', 'T-2', 'T-1']);
    expect(deviceGroups(queue).map((g) => [g.device, g.tasks.map((x) => x.id)])).toEqual([
      ['phone', ['T-4']],
      ['pc', ['T-5', 'T-3']],
      ['both', ['T-2']],
      ['none', ['T-1']],
    ]);
  });

  it('keeps the project in view only', () => {
    const tasks = [task('T-1', { project: 'a' }, 1), task('T-2', { project: 'b' }, 2)];
    expect(confirmQueue(tasks, (x) => x.project === 'b', {}).map((x) => x.id)).toEqual(['T-2']);
  });

  it('an answered issue stays listed after it leaves review; the card moves on; later skips; the count is measured', () => {
    const tasks = [task('T-1', { status: 'done' }, 1), task('T-2', {}, 2), task('T-3', {}, 3), task('T-4', { status: 'done' }, 4)];
    const answered = { 'T-1': 'done', 'T-2': 'later' } as const;
    const queue = confirmQueue(tasks, () => true, answered);
    expect(queue.map((x) => x.id)).toEqual(['T-1', 'T-2', 'T-3']);
    expect(currentTask(queue, answered)?.id).toBe('T-3');
    expect(confirmCount(queue, answered)).toEqual({ answered: 1, total: 3 });
    expect(currentTask(queue, { ...answered, 'T-3': 'back' })).toBeNull();
  });

  it('the head counts where the card stands; a long group folds unless it holds the card', () => {
    const tasks = ['T-1', 'T-2', 'T-3', 'T-4', 'T-5'].map((id, i) => task(id, {}, i));
    const answered = { 'T-1': 'done', 'T-2': 'back' } as const;
    const queue = confirmQueue(tasks, () => true, answered);
    expect(confirmPosition(queue, currentTask(queue, answered))).toBe(3);
    expect(confirmPosition(queue, null)).toBe(5);
    expect(groupRows(queue, null, 4, false)).toEqual({ rows: queue.slice(0, 3), more: 2 });
    expect(groupRows(queue, queue[4], 4, false).more).toBe(0);
    expect(groupRows(queue, null, 4, true).more).toBe(0);
    expect(groupRows(queue.slice(0, 4), null, 4, false).more).toBe(0);
  });

  it('an answer the daemon has not applied yet is not shown again', () => {
    const queue = confirmQueue([task('T-1', {}, 1), task('T-2', {}, 2)], () => true, { 'T-1': 'done' });
    expect(currentTask(queue, { 'T-1': 'done' })?.id).toBe('T-2');
  });
});

describe('confirm answers', () => {
  it('confirmed is done; still wrong is doing with the stamped line in front of the note kept; later sends nothing', () => {
    expect(answerEdit('done')).toEqual({ status: 'done' });
    expect(answerEdit('back', '  still cut at 4000  ', '[owner 11-27 18:00]')).toEqual({ status: 'doing', note: '[owner 11-27 18:00] still cut at 4000' });
    expect(answerEdit('back', 'still cut', '[s]', 'fixed the cut')).toEqual({ status: 'doing', note: '[s] still cut\n\nfixed the cut' });
    expect(answerEdit('back', '   ', '[s]', 'kept')).toBeNull();
    expect(answerEdit('later')).toBeNull();
  });

  it('a long note loses its oldest end, never the owner\'s line', () => {
    const note = answerEdit('back', 'mine', '[s]', 'x'.repeat(1990), 20)!.note!;
    expect(note).toBe(`[s] mine\n\n${'x'.repeat(10)}`);
    expect(note.length).toBe(20);
  });

  it('confirming merges only when the daemon says its automatic merge would run', () => {
    expect(confirmMerge({ merged: false, autoMerges: true })).toBe('auto');
    expect(confirmMerge({ merged: false, autoMerges: false })).toBe('manual');
    expect(confirmMerge({ merged: false })).toBe('manual');
    expect(confirmMerge({ merged: true })).toBeNull();
    expect(confirmMerge(undefined)).toBeNull();
  });

  it('a press counts only for the card shown when it began, and not in its first moment', () => {
    const shown = { id: 'T-2', at: 1000 };
    expect(pressAllowed(shown, 'T-2', 1000 + 599, 600)).toBe(false);
    expect(pressAllowed(shown, 'T-2', 1000 + 600, 600)).toBe(true);
    expect(pressAllowed(shown, 'T-1', 5000, 600)).toBe(false);
    expect(pressAllowed(null, 'T-2', 5000, 600)).toBe(false);
  });
});

describe('who wrote what', () => {
  it('reads the review move and the last writer of a field from the history', () => {
    const t = task('T-1', {}, 10);
    t.history.push({ at: at(20), by: 'gui:Chrome', change: 'note' });
    expect(reviewEntry(t)).toEqual({ at: at(10), by: 'lead-p' });
    expect(lastWriter(t, 'note')).toEqual({ at: at(20), by: 'gui:Chrome' });
    expect(lastWriter(t, 'detail')).toEqual({ at: at(0), by: 'cli' });
    expect(reviewEntry({ history: [] })).toBeNull();
    expect(authorOf('gui:Chrome')).toEqual({ kind: 'owner', device: 'Chrome' });
    expect(authorOf('lead-p')).toEqual({ kind: 'name', name: 'lead-p' });
  });
});
