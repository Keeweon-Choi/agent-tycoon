/**
 * The shared folder rules (T-0032, core/src/cld/projectPath.ts) for every host,
 * on any machine: the host info says which rules apply, and each accepted
 * result is checked against Node's own rules for that host (path.win32 or
 * path.posix): absolute, and already in their normal form.
 */
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import type { PathHost, ProjectPath } from '../../../core/src/cld/projectPath.js';
import {
  checkNewFolderName,
  defaultProjectFolder,
  normalizeProjectPath,
  sameProjectPath,
  WARN_LONG,
  WARN_MNT,
  WARN_UNC,
} from '../../../core/src/cld/projectPath.js';

const LINUX: PathHost = { os: 'linux', home: '/home/me', caseInsensitive: false };
const WSL: PathHost = {
  os: 'wsl',
  home: '/home/me',
  caseInsensitive: false,
  distro: 'Ubuntu',
  mnt: '/mnt',
};
const DARWIN: PathHost = { os: 'darwin', home: '/Users/me', caseInsensitive: true };
const WIN: PathHost = { os: 'win32', home: 'C:\\Users\\me', caseInsensitive: true };
const NFD = (s: string) => s.normalize('NFD');
const LONG = `C:\\${'a'.repeat(120)}\\${'b'.repeat(140)}`;

/** [what, host, input, path or error pattern, warnings, display (default: path)] */
type Case = [string, PathHost, string, string | RegExp, string[]?, string?];

const cases: Case[] = [
  // Every OS: ~, trim, separators, dots, control characters, length, NFC.
  ['linux: ~', LINUX, '~', '/home/me'],
  ['linux: ~/…', LINUX, '~/projects/app', '/home/me/projects/app'],
  ['linux: trim and trailing /', LINUX, '  /srv/app/  ', '/srv/app'],
  ['linux: repeated /', LINUX, '/srv//app///', '/srv/app'],
  ['linux: the root stays', LINUX, '/', '/'],
  ['linux: a backslash is a name character', LINUX, '/srv/a\\b', '/srv/a\\b'],
  ['linux: NFD Hangul stored as NFC', LINUX, NFD('/home/me/한글'), '/home/me/한글'],
  ['linux: relative', LINUX, 'projects/app', /^폴더는 \/ 나 ~\/ 로/],
  ['linux: ~user', LINUX, '~root/x', /^폴더는 \/ 나 ~\/ 로/],
  ['linux: ..', LINUX, '/srv/../etc', /\. 이나 \.\./],
  ['linux: .', LINUX, '/srv/./app', /\. 이나 \.\./],
  ['linux: ~/..', LINUX, '~/../x', /\. 이나 \.\./],
  ['linux: newline', LINUX, '/srv/a\nb', /제어 문자/],
  ['linux: DEL', LINUX, '/srv/a\u007fb', /제어 문자/],
  ['linux: empty', LINUX, '   ', /^폴더를 입력/],
  ['linux: too long', LINUX, `/${'x'.repeat(5000)}`, /너무 길어요/],
  ['linux: a Windows path is not a folder here', LINUX, 'C:\\work', /^폴더는 \/ 나 ~\/ 로/],
  // WSL: Windows drives and \\wsl.localhost paths.
  [
    'wsl: X:\\… -> /mnt/x/… (slow)',
    WSL,
    'D:\\projects\\app',
    '/mnt/d/projects/app',
    [WARN_MNT],
    'D:\\projects\\app',
  ],
  ['wsl: x:/… -> /mnt/x/…', WSL, 'd:/projects/', '/mnt/d/projects', [WARN_MNT], 'D:\\projects'],
  ['wsl: C: alone', WSL, 'C:', '/mnt/c', [WARN_MNT], 'C:\\'],
  ['wsl: C:\\', WSL, 'C:\\', '/mnt/c', [WARN_MNT], 'C:\\'],
  [
    'wsl: a typed /mnt drive',
    WSL,
    '/mnt/c/Users/me/',
    '/mnt/c/Users/me',
    [WARN_MNT],
    'C:\\Users\\me',
  ],
  [
    'wsl: \\\\wsl.localhost\\<distro>\\…',
    WSL,
    '\\\\wsl.localhost\\Ubuntu\\home\\me\\app',
    '/home/me/app',
    [],
    '\\\\wsl.localhost\\Ubuntu\\home\\me\\app',
  ],
  [
    'wsl: \\\\wsl$\\<distro>\\…',
    WSL,
    '\\\\wsl$\\Ubuntu\\srv',
    '/srv',
    [],
    '\\\\wsl.localhost\\Ubuntu\\srv',
  ],
  [
    'wsl: //wsl.localhost/<distro>',
    WSL,
    '//WSL.localhost/ubuntu/home/me',
    '/home/me',
    [],
    '\\\\wsl.localhost\\Ubuntu\\home\\me',
  ],
  ['wsl: another distro', WSL, '\\\\wsl.localhost\\Debian\\home\\x', /다른 WSL 배포판\(Debian\)/],
  [
    'wsl: ~ shown the Windows way',
    WSL,
    '~/app',
    '/home/me/app',
    [],
    '\\\\wsl.localhost\\Ubuntu\\home\\me\\app',
  ],
  ['wsl: a UNC share is not a Linux folder', WSL, '\\\\server\\share\\x', /C:\\ 로 시작/],
  ['wsl: drive-relative D:foo', WSL, 'D:foo', /C:\\ 로 시작/],
  [
    'wsl: /mnt/data is no drive',
    WSL,
    '/mnt/data/x',
    '/mnt/data/x',
    [],
    '\\\\wsl.localhost\\Ubuntu\\mnt\\data\\x',
  ],
  [
    'wsl: no distro known',
    { ...WSL, distro: undefined },
    '/home/me/app',
    '/home/me/app',
    [],
    '/home/me/app',
  ],
  // macOS.
  ['darwin: ~/…', DARWIN, '~/Projects', '/Users/me/Projects'],
  ['darwin: NFD Hangul -> NFC', DARWIN, NFD('/Users/me/프로젝트/'), '/Users/me/프로젝트'],
  ['darwin: a Windows path', DARWIN, 'C:\\x', /^폴더는 \/ 나 ~\/ 로/],
  // Windows.
  ['win32: C:\\…', WIN, 'C:\\work\\app', 'C:\\work\\app'],
  ['win32: c:/…/ (slashes, lower-case drive)', WIN, 'c:/work/app/', 'C:\\work\\app'],
  ['win32: C:', WIN, 'C:', 'C:\\'],
  ['win32: C:\\', WIN, 'C:\\', 'C:\\'],
  ['win32: ~\\…', WIN, '~\\projects', 'C:\\Users\\me\\projects'],
  ['win32: ~/…', WIN, '~/projects', 'C:\\Users\\me\\projects'],
  ['win32: UNC (slow)', WIN, '\\\\server\\share\\proj', '\\\\server\\share\\proj', [WARN_UNC]],
  ['win32: UNC share root, slashes', WIN, '//server/share/', '\\\\server\\share', [WARN_UNC]],
  ['win32: \\\\?\\ prefix', WIN, '\\\\?\\C:\\work', /드라이브나/],
  ['win32: \\\\.\\ device', WIN, '\\\\.\\PhysicalDrive0', /드라이브나/],
  ['win32: a server without a share', WIN, '\\\\server', /드라이브나/],
  ['win32: reserved CON', WIN, 'C:\\work\\CON', /CON: Windows가 장치 이름/],
  ['win32: reserved nul.txt', WIN, 'C:\\work\\nul.txt', /장치 이름/],
  ['win32: reserved com1 mid-path', WIN, 'C:\\com1\\x', /장치 이름/],
  ['win32: reserved lpt9, lower case', WIN, 'C:\\lpt9', /장치 이름/],
  ['win32: reserved AUX with a space', WIN, 'C:\\AUX .txt', /장치 이름/],
  ['win32: Console is a name', WIN, 'C:\\work\\Console', 'C:\\work\\Console'],
  ['win32: <', WIN, 'C:\\work\\a<b', /< > : " \| \? \*/],
  ['win32: ?', WIN, 'C:\\work\\a?b', /< > : " \| \? \*/],
  ['win32: a second colon', WIN, 'C:\\work\\a:b', /< > : " \| \? \*/],
  ['win32: |', WIN, 'C:\\a|b', /< > : " \| \? \*/],
  ['win32: relative', WIN, 'work\\app', /드라이브나/],
  ['win32: no drive', WIN, '\\work', /드라이브나/],
  ['win32: drive-relative', WIN, 'C:work', /드라이브나/],
  ['win32: ..', WIN, 'C:\\work\\..\\x', /\. 이나 \.\./],
  ['win32: long path (allowed, warned)', WIN, LONG, LONG, [WARN_LONG]],
];

describe('normalizeProjectPath (T-0032)', () => {
  it('has the 40 cases the task asks for, and more', () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
  });

  it.each(cases)('%s', (_what, host, input, want, warnings = [], display) => {
    const out = normalizeProjectPath(input, host);
    if (want instanceof RegExp) {
      expect(out).toMatchObject({ error: expect.stringMatching(want), errorCode: expect.any(String) });
      return;
    }
    expect(out).toEqual({ path: want, display: display ?? want, warnings });
    // Node's own rules for that host agree: absolute and already normal.
    const p = host.os === 'win32' ? path.win32 : path.posix;
    const { path: got } = out as ProjectPath;
    expect(p.isAbsolute(got)).toBe(true);
    const trim = (s: string) => (s.length > 3 ? s.replace(/[\\/]+$/, '') : s);
    expect(trim(p.normalize(got))).toBe(got);
  });
});

describe('the same folder (duplicates)', () => {
  it.each<[string, PathHost, string, string, boolean]>([
    ['NFC vs NFD Hangul (Linux)', LINUX, '/home/me/한글', NFD('/home/me/한글/'), true],
    ['NFC vs NFD Hangul (macOS)', DARWIN, NFD('/Users/me/프로젝트'), '/Users/me/프로젝트', true],
    ['case on macOS', DARWIN, '/Users/me/App', '/users/ME/app/', true],
    ['case on Windows, slashes, drive letter', WIN, 'C:\\Work\\App', 'c:/work/app/', true],
    ['case on Linux is another folder', LINUX, '/home/me/App', '/home/me/app', false],
    ['case on a WSL /mnt drive (Windows)', WSL, '/mnt/c/Work', 'C:\\work', true],
    ['case in the WSL home is another folder', WSL, '/home/me/Work', '/home/me/work', false],
    ['~ and its expansion', LINUX, '~/app', '/home/me/app', true],
    ['different folders', WIN, 'C:\\a', 'C:\\b', false],
  ])('%s', (_what, host, a, b, same) => {
    expect(sameProjectPath(a, b, host)).toBe(same);
  });
});

describe('checkNewFolderName (picker child folder)', () => {
  it.each<[string, PathHost, string, string | RegExp]>([
    ['plain Linux name', LINUX, 'projects', 'projects'],
    ['plain Windows name', WIN, '프로젝트 2', '프로젝트 2'],
    ['trims surrounding whitespace', LINUX, '  project  ', 'project'],
    ['NFD Hangul is stored as NFC', LINUX, NFD('한글'), '한글'],
    ['empty', LINUX, '   ', /입력해/],
    ['too long', LINUX, 'x'.repeat(256), /255자/],
    ['dot', LINUX, '.', /\. 이나 \.\./],
    ['dot dot', LINUX, '..', /\. 이나 \.\./],
    ['forward slash', LINUX, 'a/b', /\/ 나/],
    ['backslash', LINUX, 'a\\b', /\\ 는/],
    ['control character', LINUX, 'a\nb', /제어 문자/],
    ['CON', WIN, 'CON', /장치 이름/],
    ['con.txt', WIN, 'con.txt', /장치 이름/],
    ['NUL', WIN, 'NUL', /장치 이름/],
    ['CON .txt (spaces before the dot)', WIN, 'CON .txt', /장치 이름/],
    ['CON is a plain name on Linux', LINUX, 'CON', 'CON'],
    ['trailing dot on Windows', WIN, 'folder.', /점이나 공백/],
    ['trailing dot on Linux', LINUX, 'folder.', 'folder.'],
    ['bad Windows character', WIN, 'a<b', /< > :/],
    ['bad Windows character is allowed on Linux', LINUX, 'a<b', 'a<b'],
  ])('%s', (_what, host, input, want) => {
    const out = checkNewFolderName(input, host);
    if (want instanceof RegExp) {
      expect(out).toMatchObject({ error: expect.stringMatching(want), errorCode: expect.any(String) });
      return;
    }
    expect(out).toEqual({ name: want });
  });
});

describe('the add form starts at the host’s projects folder', () => {
  it.each<[PathHost | null, string]>([
    [WIN, 'C:\\Users\\me\\projects'],
    [DARWIN, '/Users/me/projects'],
    [LINUX, '~/projects'],
    [WSL, '~/projects'],
    [null, '~/projects'],
  ])('%j', (host, want) => {
    expect(defaultProjectFolder(host)).toBe(want);
  });
});
