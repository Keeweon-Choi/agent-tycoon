import { useSyncExternalStore } from 'react';

import type { ProjectFileEntry, ProjectFileList } from '../../../../core/src/agent-tycoon/projectFiles.js';
import { showOffice } from '../hud/hudStore.js';
import { type FileRoot, fileRootKey } from './filesStore.js';

const STORAGE_KEY = 'agty.files.root.v1';
function savedRoot(): FileRoot | null {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as FileRoot | null;
    if (value?.kind === 'project' && typeof value.project === 'string') return value;
    if (value?.kind === 'worktree' && typeof value.project === 'string' && typeof value.task === 'string')
      return value;
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
  window.dispatchEvent(new Event('agty-open-files-tab'));
}

/** SPT-P1A: a file to show once the project's explorer is up (the 문서 tab's rows). */
let pendingFile: { project: string; entry: ProjectFileEntry; line?: number } | null = null;
const pendingListeners = new Set<() => void>();
export const usePendingFile = () =>
  useSyncExternalStore(
    (l) => {
      pendingListeners.add(l);
      return () => void pendingListeners.delete(l);
    },
    () => pendingFile,
  );
/** The explorer took it. */
export const clearPendingFile = () => {
  pendingFile = null;
};
/** Open the 파일 tab on `project` and show one file of it (at `line`: its source, scrolled there and marked). */
export function openProjectFile(project: string, entry: ProjectFileEntry, line?: number) {
  pendingFile = { project, entry, ...(line && { line }) };
  pendingListeners.forEach((l) => l());
  openProjectFiles(project);
}

/** The dev room's `… → 탐색기에서 열기`: the 파일 window, rooted at one task worktree. */
export function openExplorer(project: string, task: string) {
  chooseFileRoot({ kind: 'worktree', project, task });
  showOffice('files');
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
