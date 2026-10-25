/**
 * The PATH sessions and jobs get. The engine runs under a service manager
 * whose PATH is short: no Windows directories (curl.exe, powershell.exe on
 * WSL), nothing the login shell adds (cuda, /usr/sbin). Built once at engine
 * start; any failure leaves today's PATH alone.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type Run = (
  file: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
) => string | null;

export interface SessionPathOptions {
  /** cld-gui's bin dir; goes first. */
  binDir: string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** stdout of a command, or null when it failed or timed out. Never a shell. */
  run?: Run;
  isDir?: (p: string) => boolean;
  exists?: (p: string) => boolean;
}

const TIMEOUT_MS = 3000;
const WSL_INTEROP = '/proc/sys/fs/binfmt_misc/WSLInterop';
const WSL_CMD = '/mnt/c/Windows/System32/cmd.exe';
const WSL_LIB = '/usr/lib/wsl/lib';

const realRun: Run = (file, args, opts) => {
  try {
    return execFileSync(file, args, {
      ...opts,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
};

const isDirReal = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** `C:\Program Files\nodejs\` -> `/mnt/c/Program Files/nodejs`; null for anything else (UNC, relative, %VAR%). */
export function windowsToWsl(entry: string): string | null {
  const e = entry.trim().replace(/^"(.*)"$/, '$1');
  if (!e || e.includes('%')) return null;
  const m = /^([A-Za-z]):[\\/]*(.*)$/.exec(e);
  if (!m) return null;
  const rest = m[2].replace(/\\/g, '/').replace(/\/+$/, '');
  return `/mnt/${m[1].toLowerCase()}${rest ? `/${rest}` : ''}`;
}

/** `base` then the entries of `extra` it lacks, in order, without repeats. */
export function appendMissing(
  base: string | undefined,
  extra: string | undefined,
  sep: string = path.delimiter,
): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of [...(base ?? '').split(sep), ...(extra ?? '').split(sep)])
    if (e && !seen.has(e)) {
      seen.add(e);
      out.push(e);
    }
  return out.join(sep);
}

/**
 * bin dir, then the login shell's PATH, then (WSL only) the Windows PATH and
 * /usr/lib/wsl/lib; null when nothing could be added beyond the bin dir.
 */
export function buildSessionPath(o: SessionPathOptions): string | null {
  if ((o.platform ?? process.platform) !== 'linux') return null;
  try {
    const env = o.env ?? process.env;
    const run = o.run ?? realRun;
    const isDir = o.isDir ?? isDirReal;
    const exists = o.exists ?? fs.existsSync;
    const parts: string[] = o.binDir ? [o.binDir] : [];
    const added: string[] = [];
    const login = run('bash', ['-lc', 'printf %s "$PATH"'], {
      env: { HOME: env.HOME, USER: env.USER, SHELL: env.SHELL, PATH: env.PATH },
    });
    // A profile may print before the printf: PATH is the last line.
    const loginPath = login?.trim().split('\n').pop() ?? '';
    added.push(...loginPath.split(':').filter((e) => e.startsWith('/')));
    if (exists(WSL_INTEROP) || exists(WSL_CMD)) {
      const raw = run(WSL_CMD, ['/d', '/c', 'echo %PATH%'], { cwd: '/mnt/c/Windows', env });
      for (const e of raw?.trim().split(';') ?? []) {
        const p = windowsToWsl(e);
        if (p && isDir(p)) added.push(p);
      }
      if (isDir(WSL_LIB)) added.push(WSL_LIB);
    }
    if (!added.length) return null;
    return appendMissing([...parts, ...added].join(':'), '', ':');
  } catch {
    return null;
  }
}
