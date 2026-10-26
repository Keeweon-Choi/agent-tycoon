import * as os from 'node:os';

import { legacyConfigDirectory } from '../configPath.js';

const parts = (value: string) =>
  value
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase());

/** Folders never exposed, at any depth and whatever the root. `.claude` is separate, below. */
const SEQUENCES = [
  ['.git'],
  ['.ssh'],
  ['.gnupg'],
  ['.aws'],
  ['.kube'],
  ['.docker'],
  ['.azure'],
  ['.pixel-agents'],
  ['.mozilla'],
  ['.codex'],
  ['.password-store'],
  ['.config', 'gcloud'],
  ['.config', 'gh'],
  parts(legacyConfigDirectory('')),
  ['.config', 'agent-tycoon'],
  ['.config', 'google-chrome'],
  ['.config', 'chromium'],
  ['.config', 'microsoft-edge'],
  ['.config', 'bravesoftware'],
  ['.local', 'share', 'keyrings'],
  ['appdata', 'local', 'google', 'chrome', 'user data'],
  ['appdata', 'local', 'microsoft', 'edge', 'user data'],
  ['appdata', 'local', 'bravesoftware'],
  ['appdata', 'roaming', 'mozilla'],
];

/** A Windows 8.3 alias (`SSH~1`, `CREDEN~1.TXT`) opens the long-named file on a
 * drive, and realpath keeps the alias, so no name rule would see `.ssh`. */
const shortAlias = (part: string) => /^[^~]{1,6}~\d+(\.[^.]*)?$/.test(part);

const protectedAt = (p: string[], index: number) =>
  shortAlias(p[index]) ||
  SEQUENCES.some((sequence) => sequence.every((segment, k) => p[index + k] === segment));

/** A home folder's own `.claude`: ~, /home/x, /root, /mnt/c/Users/x, C:\Users\x. */
function homeOwn(prefix: string[], home: string): boolean {
  const key = prefix.join('/');
  return (
    key === parts(home).join('/') ||
    (prefix.length === 2 && prefix[0] === 'home') ||
    (prefix.length === 1 && prefix[0] === 'root') ||
    (prefix.length === 4 && prefix[0] === 'mnt' && prefix[2] === 'users') ||
    (prefix.length === 3 && /^[a-z]:$/.test(prefix[0]) && prefix[1] === 'users')
  );
}

/** A path below the chosen root: every protected folder, any `.claude` included. */
export function forbiddenFilePath(relative: string): boolean {
  const p = parts(relative);
  return p.some((part, index) => part === '.claude' || protectedAt(p, index));
}

/** An absolute path (a root, a resolved file, a picker folder). A `.claude` the
 * root passes through (a worktree under `<project>/.claude/worktrees`) is the
 * user's choice; only a home folder's own `.claude` stays shut here. */
export function forbiddenAbsolutePath(absolute: string, home = os.homedir()): boolean {
  const p = parts(absolute);
  return p.some(
    (part, index) =>
      protectedAt(p, index) || (part === '.claude' && homeOwn(p.slice(0, index), home)),
  );
}
