import { spawnSync } from 'node:child_process';
import * as os from 'node:os';

import { forbiddenFilePath } from './security.js';

/** Git's own ignore rules include nested .gitignore, info/exclude and tracked
 * exceptions. Run only when the panel opens or a recent scan is requested. */
export function gitIgnoredPaths(root: string): string[] {
  const result = spawnSync(
    'git',
    [
      '--no-optional-locks',
      // W2: never the repository's hooks or fsmonitor (as gitRun.ts).
      '-c',
      `core.hooksPath=${os.devNull}`,
      '-c',
      'core.fsmonitor=false',
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
      '-z',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 1000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    },
  );
  if (result.status !== 0) return [];
  return result.stdout
    .split('\0')
    .filter((entry) => entry && !forbiddenFilePath(entry))
    .slice(0, 10_000);
}

export function isGitIgnored(relative: string, ignored: readonly string[]): boolean {
  return ignored.some(
    (entry) =>
      relative === entry ||
      relative === entry.replace(/\/$/, '') ||
      relative.startsWith(entry.endsWith('/') ? entry : `${entry}/`),
  );
}
