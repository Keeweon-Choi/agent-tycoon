import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ProjectFilePreview } from '../../../../core/src/cld/projectFiles.js';
import { koText } from '../../../../core/src/cld/serverText.js';
import { sensitiveFile } from './denylist.js';
import { blockedBelow, FileAccessError, relativeInside, resolveInside } from './roots.js';

export const PREVIEW_BYTES = 256 * 1024;
export const DOWNLOAD_BYTES = 50 * 1024 * 1024;

const image = new Set(['.png', '.jpg', '.jpeg', '.jfif', '.jpe', '.gif', '.webp', '.svg']);
const code = new Set([
  '.txt',
  '.log',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.css',
  '.scss',
  '.py',
  '.sh',
  '.sql',
  '.yaml',
  '.yml',
  '.xml',
  '.toml',
  '.ini',
  '.rs',
  '.go',
  '.java',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
]);
export type PreviewKind = ProjectFilePreview['kind'];

export function previewKind(file: string): PreviewKind {
  const ext = path.extname(file).toLowerCase();
  if (image.has(ext)) return 'image';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (code.has(ext)) return 'text';
  if (ext === '.csv') return 'csv';
  if (ext === '.json') return 'json';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.html' || ext === '.htm') return 'html';
  return 'download';
}

export function fileForContent(
  root: string,
  relative: string,
  allowSensitive: boolean,
): { real: string; size: number; kind: PreviewKind } {
  const real = resolveInside(root, relative);
  if (!allowSensitive && (sensitiveFile(relative) || sensitiveFile(real)))
    throw new FileAccessError(koText('sensitive_blocked'));
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new FileAccessError(koText('not_a_file'), 400);
  if (stat.size > DOWNLOAD_BYTES) throw new FileAccessError(koText('file_over_50'), 413);
  return { real, size: stat.size, kind: previewKind(relative) };
}

/** Keep the checked inode open while streaming, and close a replacement race:
 * on Linux the opened descriptor's own path is checked again; elsewhere (no
 * /proc) the checked path must still have no link in it and be the opened file. */
export function openContent(root: string, relative: string, allowSensitive: boolean) {
  const file = fileForContent(root, relative, allowSensitive);
  const fd = fs.openSync(file.real, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > DOWNLOAD_BYTES)
      throw new FileAccessError(koText('file_unreadable'));
    if (process.platform === 'linux') {
      const opened = fs.realpathSync(`/proc/self/fd/${fd}`);
      const inside = path.relative(root, opened);
      if (
        inside === '..' ||
        inside.startsWith(`..${path.sep}`) ||
        path.isAbsolute(inside) ||
        blockedBelow(root, opened) ||
        (!allowSensitive && sensitiveFile(opened))
      )
        throw new FileAccessError(koText('path_outside_project'));
    } else if (!sameFile(file.real, fs.fstatSync(fd, { bigint: true }))) {
      throw new FileAccessError(koText('path_outside_project'));
    }
    return { ...file, fd, size: stat.size };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

/** `real` still resolves to itself (no link swapped in) and is the file `opened` describes.
 *  BigInt stats: an NTFS file id above 2^53 would round as a Number and two files could compare equal. */
export function sameFile(real: string, opened: fs.BigIntStats): boolean {
  try {
    const now = fs.statSync(real, { bigint: true });
    return fs.realpathSync(real) === real && now.ino === opened.ino && now.dev === opened.dev;
  } catch {
    return false;
  }
}

export function previewFile(
  root: string,
  relative: string,
  allowSensitive: boolean,
): ProjectFilePreview {
  const { real, fd, size, kind } = openContent(root, relative, allowSensitive);
  try {
    if (kind === 'download') throw new FileAccessError(koText('preview_not_supported'), 415);
    const result: ProjectFilePreview = {
      path: relativeInside(root, real),
      kind,
      size,
      truncated: size > PREVIEW_BYTES,
    };
    if (['markdown', 'text', 'csv', 'json'].includes(kind)) {
      const buf = Buffer.alloc(Math.min(size, PREVIEW_BYTES));
      const count = fs.readSync(fd, buf, 0, buf.length, 0);
      result.text = buf.subarray(0, count).toString('utf8');
    }
    return result;
  } finally {
    fs.closeSync(fd);
  }
}

export function mimeType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return (
    (
      {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.jfif': 'image/jpeg',
        '.jpe': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf',
        '.html': 'text/html; charset=utf-8',
        '.htm': 'text/html; charset=utf-8',
      } as Record<string, string>
    )[ext] ?? 'application/octet-stream'
  );
}
