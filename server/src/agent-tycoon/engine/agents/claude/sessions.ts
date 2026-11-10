/**
 * Claude Code's own state on disk, read without spawning anything (T-0013's
 * budget: no `claude agents --json` loop).
 *
 * Live sessions: T-0013's reader of ~/.claude/sessions/<pid>.json (a live pid
 * with the same start time, spares skipped). Not `claude agents --json`: it
 * keeps listing, without a pid, background rows of sessions a reboot killed,
 * and `claude attach` on such a row resumes it (OQ-14 handoff §0-2).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { ClaudeSession } from '../../../providers/claudeProvider.js';
import { processAlive, sessionFromFile } from '../../../providers/claudeProvider.js';

/** kind 'background' (`id` = the job's id for `claude stop`) or 'interactive'. */
export type ClaudeLiveSession = ClaudeSession & { pid: number };

export const sessionsDir = (home = os.homedir()): string => path.join(home, '.claude', 'sessions');

export function readLiveSessions(home = os.homedir()): ClaudeLiveSession[] {
  const dir = sessionsDir(home);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: ClaudeLiveSession[] = [];
  for (const n of names) {
    let json: unknown;
    try {
      json = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf-8'));
    } catch {
      continue; // being written
    }
    const row = sessionFromFile(json, Number.parseInt(n, 10));
    if (row && row !== 'unknown') out.push(row as ClaudeLiveSession);
  }
  return out;
}

/**
 * A live process whose session file this build cannot read right now: caught
 * mid-rewrite, or a shape a newer Claude Code writes. readLiveSessions leaves
 * it out, so its project would look dead; the watch (T-0091) must not act then.
 */
export function unreadableLiveSession(home = os.homedir()): boolean {
  const dir = sessionsDir(home);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return false;
  }
  return names.some((n) => {
    const pid = Number.parseInt(n, 10);
    try {
      return (
        sessionFromFile(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf-8')), pid) === 'unknown'
      );
    } catch {
      return pid > 0 && processAlive(pid);
    }
  });
}

/** Variables that belong to some session, not to the user's environment. */
const SESSION_VAR = /^(CLAUDE)|^TMUX(_PANE)?$/;

/**
 * The running Claude daemon (~/.claude/daemon.lock; it hosts every background
 * session and keeps the environment of whoever started it) and the names of
 * the session variables it carries. Linux only (/proc); null when it is not
 * running or cannot be read. Values are never read out: tokens live there.
 */
export function daemonSessionVars(home = os.homedir()): { pid: number; vars: string[] } | null {
  let lock: { pid?: unknown; procStart?: unknown };
  try {
    lock = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'daemon.lock'), 'utf-8')) as {
      pid?: unknown;
    };
  } catch {
    return null;
  }
  const pid = lock.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (!processAlive(pid, typeof lock.procStart === 'string' ? lock.procStart : undefined))
    return null;
  let environ: string;
  try {
    environ = fs.readFileSync(`/proc/${pid}/environ`, 'latin1');
  } catch {
    return null;
  }
  const names = environ.split('\0').map((e) => e.slice(0, e.indexOf('=')));
  return { pid, vars: [...new Set(names.filter((n) => SESSION_VAR.test(n)))].sort() };
}
