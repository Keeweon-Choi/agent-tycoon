import * as fs from 'node:fs';
import * as path from 'node:path';

import { projectPathKey } from '../../../../core/src/cld/projectPath.js';
import { koText } from '../../../../core/src/cld/serverText.js';
import type { HostInfo } from '../../../../core/src/messages.js';
import type { ProjectFolder } from '../engine/git/repoRead.js';
import { detectHostInfo, folderRoots } from '../folders.js';
import { forbiddenAbsolutePath, forbiddenFilePath } from './security.js';

export class FileAccessError extends Error {
  constructor(
    message: string,
    readonly status = 403,
  ) {
    super(message);
  }
}

const inside = (child: string, parent: string, host: HostInfo) => {
  const candidate = projectPathKey(child, host);
  const boundary = projectPathKey(parent, host).replace(/[\\/]+$/, '');
  return candidate === boundary || candidate.startsWith(boundary + path.sep);
};

/** A user-chosen directory is confined to the picker's home and drive roots. */
export function chosenRoot(input: string, host: HostInfo = detectHostInfo()): string {
  if (
    typeof input !== 'string' ||
    !input ||
    input.length > 4096 ||
    !path.isAbsolute(input) ||
    input.includes('\0') ||
    forbiddenAbsolutePath(input, host.home)
  )
    throw new FileAccessError(koText('folder_forbidden'));
  const roots = folderRoots(host).map((root) => root.path);
  if (!roots.some((root) => inside(input, root, host)))
    throw new FileAccessError(koText('folder_outside'));
  try {
    const real = fs.realpathSync(input);
    if (
      forbiddenAbsolutePath(real, host.home) ||
      !roots.some((root) => inside(real, fs.realpathSync(root), host)) ||
      !fs.statSync(real).isDirectory()
    )
      throw new Error('outside');
    return real;
  } catch {
    throw new FileAccessError(koText('folder_forbidden'));
  }
}

/** A fresh registry lookup on every project request. */
export function projectRoot(projects: readonly ProjectFolder[], name: string): string {
  const folder = projects.find((project) => project.name === name)?.folder;
  if (!folder || !path.isAbsolute(folder))
    throw new FileAccessError(koText('project_unregistered'), 404);
  try {
    const root = fs.realpathSync(folder);
    if (!fs.statSync(root).isDirectory()) throw new Error('not a directory');
    if (forbiddenAbsolutePath(root) || forbiddenAbsolutePath(folder))
      throw new Error('forbidden folder');
    return root;
  } catch {
    throw new FileAccessError(koText('project_folder_unreadable'), 404);
  }
}

export function resolveInside(root: string, relative: string): string {
  if (
    typeof relative !== 'string' ||
    path.isAbsolute(relative) ||
    relative.includes('\\') ||
    relative.includes('\0')
  )
    throw new FileAccessError(koText('relative_only'));
  const parts = relative.split('/');
  if (
    parts.some((part) => part === '..') ||
    forbiddenFilePath(relative) ||
    forbiddenAbsolutePath(root)
  )
    throw new FileAccessError(koText('path_forbidden'));
  try {
    const real = fs.realpathSync(path.join(root, relative));
    const fromRoot = path.relative(root, real);
    if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot))
      throw new FileAccessError('프로젝트 밖 경로예요');
    if (blockedBelow(root, real)) throw new FileAccessError(koText('path_forbidden'));
    return real;
  } catch (error) {
    if (error instanceof FileAccessError) throw error;
    throw new FileAccessError(koText('file_unreadable'), 404);
  }
}

/** A resolved path under `root`: no protected folder on its absolute path, and
 * no `.claude` (or other protected folder) between the root and it. */
export function blockedBelow(root: string, real: string): boolean {
  return forbiddenAbsolutePath(real) || forbiddenFilePath(path.relative(root, real));
}

export function relativeInside(root: string, real: string): string {
  return path.relative(root, real).split(path.sep).join('/');
}
