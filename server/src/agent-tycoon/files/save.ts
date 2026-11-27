import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';

import { koText } from '../../../../core/src/agent-tycoon/serverText.js';
import { openContent } from './preview.js';
import { FileAccessError, relativeInside } from './roots.js';

/** The editor opens and saves text files up to this size (the plan's 1 MB). */
export const EDIT_MAX_BYTES = 1024 * 1024;

export const bytesHash = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

/** The file's bytes through the checked descriptor (the preview's path, sensitive and denylist rules), text only. */
function readChecked(fd: number, size: number): { bytes: Buffer; text: string } {
  if (size > EDIT_MAX_BYTES) throw new FileAccessError(koText('file_over_edit'), 413);
  const bytes = fs.readFileSync(fd);
  const text = bytes.toString('utf8');
  if (bytes.includes(0) || !Buffer.from(text, 'utf8').equals(bytes))
    throw new FileAccessError(koText('file_not_text'), 415);
  return { bytes, text };
}

/** A file's text and the hash a later save must present. */
export function readForEdit(root: string, relative: string, allowSensitive: boolean) {
  const { real, fd, size } = openContent(root, relative, allowSensitive);
  try {
    const { bytes, text } = readChecked(fd, size);
    return { path: relativeInside(root, real), text, hash: bytesHash(bytes) };
  } finally {
    fs.closeSync(fd);
  }
}

export type SaveResult =
  | { ok: true; path: string; hash: string; size: number }
  | { ok: false; path: string; hash: string };

/** Write `text` into the file only when it still has the hash it was opened with. The check runs on one
 * descriptor with no await before the write. The new bytes go to a temp file beside the real file (a
 * symbolic link stays, its target gets the text) with the old mode, then a rename: a failed or short
 * write leaves the old file whole. ponytail: another process can still write between the check and the
 * rename, and the rename gives the file a new inode (a hard link keeps the old text, the owner becomes
 * the daemon's); a lock file and fchown if either ever matters in practice. A folder swapped for a link
 * is caught on the temp file's descriptor and once more just before the rename; the window left is
 * between that last check and renameSync (Node has no renameat on a folder descriptor). A writable file
 * in a read-only folder, and on Windows a file held open without FILE_SHARE_DELETE, now fail to save
 * (the old file and the draft stay) where the in-place write used to succeed. */
export function saveEdit(
  root: string,
  relative: string,
  allowSensitive: boolean,
  text: string,
  baseHash: string,
): SaveResult {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > EDIT_MAX_BYTES) throw new FileAccessError(koText('file_over_edit'), 413);
  if (bytes.includes(0)) throw new FileAccessError(koText('file_not_text'), 415);
  // 'r+': a file the owner cannot write stays refused, as before.
  const { real, fd, size } = openContent(root, relative, allowSensitive, 'r+');
  const path = relativeInside(root, real);
  let mode: number;
  try {
    const current = bytesHash(readChecked(fd, size).bytes);
    if (current !== baseHash) return { ok: false, path, hash: current };
    mode = fs.fstatSync(fd).mode & 0o7777;
  } finally {
    fs.closeSync(fd);
  }
  const tmp = nodePath.join(
    nodePath.dirname(real),
    `.${nodePath.basename(real)}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`,
  );
  // The checked fd is closed, so a folder in the path swapped for a link since then would put the temp
  // file (and the rename) outside the root: check the temp file's own descriptor, as openContent does.
  const folder = nodePath.dirname(real);
  const folderMoved = () => fs.realpathSync(folder) !== folder;
  try {
    const out = fs.openSync(tmp, 'wx', mode);
    try {
      const escaped = process.platform === 'linux' ? fs.realpathSync(`/proc/self/fd/${out}`) !== tmp : folderMoved();
      if (escaped) throw new FileAccessError(koText('path_outside_project'));
      fs.writeFileSync(out, bytes); // loops until every byte is written, or throws
      fs.fchmodSync(out, mode); // the umask may have taken bits off
      fs.fsyncSync(out);
    } finally {
      fs.closeSync(out);
    }
    if (folderMoved()) throw new FileAccessError(koText('path_outside_project'));
    fs.renameSync(tmp, real);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  return { ok: true, path, hash: bytesHash(bytes), size: bytes.length };
}
