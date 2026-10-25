import { useSyncExternalStore } from 'react';

import type { ProjectFileList } from '../../../../core/src/cld/projectFiles.js';
import { type FileRoot, fileRootKey } from './filesStore.js';

const STORAGE_KEY = 'cld.files.root.v1';
function savedRoot(): FileRoot | null {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as FileRoot | null;
    if (value?.kind === 'project' && typeof value.project === 'string') return value;
    if (value?.kind === 'folder' && typeof value.folder === 'string') return value;
  } catch {
    /* unavailable storage */
  }
  return null;
}

let current: FileRoot | null = savedRoot();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const useFileRoot = () => useSyncExternalStore(subscribe, () => current);
export function chooseFileRoot(root: FileRoot) {
  current = root;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(root));
  } catch {
    /* this visit only */
  }
  listeners.forEach((listener) => listener());
}

/** Existing project buttons select a root and ask App to reveal the tab. */
export function openProjectFiles(project: string) {
  chooseFileRoot({ kind: 'project', project });
  window.dispatchEvent(new Event('cld-open-files-tab'));
}

export class ListingCache {
  private readonly pages = new Map<string, ProjectFileList>();

  key(root: FileRoot, folder: string, offset: number, hidden: boolean) {
    return JSON.stringify([fileRootKey(root), folder, offset, hidden]);
  }

  peek(key: string): ProjectFileList | null {
    return this.pages.get(key) ?? null;
  }

  async showThenRefresh(
    key: string,
    fetchPage: () => Promise<ProjectFileList>,
    show: (listing: ProjectFileList) => void,
  ): Promise<void> {
    const cached = this.pages.get(key);
    if (cached) show(cached);
    const fresh = await fetchPage();
    this.pages.set(key, fresh);
    show(fresh);
  }
}

/** Browser memory only; no disk listing and no server listing cache. */
export const listingCache = new ListingCache();
