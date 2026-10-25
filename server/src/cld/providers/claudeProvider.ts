/**
 * Default provider: needs only Claude Code. The live sessions come from
 * ~/.claude/sessions/<pid>.json, which Claude Code writes per process (no
 * process per refresh, T-0013); `claude agents --json` (no TTY, ~0.2 s, but
 * ~180 MB at its peak) only fills what the files lack. Each session becomes
 * one character, driven by its transcript under ~/.claude/projects. Rooms
 * group sessions by project directory. Labels are the session name (`-n` /
 * customTitle) or else the project folder's basename.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { OfficeRoom } from '../../../../core/src/messages.js';
import { normalizeProjectPath } from '../../../../core/src/normalizeProjectPath.js';
import type { SpawnFn } from '../spawnJson.js';
import { spawnJson } from '../spawnJson.js';
import type { AgentEntry } from './types.js';
import { ENTRY_DEFAULTS } from './types.js';

export const CLAUDE_TIMEOUT_MS = 10_000;
/** `claude agents --json` as the fallback: at most this often. */
export const AGENTS_FALLBACK_MS = 30_000;

/** One row of `claude agents --json` (Claude Code 2.1.306), or of a sessions
 *  file mapped to it. Unknown fields ignored. */
export interface ClaudeSession {
  id?: string;
  pid?: number;
  cwd: string;
  kind: string;
  startedAt?: number;
  sessionId: string;
  name?: string;
  /** interactive: busy | idle (files also: waiting | shell) */
  status?: string;
  /** background: working | blocked | done. `done` = turn finished, still alive
   *  (a stopped session is not listed at all; T-0014 spike). A background row
   *  without `pid` is a session killed by a reboot. */
  state?: string;
  /** The process start time (`/proc/<pid>/stat` field 22), when Claude gives it. */
  procStart?: string | number;
  /** What a `blocked` background session waits for (`permission prompt` while a permission
   *  dialog is up, seen with Claude Code 2.1.31x; PERM-PROMPT). */
  waitingFor?: string;
}

/** PERM-PROMPT: the row says a permission dialog holds the session. */
export const waitsForPermission = (s: Pick<ClaudeSession, 'waitingFor'> | undefined): boolean =>
  typeof s?.waitingFor === 'string' && /permission/i.test(s.waitingFor);

/** `which`: first executable `cmd` on PATH, as an absolute path. On Windows a
 *  name without an extension is tried with each PATHEXT one (claude.exe, then
 *  npm's claude.cmd), never bare: npm puts a sh script named `claude` beside them. */
export function findOnPath(
  cmd: string,
  envPath = process.env.PATH ?? '',
  platform: NodeJS.Platform = process.platform,
  pathExt = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
): string | null {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const names =
    platform === 'win32' && !p.extname(cmd)
      ? pathExt.split(';').filter(Boolean).map((e) => cmd + e.toLowerCase())
      : [cmd];
  for (const dir of envPath.split(p.delimiter)) {
    if (!dir || !p.isAbsolute(dir)) continue;
    for (const name of names) {
      const file = p.join(dir, name);
      try {
        fs.accessSync(file, fs.constants.X_OK);
        if (fs.statSync(file).isFile()) return file;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

export function parseAgents(json: unknown): ClaudeSession[] {
  if (!Array.isArray(json)) throw new Error('claude agents --json: not an array');
  return json.filter(
    (s): s is ClaudeSession =>
      typeof s === 'object' &&
      s !== null &&
      typeof (s as ClaudeSession).cwd === 'string' &&
      typeof (s as ClaudeSession).sessionId === 'string',
  );
}

/** ~/.claude/projects/<encoded cwd>/<sessionId>.jsonl, or a search of the
 *  other project dirs when Claude encoded the cwd differently. */
export function transcriptPath(cwd: string, sessionId: string, home = os.homedir()): string {
  const root = path.join(home, '.claude', 'projects');
  const direct = path.join(root, normalizeProjectPath(cwd), `${sessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  try {
    for (const d of fs.readdirSync(root)) {
      const p = path.join(root, d, `${sessionId}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  } catch {
    /* no projects dir yet */
  }
  return direct;
}

/** Room label per cwd: its basename, widened with the parent when two cwds collide. */
function roomLabels(cwds: string[]): Map<string, string> {
  const byBase = new Map<string, Set<string>>();
  for (const c of cwds) {
    const b = path.basename(c) || c;
    if (!byBase.has(b)) byBase.set(b, new Set());
    byBase.get(b)!.add(c);
  }
  const out = new Map<string, string>();
  for (const [b, set] of byBase) {
    for (const c of set) {
      out.set(c, set.size > 1 ? `${path.basename(path.dirname(c))}/${b}` : b);
    }
  }
  return out;
}

export function entriesFromSessions(
  sessions: ClaudeSession[],
  transcriptOf: (cwd: string, sessionId: string) => string = transcriptPath,
): { rooms: OfficeRoom[]; agents: AgentEntry[] } {
  const sorted = [...sessions].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const labels = roomLabels(sorted.map((s) => s.cwd));
  const roomNames = [...new Set(labels.values())].sort((a, b) => a.localeCompare(b));
  const rooms: OfficeRoom[] = roomNames.map((name, i) => ({ name, kind: 'orch', order: i + 1 }));
  const seenKeys = new Set<string>();
  const perRoom = new Map<string, number>();
  const agents: AgentEntry[] = sorted.map((s) => {
    const room = labels.get(s.cwd)!;
    let key = s.name ? `name:${s.name}` : `sid:${s.sessionId}`;
    if (seenKeys.has(key)) key = `${key}#${s.sessionId.slice(0, 8)}`;
    seenKeys.add(key);
    const order = (perRoom.get(room) ?? 0) + 1;
    perRoom.set(room, order);
    const background = s.kind === 'background';
    const statusBusy = s.status === 'busy' ? true : turnEnded(s.status) ? false : null;
    return {
      ...ENTRY_DEFAULTS,
      key,
      name: s.name || path.basename(s.cwd) || s.cwd,
      dir: s.cwd,
      tab: room,
      order,
      state: 'running',
      // A background job's state when `claude agents --json` gave one, else its file's status.
      busy: background && s.state ? s.state === 'working' : statusBusy,
      pid: typeof s.pid === 'number' ? s.pid : null,
      sessionId: s.sessionId,
      bg: background
        ? {
            id: s.id ?? s.sessionId.slice(0, 8),
            state: s.state ?? 'unknown',
            sessionId: s.sessionId,
            started: s.startedAt ? new Date(s.startedAt).toISOString() : null,
          }
        : null,
      remoteControl: { on: false, url: null },
      transcript: transcriptOf(s.cwd, s.sessionId),
    };
  });
  return { rooms, agents };
}

/** Runs `claude agents --json` by absolute path; one call at a time. */
export class ClaudeAgentsSource {
  private inFlight: Promise<ClaudeSession[]> | null = null;

  constructor(
    readonly claudePath: string,
    private readonly spawnFn?: SpawnFn,
    private readonly timeoutMs = CLAUDE_TIMEOUT_MS,
  ) {}

  list(): Promise<ClaudeSession[]> {
    this.inFlight ??= spawnJson(this.claudePath, ['agents', '--json'], {
      timeoutMs: this.timeoutMs,
      spawnFn: this.spawnFn,
    })
      .then(parseAgents)
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}

/** The process is running and is the one that wrote the file: on Linux
 *  /proc/<pid>/stat field 22 (its start time) must equal `procStart`, which
 *  rules out a reused pid; elsewhere, or without `procStart`, the pid alone. */
export function processAlive(pid: number, procStart?: string): boolean {
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
      return (
        procStart === undefined ||
        stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === procStart
      );
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The session file's status says the main turn is over: `idle`, or `shell` (Claude Code writes
 *  that for an ended turn while a run_in_background shell is still alive; RENEW-STUCK). */
export const turnEnded = (status: string | undefined): boolean =>
  status === 'idle' || status === 'shell';

const FILE_KINDS: Record<string, string> = { interactive: 'interactive', bg: 'background' };

/**
 * One ~/.claude/sessions/<pid>.json (Claude Code 2.1.306) as a session row.
 * null: its process is gone, or it is a spare background worker (started
 * ahead, no conversation yet). 'unknown': alive, but not a shape this build
 * reads. `filePid` (from the file name) stands in when `pid` is unreadable.
 */
export function sessionFromFile(
  json: unknown,
  filePid: number,
  alive: (pid: number, procStart?: string) => boolean = processAlive,
): ClaudeSession | 'unknown' | null {
  const f = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const pid = Number.isInteger(f.pid) && (f.pid as number) > 0 ? (f.pid as number) : filePid;
  const procStart = typeof f.procStart === 'string' ? f.procStart : undefined;
  if (!(pid > 0) || !alive(pid, procStart)) return null;
  const kind = FILE_KINDS[f.kind as string];
  if (
    pid !== f.pid ||
    typeof f.sessionId !== 'string' ||
    typeof f.cwd !== 'string' ||
    !kind ||
    (process.platform === 'linux' && procStart === undefined)
  )
    return 'unknown';
  if (f.spare === true) return null;
  return {
    pid,
    cwd: f.cwd,
    kind,
    sessionId: f.sessionId,
    startedAt: typeof f.startedAt === 'number' ? f.startedAt : undefined,
    name: typeof f.name === 'string' && f.name ? f.name : undefined,
    // A conversation parked in a background job leaves this file frozen (HIF §1).
    status: typeof f.status === 'string' && !f.parkedJobId ? f.status : undefined,
    id: typeof f.jobId === 'string' ? f.jobId : undefined,
  };
}

/**
 * The live sessions from ~/.claude/sessions. `claude agents --json` runs only
 * when `spawn` (someone is viewing), at most every 30 s, and only for what the
 * files lack: a background job's state or a missing name. When a live file has
 * a shape this build does not read, its answer replaces the files.
 */
export class ClaudeSessions {
  /** Last good parse per file: Claude Code rewrites them in place, so a read can land mid-write. */
  private readonly parsed = new Map<string, unknown>();
  private agents: ClaudeSession[] = [];
  private agentsAt: number | null = null;
  private warnedUnknown = false;
  private lastError = '';

  constructor(
    readonly dir: string,
    private readonly fallback: Pick<ClaudeAgentsSource, 'list'> | null,
    private readonly alive = processAlive,
  ) {}

  async list(spawn: boolean): Promise<ClaudeSession[]> {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    } catch {
      // No sessions yet.
    }
    for (const n of [...this.parsed.keys()]) if (!names.includes(n)) this.parsed.delete(n);
    const rows: ClaudeSession[] = [];
    let unknown = false;
    for (const n of names) {
      try {
        this.parsed.set(n, JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf-8')));
      } catch {
        // Mid-write or just removed: the last good read, if any.
      }
      if (!this.parsed.has(n)) continue;
      const row = sessionFromFile(this.parsed.get(n), Number.parseInt(n, 10), this.alive);
      if (row === 'unknown') unknown = true;
      else if (row) rows.push(row);
    }
    if (unknown && !this.warnedUnknown) {
      console.warn(
        `[cld] ${this.dir}: a live session file in a format this build does not read; using claude agents --json (at most every 30 s while viewing)`,
      );
      this.warnedUnknown = true;
    }
    const lacking = unknown || rows.some((r) => r.kind === 'background' || !r.name);
    if (
      lacking &&
      spawn &&
      this.fallback &&
      (this.agentsAt === null || Date.now() - this.agentsAt >= AGENTS_FALLBACK_MS)
    ) {
      this.agentsAt = Date.now();
      try {
        this.agents = await this.fallback.list();
        this.lastError = '';
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg !== this.lastError) console.warn(`[cld] ${msg}`);
        this.lastError = msg;
      }
    }
    if (unknown && this.agents.length) return this.agents;
    return rows.map((r) => {
      const a = this.agents.find((x) => x.sessionId === r.sessionId || (!!r.id && x.id === r.id));
      return a ? { ...r, name: r.name ?? a.name, state: a.state, id: r.id ?? a.id } : r;
    });
  }
}
