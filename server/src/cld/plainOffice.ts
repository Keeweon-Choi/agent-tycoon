/**
 * AGENT-CLI: the plain office (the daemon found no Claude Code at start) tells its viewers to
 * install it and picks it up without a manual restart. It looks again when a viewer connects
 * and when the owner presses 다시 찾기 (never on a timer: nobody may be watching). When claude
 * turns up it restarts the daemon, because the office's routes and providers are built once
 * before the server listens; a restart that does not take effect leaves this plain office
 * running and says so in the log and in the notice.
 */
import { execFile, spawn } from 'child_process';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';

import {
  AGENT_CLI_RECHECK_MIN_GAP_MS,
  AGENT_CLI_RESTART_COMMAND_TIMEOUT_MS,
  AGENT_CLI_RESTART_WAIT_MS,
} from '../constants.js';
import { claudeInstallCommand } from './agentCli.js';
import { detectHostInfo } from './folders.js';
import type { CldHooks, WsSend } from './hooks.js';

type State = 'missing' | 'restarting' | 'failed';

export interface PlainOfficeDeps {
  /** findClaude: the path, or null. */
  find: () => string | null;
  /** Orders the daemon's restart; false: it could not be ordered. A restart that works ends this process. */
  restart: () => Promise<boolean>;
  platform?: NodeJS.Platform;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export class PlainOffice {
  state: State = 'missing';
  private readonly viewers = new Set<WsSend>();
  private lastCheck = Number.NEGATIVE_INFINITY;

  constructor(private readonly d: PlainOfficeDeps) {}

  hooks(): Pick<CldHooks, 'onClientReady' | 'onClientMessage' | 'onClientClosed'> {
    return {
      onClientReady: (send) => {
        this.viewers.add(send);
        this.tell(send);
        // the notice's install buttons open a shell in the home folder (CLI-TERMINAL): a full office
        // sends this on ready, a plain one did not, so the buttons stayed disabled
        send({ ...detectHostInfo() });
        void this.check('viewer');
      },
      onClientClosed: (send) => void this.viewers.delete(send),
      onClientMessage: (msg, _send, privileged) => {
        if (msg.type !== 'agentCliRecheck') return;
        if (!privileged) return void this.log('[cld] agent CLI: 다시 찾기 refused (not privileged)');
        void this.check('button');
      },
    };
  }

  /** Looks for claude; found: restart. Never throws. */
  async check(by: 'viewer' | 'button'): Promise<void> {
    const now = (this.d.now ?? Date.now)();
    // A viewer's look is throttled; after a failed restart only the button tries again.
    if (this.state === 'restarting') return;
    if (by === 'viewer' && (this.state === 'failed' || now - this.lastCheck < AGENT_CLI_RECHECK_MIN_GAP_MS))
      return;
    this.lastCheck = now;
    let claude: string | null = null;
    try {
      claude = this.d.find();
    } catch {
      /* treated as not found */
    }
    if (!claude) return this.set('missing', by === 'button');
    this.log(`[cld] agent CLI found at ${claude}: restarting to bring the full office up`);
    this.set('restarting');
    let ordered = false;
    try {
      ordered = await this.d.restart();
    } catch (err) {
      this.log(`[cld] agent CLI restart error: ${err instanceof Error ? err.message : String(err)}`);
    }
    // When the restart works this process ends while it waits.
    if (ordered) await (this.d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(AGENT_CLI_RESTART_WAIT_MS);
    this.log('[cld] agent CLI restart did not take effect: plain pixel-agents office keeps running');
    this.set('failed');
  }

  private set(state: State, again = false): void {
    if (state === this.state && !again) return; // the viewers already know
    this.state = state;
    for (const send of this.viewers) this.tell(send, again);
  }

  private tell(send: WsSend, again = false): void {
    send({
      type: 'agentCliState',
      state: this.state,
      command: claudeInstallCommand(this.d.platform ?? process.platform),
      ...(again && this.state === 'missing' ? { again: true } : {}),
    });
  }

  private log(line: string): void {
    (this.d.log ?? console.log)(line);
  }
}

export interface RestartDeps {
  platform?: NodeJS.Platform;
  home?: string;
  /** This checkout's cld/bin (CLD_BIN_DIR), where the service plans live; null: not found. */
  binDir: string | null;
  /** Runs a command to its end; true: exit code 0. */
  run?: (command: string[]) => Promise<boolean>;
  /** Ends this daemon after its graceful shutdown (Windows: a helper started before it runs the task again). */
  exitForSupervisor: () => void;
  /** Starts the Windows restart helper (child_process.spawn). */
  spawn?: typeof spawn;
  /** %SystemRoot% of the Windows daemon. */
  systemRoot?: string;
  /** This daemon's pid, which the helper waits for. */
  pid?: number;
  log?: (line: string) => void;
}

const runCommand = (command: string[]): Promise<boolean> =>
  new Promise((resolve) =>
    execFile(
      command[0],
      command.slice(1),
      { timeout: AGENT_CLI_RESTART_COMMAND_TIMEOUT_MS, windowsHide: true },
      (error) => resolve(!error),
    ),
  );

/**
 * The daemon's restart, by the service plans `agty restart` uses (cld/bin/cld-gui-maintenance.js).
 * systemd and launchd restart the unit (async: the command waits for this process to stop, a
 * blocking wait would deadlock). A Windows logon task runs with MultipleInstances IgnoreNew, so
 * `schtasks /Run` would do nothing while the daemon runs, and a non-zero exit is not restarted by the
 * task: a hidden helper waits for this daemon's pid to end, then runs the task again. Without a registered service
 * (npx, a hand start) there is nothing to restart: false.
 */
export async function restartDaemon(d: RestartDeps): Promise<boolean> {
  const log = d.log ?? console.log;
  if (!d.binDir) {
    log('[cld] agent CLI: cld/bin not found, cannot restart');
    return false;
  }
  const platform = d.platform ?? process.platform;
  const home = d.home ?? os.homedir();
  const run = d.run ?? runCommand;
   
  const maintenance = createRequire(__filename)(path.join(d.binDir, 'cld-gui-maintenance.js'));
  const service: string = maintenance.installedService(platform, home);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const plan = maintenance.serviceCommands(platform, uid, service) as {
    installed: string[] | null;
    active: string[];
    restart: string[];
  };
  if (!(await run(plan.installed ?? plan.active))) {
    log(`[cld] agent CLI: service ${service} is not registered, cannot restart`);
    return false;
  }
  if (platform === 'win32') {
    // A task exiting non-zero is NOT restarted (restart-on-failure only covers a failed launch; measured
    // on Windows 11), and `schtasks /Run` does nothing while the task runs (IgnoreNew). A hidden helper
    // outlives the task's main process: it waits for this pid, then runs the task again. This pid ending is
    // not yet the task ending (cmd.exe and wscript.exe above it exit after it), and a run asked for in between
    // is dropped: 10-28 a Windows 10 laptop stayed down. So the helper also waits for the task to leave
    // Running (at most 30 s), and runs it once more if it is not running 5 s later.
    const state = `(Get-ScheduledTask -TaskName '${service}' -ErrorAction SilentlyContinue).State`;
    const runTask = plan.restart.join(' ');
    const wait = `Wait-Process -Id ${d.pid ?? process.pid} -Timeout 30 -ErrorAction SilentlyContinue; for ($i = 0; $i -lt 60 -and ${state} -eq 'Running'; $i++) { Start-Sleep -Milliseconds 500 }; ${runTask}; Start-Sleep -Seconds 5; if (${state} -ne 'Running') { ${runTask} }`;
    const powershell = path.win32.join(
      d.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    try {
      (d.spawn ?? spawn)(powershell, ['-NoProfile', '-Command', wait], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } catch (err) {
      log(`[cld] agent CLI: restart helper failed to start: ${err instanceof Error ? err.message : String(err)}`);
      return false; // the daemon keeps running: no helper, no exit
    }
    d.exitForSupervisor();
    return true;
  }
  return run(plan.restart);
}
