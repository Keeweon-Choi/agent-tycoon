/**
 * GPU reservations and their queue (T-0021, cld/docs/design/cld-cli.md §13):
 * a file-based queue in Node, so every wrapper process and the daemon can stand
 * in one queue for one GPU without calling each other.
 *
 * In the queue folder: tickets `q-<8-digit seq>-<id>`, leases `l-<id>`, the
 * admission lock `.admit`, the sequence `.seq` (counted under `.admit`). A
 * ticket or lease is `key=value` lines and is held by its owner, the wrapper
 * process, for as long as it lives:
 * - Linux (flock(1) found): a flock on the file, taken by a `flock` child on
 *   the wrapper's own open file description, so it lasts until the wrapper
 *   closes it or dies (kill -9 included) and its command's children never
 *   inherit it (Node opens files close-on-exec). Anyone whose `flock -n`
 *   succeeds knows the owner is dead. any other implementation can do the same;
 * - elsewhere: `.admit.lock` by exclusive create, and an owner is alive while
 *   the `pid` in its file is.
 * Strict FIFO: only the head may enter, under the user's numbers in
 * ~/.config/agent-tycoon/gpu.json. Without them the rule fails closed (ADR-0014, T-0094): numbers
 * derived from the GPU's total VRAM, and with that unknown one reservation at a time.
 */
import type { ChildProcess } from 'child_process';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CLI_NAME } from '../cliName.js';
import { configDirectory } from '../configPath.js';
import { findOnPath } from '../providers/claudeProvider.js';
import { windowsCmd } from '../spawnJson.js';
import { isoLocal } from './events.js';

const C = fs.constants;
/** The file is not there (any other failure to open it is no proof its owner died). */
const gone = (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT';
const ADMIT_WAIT_S = 10;
/** The pid-backend admission lock is taken from a holder older than this (it died mid-admission). */
const STALE_ADMIT_MS = 60_000;
export const GPU_POLL_MS = 2_000;
/** hw.json readings older than this do not count for the live VRAM rule (HIF §9). */
const HW_FRESH_MS = 5_000;

export interface GpuConfig {
  dir?: string;
  exclusiveGib?: number;
  sharedBudgetGib?: number;
  liveLimitGib?: number;
  nvidiaSmi?: boolean;
}

/** Whose numbers decide: the user's file, a share of the GPU's size, or neither (one at a time). */
export type GpuRule = 'file' | 'derived' | 'unknown';

/** The admission numbers in force; `unknown` has zeros, so every reservation counts as exclusive. */
export interface GpuPolicy {
  exclusiveGib: number;
  sharedBudgetGib: number;
  liveLimitGib: number | null;
  rule: GpuRule;
  /** The GPU's size the numbers were derived from (`derived` only). */
  totalGib: number | null;
}

export const gpuConfigPath = (home = os.homedir()): string =>
  path.join(configDirectory(home), 'gpu.json');

/** ~/.config/agent-tycoon/gpu.json; a field of the wrong type is ignored, a broken file is empty. */
export function readGpuConfig(home = os.homedir()): GpuConfig {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(fs.readFileSync(gpuConfigPath(home), 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
  if (!j || typeof j !== 'object') return {};
  const out: GpuConfig = {};
  const num = (k: 'exclusiveGib' | 'sharedBudgetGib' | 'liveLimitGib') => {
    const v = j[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
  };
  num('exclusiveGib');
  num('sharedBudgetGib');
  num('liveLimitGib');
  if (typeof j.dir === 'string' && path.isAbsolute(j.dir)) out.dir = j.dir;
  if (typeof j.nvidiaSmi === 'boolean') out.nvidiaSmi = j.nvidiaSmi;
  return out;
}

/** Shares of the GPU's total VRAM the default rule uses (the installer's gpuPolicy.mjs says the same). */
export const DERIVED_SHARE = { exclusive: 0.55, shared: 0.55, live: 0.75 } as const;
const halfGib = (gib: number) => Math.round(gib * 2) / 2;

/** The user's file has both thresholds (the rule then needs no GPU reading at all). */
export const hasThresholds = (c: GpuConfig): boolean =>
  c.exclusiveGib !== undefined && c.sharedBudgetGib !== undefined;

/**
 * The numbers in force, never "none": gpu.json when it has both thresholds; else shares of the
 * GPU's total (a single field the file does set still wins); with the total unknown, zeros, so
 * every reservation is exclusive. A reservation must never fail open (T-0094).
 */
export function policyOf(c: GpuConfig, totalMib: number | null): GpuPolicy {
  if (hasThresholds(c))
    return {
      exclusiveGib: c.exclusiveGib!,
      sharedBudgetGib: c.sharedBudgetGib!,
      liveLimitGib: c.liveLimitGib ?? null,
      rule: 'file',
      totalGib: null,
    };
  if (totalMib === null || !(totalMib > 0))
    return {
      exclusiveGib: 0,
      sharedBudgetGib: 0,
      liveLimitGib: null,
      rule: 'unknown',
      totalGib: null,
    };
  const total = totalMib / 1024;
  return {
    exclusiveGib: c.exclusiveGib ?? halfGib(total * DERIVED_SHARE.exclusive),
    sharedBudgetGib: c.sharedBudgetGib ?? halfGib(total * DERIVED_SHARE.shared),
    liveLimitGib: c.liveLimitGib ?? halfGib(total * DERIVED_SHARE.live),
    rule: 'derived',
    totalGib: total,
  };
}

/**
 * The GPU's total VRAM in MiB: a hw.json beside the queue (the daemon's sample; the size
 * does not age), else `nvidia` (the opt-in reader), else null.
 */
export async function readGpuTotalMib(
  dir: string,
  nvidia: (() => Promise<number | null>) | null,
): Promise<number | null> {
  try {
    const hw = JSON.parse(fs.readFileSync(path.join(dir, '..', 'hw.json'), 'utf-8')) as {
      gpu?: { vram_total_mib?: unknown };
    };
    const total = hw.gpu?.vram_total_mib;
    if (typeof total === 'number' && total > 0) return total;
  } catch {
    /* no hw.json */
  }
  return (await nvidia?.()) ?? null;
}

const gib = (n: number) => String(Math.round(n * 100) / 100);

/** The board's one line saying which rule is in force. */
export function ruleLine(p: GpuPolicy): string {
  if (p.rule === 'unknown')
    return '(문턱: GPU 크기를 몰라 한 번에 하나만 돕니다. gpu.json 에 exclusiveGib·sharedBudgetGib 를 적으면 그 값을 따릅니다)';
  const nums = `혼자 ${gib(p.exclusiveGib)} · 함께 ${gib(p.sharedBudgetGib)} · 실제 ${p.liveLimitGib === null ? '없음' : gib(p.liveLimitGib)} GiB`;
  if (p.rule === 'file') return `(문턱: gpu.json — ${nums})`;
  const pct = [DERIVED_SHARE.exclusive, DERIVED_SHARE.shared, DERIVED_SHARE.live]
    .map((x) => `${Math.round(x * 100)}%`)
    .join(' · ');
  return `(문턱: GPU 크기에서 정한 기본값 — GPU ${gib(p.totalGib!)} GiB의 ${pct}: ${nums}. 바꾸려면 gpu.json)`;
}

/** How today's policy counts a reservation: it reaches the exclusive line, or has no size to share. */
export const countsExclusive = (
  t: Pick<Ticket, 'exclusive' | 'vramGib'>,
  policy: GpuPolicy,
): boolean => t.exclusive || t.vramGib === null || t.vramGib >= policy.exclusiveGib;

/**
 * Holders whose lease was granted under a looser rule (before any threshold existed): ones the
 * policy now counts as exclusive though they were taken as shared, and, when the shared ones
 * together overrun the budget, all of them. They keep running; new requests wait behind them.
 */
export function noThresholdHolders(holders: Ticket[], policy: GpuPolicy): Set<string> {
  const out = new Set<string>();
  const shared = holders.filter((h) => !countsExclusive(h, policy));
  for (const h of holders) if (!h.exclusive && countsExclusive(h, policy)) out.add(h.id);
  if (shared.reduce((n, h) => n + (h.vramGib ?? 0), 0) > policy.sharedBudgetGib)
    for (const h of shared) out.add(h.id);
  return out;
}

export const ownGpuDir = (home = os.homedir()): string =>
  path.join(home, '.local', 'share', 'cld-gui', 'gpu');

/** The queue folder: the user's `dir` in gpu.json, else our own under ~/.local/share/cld-gui. */
export function gpuDir(home = os.homedir(), c: GpuConfig = readGpuConfig(home)): string {
  return c.dir || ownGpuDir(home);
}

// ── Locks ──────────────────────────────────────────────────────

export interface Locks {
  readonly kind: 'flock' | 'pid';
  /** The admission lock, waited for up to `waitS`; its release, or null on timeout. */
  admit(dir: string, waitS: number): (() => void) | null;
  /** Create `file` and hold it until the returned fd is closed or this process dies. */
  hold(file: string): number;
  /** The owner of `file` is alive (when unsure: alive, so nothing live is swept). */
  owned(file: string): boolean;
}

const stdio = (fd: number): ['ignore', 'ignore', 'ignore', number] => [
  'ignore',
  'ignore',
  'ignore',
  fd,
];

/** flock(1) on fd 3 of a child: the lock is on our open file description, not the child's life. */
export function flockLocks(bin: string): Locks {
  const lock = (fd: number, args: string[]) =>
    spawnSync(bin, [...args, '3'], { stdio: stdio(fd), timeout: 60_000 });
  return {
    kind: 'flock',
    admit(dir, waitS) {
      fs.mkdirSync(dir, { recursive: true });
      const fd = fs.openSync(path.join(dir, '.admit'), C.O_RDWR | C.O_CREAT, 0o644);
      if (lock(fd, ['-x', '-w', String(waitS)]).status === 0) return () => fs.closeSync(fd);
      fs.closeSync(fd);
      return null;
    },
    hold(file) {
      const fd = fs.openSync(file, C.O_RDWR | C.O_CREAT, 0o644);
      if (lock(fd, ['-x', '-n']).status !== 0) {
        fs.closeSync(fd);
        throw new Error(`cannot lock ${file}`);
      }
      return fd;
    },
    owned(file) {
      let fd: number;
      try {
        fd = fs.openSync(file, C.O_RDWR);
      } catch (err) {
        return !gone(err); // EACCES and the like: unsure, so alive
      }
      try {
        // 0: we got it, so nobody holds it; 75: held; anything else: unsure.
        return lock(fd, ['-x', '-n', '-E', '75']).status !== 0;
      } finally {
        fs.closeSync(fd);
      }
    },
  };
}

/** A pid is a live process (signal 0 delivers nothing; EPERM is someone else's live one). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Without flock (macOS, Windows): exclusive create for admission, pid liveness for owners. */
export function pidLocks(alive: (pid: number) => boolean = pidAlive, now = Date.now): Locks {
  return {
    kind: 'pid',
    admit(dir, waitS) {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, '.admit.lock');
      const end = now() + waitS * 1000;
      for (;;) {
        try {
          fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
          return () => fs.rmSync(file, { force: true });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        }
        try {
          const pid = Number(fs.readFileSync(file, 'utf-8'));
          if (!alive(pid) || now() - fs.statSync(file).mtimeMs > STALE_ADMIT_MS)
            fs.rmSync(file, { force: true });
        } catch {
          /* released meanwhile */
        }
        if (now() > end) return null;
        sleepSync(50);
      }
    },
    hold(file) {
      return fs.openSync(file, C.O_RDWR | C.O_CREAT, 0o644);
    },
    owned(file) {
      let pid: number | null;
      try {
        pid = parseTicket(fs.readFileSync(file, 'utf-8'), file).pid;
      } catch (err) {
        return !gone(err);
      }
      // No pid yet (mid-write) or a live one: kept. `gpu cancel` removes a ticket stuck so.
      return pid === null || alive(pid);
    },
  };
}

/** flock where flock(1) exists (Linux), else the pid backend. */
export function defaultLocks(envPath = process.env.PATH): Locks {
  const bin =
    process.platform === 'linux'
      ? (findOnPath('flock', envPath) ??
        ['/usr/bin/flock', '/bin/flock'].find((f) => fs.existsSync(f)) ??
        null)
      : null;
  return bin ? flockLocks(bin) : pidLocks();
}

// ── Tickets ────────────────────────────────────────────────────

export interface Ticket {
  id: string;
  project: string | null;
  pid: number | null;
  label: string | null;
  vramGib: number | null;
  exclusive: boolean;
  requested: string | null;
  started: string | null;
  jobLog: string | null;
  /** 1-based, queue only. */
  position: number | null;
  path: string;
}

/** The `key=value` lines (the last of a key wins). */
export function parseTicket(text: string, file: string): Ticket {
  const kv: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
  }
  const n = (s: string | undefined) => (s && Number.isFinite(Number(s)) ? Number(s) : null);
  const pid = n(kv.pid);
  return {
    id: kv.id ?? path.basename(file).replace(/^(q-\d+-|l-)/, ''),
    project: kv.project || null,
    pid: pid !== null && Number.isInteger(pid) ? pid : null,
    label: kv.label || null,
    vramGib: n(kv.vram),
    exclusive: kv.exclusive === '1',
    requested: kv.requested || null,
    started: kv.started || null,
    jobLog: kv.log || null,
    position: null,
    path: file,
  };
}

const oneLine = (s: string | null | undefined) => (s ?? '').replace(/[\r\n]/g, ' ');

/** In a fixed key order, so any implementation reads the other's. */
export function ticketText(t: {
  id: string;
  project: string | null;
  pid: number;
  label: string | null;
  vramGib: number | null;
  exclusive: boolean;
  requested: string;
  jobLog: string | null;
}): string {
  return [
    ['id', t.id],
    ['project', oneLine(t.project)],
    ['pid', String(t.pid)],
    ['label', oneLine(t.label)],
    ['vram', t.vramGib === null ? '' : String(t.vramGib)],
    ['exclusive', t.exclusive ? '1' : ''],
    ['requested', t.requested],
    ['log', oneLine(t.jobLog)],
  ]
    .map(([k, v]) => `${k}=${v}\n`)
    .join('');
}

const pad2 = (n: number) => String(n).padStart(2, '0');
/** `g-MMDD-HHMMSS-<project or x>` (HIF §9). */
export function gpuId(project: string | null, t = Date.now()): string {
  const d = new Date(t);
  const safe = (project ?? '').replace(/[^A-Za-z0-9가-힣._-]/g, '') || 'x';
  return `g-${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}-${safe}`;
}

export type GpuEvent = (type: string, fields: Record<string, unknown>) => void;

export type Admission = { ok: true } | { ok: false; position: number | null; gone?: boolean };

export interface GpuQueueOptions {
  dir: string;
  locks: Locks;
  event: GpuEvent;
  now?: () => number;
  /** hw.json beside the queue folder (the collector's layout): the live VRAM rule's reading. */
  hwFile?: string | null;
}

export class GpuQueue {
  readonly dir: string;
  private readonly now: () => number;

  constructor(private readonly o: GpuQueueOptions) {
    this.dir = o.dir;
    this.now = o.now ?? Date.now;
  }

  /** `fn` under the admission lock; null when it could not be had in `waitS`. */
  withAdmit<T>(fn: () => T, waitS = ADMIT_WAIT_S): T | null {
    const release = this.o.locks.admit(this.dir, waitS);
    if (!release) return null;
    try {
      return fn();
    } finally {
      release();
    }
  }

  private files(prefix: 'q-' | 'l-'): string[] {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((n) => n.startsWith(prefix))
        .sort()
        .map((n) => path.join(this.dir, n));
    } catch {
      return [];
    }
  }

  private read(file: string): Ticket | null {
    try {
      return parseTicket(fs.readFileSync(file, 'utf-8'), file);
    } catch {
      return null;
    }
  }

  /** (Under admission) remove what dead owners left; a dead lease or ticket is recorded once. */
  sweep(): void {
    for (const p of [...this.files('q-'), ...this.files('l-')]) {
      if (this.o.locks.owned(p)) continue;
      const t = this.read(p);
      try {
        fs.rmSync(p);
      } catch {
        continue;
      }
      if (!t) continue;
      if (path.basename(p).startsWith('l-'))
        this.o.event('gpu_release', { id: t.id, project: t.project, exit: null, reason: 'dead' });
      else this.o.event('gpu_cancel', { id: t.id, project: t.project, reason: 'dead' });
    }
  }

  /** Holders, and the queue in order with positions. Read only. */
  state(): { holders: Ticket[]; queue: Ticket[] } {
    const holders = this.files('l-')
      .map((p) => this.read(p))
      .filter((t): t is Ticket => !!t);
    const queue = this.files('q-')
      .map((p) => this.read(p))
      .filter((t): t is Ticket => !!t)
      .map((t, i) => ({ ...t, position: i + 1 }));
    return { holders, queue };
  }

  /** (Under admission) a new ticket at the tail, held by this process. */
  enqueue(req: {
    project: string | null;
    label: string | null;
    vramGib: number | null;
    exclusive: boolean;
    jobLog: string | null;
  }): { id: string; fd: number; file: string } {
    fs.mkdirSync(this.dir, { recursive: true });
    const seqFile = path.join(this.dir, '.seq');
    let n = 0;
    try {
      n = Number(fs.readFileSync(seqFile, 'utf-8').trim()) || 0;
    } catch {
      /* the first */
    }
    n += 1;
    fs.writeFileSync(seqFile, String(n));
    const base = gpuId(req.project, this.now());
    let id = base;
    const names = fs.readdirSync(this.dir);
    for (let k = 2; names.some((f) => f.endsWith(`-${id}`)); k++) id = `${base}-${k}`;
    const file = path.join(this.dir, `q-${String(n).padStart(8, '0')}-${id}`);
    const fd = this.o.locks.hold(file);
    fs.writeSync(fd, ticketText({ ...req, id, pid: process.pid, requested: isoLocal(this.now()) }));
    return { id, fd, file };
  }

  /** (Under admission) may `id` enter now: strict FIFO, then the policy in force. */
  admits(id: string, policy: GpuPolicy): Admission {
    const { holders, queue } = this.state();
    const me = queue.find((t) => t.id === id);
    if (!me) return { ok: false, position: null, gone: true };
    if (me.position !== 1) return { ok: false, position: me.position };
    if (!holders.length) {
      const used = policy.liveLimitGib === null ? null : this.liveVramMib();
      return used !== null && used / 1024 + (me.vramGib ?? 0) > policy.liveLimitGib!
        ? { ok: false, position: 1 }
        : { ok: true };
    }
    // Holders count by today's policy, not by the flag they were granted with (T-0094).
    if (countsExclusive(me, policy))
      return holders.length ? { ok: false, position: 1 } : { ok: true };
    const shared = holders.reduce((s, h) => s + (h.vramGib ?? 0), 0) + (me.vramGib ?? 0);
    if (holders.some((h) => countsExclusive(h, policy)) || shared > policy.sharedBudgetGib)
      return { ok: false, position: 1 };
    const used = policy.liveLimitGib === null ? null : this.liveVramMib();
    if (used !== null && used / 1024 + (me.vramGib ?? 0) > policy.liveLimitGib!)
      return { ok: false, position: 1 };
    return { ok: true };
  }

  /** (Under admission) ticket -> lease: the lease made and held, then the ticket removed. */
  lease(id: string, ticketFd: number): { fd: number; file: string } {
    const ticket = this.files('q-').find((p) => path.basename(p).endsWith(`-${id}`))!;
    const file = path.join(this.dir, `l-${id}`);
    const fd = this.o.locks.hold(file);
    fs.writeSync(fd, `${fs.readFileSync(ticket, 'utf-8')}started=${isoLocal(this.now())}\n`);
    fs.rmSync(ticket, { force: true });
    fs.closeSync(ticketFd);
    return { fd, file };
  }

  /** `gpu cancel <id>`: the ticket goes; its waiter notices and records gpu_cancel{cancel}. */
  cancel(id: string): { ok: true; id: string } | { ok: false; code: string; error: string } {
    const r = this.withAdmit(() => {
      this.sweep();
      const { holders, queue } = this.state();
      if (holders.some((h) => h.id === id)) return refuseLeased(id);
      const t = queue.find((q) => q.id === id);
      if (!t) return noTicket(id);
      fs.rmSync(t.path, { force: true });
      return { ok: true as const, id };
    });
    return r ?? busy();
  }

  /** `gpu move <id> <position>`: the queue renamed in its new order (open fds stay valid). */
  move(
    id: string,
    position: number,
  ): { ok: true; id: string; position: number } | { ok: false; code: string; error: string } {
    const r = this.withAdmit(() => {
      this.sweep();
      const { holders, queue } = this.state();
      if (holders.some((h) => h.id === id)) return refuseLeased(id);
      const t = queue.find((q) => q.id === id);
      if (!t) return noTicket(id);
      const order = queue.filter((q) => q !== t);
      order.splice(Math.max(0, Math.min(order.length, position - 1)), 0, t);
      const seqFile = path.join(this.dir, '.seq');
      const n = Number(fs.readFileSync(seqFile, 'utf-8').trim()) || 0;
      order.forEach((q, i) =>
        fs.renameSync(
          q.path,
          path.join(this.dir, `q-${String(n + i + 1).padStart(8, '0')}-${q.id}`),
        ),
      );
      fs.writeFileSync(seqFile, String(n + order.length));
      const pos = order.indexOf(t) + 1;
      this.o.event('gpu_move', { id, project: t.project, position: pos });
      return { ok: true as const, id, position: pos };
    });
    return r ?? busy();
  }

  // The live rule reads a hw.json beside the queue: the daemon's own sample
  // (writeCollectorGpuHw) while a reservation waits or runs.
  private liveVramMib(): number | null {
    const file = this.o.hwFile === undefined ? path.join(this.dir, '..', 'hw.json') : this.o.hwFile;
    if (!file) return null;
    try {
      const hw = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
        ts?: string;
        gpu?: { vram_used_mib?: unknown };
      };
      const ts = Date.parse(hw.ts ?? '');
      const used = hw.gpu?.vram_used_mib;
      return ts <= this.now() && this.now() - ts < HW_FRESH_MS && typeof used === 'number'
        ? used
        : null;
    } catch {
      return null;
    }
  }
}

/** A worker can read this file even though the collector runs in the daemon. */
export function writeCollectorGpuHw(
  queue: Pick<GpuQueue, 'dir' | 'state'>,
  sample: {
    ts?: string | null;
    vramUsedMib?: number | null;
    vramTotalMib?: number | null;
    gpuProcesses?: GpuProc[] | null;
  },
  now = Date.now(),
): boolean {
  const { queue: waiting } = queue.state();
  if (!waiting.length) return false;
  if (typeof sample.vramUsedMib !== 'number' || typeof sample.vramTotalMib !== 'number')
    return false;
  const file = path.join(queue.dir, '..', 'hw.json');
  try {
    const old = JSON.parse(fs.readFileSync(file, 'utf-8')) as { ts?: string; collector?: string };
    const age = now - Date.parse(old.ts ?? '');
    if (old.collector !== 'cld-gui' && age >= 0 && age < HW_FRESH_MS) return false;
  } catch {
    /* no file yet */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({
      v: 1,
      ts: sample.ts,
      collector: 'cld-gui',
      gpu: {
        vram_used_mib: sample.vramUsedMib,
        vram_total_mib: sample.vramTotalMib,
        procs:
          sample.gpuProcesses?.map((p) => ({ pid: p.pid, cmd: p.cmd, used_mib: p.usedMib })) ??
          null,
      },
    }),
  );
  fs.renameSync(tmp, file);
  return true;
}

/** A process using the GPU; `usedMib` is null when the source (WSL's /dev/dxg) cannot tell. */
export interface GpuProc {
  pid: number;
  usedMib: number | null;
  cmd?: string;
}

/** A current GPU process list beside the queue; null means the collector cannot know it. */
export function gpuProcessesFromFile(dir: string, now = Date.now()): GpuProc[] | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, '..', 'hw.json'), 'utf-8')) as {
      ts?: string;
      gpu?: { procs?: Array<{ pid?: unknown; used_mib?: unknown; cmd?: unknown }> | null };
    };
    const age = now - Date.parse(j.ts ?? '');
    if (age < 0 || age >= HW_FRESH_MS || !Array.isArray(j.gpu?.procs)) return null;
    return j.gpu.procs
      .filter((p) => Number.isInteger(p.pid) && Number(p.pid) > 0)
      .map((p) => ({
        pid: Number(p.pid),
        usedMib: typeof p.used_mib === 'number' ? p.used_mib : null,
        ...(typeof p.cmd === 'string' && { cmd: p.cmd }),
      }));
  } catch {
    return null;
  }
}

/** WSL: processes that opened /dev/dxg (the GPU device), as a /proc scan finds them; no driver
 *  call. The name is `comm` only, so no secret in a command line shows. */
export function readDxgUsers(proc = '/proc'): Array<GpuProc & { cmd: string; cwd: string }> {
  const out: Array<GpuProc & { cmd: string; cwd: string }> = [];
  let pids: string[];
  try {
    pids = fs.readdirSync(proc).filter((d) => /^\d+$/.test(d));
  } catch {
    return [];
  }
  for (const d of pids) {
    try {
      const fds = fs.readdirSync(path.join(proc, d, 'fd'));
      if (!fds.some((f) => fs.readlinkSync(path.join(proc, d, 'fd', f)) === '/dev/dxg')) continue;
      const cmd = fs.readFileSync(path.join(proc, d, 'comm'), 'utf-8').trim();
      const cwd = fs.readlinkSync(path.join(proc, d, 'cwd'));
      if (cmd !== 'nvidia-smi') out.push({ pid: Number(d), usedMib: null, cmd, cwd });
    } catch {
      /* not ours to read, or gone */
    }
  }
  return out;
}

/** Child GPU processes inherit a wrapper's reservation. */
export function unleasedFromProcesses<T extends { pid: number }>(
  processes: T[],
  holders: Set<number>,
  proc = '/proc',
): T[] {
  const parent = new Map<number, number>();
  try {
    for (const name of fs.readdirSync(proc).filter((x) => /^\d+$/.test(x))) {
      try {
        const stat = fs.readFileSync(path.join(proc, name, 'stat'), 'utf-8');
        parent.set(Number(name), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
      } catch {
        /* exited */
      }
    }
  } catch {
    /* no /proc */
  }
  return processes.filter(({ pid }) => {
    for (let p = pid, n = 0; p > 0 && n < 64; n++, p = parent.get(p) ?? 0)
      if (holders.has(p)) return false;
    return true;
  });
}

const refuseLeased = (id: string) => ({
  ok: false as const,
  code: 'leased',
  error: `${id} 은 이미 예약을 잡고 돈다. 멈추려면 ${CLI_NAME} stop <pid>`,
});
const noTicket = (id: string) => ({
  ok: false as const,
  code: 'no_ticket',
  error: `대기 줄에 ${id} 이 없다`,
});
const busy = () => ({
  ok: false as const,
  code: 'gpu_busy',
  error: 'GPU 대기 폴더의 입장 잠금을 잡지 못했다(10초)',
});

/** The board as `cld-gui gpu --json` prints it (HIF §9's shape; the numbers are the user's). */
export function boardJson(
  dir: string,
  policy: GpuPolicy,
  s: { holders: Ticket[]; queue: Ticket[] },
  unleased: Array<Record<string, unknown>> = [],
) {
  const late = noThresholdHolders(s.holders, policy);
  const row = (t: Ticket) => ({
    id: t.id,
    project: t.project,
    pid: t.pid,
    label: t.label,
    vram_gib: t.vramGib,
    exclusive: t.exclusive,
    requested: t.requested,
    started: t.started,
    job_log: t.jobLog,
    ...(t.position !== null && { position: t.position }),
    ...(late.has(t.id) && { no_threshold: true }),
  });
  const known = policy.rule !== 'unknown';
  return {
    v: 1,
    dir,
    rule: policy.rule,
    exclusive_gib: known ? policy.exclusiveGib : null,
    shared_budget_gib: known ? policy.sharedBudgetGib : null,
    live_limit_gib: policy.liveLimitGib,
    holders: s.holders.map(row),
    queue: s.queue.map(row),
    unleased,
  };
}

/** Linux: processes that opened /dev/dxg (WSL's GPU) with no lease holder among their ancestors. */
export function unleasedGpuUsers(
  holderPids: Set<number>,
  projectAt: (cwd: string) => string | null,
  proc = '/proc',
): Array<{ pid: number; cmd: string; cwd: string; project: string | null }> {
  return unleasedFromProcesses(readDxgUsers(proc), holderPids, proc).map(({ pid, cmd, cwd }) => ({
    pid,
    cmd,
    cwd,
    project: projectAt(cwd),
  }));
}

// ── The wrapper (`job --gpu`, `gpu run`) ───────────────────────

export interface GpuRunOptions {
  queue: GpuQueue;
  policy: GpuPolicy;
  cmd: string;
  vramGib: number | null;
  exclusive: boolean;
  label: string | null;
  project: string | null;
  /** Minutes; null waits for ever (`job --gpu`). */
  waitMin: number | null;
  jobLog: string | null;
  /** The job's `<id>.gpu` file: the lease id once held (cld-gui jobs' gpu_id). */
  gpuFile: string | null;
  event: GpuEvent;
  print?: (line: string) => void;
  /** Runs the command; tests replace it. */
  spawnCmd?: (cmd: string) => ChildProcess;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Signal hooks (tests drive them; default: process.on). */
  onSignal?: (fn: (sig: NodeJS.Signals) => void) => void;
  exit?: (code: number) => void;
}

export function shellSpawn(cmd: string): ChildProcess {
  return process.platform === 'win32'
    ? spawn(windowsCmd(), ['/d', '/s', '/c', `"${cmd}"`], {
        stdio: 'inherit',
        windowsVerbatimArguments: true,
        windowsHide: true,
      })
    : spawn('bash', ['-c', cmd], { stdio: 'inherit' });
}

const SIGNUM: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

/**
 * Wait for the turn, lease, run, release . Returns the
 * command's exit code; 3 = --wait passed, 4 = cancelled, 1 = no admission lock.
 */
export async function gpuRun(o: GpuRunOptions): Promise<number> {
  const print = o.print ?? ((l: string) => console.log(l));
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const exclusive = o.exclusive || o.vramGib === null || o.vramGib >= o.policy.exclusiveGib;
  const base = {
    project: o.project,
    vram_gib: o.vramGib,
    exclusive,
  };
  const t = o.queue.withAdmit(() =>
    o.queue.enqueue({
      project: o.project,
      label: o.label,
      vramGib: o.vramGib,
      exclusive,
      jobLog: o.jobLog,
    }),
  );
  if (!t) {
    print('[cld-gui gpu] GPU 대기 폴더의 입장 잠금을 잡지 못했다');
    return 1;
  }
  const { id } = t;
  o.event('gpu_queue', { id, ...base, label: o.label });
  let ticketFd: number | null = t.fd;
  let lease: { fd: number; file: string } | null = null;
  let child: ChildProcess | null = null;
  /** Our ticket gone (found by id under admission: a move renames it) and its lock let go. */
  const dropTicket = () => {
    if (ticketFd === null) return;
    const rm = () => {
      for (const f of fs.readdirSync(o.queue.dir))
        if (f.startsWith('q-') && f.endsWith(`-${id}`))
          fs.rmSync(path.join(o.queue.dir, f), { force: true });
    };
    if (o.queue.withAdmit(rm) === null) rm();
    fs.closeSync(ticketFd);
    ticketFd = null;
  };
  // A signal while queued: the ticket goes and gpu_cancel{stop} is written ;
  // while leased: the command gets it too, and its end releases the lease.
  (o.onSignal ?? ((fn) => ['SIGTERM', 'SIGINT', 'SIGHUP'].forEach((s) => process.on(s, fn))))(
    (sig) => {
      if (lease) {
        child?.kill(sig);
        return;
      }
      if (ticketFd !== null) {
        dropTicket();
        o.event('gpu_cancel', { id, project: o.project, reason: 'stop' });
      }
      (o.exit ?? process.exit)(128 + (SIGNUM[sig] ?? 15));
    },
  );
  const t0 = now();
  let last: number | null = null;
  for (;;) {
    const r = o.queue.withAdmit(() => {
      o.queue.sweep();
      const a = o.queue.admits(id, o.policy);
      if (a.ok) lease = o.queue.lease(id, ticketFd!);
      return a;
    });
    if (ticketFd === null && !lease) return 143; // stopped while we slept
    if (r?.ok) {
      ticketFd = null;
      break;
    }
    if (r && !r.ok && r.gone) {
      fs.closeSync(ticketFd!);
      ticketFd = null;
      o.event('gpu_cancel', { id, project: o.project, reason: 'cancel' });
      print(`[cld-gui gpu] ${id} 대기가 취소됐다`);
      return 4;
    }
    const pos = r && !r.ok ? r.position : null;
    if (pos !== null && pos !== last) {
      print(`[cld-gui gpu] GPU 차례 기다리는 중(${pos}번째) · 예약판: ${CLI_NAME} gpu`);
      last = pos;
    }
    if (o.waitMin !== null && now() - t0 > o.waitMin * 60_000) {
      dropTicket();
      o.event('gpu_cancel', { id, project: o.project, reason: 'wait' });
      print(`[cld-gui gpu] ${o.waitMin}분 안에 차례가 오지 않았다`);
      return 3;
    }
    await sleep(GPU_POLL_MS);
  }
  const held = lease as unknown as { fd: number; file: string };
  o.event('gpu_lease', { id, ...base, waited_s: Math.round((now() - t0) / 1000) });
  if (o.gpuFile) {
    try {
      fs.writeFileSync(o.gpuFile, `${id}\n`);
    } catch {
      /* the jobs list shows queued; the lease still holds */
    }
  }
  print(`[cld-gui gpu] 예약 ${id} (${exclusive ? '혼자' : `함께 ${o.vramGib}GiB`}) · 시작`);
  let rc: number;
  try {
    child = (o.spawnCmd ?? shellSpawn)(o.cmd);
    rc = await new Promise<number>((resolve) => {
      child!.on('error', () => resolve(127));
      child!.on('exit', (code, sig) => resolve(code ?? 128 + (sig ? (SIGNUM[sig] ?? 15) : 0)));
    });
  } finally {
    fs.rmSync(held.file, { force: true });
    fs.closeSync(held.fd);
  }
  o.event('gpu_release', { id, project: o.project, exit: rc });
  return rc;
}
