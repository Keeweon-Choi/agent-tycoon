/**
 * The only place that runs `git` (FR-ENG-003, FR-ENG-005): the absolute path
 * found on PATH, an argv array, never a shell, stdin /dev/null, an explicit
 * absolute cwd, a timeout and an output cap. The environment is the daemon's
 * minus every variable that picks a repository (GIT_DIR ...), with prompts off
 * and git's messages in English (the Korean texts are ours).
 *
 * W2 fix: never the repository's own code on what the daemon does by itself or
 * an agent can trigger. Every call carries config overrides (through
 * GIT_CONFIG_COUNT, so a key may hold `=`): hooks and fsmonitor off, submodule
 * recursion off; and every call that may touch file content (touchesContent:
 * writes, checkout, status, diff) also switches off each filter driver the
 * repository side defines, read with `--show-scope --includes` in the call's
 * own folder (scopes `local` and `worktree`, so a linked worktree's
 * config.worktree too; `global`/`system` drivers such as git-lfs stay). The one
 * exception is `repoHooks` (the owner's confirmed commit and push from the
 * panel): git as the owner's terminal would run it, hooks and filters included,
 * in the sanitized environment.
 */
import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';

import { koText } from '../../../../../core/src/cld/serverText.js';
import { findOnPath } from '../../providers/claudeProvider.js';
import type { SpawnFn } from '../../spawnJson.js';

export const GIT_TIMEOUT_MS = 15_000;
export const GIT_MAX_BYTES = 4 * 1024 * 1024;
const STDERR_MAX = 8 * 1024;

/** Variables that make git work on some other repository than the cwd's. */
const REPO_SELECTING = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_QUARANTINE_PATH',
  // Command-scope config outranks GIT_CONFIG_COUNT, so it could restore hooks or filters.
  'GIT_CONFIG_PARAMETERS',
];

/** On every call (not `repoHooks`): the repository's hooks and fsmonitor never run, no submodule
 *  is entered, and no signature is checked (GIT-HARDEN: `log.showSignature` on `log` and
 *  `merge.verifySignatures` on `merge` run `gpg.program` for any signed commit). */
export const NO_REPO_CODE: ReadonlyArray<[string, string]> = [
  ['core.hooksPath', os.devNull],
  ['core.fsmonitor', 'false'],
  ['submodule.recurse', 'false'],
  ['diff.ignoreSubmodules', 'all'],
  ['log.showSignature', 'false'],
  ['merge.verifySignatures', 'false'],
];

/** GIT-HARDEN: no transport at all. In a partial clone (`extensions.partialClone`, written into
 *  .git/config) any read of a missing object (a ref an agent pointed at a made-up SHA) starts a
 *  lazy `git fetch` from the promisor remote: `ext::<cmd>`, `core.sshCommand`,
 *  `remote.*.uploadpack`. The repository's `protocol.<name>.allow` outranks a `protocol.allow`
 *  override; this list replaces both, and empty matches no protocol. None of these calls needs
 *  the network (push is `repoHooks`). */
export const NO_FETCH_ENV = { GIT_ALLOW_PROTOCOL: '' };

/** Subcommands that never read or write work-tree content, so never run a filter driver: the
 *  only calls that skip reading the repository's filter config first. */
const NO_CONTENT = new Set([
  'cat-file', 'check-ignore', 'config', 'for-each-ref', 'log', 'rev-list', 'rev-parse', 'show-ref',
  'symbolic-ref',
]);

/** `args` (after any leading `-c x` pairs) may run a filter driver: a write or checkout, and also
 *  `status`/`diff` (they clean files to compare them). `worktree list` does not. */
export function touchesContent(args: readonly string[]): boolean {
  let i = 0;
  while (args[i] === '-c') i += 2;
  const cmd = args[i];
  if (!cmd) return false;
  if (cmd === 'worktree') return args[i + 1] !== 'list';
  return !NO_CONTENT.has(cmd);
}

/** The repository side's filter (and, W3, merge) drivers in `git config --show-scope --includes --get-regexp`
 *  output (`<scope>\t<key> <value>`), each switched off: no smudge, clean or process command,
 *  not required. Scopes `local` and `worktree` only: the user's global and system ones stay. */
export function filterOverrides(configOut: string): Array<[string, string]> {
  const names = new Set<string>();
  const drivers = new Set<string>();
  for (const line of configOut.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const scope = line.slice(0, tab);
    if (scope !== 'local' && scope !== 'worktree') continue;
    const key = line.slice(tab + 1).split(' ', 1)[0] ?? '';
    const m = /^filter\.(.+)\.[^.]+$/is.exec(key);
    if (m) names.add(m[1]);
    // W3: a custom merge driver becomes `false` (run as `sh -c false`): that file is a conflict.
    const d = /^merge\.(.+)\.driver$/is.exec(key);
    if (d) drivers.add(d[1]);
  }
  return [
    ...[...names].flatMap((n): Array<[string, string]> => [
      [`filter.${n}.smudge`, ''],
      [`filter.${n}.clean`, ''],
      [`filter.${n}.process`, ''],
      [`filter.${n}.required`, 'false'],
    ]),
    ...[...drivers].map((n): [string, string] => [`merge.${n}.driver`, 'false']),
  ];
}

/** `pairs` as GIT_CONFIG_COUNT / KEY_n / VALUE_n, after the ones `env` already carries. */
export function configEnv(
  pairs: ReadonlyArray<readonly [string, string]>,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const had = Number(env.GIT_CONFIG_COUNT);
  const start = Number.isInteger(had) && had > 0 ? had : 0;
  const out: Record<string, string> = { GIT_CONFIG_COUNT: String(start + pairs.length) };
  pairs.forEach(([k, v], i) => {
    out[`GIT_CONFIG_KEY_${start + i}`] = k;
    out[`GIT_CONFIG_VALUE_${start + i}`] = v;
  });
  return out;
}

/** For reads: `git status` must not refresh (write) the index under a user's own git. */
export const READ_ENV = { GIT_OPTIONAL_LOCKS: '0' };
/** For commands that take client-chosen paths: no globs, no `:(magic)`. */
export const LITERAL_ENV = { GIT_LITERAL_PATHSPECS: '1' };

export interface GitResult {
  /** Exit code; null when git was killed (timeout, output cap). */
  code: number | null;
  stdout: Buffer;
  stderr: string;
  /** stdout reached `maxBytes`: git was killed and the output is cut. */
  capped: boolean;
  timedOut: boolean;
}

export interface GitOptions {
  timeoutMs?: number;
  /** Stop (and kill git) once this much stdout arrived. */
  maxBytes?: number;
  /** On top of the runner's environment. */
  env?: Record<string, string>;
  /** W2 (N7): the owner's confirmed commit or push from the panel: the repository's hooks and
   *  filters run as in the owner's terminal. Never for anything automatic or agent-triggered. */
  repoHooks?: boolean;
}

/** Run `git <args>` in `cwd` (absolute). Rejects only when git cannot be started. */
export type GitRunner = (cwd: string, args: string[], opts?: GitOptions) => Promise<GitResult>;

/** `git` as an absolute path, or null when it is not on PATH. */
export function findGit(envPath = process.env.PATH ?? ''): string | null {
  return findOnPath(process.platform === 'win32' ? 'git.exe' : 'git', envPath);
}

/** A failure whose message is a Korean sentence meant for the user; `code` (W2) an English word
 *  for the CLI and MCP (`exists`, `protected`, `in_progress`, `bad_name`, `no_base`). */
export class RepoError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export class GitMissingError extends RepoError {
  constructor() {
    super(koText('git_missing'));
  }
}

/** Git before 2.31 ignores the GIT_CONFIG_COUNT overrides that guard repository code. */
export class GitTooOldError extends RepoError {
  constructor(version: string) {
    super(koText('git_too_old', { version }));
  }
}

export function gitEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of REPO_SELECTING) delete env[key];
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    LC_MESSAGES: 'C',
    ...extra,
  };
}

export interface GitRunnerOptions {
  /** Default: `git` on PATH. null = not installed. */
  gitPath?: string | null;
  spawnFn?: SpawnFn;
  /** The base environment (tests pin git's config here). Default: process.env. */
  env?: NodeJS.ProcessEnv;
}

export function createGitRunner(o: GitRunnerOptions = {}): GitRunner {
  const gitPath = o.gitPath === undefined ? findGit() : o.gitPath;
  const raw: GitRunner = (cwd, args, opts = {}) =>
    new Promise((resolve, reject) => {
      if (!gitPath) return reject(new GitMissingError());
      // Never fall back to the daemon's own cwd, which may be a real repository.
      if (!path.isAbsolute(cwd)) return reject(new Error('git: cwd must be an absolute path'));
      const maxBytes = opts.maxBytes ?? GIT_MAX_BYTES;
      const child = (o.spawnFn ?? spawn)(gitPath, args, {
        cwd,
        env: gitEnv(o.env ?? process.env, opts.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let stderr = '';
      let capped = false;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, opts.timeoutMs ?? GIT_TIMEOUT_MS);
      child.stdout?.on('data', (b: Buffer) => {
        if (capped) return;
        chunks.push(b);
        size += b.length;
        if (size >= maxBytes) {
          capped = true;
          child.kill('SIGKILL');
        }
      });
      child.stderr?.on('data', (b: Buffer) => {
        if (stderr.length < STDERR_MAX) stderr += b.toString('utf-8');
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      // Killed: a hook or ssh still holding the pipes would delay 'close' until it exits too.
      child.on('exit', (_code, signal) => {
        if (signal) {
          child.stdout?.destroy();
          child.stderr?.destroy();
        }
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          code: capped || timedOut ? null : code,
          stdout: Buffer.concat(chunks),
          stderr: stderr.trim(),
          capped,
          timedOut,
        });
      });
    });
  const base = o.env ?? process.env;
  let versionCheck: Promise<void> | null = null;
  const requireSupportedGit = (opts: GitOptions): Promise<void> => {
    if (!versionCheck) {
      let definitive = false;
      const probe = raw(os.tmpdir(), ['version'], {
        ...(opts.timeoutMs !== undefined && { timeoutMs: opts.timeoutMs }),
        maxBytes: STDERR_MAX,
      }).then((r) => {
        const output = r.stdout.toString('utf-8').trim();
        const match = /^git version (\d+)\.(\d+)(?:\.[^\s(]+)?/i.exec(output);
        const version = match?.[0].slice('git version '.length) ?? 'unknown';
        if (!match || r.code !== 0) throw new GitTooOldError(version);
        definitive = true;
        if (Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 31))
          throw new GitTooOldError(version);
      });
      // A failed, timed-out or unparseable probe says nothing durable about this runner. Keep
      // only a definite supported/too-old result, so a transient failure cannot poison it.
      versionCheck = probe;
      void probe.catch(() => {
        if (!definitive && versionCheck === probe) versionCheck = null;
      });
    }
    return versionCheck;
  };
  return async (cwd, args, opts = {}) => {
    if (opts.repoHooks) return raw(cwd, args, opts);
    // Validate before caching the probe: an accidental relative cwd must not poison this runner.
    if (!path.isAbsolute(cwd)) return raw(cwd, args, opts);
    await requireSupportedGit(opts);
    const guard = (pairs: ReadonlyArray<readonly [string, string]>, extra: Record<string, string> = {}) => ({
      ...extra,
      ...NO_FETCH_ENV,
      ...configEnv(pairs, { ...base, ...extra }),
    });
    let filters: Array<[string, string]> = [];
    if (touchesContent(args)) {
      const r = await raw(cwd, ['config', '--show-scope', '--includes', '--get-regexp', '^(filter|merge)\\.'], {
        env: guard(NO_REPO_CODE, READ_ENV),
        maxBytes: 256 * 1024,
        ...(opts.timeoutMs !== undefined && { timeoutMs: opts.timeoutMs }),
      });
      // 1: no driver; 128: not a repository (the call itself then fails). Anything else (a broken
      // config, a timeout): the call does not run.
      if (r.code !== 0 && r.code !== 1 && r.code !== 128) return r;
      filters = filterOverrides(r.stdout.toString('utf-8'));
    }
    return raw(cwd, args, { ...opts, env: guard([...NO_REPO_CODE, ...filters], opts.env) });
  };
}
