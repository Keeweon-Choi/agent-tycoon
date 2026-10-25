/**
 * Files the lead sends (T-0105): a `SendUserFile` call's `files`, or a
 * `[첨부] <absolute path>` line in its own text. The server never serves the
 * source: it copies it once into `<project>/.cld-outbox/` (git-excluded,
 * 0700/0600) and the file tickets serve only that copy.
 *
 * The copy's name is `<mtime date>-<hash of source path + mtime>-<name>`, so
 * "copied once, remembered by source path and mtime" needs no table and holds
 * across daemon restarts: the same source and mtime name the same copy, which
 * is reused when it is already there; an edited source is a new copy.
 */
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ChatAttachment } from '../../../../core/src/messages.js';
import { normalizeProjectPath } from '../../../../core/src/normalizeProjectPath.js';
import { excludeLine } from '../engine/codex.js';
import {
  ATTACH_MAX,
  IMAGE_TYPES,
  inbox,
  safeAttachmentName,
  STORED_TYPES,
  TEXT_EXT,
} from './attachments.js';
import { sensitiveFile } from './denylist.js';
import { forbiddenAbsolutePath } from './security.js';

export const OUTBOX = '.cld-outbox';
/** Files one message may carry. */
export const SENT_MAX = 10;

export function typeOf(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_TYPES[ext]) return IMAGE_TYPES[ext];
  if (ext === '.pdf') return 'application/pdf';
  if (STORED_TYPES[ext]) return STORED_TYPES[ext].type;
  return TEXT_EXT.has(ext) ? 'text/plain' : 'application/octet-stream';
}

const stamp = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};

const under = (child: string, parent: string, sep = path.sep) =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * A Windows UNC or device path (`\\host\share`, `\\.\pipe\x`, `\\?\C:\x`) outside the project
 * folder: opening it at all would reach another machine (SMB, with this user's credentials) or a
 * device before any folder check runs, so it is refused first. A project on `\\wsl.localhost` keeps its own files.
 */
export const uncOutside = (from: string, dir: string, sep = path.sep): boolean =>
  /^[\\/]{2}/.test(from) && !under(from, dir, sep);

/** The project's git worktrees (the main one included); [] when it is not a repo. */
function worktrees(dir: string): string[] {
  const g = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: dir,
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (g.status !== 0) return [];
  return g.stdout
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length));
}

/**
 * Where a sent file may come from: the lead's project folder, its git
 * worktrees, and Claude Code's scratchpad for it (`<tmp>/claude-<uid>/<project
 * key>/`, where screenshots land). The transcript is written by the agent and by
 * whatever it read (a fetched page can make it print a `[첨부]` line), and the
 * copy is shown to every logged-in device, so a path elsewhere (another
 * project, ~, /proc/self/environ) is never copied. Real paths on both sides.
 */
function allowedSource(dir: string, real: string): boolean {
  const inside = (root: string) => {
    try {
      return under(real, fs.realpathSync(root));
    } catch {
      return false;
    }
  };
  const uid = process.getuid?.();
  const pads =
    uid === undefined
      ? []
      : [dir, fs.realpathSync(dir)].map((d) =>
          path.join(os.tmpdir(), `claude-${uid}`, normalizeProjectPath(d)),
        );
  // git only for a file outside the folder itself (a worktree's), not on every read.
  return inside(dir) || pads.some(inside) || worktrees(dir).some(inside);
}

const gone = (source: string): ChatAttachment => ({
  name:
    path
      .basename(source)
      .replace(/\p{Cc}/gu, '')
      .slice(0, 80) || '파일',
  unavailable: true,
});

/**
 * The attachment for one file a lead sent. `dir` is the lead's project folder
 * as the clients know it (the returned path lies under it); a relative source
 * is relative to it, like Claude Code's own cwd. Never throws: whatever stops
 * the copy (missing, too big, a symlink, a directory, a protected path) is an
 * `unavailable` entry and no file.
 */
export function sendOutbox(dir: string, source: string): ChatAttachment {
  try {
    if (!path.isAbsolute(dir) || source.includes('\0')) return gone(source);
    const from = path.resolve(dir, source);
    if (uncOutside(from, path.resolve(dir)) || forbiddenAbsolutePath(from) || sensitiveFile(from)) return gone(from);
    const name = safeAttachmentName(path.basename(from));
    // O_NOFOLLOW: a symlink as the file itself is refused. O_NONBLOCK: a FIFO cannot hang the daemon.
    const fd = fs.openSync(
      from,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    let body: Buffer;
    let mtimeMs: number;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > ATTACH_MAX) return gone(from);
      // Checked on the file actually opened: its real path (a symlinked folder
      // anywhere on the way is resolved) is the same inode, outside every
      // protected folder and inside the project's own places.
      const real = fs.realpathSync(from);
      const there = fs.statSync(real);
      if (
        there.ino !== stat.ino ||
        there.dev !== stat.dev ||
        forbiddenAbsolutePath(real) ||
        sensitiveFile(real) ||
        !allowedSource(dir, real)
      )
        return gone(from);
      mtimeMs = stat.mtimeMs;
      const copy = path.join(
        dir,
        OUTBOX,
        `${stamp(mtimeMs)}-${crypto.createHash('sha1').update(`${from}\0${mtimeMs}`).digest('hex').slice(0, 8)}-${name}`,
      );
      const held = reuse(dir, copy);
      if (held !== null) return made(copy, name, held);
      body = fs.readFileSync(fd);
      if (body.length > ATTACH_MAX) return gone(from);
      return made(copy, name, write(dir, copy, body));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return gone(source);
  }
}

const made = (copy: string, name: string, size: number): ChatAttachment => ({
  name,
  path: copy,
  type: typeOf(name),
  sizeKb: Math.ceil(size / 1024),
});

/** The size of the copy already made, or null (none; a symlink or a non-file there counts as none). */
function reuse(dir: string, copy: string): number | null {
  inbox(dir, false, OUTBOX);
  try {
    const stat = fs.lstatSync(copy);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

/** Write via a temp name and rename, so a crash never leaves a half copy under the final name. */
function write(dir: string, copy: string, body: Buffer): number {
  inbox(dir, true, OUTBOX);
  const tmp = path.join(
    path.dirname(copy),
    `.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
  );
  const fd = fs.openSync(
    tmp,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(fd, body);
  } catch (error) {
    fs.closeSync(fd);
    fs.unlinkSync(tmp);
    throw error;
  }
  fs.closeSync(fd);
  fs.renameSync(tmp, copy);
  excludeLine(dir, `${OUTBOX}/`);
  return body.length;
}

/** A lead's text without its `[첨부] <path>` lines, and those paths (an optional `(type, N KB)` tail is dropped). */
export function sentLines(text: string): { text: string; paths: string[] } {
  const paths: string[] = [];
  const kept = text.split('\n').filter((line) => {
    // An absolute path: POSIX, a Windows drive (C:\...) or UNC (\\wsl.localhost\...).
    const m = /^\[첨부\] ((?:\/|[A-Za-z]:[\\/]|\\\\)[^\n]*?)(?: \([^(),]+, \d+ KB\))?\s*$/.exec(line);
    if (!m) return true;
    paths.push(m[1]);
    return false;
  });
  return { text: kept.join('\n').trim(), paths };
}
