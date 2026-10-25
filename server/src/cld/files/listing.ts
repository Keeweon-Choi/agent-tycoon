import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ProjectFileEntry, ProjectFileList } from '../../../../core/src/cld/projectFiles.js';
import { koText } from '../../../../core/src/cld/serverText.js';
import { FileAccessError, relativeInside, resolveInside } from './roots.js';
import { forbiddenFilePath } from './security.js';

export const LIST_LIMIT = 1000;
export const PAGE_SIZE = 200;

export function listFiles(
  root: string,
  relative = '',
  offset = 0,
  hidden = false,
  limit = PAGE_SIZE,
): ProjectFileList {
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new FileAccessError(koText('page_number_invalid'), 400);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_LIMIT)
    throw new FileAccessError(koText('page_size_invalid'), 400);
  const dir = resolveInside(root, relative);
  if (!fs.statSync(dir).isDirectory()) throw new FileAccessError(koText('folder_not_dir'), 400);
  const entries: ProjectFileEntry[] = [];
  const names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) =>
        !forbiddenFilePath(path.join(relative, entry.name)) &&
        (hidden || !entry.name.startsWith('.')),
    )
    .sort(
      (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
    );
  let cursor = offset;
  for (; cursor < names.length && entries.length < limit; cursor++) {
    const name = names[cursor].name;
    try {
      const real = resolveInside(root, path.join(relative, name).split(path.sep).join('/'));
      const stat = fs.statSync(real);
      if (!stat.isFile() && !stat.isDirectory()) continue;
      entries.push({
        name,
        path: path.posix.join(relative, name),
        kind: stat.isDirectory() ? 'directory' : 'file',
        size: stat.size,
        mtime: stat.mtimeMs,
      });
    } catch {
      /* a symlink outside the root or a disappearing entry stays absent */
    }
  }
  return {
    path: relativeInside(root, dir),
    entries,
    offset,
    nextOffset: cursor < names.length ? cursor : null,
  };
}
