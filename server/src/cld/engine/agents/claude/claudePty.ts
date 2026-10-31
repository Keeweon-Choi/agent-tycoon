/**
 * TERM-P1 (ADR-0018): Claude Code run directly in our own PTY host, provider `claude-pty`
 * (protocol `pty`). No `--bg`, `claude attach`, `claude agents` or `claude stop`: the host
 * (ptyhost/) holds the PTY, so the session outlives our daemon's restart, and its sessions count
 * as the engine's held ones (kind 'background': a holder the engine drives, not a person's
 * terminal), so the engine's lifecycle stays as it is.
 *
 * Liveness from files, nothing spawned: the host's terminals.json (terminal id, pid, the
 * assignment) joined by pid to Claude's own ~/.claude/sessions/<pid>.json. Status: the session
 * file first, OSC 7501 from the host where it says more (blocked). Every start is a full one:
 * an interactive `--resume <id>` with flags keeps the id (P0 a), so revive, wake and a new host
 * are all `claude -n <name> --resume <id> [flags]`. The environment is the engine's clean one
 * without CLAUDE* and AI_AGENT (with them Claude wrote no session file and no transcript, P0),
 * plus CLD_BIN, PATH and CLD_AGENT_TOKEN as real variables. The permission mode is always given
 * (else the account's default applies, P0).
 *
 * Messages (deliver): a bracketed paste, then Enter as its own write once the paste had time to
 * land, only when the session is ready (session file idle, or OSC idle/done); a `now` message
 * into a running turn goes with Claude's chat:sendNow chord instead of Enter. Nothing is read
 * off the screen: the turn starting (OSC working, session busy) or the transcript holding the
 * message confirms it.
 *
 * Any install of Claude (TERM-P2): the terminal's pid is Claude's own for the native binary and a
 * launcher that execs (npm's Unix symlink, nvm/asdf/mise, Homebrew), but not for one that starts
 * Claude as its child (npm's Windows .cmd, bun, volta, scoop). So every start names its
 * conversation (`--session-id` we choose, or `--resume <id>`) in the terminal's meta, and a
 * terminal without `<pid>.json` is joined to the live session file with that id; the pid found
 * stays joined (claude-pids.json beside the host's list), so a /clear later does not lose it.
 *
 * TERM-P3: every new Claude agent runs here, and its permission prompts reach the owner through
 * Claude Code's PermissionRequest hook in `--settings` (permissionHooks), never off its screen.
 *
 * TERM-P2, Windows and macOS: the host listens on a named pipe on Windows (protocol.ts). Windows
 * runs the daemon under a Task Scheduler task, and ending the task (an update, a restart from
 * the manager) may end the host and its agents with it: accepted, the engine starts them again
 * with `--resume`, and the first daemon to see their terminals gone logs it once.
 */
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { koText, refused } from '../../../../../../core/src/cld/serverText.js';
import {
  PTY_CLOSE_WAIT_MS,
  PTY_PASTE_BYTES_PER_MS,
  PTY_PASTE_BYTES_PER_MS_WINDOWS,
  PTY_PASTE_ENTER_MS,
  PTY_PERMISSION_HOOK_S,
  PTY_SUBMIT_MS,
} from '../../../../constants.js';
import { readJson, writeJsonAtomic } from '../../../jsonFile.js';
import { processAlive, sessionFromFile, transcriptPath, turnEnded } from '../../../providers/claudeProvider.js';
import { PtyHostClient } from '../../../ptyhost/client.js';
import { readyToType } from '../../../ptyhost/programStatus.js';
import type { TerminalInfo } from '../../../ptyhost/protocol.js';
import { ptyhostPaths } from '../../../ptyhost/protocol.js';
import { rulesDirFor, writeCombinedRules } from '../../agentRules.js';
import { AGENT_TOKEN_ENV } from '../../agentTokens.js';
import { alreadyTyped, cleanText, tail } from '../../messenger.js';
import type { ProjectRecord } from '../../registry.js';
import { CLAUDE_PTY_PROVIDER } from '../../registry.js';
import type { AgentProvider, LiveSession, StartResult, StopResult } from '../types.js';
import {
  CLAUDE_CAPABILITIES,
  claudeCommand,
  COMPACT_MARK,
  nameMatches,
  sessionFlags,
  transcriptFillPct,
  TRUST_NEEDED,
  writeMcpConfig,
} from './claude.js';
import { sessionsDir } from './sessions.js';

export { CLAUDE_PTY_PROVIDER };

/** Claude Code's chat:sendNow (ctrl+x ctrl+s), as two key presses (chat.ts SEND_NOW). */
const SEND_NOW = ['\x18', '\x13'] as const;
const SEND_NOW_GAP_MS = 40;

export const PTY_TIMING = {
  enterMs: PTY_PASTE_ENTER_MS,
  bytesPerMs: PTY_PASTE_BYTES_PER_MS,
  submitMs: PTY_SUBMIT_MS,
  pollMs: 100,
  closeMs: PTY_CLOSE_WAIT_MS,
};

/** Variables that belong to the Claude session that started us, never to an agent's (P0). */
const SESSION_VAR = /^(CLAUDE|AI_AGENT)/i;

/** The agent's environment: `base` without session variables, with our own on top. */
export function ptyEnv(base: NodeJS.ProcessEnv, own: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !SESSION_VAR.test(k)) env[k] = v;
  return { ...env, ...own };
}

/**
 * TERM-P3: the session's PermissionRequest hook, the CLI beside `cldBin` on our Node (as the status
 * line): it asks the daemon over the control socket with the session's own CLD_AGENT_TOKEN and
 * prints the owner's 허용/거부 as the hook's decision, or nothing (Claude then shows its dialog).
 * Given in `--settings` only: no settings file is written (P0 b: it fires for this session only).
 */
export const permissionHooks = (cldBin: string, node = process.execPath) => ({
  PermissionRequest: [
    {
      matcher: '*',
      hooks: [
        {
          type: 'command',
          command: `"${node}" "${path.join(path.dirname(cldBin), 'cld-gui')}" permission-hook`,
          timeout: PTY_PERMISSION_HOOK_S,
        },
      ],
    },
  ],
});

/** `claude` argv in our PTY: the session flags, the permission mode always ('default' unset). */
export function ptyArgs(
  p: ProjectRecord,
  resume: string | undefined,
  cldBin: string | null,
  mcpConfigFile: string | null,
): string[] {
  const extra = cldBin ? { hooks: permissionHooks(cldBin) } : {};
  return sessionFlags(p, resume, cldBin, mcpConfigFile, extra, p.permissionMode || 'default');
}

/**
 * Claude's own folder trust for `folder` or one above it (trust is inherited, P0 e), read only
 * from ~/.claude.json; null when that file cannot be read (then the start goes ahead and a
 * dialog, if any, waits in the terminal for a person).
 */
export function folderTrusted(home: string, folder: string): boolean | null {
  let projects: unknown;
  try {
    projects = (JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf-8')) as { projects?: unknown })
      .projects;
  } catch {
    return null;
  }
  if (!projects || typeof projects !== 'object') return null;
  const all = projects as Record<string, { hasTrustDialogAccepted?: unknown } | undefined>;
  for (let d = path.resolve(folder); ; d = path.dirname(d)) {
    if (all[d]?.hasTrustDialogAccepted === true) return true;
    if (path.dirname(d) === d) return false;
  }
}

const assignmentOf = (p: ProjectRecord): string | undefined => (p.role ? p.assignmentId : p.leadAssignmentId);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ClaudePtyOptions {
  claudePath: string;
  home: string;
  /** The engine's clean environment (cleanEnv, sessionPath applied). */
  env: NodeJS.ProcessEnv;
  systemdRun: string | null;
  cldBin: string | null;
  /** dist/cld-ptyhost.js, or null when this build has none. */
  hostScript: string | null;
  log: (line: string) => void;
  /** Tests: a client of their own. */
  client?: PtyHostClient;
  timing?: Partial<typeof PTY_TIMING>;
  platform?: NodeJS.Platform;
}

export class ClaudePtyAgent implements AgentProvider {
  readonly id = CLAUDE_PTY_PROVIDER;
  readonly protocol = 'pty' as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  readonly compaction = { mark: COMPACT_MARK, fillPct: transcriptFillPct };
  readonly host: PtyHostClient;
  private scope: string | null;
  private readonly t: typeof PTY_TIMING;
  private readonly platform: NodeJS.Platform;
  /** The dead terminals last logged (a host that ended without writing their exit). */
  private loggedGone = '';
  /** Terminal id -> Claude's own pid, for a launcher that starts Claude as its child. */
  private found: Record<string, number> | null = null;

  constructor(private readonly o: ClaudePtyOptions) {
    this.scope = o.systemdRun;
    this.platform = o.platform ?? process.platform;
    // Orca's measured paste ingest: ConPTY takes a paste in far slower than a Unix PTY.
    const bytesPerMs = this.platform === 'win32' ? PTY_PASTE_BYTES_PER_MS_WINDOWS : PTY_PASTE_BYTES_PER_MS;
    this.t = { ...PTY_TIMING, bytesPerMs, ...o.timing };
    this.host = o.client ?? new PtyHostClient({ home: o.home, launch: () => this.launch(), log: o.log });
  }

  /** Start the host outside our service's cgroup (its own systemd user scope, else setsid), as
   *  claude.ts runs `claude --bg`: a redeploy of the daemon must not take the agents with it. */
  private launch(retry = true): void {
    const dir = ptyhostPaths(this.o.home).dir;
    const cmd = claudeCommand(process.execPath, ['--max-semi-space-size=1', this.o.hostScript ?? '', dir], this.scope);
    try {
      const child = spawn(cmd.file, cmd.args, {
        cwd: dir,
        env: this.o.env,
        stdio: 'ignore',
        detached: true,
        windowsHide: true, // detached on Windows would open a console window
      });
      child.on('error', (err) => this.o.log(`PTY host: ${err.message}`));
      child.on('exit', (code) => {
        if (code === 0 || !this.scope || !retry) return;
        // A host that left because one already listens exits 0; systemd-run failing does not.
        this.o.log(`PTY host in a systemd scope exited ${code}; starting it with setsid from now on`);
        this.scope = null;
        this.launch(false);
      });
      child.unref();
    } catch (err) {
      this.o.log(`PTY host: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The host's terminals whose process is alive (terminals.json; a killed host leaves dead ones). */
  terminals(): TerminalInfo[] {
    let list: unknown;
    try {
      list = readJson(ptyhostPaths(this.o.home).terminals);
    } catch {
      return [];
    }
    if (!Array.isArray(list)) return [];
    const valid = (list as TerminalInfo[]).filter(
      (t) => t && typeof t.id === 'string' && Number.isInteger(t.pid) && t.pid > 0,
    );
    const out = valid.filter((t) => processAlive(t.pid));
    this.noteGone(valid.filter((t) => !out.includes(t)));
    // Status (OSC 7501) lives in the host: connect once there is a terminal to hear about.
    if (out.length && !this.host.connected) void this.host.connect(false).catch(() => undefined);
    return out;
  }

  /**
   * Terminals the list still names whose process is gone, with no host connected: the host
   * ended without writing their exit (killed, or on Windows ended with the daemon's task). Logged
   * once per set; the engine starts those agents again with `--resume`.
   */
  private noteGone(gone: TerminalInfo[]): void {
    const key = gone.map((t) => t.id).sort().join(',');
    if (!gone.length || this.host.connected || key === this.loggedGone) return;
    this.loggedGone = key;
    const why =
      this.platform === 'win32'
        ? ' (Windows ends it with the daemon\'s Task Scheduler task)'
        : '';
    this.o.log(
      `PTY host ended with ${gone.length} agent terminal(s)${why}; they start again with --resume`,
    );
  }

  /** Pids our host holds, Claude's own included: the Claude provider leaves them out (one conversation, one holder). */
  pids(): Set<number> {
    return new Set(this.terminals().flatMap((t) => [t.pid, this.session(t)?.pid ?? t.pid]));
  }

  /** A terminal of the host (the chat route joins it instead of `claude attach`). */
  has(id: string): boolean {
    return this.terminals().some((t) => t.id === id);
  }

  private sessionAt(pid: number) {
    try {
      const row = sessionFromFile(
        JSON.parse(fs.readFileSync(path.join(sessionsDir(this.o.home), `${pid}.json`), 'utf-8')),
        pid,
      );
      return row && row !== 'unknown' ? row : null;
    } catch {
      return null;
    }
  }

  private get foundFile(): string {
    return path.join(ptyhostPaths(this.o.home).dir, 'claude-pids.json');
  }

  /**
   * Claude's session in terminal `t`: its pid's own file, else (a launcher that starts Claude as
   * its child) the pid joined before, else the live file holding the conversation it was started
   * with. ponytail: a person running `claude --resume` on that same conversation elsewhere, before
   * the first join, could be taken for it; a descendant check per platform would rule that out.
   */
  private session(t: TerminalInfo) {
    const own = this.sessionAt(t.pid);
    if (own) return own;
    if (!this.found) {
      let saved: unknown = null;
      try {
        saved = readJson(this.foundFile);
      } catch {
        /* torn or foreign: joined again by session id */
      }
      this.found = saved && typeof saved === 'object' && !Array.isArray(saved) ? (saved as Record<string, number>) : {};
    }
    const joined = this.found[t.id];
    if (Number.isInteger(joined)) {
      const row = this.sessionAt(joined);
      if (row) return row;
    }
    const want = t.meta.session;
    if (!want) return null;
    let files: string[];
    try {
      files = fs.readdirSync(sessionsDir(this.o.home));
    } catch {
      return null;
    }
    for (const f of files) {
      const pid = Number(/^(\d+)\.json$/.exec(f)?.[1]);
      const row = pid > 0 && pid !== t.pid ? this.sessionAt(pid) : null;
      if (row?.sessionId !== want) continue;
      this.found[t.id] = pid;
      const ids = new Set(this.terminals().map((x) => x.id));
      for (const id of Object.keys(this.found)) if (!ids.has(id)) delete this.found[id];
      try {
        writeJsonAtomic(this.foundFile, this.found);
      } catch (err) {
        this.o.log(`claude-pids.json: ${err instanceof Error ? err.message : String(err)}`);
      }
      return row;
    }
    return null;
  }

  live(): LiveSession[] {
    const out: LiveSession[] = [];
    for (const t of this.terminals()) {
      const row = this.session(t);
      if (!row) continue; // not up yet: Claude writes its file within a second
      const osc = this.host.status.get(t.id);
      out.push({
        id: t.id,
        pid: row.pid ?? t.pid,
        cwd: row.cwd,
        kind: 'background',
        sessionId: row.sessionId,
        startedAt: row.startedAt ?? t.startedAt,
        ...(row.name && { name: row.name }),
        // The session file first; OSC says blocked when the file does not (yet).
        status:
          osc?.state === 'blocked'
            ? 'waiting'
            : (row.status || (osc ? (osc.state === 'working' ? 'busy' : readyToType(osc) ? 'idle' : undefined) : undefined)),
        ...(t.meta.assignment && { assignmentId: t.meta.assignment }),
      });
    }
    return out;
  }

  /** A live terminal of ours whose session file cannot be read: it may be up and look dead. */
  liveUnsure(): boolean {
    return this.terminals().some((t) => !this.session(t));
  }

  onChange(cb: () => void): () => void {
    const offs = [this.host.onChange(cb)];
    for (const dir of [sessionsDir(this.o.home), ptyhostPaths(this.o.home).dir])
      try {
        const w = fs.watch(dir, cb);
        w.on('error', () => undefined);
        offs.push(() => w.close());
      } catch {
        /* not there yet: the 30 s refresh reads it */
      }
    return () => offs.forEach((off) => off());
  }

  nameMatches(name: string | null | undefined, base: string): boolean {
    return nameMatches(name, base);
  }

  ready(): string | null {
    if (!this.o.hostScript) return koText('pty_host_missing');
    return fs.existsSync(this.o.claudePath) ? null : koText('claude_missing');
  }

  transcript(s: Pick<LiveSession, 'cwd' | 'sessionId'>): string {
    return transcriptPath(s.cwd, s.sessionId, this.o.home);
  }

  async start(p: ProjectRecord, o: { resume?: string; token: () => string | null }): Promise<StartResult> {
    // Only a person answers Claude's trust question (in this terminal, or the engine's trust step).
    if (folderTrusted(this.o.home, p.folder) === false) return { ok: false, error: TRUST_NEEDED, needsTrust: true };
    const assignment = assignmentOf(p) ?? p.name;
    // Ours, never up (no session file): the engine found nothing live, so it goes before a new one.
    for (const t of this.terminals())
      if (t.meta.assignment === assignment && !this.session(t)) await this.host.call('kill', { t: t.id });
    const token = this.o.cldBin ? o.token() : null;
    const mcp = this.o.cldBin ? writeMcpConfig(this.o.home, this.o.cldBin, this.o.log) : null;
    const combined = writeCombinedRules({
      home: this.o.home,
      rulesDir: rulesDirFor(this.o.cldBin ? path.dirname(this.o.cldBin) : null),
      role: p.role ?? 'lead',
      projectRulesFile: p.rulesFile,
      name: p.name,
      log: this.o.log,
    });
    // The conversation named up front: the terminal is joined to it whatever launcher runs Claude.
    const session = o.resume ?? randomUUID();
    const args = [
      ...ptyArgs({ ...p, rulesFile: combined?.file ?? p.rulesFile }, o.resume, this.o.cldBin, mcp),
      ...(o.resume ? [] : ['--session-id', session]),
    ];
    const r = await this.host.spawn({
      file: this.o.claudePath,
      args,
      cwd: p.folder,
      env: ptyEnv(this.o.env, {
        ...(this.o.cldBin && { CLD_BIN: this.o.cldBin }),
        ...(token && { [AGENT_TOKEN_ENV]: token }),
      }),
      meta: { assignment, session },
    });
    if (!r.ok || typeof r.id !== 'string')
      return { ok: false, ...refused('session_start_failed'), detail: r.error?.slice(0, 160) };
    return { ok: true, id: r.id, ...(combined?.playbook && { playbook: combined.playbook }) };
  }

  /** Close the PTY: SIGHUP to claude, SIGKILL after the grace (the host's). */
  async stop(s: LiveSession): Promise<StopResult> {
    const r = s.id ? await this.host.call('kill', { t: s.id }) : { ok: false, error: 'no terminal id' };
    return r.ok ? { ok: true } : { ok: false, ...refused('session_stop_failed'), detail: r.error };
  }

  /** TERM-P3: a move's rollback closes every terminal of the assignment, also one whose Claude has
   *  not written its session file yet (live() leaves it out): only then may `claude --bg` resume it. */
  async closeAll(p: ProjectRecord): Promise<boolean> {
    const assignment = assignmentOf(p) ?? p.name;
    const mine = () => this.terminals().filter((t) => t.meta.assignment === assignment);
    for (const t of mine()) await this.host.call('kill', { t: t.id });
    const end = Date.now() + this.t.closeMs;
    while (mine().length) {
      if (Date.now() > end) return false;
      await sleep(this.t.pollMs);
    }
    return true;
  }

  /** A permission or question only its terminal can answer: the session file or OSC says so. */
  held(s: LiveSession): Promise<boolean> {
    return Promise.resolve(s.status === 'waiting' || this.host.status.get(s.id ?? '')?.state === 'blocked');
  }

  /** TERM-P1: someone watches this terminal (the engine's idle stop leaves it alone). */
  viewed(s: LiveSession): boolean {
    return !!s.id && this.host.viewers(s.id) > 0;
  }

  async deliver(
    p: ProjectRecord,
    text: string,
    o: { messageId?: string; now?: boolean },
  ): Promise<'typed' | 'notReady' | 'failed'> {
    const assignment = assignmentOf(p) ?? p.name;
    const s = this.live().find((x) => x.assignmentId === assignment);
    if (!s?.id) return 'notReady';
    const id = s.id;
    const osc = () => this.host.status.get(id);
    const fileStatus = () => this.live().find((x) => x.id === id)?.status;
    const ready = turnEnded(s.status) || (s.status === undefined && readyToType(osc()));
    const now = !!o.now && s.status === 'busy';
    if ((!ready && !now) || (await this.held(s))) return 'notReady';
    const clean = cleanText(text);
    const pasted = await this.host.write(id, `\x1b[200~${clean.replaceAll('\n', '\r')}\x1b[201~`);
    if (!pasted.ok) return 'failed';
    // Enter on its own, once the paste had time to land (Orca: a 500 ms settle + ingest, 64 B/ms on Windows).
    await sleep(this.t.enterMs + Math.ceil(Buffer.byteLength(clean) / this.t.bytesPerMs));
    if (now) {
      await this.host.write(id, SEND_NOW[0]);
      await sleep(SEND_NOW_GAP_MS);
      await this.host.write(id, SEND_NOW[1]);
    } else await this.host.write(id, '\r');
    const file = this.transcript(s);
    const end = Date.now() + this.t.submitMs;
    for (;;) {
      if (
        (!now && (osc()?.state === 'working' || fileStatus() === 'busy')) ||
        (o.messageId && alreadyTyped(tail(file), o.messageId))
      )
        return 'typed';
      if (Date.now() >= end) break;
      await sleep(this.t.pollMs);
    }
    // The paste and Enter went in; a turn that has not shown yet still has them (as the Typist does).
    this.o.log(`typed into "${p.name}"; no turn start seen in ${this.t.submitMs} ms`);
    return 'typed';
  }
}
