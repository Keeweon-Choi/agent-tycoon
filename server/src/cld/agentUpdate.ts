/**
 * AGENT-UPDATE (owner 11-06 20:35, "에이전트 CLI 업데이트 해야될 때는 어떻게해?"): the owner updates an
 * agent CLI from the office, the same way for every agent (`agentCliUpdate {agent}`). The agent's
 * provider declares its own update arguments (AgentCapabilities.update); the daemon runs exactly those
 * with the binary the engine runs for that agent (Engine.agentCli), never a path or an argument from
 * the client, without a shell, with a timeout, and answers `agentCliUpdateState` with `--version`
 * before and after and the CLI's own last lines (escape codes stripped, secrets masked, the home
 * folder as ~, capped). Gates: a privileged connection on a daemon that is not read-only, a fresh
 * step-up from a remote device (as the engine's actions), one run per CLI at a time, none while the
 * CLI is missing. Nothing is restarted: a running agent keeps its version until its next start.
 */
import { execFile } from 'child_process';
import * as os from 'os';
import { stripVTControlCharacters } from 'util';

import {
  AGENT_CLI_UPDATE_KILL_GRACE_MS,
  AGENT_CLI_UPDATE_LINES,
  AGENT_CLI_UPDATE_MAX_BYTES,
  AGENT_CLI_UPDATE_TIMEOUT_MS,
  AGENT_CLI_VERSION_TIMEOUT_MS,
} from '../constants.js';
import { versionOf } from './engine/agentCapabilities.js';
import type { SocketStepUp, WsSend } from './hooks.js';
import { maskText } from './mask.js';
import { STEPUP_REQUIRED } from './shell/gate.js';
import { commandArgv } from './spawnJson.js';

export type CliRun = (
  file: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
) => Promise<{ code: number; output: string; timedOut?: boolean }>;

export interface AgentUpdateDeps {
  /** The engine's CLI for provider `agent` (bin null: not installed), or null: no update offered. */
  cli: (agent: string) => { bin: string | null; update: readonly string[] } | null;
  /** The environment the engine's sessions get (no agent token in it). */
  env: () => NodeJS.ProcessEnv;
  home: string;
  run?: CliRun;
  /** An update ran: the engine re-reads the installed versions (engineState.agentChoices). */
  updated?: () => void;
}

export interface AgentUpdateCtx {
  privileged: boolean;
  readOnly: boolean;
  stepUp?: SocketStepUp;
}

/** `file ...args` without a shell (cmd.exe only for a Windows .cmd shim, args quoted), stdout and
 *  stderr together: a CLI tells why it cannot update on either. */
export const runCli: CliRun = (file, args, timeoutMs, env) =>
  new Promise((resolve) => {
    const run = commandArgv(file, args);
    const child = execFile(
      run.file,
      run.args,
      {
        env,
        // Never the daemon's own cwd: a project there could feed the CLI's package manager its .npmrc or bunfig.
        cwd: os.homedir(),
        timeout: timeoutMs,
        maxBuffer: AGENT_CLI_UPDATE_MAX_BYTES,
        windowsHide: true,
        windowsVerbatimArguments: run.windowsVerbatimArguments,
      },
      (err, stdout, stderr) => {
        clearTimeout(hardStop);
        const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        resolve({
          code: e ? (typeof e.code === 'number' ? e.code : -1) : 0,
          output: `${String(stdout ?? '')}\n${String(stderr ?? '')}`,
          timedOut: !!e?.killed && e.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        });
      },
    );
    // The timeout only sends SIGTERM to the CLI itself: one that ignores it, or a child of it that keeps
    // the pipes open, would leave the update 'running' until the daemon restarts.
    const hardStop = setTimeout(() => {
      child.kill('SIGKILL');
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, timeoutMs + AGENT_CLI_UPDATE_KILL_GRACE_MS);
    child.stdin?.end(); // nothing to answer: a prompt reads end of input
  });

/** The CLI's last lines as the owner may see them. */
export function updateLines(output: string, home: string): string[] {
  const text = maskText(stripVTControlCharacters(output));
  const lines = text
    .split(/\r?\n|\r/)
    .map((l) => (home ? l.replaceAll(home, '~') : l).trim())
    .filter(Boolean);
  return lines.slice(-AGENT_CLI_UPDATE_LINES);
}

/** A CLI saying it cannot update itself (a package manager owns the install). */
const MANUAL_HINT =
  /package manager|managed by|installed (?:with|via|by|through|using)|update (?:it )?(?:with|through|using|via)|(?:can ?not|unable to) (?:self-?)?update|self-?update is (?:disabled|not supported)/i;
/** The package manager's command it gives, from its first word to the line's end. */
const MANAGER_COMMAND =
  /\b(?:sudo\s+)?(?:npm|pnpm|yarn|bun|brew|scoop|volta|winget|choco|mise|asdf)\s+(?:i|install|add|update|upgrade|up|global)\b[^\r\n]*/i;

/** The version did not change: did the CLI ask for a manual update (and with which command)?
 *  ponytail: English wording heuristics; a CLI that words it otherwise reads as up to date. */
export function manualUpdate(lines: readonly string[]): { command: string | null } | null {
  for (const line of lines) {
    const m = MANAGER_COMMAND.exec(line);
    if (m) return { command: m[0].trim().replace(/[`'".,;]+$/, '') };
  }
  return lines.some((l) => MANUAL_HINT.test(l)) ? { command: null } : null;
}

export class AgentUpdate {
  /** The CLIs (by binary) updating now: claude and claude-pty share one. */
  private readonly busy = new Set<string>();
  private readonly run: CliRun;

  constructor(private readonly d: AgentUpdateDeps) {
    this.run = d.run ?? runCli;
  }

  handle(msg: Record<string, unknown>, send: WsSend, ctx: AgentUpdateCtx): Promise<void> {
    const agent = typeof msg.agent === 'string' ? msg.agent : '';
    const refuse = (error: string) => {
      send({ type: 'agentCliUpdateState', agent, phase: 'refused', error });
      return Promise.resolve();
    };
    if (!ctx.privileged || ctx.readOnly) return refuse('read_only');
    if (ctx.stepUp?.remote && !ctx.stepUp.fresh()) return refuse(STEPUP_REQUIRED);
    const cli = this.d.cli(agent);
    if (!cli) return refuse('unsupported');
    if (!cli.bin) return refuse('missing');
    if (this.busy.has(cli.bin)) return refuse('busy');
    return this.update(agent, cli.bin, [...cli.update], send);
  }

  private async update(agent: string, bin: string, args: string[], send: WsSend): Promise<void> {
    this.busy.add(bin);
    send({ type: 'agentCliUpdateState', agent, phase: 'running' });
    try {
      const env = this.d.env();
      const version = async () =>
        versionOf((await this.run(bin, ['--version'], AGENT_CLI_VERSION_TIMEOUT_MS, env)).output);
      const before = await version();
      console.log(`[Agent Tycoon] agent CLI: updating ${agent} on the owner's request`);
      const r = await this.run(bin, args, AGENT_CLI_UPDATE_TIMEOUT_MS, env);
      const after = await version();
      const lines = updateLines(r.output, this.d.home);
      const manual = !r.timedOut && (!after || after === before) ? manualUpdate(lines) : null;
      send({
        type: 'agentCliUpdateState',
        agent,
        phase: 'done',
        ok: r.code === 0 && !r.timedOut,
        ...(before && { before }),
        ...(after && { after }),
        lines,
        ...(manual && { manual: true }),
        ...(manual?.command && { command: manual.command }),
        ...(r.timedOut && { error: 'timeout' }),
      });
    } catch (err) {
      console.warn(`[Agent Tycoon] agent CLI: ${agent} update: ${err instanceof Error ? err.name : 'error'}`);
      send({ type: 'agentCliUpdateState', agent, phase: 'done', ok: false, lines: [] });
    } finally {
      this.busy.delete(bin);
      try {
        this.d.updated?.();
      } catch {
        /* the next engineState reads them anyway */
      }
    }
  }
}
