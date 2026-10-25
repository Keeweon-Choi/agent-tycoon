import * as fs from 'node:fs';
import * as path from 'node:path';

import { koText } from '../../../../core/src/cld/serverText.js';
import { excludeLine } from '../engine/codex.js';
import { FileAccessError } from './roots.js';

export const ATTACH_MAX = 20 * 1024 * 1024;
const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;
export const TEXT_EXT = new Set([
  '.txt',
  '.md',
  '.csv',
  '.json',
  '.log',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cs',
  '.sh',
  '.bash',
  '.zsh',
  '.css',
  '.html',
  '.xml',
  '.yaml',
  '.yml',
  '.sql',
  '.toml',
]);
export const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg', // Windows saves some JPEGs as .jfif (user 10-22 17:59)
  '.jpe': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export type StoredType = { type: string; magic: (body: Buffer) => boolean };
const begins = (signature: number[]) => (body: Buffer) =>
  body.subarray(0, signature.length).every((byte, index) => byte === signature[index]);
const zipFile = begins([0x50, 0x4b, 0x03, 0x04]);
const oleFile = begins([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/** Binary files stored for the lead to inspect, rather than opened by the server. */
export const STORED_TYPES: Record<string, StoredType> = {
  '.zip': {
    type: 'application/zip',
    magic: (body) => zipFile(body) || begins([0x50, 0x4b, 0x05, 0x06])(body),
  },
  '.7z': { type: 'application/x-7z-compressed', magic: begins([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) },
  '.tar': {
    type: 'application/x-tar',
    magic: (body) => body.subarray(257, 262).equals(Buffer.from('ustar')),
  },
  '.gz': { type: 'application/gzip', magic: begins([0x1f, 0x8b]) },
  '.tgz': { type: 'application/gzip', magic: begins([0x1f, 0x8b]) },
  '.docx': {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    magic: zipFile,
  },
  '.xlsx': {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    magic: zipFile,
  },
  '.pptx': {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    magic: zipFile,
  },
  '.odt': { type: 'application/vnd.oasis.opendocument.text', magic: zipFile },
  '.ods': { type: 'application/vnd.oasis.opendocument.spreadsheet', magic: zipFile },
  '.odp': { type: 'application/vnd.oasis.opendocument.presentation', magic: zipFile },
  '.hwpx': { type: 'application/hwp+zip', magic: zipFile },
  '.doc': { type: 'application/msword', magic: oleFile },
  '.xls': { type: 'application/vnd.ms-excel', magic: oleFile },
  '.ppt': { type: 'application/vnd.ms-powerpoint', magic: oleFile },
  '.hwp': { type: 'application/x-hwp', magic: oleFile },
  '.rtf': { type: 'application/rtf', magic: begins([0x7b, 0x5c, 0x72, 0x74, 0x66]) },
};

/** Whether a stored binary file's content has the signature its extension requires. */
export function hasStoredMagic(name: string, body: Buffer): boolean {
  const stored = STORED_TYPES[path.extname(name).toLowerCase()];
  return !!stored && stored.magic(body);
}

export function safeAttachmentName(input: string): string {
  if (!input || input.includes('/') || input.includes('\\') || input.includes('\0'))
    throw new FileAccessError(koText('file_name_invalid'), 400);
  const cleaned = input.replace(/[^A-Za-z0-9가-힣._-]/g, '_');
  const possibleExt = path.extname(cleaned);
  const ext = possibleExt.length <= 16 ? possibleExt : '';
  const name = cleaned.length > 80 ? `${cleaned.slice(0, 80 - ext.length)}${ext}` : cleaned;
  if (!name || name.startsWith('.') || name === '..')
    throw new FileAccessError(koText('file_name_invalid'), 400);
  return name;
}

export function attachmentType(name: string, declared: string): string {
  const ext = path.extname(name).toLowerCase();
  const type = declared.toLowerCase().split(';')[0].trim();
  if (STORED_TYPES[ext]) return STORED_TYPES[ext].type;
  if (IMAGE_TYPES[ext] === type) return type;
  if (ext === '.pdf' && type === 'application/pdf') return type;
  if (
    TEXT_EXT.has(ext) &&
    (type.startsWith('text/') ||
      [
        'application/json',
        'application/xml',
        'application/javascript',
        'application/x-javascript',
        'application/typescript',
        'application/x-typescript',
        'application/x-sh',
        'application/x-python-code',
        'application/octet-stream',
      ].includes(type))
  )
    return type;
  throw new FileAccessError(koText('attach_type_unsupported'), 415);
}

export function inbox(root: string, create: boolean, name = '.cld-inbox'): string {
  const dir = path.join(root, name);
  if (create) {
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  if (fs.existsSync(dir)) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new FileAccessError(koText('attach_folder_unusable'));
  }
  return dir;
}

export function cleanOldAttachments(root: string, now = Date.now()): void {
  // The outbox's copies (T-0105) age out too; a copy still wanted is made again from its source.
  for (const name of ['.cld-inbox', '.cld-outbox']) {
    const dir = inbox(root, false, name);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const file = path.join(dir, entry);
      const stat = fs.lstatSync(file);
      if (stat.isFile() && now - stat.mtimeMs > RETAIN_MS) fs.unlinkSync(file);
    }
  }
}

export function storeAttachment(
  root: string,
  name: string,
  type: string,
  body: Buffer,
  now = Date.now(),
) {
  const safe = safeAttachmentName(name);
  const accepted = attachmentType(safe, type);
  if (body.length > ATTACH_MAX)
    throw new FileAccessError(koText('attach_too_large'), 413);
  if (STORED_TYPES[path.extname(safe).toLowerCase()] && !hasStoredMagic(safe, body))
    throw new FileAccessError(koText('attach_type_mismatch'), 415);
  const dir = inbox(root, true);
  const date = new Date(now);
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`;
  let file = '';
  for (let n = 0; n < 100; n++) {
    const suffix = n ? `-${n}` : '';
    file = path.join(dir, `${stamp}-${suffix}${safe}`);
    try {
      const fd = fs.openSync(
        file,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
      let writeError: unknown;
      try {
        fs.writeFileSync(fd, body);
      } catch (error) {
        writeError = error;
      } finally {
        fs.closeSync(fd);
      }
      if (writeError) {
        fs.unlinkSync(file);
        throw writeError;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (n === 99) throw new FileAccessError(koText('attach_name_failed'), 409);
    }
  }
  excludeLine(root, '.cld-inbox/');
  return { path: file, name: safe, size: body.length, type: accepted };
}
