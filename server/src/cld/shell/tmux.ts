/**
 * Our own tmux server for trusted-device shells (T-0069, T-0078): a shell
 * runs in a detached tmux session so a deploy (the daemon restarting) does
 * not kill it. Every call names `-L <socket> -f /dev/null`: a private socket
 * and no user config, never the default server. The only way
 * to another socket is `CLD_GUI_SHELL_TMUX_SOCKET` with a `cld-test-` name
 * (the tests'), so nothing an environment says can point this at a real server.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { findOnPath } from '../providers/claudeProvider.js';

export const SHELL_TMUX_SOCKET = 'cld-gui-shell';
export const SHELL_TMUX_SOCKET_ENV = 'CLD_GUI_SHELL_TMUX_SOCKET';
const TEST_SOCKET = /^cld-test-[a-z0-9]{4,40}$/;
/** Tried after PATH: a daemon started by systemd has a short PATH. */
const FALLBACK_DIRS = ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'];

/** The socket name: ours, or a test's when the environment names a `cld-test-` one. */
export function tmuxSocketName(env: NodeJS.ProcessEnv = process.env): string {
  const asked = env[SHELL_TMUX_SOCKET_ENV];
  return asked && TEST_SOCKET.test(asked) ? asked : SHELL_TMUX_SOCKET;
}

export function findTmux(env: NodeJS.ProcessEnv = process.env, home?: string): string | null {
  const dirs = [...(env.PATH ?? '').split(path.delimiter), ...FALLBACK_DIRS];
  if (home) dirs.push(path.join(home, '.local', 'bin'));
  return findOnPath('tmux', dirs.join(path.delimiter));
}

export interface TmuxResult {
  status: number | null;
  stdout: string;
}
/** Runs tmux with `argv` (tests record the calls). */
export type TmuxRun = (bin: string, argv: string[], env: Record<string, string>) => TmuxResult;

const runSync: TmuxRun = (bin, argv, env) => {
  const r = spawnSync(bin, argv, { env, encoding: 'utf8', timeout: 5_000, stdio: 'pipe' });
  return { status: r.status, stdout: r.stdout ?? '' };
};

export interface NewSession {
  cols: number;
  rows: number;
  cwd: string;
  command: string;
  args: string[];
  /** The login environment: the whole environment of the shell and of the server it may start. */
  env: Record<string, string>;
}

/**
 * `s` as tmux reads it literally: `-c` is expanded as a format (a folder named
 * `#(cmd)` would run cmd), and an argument ending in `;` ends the command.
 */
export const tmuxLiteral = (s: string): string => s.replace(/#/g, '##').replace(/;$/, '\\;');

export class Tmux {
  constructor(
    readonly bin: string,
    readonly socket: string = tmuxSocketName(),
    private readonly run: TmuxRun = runSync,
  ) {}

  /** Every call starts like this. */
  argv(...rest: string[]): string[] {
    return ['-L', this.socket, '-f', '/dev/null', ...rest];
  }

  /** Without the daemon's environment: a stray $TMUX must not matter. */
  private exec(rest: string[], env: Record<string, string> = {}): TmuxResult {
    return this.run(this.bin, this.argv(...rest), env);
  }

  /** `=` makes the target an exact name, not a prefix. */
  private target = (id: string) => `=${id}`;

  /** A detached session named `id` running the login shell; false when tmux refused. */
  newSession(id: string, o: NewSession): boolean {
    const set = Object.entries(o.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const ok = this.exec(
      [
        'new-session',
        '-d',
        '-s',
        id,
        '-x',
        String(o.cols),
        '-y',
        String(o.rows),
        '-c',
        tmuxLiteral(o.cwd),
        ...set,
        '--',
        o.command,
        ...o.args,
        // A terminal, not a tmux window: no prefix key (Ctrl+B is the shell's),
        // no status line, no half-second ESC wait, 24-bit colour passes
        // through, the wheel scrolls tmux's history.
        ';',
        'set-option',
        '-g',
        'prefix',
        'None',
        ';',
        'set-option',
        '-g',
        'prefix2',
        'None',
        ';',
        'set-option',
        '-s',
        'escape-time',
        '0',
        ';',
        'set-option',
        '-sa',
        'terminal-features',
        ',xterm*:RGB',
        ';',
        'set-option',
        '-t',
        `${this.target(id)}:`,
        'status',
        'off',
        ';',
        'set-option',
        '-t',
        `${this.target(id)}:`,
        'mouse',
        'on',
        // Right-click opens tmux's pane menu (Kill, Respawn, Split): not ours.
        ';',
        'unbind-key',
        '-n',
        'MouseDown3Pane',
        ';',
        'unbind-key',
        '-n',
        'M-MouseDown3Pane',
      ],
      o.env,
    );
    return ok.status === 0;
  }

  hasSession(id: string): boolean {
    return this.exec(['has-session', '-t', this.target(id)]).status === 0;
  }

  killSession(id: string): void {
    this.exec(['kill-session', '-t', this.target(id)]);
  }

  /** Names of the live sessions; none when the server is not running. */
  sessions(): Set<string> {
    const r = this.exec(['list-sessions', '-F', '#{session_name}']);
    return new Set(r.status === 0 ? r.stdout.split('\n').filter(Boolean) : []);
  }

  /** What the daemon's PTY runs to show session `id`. `-u`: UTF-8 whatever locale the daemon was started in (Korean). */
  attachCommand(id: string): { file: string; args: string[] } {
    return { file: this.bin, args: this.argv('-u', 'attach-session', '-t', this.target(id)) };
  }

  /** Tests only, on their own `cld-test-` socket. */
  killServer(): void {
    if (!TEST_SOCKET.test(this.socket))
      throw new Error('refusing to kill a tmux server that is not a test one');
    this.exec(['kill-server']);
    // tmux leaves the socket file behind.
    const dir = path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid?.() ?? 0}`);
    fs.rmSync(path.join(dir, this.socket), { force: true });
  }
}
