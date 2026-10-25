/**
 * cld-gui codex (T-0021, cld/docs/design/cld-cli.md §12): a task for the
 * Codex CLI, run by the engine itself. The daemon makes the record
 * (and, with --worktree, an E3 task worktree) and starts the worker as an
 * engine job, so it outlives sessions and daemon restarts; the worker
 * (`cld-worker.js codex <id>`, runCodex below) runs `codex exec`, waits out a
 * usage limit and resumes the same session, then tells the project's
 * orchestrator in one line through `cld-gui send` and records codex_* events.
 *
 * Records: ~/.local/state/cld-gui/codex/<id>.json (the worker updates its
 * state), <id>.jsonl (Codex's JSON output). The engine adds no rules to a
 * `cld-gui codex` spec and keeps no table of model names (ADR-0014); only a
 * Codex Worker's run (below) begins with the shipped rules.
 *
 * D5: the same records and worker also run a Codex Worker's messages (one run
 * per message, agents/codex/codex.ts): such a record names its `agent` and
 * `assignmentId`, its prompt is <id>.prompt.md, a follow-up resumes the
 * Worker's thread (`resume`), Codex's last message goes to <id>.last.md (its
 * `summary`), and the daemon, not the worker, tells the Lead. C7b: a Worker's
 * <id>.prompt.md of a NEW thread begins with the composition a Claude Worker gets (agentRules.ts), then
 * `---`; it only ever lives in the engine's own folder, never in the repository.
 * `cld-gui codex` runs (no `agent`) are exactly as before.
 */
import type { ChildProcess } from 'child_process';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { CodexTask } from '../../../../core/src/messages.js';
import { CLI_NAME } from '../cliName.js';
import { codexShownTitle, codexTitle } from '../jobNames.js';
import { findOnPath } from '../providers/claudeProvider.js';
import { commandArgv } from '../spawnJson.js';
import { composeWithPlaybook } from './agentRules.js';
import type { Reply } from './control.js';
import { refuse } from './control.js';
import { appendEvent, eventsPath, isoLocal, shortStamp } from './events.js';
import { NO_FETCH_ENV } from './git/gitRun.js';
import type { Jobs } from './jobs.js';
import { jobsDir } from './jobs.js';
import { writeAtomic } from './messenger.js';
import type { WorkerRole } from './registry.js';

const DAY = 86_400_000;
/** D5: runs in the order they were asked for. File names do not sort so: two in one second are
 *  `<base>` then `<base>-2` ('-' sorts before '.json'), and MMDD wraps at a new year. */
const byStart = (a: CodexRecord, b: CodexRecord): number =>
  (a.started ?? '').localeCompare(b.started ?? '') || a.id.length - b.id.length || a.id.localeCompare(b.id);

/** D5: the Worker-run index is read again on a watch event of the folder; without one only
 *  after this long (a missed event, or no watch at all). Never a timer: only when it is asked. */
const INDEX_STALE_MS = 60_000;
export const ID_RE = /^\d{4}-\d{6}-[A-Za-z0-9가-힣._-]{1,48}$/;
export const LIMIT_RE = /usage_limit_exceeded|hit your usage limit/i;

/** A usage limit ended this run: one of Codex's own error events (or a plain stderr line) says so.
 *  Text inside other events never counts: a grep that printed this file read as a limit and
 *  set a finished task to resume every 5 minutes (10-22 18:46). */
export function hitLimit(out: string): boolean {
  return out.split('\n').some((line) => {
    if (!LIMIT_RE.test(line)) return false;
    let e: { type?: string; message?: string; error?: { message?: string } };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      return true; // stderr
    }
    const msg = e.type === 'error' ? e.message : e.type === 'turn.failed' ? e.error?.message : null;
    return !!msg && LIMIT_RE.test(msg);
  });
}
export const RESUME_TEXT =
  'You were stopped by a usage limit or a restart and are now resumed in the same session. Check the state of your work (git status, git log) and continue the task from where you left off.';
export const CODEX_TIMING = {
  /** Unknown reset time: the first try again after this (the spec's 5 minutes)... */
  pollMs: 5 * 60_000,
  /** ...then twice as long each blind lap, up to this (TOKEN-GUARD: no 300 laps at 5 minutes). */
  pollMaxMs: 60 * 60_000,
  /** After the reported reset, this much more (60 s). */
  marginMs: 60_000,
  /** How often the worker looks for the session id while Codex runs. */
  sidMs: 1_000,
};

/** D5: a Codex Worker's runs, `cld-gui codex`'s sandbox (open question 2), also on a resume. */
export const WORKER_SANDBOX = 'workspace-write';
/** D5: how much of a Worker run's last message the record keeps as its summary. */
export const SUMMARY_MAX = 2_000;

/** Codex's reasoning efforts; the engine only checks the word, it sets no default (ADR-0014). */
export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
export type CodexEffort = (typeof CODEX_EFFORTS)[number];
export const isCodexEffort = (x: unknown): x is CodexEffort =>
  CODEX_EFFORTS.includes(x as CodexEffort);

export type CodexState = 'running' | 'limit' | 'done' | 'failed' | 'stopped';

export interface CodexRecord {
  id: string;
  project: string | null;
  model: string | null;
  /** `-c model_reasoning_effort=…`; null or absent (older records) = Codex's own config. */
  effort?: CodexEffort | null;
  state: CodexState;
  /** Where Codex works: the worktree, or the folder `cld-gui codex` was called in. */
  dir: string;
  worktree: string | null;
  branch: string | null;
  /** The commit the task started from (commits = base..HEAD). */
  base: string | null;
  spec: string;
  title?: string;
  /** When the task was asked for (the record is written before any worker runs). */
  started: string;
  /** When the worker first came up; absent before then and on older records (U-03). */
  ran?: string;
  ended: string | null;
  exit: number | null;
  resetAt: string | null;
  /** Codex's session (thread) id, for resume. */
  sid: string | null;
  commits: number | null;
  /** The engine job running the worker (its log is the task's log). */
  jobId: string;
  log: string;
  pid: number | null;
  source: string;
  /** D5: a Codex Worker's run: its name (as when it ran) and assignment. */
  agent?: string;
  assignmentId?: string;
  /** D5: the Task this run is an Execution of. */
  task?: string;
  /** D5: the Worker's thread its first run resumes (a follow-up message), else a new one. */
  resume?: string;
  /** D5: the message this run carries (one message is one run: never started twice). */
  messageId?: string;
  /** D5: a room post's run: its room and post (the daemon posts the summary there). */
  room?: { id: string; messageId?: string };
  /** D5: Codex's last message (`-o`), the Worker's report, at most SUMMARY_MAX characters. */
  summary?: string;
  /** TOKEN-GUARD: the limit wait the orchestrator was last told of (`limit:<resetAt>`): the same
   *  wait is never told twice, also by a worker started again after a daemon restart. */
  told?: string;
}

export const codexDir = (home = os.homedir(), platform = process.platform, env = process.env) =>
  path.join(path.dirname(jobsDir(home, platform, env)), 'codex');

export function readCodex(dir: string, id: string): CodexRecord | null {
  if (!ID_RE.test(id)) return null;
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf-8')) as CodexRecord;
    return r && r.id === id && typeof r.dir === 'string' ? r : null;
  } catch {
    return null;
  }
}

export const saveCodex = (dir: string, r: CodexRecord) =>
  writeAtomic(path.join(dir, `${r.id}.json`), `${JSON.stringify(r)}\n`);

/** `cld-gui codex` (HIF §2's shape). */
export const codexJson = (r: CodexRecord) => ({
  id: r.id,
  project: r.project,
  model: r.model,
  model_slug: null,
  state: r.state,
  pid: r.pid,
  spec: r.spec,
  title: codexShownTitle(r.title, r.spec),
  dir: r.dir,
  worktree: r.worktree,
  branch: r.branch,
  started: r.started,
  ended: r.ended,
  exit: r.exit,
  limit: r.state === 'limit' ? { reset_at: r.resetAt, checked: null } : null,
  progress: { done: null, total: null, commits: r.commits },
  session_log: null,
  log: r.log,
});

export interface CodexTasksOptions {
  home: string;
  /** C7b: cld/rules (rulesDirFor); null = no shipped rules, the user's still apply. */
  rulesDir?: string | null;
  jobs: Jobs;
  /** E3: a task worktree in a project. */
  worktree: (
    project: { name: string; folder: string },
    task: string,
    /** W2: a Codex Worker's run for a Task: whose worktree it is. */
    meta?: { taskId?: string; assignmentId?: string; createdBy?: string },
  ) => Promise<{ path: string; branch: string }>;
  folderOf: (project: string) => string | null;
  changed?: () => void;
  now?: () => number;
  platform?: NodeJS.Platform;
  log?: (line: string) => void;
}

/** D5: what a Codex Worker's run carries beyond a `cld-gui codex` task. */
export interface WorkerRun {
  name: string;
  assignmentId: string;
  /** The message with its header line: the prompt (<id>.prompt.md, 0600). */
  prompt: string;
  /** C7b: whose playbook the run's rules carry, and the agent's own rules file. */
  role?: WorkerRole;
  rulesFile?: string;
  task?: string;
  resume?: string;
  messageId?: string;
  room?: { id: string; messageId?: string };
  title?: string;
  /** `cwd` is the Worker's own worktree: its commits are counted, as a task worktree's. */
  ownWorktree?: boolean;
  /** The branch of that worktree, when known (a follow-up in a task worktree). */
  branch?: string;
  /** W2 (N5): a new task worktree made for this run is not recorded as the Task's (the Task's
   *  own belongs to another agent now). */
  taskWorktree?: false;
}

/** The daemon's side: start, list, recover. */
export class CodexTasks {
  readonly dir: string;
  private watcher: fs.FSWatcher | null = null;
  private soon: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  /** D5: Worker runs by assignment, kept in memory: live() is read every poll, files only when
   *  the directory changed (the watch) or this went stale. */
  private workerRuns: CodexRecord[] = [];
  private indexAt = -Infinity;

  constructor(private readonly o: CodexTasksOptions) {
    this.dir = codexDir(o.home, o.platform);
    this.now = o.now ?? Date.now;
  }

  start(): void {
    this.recover();
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      this.watcher = fs.watch(this.dir, (_e, name) => {
        if (!name?.endsWith('.json')) return;
        this.indexAt = -Infinity;
        if (this.soon) return;
        this.soon = setTimeout(() => {
          this.soon = null;
          this.o.changed?.();
        }, 300);
      });
      this.watcher.on('error', () => undefined);
    } catch {
      /* the panel updates on the next recompute */
    }
  }

  dispose(): void {
    this.watcher?.close();
    if (this.soon) clearTimeout(this.soon);
  }

  /** `cld-gui codex …`: refused, or the task started. */
  async run(req: {
    spec: string;
    model: string | null;
    effort?: string | null;
    worktree: boolean;
    project: string | null;
    cwd: string;
    path?: string;
    source: string;
    /** D5: a Codex Worker's message (`spec` unused). */
    worker?: WorkerRun;
  }): Promise<Reply> {
    const w = req.worker;
    const worker = !!w;
    if (!worker && (!path.isAbsolute(req.spec) || !isFile(req.spec)))
      return refuse('bad_file', `명세 파일을 읽지 못했습니다: ${req.spec}`);
    let title: string;
    try {
      title = w
        ? (w.title ?? messageTitle(w.prompt))
        : codexTitle(req.spec, fs.readFileSync(req.spec, 'utf8'));
    } catch {
      return refuse('bad_file', `명세 파일을 읽지 못했습니다: ${req.spec}`);
    }
    if (req.model !== null && !/^[\w.:/@+ -]{1,80}$/.test(req.model))
      return refuse('usage', '모델 이름이 올바르지 않습니다');
    const effort = req.effort ?? null;
    if (effort !== null && !isCodexEffort(effort))
      return refuse('usage', `추론 강도는 ${CODEX_EFFORTS.join(' ')} 중 하나입니다`);
    const env = this.o.jobs.env();
    const codex = findOnPath(
      this.o.platform === 'win32' ? 'codex.cmd' : 'codex',
      req.path ?? env.PATH,
    );
    if (!codex) return refuse('no_codex', 'codex 실행 파일을 찾지 못했습니다(PATH)');
    let dir = req.cwd;
    let worktree: string | null = w?.ownWorktree ? req.cwd : null;
    let branch: string | null = w?.branch ?? null;
    if (req.worktree) {
      const folder = req.project ? this.o.folderOf(req.project) : null;
      if (!req.project || !folder)
        return refuse('no_project', '--worktree 는 엔진 프로젝트 안에서만 씁니다');
      try {
        let worktreeFolder = folder;
        try {
          const projectPath = fs.realpathSync(folder);
          const cwdPath = fs.realpathSync(req.cwd);
          if (cwdPath === projectPath || cwdPath.startsWith(`${projectPath}${path.sep}`)) {
            worktreeFolder = req.cwd;
          }
        } catch {
          // If either path cannot be resolved, keep using the configured project folder.
        }
        const made = await this.o.worktree(
          { name: req.project, folder: worktreeFolder },
          taskName(this.now()),
          w?.task && w.taskWorktree !== false
            ? { taskId: w.task, assignmentId: w.assignmentId, createdBy: `agent:${w.name}` }
            : undefined,
        );
        dir = worktree = made.path;
        branch = made.branch;
      } catch (err) {
        return refuse(
          'worktree_failed',
          `작업 공간을 만들지 못했습니다: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // C7b: a Worker's prompt starts with the rules a Claude Worker gets, but only when it starts a new
    // thread (a resumed thread already has them in its history); a plain spec run adds nothing.
    const rules = w && !w.resume
      ? composeWithPlaybook({
          home: this.o.home,
          rulesDir: this.o.rulesDir ?? null,
          role: w.role ?? 'worker',
          projectRulesFile: w.rulesFile,
        })
      : null;
    let record: CodexRecord | null = null;
    const r = this.o.jobs.run({
      cmd: `codex ${path.basename(req.spec)}`,
      cwd: dir,
      project: req.project,
      tty: false,
      path: req.path,
      source: req.source,
      codex: {
        bin: codex,
        ...(w && { agent: w.name }),
        prepare: (id, log) => {
          const spec = worker ? path.join(this.dir, `${id}.prompt.md`) : req.spec;
          if (w) writeAtomic(spec, rules?.text ? `${rules.text}\n\n---\n\n${w.prompt}` : w.prompt);
          record = {
            id,
            project: req.project,
            model: req.model,
            effort,
            state: 'running',
            dir,
            worktree,
            branch,
            base: null,
            spec,
            title,
            started: isoLocal(this.now()),
            ended: null,
            exit: null,
            resetAt: null,
            sid: null,
            commits: null,
            jobId: id,
            log,
            pid: null,
            source: req.source,
            ...(w && { agent: w.name, assignmentId: w.assignmentId }),
            ...(w?.task && { task: w.task }),
            ...(w?.resume && { resume: w.resume }),
            ...(w?.messageId && { messageId: w.messageId }),
            ...(w?.room && { room: w.room }),
          };
          saveCodex(this.dir, record);
          // At once, not at the watch: the next message must see this run (one at a time).
          if (record.assignmentId) this.workerRuns.push(record);
        },
      },
    });
    if (!r.ok) {
      if (record) {
        const id = (record as CodexRecord).id;
        fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
        fs.rmSync(path.join(this.dir, `${id}.prompt.md`), { force: true });
        this.workerRuns = this.workerRuns.filter((x) => x.id !== id);
      }
      return r;
    }
    appendCodexEvent(this.o.home, 'codex_start', {
      id: r.id,
      project: req.project,
      model: req.model,
      title,
      ...(w && { agent: w.name }),
      ...(w?.task && { task: w.task }),
      ...(rules?.playbook && { role: w?.role ?? 'worker', playbook: rules.playbook }),
    });
    this.o.changed?.();
    return { ok: true, id: r.id, pid: r.pid, log: r.log, dir, worktree, branch };
  }

  records(): CodexRecord[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    return names
      .sort()
      .map((n) => readCodex(this.dir, n.slice(0, -5)))
      .filter((r): r is CodexRecord => !!r);
  }

  /** Running and waiting ones, and those ended in the last 24 h (all with `all`). */
  list(all = false): CodexRecord[] {
    const now = this.now();
    return this.records().filter(
      (r) => all || !r.ended || now - (Date.parse(r.ended) || now) < DAY,
    );
  }

  /** The office's rows (CodexTask), `provider: engine`. */
  tasks(): Array<Omit<CodexTask, 'agentId'>> {
    return this.list().map((r) => ({
      id: r.id,
      project: r.project ?? '?',
      model: r.model,
      state: r.state,
      pid: r.pid,
      branch: r.branch,
      created: r.started,
      // Queued until the worker is up (older records had no `ran`: a pid means it ran).
      started: r.ran ?? (r.pid !== null ? r.started : null),
      ended: r.ended,
      exit: r.exit,
      resetAt: r.resetAt,
      progressDone: null,
      progressTotal: null,
      commits: r.commits,
      spec: path.basename(r.spec),
      title: codexShownTitle(r.title, r.spec),
      provider: 'engine',
      ...(r.agent && { agent: r.agent }),
      ...(r.task && { task: r.task }),
    }));
  }

  /** D5: every Worker run (records with an assignment), oldest first, from memory. */
  workerRecords(): CodexRecord[] {
    // ponytail: a full re-read per folder change; an incremental index if the folder grows large.
    if (this.indexAt === -Infinity || this.now() - this.indexAt > INDEX_STALE_MS) {
      this.workerRuns = this.records()
        .filter((r) => !!r.assignmentId)
        .sort(byStart);
      this.indexAt = this.now();
    }
    return this.workerRuns;
  }

  /** D5: an assignment's runs, oldest first. */
  runsOf(assignmentId: string): CodexRecord[] {
    return this.workerRecords().filter((r) => r.assignmentId === assignmentId);
  }

  /** The job that runs task `id` now (a recovered task runs under a new job). */
  jobOf(id: string): string | null {
    return readCodex(this.dir, id)?.jobId ?? null;
  }

  /**
   * A task still running or waiting whose worker is gone (a reboot) starts
   * again under a new job: same record, same Codex session. TOKEN-GUARD: never
   * one the user stopped (its job says so) whose worker died before writing it.
   */
  recover(): void {
    for (const r of this.records()) {
      if (r.state !== 'running' && r.state !== 'limit') continue;
      const job = this.o.jobs.list(true, true).find((j) => j.id === r.jobId);
      if (job && !job.ended) continue;
      if (job?.stopped) {
        saveCodex(this.dir, { ...r, state: 'stopped', ended: r.ended ?? isoLocal(), resetAt: null });
        this.log(`codex ${r.id}: stopped by the user; not started again`);
        continue;
      }
      const env = this.o.jobs.env();
      const codex = findOnPath(this.o.platform === 'win32' ? 'codex.cmd' : 'codex', env.PATH);
      if (!codex) {
        this.log(`codex ${r.id}: worker gone and codex not found; left as it is`);
        continue;
      }
      const j = this.o.jobs.run({
        cmd: `codex ${path.basename(r.spec)}`,
        cwd: r.dir,
        project: r.project,
        tty: false,
        source: 'revive',
        codex: {
          bin: codex,
          prepare: (jobId, log) => saveCodex(this.dir, { ...r, jobId, log }),
          id: r.id,
          ...(r.agent && { agent: r.agent }),
        },
      });
      this.log(
        j.ok ? `codex ${r.id}: worker started again (job ${j.id})` : `codex ${r.id}: ${j.error}`,
      );
    }
  }

  private log(line: string): void {
    (this.o.log ?? ((l: string) => console.log(`[cld engine] ${l}`)))(line);
  }
}

/** `codex-MMDD-HHMMSS` (E3's task names are lower case, digits and -). */
export function taskName(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `codex-${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** D5: a Worker run's title without a Task: its message's first line under the header. */
const messageTitle = (prompt: string): string =>
  prompt
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .find(Boolean)
    ?.slice(0, 80) ?? 'Codex';

/** D5: a Worker run's events name the Worker and its Task. */
const workerOf = (r: CodexRecord) => ({
  ...(r.agent && { agent: r.agent }),
  ...(r.task && { task: r.task }),
});

/** codex_* go to the engine's event log, from the daemon or the worker alike. */
const appendCodexEvent = (home: string, type: string, fields: Record<string, unknown>) =>
  appendEvent(eventsPath(home), type, 'codex', fields);

// ── The worker ─────────────────────────────────────────────────

/** The first `rate_limits` object anywhere in a Codex log record, or null. */
export function rateLimitsIn(o: unknown): Record<string, unknown> | null {
  if (!o || typeof o !== 'object') return null;
  const x = o as Record<string, unknown>;
  if (x.rate_limits && typeof x.rate_limits === 'object')
    return x.rate_limits as Record<string, unknown>;
  for (const v of Object.values(x)) {
    const r = rateLimitsIn(v);
    if (r) return r;
  }
  return null;
}

/**
 * The latest reset time of a usage window used up (>= 99 %) in the session's
 * own Codex log (`rate_limits`, the last per limit_id), as the usage plugin reads it; null
 * when none is found.
 */
export function resetFromSessions(sid: string, codexHome: string): number | null {
  let files: string[];
  try {
    files = (fs.readdirSync(path.join(codexHome, 'sessions'), { recursive: true }) as string[])
      .filter((f) => f.endsWith('.jsonl') && f.includes(sid))
      .map((f) => path.join(codexHome, 'sessions', f));
  } catch {
    return null;
  }
  const last = new Map<unknown, Record<string, unknown>>();
  for (const f of files) {
    let text = '';
    try {
      text = fs.readFileSync(f, 'utf-8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"rate_limits"')) continue;
      try {
        const rl = rateLimitsIn(JSON.parse(line));
        if (rl) last.set(rl.limit_id ?? null, rl);
      } catch {
        /* a broken line */
      }
    }
  }
  let best: number | null = null;
  for (const rl of last.values())
    for (const w of [rl.primary, rl.secondary]) {
      const win = w as { resets_at?: unknown; used_percent?: unknown } | undefined;
      if (
        win &&
        typeof win.resets_at === 'number' &&
        typeof win.used_percent === 'number' &&
        win.used_percent >= 99
      )
        best = Math.max(best ?? 0, win.resets_at);
    }
  return best === null ? null : best * 1000;
}

/** Codex's own progress note, never meant for a commit. */
export const PROGRESS_FILE = 'CODEX_PROGRESS.md';

/**
 * Adds `line` to the repository's info/exclude (shared by all its worktrees)
 * unless it is already there. Returns whether it wrote.
 */
export function excludeLine(dir: string, line = PROGRESS_FILE): boolean {
  const g = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: dir,
    encoding: 'utf-8',
    timeout: 15_000,
  });
  if (g.status !== 0) return false;
  const file = path.join(path.resolve(dir, g.stdout.trim()), 'info', 'exclude');
  try {
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
    if (text.split('\n').some((l) => l.trim() === line)) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`);
    return true;
  } catch {
    return false;
  }
}

export interface WorkerDeps {
  home: string;
  /** codex's absolute path. */
  codex: string;
  /** CLD_BIN (the cld-gui CLI), for the one-line notices; null = none. */
  cldBin: string | null;
  timing?: Partial<typeof CODEX_TIMING>;
  now?: () => number;
  /** Waits; resolves early when `wake` is called (a stop). */
  sleep?: (ms: number, wake: (fn: () => void) => void) => Promise<void>;
  spawnFn?: typeof spawn;
  print?: (line: string) => void;
  onSignal?: (fn: () => void) => void;
}

/** `cld-worker.js codex <id>`: the task to its end. Returns Codex's last exit code. */
export async function runCodex(id: string, d: WorkerDeps): Promise<number> {
  const dir = codexDir(d.home);
  const t = { ...CODEX_TIMING, ...d.timing };
  const now = d.now ?? Date.now;
  const print = d.print ?? ((l: string) => console.log(`[${shortStamp(now())}] ${l}`));
  const event = (type: string, fields: Record<string, unknown>) =>
    appendEvent(eventsPath(d.home), type, 'codex', fields, now());
  let r = readCodex(dir, id);
  if (!r) {
    print(`작업 기록이 없습니다: ${id}`);
    return 1;
  }
  const save = (patch: Partial<CodexRecord>) => {
    r = { ...r!, ...patch };
    saveCodex(dir, r);
  };
  const git = (args: string[]) => {
    // GIT-HARDEN: `rev-list base..HEAD` on a missing object would lazily fetch (no transport).
    const g = spawnSync('git', args, { cwd: r!.dir, encoding: 'utf-8', timeout: 15_000, env: { ...process.env, ...NO_FETCH_ENV } });
    return g.status === 0 ? g.stdout.trim() : null;
  };
  save({
    pid: process.pid,
    base: r.base ?? git(['rev-parse', 'HEAD']),
    ran: r.ran ?? isoLocal(now()),
  });
  // D5: a Worker's run reports through the daemon (to its Lead, under its name), never here.
  const notify = (text: string) => {
    if (!r!.project || !d.cldBin || r!.assignmentId) return;
    // From the file system root and with no agent token: no project is the sender, the line says who.
    const cli = path.join(path.dirname(d.cldBin), 'cld-gui');
    spawnSync(process.execPath, [cli, 'send', r!.project, text], {
      cwd: path.parse(r!.dir).root,
      env: { ...process.env, CLD_SOURCE: 'codex', CLD_OUTPUT: 'json', CLD_AGENT_TOKEN: undefined },
      stdio: 'ignore',
      timeout: 60_000,
    });
  };

  let stopped = false;
  let child: ChildProcess | null = null;
  let wakeUp: (() => void) | null = null;
  (d.onSignal ?? ((fn) => ['SIGTERM', 'SIGINT', 'SIGHUP'].forEach((s) => process.on(s, fn))))(
    () => {
      stopped = true;
      child?.kill('SIGTERM');
      wakeUp?.();
    },
  );
  const sleep =
    d.sleep ??
    ((ms: number, wake: (fn: () => void) => void) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        wake(() => {
          clearTimeout(timer);
          resolve();
        });
      }));

  if (r.worktree) excludeLine(r.dir);
  // Codex may commit inside a worktree: its git folders are outside the workspace.
  const gitDirs = [git(['rev-parse', '--git-dir']), git(['rev-parse', '--git-common-dir'])]
    .filter((x): x is string => !!x)
    .map((g) => path.resolve(r!.dir, g));
  const common = [
    '--json',
    ...(r.model ? ['-m', r.model] : []),
    ...(r.effort ? ['-c', `model_reasoning_effort=${r.effort}`] : []),
    ...(gitDirs.length
      ? ['-c', `sandbox_workspace_write.writable_roots=${JSON.stringify([...new Set(gitDirs)])}`]
      : []),
  ];
  const out = path.join(dir, `${id}.jsonl`);
  const last = path.join(dir, `${id}.last.md`);
  /** D5: a Worker's run keeps Codex's last message and its sandbox on a resume too
   *  (`exec resume` takes no -s; see the D5 report for what a real Codex must confirm). */
  const workerArgs = (resuming: boolean) =>
    r!.assignmentId
      ? [...(resuming ? ['-c', `sandbox_mode="${WORKER_SANDBOX}"`] : []), '-o', last]
      : [];
  const size = () => {
    try {
      return fs.statSync(out).size;
    } catch {
      return 0;
    }
  };
  const since = (off: number) => {
    try {
      const fd = fs.openSync(out, 'r');
      try {
        const len = Math.max(0, size() - off);
        const buf = Buffer.alloc(Math.min(len, 8 * 1024 * 1024));
        const n = fs.readSync(fd, buf, 0, buf.length, off);
        return buf.toString('utf-8', 0, n);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return '';
    }
  };
  const sidIn = (text: string) => /"thread_id"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? null;

  /** One codex run, its output appended to <id>.jsonl; the session id saved as soon as seen. */
  const once = (off: number): Promise<number> =>
    new Promise((resolve) => {
      const fd = fs.openSync(out, 'a', 0o600);
      const args = r!.sid
        ? ['exec', 'resume', ...common, ...workerArgs(true), r!.sid, RESUME_TEXT]
        : r!.resume
          ? ['exec', 'resume', ...common, ...workerArgs(true), r!.resume, '-']
          : ['exec', ...common, ...workerArgs(false), '-s', 'workspace-write', '-C', r!.dir, '-'];
      const run = commandArgv(d.codex, args); // codex.cmd on Windows
      const c = (d.spawnFn ?? spawn)(run.file, run.args, {
        windowsVerbatimArguments: run.windowsVerbatimArguments,
        cwd: r!.dir,
        stdio: [r!.sid ? 'ignore' : 'pipe', fd, fd],
        windowsHide: true,
      });
      child = c;
      fs.closeSync(fd);
      if (!r!.sid) {
        c.stdin?.on('error', () => undefined);
        c.stdin?.end(fs.readFileSync(r!.spec));
      }
      const look = setInterval(() => {
        const sid = r!.sid ?? sidIn(since(off));
        if (sid && !r!.sid) save({ sid });
      }, t.sidMs);
      c.on('error', () => undefined);
      c.on('close', (code, sig) => {
        clearInterval(look);
        child = null;
        if (!r!.sid) {
          const sid = sidIn(since(off));
          if (sid) save({ sid });
        }
        resolve(code ?? (sig ? 143 : 1));
      });
    });

  let rc = 1;
  /** Blind laps in a row (no reset time): each waits twice as long, up to pollMaxMs. */
  let blind = 0;
  for (let n = 0; n < 300 && !stopped; n++) {
    if (r.state === 'limit') {
      print(
        r.resetAt
          ? `사용량 한도 대기 · ${shortStamp(Date.parse(r.resetAt))} 에 같은 세션을 이어 간다`
          : '사용량 한도 대기 · 간격을 늘려 가며(최대 1시간) 다시 해 본다',
      );
      const due = r.resetAt ? Date.parse(r.resetAt) + t.marginMs : NaN;
      // A reset already past (a stale reading, a skewed clock) or unreadable is no reason
      // to try again at once: then it polls, so a limit that persists never spins hot.
      const reset = due > now() ? due : null;
      const wait = reset === null ? Math.min(t.pollMs * 2 ** blind++, t.pollMaxMs) : t.pollMs;
      if (reset !== null) blind = 0;
      for (;;) {
        const left = reset === null ? wait : reset - now();
        if (left <= 0 || stopped) break;
        await sleep(Math.min(left, wait), (fn) => (wakeUp = fn));
        wakeUp = null;
        if (reset === null) break;
      }
      if (stopped) break;
      event('codex_resume', { id, project: r.project, title: r.title, lap: n, blind: reset === null });
      print('같은 세션을 이어 간다');
    }
    save({ state: 'running', resetAt: null });
    const off = size();
    rc = await once(off);
    if (stopped || !hitLimit(since(off))) break;
    const reset = r.sid
      ? resetFromSessions(r.sid, process.env.CODEX_HOME ?? path.join(d.home, '.codex'))
      : null;
    const resetAt = reset === null ? null : isoLocal(reset);
    save({ state: 'limit', resetAt });
    // TOKEN-GUARD: each notice is a turn of the orchestrator; the same wait is told once.
    const mark = `limit:${resetAt ?? ''}`;
    event('codex_limit', {
      id,
      project: r.project,
      reset_at: resetAt,
      title: r.title,
      ...workerOf(r),
      notified: r.told !== mark,
    });
    if (r.told === mark) continue;
    notify(
      `[cld-gui codex] 작업 ${id} 이 Codex 사용량 한도에 걸렸다. ${
        reset === null ? '간격을 늘려 가며(최대 1시간) 다시 해 보고' : `${shortStamp(reset)} 에`
      } 같은 세션을 이어 간다(멈추기: ${CLI_NAME} stop ${id})`,
    );
    save({ told: mark });
  }
  const state: CodexState = stopped
    ? 'stopped'
    : rc === 0 && r.state === 'running'
      ? 'done'
      : 'failed';
  const commits = r.base ? Number(git(['rev-list', '--count', `${r.base}..HEAD`]) ?? NaN) : NaN;
  let summary: string | undefined;
  if (r.assignmentId)
    try {
      summary = fs.readFileSync(last, 'utf-8').trim().slice(0, SUMMARY_MAX) || undefined;
    } catch {
      /* Codex wrote no last message */
    }
  save({
    state,
    ended: isoLocal(now()),
    exit: rc,
    resetAt: null,
    commits: Number.isFinite(commits) ? commits : null,
    ...(summary && { summary }),
  });
  event('codex_end', { id, project: r.project, state, exit: rc, title: r.title, ...workerOf(r) });
  print(`끝: ${state} (exit ${rc})`);
  notify(
    `[cld-gui codex] 작업 ${id} 끝: ${state} · 폴더 ${r.dir} · 커밋 ${r.commits ?? '?'}개 · 로그 ${r.log}`,
  );
  return rc;
}
