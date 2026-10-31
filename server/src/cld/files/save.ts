import { createHash } from 'node:crypto';
import * as fs from 'node:fs';

import { koText } from '../../../../core/src/cld/serverText.js';
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

/** Write `text` into the file only when it still has the hash it was opened with. The check and the
 * write run on one descriptor with no await between them. ponytail: another process can still write
 * between the check and the truncate; a lock file if that ever happens in practice. */
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
  const { real, fd, size } = openContent(root, relative, allowSensitive, 'r+');
  try {
    const current = bytesHash(readChecked(fd, size).bytes);
    const path = relativeInside(root, real);
    if (current !== baseHash) return { ok: false, path, hash: current };
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, bytes, 0, bytes.length, 0);
    fs.fsyncSync(fd);
    return { ok: true, path, hash: bytesHash(bytes), size: bytes.length };
  } finally {
    fs.closeSync(fd);
  }
}
