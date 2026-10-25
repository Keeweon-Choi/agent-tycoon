import { describe, expect, it } from 'vitest';

import type {
  BoardTask,
  CodexTask,
  EngineProject,
  OfficeOrchestrator,
  OfficeSnapshot,
} from '../../../../core/src/messages.js';
import { t } from '../../i18n/index.js';
import type { CldSnapshot } from '../officeStore.js';
import {
  CODEX_FINISHED_SHOWN,
  codexCards,
  codexWorkerView,
  DEFAULT_TAB,
  emptyWorkerForm,
  NO_PROJECT,
  ownedNames,
  parseSaved,
  pickerEntryOf,
  pickerProjects,
  projectOfAgent,
  resolveProject,
  scopeToProject,
  scopeToUnowned,
  teamOf,
  workbenchProjects,
  workerFields,
  workerFormError,
  workerProviders,
} from './workbenchState.js';

const orch = (name: string, over: Partial<OfficeOrchestrator> = {}): OfficeOrchestrator =>
  ({
    name,
    dir: `/w/${name}`,
    tab: name,
    order: 0,
    state: 'running',
    busy: null,
    remoteControl: { on: false, url: null },
    compactions: 0,
    alive: true,
    agentId: 1,
    ...over,
  }) as OfficeOrchestrator;
const office = (...orchestrators: OfficeOrchestrator[]) =>
  ({ orchestrators }) as unknown as OfficeSnapshot;
const proj = (name: string, over: Partial<EngineProject> = {}): EngineProject => ({
  name,
  folder: `/w/${name}`,
  room: 'r',
  wantRunning: true,
  live: true,
  ...over,
});

describe('the workbench remembers per device', () => {
  it('reads what was saved and falls back on anything else', () => {
    expect(parseSaved(JSON.stringify({ project: 'alpha', tab: 'changes' }))).toEqual({
      project: 'alpha',
      tab: 'changes',
    });
    for (const raw of [null, '', 'not json', '{"project":3,"tab":"nope"}'])
      expect(parseSaved(raw)).toEqual({ project: null, tab: DEFAULT_TAB });
  });

  it('shows the wanted project while it exists, else the first one', () => {
    expect(resolveProject(['a', 'b'], 'b')).toBe('b');
    expect(resolveProject(['a', 'b'], 'gone')).toBe('a');
    expect(resolveProject(['a', 'b'], null)).toBe('a');
    expect(resolveProject([], 'a')).toBeNull();
  });
});

describe('projects and teams', () => {
  const engine = [
    proj('alpha', { model: 'opus', effort: 'high' }),
    proj('alpha-a', { role: 'worker', project: 'alpha', live: false }),
    proj('alpha-r', { role: 'reviewer', project: 'alpha' }),
    proj('beta'),
  ];
  const snapshot = office(
    orch('alpha', { agentId: 7, busy: true }),
    orch('alpha-a', { agentId: 8, state: 'off' }),
    orch('alpha-r', { agentId: 9, busy: false }),
    orch('beta', { agentId: 10 }),
  );

  it('lists projects, not their Workers', () => {
    expect(workbenchProjects(snapshot, engine)).toEqual(['alpha', 'beta']);
    expect(workbenchProjects(null, engine)).toEqual([]);
  });

  it('a team is the Lead then its own Workers, with the office state words', () => {
    expect(teamOf('alpha', snapshot, engine)).toEqual([
      { name: 'alpha', role: 'lead', state: 'working', model: 'opus', effort: 'high', agentId: 7 },
      { name: 'alpha-a', role: 'worker', state: 'off', agentId: 8 },
      { name: 'alpha-r', role: 'reviewer', state: 'resting', agentId: 9 },
    ]);
    expect(teamOf('beta', snapshot, engine).map((m) => m.name)).toEqual(['beta']);
  });

  it('a Lead the office does not list yet reads from the engine', () => {
    expect(teamOf('beta', null, engine)).toEqual([
      { name: 'beta', role: 'lead', state: 'on', agentId: null },
    ]);
  });
});

describe('a Worker card opens its own project', () => {
  const engine = [proj('alpha'), proj('beta'), proj('beta-a', { role: 'worker', project: 'beta' })];
  it('maps a Worker to its project and leaves a project alone', () => {
    expect(projectOfAgent('beta-a', engine)).toBe('beta');
    expect(projectOfAgent('alpha', engine)).toBe('alpha');
    expect(projectOfAgent('unknown', engine)).toBe('unknown');
    expect(projectOfAgent('beta-a')).toBe('beta-a');
  });
});

describe('the Task tab sees one project', () => {
  it('keeps the tasks, runs and jobs of the Lead and its Workers only', () => {
    const snap = {
      taskBoard: {
        type: 'taskBoard',
        tasks: [{ project: 'alpha' }, { project: 'beta' }, { project: 'alpha-a' }],
      },
      codexTasks: { type: 'codexTasks', tasks: [{ project: 'beta' }, { project: 'alpha' }] },
      officeJobs: { type: 'officeJobs', jobs: [{ project: null }, { project: 'alpha' }] },
      tracked: { alpha: { project: 'alpha' }, beta: { project: 'beta' } },
      officeReadOnly: true,
    } as unknown as CldSnapshot;
    const scoped = scopeToProject(['alpha', 'alpha-a'])(snap);
    expect(scoped.taskBoard?.tasks.map((x) => x.project)).toEqual(['alpha', 'alpha-a']);
    expect(scoped.codexTasks?.tasks).toHaveLength(1);
    expect(scoped.officeJobs?.jobs).toHaveLength(1);
    expect(Object.keys(scoped.tracked)).toEqual(['alpha']);
    expect(scoped.officeReadOnly).toBe(true);
    expect(scopeToProject(['x'])({ ...snap, taskBoard: null }).taskBoard).toBeNull();
  });
});

describe('D3b: the + Worker form', () => {
  const engine = [
    { name: 'alpha', folder: '/w/alpha', room: 'lab', wantRunning: true, live: true },
    { name: 'alpha-a', role: 'worker', project: 'alpha', folder: '/w/alpha', room: 'lab', wantRunning: false, live: false },
  ] as EngineProject[];
  const form = (over: Partial<ReturnType<typeof emptyWorkerForm>>) => ({ ...emptyWorkerForm('/w/alpha'), ...over });

  it('checks the name like the CLI: valid, not a project’s, not another agent’s', () => {
    expect(workerFormError(form({ name: '' }), engine)).toBe(t('engine.error.name'));
    expect(workerFormError(form({ name: '-x' }), engine)).toBe(t('engine.error.name'));
    expect(workerFormError(form({ name: 'a'.repeat(42) }), engine)).toBe(t('engine.error.name'));
    expect(workerFormError(form({ name: 'alpha' }), engine)).toBe(t('workbench.error.project'));
    expect(workerFormError(form({ name: 'alpha-a' }), engine)).toBe(t('workbench.error.taken'));
    expect(workerFormError(form({ name: ' alpha-b ' }), engine)).toBeNull();
  });

  it('sends role and project; the project folder and unset choices are left out', () => {
    expect(workerFields(form({ name: 'b' }), 'alpha', '/w/alpha')).toEqual({ role: 'worker', project: 'alpha' });
    expect(
      workerFields(form({ role: 'reviewer', folder: '/w/alpha/.worktrees/b', model: 'm', effort: 'high', permissionMode: 'plan' }), 'alpha', '/w/alpha'),
    ).toEqual({ role: 'reviewer', project: 'alpha', folder: '/w/alpha/.worktrees/b', model: 'm', effort: 'high', permissionMode: 'plan' });
  });
});

describe('UI-C1: Codex runs on the agents tab', () => {
  const run = (id: string, over: Partial<CodexTask> = {}): CodexTask => ({
    id,
    project: 'alpha',
    state: 'done',
    created: '2026-10-24T01:00:00.000Z',
    started: '2026-10-24T01:00:00.000Z',
    ...over,
  });

  it('live runs first (queued, running, limit), the newest 3 finished next, the rest behind a fold', () => {
    const tasks = [
      run('old1', { ended: '2026-10-24T02:00:00.000Z' }),
      run('new1', { ended: '2026-10-24T06:00:00.000Z', state: 'failed' }),
      run('run1', { state: 'running', started: '2026-10-24T03:00:00.000Z' }),
      run('old2', { ended: '2026-10-24T03:00:00.000Z', state: 'stopped' }),
      run('lim', { state: 'limit' }),
      run('new2', { ended: '2026-10-24T05:00:00.000Z' }),
      run('que', { state: 'running', started: null }),
      run('new3', { ended: '2026-10-24T04:00:00.000Z' }),
    ];
    const cards = codexCards(tasks);
    expect(CODEX_FINISHED_SHOWN).toBe(3);
    expect(cards.live.map((x) => x.id).sort()).toEqual(['lim', 'que', 'run1']);
    expect(cards.shown.map((x) => x.id)).toEqual(['new1', 'new2', 'new3']);
    expect(cards.more.map((x) => x.id)).toEqual(['old2', 'old1']);
    expect(codexCards([])).toEqual({ live: [], shown: [], more: [] });
  });
});

describe('D5: a Codex Worker on the agents tab and in the + Worker form', () => {
  const run = (id: string, over: Partial<CodexTask> = {}): CodexTask => ({
    id,
    project: 'alpha',
    state: 'done',
    created: '2026-10-24T01:00:00.000Z',
    started: '2026-10-24T01:00:00.000Z',
    ...over,
  });
  const engine = [
    { name: 'alpha', folder: '/w/alpha', room: 'lab', wantRunning: true, live: true },
    { name: 'alpha-c', role: 'worker', project: 'alpha', provider: 'codex', model: 'model-a', folder: '/w/alpha', room: 'lab', wantRunning: true, live: true },
  ] as EngineProject[];

  it("its runs leave the plain Codex cards; the card shows its current Task, else its last run and that run's report", () => {
    const tasks = [
      run('w-old', { agent: 'alpha-c', task: 'T-1', ended: '2026-10-24T02:00:00.000Z', exit: 0, commits: 1 }),
      run('plain', { ended: '2026-10-24T03:00:00.000Z' }),
    ];
    expect(codexCards(tasks).shown.map((x) => x.id)).toEqual(['plain']);
    const board = [
      {
        id: 'T-1',
        project: 'alpha',
        title: 'fix login',
        status: 'todo',
        executions: [{ id: 'codex:w-old', kind: 'codex', ref: 'w-old', log: '/l/w-old', summary: { value: '\nfixed it\nmore', source: 'reported', at: 'x' } }],
      },
      { id: 'T-2', project: 'alpha', title: 'add tests', status: 'todo' },
    ] as unknown as BoardTask[];
    expect(codexWorkerView('alpha-c', tasks, board)).toMatchObject({
      current: null,
      last: { id: 'w-old' },
      task: null,
      summary: 'fixed it',
      log: '/l/w-old',
    });
    const busy = [...tasks, run('w-now', { agent: 'alpha-c', task: 'T-2', state: 'running', started: '2026-10-24T04:00:00.000Z' })];
    // F6: while a run goes the card shows it as the current work only, not again as the last run.
    expect(codexWorkerView('alpha-c', busy, board)).toMatchObject({ current: { id: 'w-now' }, last: null, task: 'T-2 add tests', summary: null, log: null });
    expect(codexWorkerView('alpha-x', busy, board)).toEqual({ current: null, last: null, task: null, summary: null, log: null });
  });

  it('a team member carries its provider and its down note', () => {
    const down = [...engine.slice(0, 1), { ...engine[1], live: false, downNote: 'no codex' }];
    expect(teamOf('alpha', null, down)[1]).toMatchObject({ name: 'alpha-c', provider: 'codex', model: 'model-a', downNote: 'no codex', state: 'off' });
    expect(teamOf('alpha', null, engine)[0]).not.toHaveProperty('provider');
  });

  it('the form offers the agents installed here; a Codex Worker is sent with its provider and no permission mode', () => {
    expect(workerProviders({ claude: { models: [], efforts: [] }, codex: { models: [], efforts: [] } })).toEqual(['claude', 'codex']);
    expect(workerProviders({ claude: { models: [], efforts: [] } })).toEqual(['claude']);
    expect(workerProviders(undefined)).toEqual([]);
    const f = { ...emptyWorkerForm('/w/alpha', 'codex'), name: 'c', model: 'model-a', effort: 'high', permissionMode: 'plan' };
    expect(workerFields(f, 'alpha', '/w/alpha')).toEqual({ role: 'worker', project: 'alpha', model: 'model-a', effort: 'high', provider: 'codex' });
    expect(emptyWorkerForm('/w/alpha').provider).toBe('claude');
  });
});

describe('UI-C1: no project', () => {
  const engine = [proj('alpha'), proj('alpha-a', { role: 'worker', project: 'alpha' })];
  const snap = (jobs: Array<{ project: string | null }>, codex: Array<{ project: string }>) =>
    ({
      officeJobs: { type: 'officeJobs', jobs },
      codexTasks: { type: 'codexTasks', tasks: codex },
    }) as unknown as CldSnapshot;

  it('the entry exists only while a job or a Codex run belongs to no project', () => {
    const leads = ['alpha'];
    expect(pickerProjects(leads, snap([{ project: 'alpha' }], [{ project: 'alpha-a' }]), engine)).toEqual(['alpha']);
    expect(pickerProjects(leads, snap([{ project: null }], []), engine)).toEqual(['alpha', NO_PROJECT]);
    expect(pickerProjects(leads, snap([], [{ project: 'ghost' }]), engine)).toEqual(['alpha', NO_PROJECT]);
    expect(pickerProjects(leads, { officeJobs: null, codexTasks: null }, engine)).toEqual(['alpha']);
  });

  it('a Task (or a tracked list) under an unknown project brings the entry too, so nothing is invisible', () => {
    const board = (project: string) =>
      ({
        officeJobs: null,
        codexTasks: null,
        taskBoard: { type: 'taskBoard', tasks: [{ project }] },
        tracked: {},
      }) as unknown as CldSnapshot;
    expect(pickerProjects(['alpha'], board('alpha'), engine)).toEqual(['alpha']);
    expect(pickerProjects(['alpha'], board('alpha-a'), engine)).toEqual(['alpha']);
    expect(pickerProjects(['alpha'], board('ghost'), engine)).toEqual(['alpha', NO_PROJECT]);
    const tracked = { ...board('alpha'), tracked: { ghost: {} } } as unknown as CldSnapshot;
    expect(pickerProjects(['alpha'], tracked, engine)).toEqual(['alpha', NO_PROJECT]);
  });

  it('a remembered pick of it falls back once it is gone', () => {
    expect(resolveProject(['alpha'], NO_PROJECT)).toBe('alpha');
    expect(resolveProject(['alpha', NO_PROJECT], NO_PROJECT)).toBe(NO_PROJECT);
  });

  it('its scope keeps only what nobody owns: jobs, runs, Tasks and tracked lists', () => {
    const full = {
      taskBoard: { type: 'taskBoard', tasks: [{ project: 'alpha' }] },
      codexTasks: { type: 'codexTasks', tasks: [{ project: 'alpha-a' }, { project: 'ghost' }] },
      officeJobs: { type: 'officeJobs', jobs: [{ project: null }, { project: 'alpha' }] },
      tracked: { alpha: { project: 'alpha' }, ghost: { project: 'ghost' } },
    } as unknown as CldSnapshot;
    full.taskBoard!.tasks.push({ project: 'ghost' } as never);
    const scoped = scopeToUnowned(ownedNames(['alpha'], engine))(full);
    expect(scoped.codexTasks?.tasks.map((x) => x.project)).toEqual(['ghost']);
    expect(scoped.officeJobs?.jobs.map((x) => x.project)).toEqual([null]);
    expect(scoped.taskBoard?.tasks.map((x) => x.project)).toEqual(['ghost']);
    expect(Object.keys(scoped.tracked)).toEqual(['ghost']);
  });

  it('an item opens the entry of its Lead, else the no-project entry', () => {
    expect(pickerEntryOf('alpha-a', ['alpha'], engine)).toBe('alpha');
    expect(pickerEntryOf('alpha', ['alpha'], engine)).toBe('alpha');
    expect(pickerEntryOf('ghost', ['alpha'], engine)).toBe(NO_PROJECT);
    expect(pickerEntryOf(null, ['alpha'], engine)).toBe(NO_PROJECT);
  });
});
