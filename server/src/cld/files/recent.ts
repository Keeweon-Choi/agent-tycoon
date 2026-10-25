import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ProjectFileEntry } from '../../../../core/src/cld/projectFiles.js';
import { gitIgnoredPaths, isGitIgnored } from './ignored.js';
import { relativeInside, resolveInside } from './roots.js';
import { forbiddenFilePath } from './security.js';

const skip = new Set([
  '.git',
  '.ssh',
  '.claude',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.cache',
  'target',
  '.venv',
  '__pycache__',
]);
const preferred = new Set(['artifacts', 'reports', 'outputs', 'results']);
/** In or under an artifacts/reports/outputs/results folder at any depth. */
const inPreferred = (relative: string) => relative.split('/').some((part) => preferred.has(part));

/** Bounded, on-demand walk. Never follows a symlink outside the project. */
export function recentFiles(
  root: string,
  now = Date.now(),
  ignored = gitIgnoredPaths(root),
  maxVisited = 20_000,
  clock = Date.now,
): { entries: ProjectFileEntry[]; partial: boolean } {
  const found: ProjectFileEntry[] = [];
  /** Real paths: an inward symlink and its target are one file. */
  const seen = new Set<string>();
  const queue = [''];
  let visited = 0;
  let partial = false;
  const started = clock();
  while (queue.length) {
    if (visited >= maxVisited || clock() - started >= 1000) {
      partial = true;
      break;
    }
    const relative = queue.shift()!;
    let names: string[];
    try {
      names = fs.readdirSync(resolveInside(root, relative));
    } catch {
      continue;
    }
    for (const name of names) {
      if (++visited > maxVisited || clock() - started >= 1000) {
        partial = true;
        break;
      }
      if (name.startsWith('.') || skip.has(name) || forbiddenFilePath(path.join(relative, name)))
        continue;
      const child = path.posix.join(relative, name);
      if (!inPreferred(child) && isGitIgnored(child, ignored)) continue;
      try {
        const real = resolveInside(root, child);
        const stat = fs.statSync(real);
        if (stat.isDirectory()) queue.push(child);
        else if (
          stat.isFile() &&
          stat.mtimeMs >= now - 86_400_000 &&
          stat.mtimeMs <= now + 1000 &&
          !seen.has(real)
        ) {
          seen.add(real);
          found.push({
            name,
            path: relativeInside(root, real),
            kind: 'file',
            size: stat.size,
            mtime: stat.mtimeMs,
          });
        }
      } catch {
        /* unreadable or outside root */
      }
    }
  }
  return {
    entries: found
      .sort(
        (a, b) => Number(inPreferred(b.path)) - Number(inPreferred(a.path)) || b.mtime - a.mtime,
      )
      .slice(0, 20),
    partial,
  };
}
