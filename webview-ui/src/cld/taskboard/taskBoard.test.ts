import { describe, expect, it } from 'vitest';

import type { BoardTask, CodexTask, OfficeJob, TrackedItem, TrackedItems } from '../../../../core/src/messages.js';
import {
  assigneeOf,
  boardItems,
  DONE_SHOWN,
  filterChoices,
  filterItems,
  goalProgress,
  groupItems,
  nestItems,
  NO_FILTER,
  nowStrip,
  observedRuns,
  toggleGoalFilter,
  trackedColumn,
  trackedCount,
} from './taskBoard.js';

const at = (min: number) => new Date(Date.UTC(2026, 9, 23, 14, min)).toISOString();
const task = (o: Partial<BoardTask> & { id: string }): BoardTask => ({
  project: 'cld-gui',
  title: o.id,
  status: 'todo',
  source: 'reported',
  createdAt: at(0),
  updatedAt: at(0),
  history: [{ at: at(0), by: 'cli', change: 'import' }],
  ...o,
});
const codex: CodexTask[] = [
  { id: 'c-run', project: 'cld-gui', state: 'running', model: 'm1', started: at(5), branch: 'task/s4' },
  { id: 'c-free', project: 'pofol', state: 'limit', started: at(1) },
];
const jobs: OfficeJob[] = [
  { id: 'c-run', pid: 1, project: 'cld-gui', cmd: 'codex', started: at(5) }, // the Codex task's own job
  { id: 'j-1', pid: 2, project: 'alpha', cmd: 'npm test', label: 'npm job', started: at(3) },
  { id: 'j-2', pid: 3, project: 'alpha', cmd: 'x', started: at(1), ended: at(2), exit: 1 },
];

describe('task board (DEV-BOARD)', () => {
  it('observed runs: Codex tasks and jobs once each, with the engine’s own states', () => {
    const runs = observedRuns(codex, jobs);
    expect(runs.map((r) => `${r.kind}:${r.id}:${r.state}`)).toEqual([
      'codex:c-run:running',
      'codex:c-free:limit',
      'job:j-1:running',
      'job:j-2:failed',
    ]);
  });

  it('waits are not running: a GPU-queued job and a queued Codex task have their own states and are not doing (U-03)', () => {
    const waiting = observedRuns(
      [{ id: 'c-q', project: 'p', state: 'running', created: at(2), started: null }],
      [{ id: 'j-q', pid: 4, project: 'p', cmd: 'x', gpu: 'queued', created: at(3), started: null }],
    );
    expect(waiting.map((r) => `${r.id}:${r.state}`)).toEqual(['c-q:queued', 'j-q:gpuWait']);
    const items = boardItems([], [{ id: 'c-q', project: 'p', state: 'running', created: at(2), started: null }], [
      { id: 'j-q', pid: 4, project: 'p', cmd: 'x', gpu: 'queued', created: at(3), started: null },
    ]);
    expect(items.map((i) => [i.id, i.status])).toEqual([
      ['c-q', 'todo'],
      ['j-q', 'blocked'],
    ]);
  });

  it('a reported task carries its linked run; unlinked runs become observed cards', () => {
    const tasks = [
      task({ id: 'S4', status: 'doing', owner: { kind: 'codex', name: 'Codex W' }, links: [{ kind: 'codex', ref: 'c-run' }, { kind: 'job', ref: 'gone' }] }),
    ];
    const items = boardItems(tasks, codex, jobs);
    const s4 = items.find((i) => i.id === 'S4')!;
    expect(s4).toMatchObject({ source: 'reported', since: at(0), missing: ['gone'] });
    expect(s4.runs.map((r) => r.id)).toEqual(['c-run']);
    expect(items.filter((i) => i.source === 'observed').map((i) => [i.id, i.status])).toEqual([
      ['c-free', 'blocked'],
      ['j-1', 'doing'],
      ['j-2', 'done'],
    ]);
    // Nothing invents progress: no item has a percentage or an ETA field.
    expect(JSON.stringify(items)).not.toMatch(/pct|eta|percent/i);
  });

  it('since: the latest change to doing, else when it came in as doing', () => {
    const moved = task({
      id: 'A',
      status: 'doing',
      history: [
        { at: at(0), by: 'cli', change: 'add' },
        { at: at(9), by: 'cli', change: 'status todo → doing, note' },
      ],
    });
    expect(boardItems([moved])[0].since).toBe(at(9));
    expect(boardItems([task({ id: 'B', status: 'doing' })])[0].since).toBe(at(0));
  });

  it('now strip: one row per owner with doing items', () => {
    const tasks = [
      task({ id: 'A', status: 'doing', owner: { kind: 'worker', name: 'Ann' } }),
      task({ id: 'B', status: 'doing', owner: { kind: 'worker', name: 'Ann' } }),
      task({ id: 'C', status: 'review', owner: { kind: 'worker', name: 'Bo' } }),
    ];
    const rows = nowStrip(boardItems(tasks, codex, jobs));
    // The longest-running owner first; the review task is not in the strip.
    expect(rows.map((r) => [r.key, r.items.map((i) => i.id)])).toEqual([
      ['worker:Ann', ['A', 'B']],
      ['lead:alpha', ['j-1']],
      ['codex:Codex m1', ['c-run']],
    ]);
  });

  it('groups in board order, P0 first; done keeps the latest 20; filters by project, goal, owner', () => {
    const tasks = [
      task({ id: 'P2', status: 'todo', priority: 'P2' }),
      task({ id: 'P0', status: 'todo', priority: 'P0', goal: 'Security' }),
      task({ id: 'W1', status: 'proposed' }),
      ...Array.from({ length: 25 }, (_, n) => task({ id: `D${n}`, status: 'done', updatedAt: at(n) })),
    ];
    const groups = groupItems(boardItems(tasks));
    expect(groups.map((g) => g.status)).toEqual(['doing', 'review', 'blocked', 'proposed', 'todo', 'done']);
    // C5a: a Worker's create_task waits for its Lead in its own group.
    expect(groups[3].items.map((i) => i.id)).toEqual(['W1']);
    expect(groups[4].items.map((i) => i.id)).toEqual(['P0', 'P2']);
    expect(groups[5]).toMatchObject({ total: 25 });
    expect(groups[5].items).toHaveLength(DONE_SHOWN);
    expect(groups[5].items[0].id).toBe('D24');
    const items = boardItems(tasks, codex, jobs);
    expect(filterItems(items, { ...NO_FILTER, goal: 'Security' }).map((i) => i.id)).toEqual(['P0']);
    expect(filterItems(items, { ...NO_FILTER, project: 'alpha' }).map((i) => i.id)).toEqual(['j-1', 'j-2']);
    expect(filterChoices(items).projects).toEqual(['alpha', 'cld-gui', 'pofol']);
  });

  it('summarizes fixed MVP goals in order, with done and active statuses', () => {
    const items = boardItems([
      task({ id: 'S-done', goal: 'Security', status: 'done' }),
      task({ id: 'S-review', goal: 'Security', status: 'review' }),
      task({ id: 'C-doing', goal: 'Core Orchestration', status: 'doing' }),
      task({ id: 'C-todo', goal: 'Core Orchestration', status: 'todo' }),
      task({ id: 'Other', status: 'blocked' }),
    ]);
    expect(goalProgress(items)).toEqual({
      goals: [
        { goal: 'Security', total: 2, done: 1, active: 1 },
        { goal: 'Core Orchestration', total: 2, done: 0, active: 1 },
        { goal: 'Collaboration & Workbench', total: 0, done: 0, active: 0 },
        { goal: 'Desktop & Installer', total: 0, done: 0, active: 0 },
        { goal: 'UX & Onboarding', total: 0, done: 0, active: 0 },
        { goal: 'Release Candidate', total: 0, done: 0, active: 0 },
        { goal: 'Public Release', total: 0, done: 0, active: 0 },
        { goal: 'other', total: 1, done: 0, active: 0 },
      ],
      overall: { goal: 'overall', total: 4, done: 1, active: 2 },
    });
  });

  it('keeps only the project filter in the MVP overview and handles no tasks', () => {
    const items = boardItems([
      task({ id: 'A', project: 'alpha', goal: 'Security', status: 'done' }),
      task({ id: 'B', project: 'beta', goal: 'Security', status: 'review' }),
      task({ id: 'C', project: 'alpha', goal: 'Core Orchestration', status: 'doing' }),
    ]);
    const progress = goalProgress(items, { ...NO_FILTER, project: 'alpha', goal: 'Security' });
    expect(progress.goals.slice(0, 2)).toEqual([
      { goal: 'Security', total: 1, done: 1, active: 0 },
      { goal: 'Core Orchestration', total: 1, done: 0, active: 1 },
    ]);
    expect(progress.overall).toEqual({ goal: 'overall', total: 2, done: 1, active: 1 });
    expect(goalProgress([])).toEqual({
      goals: [
        { goal: 'Security', total: 0, done: 0, active: 0 },
        { goal: 'Core Orchestration', total: 0, done: 0, active: 0 },
        { goal: 'Collaboration & Workbench', total: 0, done: 0, active: 0 },
        { goal: 'Desktop & Installer', total: 0, done: 0, active: 0 },
        { goal: 'UX & Onboarding', total: 0, done: 0, active: 0 },
        { goal: 'Release Candidate', total: 0, done: 0, active: 0 },
        { goal: 'Public Release', total: 0, done: 0, active: 0 },
      ],
      overall: { goal: 'overall', total: 0, done: 0, active: 0 },
    });
  });

  it('toggles a summary goal without changing the other filters', () => {
    const selected = toggleGoalFilter({ project: 'alpha', goal: null, owner: 'lead:alpha' }, 'Security');
    expect(selected).toEqual({ project: 'alpha', goal: 'Security', owner: 'lead:alpha' });
    expect(toggleGoalFilter(selected, 'Security')).toEqual({ project: 'alpha', goal: null, owner: 'lead:alpha' });
  });
});

describe('task board with the D6 Task store', () => {
  it('an Execution is a run of its task like a link (one card, no duplicate observed card)', () => {
    const t = task({ id: 'E', status: 'doing', executions: [{ id: 'job:j-1', kind: 'job', ref: 'j-1' }], links: [{ kind: 'job', ref: 'j-1' }] });
    const items = boardItems([t], [], jobs);
    expect(items.find((i) => i.id === 'E')!.runs.map((r) => r.id)).toEqual(['j-1']);
    expect(items.some((i) => i.id === 'j-1')).toBe(false); // no observed card of its own
    const only = boardItems([task({ id: 'F', executions: [{ id: 'job:j-1', kind: 'job', ref: 'j-1' }] })], [], jobs);
    expect(only.find((i) => i.id === 'F')!.runs.map((r) => r.id)).toEqual(['j-1']);
    expect(only.some((i) => i.id === 'j-1')).toBe(false);
  });

  it('children nest under their topmost shown ancestor; a child whose parent is filtered out stays on top', () => {
    const items = boardItems([
      task({ id: 'P' }),
      task({ id: 'C1', parentId: 'P', status: 'doing' }),
      task({ id: 'C2', parentId: 'C1' }),
      task({ id: 'O', parentId: 'gone' }),
    ]);
    const { top, children } = nestItems(items);
    expect(top.map((i) => i.id)).toEqual(['P', 'O']);
    expect(children.get('P')!.map((i) => i.id)).toEqual(['C1', 'C2']);
    const shown = nestItems(items.filter((i) => i.id !== 'P'));
    expect(shown.top.map((i) => i.id)).toEqual(['C1', 'O']);
    expect(shown.children.get('C1')!.map((i) => i.id)).toEqual(['C2']);
    // A loop in the data never hangs or drops a task.
    const loop = nestItems(boardItems([task({ id: 'X', parentId: 'Y' }), task({ id: 'Y', parentId: 'X' })]));
    expect(loop.top.length + [...loop.children.values()].flat().length).toBe(2);
  });

  it('the assignee by name, marked removed once its assignment is gone', () => {
    const t = task({ id: 'A', assignee: { assignmentId: 'a_workerbbbb', name: 'alpha-w' } });
    expect(assigneeOf(t)).toEqual({ name: 'alpha-w', removed: false });
    expect(assigneeOf(t, ['a_workerbbbb'])).toEqual({ name: 'alpha-w', removed: true });
    expect(assigneeOf(task({ id: 'B' }))).toBeNull();
  });
});

// U-48 phase 1: the agents' own lists next to the cards.
const line = (o: Partial<TrackedItem> & { key: string }): TrackedItem => ({
  kind: 'agentList',
  title: o.key,
  status: 'todo',
  source: 'reported',
  ...o,
});
const trackedProject = (project: string, items: TrackedItem[], more: TrackedItems['more'] = []): TrackedItems => ({
  type: 'trackedItems',
  project,
  items,
  more,
});
const sess = (key: string, o: Partial<TrackedItem> = {}) =>
  line({ key: `session:${key}`, kind: 'session', source: 'observed', ref: key.slice(0, 8), ...o });

describe('tracked items on the board (U-48)', () => {
  it('a session is a card with its list folded under it; the columns follow its status', () => {
    const items = boardItems([], [], [], [
      trackedProject('cld-gui', [
        sess('aaaa1111', { status: 'doing', title: 'working' }),
        line({ key: 'claude-task:aaaa1111/1', parentKey: 'session:aaaa1111', title: 'first', status: 'doing' }),
        line({ key: 'claude-task:aaaa1111/2', parentKey: 'session:aaaa1111', title: 'second' }),
        sess('bbbb2222', { status: 'review' }),
        sess('cccc3333', { status: 'unknown', ended: true }),
      ], [{ parentKey: 'session:aaaa1111', count: 4 }]),
    ]);
    const card = items.find((i) => i.key === 'session:aaaa1111')!;
    expect([card.source, card.status, card.project, card.owner]).toEqual(['tracked', 'doing', 'cld-gui', null]);
    expect(card.trackedChildren?.map((c) => c.title)).toEqual(['first', 'second']);
    expect(card.trackedMore).toBe(4);
    expect(items.find((i) => i.key === 'session:bbbb2222')!.status).toBe('review');
    // An ended session is not "done": it only sits with the finished (its own named column constant).
    expect(items.find((i) => i.key === 'session:cccc3333')!.status).toBe(trackedColumn('unknown'));
    expect(groupItems(items).find((g) => g.status === 'doing')!.items.map((i) => i.key)).toEqual(['session:aaaa1111']);
  });

  it('a line that names a Task by its exact id goes under that Task, out of the session fold; nothing else links', () => {
    const items = boardItems(
      [task({ id: 'T-12', status: 'doing' })],
      [],
      [],
      [
        trackedProject('cld-gui', [
          sess('aaaa1111'),
          line({ key: 'k1', parentKey: 'session:aaaa1111', title: 'build T-12', taskId: 'T-12' }),
          line({ key: 'k2', parentKey: 'session:aaaa1111', title: 'build T-99', taskId: 'T-99' }), // no such Task
          line({ key: 'k3', parentKey: 'session:aaaa1111', title: 'twelve' }), // similar title, no id: no link
        ]),
      ],
    );
    expect(items.find((i) => i.id === 'T-12')!.trackedChildren?.map((c) => c.key)).toEqual(['k1']);
    expect(items.find((i) => i.key === 'session:aaaa1111')!.trackedChildren?.map((c) => c.key)).toEqual(['k2', 'k3']);
  });

  it('a Codex checklist sits under the run’s card, or under the Task that linked the run', () => {
    const run: CodexTask = { id: 'c-run', project: 'cld-gui', state: 'running', started: at(5) };
    const checklist = trackedProject('cld-gui', [
      line({ key: 'p1', kind: 'codexProgress', parentKey: 'codex:c-run', title: 'step', source: 'inferred', status: 'doing' }),
    ]);
    const free = boardItems([], [run], [], [checklist]);
    expect(free.find((i) => i.key === 'codex:c-run')!.trackedChildren?.map((c) => c.key)).toEqual(['p1']);
    const linked = boardItems(
      [task({ id: 'T-3', executions: [{ id: 'codex:c-run', kind: 'codex', ref: 'c-run' }] })],
      [run],
      [],
      [checklist],
    );
    expect(linked.find((i) => i.id === 'T-3')!.trackedChildren?.map((c) => c.key)).toEqual(['p1']);
    expect(linked.some((i) => i.key === 'codex:c-run')).toBe(false);
  });

  it('the MVP progress counts Tasks only; tracked items are counted apart', () => {
    const tracked = [
      trackedProject('cld-gui', [sess('aaaa1111', { status: 'doing' }), line({ key: 'x', parentKey: 'session:aaaa1111' })], [
        { parentKey: 'session:aaaa1111', count: 3 },
      ]),
      trackedProject('other', [sess('dddd4444')]),
    ];
    const tasks = [task({ id: 'T-1', goal: 'Security', status: 'done' }), task({ id: 'T-2', goal: 'Security' })];
    const withTracked = boardItems(tasks, [], [], tracked);
    expect(goalProgress(withTracked)).toEqual(goalProgress(boardItems(tasks)));
    expect(goalProgress(withTracked).overall).toMatchObject({ total: 2, done: 1 });
    // Only list lines: the line, the 3 left out; not the session cards.
    expect(trackedCount(tracked)).toBe(1 + 3);
    expect(trackedCount(tracked, 'cld-gui')).toBe(4);
    expect(trackedCount(tracked, 'other')).toBe(0);
    const unreadable = trackedProject('x', [sess('eeee5555'), line({ key: 'u', unreadable: true, parentKey: 'session:eeee5555' })]);
    expect(trackedCount([unreadable])).toBe(0);
    expect(trackedCount([])).toBe(0);
  });

  it('the project filter applies to session cards; the goal filter and the now strip leave them alone', () => {
    const items = boardItems([task({ id: 'T-1', status: 'doing', goal: 'Security' })], [], [], [
      trackedProject('cld-gui', [sess('aaaa1111', { status: 'doing' })]),
      trackedProject('other', [sess('bbbb2222', { status: 'doing' })]),
    ]);
    expect(filterItems(items, { ...NO_FILTER, project: 'other' }).map((i) => i.key)).toEqual(['session:bbbb2222']);
    expect(filterItems(items, { ...NO_FILTER, goal: 'Security' }).map((i) => i.id)).toEqual(['T-1']);
    expect(nowStrip(items).flatMap((r) => r.items.map((i) => i.id))).toEqual(['T-1']);
    expect(filterChoices(items).projects).toEqual(['cld-gui', 'other']);
  });
});

// U-48 phase 2a: a project's planning documents next to the cards.
const docCard = (path: string, o: Partial<TrackedItem> = {}) =>
  line({ key: `doc:cld-gui/${path}`, kind: 'doc', title: path, path, source: 'inferred', ...o });
const docLine = (path: string, k: string, o: Partial<TrackedItem> = {}) =>
  line({ key: `doc:cld-gui/${path}#${k}`, kind: 'doc', parentKey: `doc:cld-gui/${path}`, path, ...o });

describe('document items on the board (U-48 2a)', () => {
  it('a document is a card with its items folded under it, headings included', () => {
    const items = boardItems([], [], [], [
      trackedProject('cld-gui', [
        docCard('ROADMAP.md', { status: 'doing' }),
        docLine('ROADMAP.md', 'h:1', { title: 'Week one', status: 'unknown', source: 'unknown' }),
        docLine('ROADMAP.md', 'h:2', { title: 'write', parentKey: 'doc:cld-gui/ROADMAP.md#h:1' }),
        docLine('ROADMAP.md', 'AB-1', { taskId: 'AB-1', status: 'cancelled' }),
      ], [{ parentKey: 'doc:cld-gui/ROADMAP.md', count: 3 }]),
    ]);
    expect(items).toHaveLength(1);
    const card = items[0];
    expect([card.source, card.status, card.id, card.trackedMore]).toEqual(['tracked', 'doing', 'ROADMAP.md', 3]);
    expect(card.trackedChildren?.map((c) => c.title)).toEqual(['Week one', 'write', 'doc:cld-gui/ROADMAP.md#AB-1']);
    expect(trackedColumn('cancelled')).toBe('done');
  });

  it('an item defining a Task id of the same project is that Task card’s source line; its status stays the Task’s', () => {
    const tasks = [task({ id: 'U-48', status: 'doing' }), task({ id: 'U-49', status: 'done' }), task({ id: 'U-50', project: 'other' })];
    const items = boardItems(tasks, [], [], [
      trackedProject('cld-gui', [
        docCard('BACKLOG.md'),
        docLine('BACKLOG.md', 'U-48', { taskId: 'U-48', status: 'doing' }),
        docLine('BACKLOG.md', 'U-49', { taskId: 'U-49', status: 'todo', rawStatus: 'planned' }),
        docLine('BACKLOG.md', 'U-50', { taskId: 'U-50', status: 'todo' }), // another project's Task: stays in the document
        docLine('BACKLOG.md', 'h:9', { refs: ['U-48'], title: 'mentions it' }),
      ]),
    ]);
    const byId = (id: string) => items.find((i) => i.id === id)!;
    expect(byId('U-48').status).toBe('doing');
    expect(byId('U-48').trackedDocs?.map((d) => d.key)).toEqual(['doc:cld-gui/BACKLOG.md#U-48']);
    expect(byId('U-48').trackedDrift).toBe(false);
    expect(byId('U-49').status).toBe('done');
    expect(byId('U-49').trackedDrift).toBe(true); // the document says todo, the Task done: both shown, marked
    expect(byId('U-48').trackedMentions?.map((d) => d.title)).toEqual(['mentions it']);
    expect(byId('U-50').trackedDocs).toBeUndefined();
    const doc = items.find((i) => i.key === 'doc:cld-gui/BACKLOG.md')!;
    expect(doc.trackedChildren?.map((c) => c.key)).toEqual(['doc:cld-gui/BACKLOG.md#U-50', 'doc:cld-gui/BACKLOG.md#h:9']);
  });

  it('a mention never makes a card or a source line', () => {
    const items = boardItems([task({ id: 'U-7' })], [], [], [
      trackedProject('cld-gui', [docCard('TODO.md', { refs: ['U-7'] }), docLine('TODO.md', 'h:1', { refs: ['U-7'] })]),
    ]);
    expect(items.map((i) => i.key)).toEqual(['U-7', 'doc:cld-gui/TODO.md']);
    expect(items[0].trackedDocs).toBeUndefined();
    expect(items[0].trackedMentions).toHaveLength(2);
  });

  it('unknown and gone document statuses never mark a mismatch; document cards are not counted as lines', () => {
    const items = boardItems([task({ id: 'U-1', status: 'done' })], [], [], [
      trackedProject('cld-gui', [
        docCard('A.md'),
        docLine('A.md', 'U-1', { taskId: 'U-1', status: 'unknown' }),
        docLine('A.md', 'U-1~2', { taskId: 'U-1', status: 'todo', gone: true }),
      ]),
    ]);
    expect(items[0].trackedDrift).toBe(false);
    expect(trackedCount([trackedProject('cld-gui', [docCard('A.md'), docLine('A.md', 'x')])])).toBe(1);
  });
});
