/**
 * cld-gui job, jobs and stop (T-0019, cld/docs/design/cld-cli.md §6): the
 * user's long commands, started detached by the daemon when an orchestrator
 * asks over the local socket. The web UI only lists them, reads their logs
 * and stops them.
 *
 * A job is `bash -lc` (Linux, macOS; under `script -qfc` with -t, a pseudo
 * terminal, on Linux) or `cmd /d /s /c` (Windows), in a new session and, when
 * there is a systemd user manager, its own user scope: a session ending or the
 * service restarting never takes a job along (handoff 2-13). Records
 * and logs live in ~/.local/state/cld-gui/jobs/ (Windows: %LOCALAPPDATA%):
 * <id>.json, <id>.log, and <id>.exit, which the job's wrapper writes when its
 * command ends, so an end is known even when the daemon was down. A job that
 * vanished without it (a reboot, a kill) ends with exit null. HIF §3's fields.
 */
import type { ChildProcess, SpawnOptions } from 'child_process';
import { execFileSync, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type Coded, type Refused, refused } from '../../../../core/src/cld/serverText.js';
import type { OfficeJob } from '../../../../core/src/messages.js';
import { digestJobLog, maskJobLog } from '../jobDigest.js';
import { estimateProgress, rememberDuration } from '../jobHistory.js';
import { deriveJobName, readNameRules } from '../jobNames.js';
import { findOnPath } from '../providers/claudeProvider.js';
import { windowsCmd } from '../spawnJson.js';
import type { EngineEvents } from './events.js';
import { isoLocal } from './events.js';
import { parseTqdm, readLogTail } from './jobProgress.js';
import { writeAtomic } from './messenger.js';
import { appendMissing } from './sessionPath.js';

/** The tqdm bar (TQDM_ASCII): smooth blocks, never '#'. */
export const TQDM_ASCII = ' ▏▎▍▌▋▊▉█';
/** The job's own shell: the command in a subshell (its `exit` still gets the end
 *  line), then the end line and the exit file. */
export const JOB_WRAPPER =
  '(eval "$CLD_JOB_CMD"); r=$?; echo "[작업 종료 · exit $r · $(date "+%m-%d %H:%M")]"; printf "%s\\n" "$r" > "$CLD_JOB_EXIT"; exit $r';
/** The pseudo terminal a -t job runs in (the job panel shows about this much). */
export const JOB_PTY_COLS = 120;
export const JOB_PTY_ROWS = 40;
const DAY = 86_400_000;
const LOG_READ_MAX = 64 * 1024;
const CMD_EVENT_MAX = 300;
export const ID_RE = /^\d{4}-\d{6}-[A-Za-z0-9가-힣._-]{1,48}$/;

export const jobsDir = (
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string =>
  platform === 'win32'
    ? path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'cld-gui', 'jobs')
    : path.join(home, '.local', 'state', 'cld-gui', 'jobs');

/** Secret values in a command line become *** (handoff 2-9). */
export function maskSecrets(cmd: string): string {
  return cmd
    .replace(
      /((?:proxy-)?authorization["']?[: =]+["']?(?:(?:bearer|basic|token) +)?)[^ '"]+/gi,
      '$1***',
    )
    .replace(
      /((?:x-)?(?:api[-_]?key|access[-_]?token|auth[-_]?token|refresh[-_]?token|client[-_]?secret|secret|token|password|passwd)["']?[:=] *["']?)[^ '"&]+/gi,
      '$1***',
    )
    .replace(
      /(--(?:api[-_]?key|access[-_]?token|token|secret|password|passwd)[ =]+)[^ ]+/gi,
      '$1***',
    )
    .replace(/(:\/\/[^/:@ ]+:)[^@/ ]+@/g, '$1***@')
    .replace(
      /\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|hf_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
      '***',
    );
}

/** What runs a job: the shell (or `script`), wrapped in a systemd user scope when given. */
export function jobArgv(
  cmd: string,
  o: {
    platform: NodeJS.Platform;
    tty: boolean;
    log: string;
    systemdRun: string | null;
    bash?: string;
    script?: string;
  },
): { file: string; args: string[]; windowsVerbatimArguments?: true } {
  if (o.platform === 'win32')
    // /s: cmd keeps the command between the outer quotes as it is.
    return {
      file: windowsCmd(),
      args: ['/d', '/s', '/c', `"${cmd}"`],
      windowsVerbatimArguments: true,
    };
  const bash = o.bash ?? 'bash';
  const base =
    o.tty && o.platform === 'linux'
      ? {
          file: o.script ?? 'script',
          // script's pty starts at 0x0 without a terminal, and tqdm then draws no bar at all
          // (pofol 10-22 15:33): give it a size first.
          args: [
            '-qfc',
            `stty cols ${JOB_PTY_COLS} rows ${JOB_PTY_ROWS} 2>/dev/null; exec ${bash} -lc "$CLD_JOB_RUN"`,
            o.log,
          ],
        }
      : { file: bash, args: ['-lc', JOB_WRAPPER] };
  return o.systemdRun
    ? {
        file: o.systemdRun,
        args: ['--user', '--scope', '--collect', '--quiet', '--', base.file, ...base.args],
      }
    : base;
}

/**
 * When `pid` started, as an opaque string (a reused pid has another one); null for a zombie or no
 * such process. Linux: /proc/<pid>/stat field 22. macOS: `ps -o lstart=`. Windows: the process's
 * CreationDate from CIM, through PowerShell.
 * ponytail: on Windows a PowerShell start (about a second, synchronous); only at a job's start, its stop
 * and for jobs a restarted daemon finds still running. Native code (GetProcessTimes) if it is felt.
 */
export function procStart(pid: number, platform: NodeJS.Platform = process.platform): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'darwin')
      return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf-8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    if (platform === 'win32')
      return (
        execFileSync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CreationDate.ToFileTimeUtc()`],
          { encoding: 'utf-8', timeout: 15_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
        ).trim() || null
      );
    const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8').split(') ').pop()!.split(' ');
    return f[0] === 'Z' ? null : (f[19] ?? null);
  } catch {
    return null;
  }
}

function bootId(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'linux') {
    try {
      return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim();
    } catch {
      /* below */
    }
  }
  // Elsewhere the boot time, to the minute.
  return `t${Math.round((Date.now() - os.uptime() * 1000) / 60_000)}`;
}

/** `pid` is still the process that started at `pstart` (when recorded); `startTime` = procStart for the platform. */
function alive(
  pid: number,
  pstart: string | null,
  platform: NodeJS.Platform,
  startTime: (pid: number) => string | null = (p) => procStart(p, platform),
): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (pstart !== null) return startTime(pid) === pstart;
  if (platform === 'linux') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Direct children (pgrep -P). */
function childrenOf(pid: number): number[] {
  const out: number[] = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const f = fs.readFileSync(`/proc/${d}/stat`, 'utf-8').split(') ').pop()!.split(' ');
      if (Number(f[1]) === pid) out.push(Number(d));
    } catch {
      /* gone */
    }
  }
  return out;
}

/** Sends a signal: process.kill on Linux and macOS, taskkill /T /F of the pid on Windows. */
export type KillFn = (target: number, signal: NodeJS.Signals) => void;

const defaultKill =
  (platform: NodeJS.Platform): KillFn =>
  (target, signal) => {
    if (platform !== 'win32') return void process.kill(target, signal);
    spawnSync('taskkill', ['/pid', String(target), '/T', '/F'], { windowsHide: true });
  };

/** /proc/<pid>/stat fields after the name: [state, ppid, pgrp, session, ...]; null when unreadable. */
function statFields(pid: number | 'self'): string[] | null {
  try {
    return fs.readFileSync(`/proc/${pid}/stat`, 'utf-8').split(') ').pop()!.split(' ');
  } catch {
    return null;
  }
}

/** What stop must never signal: this daemon, its group and session, and its ancestors. */
export function protectedPids(): Set<number> {
  const out = new Set<number>([process.pid, process.ppid]);
  const self = statFields('self');
  if (self) for (const f of [self[2], self[3]]) if (Number(f) > 0) out.add(Number(f));
  for (let p = process.ppid, n = 0; p > 1 && n < 64; n++) {
    out.add(p);
    const f = statFields(p);
    p = f ? Number(f[1]) : 0;
  }
  return out;
}

/**
 * The last check before any signal, whatever the records say: a pid or a
 * group (negative) above 1, never this daemon, its group or an ancestor.
 * kill(-1) or kill(0) would reach every process of the user or our own group.
 */
export function signalSafe(target: number, own: Set<number> = protectedPids()): boolean {
  const pid = Math.abs(target);
  return Number.isInteger(target) && pid > 1 && !own.has(pid);
}

export interface JobRecord {
  id: string;
  pid: number | null;
  /** When `pid` started (procStart; null when it could not be read): a reused pid is not this job. */
  pstart: string | null;
  boot: string;
  project: string | null;
  /** Masked command line. */
  cmd: string;
  /** The user's one-line description; absent on old jobs. */
  desc?: string | null;
  dir: string;
  tab: null;
  tty: boolean;
  log: string;
  started: string;
  ended: string | null;
  exit: number | null;
  source: string;
  /** `job --gpu` (T-0021): the command runs under a GPU reservation. */
  gpu?: boolean;
  /** Set only when the user explicitly stopped this job. */
  stopped?: boolean;
  /** The Codex worker of a `cld-gui codex` task (T-0021): not listed as a job. */
  kind?: 'codex';
  /** D5: the Codex Worker whose run this is (its end is that run's, told elsewhere). */
  agent?: string;
}

/** A GPU job's reservation: done once ended, leased once the wrapper wrote `<id>.gpu`, else queued. */
export function gpuOf(
  dir: string,
  r: JobRecord,
): { gpu: 'queued' | 'leased' | 'done' | null; gpuId: string | null } {
  if (!r.gpu) return { gpu: null, gpuId: null };
  let gpuId: string | null = null;
  try {
    gpuId = fs.readFileSync(path.join(dir, `${r.id}.gpu`), 'utf-8').trim() || null;
  } catch {
    /* not leased yet */
  }
  return { gpu: r.ended ? 'done' : gpuId ? 'leased' : 'queued', gpuId };
}

/**
 * When the job really began (U-03): a job's record is written the moment it is asked for, but a
 * GPU job's command only runs once the wrapper holds the reservation (`<id>.gpu`, written then).
 * Null while it waits, or if it ended without ever leasing.
 */
export function startedOf(dir: string, r: JobRecord): string | null {
  if (!r.gpu) return r.started;
  try {
    const file = path.join(dir, `${r.id}.gpu`);
    return fs.readFileSync(file, 'utf-8').trim() ? isoLocal(fs.statSync(file).mtimeMs) : null;
  } catch {
    return null;
  }
}

/** A record as `cld-gui jobs` prints it (HIF §3, plus id and tty). */
export const jobJson = (r: JobRecord, dir = '') => ({
  id: r.id,
  pid: r.pid,
  project: r.project,
  cmd: r.cmd,
  dir: r.dir,
  tab: r.tab,
  tty: r.tty,
  log: r.log,
  started: r.started,
  ended: r.ended,
  exit: r.exit,
  gpu: gpuOf(dir, r).gpu,
  gpu_id: gpuOf(dir, r).gpuId,
});

export type JobError =
  'usage' | 'bad_folder' | 'spawn_failed' | 'no_such_job' | 'not_engine_job' | 'no_build';
type Fail = { ok: false; code: JobError; error: string } & Coded;
const fail = (code: JobError, error: string | Refused): Fail =>
  typeof error === 'string' ? { ok: false, code, error } : { ok: false, code, ...error };

export interface JobsOptions {
  home: string;
  events: EngineEvents;
  /** The clean environment every job starts from (the engine's cleanEnv). */
  env: () => NodeJS.ProcessEnv;
  /** systemd-run, or null for a plain new session. */
  systemdRun: string | null;
  /** Records or ends changed (the office republishes). */
  changed?: () => void;
  platform?: NodeJS.Platform;
  log?: (line: string) => void;
  now?: () => number;
  spawnFn?: (file: string, args: string[], o: SpawnOptions) => ChildProcess;
  /** How stop signals (tests record it); every call passes signalSafe first. */
  kill?: KillFn;
  /** dist/cld-worker.js (the GPU wrapper and the Codex worker, T-0021); null = not built. */
  worker?: string | null;
  /** The node that runs it (this daemon's). */
  node?: string;
  /** procStart for this platform (tests give a fake). */
  startTime?: (pid: number) => string | null;
}

/** What a GPU job or a Codex task runs instead: the worker, by absolute paths. */
export function workerCommand(
  platform: NodeJS.Platform,
  node: string,
  worker: string,
  args: string[],
): string {
  const q = (s: string) => (platform === 'win32' ? `"${s}"` : `'${s.replaceAll("'", "'\\''")}'`);
  return `${platform === 'win32' ? '' : 'exec '}${[node, worker, ...args].map(q).join(' ')}`;
}

export class Jobs {
  readonly dir: string;
  private readonly platform: NodeJS.Platform;
  private readonly boot: string;
  private watcher: fs.FSWatcher | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private soon: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  private readonly startTime: (pid: number) => string | null;
  /** Pids this daemon spawned whose exit it has not seen: alive without asking the OS. */
  private readonly running = new Set<number>();

  constructor(private readonly opts: JobsOptions) {
    this.platform = opts.platform ?? process.platform;
    this.dir = jobsDir(opts.home, this.platform);
    this.boot = bootId(this.platform);
    this.now = opts.now ?? Date.now;
    this.startTime = opts.startTime ?? ((pid) => procStart(pid, this.platform));
  }

  /** Settle what ended while the daemon was away; follow exit files as they appear. */
  start(): void {
    this.reconcile();
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      this.watcher = fs.watch(this.dir, (_e, name) => {
        if (name?.endsWith('.exit')) this.reconcileSoon();
      });
      this.watcher.on('error', () => undefined);
    } catch {
      /* the 30 s check alone */
    }
    // A job killed outright leaves no exit file: look while any runs.
    this.poll = setInterval(() => {
      if (this.records().some((r) => !r.ended)) this.reconcile();
    }, 30_000);
    this.poll.unref?.();
  }

  dispose(): void {
    this.watcher?.close();
    if (this.poll) clearInterval(this.poll);
    if (this.soon) clearTimeout(this.soon);
  }

  /** The clean environment jobs start from. */
  env(): NodeJS.ProcessEnv {
    return this.opts.env();
  }

  /** Start a job. Never throws. */
  run(req: {
    cmd: string;
    desc?: string | null;
    cwd: string;
    project: string | null;
    tty: boolean;
    path?: string;
    source: string;
    /** `job --gpu`: the command waits for a GPU reservation (T-0021). */
    gpu?: { vramGib: number | null; exclusive: boolean; label: string | null };
    /** A Codex task's worker: `prepare` writes the task record before it starts. */
    codex?: { bin: string; prepare: (jobId: string, log: string) => void; id?: string; agent?: string };
  }): { ok: true; id: string; pid: number; log: string } | Fail {
    const cmd = req.cmd.trim();
    if (!cmd) return fail('usage', '명령이 없습니다');
    const worker = this.opts.worker ?? null;
    if ((req.gpu || req.codex) && !worker)
      return fail('no_build', 'dist/cld-worker.js 가 없습니다(npm run build)');
    try {
      if (!path.isAbsolute(req.cwd) || !fs.statSync(req.cwd).isDirectory())
        return fail('bad_folder', `폴더가 없습니다: ${req.cwd}`);
    } catch {
      return fail('bad_folder', `폴더가 없습니다: ${req.cwd}`);
    }
    let id: string;
    try {
      id = this.reserve(req.project ?? 'job');
    } catch (err) {
      return fail('spawn_failed', `작업 기록을 만들지 못했습니다(${String(err)})`);
    }
    const log = path.join(this.dir, `${id}.log`);
    const exitFile = path.join(this.dir, `${id}.exit`);
    const node = this.opts.node ?? process.execPath;
    const workerArgs = req.gpu || req.codex ? [worker!, ...(req.codex ? ['codex', req.codex.id ?? id] : ['gpu-run'])] : null;
    const run = workerArgs ? workerCommand(this.platform, node, workerArgs[0], workerArgs.slice(1)) : cmd;
    const env: NodeJS.ProcessEnv = {
      ...this.jobEnv(req.path, run, exitFile),
      CLD_JOB_ID: id,
      ...(req.gpu && {
        CLD_GPU_CMD: cmd,
        CLD_GPU_VRAM: req.gpu.vramGib === null ? '' : String(req.gpu.vramGib),
        CLD_GPU_EXCL: req.gpu.exclusive ? '1' : '',
        CLD_GPU_LABEL: req.gpu.label ?? '',
        CLD_GPU_PROJECT: req.project ?? '',
        CLD_GPU_FILE: path.join(this.dir, `${id}.gpu`),
        CLD_JOB_LOG: log,
      }),
      ...(req.codex && { CLD_CODEX: req.codex.bin }),
    };
    try {
      req.codex?.prepare(id, log);
    } catch (err) {
      this.forget(id);
      return fail('spawn_failed', `작업 기록을 쓰지 못했습니다(${String(err)})`);
    }
    // Windows: the worker is node itself, started without cmd.exe (no line for cmd to re-parse, nothing to escape).
    const argv = workerArgs && this.platform === 'win32' ? { file: node, args: workerArgs } : jobArgv(run, {
      platform: this.platform,
      tty: req.tty,
      log,
      systemdRun: this.opts.systemdRun,
      bash: this.platform === 'win32' ? undefined : (findOnPath('bash', env.PATH) ?? undefined),
      script: req.tty ? (findOnPath('script', env.PATH) ?? undefined) : undefined,
    });
    let out: number | undefined;
    let child: ChildProcess;
    try {
      out = fs.openSync(log, 'a', 0o600);
      const tty = req.tty && this.platform === 'linux';
      child = (this.opts.spawnFn ?? spawn)(argv.file, argv.args, {
        cwd: req.cwd,
        env,
        detached: true,
        stdio: tty ? 'ignore' : ['ignore', out, out],
        windowsHide: true,
        ...(argv.windowsVerbatimArguments && { windowsVerbatimArguments: true }),
      });
    } catch (err) {
      this.forget(id);
      return fail(
        'spawn_failed',
        `작업을 띄우지 못했습니다(${err instanceof Error ? err.message : String(err)})`,
      );
    } finally {
      if (out !== undefined) fs.closeSync(out);
    }
    if (!child.pid) {
      this.forget(id);
      return fail('spawn_failed', '작업을 띄우지 못했습니다');
    }
    const pid = child.pid;
    this.running.add(pid);
    child.on('error', (err) => this.log(`job ${id}: ${err.message}`));
    child.on('exit', (code) => {
      this.running.delete(pid);
      // cmd has no wrapper: the daemon writes the end line and the exit file.
      if (this.platform === 'win32') this.finishWindows(id, log, exitFile, code);
      this.reconcileSoon();
    });
    child.unref();
    const record: JobRecord = {
      id,
      pid,
      pstart: this.startTime(pid),
      boot: this.boot,
      project: req.project,
      cmd: maskJobLog(maskSecrets(cmd.replaceAll('\n', ' '))),
      desc: req.desc ?? null,
      dir: req.cwd,
      tab: null,
      tty: req.tty,
      log,
      started: isoLocal(this.now()),
      ended: null,
      exit: null,
      source: req.source,
      ...(req.gpu && { gpu: true }),
      ...(req.codex && { kind: 'codex' as const }),
      ...(req.codex?.agent && { agent: req.codex.agent }),
    };
    this.save(record);
    this.opts.events.append('job_start', req.source, {
      id,
      pid,
      project: req.project,
      label: this.nameOf(record),
      cmd: record.cmd.slice(0, CMD_EVENT_MAX),
      tab: null,
      log,
    });
    this.log(`job ${id} started: pid ${pid}${req.project ? ` (${req.project})` : ''}`);
    this.opts.changed?.();
    return { ok: true, id, pid, log };
  }

  /** `cld-gui jobs`: running ones and those ended in the last 24 h (all with `all`).
   *  Codex workers are tasks, not jobs (`withCodex` for the Codex side). */
  list(all = false, withCodex = false): JobRecord[] {
    this.reconcile();
    const now = this.now();
    return this.records().filter(
      (r) =>
        (withCodex || r.kind !== 'codex') &&
        (all || !r.ended || now - (Date.parse(r.ended) || now) < DAY),
    );
  }

  /** `cld-gui jobs`' rows. */
  json(all = false) {
    return this.list(all).map((r) => jobJson(r, this.dir));
  }

  /** The office's job list: the same rows with a progress bar from each running log. */
  officeJobs(): OfficeJob[] {
    return this.list().map((r) => {
      const gpu = gpuOf(this.dir, r);
      return {
        id: r.id,
        pid: r.pid ?? 0,
        project: r.project,
        cmd: r.cmd,
        tab: null,
        label: this.nameOf(r),
        created: r.started,
        started: startedOf(this.dir, r),
        ended: r.ended,
        exit: r.exit,
        stopped: r.stopped === true,
        // Nothing runs while it waits for the GPU: no log, no bar (F-15).
        progress: r.ended || gpu.gpu === 'queued' ? null : this.progressOf(r),
        ...(r.gpu && gpu),
      };
    });
  }

  /** `cld-gui stop <id|pid>`, the job panel's 멈추기: the job's process groups, SIGTERM. */
  stop(target: string, source: string): { ok: true; pid: number; id: string } | Fail {
    this.reconcile();
    const r = this.records().find(
      (x) => x.id === target || (/^\d+$/.test(target) && x.pid === Number(target)),
    );
    if (!r || r.ended || r.pid === null || !alive(r.pid, r.pstart, this.platform, this.startTime)) {
      const pid = /^\d+$/.test(target) ? Number(target) : null;
      if (!r && pid !== null && alive(pid, this.startTime(pid), this.platform, this.startTime))
        return fail('not_engine_job', refused('job_not_ours', { pid }));
      return fail('no_such_job', refused('job_gone', { what: pid !== null ? `pid ${pid}` : target }));
    }
    if (!this.kill(r.pid))
      return fail('not_engine_job', refused('job_unstoppable', { pid: r.pid }));
    this.opts.events.append('stop', source, { pid: r.pid, id: r.id });
    this.save({ ...r, stopped: true });
    this.log(`job ${r.id} stopped (pid ${r.pid}, ${source})`);
    this.reconcileSoon(1_000);
    return { ok: true, pid: r.pid, id: r.id };
  }

  /** The last 64 KB of a job's log, each line as the terminal last showed it (tqdm's \r). */
  readLog(id: string): {
    text: string;
    truncated: boolean;
    digest: ReturnType<typeof digestJobLog>;
    path: string;
  } | null {
    if (!ID_RE.test(id)) return null;
    const r = this.records().find((x) => x.id === id);
    if (!r) return null;
    let size = 0;
    try {
      size = fs.statSync(r.log).size;
    } catch {
      return { text: '', truncated: false, digest: digestJobLog(r.cmd, ''), path: r.log };
    }
    const raw = readLogTail(r.log, LOG_READ_MAX);
    const text = raw
      .split('\n')
      .map((l) => l.slice(l.lastIndexOf('\r') + 1))
      .join('\n');
    return {
      text: maskJobLog(text),
      truncated: size > LOG_READ_MAX,
      digest: digestJobLog(r.cmd, raw),
      path: r.log,
    };
  }

  /** Settle ended jobs: the exit file's code, or exit null for a vanished one. */
  reconcile(): void {
    let changed = false;
    const now = this.now();
    for (const r of this.records()) {
      if (r.ended) {
        continue; // old ended records and their logs go in logPrune.ts (U-42)
      }
      const exitFile = path.join(this.dir, `${r.id}.exit`);
      let exit: number | null | undefined;
      let ended: number | undefined;
      try {
        const raw = fs.readFileSync(exitFile, 'utf-8').trim();
        exit = /^-?\d+$/.test(raw) ? Number(raw) : null;
        ended = fs.statSync(exitFile).mtimeMs;
      } catch {
        if (
          r.pid !== null &&
          r.boot === this.boot &&
          // Ours and not exited, or (after a restart) the pid still started when the record says.
          (this.running.has(r.pid) || (r.pstart !== null && alive(r.pid, r.pstart, this.platform, this.startTime)))
        )
          continue;
        exit = null;
        try {
          ended = fs.statSync(r.log).mtimeMs;
        } catch {
          ended = now;
        }
      }
      this.save({ ...r, ended: isoLocal(ended), exit });
      if (exit === 0 && r.kind !== 'codex') {
        try {
          // The run itself, not the GPU wait before it (startedOf: the lease time, else the ask).
          const ran = Date.parse(startedOf(this.dir, r) ?? r.started);
          rememberDuration(this.opts.home, this.nameOf(r), ended - ran);
        } catch (err) {
          this.log(`job history: ${String(err)}`);
        }
      }
      fs.rmSync(exitFile, { force: true });
      this.opts.events.append('job_end', 'job', {
        id: r.id,
        pid: r.pid,
        project: r.project,
        exit,
        stopped: r.stopped === true,
        label: this.nameOf(r),
        ...(r.kind && { kind: r.kind }),
        ...(r.agent && { agent: r.agent }),
      });
      this.log(`job ${r.id} ended: exit ${exit ?? '?'}`);
      changed = true;
    }
    if (changed) this.opts.changed?.();
  }

  // ── Internals ───────────────────────────────────────────────

  private progressOf(r: JobRecord): OfficeJob['progress'] {
    const raw = readLogTail(r.log);
    return (
      parseTqdm(raw) ??
      estimateProgress(
        this.opts.home,
        this.nameOf(r),
        r.cmd,
        raw,
        this.now() - Date.parse(startedOf(this.dir, r) ?? r.started),
      )
    );
  }

  /** What the job is: the user's description, else a name derived from the command. */
  private nameOf(r: JobRecord): string {
    return r.desc || deriveJobName(r.cmd, readNameRules(this.opts.home));
  }

  private reconcileSoon(ms = 200): void {
    if (this.soon) return;
    this.soon = setTimeout(() => {
      this.soon = null;
      this.reconcile();
    }, ms);
  }

  /** `MMDD-HHMMSS-<project>`, `-2`, `-3`... claimed by an exclusive create (handoff 2-14). */
  private reserve(project: string): string {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const d = new Date(this.now());
    const p = (n: number) => String(n).padStart(2, '0');
    const base = `${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${project}`;
    for (let n = 1; ; n++) {
      const id = n === 1 ? base : `${base}-${n}`;
      try {
        fs.closeSync(fs.openSync(path.join(this.dir, `${id}.json`), 'wx', 0o600));
        return id;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n > 99) throw err;
      }
    }
  }

  private jobEnv(callerPath: string | undefined, cmd: string, exitFile: string): NodeJS.ProcessEnv {
    const env = this.opts.env();
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    // The caller's PATH (what its shell would use), behind the cld-gui bin dir the clean env put first.
    if (callerPath) {
      const first = env.CLD_BIN ? path.dirname(env.CLD_BIN) : null;
      // Then what the engine's PATH has that the caller's lacks (a job from an old session still finds curl.exe).
      env[key] = appendMissing(
        first ? `${first}${path.delimiter}${callerPath}` : callerPath,
        env[key],
      );
    }
    return {
      ...env,
      TQDM_ASCII,
      CLD_JOB_CMD: cmd,
      CLD_JOB_EXIT: exitFile,
      CLD_JOB_RUN: JOB_WRAPPER,
    };
  }

  private finishWindows(id: string, log: string, exitFile: string, code: number | null): void {
    try {
      const d = new Date(this.now());
      const p = (n: number) => String(n).padStart(2, '0');
      fs.appendFileSync(
        log,
        `[작업 종료 · exit ${code ?? '?'} · ${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}]\r\n`,
      );
      fs.writeFileSync(exitFile, `${code ?? ''}\n`);
    } catch (err) {
      this.log(`job ${id}: ${String(err)}`);
    }
  }

  /** SIGTERM to the job's process groups (stop); false when the guard refuses `pid`. */
  private kill(pid: number): boolean {
    const own = protectedPids();
    if (!signalSafe(pid, own)) {
      this.log(`stop refused: pid ${pid} is not one a job may have`);
      return false;
    }
    if (this.platform === 'win32') return this.signal(pid, own) !== 'refused';
    // Every child's group first (a -t job's terminal holds its own session), then the job's.
    if (this.platform === 'linux') for (const c of childrenOf(pid)) this.signal(-c, own);
    if (this.signal(-pid, own) !== 'sent') this.signal(pid, own);
    return true;
  }

  private signal(target: number, own: Set<number>): 'sent' | 'failed' | 'refused' {
    if (!signalSafe(target, own)) {
      this.log(`stop refused: signal to ${target}`);
      return 'refused';
    }
    try {
      (this.opts.kill ?? defaultKill(this.platform))(target, 'SIGTERM');
      return 'sent';
    } catch {
      return 'failed'; // not a group leader, or gone
    }
  }

  private records(): JobRecord[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const out: JobRecord[] = [];
    for (const n of names.sort()) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf-8')) as JobRecord;
        // A pid that is not a job's (0, 1, negative: kill(-pid) would reach every process) is no record.
        const pidOk = r?.pid === null || (Number.isInteger(r?.pid) && r.pid! > 1);
        if (r && typeof r.id === 'string' && typeof r.log === 'string' && pidOk) out.push(r);
      } catch {
        /* reserved, not written yet */
      }
    }
    return out;
  }

  private save(r: JobRecord): void {
    writeAtomic(path.join(this.dir, `${r.id}.json`), `${JSON.stringify(r)}\n`);
  }

  private forget(id: string, log = true): void {
    fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
    fs.rmSync(path.join(this.dir, `${id}.exit`), { force: true });
    fs.rmSync(path.join(this.dir, `${id}.gpu`), { force: true });
    if (log) fs.rmSync(path.join(this.dir, `${id}.log`), { force: true });
  }

  private log(line: string): void {
    (this.opts.log ?? ((l: string) => console.log(`[cld engine] ${l}`)))(line);
  }
}
