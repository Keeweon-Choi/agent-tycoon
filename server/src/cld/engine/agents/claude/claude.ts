/**
 * The Claude Code provider (ADR-0013, ADR-0016 "Claude Code에 맞추기"): Claude
 * Code hosts the sessions (`claude --bg`), this starts, stops and lists them
 * for the engine.
 *
 * The only place that runs `claude` for the engine: absolute path, argv
 * array, no shell, stdin /dev/null (a pipe would become the first prompt),
 * cwd = the project folder, and a clean environment (HOME, PATH, locale...):
 * the Claude daemon that hosts every background session keeps the
 * environment and the cgroup of whoever starts it, so each run sits in its
 * own systemd user scope when there is one (else a new session) -- a
 * redeploy of our service must not kill every background session.
 *
 * Liveness is a live pid in ~/.claude/sessions (sessions.ts), read on demand
 * and when that directory changes; `claude` runs only for actions.
 */
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { koText, refused } from '../../../../../../core/src/cld/serverText.js';
import { extractContextTokens, readTranscriptTail } from '../../../../contextUsage.js';
import { contextWindowForModel } from '../../../../providers/hook/claude/claude.js';
import type { ClaudeSession } from '../../../providers/claudeProvider.js';
import {
  CLAUDE_TIMEOUT_MS,
  parseAgents,
  processAlive,
  transcriptPath,
  waitsForPermission,
} from '../../../providers/claudeProvider.js';
import type { SpawnFn } from '../../../spawnJson.js';
import { commandArgv } from '../../../spawnJson.js';
import { rulesDirFor, writeCombinedRules } from '../../agentRules.js';
import { AGENT_TOKEN_ENV } from '../../agentTokens.js';
import { configDir } from '../../events.js';
import { answeredSince, MESSENGER_TIMING, tail, turnOver, writeAtomic } from '../../messenger.js';
import type { ProjectRecord } from '../../registry.js';
import { sessionName } from '../../registry.js';
import type {
  AgentCapabilities,
  AgentProvider,
  LiveSession,
  StartResult,
  StopResult,
} from '../types.js';
import { parseIdleRetire, readDaemonLogTail } from './daemonLog.js';
import {
  daemonSessionVars,
  readLiveSessions,
  sessionsDir,
  unreadableLiveSession,
} from './sessions.js';

/** What Claude Code offers (F-11): its permission modes, no sandbox of its own. */
export const CLAUDE_CAPABILITIES: AgentCapabilities = {
  approvalPolicy: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
  sandbox: null,
  attach: 'pty',
  resume: true,
  naming: 'numbered',
  usage: 'statusLine',
  lifetime: 'session',
};

/** An id we pass to `claude stop`: Claude's short id, never a flag. */
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SYSTEMD_RUN_FAILED =
  /^Failed to (connect to bus|create bus connection|start transient scope)/m;
/** `claude --bg` in a folder Claude has not been allowed to trust: refused, nothing started. */
const UNTRUSTED = /Workspace not trusted/i;
/** Claude's background start has refused until its one-time bypass warning is accepted. */
const BYPASS_WARNING = /dangerously-skip-permissions|bypass permissions/i;

export const TRUST_NEEDED =
  koText('trust_needed');
export const BYPASS_NEEDED = koText('bypass_needed');

/** One `claude` run: in its own systemd user scope, or detached into a new session. */
export function claudeCommand(
  claudePath: string,
  args: string[],
  systemdRun: string | null,
): { file: string; args: string[]; detached: boolean } {
  return systemdRun
    ? {
        file: systemdRun,
        args: ['--user', '--scope', '--collect', '--quiet', '--', claudePath, ...args],
        detached: false,
      }
    : { file: claudePath, args, detached: true };
}

/** The engine sessions' status line: this Node running cld-gui-statusline.js beside `cldBin`. */
export const statusLineCommand = (cldBin: string, node = process.execPath): string =>
  `"${node}" "${path.join(path.dirname(cldBin), 'cld-gui-statusline.js')}"`;

/** C5a: the MCP adapter beside the CLI (cld/bin/cld-gui-mcp.js), as the sessions name it. */
export const MCP_SERVER_NAME = 'cld-gui';
export const mcpServerScript = (cldBin: string): string =>
  path.join(path.dirname(cldBin), 'cld-gui-mcp.js');
export const mcpConfigPath = (home: string): string => path.join(configDir(home), 'mcp-config.json');
/** The `--mcp-config` file's content: our Node on the adapter. No token: the adapter inherits
 *  the session's environment, CLD_AGENT_TOKEN included (checked with Claude Code 2.1.310). */
export const mcpConfig = (cldBin: string, node = process.execPath) => ({
  mcpServers: { [MCP_SERVER_NAME]: { command: node, args: [mcpServerScript(cldBin)] } },
});

/** Write the `--mcp-config` file (the same for every session); null when it cannot be written. */
export function writeMcpConfig(home: string, cldBin: string, log: (line: string) => void): string | null {
  const file = mcpConfigPath(home);
  try {
    writeAtomic(file, `${JSON.stringify(mcpConfig(cldBin))}\n`);
    return file;
  } catch (err) {
    log(`${file}: ${err instanceof Error ? err.message : String(err)}; sessions start without the agent tools`);
    return null;
  }
}

/**
 * `claude --bg` argv for a project. A background job of this conversation
 * keeps its own options, and any flag next to `--resume` makes Claude start a
 * copy under a new id ("keeps its own saved options, so the flags you passed
 * started a copy"), so such a job is woken with `--resume` alone.
 *
 * `cldBin` (T-0019) goes in as `--settings` env: `claude --bg` hands a session
 * the environment of Claude's own background service, not the caller's, so
 * this is how CLD_BIN reaches every session. `sessionPath` rides along: the
 * background service's PATH lacks the login shell's entries and, on WSL, the
 * Windows ones (curl.exe, powershell.exe), so the engine hands over the one
 * it built (sessionPath.ts). A bare wake resume above cannot carry flags, so
 * such a session keeps the PATH it has until it renews. `agentToken` (S7,
 * agentTokens.ts) rides along the same way: the session's identity on the
 * control socket. The status line (ENV-2) is cld-gui-statusline.js next to
 * the CLI: it keeps Claude Code's own rate_limits for the usage bar and runs
 * the user's own status line, so only sessions the engine starts get it.
 * `mcpConfig` (C5a) adds our MCP adapter to the session's own servers: never
 * `--strict-mcp-config`, so the user's MCP servers load as in a plain `claude`.
 */
export function startArgs(
  p: ProjectRecord,
  resume?: string,
  wake = false,
  cldBin: string | null = null,
  sessionPath: string | null = null,
  agentToken: string | null = null,
  mcpConfigFile: string | null = null,
): string[] {
  if (resume && wake) return ['--bg', '--resume', resume];
  const name = sessionName(p);
  return [
    '--bg',
    '-n',
    name,
    ...(resume ? ['--resume', resume] : []),
    ...(p.rulesFile ? ['--append-system-prompt-file', p.rulesFile] : []),
    ...(p.model ? ['--model', p.model] : []),
    ...(p.permissionMode ? ['--permission-mode', p.permissionMode] : []),
    ...(p.effort ? ['--effort', p.effort] : []),
    ...(p.remoteControl ? ['--remote-control', name] : []),
    ...(cldBin && mcpConfigFile ? ['--mcp-config', mcpConfigFile] : []),
    ...(cldBin
      ? [
          '--settings',
          JSON.stringify({
            env: {
              CLD_BIN: cldBin,
              ...(sessionPath ? { PATH: sessionPath } : {}),
              ...(agentToken ? { [AGENT_TOKEN_ENV]: agentToken } : {}),
            },
            // An orchestrator works in its own checkout, as before: Claude Code's
            // background-session guard would push every edit into a worktree (10-22 12:1x).
            worktree: { bgIsolation: 'none' },
            statusLine: { type: 'command', command: statusLineCommand(cldBin) },
            // No suggested next prompt (nor the first `Try "…"`, which comes with it) in the input line:
            // a Windows 10 ConPTY drops their dim attribute, the messenger took them for a typed draft
            // and every message waited (10-28 laptop). Messenger users never see them (user 10-28 21:57).
            promptSuggestionEnabled: false,
          }),
        ]
      : []),
  ];
}

/** The PTY program that joins background session `id` (chat.ts, the messenger's Typist). */
export const claudeAttachArgv = (claudePath: string, id: string): string[] => [
  claudePath,
  'attach',
  id,
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Claude names a background session `<name> (2)` when `<name>` is taken. */
export const nameMatches = (name: string | null | undefined, base: string): boolean =>
  !!name && new RegExp(`^${escapeRe(base)}( \\(\\d+\\))?$`).test(name);
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** `backgrounded · <id> · <name>`, the first line `claude --bg` prints. */
export function printedId(stdout: string): string | null {
  return /backgrounded · ([A-Za-z0-9_-]+)/.exec(stripAnsi(stdout))?.[1] ?? null;
}

const COMPACT_MARK = '"subtype":"compact_boundary"';

/** The newest main-chain usage snapshot in a transcript tail, as a percent;
 *  null when a compaction came after it (that usage is the context it emptied). */
function transcriptFillPct(file: string): number | null {
  const text = readTranscriptTail(file);
  if (text === null) return null;
  for (const line of text.split('\n').reverse()) {
    if (!line) continue;
    let record: {
      type?: string;
      subtype?: string;
      isSidechain?: boolean;
      message?: { model?: string };
    };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue;
    }
    if (record.type === 'system' && record.subtype === 'compact_boundary') return null;
    if (record.isSidechain) continue;
    const tokens = extractContextTokens(record);
    if (tokens <= 0) continue;
    const window = contextWindowForModel(record.message?.model);
    return window === undefined ? null : Math.min(100, Math.round((tokens / window) * 100));
  }
  return null;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

const firstLine = (r: Run): string | undefined =>
  stripAnsi(r.stderr || r.stdout)
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
    ?.slice(0, 160);

function runCommand(
  cmd: { file: string; args: string[]; detached: boolean },
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; spawnFn?: SpawnFn },
): Promise<Run> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      resolve({ code, stdout, stderr });
    };
    let child: ChildProcess;
    try {
      // Windows: npm's claude.cmd goes through cmd.exe (spawnJson.ts).
      const run = commandArgv(cmd.file, cmd.args);
      child = (opts.spawnFn ?? spawn)(run.file, run.args, {
        windowsVerbatimArguments: run.windowsVerbatimArguments,
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        detached: cmd.detached,
        timeout: opts.timeoutMs,
        windowsHide: true,
      });
    } catch (err) {
      stderr = err instanceof Error ? err.message : String(err);
      finish(null);
      return;
    }
    child.stdout?.on('data', (b: Buffer) => {
      if (stdout.length < 65_536) stdout += b.toString('utf-8');
    });
    child.stderr?.on('data', (b: Buffer) => {
      if (stderr.length < 65_536) stderr += b.toString('utf-8');
    });
    child.on('error', (err) => {
      stderr ||= err.message;
      finish(null);
    });
    child.on('close', (code) => finish(code));
    // A Claude daemon it started may hold our pipes: don't wait for that one.
    child.on('exit', (code) => setTimeout(() => finish(code), 1_000).unref());
  });
}

export interface ClaudeAgentOptions {
  claudePath: string;
  /** Claude Code's home (~/.claude) and the HOME of every `claude` it runs. */
  home: string;
  /** The engine's clean environment (cleanEnv). */
  env: NodeJS.ProcessEnv;
  /** systemd-run path, or null for setsid. */
  systemdRun: string | null;
  /** T-0019: cld-gui's CLI for sessions (CLD_BIN), or null. */
  cldBin: string | null;
  /** The PATH every session gets, or null when the service's own stands. */
  sessionPath: string | null;
  /** How long `claude --bg` and `claude stop` may take. */
  startMs: number;
  stopMs: number;
  spawnFn?: SpawnFn;
  log: (line: string) => void;
}

export class ClaudeAgent implements AgentProvider {
  readonly id = 'claude';
  readonly protocol = 'claude' as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  readonly compaction = { mark: COMPACT_MARK, fillPct: transcriptFillPct };
  private scope: string | null;

  constructor(private readonly o: ClaudeAgentOptions) {
    this.scope = o.systemdRun;
  }

  live(): LiveSession[] {
    return readLiveSessions(this.o.home);
  }

  liveUnsure(): boolean {
    return unreadableLiveSession(this.o.home);
  }

  onChange(cb: () => void): () => void {
    try {
      const watcher = fs.watch(sessionsDir(this.o.home), cb);
      watcher.on('error', () => undefined);
      return () => watcher.close();
    } catch {
      // No sessions directory yet: the 30 s refresh and the actions read it.
      return () => undefined;
    }
  }

  nameMatches(name: string | null | undefined, base: string): boolean {
    return nameMatches(name, base);
  }

  /** The claude the engine runs is there (what the office's providerReady checked before D5). */
  ready(): string | null {
    return fs.existsSync(this.o.claudePath) ? null : koText('claude_missing');
  }

  transcript(s: Pick<LiveSession, 'cwd' | 'sessionId'>): string {
    return transcriptPath(s.cwd, s.sessionId, this.o.home);
  }

  attachArgv(id: string): string[] {
    return claudeAttachArgv(this.o.claudePath, id);
  }

  async start(
    p: ProjectRecord,
    o: { resume?: string; token: () => string | null; flags?: boolean },
  ): Promise<StartResult> {
    const { resume } = o;
    // D3b: `flags` resumes under p's own -n, flags and a fresh token: Claude copies it (ADR-0013 §12).
    const wake = !!resume && !o.flags && this.hasJob(resume);
    // A wake resume carries no flags: that session keeps the token it has.
    const token = this.o.cldBin && !wake ? o.token() : null;
    const mcp = this.o.cldBin && !wake ? writeMcpConfig(this.o.home, this.o.cldBin, this.o.log) : null;
    // RULES-DEFAULT + C7a: built-in (shared + the role's playbook) + user + own rules as one
    // file, for a Lead, Worker or Reviewer alike (a wake resume carries no flags).
    const combined = wake
      ? null
      : writeCombinedRules({
          home: this.o.home,
          rulesDir: rulesDirFor(this.o.cldBin ? path.dirname(this.o.cldBin) : null),
          role: p.role ?? 'lead',
          projectRulesFile: p.rulesFile,
          name: p.name,
          log: this.o.log,
        });
    const rulesFile = combined?.file ?? p.rulesFile;
    const args = startArgs({ ...p, rulesFile }, resume, wake, this.o.cldBin, this.o.sessionPath, token, mcp);
    const r = await this.claude(args, p.folder, this.o.startMs);
    if (r.code !== 0) {
      const output = r.stderr + r.stdout;
      if (p.permissionMode === 'bypassPermissions' && BYPASS_WARNING.test(output))
        return {
          ok: false,
          error: BYPASS_NEEDED,
          needsBypassAccept: true,
          detail: firstLine(r),
        };
      if (!UNTRUSTED.test(output))
        return { ok: false, ...refused('session_start_failed'), detail: firstLine(r) };
      // Only a person answers Claude's trust question; the engine never does.
      return { ok: false, error: TRUST_NEEDED, needsTrust: true };
    }
    return { ok: true, id: printedId(r.stdout), ...(combined?.playbook && { playbook: combined.playbook }) };
  }

  /** `claude stop <exact id>`. */
  async stop(h: LiveSession): Promise<StopResult> {
    if (!h.id || !JOB_ID_RE.test(h.id)) return { ok: false, ...refused('session_id_unknown') };
    const r = await this.claude(['stop', h.id], this.o.home, this.o.stopMs);
    if (r.code !== 0) return { ok: false, ...refused('session_stop_failed'), detail: firstLine(r) };
    return { ok: true };
  }

  /**
   * The messenger asks this just before an attach: `claude agents --json`
   * lists the session as `blocked`, it has answered since it started (a fresh
   * or resumed session reads `blocked` while it waits for its first message,
   * T-0014), and its turn is still open on a tool call: a question or
   * permission its terminal shows, where typed input does not stick. Claude
   * also lists a session whose turn simply ended waiting for a reply as
   * `blocked` (pofol 10-22 14:28: "Worked for 20s", an empty input line); a
   * message is the answer then. One spawn, only when a message is about to go
   * in, so at most once per retry pause. PERM-PROMPT: `waitingFor` naming a
   * permission prompt is held whatever the transcript says (a background
   * sub-agent's dialog can come up after the lead's own turn ended).
   */
  async held(h: LiveSession): Promise<boolean> {
    const r = await runCommand(claudeCommand(this.o.claudePath, ['agents', '--json'], null), {
      cwd: this.o.home,
      env: this.o.env,
      timeoutMs: CLAUDE_TIMEOUT_MS,
      spawnFn: this.o.spawnFn,
    });
    let row: ClaudeSession | undefined;
    try {
      row = parseAgents(JSON.parse(r.stdout)).find((a) => a.id === h.id);
    } catch {
      return false;
    }
    if (waitsForPermission(row)) return true;
    if (row?.state !== 'blocked') return false;
    const since = row.startedAt ?? h.startedAt ?? 0;
    const text = tail(this.transcript(h));
    return answeredSince(text, since) && !turnOver(text, Date.now(), MESSENGER_TIMING.quietMs);
  }

  /** A persisted marker also survives a log rotation before the daemon restarts. */
  idleRetired(): (ids: Array<string | undefined>) => boolean {
    const daemonLog = readDaemonLogTail(this.o.home);
    return (ids) => !!parseIdleRetire(daemonLog ?? '', ids);
  }

  /** true/false: ~/.claude/daemon.lock names a Claude daemon that is (not) running; null: no such file. */
  daemonUp(): boolean | null {
    try {
      const lock = JSON.parse(
        fs.readFileSync(path.join(this.o.home, '.claude', 'daemon.lock'), 'utf-8'),
      ) as { pid?: unknown; procStart?: unknown };
      if (typeof lock.pid !== 'number' || !Number.isInteger(lock.pid) || lock.pid <= 0) return null;
      return processAlive(
        lock.pid,
        typeof lock.procStart === 'string' ? lock.procStart : undefined,
      );
    } catch {
      return null;
    }
  }

  warning(): string | null {
    const daemon = daemonSessionVars(this.o.home);
    return daemon?.vars.length
      ? koText('daemon_env', { pid: daemon.pid, vars: daemon.vars.join(', ') })
      : null;
  }

  private hasJob(sessionId: string): boolean {
    return fs.existsSync(
      path.join(this.o.home, '.claude', 'jobs', sessionId.slice(0, 8), 'state.json'),
    );
  }

  private async claude(args: string[], cwd: string, timeoutMs: number): Promise<Run> {
    const r = await runCommand(claudeCommand(this.o.claudePath, args, this.scope), {
      cwd,
      env: this.o.env,
      timeoutMs,
      spawnFn: this.o.spawnFn,
    });
    if (this.scope && r.code !== 0 && SYSTEMD_RUN_FAILED.test(r.stderr)) {
      this.o.log(`systemd-run failed (${firstLine(r)}); running claude with setsid from now on`);
      this.scope = null;
      return this.claude(args, cwd, timeoutMs);
    }
    return r;
  }
}
