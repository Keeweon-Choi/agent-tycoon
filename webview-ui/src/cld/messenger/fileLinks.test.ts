import { expect, it } from 'vitest';

import { findFilePaths, resolvePath } from './fileLinks.js';

it('finds absolute and relative paths, including paths in code spans', () => {
  expect(findFilePaths('See /work/a/report.png and `cld/artifacts/board-hw-windows.png`.')).toEqual(
    [
      { start: 4, end: 22, path: '/work/a/report.png' },
      { start: 28, end: 62, path: 'cld/artifacts/board-hw-windows.png' },
    ],
  );
});

it('keeps source locations separate from paths', () => {
  expect(findFilePaths('server/src/cld/office.ts:123 and webview-ui/src/a.ts:12:3')).toEqual([
    { start: 0, end: 24, path: 'server/src/cld/office.ts', line: 123 },
    { start: 33, end: 52, path: 'webview-ui/src/a.ts', line: 12 },
  ]);
});

it('excludes trailing punctuation and Hangul particles', () => {
  const paths = [
    'src/app.ts\uc5d0\uc11c',
    'src/app.ts\uc640',
    'src/app.ts\uacfc',
    'src/app.ts\uc774',
    'src/app.ts\uac00',
    'src/app.ts\ub3c4',
    'src/app.ts\ub9cc',
    'src/app.ts\uae4c\uc9c0',
    'src/app.ts\ubd80\ud130',
    'src/app.ts\uc774\uc5d0\uc694',
    'src/app.ts\uc785\ub2c8\ub2e4',
    'src/app.ts\ucc98\ub7fc',
    'src/app.ts\ub791',
    'src/app.ts\ud558\uace0',
    'src/app.ts\uc5d0\ub3c4',
  ];
  expect(
    findFilePaths(`/work/file.png. a/b/c.txt) d/e/f.md\uc5d0 g/h/i.ts\uc744 ${paths.join(' ')}`),
  ).toEqual([
    { start: 0, end: 14, path: '/work/file.png' },
    { start: 16, end: 25, path: 'a/b/c.txt' },
    { start: 27, end: 35, path: 'd/e/f.md' },
    { start: 37, end: 45, path: 'g/h/i.ts' },
    ...paths.map((_, index) => {
      const start = 47 + paths.slice(0, index).reduce((total, path) => total + path.length + 1, 0);
      return { start, end: start + 'src/app.ts'.length, path: 'src/app.ts' };
    }),
  ]);
});

it('does not find URLs, home-relative paths, or spaced values', () => {
  expect(
    findFilePaths(
      'https://example.test/a.png http://example.test/b.txt file:///tmp/c.md ~/x/y.ts a/b bad.txt',
    ),
  ).toEqual([]);
});

it('refuses values that merely resemble file paths', () => {
  expect(
    findFilePaths(
      '1/2.5 10/24.5 2026/10.24 3/4.5x v1.2/v1.3 github.com/a/b.js www.example.com/page.html x.com/abc.def localhost/a.js localhost:3000/a.js e.g./i.e. src/*.ts src/**/*.ts npm/pixel-agents@1.2.3',
    ),
  ).toEqual([]);
});

it('requires a letter, dot, or underscore at the start of a segment before the file name', () => {
  expect(findFilePaths('1/a.ts 2026/10/report.md')).toEqual([]);
});

it('checks each comma-separated path independently', () => {
  expect(findFilePaths('a/b.ts,c/d.ts')).toEqual([
    { start: 0, end: 6, path: 'a/b.ts' },
    { start: 7, end: 13, path: 'c/d.ts' },
  ]);
});

it('accepts one leading ./ and strips surrounding quotes', () => {
  expect(findFilePaths('./server/a.ts \'server/src/a.ts\' "server/src/a.ts"')).toEqual([
    { start: 2, end: 13, path: 'server/a.ts' },
    { start: 15, end: 30, path: 'server/src/a.ts' },
    { start: 33, end: 48, path: 'server/src/a.ts' },
  ]);
});

it('refuses dot segments when resolving and joins safe relative paths', () => {
  expect(resolvePath('src/a.ts', '/work/project')).toBe('/work/project/src/a.ts');
  expect(resolvePath('./src/a.ts', '/work/project')).toBe('/work/project/src/a.ts');
  expect(resolvePath('/work/project/src/a.ts', '/other')).toBe('/work/project/src/a.ts');
  expect(resolvePath('../secret.txt', '/work/project')).toBeNull();
  expect(resolvePath('src/../secret.txt', '/work/project')).toBeNull();
});
