/**
 * AGENT-CLI: finding the agent CLI (Claude Code) where its installers put it, not only on
 * the PATH the daemon was started with. A user who installs Claude Code after Agent Tycoon
 * has a daemon whose PATH never saw the new folder (on Windows the installer adds
 * %USERPROFILE%\.local\bin to the user PATH, which a running process does not re-read).
 */
import { execFileSync } from 'child_process';
import * as path from 'path';

import { findOnPath } from './providers/claudeProvider.js';

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

/** The user PATH as Windows keeps it (HKCU\Environment), %VARS% expanded; '' when unreadable. */
export function readWindowsUserPath(env: NodeJS.ProcessEnv = process.env): string {
  try {
    const out = execFileSync('reg.exe', ['query', 'HKCU\\Environment', '/v', 'Path'], {
      encoding: 'utf8',
      timeout: 3_000,
      windowsHide: true,
    });
    const value = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(out)?.[1]?.trim() ?? '';
    return value.replace(/%([^%]+)%/g, (all, name: string) => env[name] ?? all);
  } catch {
    return '';
  }
}

export interface FindClaudeDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  /** Windows only; read once per call. */
  userPath?: () => string;
  find?: typeof findOnPath;
}

/** The absolute path of `claude`: the daemon's PATH first, then (Windows) the user PATH from the
 *  registry, then the usual install folders. Null when none holds one. */
export function findClaude(deps: FindClaudeDeps = {}): string | null {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const find = deps.find ?? findOnPath;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const home = deps.home ?? env.HOME ?? env.USERPROFILE ?? '';
  const dirs = [
    ...(env.PATH ?? '').split(p.delimiter),
    ...(platform === 'win32' ? (deps.userPath ?? (() => readWindowsUserPath(env)))().split(';') : []),
    ...claudeInstallDirs(platform, home, env),
  ].filter(Boolean);
  return find('claude', dirs.join(p.delimiter), platform);
}

/** The one-line installer for this daemon's OS (claude.ai/install). */
export const claudeInstallCommand = (platform: NodeJS.Platform): string =>
  platform === 'win32'
    ? 'irm https://claude.ai/install.ps1 | iex'
    : 'curl -fsSL https://claude.ai/install.sh | bash';
