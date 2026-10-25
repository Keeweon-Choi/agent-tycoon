import { expect, it } from 'vitest';

import type { ProjectFileList } from '../../../../core/src/cld/projectFiles.js';
import { chooseFileRoot, ListingCache } from './explorerState.js';

const listing = (name: string): ProjectFileList => ({
  path: '',
  offset: 0,
  nextOffset: null,
  entries: [{ name, path: name, kind: 'file', size: 1, mtime: 0 }],
});

it('shows a cached page before its fresh request resolves', async () => {
  const cache = new ListingCache();
  const key = cache.key({ kind: 'folder', folder: '/home/test' }, '', 0, false);
  await cache.showThenRefresh(
    key,
    async () => listing('old.txt'),
    () => undefined,
  );
  let resolve!: (value: ProjectFileList) => void;
  const pending = new Promise<ProjectFileList>((done) => {
    resolve = done;
  });
  const shown: string[] = [];
  const refresh = cache.showThenRefresh(
    key,
    () => pending,
    (page) => shown.push(page.entries[0].name),
  );
  expect(shown).toEqual(['old.txt']);
  resolve(listing('new.txt'));
  await refresh;
  expect(shown).toEqual(['old.txt', 'new.txt']);
  expect(cache.peek(key)?.entries[0].name).toBe('new.txt');
  expect(cache.key({ kind: 'folder', folder: '/home/other' }, '', 0, false)).not.toBe(key);
});

it('keeps listings in memory: the device stores the chosen root and nothing else', async () => {
  const stored = new Map<string, string>();
  const fake = {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
    removeItem: (k: string) => void stored.delete(k),
  };
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true });
  try {
    chooseFileRoot({ kind: 'folder', folder: '/home/test/work' });
    const cache = new ListingCache();
    const key = cache.key({ kind: 'folder', folder: '/home/test/work' }, '', 0, false);
    await cache.showThenRefresh(
      key,
      async () => listing('secret-plan.md'),
      () => undefined,
    );
    expect([...stored.keys()]).toEqual(['cld.files.root.v1']);
    expect(JSON.parse(stored.get('cld.files.root.v1')!)).toEqual({
      kind: 'folder',
      folder: '/home/test/work',
    });
    expect([...stored.values()].join()).not.toContain('secret-plan');
  } finally {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
