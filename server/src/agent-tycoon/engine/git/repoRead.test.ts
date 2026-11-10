import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RepoError } from './gitRun.js';
import {
  DIFF_CHUNK_BYTES,
  DIFF_TOTAL_BYTES,
  isConflict,
  isStaged,
  isUnstaged,
  parseStatusV2,
  readDiff,
  readRepoState,
  readStatus,
  repoRoot,
} from './repoRead.js';
import type { TempRepo } from './testRepo.js';
import { GIT_AVAILABLE, makeTempRepo } from './testRepo.js';

// Every test here runs real git processes (a dozen or more each, the diff test a 2.5 MB diff); on a
// starved CPU (the deploy gate: two nice'd cores) that outlasts the 10 s default while nothing is wrong.
vi.setConfig({ testTimeout: 60_000 });

const repos: TempRepo[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.cleanup();
});
const temp = (opts?: Parameters<typeof makeTempRepo>[0]) => {
  const repo = makeTempRepo(opts);
  repos.push(repo);
  return repo;
};

const z = (...entries: string[]) => `${entries.join('\0')}\0`;

describe('parseStatusV2 (porcelain v2, -z)', () => {
  it('reads the branch headers: upstream, ahead and behind', () => {
    const st = parseStatusV2(
      z(
        '# branch.oid 0123456789abcdef0123456789abcdef01234567',
        '# branch.head feature/x',
        '# branch.upstream origin/feature/x',
        '# branch.ab +2 -3',
      ),
    );
    expect(st).toMatchObject({
      head: '0123456',
      branch: 'feature/x',
      upstream: 'origin/feature/x',
      ahead: 2,
      behind: 3,
      files: [],
      truncated: false,
    });
  });

  it('before the first commit and on a detached HEAD', () => {
    expect(parseStatusV2(z('# branch.oid (initial)', '# branch.head main'))).toMatchObject({
      head: null,
      branch: 'main',
      upstream: null,
      ahead: null,
    });
    expect(parseStatusV2(z('# branch.oid abcdef1234', '# branch.head (detached)'))).toMatchObject({
      head: 'abcdef1',
      branch: null,
    });
  });

  it('an upstream that is gone has no ahead/behind', () => {
    const st = parseStatusV2(z('# branch.head main', '# branch.upstream origin/main'));
    expect(st).toMatchObject({ upstream: 'origin/main', ahead: null, behind: null });
  });

  it('changed, renamed, unmerged and untracked entries, with odd names', () => {
    const h = '5626abf0f72e58d7a153368ba57db4c673c0e171';
    const st = parseStatusV2(
      z(
        `1 .M N... 100644 100644 100644 ${h} ${h} a b.txt`,
        `1 A. N... 000000 100644 100644 ${h} ${h} 한글 파일.txt`,
        `2 R. N... 100644 100644 100644 ${h} ${h} R100 sub/c.txt`,
        'sub/old name.txt',
        `u UU N... 100644 100644 100644 100644 ${h} ${h} ${h} conflict.txt`,
        '? new\nline.txt',
        '? newdir/',
      ),
    );
    expect(st.files).toEqual([
      { path: 'a b.txt', index: '.', worktree: 'M' },
      { path: '한글 파일.txt', index: 'A', worktree: '.' },
      { path: 'sub/c.txt', origPath: 'sub/old name.txt', index: 'R', worktree: '.' },
      { path: 'conflict.txt', index: 'U', worktree: 'U' },
      { path: 'new\nline.txt', index: '.', worktree: '?' },
      { path: 'newdir/', index: '.', worktree: '?' },
    ]);
    expect(st.files.map(isStaged)).toEqual([false, true, true, false, false, false]);
    expect(st.files.map(isUnstaged)).toEqual([true, false, false, true, true, true]);
    expect(st.files.map(isConflict)).toEqual([false, false, false, true, false, false]);
  });

  it('keeps the first maxFiles entries and says it cut the rest', () => {
    const entries = Array.from({ length: 5 }, (_, i) => `? f${i}.txt`);
    const st = parseStatusV2(z('# branch.head main', ...entries), 3);
    expect(st.files.map((f) => f.path)).toEqual(['f0.txt', 'f1.txt', 'f2.txt']);
    expect(st.truncated).toBe(true);
  });
});

describe.skipIf(!GIT_AVAILABLE)('reading a repository (temp repos)', () => {
  it('a clean clone: branch, upstream, 0/0, nothing changed', async () => {
    const r = temp();
    const state = await readRepoState(r.run, { name: 'p', folder: r.folder });
    expect(state).toMatchObject({
      project: 'p',
      ok: true,
      branch: 'main',
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
      files: [],
      filesTruncated: false,
      statStaged: '',
      statUnstaged: '',
    });
    expect(state.head).toMatch(/^[0-9a-f]{7}$/);
  });

  it('changes: modified, staged, renamed, untracked, and the two diff --stat texts', async () => {
    const r = temp();
    r.write('a.txt', 'one\ntwo\n'); // modified, not staged
    r.git(['mv', 'sub/b.txt', 'sub/c.txt']); // staged rename
    r.write('untracked.txt', 'new\n');
    r.write('newdir/x.txt', 'n\n');
    const state = await readRepoState(r.run, { name: 'p', folder: r.folder });
    expect(state.files).toEqual([
      { path: 'a.txt', index: '.', worktree: 'M' },
      { path: 'sub/c.txt', origPath: 'sub/b.txt', index: 'R', worktree: '.' },
      { path: 'newdir/', index: '.', worktree: '?' },
      { path: 'untracked.txt', index: '.', worktree: '?' },
    ]);
    expect(state.statUnstaged).toMatch(/a\.txt\s+\|\s+1 \+/);
    expect(state.statUnstaged).toContain('1 file changed');
    expect(state.statStaged).toMatch(/sub\/\{b\.txt => c\.txt\}/);
  });

  it('ahead and behind the upstream', async () => {
    const r = temp();
    r.write('a.txt', 'local\n');
    r.git(['commit', '-q', '-am', 'local']);
    const other = r.cloneRemote('other');
    fs.writeFileSync(path.join(other, 'remote.txt'), 'r\n');
    r.git(['add', '-A'], other);
    r.git(['commit', '-q', '-m', 'remote'], other);
    r.git(['push', '-q', 'origin', 'main'], other);
    r.git(['fetch', '-q', 'origin']);
    const state = await readRepoState(r.run, { name: 'p', folder: r.folder });
    expect(state).toMatchObject({ ahead: 1, behind: 1, files: [] });
  });

  it('no upstream, an upstream not pushed yet, detached HEAD, and before the first commit', async () => {
    const r = temp({ push: false });
    // A clone of an empty remote tracks origin/main before it exists: no ahead/behind to count.
    expect(await readRepoState(r.run, { name: 'p', folder: r.folder })).toMatchObject({
      ok: true,
      branch: 'main',
      upstream: 'origin/main',
      ahead: null,
      behind: null,
    });
    r.git(['branch', '--unset-upstream']);
    expect(await readRepoState(r.run, { name: 'p', folder: r.folder })).toMatchObject({
      upstream: null,
      ahead: null,
    });
    r.git(['checkout', '-q', '--detach']);
    expect(await readRepoState(r.run, { name: 'p', folder: r.folder })).toMatchObject({
      ok: true,
      branch: null,
    });
    const empty = temp({ commit: false });
    expect(await readRepoState(empty.run, { name: 'e', folder: empty.folder })).toMatchObject({
      ok: true,
      head: null,
      branch: 'main',
    });
  });

  it('says why there is nothing: no folder, not a repository, a subfolder, a relative path', async () => {
    const r = temp();
    const plain = path.join(r.root, 'plain');
    fs.mkdirSync(plain);
    const state = (folder: string) => readRepoState(r.run, { name: 'p', folder });
    expect(await state(path.join(r.root, 'missing'))).toMatchObject({
      ok: false,
      error: '폴더가 없어요',
    });
    expect(await state(plain)).toMatchObject({
      ok: false,
      error: '이 폴더는 git 저장소가 아니에요',
    });
    expect(await state(path.join(r.folder, 'sub'))).toMatchObject({
      ok: false,
      error: 'git 저장소의 맨 위 폴더가 아니에요',
    });
    expect(await state('relative/dir')).toMatchObject({
      ok: false,
      error: '폴더 경로가 올바르지 않아요',
    });
  });

  it('a link to the repository folder is the repository', async () => {
    const r = temp();
    const link = path.join(r.root, 'link');
    fs.symlinkSync(r.folder, link);
    expect(await repoRoot(r.run, link)).toBe(fs.realpathSync(r.folder));
  });

  it('reads status without refreshing the index (a poll must not write under the user’s git)', async () => {
    const r = temp();
    // Same content, new mtime: a plain `git status` rewrites the index to record it.
    const file = r.write('a.txt', 'one\n');
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(file, later, later);
    const index = path.join(r.folder, '.git/index');
    const before = fs.statSync(index).mtimeMs;
    expect((await readStatus(r.run, r.folder)).files).toEqual([]);
    expect(fs.statSync(index).mtimeMs).toBe(before);
    expect(fs.existsSync(`${index}.lock`)).toBe(false);
    // Control: without GIT_OPTIONAL_LOCKS=0 the same status does move it.
    r.git(['status', '--short']);
    expect(fs.statSync(index).mtimeMs).not.toBe(before);
  });
});

describe.skipIf(!GIT_AVAILABLE)('the diff of one file (temp repos)', () => {
  const diff = (r: TempRepo, file: string, staged = false, offset?: number) =>
    readDiff(r.run, r.folder, { path: file, staged, offset });

  it('unstaged, staged, and a new file shown whole', async () => {
    const r = temp();
    r.write('a.txt', 'one\ntwo\n');
    r.write('untracked.txt', 'brand new\n');
    expect((await diff(r, 'a.txt')).text).toMatch(/^diff --git a\/a\.txt b\/a\.txt[\s\S]*\+two\n$/);
    expect(await diff(r, 'untracked.txt')).toEqual({
      text: expect.stringMatching(/new file mode[\s\S]*\+brand new\n$/),
    });
    r.git(['add', 'a.txt']);
    expect((await diff(r, 'a.txt', true)).text).toContain('+two');
    // Staged and unstaged are separate views of one file.
    r.write('a.txt', 'one\ntwo\nthree\n');
    expect((await diff(r, 'a.txt')).text).toMatch(/\+three/);
    expect((await diff(r, 'a.txt')).text).not.toMatch(/\+two/);
  });

  it('a rename shows as a rename; a new folder says so', async () => {
    const r = temp();
    r.git(['mv', 'sub/b.txt', 'sub/c.txt']);
    r.write('newdir/x.txt', 'n\n');
    expect((await diff(r, 'sub/c.txt', true)).text).toMatch(/rename from sub\/b\.txt/);
    expect((await diff(r, 'newdir/')).text).toContain('새 폴더');
  });

  it('only files of the latest status, as the status spells them', async () => {
    const r = temp();
    r.write('a.txt', 'one\ntwo\n');
    fs.writeFileSync(path.join(r.root, 'outside.txt'), 'secret\n');
    for (const bad of [
      'sub/b.txt', // tracked, unchanged
      '../outside.txt',
      path.join(r.root, 'outside.txt'),
      '--output=pwned.txt',
      '-p',
      ':(glob)*.txt',
      '*',
      'a.txt/',
      '',
    ]) {
      await expect(diff(r, bad)).rejects.toThrow('변경 목록에 없는 파일이에요');
    }
    expect(fs.existsSync(path.join(r.folder, 'pwned.txt'))).toBe(false);
    // The view that has no change is refused, not shown empty.
    await expect(diff(r, 'a.txt', true)).rejects.toThrow('스테이지된 변경이 없어요');
    r.git(['add', 'a.txt']);
    await expect(diff(r, 'a.txt', false)).rejects.toThrow(RepoError);
  });

  it('files that look like options or shell syntax are just names', async () => {
    const r = temp();
    const names = ['--help', '-p', '$(touch pwned)', '; touch pwned', '`touch pwned`', 'a b.txt'];
    for (const n of names) r.write(n, `content of ${n}\n`);
    for (const n of names) {
      expect((await diff(r, n)).text).toContain(`+content of ${n}`);
    }
    expect(fs.readdirSync(r.folder).filter((f) => f === 'pwned')).toEqual([]);
  });

  it('a conflict is shown as the combined diff, also when staged is asked for', async () => {
    const r = temp();
    r.git(['checkout', '-q', '-b', 'other']);
    r.write('a.txt', 'other\n');
    r.git(['commit', '-q', '-am', 'other']);
    r.git(['checkout', '-q', 'main']);
    r.write('a.txt', 'main\n');
    r.git(['commit', '-q', '-am', 'main']);
    expect(() => r.git(['merge', 'other'])).toThrow();
    const st = await readStatus(r.run, r.folder);
    expect(st.files.map(isConflict)).toEqual([true]);
    expect((await diff(r, 'a.txt', true)).text).toMatch(/^diff --cc a\.txt/);
  });

  it('pages of at most 200 KB, cut at line ends, that add up to git’s own output', async () => {
    const r = temp();
    const lines = Array.from({ length: 30_000 }, (_, i) => `line ${i} ${'x'.repeat(40)}\n`);
    r.write('big.txt', lines.join(''));
    r.git(['add', 'big.txt']);
    r.git(['commit', '-q', '-m', 'big']);
    r.write('big.txt', lines.map((l) => `${l.trimEnd()}!\n`).join('')); // ~2.5 MB of diff
    const whole = r.git(['diff', '--no-color', '--', 'big.txt']);
    expect(whole.length).toBeGreaterThan(DIFF_TOTAL_BYTES + DIFF_CHUNK_BYTES);

    let text = '';
    let offset: number | undefined;
    let pages = 0;
    for (;;) {
      const page = await diff(r, 'big.txt', false, offset);
      expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(DIFF_CHUNK_BYTES);
      expect(page.text.endsWith('\n')).toBe(true);
      text += page.text;
      pages++;
      if (page.limited) {
        expect(page.nextOffset).toBeUndefined();
        break;
      }
      expect(page.nextOffset).toBe(Buffer.byteLength(text));
      offset = page.nextOffset;
      if (pages > 20) throw new Error('never limited');
    }
    expect(Buffer.byteLength(text)).toBeGreaterThan(DIFF_TOTAL_BYTES - DIFF_CHUNK_BYTES);
    expect(whole.startsWith(text)).toBe(true);
    // Past the limit: nothing more, and still limited.
    expect(await diff(r, 'big.txt', false, DIFF_TOTAL_BYTES)).toEqual({ text: '', limited: true });
  });

  it('a diff under 200 KB comes whole, with no next page; an offset past its end is empty', async () => {
    const r = temp();
    r.write('a.txt', 'one\ntwo\n');
    const page = await diff(r, 'a.txt');
    expect(page.nextOffset).toBeUndefined();
    expect(page.limited).toBeUndefined();
    expect(await diff(r, 'a.txt', false, 100_000)).toEqual({ text: '' });
  });

  it('never cuts a multi-byte character in two, also in one huge line', async () => {
    const r = temp();
    r.write('wide.txt', '가'.repeat(150_000) + '\n'); // 450 KB in a single line
    let text = '';
    let offset: number | undefined;
    do {
      const page = await diff(r, 'wide.txt', false, offset);
      expect(page.text).not.toContain('�');
      text += page.text;
      offset = page.nextOffset;
    } while (offset !== undefined);
    expect(text).toContain('가'.repeat(150_000));
  });

  it('a binary file is one line, not its bytes', async () => {
    const r = temp();
    fs.writeFileSync(path.join(r.folder, 'img.bin'), Buffer.from([0, 1, 2, 0, 255, 0]));
    r.git(['add', 'img.bin']);
    r.git(['commit', '-q', '-m', 'bin']);
    fs.writeFileSync(path.join(r.folder, 'img.bin'), Buffer.from([0, 9, 9, 0, 255, 0]));
    expect((await diff(r, 'img.bin')).text).toMatch(/Binary files .* differ/);
  });

  it('no external diff or textconv program runs, whatever the config says', async () => {
    const r = temp();
    const marker = path.join(r.root, 'ran');
    r.git(['config', 'diff.external', `sh -c 'touch ${marker}'`]);
    r.write('a.txt', 'one\ntwo\n');
    expect((await diff(r, 'a.txt')).text).toContain('+two');
    expect(fs.existsSync(marker)).toBe(false);
  });
});

it('the temp repos live under the OS temp dir only', () => {
  if (!GIT_AVAILABLE) return;
  const r = temp();
  expect(r.root.startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
});
