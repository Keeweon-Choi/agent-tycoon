/**
 * Project folders on the host (T-0032): what the host is (hostInfo, sent once
 * to every client), the real entry of a typed folder on disk, and the folder
 * picker (`listFolders` -> `folderList`). The typed-folder rules themselves are
 * core/src/cld/projectPath.ts, shared with the webview.
 *
 * The picker lists folders only (never a file name or content) under the home
 * folder, a Windows drive or a WSL /mnt drive, follows no symlink out of them,
 * hides dot folders unless asked, and stops at 500 entries.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { PathHost } from '../../../core/src/cld/projectPath.js';
import { normalizeProjectPath, projectPathKey } from '../../../core/src/cld/projectPath.js';
import { koText, type Refused, refused } from '../../../core/src/cld/serverText.js';
import type {
  FolderList,
  FolderRoot,
  HostInfo,
  HostOs,
  ListFolders,
} from '../../../core/src/messages.js';
import { forbiddenAbsolutePath } from './files/security.js';

export const FOLDER_CAP = 500;
const REQUEST_ID_MAX = 128;
const PATH_MAX = 4096;

const read = (file: string): string => {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
};

/** Same file through the home folder's case-flipped spelling: the file system folds case. */
export function foldsCase(home: string): boolean {
  const flipped = [...home]
    .map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
    .join('');
  if (flipped === home) return false;
  try {
    const a = fs.statSync(home);
    const b = fs.statSync(flipped);
    return a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
}

/** WSL's distribution name: its variable, else `wslpath -w /` (a systemd service has no variable). */
function wslDistro(env: NodeJS.ProcessEnv): string | undefined {
  if (env.WSL_DISTRO_NAME) return env.WSL_DISTRO_NAME;
  try {
    const out = execFileSync('wslpath', ['-w', '/'], { encoding: 'utf-8', timeout: 2_000 });
    return /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)/i.exec(out.trim())?.[1];
  } catch {
    return undefined;
  }
}

/**
 * The host, once. `CLD_GUI_TEST_HOST` (tests only, JSON) replaces what was
 * detected: `os`, `distro`, `mnt` (a folder standing in for /mnt) and
 * `caseInsensitive`.
 */
export function detectHostInfo(
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): HostInfo {
  const fake = JSON.parse(env.CLD_GUI_TEST_HOST || '{}') as Partial<HostInfo>;
  const wsl = platform === 'linux' && /microsoft/i.test(read('/proc/sys/kernel/osrelease'));
  const hostOs: HostOs =
    fake.os ?? (platform === 'win32' || platform === 'darwin' ? platform : wsl ? 'wsl' : 'linux');
  const win = hostOs === 'win32';
  const distro = hostOs === 'wsl' ? (fake.distro ?? wslDistro(env)) : undefined;
  return {
    type: 'hostInfo',
    os: hostOs,
    home,
    pathStyle: win ? 'win32' : 'posix',
    sep: win ? '\\' : '/',
    caseInsensitive: fake.caseInsensitive ?? foldsCase(home),
    ...(distro && { distro }),
    ...(hostOs === 'wsl' && { mnt: fake.mnt ?? '/mnt' }),
    // T-0041: office hours run on the host's clock, whoever is watching.
    utcOffsetMin: -new Date().getTimezoneOffset(),
  };
}

/**
 * The folder as it is on disk: `p` when it exists as written, else the entry
 * whose name is the same in NFD (macOS keeps Hangul names decomposed; a copy
 * from a Mac does too) and, where the file system folds case, in any case.
 * Null when there is none.
 */
export function findFolder(p: string, host: PathHost): string | null {
  if (fs.existsSync(p)) return p;
  const fold = (s: string) => {
    const d = s.normalize('NFD');
    return host.caseInsensitive ? d.toLowerCase() : d;
  };
  const { root } = path.parse(p);
  let cur = root;
  for (const part of p.slice(root.length).split(path.sep).filter(Boolean)) {
    const next = path.join(cur, part);
    if (fs.existsSync(next)) {
      cur = next;
      continue;
    }
    let names: string[];
    try {
      names = fs.readdirSync(cur);
    } catch {
      return null;
    }
    const match = names.find((n) => fold(n) === fold(part));
    if (match === undefined) return null;
    cur = path.join(cur, match);
  }
  return cur;
}

const real = (p: string): string | null => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const OUTSIDE = refused('folder_outside');

/** `child` is `root` or under it (comparison keys: NFC, case where it folds). */
function within(child: string, root: string, host: PathHost): boolean {
  const c = projectPathKey(child, host);
  const r = projectPathKey(root, host).replace(/[\\/]+$/, '');
  return c === r || c.startsWith(r + path.sep);
}

/** Where the picker starts from: home, the Windows drives, WSL's /mnt drives. */
export function folderRoots(host: HostInfo): FolderRoot[] {
  const roots: FolderRoot[] = [{ label: koText('root_home'), path: host.home }];
  if (host.os === 'win32') {
    for (const l of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      if (fs.existsSync(`${l}:\\`)) roots.push({ label: `${l}:`, path: `${l}:\\` });
    }
  }
  if (host.os === 'wsl' && host.mnt) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(host.mnt).filter((n) => /^[a-z]$/.test(n));
    } catch {
      /* no drives */
    }
    for (const l of names.sort())
      roots.push({ label: `${l.toUpperCase()}:`, path: path.join(host.mnt, l) });
  }
  return roots;
}

export function parseListFolders(msg: Record<string, unknown>): ListFolders | null {
  const { requestId, path: p, hidden } = msg;
  if (typeof requestId !== 'string' || !requestId || requestId.length > REQUEST_ID_MAX) return null;
  if (p !== undefined && (typeof p !== 'string' || p.length > PATH_MAX)) return null;
  if (hidden !== undefined && typeof hidden !== 'boolean') return null;
  return {
    type: 'listFolders',
    requestId,
    ...(p !== undefined && { path: p }),
    ...(hidden !== undefined && { hidden }),
  };
}

/** One listing (the gates are the caller's). Never throws. */
export function listFolders(req: ListFolders, host: HostInfo): FolderList {
  const roots = folderRoots(host);
  const fail = (why: Refused): FolderList => ({
    type: 'folderList',
    requestId: req.requestId,
    ok: false,
    ...why,
    roots,
    entries: [],
  });
  const n = normalizeProjectPath(req.path ?? host.home, host);
  if ('error' in n) return fail(n);
  if (forbiddenAbsolutePath(n.path, host.home)) return fail(refused('folder_forbidden'));
  // Inside a root as written, and still inside one once every symlink is resolved.
  if (!roots.some((r) => within(n.path, r.path, host))) return fail(OUTSIDE);
  const realRoots = roots.map((r) => real(r.path)).filter((r): r is string => r !== null);
  const inRoots = (p: string | null): p is string =>
    !!p && realRoots.some((r) => within(p, r, host));
  const disk = findFolder(n.path, host);
  const resolved = disk && real(disk);
  if (!disk || !resolved) return fail(refused('folder_not_found'));
  if (!inRoots(resolved)) return fail(OUTSIDE);
  if (forbiddenAbsolutePath(resolved, host.home)) return fail(refused('folder_forbidden'));
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(disk, { withFileTypes: true });
  } catch {
    return fail(refused('folder_unreadable'));
  }
  const names: string[] = [];
  for (const d of dirents) {
    if (forbiddenAbsolutePath(path.join(disk, d.name), host.home)) continue;
    if (d.name.startsWith('.') && !req.hidden) continue;
    let dir = d.isDirectory();
    if (d.isSymbolicLink()) {
      // Followed only when it stays inside a root.
      const target = real(path.join(disk, d.name));
      dir = inRoots(target) && !forbiddenAbsolutePath(target ?? '', host.home) && isDir(target);
    }
    if (dir) names.push(d.name.normalize('NFC'));
  }
  names.sort((a, b) => a.localeCompare(b));
  const atRoot = roots.some((r) => projectPathKey(r.path, host) === projectPathKey(n.path, host));
  return {
    type: 'folderList',
    requestId: req.requestId,
    ok: true,
    path: n.path,
    display: n.display,
    parent: atRoot ? null : path.dirname(n.path),
    roots,
    entries: names.slice(0, FOLDER_CAP).map((name) => ({ name, path: path.join(n.path, name) })),
    ...(names.length > FOLDER_CAP && { truncated: true }),
    ...(n.warnings.length > 0 && { warnings: n.warnings }),
  };
}
