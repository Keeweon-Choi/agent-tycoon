/**
 * Run a program by absolute path and parse its stdout as JSON. execFile's
 * semantics (argv array, no shell, timeout) plus stdin = /dev/null (or held open briefly, see holdStdinMs), which
 * execFile cannot do: Node only forwards cwd/env/shell/... from execFile to
 * spawn, never stdio. Runs are queued one at a time, process-wide, so the
 * daemon's RAM peaks at itself plus its largest child, never a sum (T-0013).
 */
import * as os from 'node:os';
import * as path from 'node:path';

import { spawn } from 'child_process';

import { SPAWN_JSON_KILL_GRACE_MS } from '../constants.js';

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
  /** stdout is one JSON value per line (stream-json): resolve the lines that parse, in order. */
  ndjson?: boolean;
  /** One UTF-8 line to write before closing stdin (for a stream-json control request). */
  stdin?: string;
  /** Give the child an open stdin pipe, nothing written, and end it after this many ms (or when the child is gone); default: /dev/null. */
  holdStdinMs?: number;
  /** After the timeout's SIGTERM, SIGKILL our child this much later if it is still there (default SPAWN_JSON_KILL_GRACE_MS). */
  killGraceMs?: number;
  /** Start now, outside the process-wide queue (T-115's side question, capped at one by its caller). */
  unqueued?: boolean;
  /** Stops our child when aborted (T-115: the side question's drawer was closed). */
  signal?: AbortSignal;
  /** Called with the child once it is started (T-115: its pid). */
  onSpawn?: (child: ReturnType<SpawnFn>) => void;
}

/** A run that did not exit 0 with JSON. `json` is what stdout still parsed to
 *  (a program may print `{ok:false,error}` and exit 1); `timedOut` when the timeout killed it;
 *  `stderr` what it wrote there (its first 2000 characters or so), for a caller that tells why. */
export class SpawnJsonError extends Error {
  constructor(
    message: string,
    readonly json: unknown,
    readonly timedOut: boolean,
    readonly stderr = '',
  ) {
    super(message);
  }
}

/** Each line that parses as JSON; a cut or a non-JSON line is skipped. */
function jsonLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    try {
      if (line.trim()) out.push(JSON.parse(line));
    } catch {
      // not JSON
    }
  }
  return out;
}

let queue: Promise<unknown> = Promise.resolve();

export function spawnJson(file: string, args: string[], opts: SpawnJsonOptions): Promise<unknown> {
  if (opts.unqueued) return spawnNow(file, args, opts);
  const run = queue.then(() => spawnNow(file, args, opts));
  queue = run.catch(() => undefined);
  return run;
}

function spawnNow(file: string, args: string[], opts: SpawnJsonOptions): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const cmd = commandArgv(file, args);
    // Whether the timeout is what killed it: a timer of our own, set before spawn's (the same delay, so it
    // runs first). Not Date.now(): a time sync sets the wall clock back, and a run measured across that
    // looked too short to be a timeout (T-147).
    let timedOut = false;
    const timeoutFlag = setTimeout(() => (timedOut = true), opts.timeoutMs);
    const child = (opts.spawnFn ?? spawn)(cmd.file, cmd.args, {
      windowsVerbatimArguments: cmd.windowsVerbatimArguments,
      env: opts.env ?? process.env,
      // Home, not the daemon's repo folder: a program that derives who is calling from its cwd
      // would otherwise take every call for the agent-tycoon orchestrator's.
      cwd: opts.cwd ?? os.homedir(),
      stdio: [opts.holdStdinMs || opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      shell: false,
      timeout: opts.timeoutMs,
      windowsHide: true,
    });
    opts.onSpawn?.(child);
    if (opts.signal?.aborted) child.kill?.();
    else opts.signal?.addEventListener('abort', () => child.kill?.(), { once: true });
    // The timeout only sends SIGTERM: a child that ignores it would hold the queue (and every later caller) for good.
    const killTimer = setTimeout(
      () => child.kill?.('SIGKILL'),
      opts.timeoutMs + (opts.killGraceMs ?? SPAWN_JSON_KILL_GRACE_MS),
    );
    const done = () => {
      clearTimeout(killTimer);
      clearTimeout(timeoutFlag);
    };
    child.on('exit', done);
    child.on('close', done);
    child.on('error', done);
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
    const stdin = child.stdin;
    if (stdin) {
      // EPIPE when the child is already gone, or any other stdin error: never the daemon's problem.
      stdin.on('error', () => undefined);
      const hold = setTimeout(() => stdin.end(), opts.holdStdinMs);
      const release = () => {
        clearTimeout(hold);
        stdin.destroy();
      };
      child.on('exit', release);
      child.on('close', release);
      child.on('error', release);
      if (opts.stdin !== undefined) {
        try {
          stdin.end(opts.stdin);
        } catch {
          child.kill();
        }
      }
    }
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
        json = opts.ndjson ? jsonLines(out) : JSON.parse(out);
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
          signal !== null && timedOut,
          errText,
        ),
      );
    });
  });
}
