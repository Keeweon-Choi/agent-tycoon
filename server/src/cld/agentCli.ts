/**
 * AGENT-CLI: finding the agent CLI (Claude Code) where its installers put it, not only on
 * the PATH the daemon was started with. A user who installs Claude Code after Agent Tycoon
 * has a daemon whose PATH never saw the new folder (on Windows the installer adds
 * %USERPROFILE%\.local\bin to the user PATH, which a running process does not re-read).
 */
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// The 10 s version-probe timeout lives in server/src/constants.ts (constants policy).
import { AGENT_CLI_VERSION_TIMEOUT_MS, WINDOWS_LOGON_ENV_CACHE_MS } from '../constants.js';

/** Where `claude` lives when the installer's PATH change did not reach this process. */
export const claudeInstallDirs = (
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv,
): string[] => {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const prefix = env.npm_config_prefix || env.NPM_CONFIG_PREFIX;
  return [
    p.join(home, '.local', 'bin'),
    p.join(home, '.claude', 'local'),
    ...(prefix ? [platform === 'win32' ? prefix : p.join(prefix, 'bin')] : []),
    ...(platform === 'win32'
      ? [p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), 'npm')]
      : [p.join(home, '.npm-global', 'bin'), '/usr/local/bin', '/opt/homebrew/bin']),
  ];
};

/** Reads Windows's machine and user environment registry values as one UTF-8 JSON document.
 *  Tests inject this instead of starting PowerShell. */
export type WindowsRegistryQuery = () => string;

const queryWindowsRegistry: WindowsRegistryQuery = () => {
  const powershell = path.win32.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  return execFileSync(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8;[PSCustomObject]@{Machine=[Environment]::GetEnvironmentVariables('Machine');User=[Environment]::GetEnvironmentVariables('User')}|ConvertTo-Json -Compress",
    ],
    {
    encoding: 'utf8',
    timeout: 3_000,
    windowsHide: true,
    },
  );
};

type WindowsRegistryEnvironment = { machine: Record<string, string>; user: Record<string, string> };
export type WindowsLogonEnvironment = Record<string, string>;

const windowsEnvironmentValue = (env: NodeJS.ProcessEnv, name: string): string | undefined =>
  Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

const objectOfStrings = (value: unknown): Record<string, string> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') return null;
    out[key] = entry;
  }
  return out;
};

const parseWindowsRegistryEnvironment = (json: string): WindowsRegistryEnvironment | null => {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const { Machine, User } = parsed as { Machine?: unknown; User?: unknown };
    const machine = objectOfStrings(Machine);
    const user = objectOfStrings(User);
    return machine && user ? { machine, user } : null;
  } catch {
    return null;
  }
};

const logonEnvironmentCache = new WeakMap<
  WindowsRegistryQuery,
  { until: number; value: WindowsRegistryEnvironment | null }
>();

const readWindowsRegistryEnvironment = (
  query: WindowsRegistryQuery,
): WindowsRegistryEnvironment | null => {
  const now = Date.now();
  const cached = logonEnvironmentCache.get(query);
  if (cached && cached.until > now) return cached.value;
  let value: WindowsRegistryEnvironment | null = null;
  try {
    value = parseWindowsRegistryEnvironment(query());
  } catch {
    /* The daemon's own environment remains the safe fallback. */
  }
  logonEnvironmentCache.set(query, { until: now + WINDOWS_LOGON_ENV_CACHE_MS, value });
  return value;
};

const setWindowsEnvironmentValue = (
  out: Record<string, string>,
  key: string,
  value: string,
): void => {
  for (const existing of Object.keys(out))
    if (existing.toLowerCase() === key.toLowerCase()) delete out[existing];
  out[key] = value;
};

/** A new Windows logon's registry environment, with the user values taking precedence. */
export function windowsLogonEnv(
  base: NodeJS.ProcessEnv = process.env,
  query: WindowsRegistryQuery = queryWindowsRegistry,
): WindowsLogonEnvironment | null {
  void base; // Kept in the public API so callers provide the same fallback context as windowsLogonPath.
  const registry = readWindowsRegistryEnvironment(query);
  if (!registry) return null;
  const out: WindowsLogonEnvironment = {};
  for (const [key, value] of Object.entries(registry.machine)) setWindowsEnvironmentValue(out, key, value);
  for (const [key, value] of Object.entries(registry.user)) setWindowsEnvironmentValue(out, key, value);
  const machinePath = Object.entries(registry.machine).find(([key]) => key.toLowerCase() === 'path');
  const userPath = Object.entries(registry.user).find(([key]) => key.toLowerCase() === 'path');
  if (machinePath || userPath) {
    for (const key of Object.keys(out)) if (key.toLowerCase() === 'path') delete out[key];
    out[userPath?.[0] ?? machinePath![0]] = [machinePath?.[1], userPath?.[1]]
      .filter((value): value is string => value !== undefined)
      .join(';');
  }
  return out;
}

/** The user PATH as Windows keeps it (HKCU\Environment); '' when unreadable. */
export function readWindowsUserPath(
  env: NodeJS.ProcessEnv = process.env,
  query: WindowsRegistryQuery = queryWindowsRegistry,
): string {
  void env;
  return windowsEnvironmentValue(readWindowsRegistryEnvironment(query)?.user ?? {}, 'Path') ?? '';
}

/** The machine PATH as Windows keeps it; '' when unreadable. */
export function readWindowsMachinePath(
  env: NodeJS.ProcessEnv = process.env,
  query: WindowsRegistryQuery = queryWindowsRegistry,
): string {
  void env;
  return windowsEnvironmentValue(readWindowsRegistryEnvironment(query)?.machine ?? {}, 'Path') ?? '';
}

/** A new Windows logon's PATH, or this daemon's PATH if the registry cannot be read. */
export function windowsLogonPath(
  env: NodeJS.ProcessEnv = process.env,
  query: WindowsRegistryQuery = queryWindowsRegistry,
): string {
  return windowsEnvironmentValue(windowsLogonEnv(env, query) ?? {}, 'Path') ??
    windowsEnvironmentValue(env, 'PATH') ??
    '';
}

export interface FindClaudeDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  /** Windows only; read once per call. */
  userPath?: () => string;
  /** Candidate files in search order. Tests inject these so they never start a CLI. */
  candidates?: (dirs: string[], platform: NodeJS.Platform, pathExt: string) => string[];
  /** Runs the version probe. Tests inject this so they never start a CLI. */
  runVersion?: ClaudeVersionRunner;
  log?: (line: string) => void;
}

export interface ClaudeVersionResult {
  exitCode: number | null;
  stdout: string;
  timedOut?: boolean;
}

export type ClaudeVersionRunner = (
  candidate: string,
  invocation: ClaudeVersionInvocation,
) => ClaudeVersionResult;

export interface ClaudeVersionInvocation {
  command: string;
  args: string[];
  timeout: number;
  env: NodeJS.ProcessEnv;
  /** Windows: pass `args` to cmd.exe as written (Node's own `shell: true` does the same). */
  verbatim?: boolean;
}

/** Every executable candidate in the same order `findOnPath` would inspect. */
export function claudeCandidates(
  dirs: string[],
  platform: NodeJS.Platform,
  pathExt = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
): string[] {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const names =
    platform === 'win32'
      ? pathExt
          .split(';')
          .filter(Boolean)
          .map((extension) => `claude${extension.toLowerCase()}`)
      : ['claude'];
  const seen = new Set<string>();
  const found: string[] = [];
  for (const dir of dirs) {
    if (!p.isAbsolute(dir)) continue;
    for (const name of names) {
      const file = p.join(dir, name);
      const key = platform === 'win32' ? file.toLowerCase() : file;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        fs.accessSync(file, fs.constants.X_OK);
        if (fs.statSync(file).isFile()) found.push(file);
      } catch {
        /* next possible executable */
      }
    }
  }
  return found;
}

/** Store aliases in WindowsApps are executable-looking files, never Claude Code. */
const isWindowsAppsAlias = (candidate: string): boolean =>
  path.win32.normalize(candidate).toLowerCase().includes('\\microsoft\\windowsapps\\');

const versionInvocation = (
  candidate: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ClaudeVersionInvocation => {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(candidate))
    return { command: candidate, args: ['--version'], timeout: AGENT_CLI_VERSION_TIMEOUT_MS, env };
  // cmd.exe receives a quoted path; never interpolate an unquoted candidate into its command string.
  // Verbatim, as Node's `shell: true` does: `/d /s /c ""C:\...\claude.cmd" --version"` (/s strips the
  // outer pair). Left to Node's own quoting the inner quotes became \", which cmd.exe does not read,
  // and a working npm install (claude.cmd) was refused.
  const quotedPath = `"${candidate.replaceAll('"', '""')}"`;
  return {
    command: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${quotedPath} --version"`],
    timeout: AGENT_CLI_VERSION_TIMEOUT_MS,
    env,
    verbatim: true,
  };
};

const runClaudeVersion: ClaudeVersionRunner = (_candidate, invocation) => {
  // spawnSync: execFileSync's options type has no windowsVerbatimArguments
  const r = spawnSync(invocation.command, invocation.args, {
    encoding: 'utf8',
    env: invocation.env,
    timeout: invocation.timeout,
    windowsHide: true,
    windowsVerbatimArguments: invocation.verbatim === true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  return { exitCode: r.status, stdout: r.stdout ?? '', timedOut: code === 'ETIMEDOUT' };
};

const rejectionReason = (result: ClaudeVersionResult): string => {
  if (result.timedOut) return `timed out after ${AGENT_CLI_VERSION_TIMEOUT_MS} ms`;
  if (result.exitCode !== 0) return `exited ${result.exitCode ?? 'without an exit code'}`;
  return 'version output did not identify Claude Code';
};

/** The absolute path of `claude`: the daemon's PATH first, then (Windows) the user PATH from the
 *  registry, then the usual install folders. Each candidate must prove it is Claude Code. */
export function findClaude(deps: FindClaudeDeps = {}): string | null {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const home = deps.home ?? env.HOME ?? env.USERPROFILE ?? '';
  const dirs = [
    ...(env.PATH ?? '').split(p.delimiter),
    ...(platform === 'win32'
      ? (deps.userPath ?? (() => readWindowsUserPath(env)))().split(';')
      : []),
    ...claudeInstallDirs(platform, home, env),
  ].filter(Boolean);
  const candidates = (deps.candidates ?? claudeCandidates)(
    dirs,
    platform,
    env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
  );
  const runVersion = deps.runVersion ?? runClaudeVersion;
  const log = deps.log ?? console.log;
  for (const candidate of candidates) {
    if (platform === 'win32' && isWindowsAppsAlias(candidate)) {
      log(
        `[cld] agent CLI: ${candidate} is not a working Claude Code (WindowsApps store alias), skipped`,
      );
      continue;
    }
    const result = runVersion(candidate, versionInvocation(candidate, platform, env));
    if (
      result.exitCode === 0 &&
      result.stdout.split(/\r?\n/).some((line) => /\(Claude Code\)/.test(line))
    )
      return candidate;
    log(
      `[cld] agent CLI: ${candidate} is not a working Claude Code (${rejectionReason(result)}), skipped`,
    );
  }
  return null;
}

/** The one-line installer for this daemon's OS (claude.ai/install). */
export const claudeInstallCommand = (platform: NodeJS.Platform): string =>
  platform === 'win32'
    ? 'irm https://claude.ai/install.ps1 | iex'
    : 'curl -fsSL https://claude.ai/install.sh | bash && { case "$SHELL:$(uname)" in */zsh:*) p="$HOME/.zprofile";; */bash:Darwin) p="$HOME/.bash_profile";; *) p="$HOME/.profile";; esac; grep -q \'\\.local/bin\' "$p" 2>/dev/null || printf \'%s\\n\' \'export PATH="$HOME/.local/bin:$PATH" # Added by Agent Tycoon (Claude Code)\' >> "$p"; export PATH="$HOME/.local/bin:$PATH"; claude auth status >/dev/null 2>&1 || claude auth login; }';
