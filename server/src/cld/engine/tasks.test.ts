import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TaskBoard } from '../../../../core/src/messages.js';
import { ROSTER, startEngineOffice } from '../officeTestKit.js';
import { makeEngineHome, removeTestHome, REPO_ROOT } from '../testHome.js';
import type { ControlDeps } from './control.js';
import { answerControl, controlPath, listenControl } from './control.js';
import { answerTask, tasksPath, TaskStore } from './tasks.js';

const CLI = path.join(REPO_ROOT, 'cld/bin/cld-gui');
const SEED = path.join(__dirname, '../fixtures/dev-board-seed.json');

let cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const c of cleanup.reverse()) c();
  cleanup = [];
});

function home(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-tasks-'));
  cleanup.push(() => removeTestHome(h));
  return h;
}

const NOW = Date.parse('2026-10-24T00:10:00Z');

describe('task store (DEV-BOARD)', () => {
  it('adds, updates with history, leaves no history for a no-op, writes 0600 {v:2}', () => {
    const h = home();
    const changed = vi.fn();
    const store = new TaskStore(tasksPath(h), changed);
    const add = store.add({ project: 'cld-gui', title: '보드 만들기', priority: 'P0' }, 'cli', NOW);
    expect(add).toMatchObject({
      ok: true,
      task: { id: 'T-1', status: 'todo', source: 'reported' },
    });
    expect(store.add({ project: 'cld-gui', title: '둘째' }, 'cli', NOW)).toMatchObject({
      task: { id: 'T-2' },
    });
    const up = store.update(
      'T-1',
      { status: 'doing', owner: { kind: 'worker', name: 'Ann' }, codex: 'c-1' },
      'alpha',
      NOW + 1000,
    );
    expect(up.ok).toBe(true);
    const t = store.get('T-1')!;
    expect(t).toMatchObject({
      status: 'doing',
      owner: { kind: 'worker', name: 'Ann' },
      links: [{ kind: 'codex', ref: 'c-1' }],
    });
    expect(t.history.at(-1)).toMatchObject({
      by: 'alpha',
      change: expect.stringContaining('status todo → doing'),
    });
    expect(store.update('T-1', { status: 'doing' }, 'alpha')).toMatchObject({
      ok: true,
      unchanged: true,
    });
    expect(store.get('T-1')!.history).toHaveLength(2);
    expect(changed).toHaveBeenCalledTimes(3);
    const file = tasksPath(h);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const disk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(disk.v).toBe(2);
    expect(disk.tasks.map((x: { id: string }) => x.id)).toEqual(['T-1', 'T-2']);
    // A restart reads it back.
    expect(new TaskStore(file).get('T-1')?.status).toBe('doing');
  });

  it('refuses bad fields and a duplicate id, and keeps history to 50', () => {
    const store = new TaskStore(tasksPath(home()));
    expect(store.add({ title: 'x' }, 'cli')).toMatchObject({ ok: false, code: 'no_project' });
    expect(store.add({ project: 'p', title: 'x', status: 'wip' }, 'cli')).toMatchObject({
      ok: false,
      code: 'usage',
    });
    expect(
      store.add({ project: 'p', title: 'x', owner: { kind: 'boss', name: 'a' } }, 'cli').ok,
    ).toBe(false);
    expect(store.add({ id: 'S4', project: 'p', title: 'x' }, 'cli').ok).toBe(true);
    expect(store.add({ id: 'S4', project: 'p', title: 'y' }, 'cli')).toMatchObject({
      code: 'exists',
    });
    expect(store.update('nope', { status: 'done' }, 'cli')).toMatchObject({ code: 'unknown_task' });
    for (let i = 0; i < 60; i++) store.update('S4', { note: `n${i}` }, 'cli');
    expect(store.get('S4')!.history).toHaveLength(50);
    expect(store.get('S4')!.history.at(-1)!.change).toBe('note');
  });

  it('a corrupt file is kept untouched, reported, and never written over', () => {
    const h = home();
    const file = tasksPath(h);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"v":1,"tasks":[ broken');
    const log = vi.fn();
    const store = new TaskStore(file, () => undefined, log);
    expect(store.corrupt).toMatch(/읽지 못했습니다/);
    expect(log).toHaveBeenCalled();
    expect(store.message()).toMatchObject({ tasks: [], corrupt: store.corrupt });
    expect(store.add({ project: 'p', title: 'x' }, 'cli')).toMatchObject({
      ok: false,
      code: 'store_corrupt',
    });
    expect(store.import([{ id: 'A', project: 'p', title: 'x' }], 'cli').ok).toBe(false);
    expect(fs.readFileSync(file, 'utf-8')).toBe('{"v":1,"tasks":[ broken');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['tasks.json']);
  });

  it('imports the seed list idempotently: adds, then nothing changes; an update keeps the rest', () => {
    const h = home();
    const store = new TaskStore(tasksPath(h));
    const seed = JSON.parse(fs.readFileSync(SEED, 'utf-8')).tasks;
    const first = store.import(seed, 'cli', NOW);
    expect(first).toMatchObject({ ok: true, added: seed.length, updated: 0 });
    const bytes = fs.readFileSync(tasksPath(h), 'utf-8');
    expect(store.import(seed, 'cli', NOW + 5000)).toMatchObject({
      ok: true,
      added: 0,
      updated: 0,
      unchanged: seed.length,
    });
    expect(fs.readFileSync(tasksPath(h), 'utf-8')).toBe(bytes);
    const s4 = store.get('S4')!;
    expect(s4).toMatchObject({
      status: 'doing',
      branch: 'task/s4',
      owner: { kind: 'codex' },
      updatedAt: '2026-10-23T23:45:00+09:00',
    });
    expect(store.get('U-15')!.owner).toEqual({ kind: 'unassigned', name: '' });
    // One changed entry: updated, nothing deleted, the others untouched.
    const r = store.import([{ id: 'S4', status: 'review' }], 'cli', NOW);
    expect(r).toMatchObject({ ok: true, added: 0, updated: 1 });
    expect(store.list()).toHaveLength(seed.length);
    // One bad entry refuses the whole import.
    expect(
      store.import(
        [
          { id: 'NEW1', project: 'p', title: 'x' },
          { id: 'S1', status: 'bogus' },
        ],
        'cli',
      ),
    ).toMatchObject({ ok: false });
    expect(store.get('NEW1')).toBeUndefined();
  });

  it('answerTask: the caller project is the default, list filters', () => {
    const store = new TaskStore(tasksPath(home()));
    expect(
      answerTask(store, { op: 'add', fields: { title: 'a' } }, { by: 'alpha', project: 'alpha' }),
    ).toMatchObject({ ok: true, task: { project: 'alpha' } });
    answerTask(
      store,
      { op: 'add', fields: { title: 'b', project: 'beta', status: 'doing' } },
      { by: 'cli', project: null },
    );
    expect(
      answerTask(store, { op: 'add', fields: { title: 'c' } }, { by: 'cli', project: null }),
    ).toMatchObject({ code: 'no_project' });
    expect(
      (
        answerTask(store, { op: 'list', project: 'beta' }, { by: 'cli', project: null })
          .tasks as unknown[]
      ).length,
    ).toBe(1);
    expect(
      answerTask(
        store,
        { op: 'done', id: 'T-1', fields: { note: '끝' } },
        { by: 'cli', project: null },
      ),
    ).toMatchObject({ task: { status: 'done', note: '끝' } });
  });
});

function cli(
  h: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: h,
      env: { PATH: process.env.PATH, HOME: h, ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString()));
    child.stderr.on('data', (b: Buffer) => (err += b.toString()));
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end();
  });
}

describe.runIf(process.platform !== 'win32')('cld-gui task (CLI over the control socket)', () => {
  it('add, update with --codex, done, list --json, import the seed', async () => {
    const h = home();
    const store = new TaskStore(tasksPath(h));
    const deps = {
      names: () => ['cld-gui'],
      projectAt: () => null,
      task: (a: Record<string, unknown>, who: { by: string; project: string | null }) =>
        answerTask(store, a, who),
    } as unknown as ControlDeps;
    const server = await listenControl(
      controlPath(h),
      (req) => answerControl(req, deps),
      () => undefined,
    );
    cleanup.push(() => server?.close());

    const add = await cli(h, [
      'task',
      'add',
      '보드',
      '만들기',
      '--project',
      'cld-gui',
      '--priority',
      'P0',
      '--owner',
      'worker:워커 A',
    ]);
    expect(add).toMatchObject({ code: 0, out: 'T-1 [todo] 보드 만들기\n' });
    expect(
      (
        await cli(h, [
          'task',
          'update',
          'T-1',
          '--status',
          'doing',
          '--codex',
          '1023-233618-cld-gui',
        ])
      ).code,
    ).toBe(0);
    expect((await cli(h, ['task', 'update', 'T-1', '--status', 'wip'])).code).toBe(2);
    expect((await cli(h, ['task', 'add', '무엇'])).err).toMatch(/프로젝트/);
    const imp = await cli(h, ['task', 'import', SEED]);
    expect(imp.code).toBe(0);
    expect(imp.out).toMatch(/작업 29개 추가/);
    expect((await cli(h, ['task', 'done', 'S4', '--note', '합침'])).code).toBe(0);
    const list = await cli(h, ['task', 'list', '--status', 'doing', '--json']);
    const tasks = JSON.parse(list.out).tasks as Array<{
      id: string;
      links?: unknown;
      owner?: unknown;
    }>;
    expect(tasks.map((t) => t.id)).toContain('T-1');
    expect(tasks.map((t) => t.id)).not.toContain('S4');
    expect(tasks.find((t) => t.id === 'T-1')).toMatchObject({
      owner: { kind: 'worker', name: '워커 A' },
      links: [{ kind: 'codex', ref: '1023-233618-cld-gui' }],
    });
    expect(store.get('S4')).toMatchObject({ status: 'done', note: '합침' });
    expect(store.get('S4')!.history.at(-1)!.by).toBe('cli');
  });
});

describe('the office: taskBoard to every client, taskEdit from a privileged one', () => {
  it('sends the board on ready, broadcasts a privileged edit, refuses a read-only one', async () => {
    const { office, messages, home: h } = await startEngineOffice({ projects: ROSTER });
    cleanup.push(() => removeTestHome(h));
    const sent: Array<Record<string, unknown>> = [];
    const send = (m: Record<string, unknown>) => sent.push(m);
    const board = (list: Array<Record<string, unknown>>) =>
      [...list].reverse().find((m) => m.type === 'taskBoard') as unknown as TaskBoard | undefined;
    office.onClientReady(send);
    expect(board(sent)?.tasks).toEqual([]);
    office.onClientMessage(
      { type: 'taskEdit', fields: { project: 'alpha', title: '첫 일' } },
      send,
      true,
      'Mozilla/5.0 (iPhone)',
    );
    expect(board(messages)?.tasks).toMatchObject([{ id: 'T-1', title: '첫 일', status: 'todo' }]);
    office.onClientMessage(
      { type: 'taskEdit', id: 'T-1', fields: { status: 'doing', title: '바꾸면 안 됨' } },
      send,
      true,
    );
    expect(board(messages)?.tasks[0]).toMatchObject({ status: 'doing', title: '첫 일' });
    sent.length = 0;
    office.onClientMessage(
      { type: 'taskEdit', id: 'T-1', fields: { status: 'done' } },
      send,
      false,
    );
    expect(board(sent)?.error).toMatch(/권한/);
    expect(office.tasks.get('T-1')?.status).toBe('doing');
  });
});

// ── D6: tasks.json v2 ───────────────────────────────────────────

const V1 = path.join(__dirname, '../fixtures/tasks-v1.json');
const V2 = path.join(__dirname, '../fixtures/tasks-v2-migrated.json');
const A_LEAD = 'a_leadaaaaaa';
const A_WORKER = 'a_workerbbbb';

/** A home whose tasks.json is the v1 fixture (the real board's shape, our own text). */
function v1Home(): { h: string; file: string; bytes: Buffer } {
  const h = home();
  const file = tasksPath(h);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(V1, file);
  return { h, file, bytes: fs.readFileSync(V1) };
}

/** The CLI's control socket over `store`, with a Lead `alpha` and a Worker `alpha-w`. */
async function socket(h: string, store: TaskStore, agent: string | null = null) {
  const agents = {
    assignmentOf: (n: string) => ({ alpha: A_LEAD, 'alpha-w': A_WORKER })[n] ?? null,
    names: () => ['alpha', 'alpha-w'],
  };
  const deps = {
    names: () => ['alpha', 'alpha-w'],
    projectAt: () => null,
    ...(agent && { agentOf: () => agent, projectOf: () => 'alpha' }),
    task: (
      a: Record<string, unknown>,
      who: { by: string; project: string | null; agent: string | null },
    ) => answerTask(store, a, who, agents),
  } as unknown as ControlDeps;
  const server = await listenControl(
    controlPath(h),
    (req) => answerControl(req, deps),
    () => undefined,
  );
  cleanup.push(() => server?.close());
}

/** `task list`'s text rows as the v1 CLI printed them. */
const listRows = (tasks: Array<Record<string, any>>) =>
  tasks
    .map((t) =>
      [
        t.id,
        t.status,
        t.priority ?? '-',
        t.owner ? `${t.owner.kind}${t.owner.name ? `:${t.owner.name}` : ''}` : '-',
        t.project,
        t.title,
      ].join('\t'),
    )
    .join('\n') + '\n';

describe('D6 migration: tasks.json v1 → v2', () => {
  it('P0: every v1 field kept, links become Executions, v1 kept byte for byte, a second start writes nothing', () => {
    const { h, file, bytes } = v1Home();
    const log = vi.fn();
    const store = new TaskStore(file, () => undefined, log);
    expect(store.unwritable).toBeNull();
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/migrated to v2, 7 tasks \(v1 kept as tasks.json.v1\)/),
    );
    expect(fs.readFileSync(`${file}.v1`).equals(bytes)).toBe(true);
    const disk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(disk).toEqual(JSON.parse(fs.readFileSync(V2, 'utf-8')));
    const v1 = JSON.parse(bytes.toString()).tasks as Array<Record<string, unknown>>;
    expect(disk.tasks).toHaveLength(v1.length);
    for (const [i, t] of v1.entries())
      for (const [k, v] of Object.entries(t)) expect(disk.tasks[i][k]).toEqual(v);
    expect(store.get('F-3')!.executions!.map((e) => e.id)).toEqual([
      'job:1022-130500-demo',
      'codex:1022-131000-demo',
    ]);
    // A second start: nothing rewritten, no new file.
    const before = { text: fs.readFileSync(file, 'utf-8'), mtime: fs.statSync(file).mtimeMs };
    const log2 = vi.fn();
    new TaskStore(file, () => undefined, log2);
    expect(log2).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf-8')).toBe(before.text);
    expect(fs.statSync(file).mtimeMs).toBe(before.mtime);
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(['tasks.json', 'tasks.json.v1']);
    void h;
  });

  it.runIf(process.platform !== 'win32')(
    'P0: task list (text and --json) shows the same rows after the migration',
    async () => {
      const { h, file, bytes } = v1Home();
      const v1 = JSON.parse(bytes.toString()).tasks as Array<Record<string, unknown>>;
      await socket(
        h,
        new TaskStore(
          file,
          () => undefined,
          () => undefined,
        ),
      );
      const text = await cli(h, ['task', 'list']);
      expect(text).toMatchObject({ code: 0, out: listRows(v1) });
      const json = JSON.parse((await cli(h, ['task', 'list', '--json'])).out);
      expect(json.v).toBe(1);
      expect(json.tasks.map((t: { id: string }) => t.id)).toEqual(v1.map((t) => t.id));
      for (const [i, t] of v1.entries()) expect(json.tasks[i]).toMatchObject(t);
      const done = await cli(h, ['task', 'list', '--status', 'done']);
      expect(done.out).toBe(listRows(v1.filter((t) => t.status === 'done')));
    },
  );

  it('a migration that would change a field writes nothing and refuses edits', () => {
    const h = home();
    const file = tasksPath(h);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A v1 task holding a stray `executions`: the migration would add to it.
    const odd = {
      v: 1,
      tasks: [
        {
          id: 'X',
          project: 'p',
          title: 'x',
          status: 'todo',
          source: 'reported',
          createdAt: 'a',
          updatedAt: 'a',
          history: [],
          links: [{ kind: 'job', ref: 'j' }],
          executions: [],
        },
      ],
    };
    fs.writeFileSync(file, JSON.stringify(odd));
    const store = new TaskStore(
      file,
      () => undefined,
      () => undefined,
    );
    expect(store.unwritable).toMatch(/v2 로 옮기지 않았습니다/);
    expect(store.list()).toEqual(odd.tasks);
    expect(store.update('X', { status: 'done' }, 'cli')).toMatchObject({
      ok: false,
      code: 'store_unwritable',
    });
    expect(fs.readFileSync(file, 'utf-8')).toBe(JSON.stringify(odd));
    expect(fs.readdirSync(path.dirname(file))).toEqual(['tasks.json']);
  });

  it('a read-only daemon shows the migrated view and writes nothing; a newer file is refused untouched', () => {
    const { file, bytes } = v1Home();
    const ro = new TaskStore(
      file,
      () => undefined,
      () => undefined,
      { readOnly: true },
    );
    expect(ro.unwritable).toMatch(/읽기 전용/);
    expect(ro.get('F-2')!.executions).toHaveLength(1);
    expect(ro.add({ project: 'p', title: 'x' }, 'cli')).toMatchObject({ code: 'store_unwritable' });
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['tasks.json']);
    fs.writeFileSync(file, '{"v":3,"tasks":[]}');
    const newer = new TaskStore(
      file,
      () => undefined,
      () => undefined,
    );
    expect(newer.corrupt).toMatch(/더 새 버전/);
    expect(fs.readFileSync(file, 'utf-8')).toBe('{"v":3,"tasks":[]}');
  });

  it('a crash before the rename leaves the v1 file; the next start migrates and reuses the same copy', () => {
    const { file, bytes } = v1Home();
    fs.writeFileSync(`${file}.v1`, bytes); // the copy made, then the crash
    new TaskStore(
      file,
      () => undefined,
      () => undefined,
    );
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).v).toBe(2);
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(['tasks.json', 'tasks.json.v1']);
    expect(fs.readFileSync(`${file}.v1`).equals(bytes)).toBe(true);
  });
});

describe('D6 tasks: parent, assignee, provenance, Executions', () => {
  it('provenance: every write is a report; a fact never comes in as observed', () => {
    const store = new TaskStore(tasksPath(home()));
    const add = store.add({ project: 'p', title: 'x' }, 'cli', NOW);
    expect(add.task).toMatchObject({ statusSource: 'reported', createdBy: 'cli' });
    store.update(
      'T-1',
      { status: 'done', commits: '3', testsRan: 'yes', testsPassed: 'no', filesChanged: 4 },
      'cli',
      NOW + 1000,
    );
    const t = store.get('T-1')!;
    const at = new Date(NOW + 1000).toISOString();
    expect(t).toMatchObject({
      status: 'done',
      statusSource: 'reported',
      reportedDone: { value: true, source: 'reported', at },
      commits: { value: 3, source: 'reported', at },
      filesChanged: { value: 4, source: 'reported', at },
      testsRan: { value: true, source: 'reported', at },
      testsPassed: { value: false, source: 'reported', at },
    });
    expect(t.history.at(-1)!.change).toContain('commits — → 3');
    // The same value again: no change, the first report's time stays.
    expect(store.update('T-1', { commits: 3 }, 'cli', NOW + 5000)).toMatchObject({
      unchanged: true,
    });
    // A fact handed in as an object (source and all) gives its value; it is stored as a report.
    store.update('T-1', { commits: { value: 9, source: 'observed', at } }, 'cli', NOW + 6000);
    expect(store.get('T-1')!.commits).toEqual({
      value: 9,
      source: 'reported',
      at: new Date(NOW + 6000).toISOString(),
    });
    store.update('T-1', { status: 'review' }, 'gui:iPhone');
    expect(store.get('T-1')!.reportedDone).toMatchObject({ value: false, source: 'reported' });
    store.add({ project: 'p', title: 'y' }, 'gui:iPhone');
    expect(store.get('T-2')!.createdBy).toBe('user');
    expect(JSON.stringify(store.list())).not.toContain('"observed"');
  });

  it('D5: a Codex Worker run’s last message is the Execution’s summary, reported (masked, at most 2,000)', () => {
    const store = new TaskStore(tasksPath(home()));
    store.add({ id: 'T', project: 'p', title: 't' }, 'cli', NOW);
    store.attach('T', { kind: 'codex', ref: 'c1' }, 'w1', NOW);
    store.attach('T', { kind: 'codex', ref: 'c2' }, 'cli', NOW);
    const runs: Record<string, Record<string, unknown>> = {
      c1: { state: 'done', ended: 'e', exit: 0, worktree: '/w', commits: 1, started: 's', log: '/c', summary: `고쳤어요. token=abc123secret ${'x'.repeat(3000)}` },
      c2: { state: 'done', ended: 'e', exit: 0, worktree: null, commits: null, started: 's', log: '/c' },
    };
    expect(store.observe({ codex: (id) => runs[id] as never, job: () => null }, NOW + 1)).toBe(true);
    const [w, plain] = store.get('T')!.executions!;
    expect(w.summary).toMatchObject({ source: 'reported', at: expect.any(String) });
    expect(w.summary!.value.startsWith('고쳤어요. token=***')).toBe(true);
    expect(w.summary!.value.length).toBeLessThanOrEqual(2000);
    expect(plain.summary).toBeUndefined(); // a `cld-gui codex` run has none
  });

  it('parent: must exist, never itself or a child of its own', () => {
    const store = new TaskStore(tasksPath(home()));
    store.add({ id: 'A', project: 'p', title: 'a' }, 'cli');
    expect(store.add({ id: 'B', project: 'p', title: 'b', parentId: 'A' }, 'cli').ok).toBe(true);
    store.add({ id: 'C', project: 'p', title: 'c', parentId: 'B' }, 'cli');
    expect(store.add({ project: 'p', title: 'd', parentId: 'Z' }, 'cli')).toMatchObject({
      code: 'usage',
      error: expect.stringContaining("'Z' 작업이 없습니다"),
    });
    expect(store.update('A', { parentId: 'C' }, 'cli')).toMatchObject({ code: 'usage' });
    expect(store.update('A', { parentId: 'A' }, 'cli')).toMatchObject({ code: 'usage' });
    expect(store.update('C', { parentId: '' }, 'cli').ok).toBe(true);
    expect(store.get('C')!.parentId).toBeUndefined();
  });

  it('observe: open Executions settle from their records; ended ones, status and history stay', () => {
    const store = new TaskStore(tasksPath(home()));
    store.add({ id: 'T', project: 'p', title: 't', status: 'doing' }, 'cli', NOW);
    store.attach('T', { kind: 'codex', ref: 'c1' }, 'cli', NOW);
    store.attach('T', { kind: 'job', ref: 'j1', log: '/l' }, 'cli', NOW);
    expect(store.attach('T', { kind: 'job', ref: 'j1' }, 'cli')).toMatchObject({ unchanged: true });
    const kept = { ...store.get('T')! };
    const codex = {
      state: 'limit',
      ended: null,
      exit: null,
      resetAt: '2026-10-24T05:00:00Z',
      worktree: '/w',
      commits: null,
      started: 's',
      log: '/c',
    };
    const job = { started: 's', ended: null, exit: null, log: '/l' };
    const src = { codex: () => codex as never, job: () => job as never };
    expect(store.observe(src, NOW + 1)).toBe(true);
    expect(store.get('T')!.executions![0]).toMatchObject({
      limit: { value: { resetAt: codex.resetAt }, source: 'inferred' },
      log: '/c',
    });
    Object.assign(codex, { state: 'done', ended: 'e', exit: 0, commits: 2 });
    Object.assign(job, { ended: 'e2', exit: 3 });
    store.observe(src, NOW + 2);
    const [c, j] = store.get('T')!.executions!;
    expect(c).toMatchObject({
      endedAt: { value: 'e', source: 'observed' },
      exit: { value: 0, source: 'observed' },
      commits: { value: 2, source: 'observed' },
      limit: { source: 'inferred' },
    });
    expect(j).toMatchObject({
      endedAt: { value: 'e2', source: 'observed' },
      exit: { value: 3, source: 'observed' },
    });
    Object.assign(job, { exit: 99 });
    expect(store.observe(src, NOW + 3)).toBe(false); // ended: never rewritten
    const now = store.get('T')!;
    expect(now).toMatchObject({
      status: 'doing',
      updatedAt: kept.updatedAt,
      history: kept.history,
    });
  });

  it.runIf(process.platform !== 'win32')(
    'CLI: --assignee resolves the Lead and a Worker, --parent nests, an unknown agent is refused, show prints sources',
    async () => {
      const h = home();
      const store = new TaskStore(tasksPath(h));
      await socket(h, store);
      expect(
        await cli(h, ['task', 'add', '부모', '--project', 'alpha', '--assignee', 'alpha']),
      ).toMatchObject({ code: 0, out: 'T-1 [todo] 부모\n' });
      expect(
        (
          await cli(h, [
            'task',
            'add',
            '자식',
            '--project',
            'alpha',
            '--assignee',
            'alpha-w',
            '--parent',
            'T-1',
          ])
        ).code,
      ).toBe(0);
      expect(store.get('T-1')!.assignee).toEqual({ assignmentId: A_LEAD, name: 'alpha' });
      expect(store.get('T-2')).toMatchObject({
        assignee: { assignmentId: A_WORKER, name: 'alpha-w' },
        parentId: 'T-1',
        createdBy: 'cli',
      });
      const bad = await cli(h, [
        'task',
        'add',
        '누구',
        '--project',
        'alpha',
        '--assignee',
        'ghost',
      ]);
      expect(bad.code).toBe(1);
      expect(bad.err).toMatch(/'ghost' 에이전트가 없습니다: alpha alpha-w/);
      expect(store.list()).toHaveLength(2);
      expect(
        (
          await cli(h, [
            'task',
            'update',
            'T-2',
            '--status',
            'done',
            '--commits',
            '2',
            '--tests-passed',
            'yes',
          ])
        ).code,
      ).toBe(0);
      expect(store.get('T-2')).toMatchObject({
        statusSource: 'reported',
        commits: { source: 'reported' },
      });
      store.attach('T-2', { kind: 'job', ref: '1024-000000-alpha', log: '/tmp/x.log' }, 'cli');
      const show = await cli(h, ['task', 'show', 'T-2']);
      expect(show.code).toBe(0);
      expect(show.out).toMatch(/^T-2 \[done\] 자식\n/);
      expect(show.out).toContain('  상태: done (보고)\n');
      expect(show.out).toContain(`  배정: alpha-w (${A_WORKER})\n`);
      expect(show.out).toContain('  상위 작업: T-1\n');
      expect(show.out).toMatch(/    완료 보고: 예 \(보고, .+\)\n/);
      expect(show.out).toMatch(/    커밋: 2 \(보고, .+\)\n/);
      expect(show.out).toMatch(/    시험 통과: 예 \(보고, .+\)\n/);
      expect(show.out).toContain('    job 1024-000000-alpha · 시작 ');
      expect(show.out).not.toContain('관측');
      const showJson = JSON.parse((await cli(h, ['task', 'show', 'T-2', '--json'])).out);
      expect(showJson).toMatchObject({ v: 1, ok: true, task: { id: 'T-2' } });
      expect((await cli(h, ['task', 'show', 'T-9'])).code).toBe(1);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'an agent token: createdBy agent:<name>, delegatedBy when it assigns someone else',
    async () => {
      const h = home();
      const store = new TaskStore(tasksPath(h));
      await socket(h, store, 'alpha');
      const token = { CLD_AGENT_TOKEN: 'tok' };
      expect((await cli(h, ['task', 'add', '맡김', '--assignee', 'alpha-w'], token)).code).toBe(0);
      expect((await cli(h, ['task', 'add', '내 일', '--assignee', 'alpha'], token)).code).toBe(0);
      expect(store.get('T-1')).toMatchObject({
        createdBy: 'agent:alpha',
        delegatedBy: 'alpha',
        project: 'alpha',
      });
      expect(store.get('T-2')!.delegatedBy).toBeUndefined();
    },
  );

  it('a removed agent leaves its tasks; the board lists its assignment as removed', () => {
    let live = new Set([A_LEAD, A_WORKER]);
    const store = new TaskStore(
      tasksPath(home()),
      () => undefined,
      () => undefined,
      { live: () => live },
    );
    store.add(
      { project: 'p', title: 'x', assignee: { assignmentId: A_WORKER, name: 'alpha-w' } },
      'cli',
    );
    expect(store.message().removedAssignees).toBeUndefined();
    live = new Set([A_LEAD]);
    expect(store.message()).toMatchObject({ removedAssignees: [A_WORKER] });
    expect(
      answerTask(store, { op: 'show', id: 'T-1' }, { by: 'cli', project: null }),
    ).toMatchObject({ assigneeRemoved: true, task: { assignee: { name: 'alpha-w' } } });
  });
});

// ── D6 fix round ────────────────────────────────────────────────

describe('D6: malformed files, import round trip, claimed sources', () => {
  const MALFORMED: Array<[string, unknown]> = [
    ['a null task', [null]],
    [
      'links that is a string',
      [
        {
          id: 'A',
          project: 'p',
          title: 'a',
          status: 'todo',
          source: 'reported',
          createdAt: 'x',
          updatedAt: 'x',
          history: [],
          links: 'codex:1',
        },
      ],
    ],
    [
      'links holding null',
      [
        {
          id: 'A',
          project: 'p',
          title: 'a',
          status: 'todo',
          source: 'reported',
          createdAt: 'x',
          updatedAt: 'x',
          history: [],
          links: [null],
        },
      ],
    ],
    [
      'executions that is not a list',
      [
        {
          id: 'A',
          project: 'p',
          title: 'a',
          status: 'todo',
          source: 'reported',
          createdAt: 'x',
          updatedAt: 'x',
          history: [],
          executions: 'x',
        },
      ],
    ],
  ];
  for (const [what, tasks] of MALFORMED)
    it(`a v1 file with ${what}: kept untouched, unwritable, one log line, the store still answers`, () => {
      const h = home();
      const file = tasksPath(h);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const text = JSON.stringify({ v: 1, tasks });
      fs.writeFileSync(file, text);
      const log = vi.fn();
      const store = new TaskStore(file, () => undefined, log);
      expect(store.unwritable).toMatch(/v2 로 옮기지 않았습니다/);
      expect(log).toHaveBeenCalledTimes(1);
      expect(store.message().type).toBe('taskBoard');
      expect(store.list().every((t) => t && typeof t === 'object')).toBe(true);
      expect(store.add({ project: 'p', title: 'x' }, 'cli')).toMatchObject({
        code: 'store_unwritable',
      });
      expect(store.observe({ codex: () => null, job: () => null })).toBe(false);
      expect(fs.readFileSync(file, 'utf-8')).toBe(text);
      expect(fs.readdirSync(path.dirname(file))).toEqual(['tasks.json']);
    });

  it('the office boots over a malformed v1 file: the board goes out, everything else starts', async () => {
    const { home: h } = makeEngineHome();
    cleanup.push(() => removeTestHome(h));
    const text = JSON.stringify({ v: 1, tasks: [null, { id: 'B', links: 'x' }] });
    fs.writeFileSync(tasksPath(h), text);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { office } = await startEngineOffice({ home: h, projects: ROSTER, readOnly: false });
    const sent: Array<Record<string, unknown>> = [];
    office.onClientReady((m) => sent.push(m));
    expect(sent.find((m) => m.type === 'taskBoard')).toBeTruthy();
    expect(office.engine?.names()).toContain('alpha');
    expect(office.tasks.unwritable).toBeTruthy();
    expect(fs.readFileSync(tasksPath(h), 'utf-8')).toBe(text);
  });

  it('other top-level keys survive the migration and every later write', () => {
    const h = home();
    const file = tasksPath(h);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const meta = { owner: 'me', tags: [1, 2] };
    fs.writeFileSync(file, JSON.stringify({ v: 1, tasks: [], meta }));
    const store = new TaskStore(
      file,
      () => undefined,
      () => undefined,
    );
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ v: 2, tasks: [], meta });
    store.add({ project: 'p', title: 'x' }, 'cli');
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).meta).toEqual(meta);
    new TaskStore(file).add({ project: 'p', title: 'y' }, 'cli');
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toMatchObject({ v: 2, meta });
  });

  it('attach on a task with no history (a hand-written file) adds one', () => {
    const h = home();
    const file = tasksPath(h);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        v: 2,
        tasks: [
          {
            id: 'A',
            project: 'p',
            title: 'a',
            status: 'todo',
            source: 'reported',
            createdAt: 'x',
            updatedAt: 'x',
          },
        ],
      }),
    );
    const store = new TaskStore(file);
    expect(store.attach('A', { kind: 'job', ref: 'j1' }, 'cli')).toMatchObject({ ok: true });
    expect(store.get('A')!.history).toEqual([
      expect.objectContaining({ change: 'execution job:j1' }),
    ]);
  });

  it('list --json | import round-trips with facts, an assignee, Executions: 0 added, 0 changed', () => {
    const store = new TaskStore(tasksPath(home()));
    const agents = {
      assignmentOf: (n: string) => (n === 'alpha-w' ? A_WORKER : null),
      names: () => ['alpha-w'],
    };
    const who = { by: 'cli', project: null };
    answerTask(
      store,
      {
        op: 'add',
        fields: { project: 'p', title: 'x', assignee: 'alpha-w', commits: '3', testsRan: 'yes' },
      },
      who,
      agents,
    );
    answerTask(
      store,
      { op: 'add', fields: { project: 'p', title: 'y', parentId: 'T-1', status: 'done' } },
      who,
      agents,
    );
    store.attach('T-1', { kind: 'job', ref: 'j1' }, 'cli');
    const listed = JSON.parse(JSON.stringify(answerTask(store, { op: 'list' }, who).tasks));
    const bytes = fs.readFileSync(store.file, 'utf-8');
    expect(answerTask(store, { op: 'import', tasks: listed }, who, agents)).toMatchObject({
      ok: true,
      added: 0,
      updated: 0,
    });
    expect(fs.readFileSync(store.file, 'utf-8')).toBe(bytes);
    // The assignee object of another task is resolved by its name.
    listed[1].assignee = { assignmentId: 'a_whatever22', name: 'alpha-w' };
    expect(answerTask(store, { op: 'import', tasks: [listed[1]] }, who, agents)).toMatchObject({
      ok: true,
      updated: 1,
    });
    expect(store.get('T-2')!.assignee).toEqual({ assignmentId: A_WORKER, name: 'alpha-w' });
  });

  it('a claimed source is never kept: statusSource and facts marked observed come in as reports', () => {
    const store = new TaskStore(tasksPath(home()));
    const who = { by: 'cli', project: null };
    const observed = { value: 5, source: 'observed', at: '2026-01-01T00:00:00Z' };
    const claims = {
      statusSource: 'observed',
      commits: observed,
      testsPassed: { value: true, source: 'observed', at: 'x' },
      reportedDone: { value: true, source: 'observed', at: 'x' },
      executions: [
        { id: 'job:j', kind: 'job', ref: 'j', exit: { value: 0, source: 'observed', at: 'x' } },
      ],
      createdBy: 'agent:mallory',
      delegatedBy: 'mallory',
    };
    answerTask(
      store,
      { op: 'add', fields: { project: 'p', title: 'a', status: 'doing', ...claims } },
      who,
    );
    answerTask(store, { op: 'add', fields: { project: 'p', title: 'b' } }, who);
    answerTask(store, { op: 'update', id: 'T-2', fields: { status: 'review', ...claims } }, who);
    answerTask(
      store,
      { op: 'import', tasks: [{ id: 'T-3', project: 'p', title: 'c', status: 'done', ...claims }] },
      who,
    );
    store.update('T-1', { status: 'blocked', ...claims }, 'cli');
    for (const id of ['T-1', 'T-2', 'T-3']) {
      const t = store.get(id)!;
      expect(t.statusSource).toBe('reported');
      expect(t.commits).toMatchObject({ value: 5, source: 'reported' });
      expect(t.testsPassed).toMatchObject({ value: true, source: 'reported' });
      expect(t.executions).toBeUndefined();
      expect(t.createdBy).toBe('cli');
      expect(t.delegatedBy).toBeUndefined();
      if (t.reportedDone) expect(t.reportedDone.source).toBe('reported');
    }
    expect(JSON.stringify(store.list())).not.toContain('"observed"');
  });

  it('no agents at all: the refusal says so instead of an empty list', () => {
    const store = new TaskStore(tasksPath(home()));
    const r = answerTask(
      store,
      { op: 'add', fields: { project: 'p', title: 'x', assignee: 'ghost' } },
      { by: 'cli', project: null },
      { assignmentOf: () => null, names: () => [] },
    );
    expect(r).toMatchObject({
      code: 'unknown_agent',
      error: "'ghost' 에이전트가 없습니다(등록된 에이전트가 없습니다)",
    });
  });
});
