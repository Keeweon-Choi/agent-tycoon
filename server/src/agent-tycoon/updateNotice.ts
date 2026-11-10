/**
 * P3a: a released-version notice, and an "설치" that asks first.
 *
 * The check is `agty update --check --json` (agent-tycoon/install/update.mjs: the pinned release key must
 * verify the signed SHA256SUMS, nothing is unpacked), so the daemon trusts nothing the manager does
 * not. No timer: a check happens only when a page asks for the view (someone is watching), at most
 * every CHECK_EVERY_MS, or when 설정's 지금 확인 asks (at most every CHECK_NOW_MIN_MS). One that fails
 * shows no notice; the view's `lastCheck` says when it was and why it failed.
 * The install is the same `agty update --from <bundle>`, started detached so it outlives the daemon
 * it stops (systemd KillMode=process); on Windows (schtasks) the manager runs it as its own hidden
 * one-shot task instead (`update --background`), since ending the daemon's task would end its
 * children. Sessions, worktrees and jobs are separate processes and keep running. The new daemon
 * reads the result: its own version is the target, or it is not.
 *
 * Two different things are kept apart on purpose. `canVerify`: this build has the code (Ed25519 +
 * SHA-256 of the daemon bundle). `release`: whether THIS release's list was actually signed by the
 * key pinned at install (only a check that passed says so). `officialKey` / `osCodeSigning` stay
 * false until a real release key and OS code signing exist (P9, F-25); flip them there.
 */
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { sameOriginRequest } from './authRoutes.js';
import { readJson, writeJsonAtomic } from './jsonFile.js';
import { STEPUP_REQUIRED } from './shell/gate.js';

/** The public repository's newest release; a release still has to verify against the key pinned at install. */
export const UPDATE_SOURCE =
  'https://github.com/Keeweon-Choi/agent-tycoon/releases/latest/download';
export const CHECK_EVERY_MS = 3_600_000;
export const RETRY_AFTER_FAIL_MS = 3_600_000;
const CHECK_TIMEOUT_MS = 60_000;
const RESULT_KEEP_MS = 24 * 3_600_000;
/** 지금 확인 (POST /api/agty/update/check) runs at most this often. */
export const CHECK_NOW_MIN_MS = 60_000;
const REASON_MAX = 200;
/** False until a real release key is published (P9); true must never be shown before that. */
export const OFFICIAL_RELEASE_KEY = false;
/** False until Windows/macOS code signing exists (F-25: the first public release has none). */
export const OS_CODE_SIGNING = false;
/** Services whose stop leaves a detached child alive (systemd KillMode=process; a detached daemon). */
const DETACH_SAFE = new Set(['systemd', 'detached']);
/**
 * Services whose updater runs as its own scheduled task (the manager's `update --background`).
 * ponytail: launchd stays terminal-only (bootout ends the job's children); a Mac check before it gets one.
 */
const OWN_TASK = new Set(['schtasks']);
/** The updater task has this long to take the manager's lock before a run with no lock counts as over. */
const TASK_START_GRACE_MS = 60_000;
/** An unreadable manager.lock younger than this is one being written (the manager's own acquireLock rule). */
const LOCK_HALF_WRITTEN_MS = 60_000;
/** A lock taken this long before the run started belongs to an older operation. */
const LOCK_CLOCK_SLACK_MS = 5_000;
/** A run still "running" after this is over whatever its pid or lock says (a pid reused after a reboot). */
const RUN_LIMIT_MS = 2 * 3_600_000;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;
const BUNDLE_RE =
  /^agent-tycoon-daemon-[0-9A-Za-z.+-]+-(linux|darwin|win)-(x64|arm64)\.tar\.(gz|zst)$/;

export interface UpdateFacts {
  /** Agents with a live session. */
  sessions: number;
  /** Jobs still running. */
  jobs: number;
  /** Active task worktrees. */
  worktrees: number;
  /** A merge or another git write is running right now: the one conflict worth waiting for. */
  merging: boolean;
}

interface Stored {
  checkedAt: number;
  ok: boolean;
  /** Why the last check failed (the manager's last error line). */
  reason?: string | null;
  /** The installed version this check was made for (a different one means the file is old news). */
  current: string | null;
  available: string | null;
  bundle: string | null;
  notes: string | null;
  run?: {
    state: 'running' | 'done' | 'failed';
    to: string;
    /** The detached updater; none for one in its own task (OWN_TASK), which the manager's lock tells about. */
    pid?: number;
    startedAt: number;
    finishedAt?: number;
    tail?: string;
  };
}

export interface UpdateView {
  managed: boolean;
  current: string | null;
  available: { version: string; notes: string | null } | null;
  signature: {
    /** This build has the code to check signatures and hashes. Not a statement about any release. */
    canVerify: boolean;
    /** `verified`: a check just proved this release's list is signed by the key pinned at install. */
    release: 'verified' | 'unknown';
    officialKey: boolean;
    osCodeSigning: boolean;
  };
  facts: UpdateFacts;
  /** This requester may press 설치 (not read-only; the service survives a detached child). */
  canInstall: boolean;
  /** The install is done in a terminal (this service kind would take the updater down with the daemon). */
  terminalOnly: boolean;
  command: string;
  install: { state: 'running' | 'done' | 'failed'; to: string; message: string } | null;
  /** The last check (epoch ms), null before the first. */
  lastCheck: { at: number; ok: boolean; reason?: string } | null;
}

export interface UpdateOptions {
  configDir: string;
  /** The install root, null for a source install (the notice is off). */
  root: string | null;
  /** This daemon's own release version (agent-tycoon/release/version.json). */
  version: string | null;
  serviceKind: string | null;
  managerPath: string;
  readOnly: boolean;
  facts(): UpdateFacts;
  source?: string;
  now?(): number;
  /** The manager's stdout for `update --check --json`. */
  check?(args: string[]): Promise<string>;
  /** Starts the manager detached with its output in `log`; the pid, or null. */
  start?(args: string[], log: string): number | null;
  /** Runs `manager update --background ...` (OWN_TASK), which starts the updater task and returns; false: it did not. */
  startTask?(args: string[], log: string): Promise<boolean>;
  alive?(pid: number): boolean;
}

export type InstallResult = { ok: true; to: string } | { ok: false; code: string; error: string };

const realCheck = (args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(
      process.execPath,
      args,
      { timeout: CHECK_TIMEOUT_MS, maxBuffer: 256 * 1024 },
      (err, stdout, stderr) =>
        err
          ? reject(
              new Error(
                String(stderr || err.message)
                  .trim()
                  .split('\n')
                  .pop(),
              ),
            )
          : resolve(stdout),
    ),
  );

function realStart(args: string[], log: string): number | null {
  try {
    const fd = fs.openSync(log, 'w', 0o600);
    const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', fd, fd] });
    child.on('error', () => undefined);
    child.unref();
    fs.closeSync(fd);
    return child.pid ?? null;
  } catch {
    return null;
  }
}

function realStartTask(args: string[], log: string): Promise<boolean> {
  try {
    fs.writeFileSync(log, '', { mode: 0o600 }); // the task's updater appends to it
  } catch {
    /* it is created by the updater then */
  }
  return new Promise((resolve) =>
    execFile(
      process.execPath,
      args,
      { timeout: CHECK_TIMEOUT_MS, windowsHide: true },
      (err, _out, stderr) => {
        if (err)
          console.warn(
            `[agty update] the updater task did not start: ${String(stderr || err.message).trim()}`,
          );
        resolve(!err || !!err.killed); // timed out: the task may be running; settle() tells (lock, grace)
      },
    ),
  );
}

const realAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** The managed install this daemon runs from (`<root>/versions/<v>`), or null (a source install, a checkout). */
export function managedInstall(
  repoRoot: string,
): { root: string; serviceKind: string | null; version: string | null } | null {
  try {
    const real = fs.realpathSync(repoRoot);
    if (path.basename(path.dirname(real)) !== 'versions') return null;
    const root = path.dirname(path.dirname(real));
    const record = readJson(path.join(root, 'install.json')) as {
      current?: unknown;
      service?: { kind?: unknown };
    } | null;
    if (!record || typeof record.current !== 'string') return null;
    const v = readJson(path.join(real, 'agent-tycoon', 'release', 'version.json')) as {
      version?: unknown;
    } | null;
    return {
      root,
      serviceKind: typeof record.service?.kind === 'string' ? record.service.kind : null,
      version: typeof v?.version === 'string' ? v.version : null,
    };
  } catch {
    return null;
  }
}

export class UpdateNotice {
  private readonly file: string;
  private readonly log: string;
  private state: Stored;
  private inflight: Promise<void> | null = null;
  private readonly source: string;

  constructor(private readonly o: UpdateOptions) {
    this.file = path.join(o.configDir, 'update-notice.json');
    this.log = path.join(o.configDir, 'update.log');
    this.source = o.source ?? UPDATE_SOURCE;
    this.state = {
      checkedAt: 0,
      ok: false,
      current: null,
      available: null,
      bundle: null,
      notes: null,
    };
    try {
      const s = readJson(this.file) as Partial<Stored> | null;
      if (s && typeof s.checkedAt === 'number') this.state = { ...this.state, ...s };
    } catch {
      /* a file we cannot read is a check not made yet */
    }
  }

  private now = () => (this.o.now ?? Date.now)();
  get managed(): boolean {
    return this.o.root !== null && this.o.version !== null;
  }

  private save(): void {
    try {
      writeJsonAtomic(this.file, this.state);
    } catch (err) {
      console.warn(`[agty update] could not write ${this.file}: ${String(err)}`);
    }
  }

  /** The newest release, when it is time to look. Never rejects: a failed check leaves no trace but a log line. */
  private check(): Promise<void> {
    const s = this.state;
    const age = this.now() - s.checkedAt;
    const stale = s.current !== this.o.version;
    if (!this.managed || (!stale && age < (s.ok ? CHECK_EVERY_MS : RETRY_AFTER_FAIL_MS)))
      return Promise.resolve();
    return this.checkOnce();
  }

  private checkOnce(): Promise<void> {
    this.inflight ??= this.doCheck().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private forcedAt = 0;
  /** 지금 확인: a check now, whatever the age of the last one; false: asked within CHECK_NOW_MIN_MS. */
  async checkNow(): Promise<boolean> {
    if (!this.managed) return true;
    if (this.forcedAt && this.now() - this.forcedAt < CHECK_NOW_MIN_MS) return false;
    this.forcedAt = this.now();
    await this.checkOnce();
    return true;
  }

  private async doCheck(): Promise<void> {
    const keep = this.state.current === this.o.version ? this.state : null;
    try {
      const out = (this.o.check ?? realCheck)([
        this.o.managerPath,
        'update',
        '--check',
        '--json',
        '--root',
        this.o.root!,
        '--from',
        this.source,
      ]);
      const r = JSON.parse((await out).trim().split('\n').pop() ?? '') as Record<string, unknown>;
      const version = r.available;
      const found =
        typeof version === 'string' &&
        VERSION_RE.test(version) &&
        r.failed !== true &&
        typeof r.bundle === 'string' &&
        BUNDLE_RE.test(r.bundle);
      this.state = {
        ...this.state,
        checkedAt: this.now(),
        ok: true,
        reason: null,
        current: this.o.version,
        available: found ? version : null,
        bundle: found ? (r.bundle as string) : null,
        notes: found && typeof r.notes === 'string' ? r.notes : null,
      };
    } catch (err) {
      console.warn(`[agty update] check failed: ${(err as Error).message}`);
      this.state = {
        ...this.state,
        checkedAt: this.now(),
        ok: false,
        reason: ((err as Error).message || String(err)).trim().slice(0, REASON_MAX),
        current: this.o.version,
        available: keep?.available ?? null,
        bundle: keep?.bundle ?? null,
        notes: keep?.notes ?? null,
      };
    }
    this.save();
  }

  /** The result of the last install this daemon (or the one before it) started. */
  private settle(): UpdateView['install'] {
    const run = this.state.run;
    if (!run || !this.managed) return null; // a source install never started one: an old file is not news
    if (
      run.state === 'running' &&
      (this.now() - run.startedAt >= RUN_LIMIT_MS ||
        !(run.pid ? (this.o.alive ?? realAlive)(run.pid) : this.taskBusy(run.startedAt)))
    ) {
      const done = this.o.version === run.to;
      this.state.run = {
        ...run,
        state: done ? 'done' : 'failed',
        finishedAt: this.now(),
        ...(done ? {} : { tail: this.tail() }),
      };
      this.save();
    }
    const r = this.state.run!;
    if (r.finishedAt && this.now() - r.finishedAt > RESULT_KEEP_MS) {
      delete this.state.run;
      this.save();
      return null;
    }
    const message =
      r.state === 'running'
        ? `${r.to} 로 올리는 중이에요. 사무실이 잠깐 다시 시작돼요 (세션은 그대로)`
        : r.state === 'done'
          ? `${r.to} 로 올렸어요`
          : `${r.to} 로 올리지 못했어요. 지금 버전은 그대로예요${r.tail ? `: ${r.tail}` : ''} (터미널에서 agty status)`;
    return { state: r.state, to: r.to, message };
  }

  /** An updater task is at work while its manager holds <root>/manager.lock, or is still starting. */
  private taskBusy(startedAt: number): boolean {
    const file = path.join(this.o.root!, 'manager.lock');
    try {
      const lock = readJson(file) as { pid?: unknown; op?: unknown; startedAt?: unknown } | null;
      if (
        lock?.op === 'update' &&
        typeof lock.pid === 'number' &&
        typeof lock.startedAt === 'string' &&
        Date.parse(lock.startedAt) >= startedAt - LOCK_CLOCK_SLACK_MS &&
        (this.o.alive ?? realAlive)(lock.pid)
      )
        return true;
    } catch {
      // Half written: the manager is taking it right now, unless it has been like that for a minute.
      try {
        if (this.now() - fs.statSync(file).mtimeMs < LOCK_HALF_WRITTEN_MS) return true;
      } catch {
        /* gone meanwhile */
      }
    }
    return this.now() - startedAt < TASK_START_GRACE_MS;
  }

  private tail(): string {
    try {
      const lines = fs
        .readFileSync(this.log, 'utf-8')
        .replace(/\x1b\[[0-9;]*m/g, '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      return lines.slice(-2).join(' / ').slice(0, 400);
    } catch {
      return '';
    }
  }

  /** What the page shows. `mayAct`: this requester is not read-only. */
  async view(mayAct: boolean): Promise<UpdateView> {
    await this.check();
    const s = this.state;
    const available =
      s.available && s.current === this.o.version && s.available !== this.o.version ? s : null;
    const terminalOnly = this.terminalOnly;
    return {
      managed: this.managed,
      current: this.o.version,
      available: available ? { version: available.available!, notes: available.notes } : null,
      signature: {
        canVerify: this.managed,
        // Only a check that passed reaches `available`, and it verified the list against the pinned key.
        release: available ? 'verified' : 'unknown',
        officialKey: OFFICIAL_RELEASE_KEY,
        osCodeSigning: OS_CODE_SIGNING,
      },
      facts: this.o.facts(),
      canInstall: this.managed && mayAct && !terminalOnly,
      terminalOnly,
      command: `agty update --from ${this.source}`,
      install: this.settle(),
      lastCheck:
        this.managed && s.checkedAt
          ? { at: s.checkedAt, ok: s.ok, ...(s.ok || !s.reason ? {} : { reason: s.reason }) }
          : null,
    };
  }

  private get terminalOnly(): boolean {
    const kind = this.o.serviceKind ?? '';
    return !DETACH_SAFE.has(kind) && !OWN_TASK.has(kind);
  }

  /** The one place an install starts. Re-reads the live facts; postpones (never fails silently) on a real conflict. */
  async install(version: unknown, who: string): Promise<InstallResult> {
    const no = (code: string, error: string): InstallResult => ({ ok: false, code, error });
    const s = this.state;
    if (!this.managed) return no('not_managed', '소스로 깐 사무실이라 여기서 올리지 않아요');
    if (this.terminalOnly) return no('terminal_only', '이 설치는 터미널에서 올려 주세요');
    if (this.settle()?.state === 'running')
      return no('running', '이미 업데이트가 진행 중이라 미뤘어요');
    if (
      !s.available ||
      s.current !== this.o.version ||
      typeof version !== 'string' ||
      version !== s.available ||
      !s.bundle
    )
      return no('changed', '알림의 버전이 바뀌었어요. 화면을 새로 고친 뒤 다시 눌러 주세요');
    if (this.o.facts().merging)
      return no(
        'merging',
        '머지가 진행 중이라 미뤘어요. 끝난 뒤 다시 눌러 주세요 (머지를 중간에 끊지 않으려고요)',
      );
    const to = s.available;
    // The release the notice showed, not latest/: one published since the check would 404 the bundle.
    const from = `${this.source.replace(/\/latest\/download$/, `/download/v${to}`)}/${s.bundle}`;
    if (OWN_TASK.has(this.o.serviceKind ?? '')) {
      // Marked first: a second press while the task starts is postponed like one while it runs.
      this.state.run = { state: 'running', to, startedAt: this.now() };
      const args = [
        this.o.managerPath,
        'update',
        '--background',
        '--from',
        from,
        '--root',
        this.o.root!,
      ];
      if (!(await (this.o.startTask ?? realStartTask)(args, this.log))) {
        delete this.state.run;
        return no('spawn', '업데이트를 시작하지 못했어요');
      }
      this.save();
      console.log(`[agty update] install ${to} started by ${who} (its own task)`);
      return { ok: true, to };
    }
    const args = [this.o.managerPath, 'update', '--from', from, '--root', this.o.root!];
    const pid = (this.o.start ?? realStart)(args, this.log);
    if (pid === null) return no('spawn', '업데이트를 시작하지 못했어요');
    this.state.run = { state: 'running', to: s.available, pid, startedAt: this.now() };
    this.save();
    console.log(`[agty update] install ${s.available} started by ${who} (pid ${pid})`);
    return { ok: true, to: s.available };
  }
}

export interface RequestKind {
  /** The host's own Bearer token. */
  host: boolean;
  /** Not this PC and not the host: dangerous actions need a fresh step-up. */
  remote: boolean;
}

/** GET /api/agty/update, POST /api/agty/update/check and /install. `auth` is the login-session (or Bearer) gate. */
export function registerUpdateRoutes(
  app: FastifyInstance,
  auth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
  notice: UpdateNotice,
  readOnly: boolean,
  stepUpFresh?: (request: FastifyRequest) => boolean,
  kindOf?: (request: FastifyRequest) => RequestKind,
  actorOf?: (request: FastifyRequest) => string | undefined,
): void {
  // Unknown standing is the careful one: a remote device, not the host.
  const kind = (request: FastifyRequest): RequestKind =>
    kindOf?.(request) ?? { host: false, remote: true };
  // Like the connector panel: the host may always act, a logged-in device only when actions are allowed.
  const mayAct = (request: FastifyRequest) => kind(request).host || !readOnly;
  app.get('/api/agty/update', { preHandler: auth }, async (request) => notice.view(mayAct(request)));
  app.post('/api/agty/update/check', { preHandler: auth }, async (request, reply) => {
    if (!kind(request).host && !sameOriginRequest(request))
      return reply.code(403).send({ error: '요청 출처가 달라요' });
    if (!(await notice.checkNow()))
      return reply
        .code(429)
        .send({ error: '방금 확인했어요. 1분 뒤 다시 눌러 주세요', code: 'throttled' });
    return notice.view(mayAct(request));
  });
  app.post<{ Body: { version?: unknown } | undefined }>(
    '/api/agty/update/install',
    { preHandler: auth },
    async (request, reply) => {
      const k = kind(request);
      if (!k.host && !sameOriginRequest(request))
        return reply.code(403).send({ error: '요청 출처가 달라요' });
      if (!mayAct(request)) return reply.code(403).send({ error: '읽기 전용이라 올릴 수 없어요' });
      if (k.remote && !stepUpFresh?.(request))
        return reply.code(403).send({ error: STEPUP_REQUIRED });
      const r = await notice.install(
        request.body?.version,
        k.host ? 'host' : (actorOf?.(request) ?? 'device'),
      );
      return r.ok ? r : reply.code(409).send({ error: r.error, code: r.code });
    },
  );
}
