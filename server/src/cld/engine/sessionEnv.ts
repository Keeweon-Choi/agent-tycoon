/**
 * Session environment helpers extracted from engine.ts (E1): preserve the
 * daemon's environment for every engine-started process.
 */
import * as fs from 'fs';
import * as path from 'path';

import { windowsLogonEnv, type WindowsLogonEnvironment } from '../agentCli.js';
import { WINDOWS_LOGIN_ENV } from '../chat.js';
import { findOnPath } from '../providers/claudeProvider.js';
import { appendMissing } from './sessionPath.js';

/** Kept from the daemon's environment: the user's, never a session's. */
const ENV_KEEP = ['HOME', 'PATH', 'LANG', 'USER', 'SHELL', 'TERM', 'XDG_RUNTIME_DIR'];
/** Not session state either, but nothing starts without them there. */
const ENV_KEEP_OS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: ['TMPDIR', 'LOGNAME'],
  win32: WINDOWS_LOGIN_ENV,
};

/** This checkout's cld/bin (the `cld-gui` CLI, T-0019): from dist/ or from server/src/cld/engine/. */
export const CLD_BIN_DIR: string | null =
  [path.resolve(__dirname, '..'), path.resolve(__dirname, '../../../..')]
    .map((root) => path.join(root, 'cld', 'bin'))
    .find((dir) => fs.existsSync(path.join(dir, 'cld-gui'))) ?? null;

export const cldBinPath = (dir: string, platform: NodeJS.Platform = process.platform): string =>
  path.join(dir, platform === 'win32' ? 'cld-gui.cmd' : 'cld-gui');

/**
 * The environment of everything the engine starts. With `binDir`, agents find
 * the cld-gui CLI whatever the user's shell config: CLD_BIN is its absolute
 * path and its folder comes first on PATH (T-0019). The CLI is a Node script
 * (`#!/usr/bin/env node`), so the daemon's own Node folder goes LAST (ENV-1):
 * a machine whose only Node is the one we ship still runs it, and a user's
 * own Node, when there is one, keeps coming first.
 */
export function cleanEnv(
  base: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform = process.platform,
  binDir: string | null = CLD_BIN_DIR,
  nodeDir: string = path.dirname(process.execPath),
  readWindowsLogonEnv: (env: NodeJS.ProcessEnv) => WindowsLogonEnvironment | null = windowsLogonEnv,
): NodeJS.ProcessEnv {
  const keep = new Set(
    [...ENV_KEEP, ...(ENV_KEEP_OS[platform] ?? [])].map((key) =>
      platform === 'win32' ? key.toUpperCase() : key,
    ),
  );
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    const key = platform === 'win32' ? k.toUpperCase() : k;
    if (v !== undefined && (keep.has(key) || key.startsWith('LC_'))) out[k] = v;
  }
  if (platform === 'win32') {
    const logon = readWindowsLogonEnv(base);
    if (logon) {
      // System, then user, then the session's own values (kept above) win, as a Windows logon builds it;
      // PATH is the registry's machine + user PATH (the machine's USERNAME is SYSTEM, so it must not win).
      for (const [key, value] of Object.entries(logon)) {
        const isPath = key.toUpperCase() === 'PATH';
        const kept = Object.keys(out).filter((existing) => existing.toUpperCase() === key.toUpperCase());
        if (kept.length && !isPath) continue;
        for (const existing of kept) delete out[existing];
        out[key] = value;
      }
    }
  }
  if (platform === 'win32')
    for (const key of Object.keys(out)) if (key.toUpperCase() === 'HOME') delete out[key];
  out.HOME = home;
  if (binDir) {
    if (platform === 'win32')
      for (const key of Object.keys(out)) if (key.toUpperCase() === 'CLD_BIN') delete out[key];
    out.CLD_BIN = cldBinPath(binDir, platform);
    const key = Object.keys(out).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    const sep = platform === 'win32' ? ';' : ':';
    out[key] = appendMissing(out[key] ? `${binDir}${sep}${out[key]}` : binDir, nodeDir, sep);
  }
  return out;
}

/** systemd-run when a user manager runs (Linux), else null. */
export function findSystemdRun(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== 'linux' || !env.XDG_RUNTIME_DIR) return null;
  if (!fs.existsSync(path.join(env.XDG_RUNTIME_DIR, 'systemd', 'private'))) return null;
  return findOnPath('systemd-run', env.PATH);
}
