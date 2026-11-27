import type { ChildProcess, SpawnOptions } from 'child_process';
import { spawn, spawnSync } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cmdKey, rememberDuration } from '../jobHistory.js';
import { windowsCmd } from '../spawnJson.js';
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
import { cleanEnv } from './sessionEnv.js';
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-jobs-'));
  const work = path.join(home, 'work');
  fs.mkdirSync(work);
  const events = new EngineEvents(eventsPath(home));
  const logs: string[] = [];
  const notices: Array<{ to: string; text: string }> = [];
  let changes = 0;
  const fake = fakeKill();
  const jobs = new Jobs({
    home,
    events,
    env: () => cleanEnv(process.env, home, process.platform, '/opt/agent-tycoon/bin'),
    systemdRun: null,
    changed: () => changes++,
    log: (l) => logs.push(l),
    kill: fake.kill,
    notice: (to, text) => (notices.push({ to, text }), Promise.resolve(null)),
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
    // A job started a moment ago may still be writing its exit file: a removal that finds the
    // folder refilled (ENOTEMPTY, a public CI run on 11-11) tries again.
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const evts = () =>
    fs
      .readFileSync(eventsPath(home), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { home, work, jobs, evts, logs, notices, changes: () => changes, fake };
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
        'stty cols 120 rows 40 2>/dev/null; exec /bin/bash -lc "$AGTY_JOB_RUN"',
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
    expect(jobsDir('/home/u', 'linux')).toBe('/home/u/.local/state/agent-tycoon/jobs');
    expect(jobsDir('C:\\Users\\u', 'win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' })).toBe(
      path.join('C:\\Users\\u\\AppData\\Local', 'agent-tycoon', 'jobs'),
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

describe.runIf(linux)('job --notify (T-109): the agent that started it is told once when it ends', () => {
  const start = (r: ReturnType<typeof rig>, cmd: string, o: { notify?: string } = {}) => {
    const out = r.jobs.run({ cmd, desc: '시험 돌리기', cwd: r.work, project: 'alpha', tty: false, source: 'cli', ...o });
    if (!out.ok) throw new Error(out.error);
    return out;
  };
  /** A daemon that restarted: another Jobs over the same files, reading them from scratch. */
  const restarted = (r: ReturnType<typeof rig>) => {
    const notices: Array<{ to: string; text: string }> = [];
    const again = new Jobs({
      home: r.home,
      events: new EngineEvents(eventsPath(r.home)),
      env: () => cleanEnv(process.env, r.home, process.platform, '/opt/agent-tycoon/bin'),
      systemdRun: null,
      kill: r.fake.kill,
      log: () => undefined,
      notice: (to, text) => (notices.push({ to, text }), Promise.resolve(null)),
    });
    again.start();
    cleanup.push(() => again.dispose());
    return { again, notices };
  };

  it('exit 0: one line with the description, exit, time and log; never again after a re-read or a restart', async () => {
    const r = rig();
    const j = start(r, 'true', { notify: 'alpha' });
    await vi.waitFor(() => expect(r.notices).toHaveLength(1), 10_000);
    expect(r.notices[0].to).toBe('alpha');
    expect(r.notices[0].text).toMatch(
      new RegExp(`^\\[agty job\\] 작업 ${j.id} 끝났다\\(성공\\) · exit 0: 시험 돌리기 · 걸린 시간 \\d+초 · 로그 ${j.log}$`),
    );
    expect(r.notices[0].text).not.toContain('\n');
    // A second reconcile, the listing, the 30 s poll's check and a restarted daemon: still one.
    r.jobs.reconcile();
    r.jobs.list(true);
    r.jobs.reconcile();
    const { notices } = restarted(r);
    restarted(r).again.reconcile();
    await new Promise((ok) => setTimeout(ok, 400));
    expect(r.notices).toHaveLength(1);
    expect(notices).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(r.jobs.dir, `${j.id}.json`), 'utf-8')).notify).toEqual({ to: 'alpha', sent: true });
  });

  it('a non-zero exit is told as a failure with its code', async () => {
    const r = rig();
    start(r, 'echo oops; exit 3', { notify: 'alpha' });
    await vi.waitFor(() => expect(r.notices).toHaveLength(1), 10_000);
    expect(r.notices[0].text).toContain('실패했다 · exit 3: 시험 돌리기');
  });

  it('a stopped job is told as stopped, once', async () => {
    const r = rig();
    const j = start(r, 'sleep 300', { notify: 'alpha' });
    expect(r.jobs.stop(j.id, 'cli')).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(r.notices).toHaveLength(1), 10_000);
    expect(r.notices[0].text).toContain(`작업 ${j.id} 멈췄다(stop): 시험 돌리기`);
    await new Promise((ok) => setTimeout(ok, 400));
    expect(r.notices).toHaveLength(1);
  });

  it('a job that vanished (no exit file) is told with its code unknown', async () => {
    const r = rig();
    const j = start(r, 'sleep 300', { notify: 'alpha' });
    process.kill(-j.pid, 'SIGKILL');
    await vi.waitFor(() => expect(r.notices).toHaveLength(1), 10_000);
    expect(r.notices[0].text).toContain('사라졌다(종료 코드를 모른다)');
  });

  it('without --notify nothing is told and nothing extra is recorded', async () => {
    const r = rig();
    const j = start(r, 'exit 2');
    await vi.waitFor(() => expect(r.jobs.list()[0]?.ended).toBeTruthy(), 10_000);
    r.jobs.reconcile();
    expect(r.notices).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(r.jobs.dir, `${j.id}.json`), 'utf-8'))).not.toHaveProperty('notify');
  });

  it('a job that ended while the daemon was away is told once when it comes back', async () => {
    const r = rig();
    // This daemon is "down": it settles nothing, while the job's own shell still writes its exit file.
    r.jobs.reconcile = () => undefined;
    const j = start(r, 'exit 5', { notify: 'alpha' });
    await vi.waitFor(() => expect(fs.readFileSync(path.join(r.jobs.dir, `${j.id}.exit`), 'utf-8').trim()).toBe('5'), 10_000);
    expect(r.notices).toEqual([]);
    const back = restarted(r);
    expect(back.notices).toHaveLength(1);
    expect(back.notices[0].text).toContain('실패했다 · exit 5: 시험 돌리기');
    back.again.reconcile();
    restarted(r);
    expect(back.notices).toHaveLength(1);
  });

  it('-t: told like any other', async () => {
    if (!HAS_SCRIPT) return;
    const r = rig();
    const t = r.jobs.run({ cmd: 'exit 4', cwd: r.work, project: 'alpha', tty: true, source: 'cli', notify: 'alpha' });
    expect(t.ok).toBe(true);
    await vi.waitFor(() => expect(r.notices).toHaveLength(1), 10_000);
    expect(r.notices[0].text).toContain('exit 4');
  });

  it('--gpu: the time is the run after the lease, not the wait for it; no worker, no job and no notice', () => {
    const r = rig();
    expect(r.jobs.run({ cmd: 'true', cwd: r.work, project: 'alpha', tty: false, source: 'cli', notify: 'alpha', gpu: { vramGib: 1, exclusive: false, label: null } })).toMatchObject({ ok: false, code: 'no_build' });
    // A GPU job asked 30 minutes ago, leased 2 minutes ago, whose command just wrote its exit file.
    const id = '1023-100000-alpha';
    const log = path.join(r.jobs.dir, `${id}.log`);
    const lease = path.join(r.jobs.dir, `${id}.gpu`);
    fs.writeFileSync(
      path.join(r.jobs.dir, `${id}.json`),
      JSON.stringify({ id, pid: process.pid, pstart: procStart(process.pid), boot: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim(), project: 'alpha', cmd: 'python train.py', desc: '학습', dir: r.work, tab: null, tty: false, log, started: isoLocal(Date.now() - 30 * 60_000), ended: null, exit: null, source: 'cli', gpu: true, notify: { to: 'alpha' } }),
    );
    fs.writeFileSync(lease, 'gpu0\n');
    const at = new Date(Date.now() - 120_000);
    fs.utimesSync(lease, at, at);
    fs.writeFileSync(path.join(r.jobs.dir, `${id}.exit`), '0\n');
    r.jobs.reconcile();
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0].text).toMatch(/끝났다\(성공\) · exit 0: 학습 · 걸린 시간 [12]분 \d+초/);
  });
});

/** A finished job as the daemon would find it: its record unsettled, its exit file written. */
function ended(dir: string, work: string, id: string, over: Record<string, unknown> = {}, exit: string | null = '0') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({ id, pid: null, pstart: null, boot: 'b', project: 'alpha', cmd: 'make', desc: '시험', dir: work, tab: null, tty: false, log: path.join(dir, `${id}.log`), started: isoLocal(Date.now() - 60_000), ended: null, exit: null, source: 'cli', notify: { to: 'alpha' }, ...over }),
  );
  if (exit !== null) fs.writeFileSync(path.join(dir, `${id}.exit`), `${exit}\n`);
}
const bare = (home: string, o: Partial<ConstructorParameters<typeof Jobs>[0]> = {}) => {
  const logs: string[] = [];
  const events = new EngineEvents(eventsPath(home));
  const jobs = new Jobs({ home, events, env: () => cleanEnv(process.env, home, process.platform, '/opt/agent-tycoon/bin'), systemdRun: null, log: (l) => logs.push(l), ...o });
  cleanup.push(() => jobs.dispose());
  return { jobs, events, logs };
};
const jobEnds = (home: string) =>
  fs.readFileSync(eventsPath(home), 'utf-8').split('\n').filter((l) => l.includes('"job_end"')).map((l) => JSON.parse(l) as { id: string; exit: number | null });

describe.runIf(linux)('T-109 review: notices that must not be lost, doubled or misaddressed', () => {
  const tmp = () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-jobs-'));
    cleanup.push(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    const work = path.join(home, 'work');
    fs.mkdirSync(work);
    return { home, work, dir: jobsDir(home) };
  };

  it('finding 1: a settle before start() (the events load runs one) tells nothing; start() tells the job once', async () => {
    const { home, work, dir } = tmp();
    ended(dir, work, '1111-100000-alpha');
    const told: string[] = [];
    const { jobs } = bare(home, { notice: (to, text) => (told.push(`${to}: ${text}`), Promise.resolve(null)) });
    jobs.reconcile(); // publishJobs() from the events load, before the engine knows its projects
    expect(told).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, '1111-100000-alpha.json'), 'utf-8')).notify.sent).toBeUndefined();
    jobs.start();
    await vi.waitFor(() => expect(told).toHaveLength(1));
    jobs.reconcile();
    await new Promise((ok) => setTimeout(ok, 100));
    expect(told).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(dir, '1111-100000-alpha.json'), 'utf-8')).notify.sent).toBe(true);
  });

  it('finding 2: reconcile re-entered through an events read settles each job once: one exit, one job_end, one notice', async () => {
    const { home, work, dir } = tmp();
    ended(dir, work, '1111-100000-alpha');
    ended(dir, work, '1111-100001-alpha');
    const told: string[] = [];
    const { jobs, events } = bare(home, { notice: (_to, text) => (told.push(text), Promise.resolve(null)) });
    // The office's wiring: a gpu_lease read from the file refreshes the job list, which reconciles.
    events.onRecord = (e) => {
      if (e.type === 'gpu_lease') jobs.officeJobs();
    };
    fs.mkdirSync(path.dirname(eventsPath(home)), { recursive: true });
    fs.appendFileSync(eventsPath(home), `${JSON.stringify({ ts: isoLocal(Date.now()), type: 'gpu_lease', source: 'gpu', id: 'g1' })}\n`);
    jobs.start();
    await vi.waitFor(() => expect(told).toHaveLength(2));
    await new Promise((ok) => setTimeout(ok, 300));
    expect(jobEnds(home).map((e) => [e.id, e.exit]).sort()).toEqual([['1111-100000-alpha', 0], ['1111-100001-alpha', 0]]);
    expect(told).toHaveLength(2);
    expect(told.every((t) => t.includes('끝났다(성공)'))).toBe(true);
    for (const id of ['1111-100000-alpha', '1111-100001-alpha'])
      expect(JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf-8')).exit).toBe(0);
  });

  it('finding 2 without --notify: the real exit code is never overwritten by a stale copy', async () => {
    const { home, work, dir } = tmp();
    for (const id of ['1111-100000-alpha', '1111-100001-alpha']) ended(dir, work, id, { notify: undefined }, '7');
    const { jobs, events } = bare(home);
    events.onRecord = (e) => {
      if (e.type === 'gpu_lease') jobs.officeJobs();
    };
    fs.mkdirSync(path.dirname(eventsPath(home)), { recursive: true });
    fs.appendFileSync(eventsPath(home), `${JSON.stringify({ ts: isoLocal(Date.now()), type: 'gpu_lease', source: 'gpu', id: 'g1' })}\n`);
    jobs.start();
    await new Promise((ok) => setTimeout(ok, 300));
    for (const id of ['1111-100000-alpha', '1111-100001-alpha'])
      expect(JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf-8')).exit).toBe(7);
    expect(jobEnds(home)).toHaveLength(2);
  });

  it('finding 4: a refused delivery is logged with the job id and retried (not at once), bounded, then given up with a log line', async () => {
    const { home, work, dir } = tmp();
    ended(dir, work, '1111-100000-alpha');
    let clock = Date.now();
    const calls: number[] = [];
    const { jobs, logs } = bare(home, {
      now: () => clock,
      notice: () => (calls.push(clock), Promise.resolve('unknown_project')),
    });
    jobs.start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const rec = () => JSON.parse(fs.readFileSync(path.join(dir, '1111-100000-alpha.json'), 'utf-8'));
    await vi.waitFor(() => expect(rec().notify).toMatchObject({ to: 'alpha', tries: 1 }));
    expect(rec().notify.sent).toBeUndefined();
    expect(logs.some((l) => l.includes('1111-100000-alpha') && l.includes('unknown_project'))).toBe(true);
    jobs.reconcile(); // the same moment: no hot loop
    await new Promise((ok) => setTimeout(ok, 50));
    expect(calls).toHaveLength(1);
    for (let n = 2; n <= 8; n++) {
      clock += 31_000;
      jobs.reconcile();
      await new Promise((ok) => setTimeout(ok, 50));
    }
    expect(calls).toHaveLength(5); // the maximum, then nothing more
    expect(logs.some((l) => l.includes('1111-100000-alpha') && l.includes('giving up'))).toBe(true);
    // A daemon restart does not start the tries again.
    const again = bare(home, { notice: () => (calls.push(0), Promise.resolve('unknown_project')) });
    again.jobs.start();
    await new Promise((ok) => setTimeout(ok, 100));
    expect(calls).toHaveLength(5);
  });

  it('finding 4: a failure that clears is told once, and marked sent only after it was accepted', async () => {
    const { home, work, dir } = tmp();
    ended(dir, work, '1111-100000-alpha');
    let clock = Date.now();
    let answer: string | null = 'queue_failed';
    const told: string[] = [];
    const { jobs } = bare(home, { now: () => clock, notice: (_t, text) => (told.push(text), Promise.resolve(answer)) });
    jobs.start();
    await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(path.join(dir, '1111-100000-alpha.json'), 'utf-8')).notify.tries).toBe(1));
    answer = null;
    clock += 31_000;
    jobs.reconcile();
    await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(path.join(dir, '1111-100000-alpha.json'), 'utf-8')).notify.sent).toBe(true));
    clock += 31_000;
    jobs.reconcile();
    await new Promise((ok) => setTimeout(ok, 50));
    expect(told).toHaveLength(2);
  });

  it('R2-1: a record that cannot be rewritten to mark `sent` is told once, not at every listing, and raises nothing', async () => {
    const { home, work, dir } = tmp();
    const id = '1111-100000-alpha';
    ended(dir, work, id, { ended: isoLocal(Date.now() - 1000), exit: 0 }, null);
    const told: string[] = [];
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on('unhandledRejection', onRejection);
    cleanup.push(() => process.off('unhandledRejection', onRejection));
    fs.chmodSync(dir, 0o500); // the folder takes no new file: the save fails
    cleanup.push(() => fs.chmodSync(dir, 0o700));
    const { jobs, logs } = bare(home, { notice: (_t, text) => (told.push(text), Promise.resolve(null)) });
    jobs.start();
    await vi.waitFor(() => expect(told).toHaveLength(1));
    for (let n = 0; n < 5; n++) {
      jobs.list(true);
      await new Promise((ok) => setTimeout(ok, 20));
    }
    expect(told).toHaveLength(1);
    expect(rejections).toEqual([]);
    expect(logs.some((l) => l.includes(id) && l.includes('could not be recorded'))).toBe(true);
    // The record still says nothing: a restarted daemon tells it once more (the one duplicate left), then marks it.
    fs.chmodSync(dir, 0o700);
    const again = bare(home, { notice: (_t, text) => (told.push(text), Promise.resolve(null)) });
    again.jobs.start();
    await vi.waitFor(() => expect(told).toHaveLength(2));
    await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf-8')).notify.sent).toBe(true));
    again.jobs.list(true);
    await new Promise((ok) => setTimeout(ok, 50));
    expect(told).toHaveLength(2);
  });

  it('R2-2: the 30 s between tries holds across a restart (the time of the last try is in the record)', async () => {
    const { home, work, dir } = tmp();
    ended(dir, work, '1111-100000-alpha');
    const clock = Date.now();
    const calls: number[] = [];
    const make = (at: number) => bare(home, { now: () => at, notice: () => (calls.push(at), Promise.resolve('queue_failed')) }).jobs;
    make(clock).start();
    await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(path.join(dir, '1111-100000-alpha.json'), 'utf-8')).notify.tries).toBe(1));
    make(clock + 5_000).start(); // restarted 5 s later
    await new Promise((ok) => setTimeout(ok, 100));
    expect(calls).toHaveLength(1);
    make(clock + 31_000).start();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
  });

  it('R2-4: a pass with no notice owed reads the job records once', () => {
    const { home, work, dir } = tmp();
    ended(dir, work, '1111-100000-alpha', { notify: undefined, ended: isoLocal(Date.now()), exit: 0 }, null);
    const { jobs } = bare(home, { notice: () => Promise.resolve(null) });
    jobs.start();
    const records = vi.spyOn(jobs as unknown as { records(): unknown }, 'records');
    jobs.reconcile();
    expect(records).toHaveBeenCalledTimes(1);
  });

  it('finding 7: a GPU job that ended before it got its turn says so and reports no run time', () => {
    const { home, work, dir } = tmp();
    ended(dir, work, '1111-100000-alpha', { gpu: true, started: isoLocal(Date.now() - 30 * 60_000) }, '4');
    const told: string[] = [];
    const { jobs } = bare(home, { notice: (_t, text) => (told.push(text), Promise.resolve(null)) });
    jobs.start();
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('GPU 차례를 받기 전에 끝났다');
    expect(told[0]).not.toContain('걸린 시간');
    expect(told[0]).toContain('로그 ');
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
  it('an exit file made but not yet written does not end the job (exit null): the code read after (11-04 gate)', async () => {
    const r = rig();
    const started = r.jobs.run({ cmd: 'sleep 0.8; exit 1', cwd: r.work, project: 'alpha', tty: false, source: 'cli' });
    if (!started.ok) throw new Error(started.error);
    // The wrapper's `>` has made the file and not yet written the code.
    fs.writeFileSync(path.join(jobsDir(r.home), `${started.id}.exit`), '');
    r.jobs.reconcile();
    expect(r.jobs.list()[0]?.ended).toBeNull();
    await vi.waitFor(() => expect(r.jobs.list()[0]?.ended).toBeTruthy(), 10_000);
    expect(r.jobs.list()[0]?.exit).toBe(1);
  });
  it('a failed job says where it stopped: the cause line, and its bar from the same command\'s successes', async () => {
    const r = rig();
    const cmd = 'sleep 1.2; echo "== test-server"; echo "FAIL npm run -s test:server"; echo "GATE FAIL"; echo "not deploying"; exit 1';
    // A success of the same command under another description is the basis (the deploy case).
    rememberDuration(r.home, cmdKey(cmd), 1);
    const started = r.jobs.run({ cmd, desc: '배포 #10', cwd: r.work, project: 'alpha', tty: false, source: 'cli' });
    if (!started.ok) throw new Error(started.error);
    await vi.waitFor(() => expect(r.jobs.list()[0]?.ended).toBeTruthy(), 10_000);
    const [job] = r.jobs.officeJobs();
    expect(job).toMatchObject({ exit: 1, stopLine: 'FAIL npm run -s test:server', stopPct: 95 });
    const ok = r.jobs.run({ cmd: 'echo done', cwd: r.work, project: 'alpha', tty: false, source: 'cli' });
    if (!ok.ok) throw new Error(ok.error);
    await vi.waitFor(() => expect(r.jobs.list().every((x) => x.ended)).toBe(true), 10_000);
    // A success carries neither; a failure with no basis has no bar.
    expect(r.jobs.officeJobs().find((j) => j.id === ok.id)).not.toHaveProperty('stopLine');
    const bare = r.jobs.run({ cmd: 'echo "Error: boom"; exit 2', desc: '처음 보는 일', cwd: r.work, project: 'alpha', tty: false, source: 'cli' });
    if (!bare.ok) throw new Error(bare.error);
    await vi.waitFor(() => expect(r.jobs.list().every((x) => x.ended)).toBe(true), 10_000);
    expect(r.jobs.officeJobs().find((j) => j.id === bare.id)).toMatchObject({ stopPct: null, stopLine: 'Error: boom' });
  });
  it('spawns detached in the caller folder, logs, ends with the exit code (HIF jobs shape, events)', async () => {
    const r = rig();
    const started = r.jobs.run({
      cmd: 'echo "hi from $PWD"; echo "bin=$AGTY_BIN tq=$TQDM_ASCII"; exit 3',
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
    expect(log).toContain('bin=/opt/agent-tycoon/bin/agty tq= ▏▎▍▌▋▊▉█');
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

  it('D6: a run that ended (and was observed) before its attach still gets its exit, with no further job event', async () => {
    const r = rig();
    const store = new TaskStore(tasksPath(r.home), undefined, () => undefined);
    store.add({ id: 'T-1', project: 'alpha', title: '학습', status: 'doing' }, 'cli');
    const src = {
      codex: () => null,
      job: (ref: string) => r.jobs.list(true, true).find((j) => j.id === ref) ?? null,
    };
    const observe = () => store.observe(src);
    // `start` resolves late: the job has ended, and the observation that the
    // end triggers has run, before the Execution exists to write to.
    const late = async () => {
      const started = r.jobs.run({ cmd: 'exit 4', cwd: r.work, project: 'alpha', tty: false, source: 'cli' });
      await vi.waitFor(() => expect(r.jobs.list(true)[0]?.ended).toBeTruthy(), 10_000);
      expect(observe()).toBe(false); // nothing attached yet: nothing to write
      return started;
    };
    expect(await startForTask(store, 'T-1', 'job', 'cli', late, observe)).toMatchObject({
      ok: true,
      task: 'T-1',
    });
    expect(store.get('T-1')!.executions![0]).toMatchObject({
      kind: 'job',
      exit: { value: 4, source: 'observed' },
    });
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
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-windows-jobs-'));
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
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-windows-jobs-'));
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
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-windows-jobs-'));
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

  it('B3.3: stop <pid> picks the running job over an older ended record of the same reused pid', () => {
    const pid = 4_246;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-windows-jobs-'));
    cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const spawned = new EventEmitter() as unknown as ChildProcess;
    Object.assign(spawned, { pid, unref: () => spawned });
    const sent: Array<[number, string]> = [];
    const jobs = new Jobs({
      home, events: new EngineEvents(eventsPath(home)), env: () => ({}), systemdRun: null,
      platform: 'win32', spawnFn: () => spawned, startTime: () => '133000000000000001',
      kill: (target, signal) => sent.push([target, signal]),
    });
    cleanup.push(() => jobs.dispose());
    const started = jobs.run({ cmd: 'x', cwd: home, project: null, tty: false, source: 'cli' });
    if (!started.ok) throw new Error(started.error);
    // Days ago a job had the same pid; its record stays until the log prune and sorts first.
    ended(jobs.dir, home, '0101-000000-old', { pid, pstart: '133000000000000000', ended: isoLocal(Date.now() - 86_400_000), exit: 0 });
    expect(jobs.stop(String(pid), 'cli')).toMatchObject({ ok: true, pid, id: started.id });
    expect(sent).toEqual([[pid, 'SIGTERM']]);
  });

  it('Windows (R5): a GPU job runs the worker as node itself, never through cmd.exe', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-windows-jobs-'));
    cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const calls: Array<{ file: string; args: string[]; o: SpawnOptions }> = [];
    const spawned = new EventEmitter() as unknown as ChildProcess;
    Object.assign(spawned, { pid: 4_245, unref: () => spawned });
    const jobs = new Jobs({
      home, events: new EngineEvents(eventsPath(home)), env: () => ({}), systemdRun: null,
      platform: 'win32', worker: 'C:\\A&B\\agty-worker.js', node: 'C:\\Program Files\\node.exe', startTime: () => null,
      spawnFn: (file, args, o) => { calls.push({ file, args, o }); return spawned; },
    });
    const r = jobs.run({ cmd: 'python "x&y".py', cwd: home, project: null, tty: false, source: 'cli', gpu: { vramGib: 4, exclusive: false, label: null } });
    expect(r.ok).toBe(true);
    expect(calls[0]).toMatchObject({ file: 'C:\\Program Files\\node.exe', args: ['C:\\A&B\\agty-worker.js', 'gpu-run'] });
    expect(calls[0].o.windowsVerbatimArguments).toBeUndefined();
    expect((calls[0].o.env as NodeJS.ProcessEnv).AGTY_GPU_CMD).toBe('python "x&y".py');
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
