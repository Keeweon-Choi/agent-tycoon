/**
 * Project folders on Windows, WSL, macOS and Linux (T-0032): one pure reading
 * of a typed folder. The webview uses it for the form's default, the line under
 * the folder and its warnings; the daemon uses it again before office, the engine
 * or the folder picker touch a folder. No file system here: whether a folder
 * exists, and its real entry on disk, is the daemon's (server/src/cld/folders.ts).
 *
 * Every OS: trim, NFC, `~` and `~/…` from the home folder, absolute only,
 * repeated and trailing separators dropped, no `.`/`..` segment, no control
 * character. win32: `C:\…` or `C:/…` (drive letter upper-cased), UNC
 * `\\server\share\…` (slow), no reserved device name or `<>:"|?*` in a
 * segment, long paths warned about. WSL: `X:\…` -> `/mnt/x/…` (slow),
 * `\\wsl.localhost\<distro>\…` and `\\wsl$\<distro>\…` -> the Linux path.
 */
import type { HostInfo } from '../messages.js';
import { koText, type Refused, refused } from './serverText.js';

/** What the rules need to know about the host. */
export type PathHost = Pick<HostInfo, 'os' | 'home' | 'caseInsensitive' | 'distro' | 'mnt'>;

export interface ProjectPath {
  /** Absolute, NFC, without a trailing separator (but a root's): stored and compared. */
  path: string;
  /** How the other side writes it: the Windows path on WSL, else `path`. */
  display: string;
  warnings: string[];
}

export const WARN_MNT = koText('path_slow_mnt');
export const WARN_UNC = koText('path_unc');
export const WARN_LONG = koText('path_long');
const MAX_LENGTH = 4096;
const WIN_MAX_PATH = 260;
/** Windows device names, also with an extension (`nul.txt`). */
const WIN_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;
const WIN_BAD = /[<>:"|?*]/;
/** `CON`, `con.txt` and `CON .txt` alike: the base name before the first dot, trailing spaces dropped. */
const winReserved = (part: string) => WIN_RESERVED.test(part.split('.')[0].trimEnd());
const DOTS = (s: string) => s === '.' || s === '..';
const DOTS_ERROR = refused('folder_dots');

/** One new child folder name for the picker; this never reads or creates it. */
export function checkNewFolderName(
  input: string,
  host: PathHost,
): { name: string } | Refused {
  const name = input.normalize('NFC').trim();
  if (!name) return refused('name_empty');
  if (name.length > 255) return refused('name_long');
  if (DOTS(name)) return DOTS_ERROR;
  if (/[/\\]/.test(name)) return refused('name_slash');
  if (/\p{Cc}/u.test(name)) return refused('name_control');
  if (host.os !== 'win32') return { name };
  if (WIN_BAD.test(name)) return refused('name_win_chars');
  if (/[. ]$/.test(name)) return refused('name_win_end');
  if (winReserved(name))
    return refused('name_win_reserved', { name });
  return { name };
}

export function normalizeProjectPath(
  input: string,
  host: PathHost,
): ProjectPath | Refused {
  const raw = input.normalize('NFC').trim();
  if (!raw) return refused('folder_empty');
  if (/\p{Cc}/u.test(raw)) return refused('folder_control');
  if (raw.length > MAX_LENGTH) return refused('folder_too_long');
  return host.os === 'win32' ? windows(raw, host) : posix(raw, host);
}

const mntOf = (host: PathHost) => host.mnt ?? '/mnt';

/** The drive letter of a path on a WSL /mnt drive, else null. */
function mntDrive(p: string, host: PathHost): string | null {
  if (host.os !== 'wsl') return null;
  const m = mntOf(host);
  const rest = p.startsWith(`${m}/`) ? p.slice(m.length + 1) : null;
  return rest !== null && /^[a-z](\/|$)/.test(rest) ? rest[0] : null;
}

function posix(raw: string, host: PathHost): ProjectPath | Refused {
  let p = raw;
  const warnings: string[] = [];
  if (host.os === 'wsl') {
    const drive = /^([A-Za-z]):(?:[\\/](.*))?$/s.exec(p);
    const wsl = /^[\\/]{2}wsl(?:\.localhost|\$)[\\/]([^\\/]+)(?:[\\/](.*))?$/is.exec(p);
    if (drive)
      p = `${mntOf(host)}/${drive[1].toLowerCase()}/${(drive[2] ?? '').replace(/\\/g, '/')}`;
    else if (wsl) {
      if (host.distro && wsl[1].toLowerCase() !== host.distro.toLowerCase())
        return refused('folder_other_distro', { distro: wsl[1] });
      p = `/${(wsl[2] ?? '').replace(/\\/g, '/')}`;
    }
  }
  if (p === '~' || p.startsWith('~/')) p = host.home + p.slice(1);
  if (!p.startsWith('/'))
    return refused(host.os === 'wsl' ? 'folder_start_wsl' : 'folder_start_posix');
  const parts = p.split('/').filter(Boolean);
  if (parts.some(DOTS)) return DOTS_ERROR;
  const path = `/${parts.join('/')}`;
  const drive = mntDrive(path, host);
  if (drive) warnings.push(WARN_MNT);
  let display = path;
  if (drive) {
    const rest = path.slice(mntOf(host).length + 3).replace(/\//g, '\\');
    display = `${drive.toUpperCase()}:\\${rest}`;
  } else if (host.os === 'wsl' && host.distro) {
    display = `\\\\wsl.localhost\\${host.distro}${path === '/' ? '\\' : path.replace(/\//g, '\\')}`;
  }
  return { path, display, warnings };
}

function windows(raw: string, host: PathHost): ProjectPath | Refused {
  let p = raw.replace(/\//g, '\\');
  if (p === '~' || p.startsWith('~\\')) p = host.home + p.slice(1);
  const warnings: string[] = [];
  const drive = /^([A-Za-z]):(\\.*)?$/s.exec(p);
  const unc = /^\\\\([^\\]+)\\([^\\]+)(\\.*)?$/s.exec(p);
  let root: string;
  let rest: string;
  if (drive) {
    root = `${drive[1].toUpperCase()}:\\`;
    rest = drive[2] ?? '';
  } else if (unc && !['?', '.'].includes(unc[1]) && !WIN_BAD.test(unc[1] + unc[2])) {
    root = `\\\\${unc[1]}\\${unc[2]}\\`;
    rest = unc[3] ?? '';
    warnings.push(WARN_UNC);
  } else {
    return refused('folder_start_win');
  }
  const parts = rest.split('\\').filter(Boolean);
  for (const part of parts) {
    if (DOTS(part)) return DOTS_ERROR;
    if (WIN_BAD.test(part)) return refused('name_win_chars');
    if (winReserved(part))
      return refused('name_win_reserved', { name: part });
  }
  const path = parts.length ? root + parts.join('\\') : drive ? root : root.slice(0, -1);
  if (path.length >= WIN_MAX_PATH) warnings.push(WARN_LONG);
  return { path, display: path, warnings };
}

/** The comparison key of a normalized path: NFC, and without case where the
 *  file system folds it (macOS, Windows, and a WSL /mnt drive). */
export function projectPathKey(p: string, host: PathHost): string {
  const n = p.normalize('NFC');
  return host.caseInsensitive || mntDrive(n, host) ? n.toLowerCase() : n;
}

/** The same folder, as typed or stored (a value that does not read as a folder
 *  is compared as written). */
export function sameProjectPath(a: string, b: string, host: PathHost): boolean {
  const key = (s: string) => {
    const n = normalizeProjectPath(s, host);
    return projectPathKey('error' in n ? s : n.path, host);
  };
  return key(a) === key(b);
}

/** The add form's first folder, written the host's way. */
export function defaultProjectFolder(host: PathHost | null): string {
  if (host?.os === 'win32') return `${host.home}\\projects`;
  if (host?.os === 'darwin') return `${host.home}/projects`;
  return '~/projects';
}
