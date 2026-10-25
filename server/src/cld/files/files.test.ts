import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sensitiveFile } from './denylist.js';
import { DownloadTickets } from './downloads.js';
import { gitIgnoredPaths, isGitIgnored } from './ignored.js';
import { listFiles } from './listing.js';
import { DOWNLOAD_BYTES, previewFile, previewKind, sameFile } from './preview.js';
import { recentFiles } from './recent.js';
import { chosenRoot, FileAccessError, projectRoot, resolveInside } from './roots.js';
import { FileRateLimit } from './routes.js';
import { forbiddenAbsolutePath, forbiddenFilePath } from './security.js';

let temp: string;
let root: string;
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 't0044-files-'));
  root = path.join(temp, 'project');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');
  fs.mkdirSync(path.join(root, 'inside'));
  fs.symlinkSync(path.join(root, 'a.txt'), path.join(root, 'in-link'));
  fs.writeFileSync(path.join(temp, 'outside.txt'), 'outside');
  fs.symlinkSync(path.join(temp, 'outside.txt'), path.join(root, 'out-link'));
});
afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

describe('file boundary', () => {
  it('confines chosen roots to home and WSL drives, including symlink targets', () => {
    const home = path.join(temp, 'home');
    const mnt = path.join(temp, 'mnt');
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(mnt, 'c'), { recursive: true });
    const host = {
      type: 'hostInfo' as const,
      os: 'wsl' as const,
      home,
      pathStyle: 'posix' as const,
      sep: '/' as const,
      caseInsensitive: false,
      mnt,
    };
    expect(chosenRoot(home, host)).toBe(home);
    expect(chosenRoot(path.join(mnt, 'c'), host)).toBe(path.join(mnt, 'c'));
    expect(() => chosenRoot(root, host)).toThrow(FileAccessError);
    fs.symlinkSync(root, path.join(home, 'escape'));
    expect(() => chosenRoot(path.join(home, 'escape'), host)).toThrow(FileAccessError);
  });

  it('blocks every protected folder at depth, regardless of case', () => {
    const home = path.join(temp, 'home');
    fs.mkdirSync(home);
    const host = {
      type: 'hostInfo' as const,
      os: 'linux' as const,
      home,
      pathStyle: 'posix' as const,
      sep: '/' as const,
      caseInsensitive: false,
    };
    const protectedNames = [
      '.SsH',
      '.GnuPG',
      '.AwS',
      '.KuBe',
      '.DoCkEr',
      '.AzUrE',
      '.ClAuDe',
      '.PiXeL-AgEnTs',
      '.GiT',
      '.MoZiLlA',
      '.CoNfIg/GcLoUd',
      '.CoNfIg/ClD-GuI',
      '.CoNfIg/GoOgLe-ChRoMe',
      'AppData/Local/Google/Chrome/User Data',
      'AppData/Local/Microsoft/Edge/User Data',
      '.CoDeX',
      '.CoNfIg/Gh',
      '.PaSsWoRd-StOrE',
      'AppData/Roaming/Mozilla',
    ];
    for (const name of protectedNames) {
      const relative = `deep/${name}/inside`;
      fs.mkdirSync(path.join(root, relative), { recursive: true });
      fs.writeFileSync(path.join(root, relative, 'note.txt'), 'secret');
      expect(forbiddenFilePath(relative), relative).toBe(true);
      expect(() => resolveInside(root, relative), relative).toThrow(FileAccessError);
      expect(() => resolveInside(root, `${relative}/note.txt`), relative).toThrow(FileAccessError);
      expect(() => previewFile(root, `${relative}/note.txt`, true), relative).toThrow(
        FileAccessError,
      );
      expect(() => chosenRoot(path.join(home, relative), host), relative).toThrow(FileAccessError);
      // The protected folder itself, or the last folder before it, is never listed.
      const parent = path.posix.dirname(`deep/${name}`);
      const names = listFiles(root, parent, 0, true).entries.map((entry) => entry.path);
      expect(names, relative).not.toContain(`deep/${name}`);
    }
    expect(forbiddenFilePath('deep/config/gcloud')).toBe(false);
  });
  it('lets a root pass through .claude (a worktree) but never below it, and never ~/.claude', () => {
    const home = path.join(temp, 'home');
    const worktree = path.join(home, 'projects', 'app', '.claude', 'worktrees', 'w');
    fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'src', 'a.md'), '# a');
    fs.mkdirSync(path.join(worktree, '.claude'));
    fs.writeFileSync(path.join(worktree, '.claude', 'settings.json'), '{}');
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), 'token');
    const host = {
      type: 'hostInfo' as const,
      os: 'linux' as const,
      home,
      pathStyle: 'posix' as const,
      sep: '/' as const,
      caseInsensitive: false,
    };
    expect(chosenRoot(worktree, host)).toBe(worktree);
    expect(projectRoot([{ name: 'w', folder: worktree }], 'w')).toBe(worktree);
    expect(listFiles(worktree, 'src').entries.map((entry) => entry.name)).toEqual(['a.md']);
    expect(previewFile(worktree, 'src/a.md', false).text).toBe('# a');
    expect(listFiles(worktree, '', 0, true).entries.map((entry) => entry.name)).not.toContain(
      '.claude',
    );
    expect(() => resolveInside(worktree, '.claude/settings.json')).toThrow(FileAccessError);
    // Home as the root: its own .claude is below the root and refused, in any case.
    expect(chosenRoot(home, host)).toBe(home);
    for (const relative of ['.claude', '.CLAUDE/projects', '.claude/.credentials.json'])
      expect(() => resolveInside(home, relative), relative).toThrow(FileAccessError);
    expect(listFiles(home, '', 0, true).entries.map((entry) => entry.name)).not.toContain(
      '.claude',
    );
    for (const target of ['.claude', '.ClAuDe/projects'])
      expect(() => chosenRoot(path.join(home, target), host), target).toThrow(FileAccessError);
    // A root inside home's own .claude (projectRoot and resolveInside check the real home).
    expect(forbiddenAbsolutePath(path.join(home, '.claude', 'projects'), home)).toBe(true);
    // A symlink inside home that points at ~/.claude resolves there and is refused.
    fs.symlinkSync(path.join(home, '.claude'), path.join(home, 'notes'));
    expect(() => resolveInside(home, 'notes/.credentials.json')).toThrow(FileAccessError);
    expect(listFiles(home).entries.map((entry) => entry.name)).not.toContain('notes');
    // Another home's .claude, Windows' included, is absolute-path protected too.
    for (const other of [
      '/home/someone/.claude',
      '/root/.claude',
      '/mnt/c/Users/Bob/.Claude/x',
      'C:\\Users\\Bob\\.claude',
    ])
      expect(forbiddenAbsolutePath(other, home), other).toBe(true);
    expect(forbiddenAbsolutePath('/srv/app/.claude/worktrees/w', home)).toBe(false);
  });

  it('refuses Windows 8.3 aliases, which open a protected folder under another spelling', () => {
    // On a Windows drive `SSH~1` opens `.ssh` and realpath keeps the alias.
    fs.mkdirSync(path.join(root, 'SSH~1'));
    fs.writeFileSync(path.join(root, 'SSH~1', 'known_hosts'), 'host');
    fs.writeFileSync(path.join(root, 'CREDEN~1'), 'aws');
    for (const relative of ['SSH~1', 'SSH~1/known_hosts', 'CREDEN~1', 'APPDAT~1/Local'])
      expect(forbiddenFilePath(relative), relative).toBe(true);
    expect(() => resolveInside(root, 'SSH~1/known_hosts')).toThrow(FileAccessError);
    expect(() => previewFile(root, 'CREDEN~1', true)).toThrow(FileAccessError);
    expect(forbiddenAbsolutePath('/mnt/c/Users/bob/SSH~1')).toBe(true);
    expect(forbiddenAbsolutePath('/mnt/c/PROGRA~1')).toBe(true);
    expect(forbiddenFilePath('backup~.txt')).toBe(false);
  });

  it('confines a Windows user folder under the WSL drive: profiles, keys, case', () => {
    const home = path.join(temp, 'home');
    const mnt = path.join(temp, 'mnt');
    const user = path.join(mnt, 'c', 'Users', 'Bob');
    fs.mkdirSync(home);
    for (const dir of [
      'AppData/Local/Google/Chrome/User Data/Default',
      'AppData/Local/Microsoft/Edge/User Data/Default',
      'AppData/Roaming/Mozilla/Firefox',
      '.ssh',
      'Documents',
    ])
      fs.mkdirSync(path.join(user, dir), { recursive: true });
    const host = {
      type: 'hostInfo' as const,
      os: 'wsl' as const,
      home,
      pathStyle: 'posix' as const,
      sep: '/' as const,
      caseInsensitive: false,
      mnt,
    };
    expect(chosenRoot(user, host)).toBe(user);
    for (const relative of [
      'appdata/local/google/chrome/user data/Default',
      'AppData/Local/Microsoft/Edge/User Data',
      'AppData/Roaming/Mozilla/Firefox',
      '.SSH',
    ]) {
      expect(() => resolveInside(user, relative), relative).toThrow(FileAccessError);
      expect(() => chosenRoot(path.join(user, relative), host), relative).toThrow(FileAccessError);
    }
    expect(listFiles(user, 'AppData/Local/Google/Chrome', 0, true).entries).toEqual([]);
    expect(listFiles(user, '', 0, true).entries.map((entry) => entry.name)).toEqual([
      'AppData',
      'Documents',
    ]);
    // `..` back into a protected folder, written into the chosen root itself.
    expect(() => chosenRoot(path.join(user, 'Documents', '..', '.ssh'), host)).toThrow(
      FileAccessError,
    );
  });

  it('rejects traversal, absolute paths, and an outward symlink, but accepts an inward one', () => {
    expect(() => resolveInside(root, '../outside.txt')).toThrow(FileAccessError);
    expect(() => resolveInside(root, path.join(temp, 'outside.txt'))).toThrow(FileAccessError);
    expect(() => resolveInside(root, 'out-link')).toThrow(FileAccessError);
    expect(resolveInside(root, 'in-link')).toBe(path.join(root, 'a.txt'));
    expect(() => resolveInside(root, '.git/config')).toThrow(FileAccessError);
  });

  it('hides hidden and outward entries and pages at 1000', () => {
    fs.writeFileSync(path.join(root, '.hidden'), 'hidden');
    fs.mkdirSync(path.join(root, '.git'));
    for (let i = 0; i < 1004; i++)
      fs.writeFileSync(path.join(root, `f${String(i).padStart(4, '0')}`), 'x');
    expect(listFiles(root).entries).toHaveLength(200);
    const first = listFiles(root, '', 0, false, 1000);
    expect(first.entries).toHaveLength(1000);
    expect(first.nextOffset).toBe(1000);
    expect(first.entries.map((entry) => entry.name)).not.toContain('out-link');
    expect(first.entries.map((entry) => entry.name)).not.toContain('.hidden');
    const second = listFiles(root, '', first.nextOffset!, false, 1000);
    expect(second.entries.length).toBeGreaterThan(0);
    expect(second.nextOffset).toBeNull();
    expect(listFiles(root, '', 0, true, 1000).entries.map((entry) => entry.name)).toContain(
      '.hidden',
    );
    expect(listFiles(root, '', 0, true, 1000).entries.map((entry) => entry.name)).not.toContain(
      '.git',
    );
    expect(() => listFiles(root, '', 0, false, 1001)).toThrow(FileAccessError);
  });
});

it('blocks known secret names and classifies preview types', () => {
  for (const name of [
    '.env',
    '.env.local',
    'tls.pem',
    'private.key',
    'id_rsa',
    'cloud-credentials.json',
    'db.secret.txt',
    '.netrc',
    '.npmrc',
    '.pypirc',
    'safe.KDBX',
    'identity.p12',
    'identity.PFX',
    'vpn.ovpn',
    'login.keychain-db',
    'Work.Keychain',
    '.bash_history',
    '.zsh_history',
    '.pgpass',
  ])
    expect(sensitiveFile(name)).toBe(true);
  expect(sensitiveFile('report.md')).toBe(false);
  for (const [name, kind] of [
    ['a.png', 'image'],
    ['a.svg', 'image'],
    ['a.md', 'markdown'],
    ['a.ts', 'text'],
    ['a.csv', 'csv'],
    ['a.json', 'json'],
    ['a.pdf', 'pdf'],
    ['a.html', 'html'],
    ['a.bin', 'download'],
  ] as const)
    expect(previewKind(name)).toBe(kind);
});

it('uses a ticket once, binds it to one session, and expires after 60 seconds', () => {
  let now = 1000;
  const tickets = new DownloadTickets(() => now);
  const ticket = tickets.mint({ session: 'one', project: 'p', path: 'a.txt', mode: 'download' });
  expect(tickets.consume(ticket, 'wrong')).toBeNull();
  expect(tickets.consume(ticket, 'one')).toBeNull();
  const second = tickets.mint({ session: 'one', project: 'p', path: 'a.txt', mode: 'download' });
  expect(tickets.consume(second, 'one')?.path).toBe('a.txt');
  expect(tickets.consume(second, 'one')).toBeNull();
  const third = tickets.mint({ session: 'one', project: 'p', path: 'a.txt', mode: 'download' });
  now += 60_001;
  expect(tickets.consume(third, 'one')).toBeNull();
});

it('limits a client independently within one minute', () => {
  let now = 0;
  const limit = new FileRateLimit(() => now, 2);
  expect(limit.allow('a')).toBe(true);
  expect(limit.allow('a')).toBe(true);
  expect(limit.allow('a')).toBe(false);
  expect(limit.allow('b')).toBe(true);
  now = 60_000;
  expect(limit.allow('a')).toBe(true);
});

it('caps preview text, refuses files above 50 MB, and prefers recent artifacts', () => {
  fs.writeFileSync(path.join(root, 'long.md'), 'x'.repeat(256 * 1024 + 3));
  const preview = previewFile(root, 'long.md', false);
  expect(preview.text).toHaveLength(256 * 1024);
  expect(preview.truncated).toBe(true);
  fs.writeFileSync(path.join(root, '.env.local'), 'secret');
  expect(() => previewFile(root, '.env.local', false)).toThrow(FileAccessError);
  fs.symlinkSync(path.join(root, '.env.local'), path.join(root, 'ordinary-link'));
  expect(() => previewFile(root, 'ordinary-link', false)).toThrow(FileAccessError);
  const large = path.join(root, 'large.bin');
  fs.closeSync(fs.openSync(large, 'w'));
  fs.truncateSync(large, DOWNLOAD_BYTES + 1);
  expect(() => previewFile(root, 'large.bin', true)).toThrow(FileAccessError);
  fs.mkdirSync(path.join(root, 'artifacts'));
  fs.writeFileSync(path.join(root, 'artifacts', 'chart.png'), 'image');
  expect(recentFiles(root).entries[0].path).toBe('artifacts/chart.png');
  fs.symlinkSync(path.join(root, 'artifacts', 'chart.png'), path.join(root, 'chart-link.png'));
  const paths = recentFiles(root).entries.map((entry) => entry.path);
  expect(paths.filter((p) => p === 'artifacts/chart.png')).toHaveLength(1);
});

it('uses git ignore rules to prune recent files but keeps preferred output folders', () => {
  expect(
    spawnSync('git', ['init', '-q'], { cwd: root, env: { ...process.env, HOME: temp } }).status,
  ).toBe(0);
  fs.writeFileSync(path.join(root, '.gitignore'), 'scratch/\nartifacts/\n');
  fs.mkdirSync(path.join(root, 'scratch'));
  fs.writeFileSync(path.join(root, 'scratch', 'ignored.txt'), 'skip');
  fs.mkdirSync(path.join(root, 'artifacts'));
  fs.writeFileSync(path.join(root, 'artifacts', 'chart.png'), 'keep');
  const ignored = gitIgnoredPaths(root);
  expect(ignored).toContain('scratch/');
  expect(isGitIgnored('scratch/ignored.txt', ignored)).toBe(true);
  const recent = recentFiles(root, Date.now(), ignored);
  expect(recent.entries.map((entry) => entry.path)).not.toContain('scratch/ignored.txt');
  expect(recent.entries.map((entry) => entry.path)).toContain('artifacts/chart.png');
  expect(recentFiles(root, Date.now(), ignored, 1).partial).toBe(true);
});

it('keeps an ignored artifacts folder nested below the top level, first', () => {
  expect(
    spawnSync('git', ['init', '-q'], { cwd: root, env: { ...process.env, HOME: temp } }).status,
  ).toBe(0);
  fs.writeFileSync(path.join(root, '.gitignore'), 'cld/artifacts/run/\n');
  fs.mkdirSync(path.join(root, 'cld', 'artifacts', 'run'), { recursive: true });
  fs.writeFileSync(path.join(root, 'cld', 'artifacts', 'run', 'shot.png'), 'keep');
  fs.writeFileSync(path.join(root, 'cld', 'artifacts', 'notes.md'), 'not ignored');
  const old = Date.now() / 1000 - 3600;
  fs.utimesSync(path.join(root, 'cld', 'artifacts', 'run', 'shot.png'), old, old);
  fs.utimesSync(path.join(root, 'cld', 'artifacts', 'notes.md'), old - 60, old - 60);
  const ignored = gitIgnoredPaths(root);
  expect(ignored).toContain('cld/artifacts/run/');
  expect(recentFiles(root, Date.now(), ignored).entries[0].path).toBe('cld/artifacts/run/shot.png');
});

it('sameFile (the race check off Linux): the checked path must still be the opened file, with no link in it', () => {
  const real = fs.realpathSync(path.join(root, 'a.txt'));
  const opened = fs.statSync(real, { bigint: true });
  expect(sameFile(real, opened)).toBe(true);
  // Swapped after the check: another file at the same path.
  fs.renameSync(real, `${real}.old`);
  fs.writeFileSync(real, 'b');
  expect(sameFile(real, opened)).toBe(false);
  const link = path.join(root, 'in-link');
  expect(sameFile(link, fs.statSync(link, { bigint: true }))).toBe(false);
});
