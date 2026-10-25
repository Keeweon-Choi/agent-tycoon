/**
 * T-0032 on the daemon: the folder picker's bounds (home, drives, WSL /mnt
 * drives; no escape through `..` or a symlink; folders only; hidden off; the
 * 500 cap), its gates, the real entry of a folder written in another Unicode
 * form, the host info every client gets, and who manages each card's row.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { WARN_MNT } from '../../../core/src/cld/projectPath.js';
import type { FolderList, HostInfo, OfficeSnapshot } from '../../../core/src/messages.js';
import {
  detectHostInfo,
  findFolder,
  FOLDER_CAP,
  foldsCase,
  listFolders,
  parseListFolders,
} from './folders.js';
import { startEngineOffice } from './officeTestKit.js';

const savedEnv = { ...process.env };
let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup) c();
  cleanup = [];
  process.env = { ...savedEnv };
});

const NFD_NAME = '한글폴더'.normalize('NFD');

/** A WSL host whose home and /mnt drives are temp folders. */
function tree() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-folders-'));
  cleanup.push(() => fs.rmSync(t, { recursive: true, force: true }));
  const mk = (p: string) => fs.mkdirSync(path.join(t, p), { recursive: true });
  for (const d of ['home/projects/a', 'home/projects/b', 'home/.hidden', 'outside/secret']) mk(d);
  for (const d of ['mnt/c/Users', 'mnt/d', 'mnt/data']) mk(d);
  mk(`home/${NFD_NAME}/inner`);
  fs.writeFileSync(path.join(t, 'home/notes.txt'), 'never listed');
  fs.symlinkSync(path.join(t, 'home/projects/a'), path.join(t, 'home/link-in'));
  fs.symlinkSync(path.join(t, 'outside'), path.join(t, 'home/link-out'));
  for (let i = 0; i < FOLDER_CAP + 20; i++) mk(`home/many/d${String(i).padStart(3, '0')}`);
  const home = path.join(t, 'home');
  const host: HostInfo = {
    type: 'hostInfo',
    os: 'wsl',
    home,
    pathStyle: 'posix',
    sep: '/',
    caseInsensitive: false,
    distro: 'Test',
    mnt: path.join(t, 'mnt'),
  };
  const list = (p?: string, hidden?: boolean): FolderList =>
    listFolders(
      { type: 'listFolders', requestId: 'r', ...(p && { path: p }), ...(hidden && { hidden }) },
      host,
    );
  return { t, home, host, list };
}

const names = (l: FolderList) => l.entries.map((e) => e.name);

describe('listFolders: what it shows', () => {
  it('home by default: folders only, sorted, no dot folders, no files; roots home + drives', () => {
    const { home, t, list } = tree();
    const l = list();
    expect(l).toMatchObject({ ok: true, path: home, parent: null });
    expect(names(l)).toEqual(['link-in', 'many', 'projects', '한글폴더']);
    expect(l.entries.find((e) => e.name === 'projects')?.path).toBe(path.join(home, 'projects'));
    expect(JSON.stringify(l)).not.toContain('notes.txt');
    expect(l.roots).toEqual([
      { label: '홈', path: home },
      { label: 'C:', path: path.join(t, 'mnt/c') },
      { label: 'D:', path: path.join(t, 'mnt/d') },
    ]);
  });

  it('hidden folders only when asked', () => {
    const { list } = tree();
    expect(names(list(undefined, true))).toContain('.hidden');
  });

  it('never shows a protected folder; a project .claude (worktrees) stays reachable', () => {
    const { home, t, list } = tree();
    for (const d of [
      '.ssh',
      '.Claude/projects',
      '.config/cld-gui',
      'projects/a/.claude/worktrees/w',
    ])
      fs.mkdirSync(path.join(home, d), { recursive: true });
    fs.mkdirSync(path.join(t, 'mnt/c/Users/Bob/SSH~1'), { recursive: true });
    fs.symlinkSync(path.join(home, '.ssh'), path.join(home, 'keys'));
    const top = names(list(undefined, true));
    for (const hidden of ['.ssh', '.Claude', 'keys']) expect(top).not.toContain(hidden);
    expect(names(list('~/.config', true))).toEqual([]);
    for (const shut of ['~/.ssh', '~/.claude/projects', '~/.CONFIG/cld-gui', '~/keys'])
      expect(list(shut).ok, shut).toBe(false);
    expect(names(list(path.join(t, 'mnt/c/Users/Bob'), true))).toEqual([]);
    expect(names(list('~/projects/a', true))).toEqual(['.claude']);
    expect(names(list('~/projects/a/.claude/worktrees'))).toEqual(['w']);
  });

  it('a subfolder: its parent, written with ~', () => {
    const { home, list } = tree();
    expect(list('~/projects')).toMatchObject({
      ok: true,
      path: path.join(home, 'projects'),
      parent: home,
      entries: [
        { name: 'a', path: path.join(home, 'projects/a') },
        { name: 'b', path: path.join(home, 'projects/b') },
      ],
    });
  });

  it(`at most ${FOLDER_CAP} entries, then truncated`, () => {
    const { list } = tree();
    const l = list('~/many');
    expect(l.entries).toHaveLength(FOLDER_CAP);
    expect(l.truncated).toBe(true);
  });

  it('a WSL drive: slow warning, the Windows path, and X:\\ typed', () => {
    const { t, list } = tree();
    expect(list(path.join(t, 'mnt/c'))).toMatchObject({
      ok: true,
      display: 'C:\\',
      warnings: [WARN_MNT],
      entries: [{ name: 'Users' }],
    });
    expect(list('C:\\Users')).toMatchObject({ ok: true, path: path.join(t, 'mnt/c/Users') });
  });

  it('a folder whose name on disk is NFD is found from NFC, and listed as NFC', () => {
    const { home, host, list } = tree();
    const nfc = path.join(home, '한글폴더');
    expect(findFolder(nfc, host)).toBe(path.join(home, NFD_NAME));
    expect(list(nfc)).toMatchObject({ ok: true, path: nfc, entries: [{ name: 'inner' }] });
  });
});

describe('listFolders: bounds', () => {
  it.each<[string, (t: string, home: string) => string, RegExp]>([
    ['.. out of home', (_t, home) => `${home}/projects/../../outside`, /\. 이나 \.\./],
    ['a folder outside', (t) => path.join(t, 'outside'), /밖은 볼 수 없어요/],
    ['/mnt itself is no drive', (t) => path.join(t, 'mnt'), /밖은 볼 수 없어요/],
    ['/mnt/data is no drive', (t) => path.join(t, 'mnt/data'), /밖은 볼 수 없어요/],
    ['a symlink out of home', (_t, home) => path.join(home, 'link-out'), /밖은 볼 수 없어요/],
    ['under a symlink out of home', (_t, home) => `${home}/link-out/secret`, /밖은 볼 수 없어요/],
    ['a missing folder', (_t, home) => `${home}/nope`, /없는 폴더/],
    ['a file', (_t, home) => `${home}/notes.txt`, /열 수 없어요/],
    ['relative', () => 'projects', /^폴더는/],
  ])('%s is refused', (_what, p, error) => {
    const { t, home, list } = tree();
    const l = list(p(t, home));
    expect(l).toMatchObject({ ok: false, error: expect.stringMatching(error), entries: [] });
    expect(l.roots.length).toBeGreaterThan(0);
  });

  it('a symlink is listed only when it stays inside', () => {
    const { list } = tree();
    const shown = names(list());
    expect(shown).toContain('link-in');
    expect(shown).not.toContain('link-out');
  });
});

describe('the message, the host and the gates', () => {
  it('listFolders: well-formed only', () => {
    expect(
      parseListFolders({ type: 'listFolders', requestId: 'r', path: '/x', hidden: true }),
    ).toEqual({ type: 'listFolders', requestId: 'r', path: '/x', hidden: true });
    for (const bad of [
      {},
      { requestId: '' },
      { requestId: 'r', path: 3 },
      { requestId: 'r', hidden: 'yes' },
      { requestId: 'r', path: 'x'.repeat(5000) },
      { requestId: 'r'.repeat(200) },
    ])
      expect(parseListFolders({ type: 'listFolders', ...bad })).toBeNull();
  });

  it('host detection: case folding by the flipped home, the test override', () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-host-'));
    cleanup.push(() => fs.rmSync(t, { recursive: true, force: true }));
    expect(foldsCase(t)).toBe(false); // ext4 here: /TMP/... is no folder
    expect(foldsCase('/')).toBe(false); // no letter to flip
    const env = { CLD_GUI_TEST_HOST: '{"os":"wsl","distro":"Fake","mnt":"/x/mnt"}' };
    expect(detectHostInfo('/home/u', env, 'linux')).toEqual({
      type: 'hostInfo',
      os: 'wsl',
      home: '/home/u',
      pathStyle: 'posix',
      sep: '/',
      caseInsensitive: false,
      distro: 'Fake',
      mnt: '/x/mnt',
      utcOffsetMin: -new Date().getTimezoneOffset(), // T-0041: the host's clock
    });
    expect(detectHostInfo('C:\\Users\\u', { CLD_GUI_TEST_HOST: '{"os":"win32"}' })).toMatchObject({
      os: 'win32',
      pathStyle: 'win32',
      sep: '\\',
    });
  });

  async function office(readOnly: boolean, engine = false) {
    const {
      office: o,
      home,
      messages,
    } = await startEngineOffice({
      readOnly,
      claude: 'C-4',
      projects: engine ? [{ name: 'alpha', folder: '/work/engine-alpha' }] : undefined,
    });
    const fake = { home };
    const sent: Array<Record<string, unknown>> = [];
    const ask = (privileged: boolean) =>
      o.onClientMessage({ type: 'listFolders', requestId: 'q' }, (m) => sent.push(m), privileged);
    return { o, fake, sent, ask, messages };
  }

  it('every client gets hostInfo once it is ready', async () => {
    const { o, fake, sent } = await office(true);
    o.onClientReady((m) => sent.push(m));
    expect(sent.filter((m) => m.type === 'hostInfo')).toEqual([
      expect.objectContaining({ type: 'hostInfo', home: fake.home }),
    ]);
  });

  it.each<[string, boolean, boolean, RegExp | null]>([
    ['read-only daemon, privileged (the 파일 tab reads)', true, true, null],
    ['read-only daemon, unprivileged client', true, false, /조작 권한이 없어요/],
    ['unprivileged client', false, false, /조작 권한이 없어요/],
    ['actions on, privileged', false, true, null],
  ])('gate: %s', async (_what, readOnly, privileged, refusal) => {
    const { sent, ask, fake } = await office(readOnly);
    ask(privileged);
    expect(sent).toEqual([
      refusal
        ? expect.objectContaining({
            type: 'folderList',
            requestId: 'q',
            ok: false,
            error: expect.stringMatching(refusal),
            entries: [],
          })
        : expect.objectContaining({
            type: 'folderList',
            requestId: 'q',
            ok: true,
            path: fake.home,
          }),
    ]);
  });

  it('officeState says who manages each row: an engine project, or another Claude session', async () => {
    const { messages } = await office(true, true);
    const hs = [...messages].reverse().find((m) => m.type === 'officeSnapshot') as unknown as OfficeSnapshot;
    const by = (p: string) => hs.orchestrators.filter((o) => o.provider === p).map((o) => o.name);
    expect(by('engine')).toEqual(['alpha']);
    expect(by('claude').length).toBeGreaterThan(0);
    expect(hs.orchestrators.every((o) => o.provider !== undefined)).toBe(true);
  });
});
