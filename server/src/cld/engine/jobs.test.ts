import type { ChildProcess, SpawnOptions } from 'child_process';
import { spawn, spawnSync } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { rememberDuration } from '../jobHistory.js';
import { windowsCmd } from '../spawnJson.js';
import { cleanEnv } from './engine.js';
import { EngineEvents, eventsPath, isoLocal } from './events.js';
import type { KillFn } from './jobs.js';
import {
  JOB_WRAPPER,
  jobArgv,
  jobJson,
  Jobs,
  jobsDir,
  maskSecrets,
  procStart,
  protectedPids,
  signalSafe,
} from './jobs.js';
import { startForTask, tasksPath, TaskStore } from './tasks.js';

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.reverse()) c();
  cleanup = [];
});

const linux = process.platform === 'linux';
const HAS_SCRIPT = linux && spawnSync('script', ['--version']).status === 0;

/**
 * The jobs' kill for tests: records every signal and passes on only those
 * aimed at a job this test started (or its descendants, by /proc ancestry);
 * nothing else on the machine is ever signalled.
 */
function fakeKill() {
  const started = new Map<number, string | null>();
  const sent: Array<[number, string]> = [];
  const ppid = (p: number) => {
    try {
      return Number(fs.readFileSync(`/proc/${p}/stat`, 'utf-8').split(') ').pop()!.split(' ')[1]);
    } catch {
      return 0;
    }
  };
  const ours = (pid: number) => {
    for (let p = pid, n = 0; p > 1 && n < 64; n++, p = ppid(p))
      if (started.has(p) && procStart(p) === started.get(p)) return true;
    return false;
  };
  const kill: KillFn = (target, signal) => {
    sent.push([target, signal]);
    if (linux && ours(Math.abs(target))) process.kill(target, signal);
  };
  return { kill, sent, started };
}

function rig() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-jobs-'));
  const work = path.join(home, 'work');
  fs.mkdirSync(work);
  const events = new EngineEvents(eventsPath(home));
  const logs: string[] = [];
  let changes = 0;
  const fake = fakeKill();
  const jobs = new Jobs({
    home,
    events,
    env: () => cleanEnv(process.env, home, process.platform, '/opt/cld/bin'),
    systemdRun: null,
    changed: () => changes++,
    log: (l) => logs.push(l),
    kill: fake.kill,
  });
  const run = jobs.run.bind(jobs);
  jobs.run = (req) => {
    const out = run(req);
    if (out.ok) fake.started.set(out.pid, procStart(out.pid));
    return out;
  };
  jobs.start();
  cleanup.push(() => {
    jobs.dispose();
    // Only what this test started, and only while it is still that process.
    for (const [pid, pstart] of fake.started)
      if (pstart !== null && procStart(pid) === pstart) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
    fs.rmSync(home, { recursive: true, force: true });
  });
  const evts = () =>
    fs
      .readFileSync(eventsPath(home), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { home, work, jobs, evts, logs, changes: () => changes, fake };
}

describe('job pieces', () => {
  it('masks secrets in command lines (office mask.sed shapes)', () => {
    expect(maskSecrets('curl -H "Authorization: Bearer abc.def" https://x')).toBe(
      'curl -H "Authorization: Bearer ***" https://x',
    );
    expect(maskSecrets('curl -H apikey:SECRET123 http://h')).toBe('curl -H apikey:*** http://h');
    expect(maskSecrets('run --token tkn-1 --password=hunter2')).toBe(
      'run --token *** --password=***',
    );
    expect(maskSecrets('git clone https://me:pw@github.com/x')).toBe(
      'git clone https://me:***@github.com/x',
    );
    expect(
      maskSecrets('echo sk-ant-api03-abcdefghijklmnop ghp_abcdefghijklmnopqrstuvwxyz0123'),
    ).toBe('echo *** ***');
    expect(maskSecrets('python train.py --epochs 3')).toBe('python train.py --epochs 3');
  });

  it('argv: bash -lc, script for -t, a systemd user scope around either; Windows cmd /d /s /c', () => {
    const base = { platform: 'linux' as const, tty: false, log: '/j/x.log', systemdRun: null };
    expect(jobArgv('make', { ...base, bash: '/bin/bash' })).toEqual({
      file: '/bin/bash',
      args: ['-lc', JOB_WRAPPER],
    });
    expect(
      jobArgv('make', { ...base, tty: true, bash: '/bin/bash', script: '/usr/bin/script' }),
    ).toEqual({
      file: '/usr/bin/script',
      args: [
        '-qfc',
        'stty cols 120 rows 40 2>/dev/null; exec /bin/bash -lc "$CLD_JOB_RUN"',
        '/j/x.log',
      ],
    });
    expect(
      jobArgv('make', { ...base, systemdRun: '/usr/bin/systemd-run', bash: '/bin/bash' }),
    ).toEqual({
      file: '/usr/bin/systemd-run',
      args: ['--user', '--scope', '--collect', '--quiet', '--', '/bin/bash', '-lc', JOB_WRAPPER],
    });
    expect(jobArgv('python a.py "x y"', { ...base, platform: 'win32' })).toEqual({
      file: windowsCmd(), // absolute (ComSpec, else %SystemRoot%\System32): never a cmd.exe planted in the job's folder
      args: ['/d', '/s', '/c', '"python a.py "x y""'],
      windowsVerbatimArguments: true,
    });
    // -t is Linux only (util-linux script); elsewhere a plain job.
    expect(
      jobArgv('make', { ...base, platform: 'darwin', tty: true, bash: '/bin/bash' }).file,
    ).toBe('/bin/bash');
  });

  it('records live under ~/.local/state (Windows: %LOCALAPPDATA%)', () => {
    expect(jobsDir('/home/u', 'linux')).toBe('/home/u/.local/state/cld-gui/jobs');
    expect(jobsDir('C:\\Users\\u', 'win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' })).toBe(
      path.join('C:\\Users\\u\\AppData\\Local', 'cld-gui', 'jobs'),
    );
  });
});

describe.runIf(linux)('a GPU job waiting for its reservation (U-03)', () => {
  /** A live record (this test process stands in for the job) that asked for a GPU. */
  function gpuRecord(r: ReturnType<typeof rig>, createdMs: number) {
    const dir = jobsDir(r.home);
    fs.mkdirSync(dir, { recursive: true });
    const id = '1023-100000-alpha';
    fs.writeFileSync(
      path.join(dir, `${id}.json`),
      JSON.stringify({
        id,
        pid: process.pid,
        pstart: procStart(process.pid),
        boot: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim(),
        project: 'alpha',
        cmd: 'python train.py',
        dir: r.work,
        tab: null,
        tty: false,
        log: path.join(dir, `${id}.log`),
        started: isoLocal(createdMs),
        ended: null,
        exit: null,
        source: 'cli',
        gpu: true,
      }),
    );
    return { dir, id };
  }

  it('is queued: created is when it was asked for, started (the real start) is null, no progress', () => {
    const r = rig();
    const created = Date.now() - 600_000;
    const { id } = gpuRecord(r, created);
    const [job] = r.jobs.officeJobs();
    expect(job).toMatchObject({
      id,
      gpu: 'queued',
      created: isoLocal(created),
      started: null,
      progress: null,
    });
  });

  it('starts when the reservation is leased: started is the lease time', () => {
    const r = rig();
    const { dir, id } = gpuRecord(r, Date.now() - 600_000);
    const lease = path.join(dir, `${id}.gpu`);
    fs.writeFileSync(lease, 'gpu0\n');
    const at = new Date(Date.now() - 120_000);
    fs.utimesSync(lease, at, at);
    const [job] = r.jobs.officeJobs();
    expect(job).toMatchObject({ gpu: 'leased', gpuId: 'gpu0', started: isoLocal(at.getTime()) });
    expect(job.created).not.toBe(job.started);
  });

  it('a leased job is measured from its lease: the GPU wait never fills its bar', () => {
    const r = rig();
    const { dir, id } = gpuRecord(r, Date.now() - 30 * 60_000);
    const lease = path.join(dir, `${id}.gpu`);
    fs.writeFileSync(lease, 'gpu0\n');
    const at = new Date(Date.now() - 60_000);
    fs.utimesSync(lease, at, at);
    rememberDuration(r.home, r.jobs.officeJobs()[0].label!, 20 * 60_000);
    const [job] = r.jobs.officeJobs();
    // One minute of a twenty-minute run, not the thirty minutes it waited (95 %).
    expect(job.progress?.pct).toBeLessThan(10);
  });

  it('a job without a GPU starts when it is created', () => {
    const r = rig();
    const started = r.jobs.run({ cmd: 'sleep 5', cwd: r.work, project: 'alpha', tty: false, source: 'cli' });
    if (!started.ok) throw new Error(started.error);
    const [job] = r.jobs.officeJobs();
    expect(job.started).toBe(job.created);
    r.jobs.stop(started.id, 'cli');
  });
});

describe.runIf(linux)('jobs on Linux', () => {
  it('carries the CLI description as the office label and masks raw login links', async () => {
    const r = rig();
    const started = r.jobs.run({
      cmd: 'printf "http://localhost/login?code=ABCDEFGH\\n"',
      desc: '서비스 배포',
      cwd: r.work,
      project: 'alpha',
      tty: false,
      source: 'cli',
    });
    if (!started.ok) throw new Error(started.error);
    expect(r.jobs.officeJobs()[0].label).toBe('서비스 배포');
    await vi.waitFor(() => expect(r.jobs.list()[0]?.ended).toBeTruthy(), 10_000);
    expect(r.jobs.readLog(started.id)?.text).toContain('/login?code=***');
  });
  it('spawns detached in the caller folder, logs, ends with the exit code (HIF jobs shape, events)', async () => {
    const r = rig();
    const started = r.jobs.run({
      cmd: 'echo "hi from $PWD"; echo "bin=$CLD_BIN tq=$TQDM_ASCII"; exit 3',
      cwd: r.work,
      project: 'alpha',
      tty: false,
      path: '/usr/bin:/bin',
      source: 'cli',
    });
    if (!started.ok) throw new Error(started.error);
    expect(started.id).toMatch(/^\d{4}-\d{6}-alpha$/);
    await vi.waitFor(() => expect(r.jobs.list()[0]?.ended).toBeTruthy(), 10_000);
    const [rec] = r.jobs.list();
    expect(rec.exit).toBe(3);
    const log = fs.readFileSync(started.log, 'utf-8');
    expect(log).toContain(`hi from ${r.work}`);
    expect(log).toContain('bin=/opt/cld/bin/cld-gui tq= ▏▎▍▌▋▊▉█');
    expect(log).toMatch(/\[작업 종료 · exit 3 · \d\d-\d\d \d\d:\d\d\]/);
    expect(Object.keys(jobJson(rec))).toEqual([
      'id',
      'pid',
      'project',
      'cmd',
      'dir',
      'tab',
      'tty',
      'log',
      'started',
      'ended',
      'exit',
      'gpu',
      'gpu_id',
    ]);
    expect(jobJson(rec)).toMatchObject({
      project: 'alpha',
      dir: r.work,
      tab: null,
      tty: false,
      gpu: null,
    });
    const evts = r.evts();
    expect(evts.map((e) => e.type)).toEqual(['job_start', 'job_end']);
    expect(evts[0]).toMatchObject({
      source: 'cli',
      id: started.id,
      pid: started.pid,
      project: 'alpha',
      tab: null,
    });
    expect(evts[1]).toMatchObject({ source: 'job', id: started.id, exit: 3 });
    expect(fs.statSync(path.join(r.jobs.dir, `${started.id}.json`)).mode & 0o777).toBe(0o600);
  });

  it('D6: job --task attaches an Execution; its end and exit are observed, the task status untouched', async () => {
    const r = rig();
    const store = new TaskStore(tasksPath(r.home), undefined, () => undefined);
    store.add({ id: 'T-1', project: 'alpha', title: '학습', status: 'doing' }, 'cli');
    const run = () =>
      r.jobs.run({ cmd: 'exit 3', cwd: r.work, project: 'alpha', tty: false, source: 'cli' });
    expect(await startForTask(store, 'nope', 'job', 'cli', run)).toMatchObject({
      code: 'unknown_task',
    });
    expect(r.jobs.list(true)).toEqual([]); // refused before it started
    const started = await startForTask(store, 'T-1', 'job', 'cli', run);
    expect(started).toMatchObject({ ok: true, task: 'T-1' });
    const id = started.id as string;
    const src = {
      codex: () => null,
      job: (ref: string) => r.jobs.list(true, true).find((j) => j.id === ref) ?? null,
    };
    expect(store.get('T-1')!.executions![0]).toMatchObject({ log: started.log });
    await vi.waitFor(() => expect(r.jobs.list(true)[0]?.ended).toBeTruthy(), 10_000);
    expect(store.observe(src)).toBe(true);
    expect(store.get('T-1')!.executions).toEqual([
      expect.objectContaining({
        id: `job:${id}`,
        kind: 'job',
        ref: id,
        endedAt: expect.objectContaining({ source: 'observed' }),
        exit: expect.objectContaining({ value: 3, source: 'observed' }),
      }),
    ]);
    expect(store.get('T-1')).toMatchObject({ status: 'doing', statusSource: 'reported' });
  });

  it('stop: the job and its children (their groups), stop event, ended with exit null', async () => {
    const r = rig();
    const started = r.jobs.run({
      cmd: 'sleep 3071 & sleep 3072; wait',
      cwd: r.work,
      project: null,
      tty: false,
      source: 'cli',
    });
    if (!started.ok) throw new Error(started.error);
    expect(started.id).toMatch(/-job$/);
    await vi.waitFor(() =>
      expect(
        spawnSync('pgrep', ['-f', 'sleep 307[12]']).stdout.toString().trim().split('\n'),
      ).toHaveLength(2),
    );
    expect(r.jobs.stop(String(started.pid), 'gui:linux')).toEqual({
      ok: true,
      pid: started.pid,
      id: started.id,
    });
    await vi.waitFor(() => expect(r.jobs.list()[0]?.ended).toBeTruthy(), 10_000);
    expect(r.jobs.list()[0].exit).toBeNull();
    await vi.waitFor(
      () => expect(spawnSync('pgrep', ['-f', 'sleep 307[12]']).status).toBe(1),
      5_000,
    );
    expect(r.evts().map((e) => [e.type, e.source])).toEqual([
      ['job_start', 'cli'],
      ['stop', 'gui:linux'],
      ['job_end', 'job'],
    ]);
    expect(r.jobs.stop(started.id, 'cli')).toMatchObject({ ok: false, code: 'no_such_job' });
  });

  it('stop refuses what is not a running engine job', () => {
    const r = rig();
    expect(r.jobs.stop('0101-000000-x', 'cli')).toMatchObject({ ok: false, code: 'no_such_job' });
    const other = spawn('sleep', ['300'], { stdio: 'ignore' });
    cleanup.push(() => other.kill('SIGKILL'));
    expect(r.jobs.stop(String(other.pid), 'cli')).toMatchObject({
      ok: false,
      code: 'not_engine_job',
    });
    expect(procStart(other.pid!)).not.toBeNull(); // untouched
  });

  it('after a Windows restart, never signals a still-live reused pid that this daemon did not spawn', () => {
    const pid = 4_242;
    const kill = vi.spyOn(process, 'kill').mockImplementation(((target: number, signal?: number | string) => {
      if (target === pid && signal === 0) return true;
      return true;
    }) as typeof process.kill);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-windows-jobs-'));
    cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const spawned = new EventEmitter() as unknown as ChildProcess;
    Object.assign(spawned, { pid, unref: () => spawned });
    const first = new Jobs({
      home, events: new EngineEvents(eventsPath(home)), env: () => ({}), systemdRun: null,
      platform: 'win32', spawnFn: () => spawned, startTime: () => null, // never the real powershell.exe (WSL interop reaches it)
    });
    const started = first.run({ cmd: 'x', cwd: home, project: null, tty: false, source: 'cli' });
    if (!started.ok) throw new Error(started.error);
    const sent: Array<[number, string]> = [];
    const restarted = new Jobs({
      home, events: new EngineEvents(eventsPath(home)), env: () => ({}), systemdRun: null,
      platform: 'win32', startTime: () => null, kill: (target, signal) => sent.push([target, signal]),
    });
    expect(restarted.stop(started.id, 'cli')).toMatchObject({ ok: false });
    expect(sent).toEqual([]);
    first.dispose();
    restarted.dispose();
    kill.mockRestore();
  });

  it('Windows (R5): after a restart the recorded start time tells a still-running job from a reused pid; nothing is signalled for a reused pid', () => {
    const pid = 4_243;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-windows-jobs-'));
    cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const spawned = new EventEmitter() as unknown as ChildProcess;
    Object.assign(spawned, { pid, unref: () => spawned });
    const started = new Jobs({
      home, events: new EngineEvents(eventsPath(home)), env: () => ({}), systemdRun: null,
      platform: 'win32', spawnFn: () => spawned, startTime: () => '133000000000000001',
    }).run({ cmd: 'x', cwd: home, project: null, tty: false, source: 'cli' });
    if (!started.ok) throw new Error(started.error);
    const restart = (now: string) => {
      const sent: Array<[number, string]> = [];
      const jobs = new Jobs({
        home, events: new EngineEvents(eventsPath(home)), env: () => ({}), systemdRun: null,
        platform: 'win32', startTime: () => now, kill: (target, signal) => sent.push([target, signal]),
      });
      return { jobs, sent };
    };
    const reused = restart('133000000000000999');
    // The pid now names another process: the job ended (exit unknown), and nothing is signalled.
    expect(reused.jobs.list(true).find((j) => j.id === started.id)).toMatchObject({ exit: null });
    expect(reused.jobs.list(true).find((j) => j.id === started.id)?.ended).not.toBeNull();
    expect(reused.jobs.stop(started.id, 'cli')).toMatchObject({ ok: false });
    expect(reused.sent).toEqual([]);
  });

  it('Windows (R5): a job still running at its recorded start time is stopped after a restart', () => {
    const pid = 4_244;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-windows-jobs-'));
    cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const spawned = new EventEmitter() as unknown as ChildProcess;
    Object.assign(spawned, { pid, unref: () => spawned });
    const started = new Jobs({
      home, events: new EngineEvents(eventsPath(home)), env: () => ({}), systemdRun: null,
      platform: 'win32', spawnFn: () => spawned, startTime: () => '133000000000000001',
    }).run({ cmd: 'x', cwd: home, project: null, tty: false, source: 'cli' });
    if (!started.ok) throw new Error(started.error);
    const sent: Array<[number, string]> = [];
    const jobs = new Jobs({
      home, events: new EngineEvents(eventsPath(home)), env: () => ({}), systemdRun: null,
      platform: 'win32', startTime: () => '133000000000000001', kill: (target, signal) => sent.push([target, signal]),
    });
    expect(jobs.stop(started.id, 'cli')).toMatchObject({ ok: true, pid });
    expect(sent).toEqual([[pid, 'SIGTERM']]); // defaultKill on win32: taskkill /pid <pid> /T /F
  });

  it('Windows (R5): a GPU job runs the worker as node itself, never through cmd.exe', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-windows-jobs-'));
    cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const calls: Array<{ file: string; args: string[]; o: SpawnOptions }> = [];
    const spawned = new EventEmitter() as unknown as ChildProcess;
    Object.assign(spawned, { pid: 4_245, unref: () => spawned });
    const jobs = new Jobs({
      home, events: new EngineEvents(eventsPath(home)), env: () => ({}), systemdRun: null,
      platform: 'win32', worker: 'C:\\A&B\\cld-worker.js', node: 'C:\\Program Files\\node.exe', startTime: () => null,
      spawnFn: (file, args, o) => { calls.push({ file, args, o }); return spawned; },
    });
    const r = jobs.run({ cmd: 'python "x&y".py', cwd: home, project: null, tty: false, source: 'cli', gpu: { vramGib: 4, exclusive: false, label: null } });
    expect(r.ok).toBe(true);
    expect(calls[0]).toMatchObject({ file: 'C:\\Program Files\\node.exe', args: ['C:\\A&B\\cld-worker.js', 'gpu-run'] });
    expect(calls[0].o.windowsVerbatimArguments).toBeUndefined();
    expect((calls[0].o.env as NodeJS.ProcessEnv).CLD_GPU_CMD).toBe('python "x&y".py');
  });

  it('stop never signals a stale record: a reused pid (start time differs), a forged pid 0 or 1', () => {
    const r = rig();
    const other = spawn('sleep', ['300'], { stdio: 'ignore' });
    cleanup.push(() => other.kill('SIGKILL'));
    const record = (id: string, pid: number, pstart: string | null) =>
      fs.writeFileSync(
        path.join(r.jobs.dir, `${id}.json`),
        JSON.stringify({
          id,
          pid,
          pstart,
          // This boot: reconcile does not end the record before stop looks at it.
          boot: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim(),
          project: null,
          cmd: 'x',
          dir: r.work,
          tab: null,
          tty: false,
          log: path.join(r.jobs.dir, `${id}.log`),
          started: '2026-10-21T00:00:00+09:00',
          ended: null,
          exit: null,
          source: 'cli',
        }),
      );
    fs.mkdirSync(r.jobs.dir, { recursive: true });
    record('1021-000001-reused', other.pid!, '1'); // the job's pid, now another process
    expect(r.jobs.stop('1021-000001-reused', 'cli')).toMatchObject({
      ok: false,
      code: 'no_such_job',
    });
    expect(r.jobs.stop(String(other.pid), 'cli')).toMatchObject({ ok: false });
    record('1021-000002-init', 1, procStart(1));
    record('1021-000003-zero', 0, procStart(process.pid));
    expect(r.jobs.stop('1021-000002-init', 'cli')).toMatchObject({ ok: false });
    expect(r.jobs.stop('1021-000003-zero', 'cli')).toMatchObject({ ok: false });
    expect(r.fake.sent).toEqual([]);
    expect(procStart(other.pid!)).not.toBeNull();
  });

  it('the last guard at the signal: never 0, 1, -1, this process, its group or its parent, records aside', () => {
    const r = rig();
    // Straight to the call site, past every record check.
    const kill = (pid: number) => (r.jobs as unknown as { kill(pid: number): boolean }).kill(pid);
    const own = protectedPids();
    for (const pid of [0, 1, -1, -0, 1.5, process.pid, -process.pid, process.ppid])
      expect(kill(pid), String(pid)).toBe(false);
    expect(r.fake.sent).toEqual([]);
    for (const t of [0, -0, 1, -1, 2.5, NaN, process.pid, -process.pid, process.ppid])
      expect(signalSafe(t, own), String(t)).toBe(false);
    expect(own.has(process.pid) && own.has(process.ppid)).toBe(true);
  });

  it('refuses an empty command and a missing folder; ids in one second get -2', () => {
    const r = rig();
    expect(
      r.jobs.run({ cmd: '  ', cwd: r.work, project: null, tty: false, source: 'cli' }),
    ).toMatchObject({
      ok: false,
      code: 'usage',
    });
    expect(
      r.jobs.run({ cmd: 'true', cwd: '/no/such/dir', project: null, tty: false, source: 'cli' }),
    ).toMatchObject({
      ok: false,
      code: 'bad_folder',
    });
    const at = Date.parse('2026-10-21T23:15:02');
    const fixed = new Jobs({
      home: r.home,
      events: new EngineEvents(eventsPath(r.home)),
      env: () => ({ ...process.env }),
      systemdRun: null,
      now: () => at,
      log: () => undefined,
      kill: r.fake.kill,
    });
    const a = fixed.run({ cmd: 'true', cwd: r.work, project: 'p', tty: false, source: 'cli' });
    const b = fixed.run({ cmd: 'true', cwd: r.work, project: 'p', tty: false, source: 'cli' });
    expect([a.ok && a.id, b.ok && b.id]).toEqual(['1021-231502-p', '1021-231502-p-2']);
  });

  it('a job that vanished without its exit file (reboot, kill -9) ends with exit null', () => {
    const r = rig();
    const started = r.jobs.run({
      cmd: 'sleep 300',
      cwd: r.work,
      project: null,
      tty: false,
      source: 'cli',
    });
    if (!started.ok) throw new Error(started.error);
    process.kill(-started.pid, 'SIGKILL');
    return vi.waitFor(() => {
      const [rec] = r.jobs.list();
      expect(rec.ended).toBeTruthy();
      expect(rec.exit).toBeNull();
    }, 10_000);
  });

  it('reads a log as the terminal last showed each line (tqdm \\r)', async () => {
    const r = rig();
    const started = r.jobs.run({
      cmd: "printf 'epoch 1\\n 10%%\\r 50%%\\r100%%\\ndone\\n'",
      cwd: r.work,
      project: null,
      tty: false,
      source: 'cli',
    });
    if (!started.ok) throw new Error(started.error);
    await vi.waitFor(() => expect(r.jobs.list()[0]?.ended).toBeTruthy(), 10_000);
    const log = r.jobs.readLog(started.id)!;
    expect(log.text.split('\n').slice(0, 3)).toEqual(['epoch 1', '100%', 'done']);
    expect(log.truncated).toBe(false);
    expect(r.jobs.readLog('../../etc/passwd')).toBeNull();
  });

  it.runIf(HAS_SCRIPT)('-t runs under a pseudo terminal (the program sees a tty)', async () => {
    const r = rig();
    const started = r.jobs.run({
      cmd: 'if [ -t 1 ]; then echo TTY; else echo PIPE; fi',
      cwd: r.work,
      project: null,
      tty: true,
      source: 'cli',
    });
    if (!started.ok) throw new Error(started.error);
    await vi.waitFor(() => expect(r.jobs.list()[0]?.ended).toBeTruthy(), 10_000);
    expect(r.jobs.list()[0].exit).toBe(0);
    expect(fs.readFileSync(started.log, 'utf-8')).toContain('TTY');
  });
});
