/**
 * Run a program by absolute path and parse its stdout as JSON. execFile's
 * semantics (argv array, no shell, timeout) plus stdin = /dev/null, which
 * execFile cannot do: Node only forwards cwd/env/shell/... from execFile to
 * spawn, never stdio. Runs are queued one at a time, process-wide, so the
 * daemon's RAM peaks at itself plus its largest child, never a sum (T-0013).
 */
import * as os from 'node:os';
import * as path from 'node:path';

import { spawn } from 'child_process';

export type SpawnFn = typeof spawn;

/** cmd.exe's own metacharacters, escaped with ^ (cross-spawn's rule). */
const CMD_META = /[()%!^"<>&|;, ]/g;

/** One argv entry for a Windows batch file: C runtime quoting (the program the
 *  .cmd starts reads its argv that way), then every cmd metacharacter escaped
 *  twice: once for the `cmd /c` line, once for the shim's own `... %*` line,
 *  which cmd parses again (BatBadBut; cross-spawn's doubleEscapeMetaChars). */
const cmdArg = (arg: string): string =>
  `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`.replace(CMD_META, '^$&').replace(CMD_META, '^$&');

/** cmd.exe by absolute path, never a bare cmd.exe: Windows would look for it in the child's working directory first. */
export const windowsCmd = (env: NodeJS.ProcessEnv = process.env): string =>
  env.ComSpec || path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');

/**
 * How to start `file` with `args` without a shell. A Windows .cmd/.bat (npm's
 * `claude.cmd`, `codex.cmd`) cannot be spawned directly (Node refuses it,
 * EINVAL), so it goes through `cmd.exe /d /v:off /s /c` with every part escaped
 * (/v:off: no !var! expansion even when the registry turns it on); an argument
 * with a line break is refused, since cmd.exe would cut the command there.
 */
export function commandArgv(
  file: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  comspec = windowsCmd(),
): { file: string; args: string[]; windowsVerbatimArguments?: true } {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) return { file, args };
  if (args.some((a) => /[\r\n\0]/.test(a)))
    throw new Error(`${path.win32.basename(file)}: cmd.exe cannot pass an argument with a line break`);
  const line = [file.replace(CMD_META, '^$&'), ...args.map(cmdArg)].join(' ');
  return { file: comspec, args: ['/d', '/v:off', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
}

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface SpawnJsonOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  spawnFn?: SpawnFn;
  /** Working directory; defaults to the home directory (see the spawn call). */
  cwd?: string;
}

/** A run that did not exit 0 with JSON. `json` is what stdout still parsed to
 *  (a program may print `{ok:false,error}` and exit 1); `timedOut` when the timeout killed it. */
export class SpawnJsonError extends Error {
  constructor(
    message: string,
    readonly json: unknown,
    readonly timedOut: boolean,
  ) {
    super(message);
  }
}

let queue: Promise<unknown> = Promise.resolve();

export function spawnJson(file: string, args: string[], opts: SpawnJsonOptions): Promise<unknown> {
  const run = queue.then(() => spawnNow(file, args, opts));
  queue = run.catch(() => undefined);
  return run;
}

function spawnNow(file: string, args: string[], opts: SpawnJsonOptions): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const cmd = commandArgv(file, args);
    const child = (opts.spawnFn ?? spawn)(cmd.file, cmd.args, {
      windowsVerbatimArguments: cmd.windowsVerbatimArguments,
      env: opts.env ?? process.env,
      // Home, not the daemon's repo folder: a program that derives who is calling from its cwd
      // would otherwise take every call for the cld-gui orchestrator's.
      cwd: opts.cwd ?? os.homedir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      timeout: opts.timeoutMs,
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let errText = '';
    child.stdout?.on('data', (b: Buffer) => {
      size += b.length;
      if (size > MAX_OUTPUT_BYTES) child.kill();
      else chunks.push(b);
    });
    child.stderr?.on('data', (b: Buffer) => {
      if (errText.length < 2000) errText += b.toString('utf-8');
    });
    child.on('error', reject);
    // Killed (timeout, output cap): a grandchild still holding the pipes would
    // otherwise delay 'close' until it exits too.
    child.on('exit', (_code, signal) => {
      if (signal) {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
    });
    child.on('close', (code, signal) => {
      let json: unknown;
      try {
        const out = Buffer.concat(chunks).toString('utf-8');
        json = JSON.parse(out);
      } catch {
        json = undefined;
      }
      if (code === 0 && json !== undefined) {
        resolve(json);
        return;
      }
      const err =
        json && typeof json === 'object' && typeof (json as { error?: unknown }).error === 'string'
          ? (json as { error: string }).error
          : errText.trim();
      const name = `${path.basename(file)} ${args[0] ?? ''}`.trim();
      reject(
        new SpawnJsonError(
          `${name} failed (${signal ?? `exit ${code}`})${err ? `: ${err}` : ''}`,
          json,
          signal !== null && Date.now() - started >= opts.timeoutMs,
        ),
      );
    });
  });
}
