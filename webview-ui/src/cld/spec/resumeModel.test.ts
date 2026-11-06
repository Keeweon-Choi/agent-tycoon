// BRN K5: the overview's five lines from their sources: each source missing, tags kept, the server's
// caps shown as "more", the board fallbacks, live state over the board.
import { describe, expect, it } from 'vitest';

import type { BoardTask } from '../../../../core/src/messages.js';
import { RESUME_BOARD_SHOWN } from '../../constants.js';
import { type Handoff, type ResumeInput, type ResumeItem, resumeLines } from './resumeModel.js';

const task = (
  id: string,
  status: BoardTask['status'],
  updatedAt: string,
  extra: Partial<BoardTask> = {},
): BoardTask =>
  ({
    id,
    project: 'alpha',
    title: `${id} title`,
    status,
    source: 'user',
    createdAt: updatedAt,
    updatedAt,
    history: [],
    ...extra,
  }) as BoardTask;
const section = (items: Handoff['done']['items'], total = items.length) => ({ items, total });
const HANDOFF: Handoff = {
  at: '2026-11-06T01:00:00.000Z',
  format: 'ok',
  goal: section([{ text: 'goal', tag: 'fact' }]),
  done: section([{ text: 'shipped the reader', tag: 'fact' }], 7),
  open: section([{ text: 'phone wraps may break', tag: 'judgement' }, { text: 'untagged line' }]),
  next: section([{ text: 'one runner pass', tag: 'unverified' }]),
};
const base = (o: Partial<ResumeInput> = {}): ResumeInput => ({
  project: 'alpha',
  tasks: [
    task('T-1', 'doing', '2026-11-06T02:00:00Z', {
      assignee: { name: 'alpha-a' } as BoardTask['assignee'],
    }),
    task('T-2', 'review', '2026-11-06T03:00:00Z'),
    task('T-3', 'blocked', '2026-11-06T01:00:00Z'),
    ...Array.from({ length: 5 }, (_, i) => task(`T-1${i}`, 'done', `2026-11-0${i + 1}T00:00:00Z`)),
    task('T-20', 'todo', '2026-11-01T00:00:00Z', { priority: 'P2' }),
    task('T-21', 'todo', '2026-11-02T00:00:00Z', { priority: 'P0' }),
    task('T-9', 'doing', '2026-11-06T09:00:00Z', { project: 'beta' }),
  ],
  handoff: HANDOFF,
  team: [
    { name: 'alpha', role: 'lead', state: 'working', agentId: 1 },
    { name: 'alpha-a', role: 'worker', state: 'resting', agentId: 2 },
    { name: 'alpha-b', role: 'worker', state: 'off', agentId: null },
  ],
  waiting: {},
  approvals: [],
  leadActivity: null,
  ...o,
});
const ids = (items: ResumeItem[]) => items.map((x) => (x.src === 'board' ? x.task.id : '?'));
const byKey = (o?: Partial<ResumeInput>) =>
  Object.fromEntries(resumeLines(base(o)).map((l) => [l.key, l]));

describe('resumeLines', () => {
  it('five lines in order, each item with its source; another project stays out', () => {
    const lines = resumeLines(base());
    expect(lines.map((l) => l.key)).toEqual(['now', 'done', 'blocked', 'who', 'next']);
    expect(JSON.stringify(lines)).not.toContain('T-9');
    const l = byKey();
    expect(l.now.items).toEqual([
      { src: 'board', task: { id: 'T-1', title: 'T-1 title', status: 'doing' }, who: 'alpha-a' },
      { src: 'board', task: { id: 'T-2', title: 'T-2 title', status: 'review' } },
    ]);
    // how far: the handoff's lines first, then the latest done Tasks (newest first, capped).
    expect(l.done.items[0]).toEqual({ src: 'handoff', text: 'shipped the reader', tag: 'fact' });
    expect(ids(l.done.items.slice(1))).toEqual(
      ['T-14', 'T-13', 'T-12'].slice(0, RESUME_BOARD_SHOWN),
    );
    expect(l.done.more).toBe(6);
    expect(l.done.note).toBeUndefined();
  });

  it('tags as written: a guess stays a guess, an untagged line has no tag of its own', () => {
    const l = byKey();
    expect(l.blocked.items).toEqual([
      { src: 'board', task: { id: 'T-3', title: 'T-3 title', status: 'blocked' } },
      { src: 'handoff', text: 'phone wraps may break', tag: 'judgement' },
      { src: 'handoff', text: 'untagged line' },
    ]);
    expect(l.next.items).toEqual([{ src: 'handoff', text: 'one runner pass', tag: 'unverified' }]);
  });

  it('no handoff on record: said on the lines that read one, the board fills in, nothing made up', () => {
    const l = byKey({ handoff: null });
    for (const k of ['done', 'blocked', 'next']) expect(l[k].note).toBe('noHandoff');
    expect(l.now.note).toBeUndefined();
    expect(l.who.note).toBeUndefined();
    expect(l.done.items.every((x: { src: string }) => x.src === 'board')).toBe(true);
    // next falls back to the top of todo (P0 before P2).
    expect(ids(l.next.items)).toEqual(['T-21', 'T-20']);
    // Not read yet: no note (the line does not claim it is missing).
    expect(byKey({ handoff: undefined }).done.note).toBeUndefined();
    // A free-form handoff says so; its empty next steps falls back to the board as well.
    const free = byKey({ handoff: { ...HANDOFF, format: 'free', next: section([]) } });
    expect(free.next.note).toBe('freeHandoff');
    expect(free.next.items[0]).toMatchObject({ src: 'board', task: { id: 'T-21' } });
  });

  it('every source empty: five empty lines, no counts invented', () => {
    const lines = resumeLines(base({ tasks: [], handoff: null, team: [] }));
    expect(lines.map((l) => [l.items.length, l.more])).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
  });

  it("live state: the Lead's activity on now, waits and approvals on blocked, who with waiting over the board", () => {
    const l = byKey({
      leadActivity: 'Running tests',
      waiting: { 2: 'permission' },
      approvals: [
        { project: 'alpha', caller: 'alpha', title: 'start a Worker' },
        { project: 'beta', caller: 'beta', title: 'not mine' },
      ],
    });
    expect(l.now.items[0]).toEqual({
      src: 'live',
      kind: 'activity',
      who: 'alpha',
      text: 'Running tests',
    });
    expect(l.blocked.items).toContainEqual({
      src: 'live',
      kind: 'approval',
      who: 'alpha',
      text: 'start a Worker',
    });
    expect(l.blocked.items).toContainEqual({
      src: 'live',
      kind: 'wait',
      who: 'alpha-a',
      reason: 'permission',
    });
    expect(JSON.stringify(l.blocked)).not.toContain('not mine');
    // An off Worker is left out; the Lead is always there.
    expect(l.who.items).toEqual([
      { src: 'live', kind: 'member', who: 'alpha', role: 'lead', state: 'working' },
      { src: 'live', kind: 'member', who: 'alpha-a', role: 'worker', state: 'waiting' },
    ]);
  });
});
